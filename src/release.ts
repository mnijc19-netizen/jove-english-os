import { z } from 'zod'
import type { InjectionKey, Ref } from 'vue'
import { abortable, readJson, withDeadline } from './ai/transport'

export const releaseSchema = z.strictObject({ schema: z.literal(1), buildId: z.string().regex(/^(?:[a-f0-9]{7}|local)-[a-f0-9]{12}$/u),
  revision: z.string().regex(/^[a-f0-9]{40}$/u).nullable(), dirty: z.boolean(), builtAt: z.string().datetime() })
export type ReleaseInfo = z.infer<typeof releaseSchema>
declare const __JOVE_RELEASE__: ReleaseInfo
export const currentRelease: ReleaseInfo | null = typeof __JOVE_RELEASE__ === 'undefined' ? null : __JOVE_RELEASE__
export const updateControls: InjectionKey<{ available: Ref<boolean>; applying: Ref<boolean>; apply: () => Promise<void> }> = Symbol('jove-update-controls')

/** Network only: release.json is deliberately absent from the offline precache. */
export async function checkPublishedRelease(base: string, signal?: AbortSignal, checkWorker?: (signal: AbortSignal) => Promise<void>): Promise<ReleaseInfo> {
  return withDeadline(signal, 8000, async scoped => {
    const response = await abortable(fetch(`${base}release.json?check=${Date.now()}`, {
      cache: 'no-store', credentials: 'omit', redirect: 'error', signal: scoped,
    }), scoped)
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      void response.body?.cancel().catch(() => undefined)
      throw new Error('Release information unavailable')
    }
    const release = releaseSchema.parse(await readJson(response, scoped, 4096))
    if (checkWorker) await abortable(checkWorker(scoped), scoped)
    return release
  })
}
