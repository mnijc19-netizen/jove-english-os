import { createAuthFence } from '../cloud/client'
import { db } from '../db/db'
import { SpeechError } from './types'

export type SpeechSession = { access_token: string; user: { id: string } }
export interface SpeechAuth {
  getSession: () => Promise<{ data: { session: SpeechSession | null }; error: unknown }>
}
export class SpeechSignInRequired extends SpeechError { constructor() { super('AUTH') } }
export const SPEECH_SESSION_READ_TIMEOUT_MS = 15000

/** The shared synchronous principal fence guards each async session/IDB gap.
 * This module adds journal binding and bounded work, not another auth epoch. */
export function createSpeechSession(auth: SpeechAuth | undefined, external?: AbortSignal, milliseconds = 0) {
  const fence = createAuthFence(), controller = new AbortController()
  let owner: string | undefined
  const changed = () => controller.abort(new SpeechError('AUTH'))
  const abort = () => controller.abort(external?.reason instanceof SpeechError ? external.reason : new SpeechError('CANCELLED'))
  fence.signal.addEventListener('abort', changed, { once: true })
  external?.addEventListener('abort', abort, { once: true })
  if (external?.aborted) abort()
  else if (fence.signal.aborted) changed()
  const timer = milliseconds ? setTimeout(() => controller.abort(new SpeechError('TIMEOUT')), milliseconds) : undefined
  const check = () => {
    if (controller.signal.aborted) throw controller.signal.reason
    if (owner && !fence.isCurrent()) throw new SpeechError('AUTH')
  }
  const assertCurrent = async () => {
    check()
    // Bound each SDK/IDB read sequence, not the lifetime of a mounted fence.
    // A timed-out read must not bind a late principal or modify a later retry.
    let finished = false, readTimer: ReturnType<typeof setTimeout> | undefined
    const checkRead = () => { check(); if (finished) throw new SpeechError('TIMEOUT') }
    let interrupted!: () => void
    const deadline = new Promise<never>((_, reject) => {
      interrupted = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', interrupted, { once: true })
      readTimer = setTimeout(() => { finished = true; reject(new SpeechError('TIMEOUT')) }, SPEECH_SESSION_READ_TIMEOUT_MS)
    })
    const read = async () => {
      if (!auth) throw new SpeechSignInRequired()
      const first = await auth.getSession(); checkRead()
      if (first.error || !first.data.session?.user.id) throw owner ? new SpeechError('AUTH') : new SpeechSignInRequired()
      const session = first.data.session
      if (!fence.bind(session.user.id) || owner && owner !== session.user.id) throw new SpeechError('AUTH')
      owner ??= session.user.id
      const bound = (await db.syncMeta.get('owner'))?.value; checkRead()
      if (bound !== owner) throw new SpeechError('AUTH')
      const last = await auth.getSession(); checkRead()
      if (last.error || last.data.session?.user.id !== owner) throw new SpeechError('AUTH')
      return session
    }
    try { return await Promise.race([read(), deadline]) }
    finally { finished = true; clearTimeout(readTimer); controller.signal.removeEventListener('abort', interrupted) }
  }
  return {
    signal: controller.signal, assertCurrent,
    isCurrent: () => !controller.signal.aborted && fence.isCurrent(),
    dispose() {
      clearTimeout(timer); external?.removeEventListener('abort', abort); fence.signal.removeEventListener('abort', changed)
      fence.dispose(); controller.abort(new SpeechError('CANCELLED'))
    },
  }
}

export async function withSpeechSession<T>(auth: SpeechAuth | undefined, external: AbortSignal | undefined, milliseconds: number,
  work: (signal: AbortSignal, session: SpeechSession) => Promise<T>): Promise<T> {
  const gate = createSpeechSession(auth, external, milliseconds)
  const interrupted = new Promise<never>((_, reject) => gate.signal.addEventListener('abort', () => reject(gate.signal.reason), { once: true }))
  void interrupted.catch(() => undefined)
  const perform = async () => {
    const session = await gate.assertCurrent()
    if (!gate.isCurrent()) throw new SpeechError('AUTH')
    const value = await work(gate.signal, session)
    await gate.assertCurrent()
    if (!gate.isCurrent()) throw new SpeechError('AUTH')
    return value
  }
  try { if (gate.signal.aborted) throw gate.signal.reason; return await Promise.race([perform(), interrupted]) }
  finally { gate.dispose() }
}
