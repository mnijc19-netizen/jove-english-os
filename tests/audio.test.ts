import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_RECORDING_SECONDS, startRecording } from '../src/audio/recorder'
import { pauseSpeech, resumeSpeech, speakLocalText, speakText, stopSpeech } from '../src/audio/speech'

class FakeRecorder {
  static instance: FakeRecorder
  static autoStart = true
  static isTypeSupported = vi.fn((type: string) => type.startsWith('audio/webm'))
  mimeType: string
  state = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  onstart: (() => void) | null = null
  start = vi.fn(() => { this.state = 'recording'; if (FakeRecorder.autoStart) queueMicrotask(() => this.onstart?.()) })
  stop = vi.fn(() => {
    this.state = 'inactive'
    queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['final-audio'], { type: this.mimeType }) }); this.onstop?.() })
  })
  constructor(_stream: unknown, options?: { mimeType: string }) { this.mimeType = options?.mimeType ?? 'audio/mp4'; FakeRecorder.instance = this }
}
let track: { stop: ReturnType<typeof vi.fn>; onended: (() => void) | null }
let getUserMedia: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.useFakeTimers()
  track = { stop: vi.fn(), onended: null }
  getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }))
  FakeRecorder.isTypeSupported.mockImplementation(type => type.startsWith('audio/webm'))
  FakeRecorder.autoStart = true
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal('MediaRecorder', FakeRecorder)
})
afterEach(() => { stopSpeech(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('browser recording lifecycle', () => {
  it('does not expose a recording handle or count preparation time before the native start event', async () => {
    FakeRecorder.autoStart = false
    let ready = false
    const pending = startRecording().then(handle => { ready = true; return handle })
    await vi.advanceTimersByTimeAsync(1500)
    expect(ready).toBe(false)
    FakeRecorder.instance.onstart?.()
    const handle = await pending
    await vi.advanceTimersByTimeAsync(2100)
    expect((await handle.stop()).duration).toBeCloseTo(2.1)
    expect(track.stop).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds a missing native start event and preserves final bytes without inventing capture time', async () => {
    FakeRecorder.autoStart = false
    const pending = startRecording().catch(error => error)
    await vi.advanceTimersByTimeAsync(5001)
    const error = await pending
    expect(error.code).toBe('RECORDING')
    expect(await error.recovery.blob.text()).toBe('final-audio')
    expect(error.recovery.duration).toBe(0)
    expect(track.stop).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds missing start and stop events and cannot activate after setup failure', async () => {
    FakeRecorder.autoStart = false
    const pending = startRecording().catch(error => error)
    await vi.advanceTimersByTimeAsync(1)
    FakeRecorder.instance.stop.mockImplementation(() => { FakeRecorder.instance.state = 'inactive' })
    await vi.advanceTimersByTimeAsync(5000)
    FakeRecorder.instance.onstart?.()
    await vi.advanceTimersByTimeAsync(5000)
    expect(await pending).toMatchObject({ code: 'RECORDING', recovery: undefined })
    expect(track.stop).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('retains already delivered bytes when native setup errors before its start event', async () => {
    FakeRecorder.autoStart = false
    const pending = startRecording().catch(error => error)
    await vi.advanceTimersByTimeAsync(1)
    FakeRecorder.instance.ondataavailable?.({ data: new Blob(['original-before-start'], { type: 'audio/webm' }) })
    FakeRecorder.instance.onerror?.()
    const error = await pending
    expect(error.code).toBe('RECORDING')
    expect(await error.recovery.blob.text()).toBe('original-before-start')
    expect(track.stop).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('returns final real audio, correct MIME and seconds; stop is idempotent and releases microphone', async () => {
    const handle = await startRecording()
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(FakeRecorder.instance.start).toHaveBeenCalledWith(1000)
    await vi.advanceTimersByTimeAsync(2100)
    const first = handle.stop(), second = handle.stop()
    expect(first).toBe(second)
    const result = await first
    expect(result.blob.type).toBe('audio/webm;codecs=opus')
    expect(await result.blob.text()).toBe('final-audio')
    expect(result.duration).toBeCloseTo(2.1)
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(FakeRecorder.instance.stop).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('auto-stops at 180 seconds and retains the result for a later UI stop', async () => {
    const handle = await startRecording()
    await vi.advanceTimersByTimeAsync(MAX_RECORDING_SECONDS * 1000 + 1000)
    const result = await handle.stop()
    expect(result.duration).toBe(MAX_RECORDING_SECONDS)
    expect(result.blob.size).toBeGreaterThan(0)
    expect(track.stop).toHaveBeenCalledTimes(1)
  })
  it('uses Safari MP4 when WebM is unsupported', async () => {
    FakeRecorder.isTypeSupported.mockImplementation(type => type === 'audio/mp4')
    const handle = await startRecording()
    expect((await handle.stop()).blob.type).toBe('audio/mp4')
  })
  it('uses actual default recorder MIME when no preference is supported', async () => {
    FakeRecorder.isTypeSupported.mockReturnValue(false)
    const handle = await startRecording()
    expect((await handle.stop()).blob.type).toBe('audio/mp4')
  })
  it('cancels idempotently and releases tracks even without onstop', async () => {
    const handle = await startRecording()
    FakeRecorder.instance.stop.mockImplementation(() => { FakeRecorder.instance.state = 'inactive' })
    handle.cancel(); handle.cancel()
    await expect(handle.stop()).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('settles a microphone/device failure and cleans up', async () => {
    const handle = await startRecording()
    FakeRecorder.instance.onerror?.()
    await expect(handle.stop()).rejects.toMatchObject({ code: 'RECORDING' })
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('exposes already captured audio for recovery when a device errors', async () => {
    const handle = await startRecording()
    const partial = new Blob(['captured-before-error'], { type: 'audio/webm;codecs=opus' })
    FakeRecorder.instance.ondataavailable?.({ data: partial })
    await vi.advanceTimersByTimeAsync(1500)
    FakeRecorder.instance.onerror?.()
    const error = await handle.stop().catch(error => error)
    expect(error.code).toBe('RECORDING')
    expect(await error.recovery.blob.text()).toBe('captured-before-error')
    expect(error.recovery.duration).toBe(1.5)
    expect(track.stop).toHaveBeenCalledTimes(1)
  })
  it('stops and preserves capture when the microphone track ends', async () => {
    const handle = await startRecording()
    await vi.advanceTimersByTimeAsync(1000)
    track.onended?.()
    expect((await handle.stop()).duration).toBe(1)
    expect(track.stop).toHaveBeenCalledTimes(1)
  })
  it('bounds a browser that never fires the final stop event', async () => {
    const handle = await startRecording()
    FakeRecorder.instance.stop.mockImplementation(() => { FakeRecorder.instance.state = 'inactive' })
    const assertion = expect(handle.stop()).rejects.toMatchObject({ code: 'RECORDING' })
    await vi.advanceTimersByTimeAsync(5001); await assertion
    expect(track.stop).toHaveBeenCalledTimes(1)
  })
  it('rejects empty capture instead of fabricating a recording', async () => {
    const handle = await startRecording()
    FakeRecorder.instance.stop.mockImplementation(() => { FakeRecorder.instance.state = 'inactive'; queueMicrotask(() => FakeRecorder.instance.onstop?.()) })
    await expect(handle.stop()).rejects.toMatchObject({ code: 'EMPTY' })
    expect(track.stop).toHaveBeenCalledTimes(1)
  })
  it.each([['NotAllowedError', 'PERMISSION'], ['NotFoundError', 'DEVICE'], ['NotReadableError', 'DEVICE']])('normalizes microphone %s', async (name, code) => {
    getUserMedia.mockRejectedValue(new DOMException('private device details', name))
    await expect(startRecording()).rejects.toMatchObject({ code })
  })
  it('handles unsupported browser and constructor failure with track release', async () => {
    vi.stubGlobal('MediaRecorder', undefined)
    await expect(startRecording()).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    vi.stubGlobal('MediaRecorder', class { static isTypeSupported() { return true }; constructor() { throw new Error('private device info') } })
    await expect(startRecording()).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    expect(track.stop).toHaveBeenCalledTimes(1)
  })
})

describe('PCM capture lifecycle (unit doubles; real audio graph covered by browser tests)', () => {
  class PcmContext {
    static instance: PcmContext
    static addModule = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined)
    sampleRate = 48000
    state = 'running'
    destination = {}
    onstatechange: (() => void) | null = null
    input = { connect: vi.fn(), disconnect: vi.fn() }
    get audioWorklet() { return { addModule: PcmContext.addModule } }
    resume = vi.fn(async () => undefined)
    close = vi.fn(async () => { this.state = 'closed' })
    createMediaStreamSource = vi.fn(() => this.input)
    constructor() { PcmContext.instance = this }
  }
  class PcmNode {
    static instance: PcmNode
    onprocessorerror: (() => void) | null = null
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      close: vi.fn(),
      postMessage: vi.fn((message: string) => {
        if (message === 'stop') queueMicrotask(() => {
          this.emit(new Float32Array([0.25]))
          this.port.onmessage?.({ data: { type: 'done' } })
        })
      }),
    }
    connect = vi.fn()
    disconnect = vi.fn()
    constructor() { PcmNode.instance = this; queueMicrotask(() => this.port.onmessage?.({ data: { type: 'ready' } })) }
    emit(samples: Float32Array) { this.port.onmessage?.({ data: { type: 'data', samples } }) }
  }
  beforeEach(() => {
    PcmContext.addModule.mockReset().mockResolvedValue(undefined)
    vi.stubGlobal('MediaRecorder', undefined)
    vi.stubGlobal('AudioContext', PcmContext)
    vi.stubGlobal('AudioWorkletNode', PcmNode)
  })
  it('uses getUserMedia, flushes the final PCM sample, writes a valid WAV and reports captured sample duration', async () => {
    const handle = await startRecording()
    const context = PcmContext.instance, node = PcmNode.instance
    node.emit(new Float32Array([-1, -0.5, 0, 0.5, 1]))
    await vi.advanceTimersByTimeAsync(5000)
    const first = handle.stop()
    expect(handle.stop()).toBe(first)
    const capture = await first
    const bytes = await capture.blob.arrayBuffer(), view = new DataView(bytes)
    expect(capture.blob.type).toBe('audio/wav')
    expect(capture.duration).toBe(6 / 48000)
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(48000)
    expect(view.getUint32(40, true)).toBe(12)
    expect(Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true))).toEqual([-32768, -16384, 0, 16384, 32767, 8192])
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(node.port.postMessage).toHaveBeenCalledTimes(1)
    expect(context.close).toHaveBeenCalledTimes(1)
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('recovers through PCM when native encoder construction fails without requesting a second stream', async () => {
    vi.stubGlobal('MediaRecorder', class { static isTypeSupported() { return false }; constructor() { throw new Error('encoder unavailable') } })
    const handle = await startRecording()
    expect((await handle.stop()).blob.type).toBe('audio/wav')
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })
  it('cancels without returning recorded samples and releases every resource', async () => {
    const handle = await startRecording()
    PcmNode.instance.emit(new Float32Array([0.2, 0.3]))
    handle.cancel(); handle.cancel()
    await expect(handle.stop()).rejects.toMatchObject({ code: 'CANCELLED', recovery: undefined })
    expect(PcmNode.instance.port.close).toHaveBeenCalledOnce()
    expect(PcmContext.instance.input.disconnect).toHaveBeenCalledOnce()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['processorerror', 'suspended'])('retains captured PCM when the audio graph is %s, without inventing gap time', async failure => {
    const handle = await startRecording()
    PcmNode.instance.emit(new Float32Array([0.5, -0.5]))
    await vi.advanceTimersByTimeAsync(5000)
    // The audio thread is unavailable: no acknowledgement, but already queued
    // PCM must still be accepted after the failure event from another task source.
    PcmNode.instance.port.postMessage.mockImplementation(() => undefined)
    if (failure === 'processorerror') PcmNode.instance.onprocessorerror?.()
    else { PcmContext.instance.state = 'suspended'; PcmContext.instance.onstatechange?.() }
    PcmNode.instance.emit(new Float32Array([0.25]))
    const pending = handle.stop().catch(error => error)
    await vi.advanceTimersByTimeAsync(2001)
    const error = await pending
    expect(error.code).toBe('RECORDING')
    expect(error.recovery.duration).toBe(3 / 48000)
    expect(error.recovery.blob.size).toBe(50)
    expect(error.recovery.blob.type).toBe('audio/wav')
    expect(track.stop).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds a lost flush acknowledgement and preserves the available partial recording', async () => {
    const handle = await startRecording()
    PcmNode.instance.emit(new Float32Array([0.25]))
    PcmNode.instance.port.postMessage.mockImplementation(() => undefined)
    const assertion = expect(handle.stop()).rejects.toMatchObject({ code: 'RECORDING', recovery: { duration: 1 / 48000 } })
    await vi.advanceTimersByTimeAsync(2001)
    await assertion
    expect(track.stop).toHaveBeenCalledOnce()
  })
  it('auto-stops on the wall-clock limit and on a device ending', async () => {
    const first = await startRecording()
    await vi.advanceTimersByTimeAsync(MAX_RECORDING_SECONDS * 1000)
    expect((await first.stop()).duration).toBe(1 / 48000)
    const second = await startRecording()
    track.onended?.()
    expect((await second.stop()).blob.type).toBe('audio/wav')
  })
  it('does not manufacture a recording from an empty graph', async () => {
    const handle = await startRecording()
    PcmNode.instance.port.postMessage.mockImplementation(() => { queueMicrotask(() => PcmNode.instance.port.onmessage?.({ data: { type: 'done' } })) })
    await expect(handle.stop()).rejects.toMatchObject({ code: 'EMPTY' })
  })
  it('releases the microphone on a failed or stalled same-origin worklet load', async () => {
    PcmContext.addModule.mockRejectedValueOnce(new Error('load failure'))
    await expect(startRecording()).rejects.toMatchObject({ code: 'RECORDING' })
    expect(track.stop).toHaveBeenCalledOnce()
    PcmContext.addModule.mockImplementationOnce(() => new Promise(() => undefined))
    const assertion = expect(startRecording()).rejects.toMatchObject({ code: 'RECORDING' })
    await vi.advanceTimersByTimeAsync(5001)
    await assertion
    expect(track.stop).toHaveBeenCalledTimes(2)
    expect(PcmContext.instance.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not miss a device ending while its worklet module is still loading', async () => {
    PcmContext.addModule.mockImplementationOnce(() => new Promise(() => undefined))
    const pending = startRecording()
    const assertion = expect(pending).rejects.toMatchObject({ code: 'RECORDING' })
    await vi.advanceTimersByTimeAsync(1)
    expect(track.onended).toBeTypeOf('function')
    track.onended?.()
    await assertion
    expect(track.stop).toHaveBeenCalledOnce()
    expect(PcmContext.instance.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('PCM worklet buffering and hard sample limit', () => {
  let Processor: new (options: { processorOptions: { maxSeconds: number; maxBytes: number } }) => {
    port: { postMessage: ReturnType<typeof vi.fn>; onmessage: (event: { data: string }) => void }
    process: (inputs: Float32Array[][]) => boolean
  }
  beforeEach(async () => {
    vi.resetModules()
    vi.stubGlobal('sampleRate', 48000)
    vi.stubGlobal('AudioWorkletProcessor', class { port = { postMessage: vi.fn(), onmessage: null } })
    vi.stubGlobal('registerProcessor', (_name: string, constructor: typeof Processor) => { Processor = constructor })
    await import('../src/audio/pcm-recorder')
  })
  it('flushes variable render quanta exactly once, omitting empty input', () => {
    const processor = new Processor({ processorOptions: { maxSeconds: 180, maxBytes: 1000 } })
    expect(processor.port.postMessage).not.toHaveBeenCalled()
    processor.process([])
    processor.process([[new Float32Array()]])
    expect(processor.port.postMessage).not.toHaveBeenCalled()
    processor.process([[new Float32Array([0.1, 0.2, 0.3])]])
    processor.process([[new Float32Array([0.4])]])
    processor.port.onmessage({ data: 'stop' })
    processor.port.onmessage({ data: 'stop' })
    const messages = processor.port.postMessage.mock.calls.map(call => call[0])
    expect(messages.map(message => message.type)).toEqual(['ready', 'data', 'done'])
    expect(messages[1].samples).toEqual(new Float32Array([0.1, 0.2, 0.3, 0.4]))
    expect(processor.process([[new Float32Array([0.5])]])).toBe(false)
  })
  it('enforces the byte ceiling inside the audio thread before another main-thread event', () => {
    const processor = new Processor({ processorOptions: { maxSeconds: 180, maxBytes: 50 } })
    expect(processor.process([[new Float32Array([1, 2, 3, 4, 5])]])).toBe(false)
    expect(processor.port.postMessage.mock.calls[1][0].samples).toEqual(new Float32Array([1, 2, 3]))
    expect(processor.port.postMessage.mock.calls[2][0]).toEqual({ type: 'done' })
  })
})

describe('browser speech playback controls', () => {
  class FakeUtterance {
    lang = ''; rate = 1; voice: unknown = null
    onend: (() => void) | null = null
    onstart: (() => void) | null = null
    onerror: ((event: { error: string }) => void) | null = null
    constructor(readonly text: string) {}
  }
  const localVoice = { lang: 'en-US', localService: true }
  let spoken: FakeUtterance
  let synthesis: { speak: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn>; getVoices: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    synthesis = { speak: vi.fn(utterance => { spoken = utterance }), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), getVoices: vi.fn(() => [localVoice]) }
    vi.stubGlobal('speechSynthesis', synthesis); vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
  })
  it('plays real speech at the requested rate and resolves only when ended', async () => {
    const pending = speakText('Hello.', 0.85)
    expect(spoken.text).toBe('Hello.'); expect(spoken.rate).toBe(0.85); expect(spoken.voice).toBe(localVoice)
    pauseSpeech(); resumeSpeech()
    expect(synthesis.pause).toHaveBeenCalledTimes(1); expect(synthesis.resume).toHaveBeenCalled()
    spoken.onend?.(); await expect(pending).resolves.toBeUndefined()
  })
  it('settles stopped/replaced speech even when the browser omits end events', async () => {
    const first = speakText('First.'), second = speakText('Second.')
    await expect(first).resolves.toBeUndefined()
    stopSpeech(); await expect(second).resolves.toBeUndefined()
    expect(synthesis.cancel).toHaveBeenCalledTimes(3)
  })
  it('clamps speed, handles cancellation and reports safe synthesis failure', async () => {
    const fast = speakText('Hello.', 9)
    expect(spoken.rate).toBe(2); spoken.onerror?.({ error: 'interrupted' }); await fast
    const failure = speakText('Hello.')
    spoken.onerror?.({ error: 'private device details' })
    await expect(failure).rejects.toThrow('Speech playback failed')
  })
  it('handles unsupported browser and invalid input', async () => {
    await expect(speakText('Hello.', NaN)).rejects.toThrow('valid playback speed')
    vi.stubGlobal('speechSynthesis', undefined)
    await expect(speakText('Hello.')).rejects.toThrow('unavailable')
    expect(() => stopSpeech()).not.toThrow()
  })
  it('refuses remote/default/non-English voices without sending text', async () => {
    synthesis.getVoices.mockReturnValue([{ lang: 'en-US', localService: false }, { lang: 'zh-CN', localService: true }])
    await expect(speakText('Private learning text.')).rejects.toThrow('No local English voice')
    expect(synthesis.speak).not.toHaveBeenCalled()
    synthesis.getVoices.mockReturnValue([])
    await expect(speakText('Private learning text.')).rejects.toThrow('No local English voice')
    expect(synthesis.speak).not.toHaveBeenCalled()
  })
  it('reports local start/end separately and never reports stop as completion', async () => {
    const events = { onStart: vi.fn(), onEnd: vi.fn() }
    const first = speakLocalText('Hello.', 1, events)
    expect(events.onStart).not.toHaveBeenCalled()
    spoken.onstart?.(); expect(events.onStart).toHaveBeenCalledTimes(1)
    stopSpeech(); await first
    expect(events.onEnd).not.toHaveBeenCalled()
    const second = speakLocalText('Hello again.', 1, events)
    spoken.onend?.(); await second
    expect(events.onEnd).toHaveBeenCalledTimes(1)
  })
})
