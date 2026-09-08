import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { AudioAsset } from '../domain/types'

const fingerprints = new WeakMap<Blob, Promise<string>>()
function fingerprint(blob: Blob): Promise<string> {
  const cached = fingerprints.get(blob)
  if (cached) return cached
  const pending = (async () => {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  })()
  fingerprints.set(blob, pending)
  void pending.catch(() => { if (fingerprints.get(blob) === pending) fingerprints.delete(blob) })
  return pending
}

/** IndexedDB returns new Blob objects on refresh. Equal bytes must not restart playback. */
export function useRecordingUrl(source: Readonly<Ref<AudioAsset | undefined>>): Ref<string> {
  const url = ref('')
  let current: { id: string; blob: Blob; mimeType: string } | undefined
  let revision = 0
  function replace(asset?: AudioAsset) {
    const next = asset ? URL.createObjectURL(asset.blob) : ''
    const previous = url.value
    current = asset ? { id: asset.id, blob: asset.blob, mimeType: asset.mimeType } : undefined
    url.value = next
    if (previous) URL.revokeObjectURL(previous)
  }
  const stop = watch(source, (asset) => {
    const token = ++revision
    const previous = current
    if (!asset || !previous || asset.id !== previous.id || asset.mimeType !== previous.mimeType
      || asset.blob.type !== previous.blob.type || asset.blob.size !== previous.blob.size) {
      replace(asset)
      return
    }
    if (asset.blob === previous.blob) return
    // Keep the playable original while checking a rehydrated Blob. ID/size alone
    // are not sufficient: replacement bytes under the same ID must be noticed.
    void Promise.all([fingerprint(previous.blob), fingerprint(asset.blob)]).then(([before, after]) => {
      if (token !== revision) return
      if (before === after) current = { id: asset.id, blob: asset.blob, mimeType: asset.mimeType }
      else replace(asset)
    }, () => {
      // No equality claim when byte verification is unavailable.
      if (token === revision) replace(asset)
    })
  }, { immediate: true })
  onBeforeUnmount(() => { ++revision; stop(); replace() })
  return url
}
