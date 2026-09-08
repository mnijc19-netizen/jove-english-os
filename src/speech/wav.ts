import { SPEECH_LIMITS, SpeechError } from './types'

/** Canonical PCM16 WAV only: header, length and actual sample count are checked server-side. */
export function inspectAssessmentWav(bytes: Uint8Array): { durationSeconds: number; sampleCount: number } {
  const fail = () => { throw new SpeechError('INVALID_AUDIO') }
  if (bytes.length < 44 || bytes.length > SPEECH_LIMITS.maxWavBytes) return fail()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (at: number, n: number) => String.fromCharCode(...bytes.subarray(at, at + n))
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE' || text(12, 4) !== 'fmt ' || text(36, 4) !== 'data' || view.getUint32(4, true) !== bytes.length - 8 || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 16000 || view.getUint32(28, true) !== 32000 || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 || view.getUint32(40, true) !== bytes.length - 44 || (bytes.length - 44) % 2) return fail()
  const sampleCount = (bytes.length - 44) / 2
  const durationSeconds = sampleCount / 16000
  if (durationSeconds < SPEECH_LIMITS.minSeconds || durationSeconds > SPEECH_LIMITS.maxSeconds) return fail()
  let nonzero = false
  for (let offset = 44; offset < bytes.length; offset += 2) if (view.getInt16(offset, true) !== 0) { nonzero = true; break }
  if (!nonzero) throw new SpeechError('NO_SPEECH')
  return { durationSeconds, sampleCount }
}

/** Encoding only, not a resampler. Supply Web Audio's rendered 16 kHz mono samples. */
export function encodeAssessmentWav(samples: Float32Array, sampleRate = 16000): Uint8Array<ArrayBuffer> {
  if (sampleRate !== 16000 || samples.length < 4000 || samples.length > 480000) throw new SpeechError('INVALID_AUDIO')
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const put = (at: number, text: string) => { for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i) }
  put(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); put(8, 'WAVE'); put(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  put(36, 'data'); view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) throw new SpeechError('INVALID_AUDIO')
    const sample = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
  }
  inspectAssessmentWav(bytes)
  return bytes
}

/** Browser-only conversion; keep the original Blob saved before invoking. No network or keys. */
export async function recordingToAssessmentWav(blob: Blob, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const cancelled = () => { if (signal?.aborted) throw new SpeechError('CANCELLED') }
  cancelled()
  if (typeof OfflineAudioContext === 'undefined') throw new SpeechError('UNSUPPORTED')
  if (!blob.size || blob.size > 10 * 1024 * 1024) throw new SpeechError('INVALID_AUDIO')
  try {
    const decoder = new OfflineAudioContext(1, 1, 16000)
    const decoded = await decoder.decodeAudioData(await blob.arrayBuffer())
    cancelled()
    if (decoded.duration < SPEECH_LIMITS.minSeconds || decoded.duration > SPEECH_LIMITS.maxSeconds || decoded.numberOfChannels > 2) throw new SpeechError('INVALID_AUDIO')
    // Use Web Audio's resampling/downmixing, never relabel WebM/MP4 or use naive decimation.
    const render = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000)
    const source = render.createBufferSource(); source.buffer = decoded; source.connect(render.destination); source.start()
    const mono = await render.startRendering()
    cancelled()
    return encodeAssessmentWav(mono.getChannelData(0))
  } catch (error) { cancelled(); throw error instanceof SpeechError ? error : new SpeechError('INVALID_AUDIO') }
}
