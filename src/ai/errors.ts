export type ProviderErrorCode =
  | 'NO_KEY' | 'AUTH' | 'CREDITS' | 'BUDGET' | 'RATE_LIMIT' | 'NETWORK'
  | 'TIMEOUT' | 'CANCELLED' | 'MODEL_REQUIRED' | 'MODEL_UNAVAILABLE' | 'VOICE'
  | 'BAD_REQUEST' | 'UNAVAILABLE' | 'INVALID_RESPONSE' | 'TRUNCATED'
  | 'INPUT' | 'RETRIEVAL' | 'USAGE'

const messages: Record<ProviderErrorCode, string> = {
  NO_KEY: 'Add an OpenRouter API key in Settings to use AI. Your saved work is still available.',
  AUTH: 'OpenRouter could not authenticate this key. Check or replace it in Settings.',
  CREDITS: 'OpenRouter credits are insufficient. Your work is saved; check your account.',
  BUDGET: 'The request budget guard blocked this request. Check your daily budget in Settings.',
  RATE_LIMIT: 'OpenRouter is rate limited. Wait briefly before retrying.',
  NETWORK: 'The network request failed. Check your connection and retry your saved work.',
  TIMEOUT: 'The request timed out. Retry or shorten your saved input.',
  CANCELLED: 'Request cancelled. Your saved input is unchanged.',
  MODEL_REQUIRED: 'Select a compatible model in Settings first.',
  MODEL_UNAVAILABLE: 'The selected model is unavailable or incompatible. Refresh models in Settings and choose a replacement.',
  VOICE: 'Choose a supported voice for the selected speech model in Settings.',
  BAD_REQUEST: 'OpenRouter rejected the request configuration. Check the selected model and input.',
  UNAVAILABLE: 'The AI provider is temporarily unavailable. Retry your saved work later.',
  INVALID_RESPONSE: 'The provider response could not be validated. No learning evidence was accepted.',
  TRUNCATED: 'The provider response was incomplete. Keep the draft and retry; it is not a completed answer.',
  INPUT: 'The input is empty, too long, or unsupported. Shorten it or choose a supported audio format.',
  RETRIEVAL: 'This page could not be read directly. Paste an accessible excerpt instead.',
  USAGE: 'Usage could not be recorded. Check local storage before making another request.',
}

/** Deliberately carries no raw response, input, key, cause or upstream message. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly status?: number
  constructor(code: ProviderErrorCode, status?: number) {
    super(messages[code])
    this.name = 'ProviderError'
    this.code = code
    this.status = status
  }
}

export function httpError(status: number): ProviderError {
  const code: ProviderErrorCode = status === 401 || status === 403 ? 'AUTH'
    : status === 402 ? 'CREDITS' : status === 429 ? 'RATE_LIMIT'
      : status === 404 ? 'MODEL_UNAVAILABLE' : status >= 500 ? 'UNAVAILABLE' : 'BAD_REQUEST'
  return new ProviderError(code, status)
}

export function normalizeError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error
  if (error instanceof Error && error.name === 'AbortError') return new ProviderError('CANCELLED')
  return new ProviderError('NETWORK')
}
