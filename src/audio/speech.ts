let current: { utterance: SpeechSynthesisUtterance; finish: (error?: Error) => void } | undefined

/** Cancelling settles the pending promise even on browsers that omit onend. */
export function stopSpeech(): void {
  const active = current
  active?.finish()
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
}

export function pauseSpeech(): void { if (typeof speechSynthesis !== 'undefined') speechSynthesis.pause() }
export function resumeSpeech(): void { if (typeof speechSynthesis !== 'undefined') speechSynthesis.resume() }

export function localEnglishVoice(): SpeechSynthesisVoice | undefined {
  if (typeof speechSynthesis === 'undefined') return undefined
  const voices = speechSynthesis.getVoices().filter(voice => voice.localService === true && /^en(?:-|$)/i.test(voice.lang))
  return voices.find(voice => voice.lang === 'en-US') ?? voices[0]
}

/** Browser synthesis is local-only; never allow the browser to select a remote default. */
export async function speakText(text: string, rate = 1): Promise<void> {
  return speakLocalText(text, rate)
}

export async function speakLocalText(text: string, rate = 1, events: { onStart?: () => void; onEnd?: () => void } = {}): Promise<void> {
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') throw new Error('Browser speech playback is unavailable. Use the recorded audio player.')
  if (!text.trim()) return
  if (text.length > 16000 || !Number.isFinite(rate)) throw new Error('Use a shorter passage and a valid playback speed.')
  const voice = localEnglishVoice()
  if (!voice) throw new Error('No local English voice is available. Install a device voice or use saved audio. No text was sent to a browser voice service.')
  stopSpeech()
  return new Promise<void>((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = voice.lang
    utterance.rate = Math.max(0.5, Math.min(2, rate))
    utterance.voice = voice
    const finish = (error?: Error) => {
      if (current?.utterance !== utterance) return
      current = undefined
      utterance.onstart = null; utterance.onend = null; utterance.onerror = null
      if (error) reject(error); else resolve()
    }
    utterance.onstart = () => events.onStart?.()
    utterance.onend = () => { events.onEnd?.(); finish() }
    utterance.onerror = event => finish(event.error === 'canceled' || event.error === 'interrupted' ? undefined : new Error('Speech playback failed. Try the audio player or another browser voice.'))
    current = { utterance, finish }
    try { speechSynthesis.speak(utterance); speechSynthesis.resume() }
    catch { finish(new Error('Speech playback could not start. Use the audio player.')) }
  })
}
