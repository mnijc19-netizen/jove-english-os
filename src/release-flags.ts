// One build-time gate for routes, navigation, account coordination and data
// controls. No URL/local-storage override and no data deletion when disabled.
export const japaneseDevelopment = import.meta.env.DEV
export const japaneseEnabled = japaneseDevelopment || import.meta.env.VITE_JOVE_JAPANESE === '1'
