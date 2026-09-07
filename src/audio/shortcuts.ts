interface RecorderShortcut {
  element: () => HTMLElement | undefined
  enabled: () => boolean
  recording: () => boolean
  toggle: () => void
}
const recorders = new Set<RecorderShortcut>()

function keydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.key.toLowerCase() !== 'r') return
  const target = event.target instanceof Element ? event.target : document.activeElement
  if (target?.closest('input, textarea, select, button, a, [contenteditable], [role="textbox"], [role="combobox"], [role="slider"]')) return
  const available = [...recorders].filter(item => item.enabled() && item.element()?.getClientRects().length)
  const selected = available.find(item => item.recording())
    ?? available.find(item => target && item.element()?.contains(target)) ?? available[0]
  if (!selected) return
  event.preventDefault()
  selected.toggle()
}

export function registerRecorderShortcut(shortcut: RecorderShortcut): () => void {
  if (!recorders.size) window.addEventListener('keydown', keydown)
  recorders.add(shortcut)
  return () => {
    recorders.delete(shortcut)
    if (!recorders.size) window.removeEventListener('keydown', keydown)
  }
}
