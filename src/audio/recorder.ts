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

/** Returns a real locally captured blob. Caller must persist it BEFORE any STT call. */
export async function startRecording(): Promise<RecordingHandle> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new AudioError('UNSUPPORTED')
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
  let recorder: MediaRecorder
  try {
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type))
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  } catch { release(); throw new AudioError('UNSUPPORTED') }

  const chunks: Blob[] = []
  let bytes = 0, settled = false, stopping = false, cancelled = false
  const started = performance.now()
  let ended: number | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let resolve!: (result: { blob: Blob; duration: number }) => void
  let reject!: (error: AudioError) => void
  const result = new Promise<{ blob: Blob; duration: number }>((res, rej) => { resolve = res; reject = rej })
  // Auto-stop/device errors can precede the UI's first call to stop().
  void result.catch(() => undefined)

  const finish = (error?: AudioError) => {
    if (settled) return
    settled = true
    clearTimeout(timer); clearTimeout(watchdog)
    recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null
    release()
    const type = recorder.mimeType || chunks.find(chunk => chunk.type)?.type || ''
    const blob = new Blob(chunks, { type })
    const duration = Math.min(MAX_RECORDING_SECONDS, Math.max(0, ((ended ?? performance.now()) - started) / 1000))
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
  const timer = setTimeout(() => { void stop() }, MAX_RECORDING_SECONDS * 1000)
  recorder.ondataavailable = event => {
    if (!cancelled && !settled && event.data.size) {
      chunks.push(event.data); bytes += event.data.size
      if (bytes >= MAX_BYTES) void stop()
    }
  }
  recorder.onstop = () => finish(cancelled ? new AudioError('CANCELLED') : undefined)
  recorder.onerror = () => finish(new AudioError('RECORDING'))
  for (const track of stream.getTracks()) track.onended = () => { void stop() }
  try { recorder.start(1000) }
  catch { finish(new AudioError('RECORDING')); throw new AudioError('RECORDING') }

  return { stop, cancel: () => {
    if (settled) return
    cancelled = true
    try { if (recorder.state !== 'inactive') recorder.stop() } catch { /* Release below even when stop fails. */ }
    finish(new AudioError('CANCELLED'))
  } }
}
