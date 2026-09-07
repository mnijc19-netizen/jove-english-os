import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_RECORDING_SECONDS, startRecording } from '../src/audio/recorder'
import { pauseSpeech, resumeSpeech, speakLocalText, speakText, stopSpeech } from '../src/audio/speech'

class FakeRecorder {
  static instance: FakeRecorder
  static isTypeSupported = vi.fn((type: string) => type.startsWith('audio/webm'))
  mimeType: string
  state = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  start = vi.fn(() => { this.state = 'recording' })
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
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal('MediaRecorder', FakeRecorder)
})
afterEach(() => { stopSpeech(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('browser recording lifecycle', () => {
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
