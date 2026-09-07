import { shallowReactive } from 'vue'
import type { AudioAsset } from '../domain/types'

export interface RecordingDraft { scope: string; asset: AudioAsset; saved: boolean }

/** Retained across component/route teardown; cleared only after successful save and attachment. */
export const recordingDrafts = shallowReactive(new Map<string, RecordingDraft>())
const writes = new WeakMap<RecordingDraft, Promise<void>>()
let protectedWindow: Window | undefined
function protectUnsaved(event: BeforeUnloadEvent): void {
  if ([...recordingDrafts.values()].some(draft => !draft.saved)) { event.preventDefault(); event.returnValue = '' }
}
function updateUnloadProtection(): void {
  protectedWindow?.removeEventListener('beforeunload', protectUnsaved)
  protectedWindow = undefined
  if (typeof window !== 'undefined' && [...recordingDrafts.values()].some(draft => !draft.saved)) {
    protectedWindow = window
    window.addEventListener('beforeunload', protectUnsaved)
  }
}

export function retainRecording(scope: string, capture: { blob: Blob; duration: number }, label: string): RecordingDraft {
  const asset: AudioAsset = { id: crypto.randomUUID(), blob: capture.blob, mimeType: capture.blob.type,
    duration: capture.duration, createdAt: Date.now(), kind: 'recording', processed: false, label }
  const draft = shallowReactive({ scope, asset, saved: false })
  recordingDrafts.set(asset.id, draft)
  updateUnloadProtection()
  return draft
}

export function saveRecording(draft: RecordingDraft, write: (asset: AudioAsset) => Promise<unknown>): Promise<void> {
  if (draft.saved) return Promise.resolve()
  const existing = writes.get(draft)
  if (existing) return existing
  const pending = Promise.resolve().then(() => write(draft.asset)).then(() => { draft.saved = true; updateUnloadProtection() }).finally(() => { writes.delete(draft) })
  writes.set(draft, pending)
  return pending
}

export function attachRecording(draft: RecordingDraft): void {
  if (draft.saved) recordingDrafts.delete(draft.asset.id)
  updateUnloadProtection()
}
