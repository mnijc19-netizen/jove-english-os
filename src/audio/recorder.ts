import pcmWorkletUrl from './pcm-recorder.ts?worker&url'

export interface RecordingHandle {
  stop: () => Promise<{ blob: Blob; duration: number }>
  cancel: () => void
}

export const MAX_RECORDING_SECONDS = 180
const MAX_BYTES = 25 * 1024 * 1024
export type AudioErrorCode = 'UNSUPPORTED' | 'PERMISSION' | 'DEVICE' | 'RECORDING' | 'EMPTY' | 'CANCELLED'
const messages: Record<AudioErrorCode, string> = {
  UNSUPPORTED: 'Audio recording is unavailable. Use a supported browser over HTTPS, or type your response.',
  PERMISSION: 'Microphone permission was denied. Allow the microphone in browser settings, or type your response.',
  DEVICE: 'No working microphone is available. Check your device, or type your response.',
  RECORDING: 'The microphone recording could not be completed. Try another browser or device.',
  EMPTY: 'No audio was captured. Check your microphone and record again.',
  CANCELLED: 'Recording cancelled.',
}

export class AudioError extends Error {
  constructor(readonly code: AudioErrorCode, readonly recovery?: { blob: Blob; duration: number }) { super(messages[code]); this.name = 'AudioError' }
}

function supportsPcmCapture(): boolean {
  return typeof AudioContext !== 'undefined' && typeof AudioWorkletNode !== 'undefined'
    && 'audioWorklet' in AudioContext.prototype
}

/** PCM16 mono, at the capture context's native rate; no provider conversion. */
function pcmWave(chunks: Float32Array[], sampleRate: number, frames: number): Blob {
  const bytes = new ArrayBuffer(44 + frames * 2)
  const view = new DataView(bytes)
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)) }
  text(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, frames * 2, true)
  let offset = 44
  for (const chunk of chunks) for (const value of chunk) {
    const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0
    view.setInt16(offset, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
    offset += 2
  }
  return new Blob([bytes], { type: 'audio/wav' })
}

/** Real Web Audio fallback for ports/codec combinations without MediaRecorder. */
async function startPcmRecording(stream: MediaStream, release: () => void): Promise<RecordingHandle> {
  let context: AudioContext
  try { context = new AudioContext() }
  catch { release(); throw new AudioError('UNSUPPORTED') }
  let node: AudioWorkletNode | undefined, source: MediaStreamAudioSourceNode | undefined
  let settled = false, stopping = false, ready = false
  let failureCode: AudioErrorCode | undefined
  let rejectSetup: ((error: AudioError) => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined, watchdog: ReturnType<typeof setTimeout> | undefined
  let setupTimer: ReturnType<typeof setTimeout> | undefined
  const chunks: Float32Array[] = []
  let frames = 0
  const maxFrames = Math.min(Math.floor(context.sampleRate * MAX_RECORDING_SECONDS), Math.floor((MAX_BYTES - 44) / 2))
  let resolve!: (capture: { blob: Blob; duration: number }) => void
  let reject!: (error: AudioError) => void
  const result = new Promise<{ blob: Blob; duration: number }>((res, rej) => { resolve = res; reject = rej })
  void result.catch(() => undefined)
  const cleanup = () => {
    clearTimeout(timer); clearTimeout(watchdog); clearTimeout(setupTimer)
    context.onstatechange = null
    if (node) { node.onprocessorerror = null; node.port.onmessage = null; node.port.close(); node.disconnect() }
    source?.disconnect()
    release()
    void context.close().catch(() => undefined)
  }
  const finish = (code: AudioErrorCode | undefined = failureCode) => {
    if (settled) return
    settled = true
    cleanup()
    // Duration comes from samples actually received, not wall-clock time while
    // iOS suspends the audio graph. Unreceived/failed tail is never invented.
    const capture = frames && code !== 'CANCELLED' ? { blob: pcmWave(chunks, context.sampleRate, frames), duration: frames / context.sampleRate } : undefined
    chunks.length = 0
    if (code) reject(new AudioError(code, code !== 'CANCELLED' ? capture : undefined))
    else if (!capture) reject(new AudioError('EMPTY'))
    else resolve(capture)
  }
  const stop = () => {
    if (stopping || settled) return result
    stopping = true
    clearTimeout(timer)
    // MessagePort FIFO orders every final sample before the done acknowledgement.
    // A suspended/crashed worklet has a bounded recovery path for prior samples.
    watchdog = setTimeout(() => finish('RECORDING'), 2000)
    try { node!.port.postMessage('stop') } catch { finish('RECORDING') }
    return result
  }
  const fail = () => {
    failureCode = 'RECORDING'
    // Failure events and port messages use different task sources. Keep the
    // handler alive for a bounded flush, including samples already in transit.
    if (node) void stop()
    else finish('RECORDING')
  }
  for (const track of stream.getTracks()) track.onended = () => {
    if (!ready) { rejectSetup?.(new AudioError('RECORDING')); fail() }
    else void stop()
  }
  try {
    const initialized = new Promise<void>((resolveReady, rejectReady) => {
      rejectSetup = rejectReady
      if (stream.getTracks().some(track => track.readyState === 'ended')) { rejectReady(new AudioError('RECORDING')); return }
      setupTimer = setTimeout(() => rejectReady(new AudioError('RECORDING')), 5000)
      // Begin resume immediately, before awaiting module/network initialization.
      const resumed = context.resume()
      void (async () => {
        await context.audioWorklet.addModule(pcmWorkletUrl)
        if (settled) return
        node = new AudioWorkletNode(context, 'jove-pcm-capture', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
          channelCount: 1, channelCountMode: 'explicit',
          processorOptions: { maxSeconds: MAX_RECORDING_SECONDS, maxBytes: MAX_BYTES },
        })
        node.onprocessorerror = () => { rejectReady(new AudioError('RECORDING')); fail() }
        node.port.onmessage = event => {
          if (settled) return
          if (event.data.type === 'ready') { ready = true; void resumed.then(resolveReady, rejectReady) }
          else if (event.data.type === 'data' && event.data.samples instanceof Float32Array) {
            const samples = event.data.samples.slice(0, Math.max(0, maxFrames - frames))
            if (samples.length) { chunks.push(samples); frames += samples.length }
            if (frames >= maxFrames) void stop()
          } else if (event.data.type === 'done') finish()
        }
        source = context.createMediaStreamSource(stream)
        source.connect(node)
        node.connect(context.destination) // silent output keeps the processing graph active
        await resumed
      })().catch(rejectReady)
      // A resume rejection must not become an unhandled rejection during addModule.
      void resumed.catch(rejectReady)
    })
    await initialized
    clearTimeout(setupTimer)
    if (settled || !ready || context.state !== 'running' || stream.getTracks().some(track => track.readyState === 'ended')) throw new AudioError('RECORDING')
    context.onstatechange = () => { if (context.state !== 'running') fail() }
    timer = setTimeout(() => { void stop() }, MAX_RECORDING_SECONDS * 1000)
  } catch {
    fail()
    await result // Preserve any real partial capture on an initialization failure.
    throw new AudioError('RECORDING')
  }
  return { stop, cancel: () => {
    if (settled) return
    try { node?.port.postMessage('cancel') } catch { /* Resource cleanup still runs. */ }
    finish('CANCELLED')
  } }
}

/** Returns a real locally captured blob. Caller must persist it BEFORE any STT call. */
export async function startRecording(): Promise<RecordingHandle> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia
    || (typeof MediaRecorder === 'undefined' && !supportsPcmCapture())) throw new AudioError('UNSUPPORTED')
  let stream: MediaStream
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
  catch (error) {
    const name = error instanceof Error ? error.name : ''
    throw new AudioError(name === 'NotAllowedError' || name === 'SecurityError' ? 'PERMISSION' : 'DEVICE')
  }
  let released = false
  const release = () => {
    if (released) return
    released = true
    for (const track of stream.getTracks()) { track.onended = null; track.stop() }
  }
  if (typeof MediaRecorder === 'undefined') return startPcmRecording(stream, release)
  let recorder: MediaRecorder
  try {
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type))
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  } catch {
    if (supportsPcmCapture()) return startPcmRecording(stream, release)
    release(); throw new AudioError('UNSUPPORTED')
  }

  const chunks: Blob[] = []
  let bytes = 0, settled = false, stopping = false, cancelled = false
  let started: number | undefined
  let ended: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let startupFailure = false
  let resolveStarted!: () => void
  const activated = new Promise<void>(resolve => { resolveStarted = resolve })
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let resolve!: (result: { blob: Blob; duration: number }) => void
  let reject!: (error: AudioError) => void
  const result = new Promise<{ blob: Blob; duration: number }>((res, rej) => { resolve = res; reject = rej })
  // Auto-stop/device errors can precede the UI's first call to stop().
  void result.catch(() => undefined)

  const finish = (error?: AudioError) => {
    if (settled) return
    settled = true
    clearTimeout(timer); clearTimeout(watchdog); clearTimeout(setupTimer)
    recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null; recorder.onstart = null
    release()
    const type = recorder.mimeType || chunks.find(chunk => chunk.type)?.type || ''
    const blob = new Blob(chunks, { type })
    const duration = started === undefined ? 0 : Math.min(MAX_RECORDING_SECONDS, Math.max(0, ((ended ?? performance.now()) - started) / 1000))
    chunks.length = 0
    if (error) {
      reject(error.code !== 'CANCELLED' && blob.size && type.startsWith('audio/')
        ? new AudioError(error.code, { blob, duration }) : error)
      return
    }
    if (!blob.size || !type.startsWith('audio/')) { reject(new AudioError('EMPTY')); return }
    resolve({ blob, duration })
  }
  const stop = () => {
    if (stopping || settled) return result
    stopping = true; ended = performance.now()
    clearTimeout(timer)
    try {
      if (recorder.state !== 'inactive') recorder.stop()
      // An inactive recorder may have final data/onstop events still queued.
      if (!settled) watchdog = setTimeout(() => finish(new AudioError('RECORDING')), 5000)
    } catch { finish(new AudioError('RECORDING')) }
    return result
  }
  // start() changes state synchronously, but native capture starts asynchronously.
  // Permission/setup latency must not become either UI time or recorded duration.
  recorder.onstart = () => {
    if (settled || stopping) return
    started = performance.now()
    clearTimeout(setupTimer)
    timer = setTimeout(() => { void stop() }, MAX_RECORDING_SECONDS * 1000)
    resolveStarted()
  }
  const setupTimer = setTimeout(() => { startupFailure = true; void stop() }, 5000)
  recorder.ondataavailable = event => {
    if (!cancelled && !settled && event.data.size) {
      chunks.push(event.data); bytes += event.data.size
      if (bytes >= MAX_BYTES) void stop()
    }
  }
  recorder.onstop = () => finish(cancelled ? new AudioError('CANCELLED') : startupFailure ? new AudioError('RECORDING') : undefined)
  recorder.onerror = () => finish(new AudioError('RECORDING'))
  for (const track of stream.getTracks()) track.onended = () => { void stop() }
  try { recorder.start(1000) }
  catch { finish(new AudioError('RECORDING')); throw new AudioError('RECORDING') }

  // A device can end/fail before start. Drain normal final events and preserve
  // any real partial Blob instead of leaving preparation pending forever.
  await Promise.race([activated, result.then(capture => { throw new AudioError('RECORDING', capture) })])

  return { stop, cancel: () => {
    if (settled) return
    cancelled = true
    try { if (recorder.state !== 'inactive') recorder.stop() } catch { /* Release below even when stop fails. */ }
    finish(new AudioError('CANCELLED'))
  } }
}
