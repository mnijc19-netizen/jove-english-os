import type { Settings } from '../domain/types'

/** Must match the main store's generatedSpeech identity; no credentials enter this key. */
export function speechIdentity(text: string, settings: Pick<Settings, 'ttsModel' | 'voice' | 'accent'>): string {
  return JSON.stringify([text, settings.ttsModel, settings.voice, settings.accent])
}

export async function speechCacheId(identity: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))
  return 'tts-' + Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
