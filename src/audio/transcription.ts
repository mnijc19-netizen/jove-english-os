import { ProviderError } from '../ai/errors'
import { abortable, checkAbort, withDeadline } from '../ai/transport'

export const TRANSCRIPTION_SAMPLE_RATE = 16000
export const TRANSCRIPTION_MAX_SECONDS = 300
const maxSamples = TRANSCRIPTION_SAMPLE_RATE * TRANSCRIPTION_MAX_SECONDS
/** Canonical mono PCM, independent of MIME claims or browser container duration. */
export function transcriptionWavDuration(bytes: Uint8Array): number {
  if (bytes.byteLength < 46 || bytes.byteLength > 44 + maxSamples * 2) throw new ProviderError('INPUT')
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const word = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))
  if (word(0) !== 'RIFF' || word(8) !== 'WAVE' || word(12) !== 'fmt ' || word(36) !== 'data'
    || data.getUint32(4, true) !== bytes.length - 8 || data.getUint32(16, true) !== 16 || data.getUint16(20, true) !== 1
    || data.getUint16(22, true) !== 1 || data.getUint32(24, true) !== TRANSCRIPTION_SAMPLE_RATE
    || data.getUint32(28, true) !== TRANSCRIPTION_SAMPLE_RATE * 2 || data.getUint16(32, true) !== 2 || data.getUint16(34, true) !== 16
    || data.getUint32(40, true) !== bytes.length - 44 || (bytes.length - 44) % 2) throw new ProviderError('INPUT')
  return (bytes.length - 44) / (TRANSCRIPTION_SAMPLE_RATE * 2)
}
export function encodeTranscriptionWav(samples: Float32Array): Uint8Array<ArrayBuffer> {
  if (!samples.length || samples.length > maxSamples) throw new ProviderError('INPUT')
  const bytes = new Uint8Array(44 + samples.length * 2), view = new DataView(bytes.buffer)
  const word = (at: number, value: string) => [...value].forEach((char, index) => { bytes[at + index] = char.charCodeAt(0) })
  word(0, 'RIFF'); word(8, 'WAVE'); word(12, 'fmt '); word(36, 'data')
  view.setUint32(4, bytes.length - 8, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, TRANSCRIPTION_SAMPLE_RATE, true); view.setUint32(28, TRANSCRIPTION_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index++) {
    if (!Number.isFinite(samples[index])) throw new ProviderError('INPUT')
    const value = Math.max(-1, Math.min(1, samples[index]!))
    view.setInt16(44 + index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
  }
  return bytes
}
/** Creates a service derivative only; callers keep the original saved recording. */
export function normalizeTranscriptionAudio(blob: Blob, signal?: AbortSignal): Promise<Blob> {
  return withDeadline(signal, 20000, async scoped => {
    if (!blob.size || blob.size > 25 * 1024 * 1024) throw new ProviderError('INPUT')
    const original = await abortable(blob.arrayBuffer(), scoped)
    try {
      transcriptionWavDuration(new Uint8Array(original))
      return new Blob([original], { type: 'audio/wav' })
    } catch { /* Browser container needs real decoding/resampling, never relabeling. */ }
    if (typeof AudioContext === 'undefined' || typeof OfflineAudioContext === 'undefined') throw new ProviderError('INPUT')
    const decoder = new AudioContext()
    try {
      const decoded = await abortable(decoder.decodeAudioData(original), scoped)
      if (!decoded.length || !Number.isFinite(decoded.duration) || decoded.duration > TRANSCRIPTION_MAX_SECONDS || decoded.numberOfChannels > 8) throw new ProviderError('INPUT')
      const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * TRANSCRIPTION_SAMPLE_RATE), TRANSCRIPTION_SAMPLE_RATE)
      const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start()
      const rendered = await abortable(offline.startRendering(), scoped)
      checkAbort(scoped)
      return new Blob([encodeTranscriptionWav(rendered.getChannelData(0))], { type: 'audio/wav' })
    } finally { void decoder.close().catch(() => undefined) }
  })
}
