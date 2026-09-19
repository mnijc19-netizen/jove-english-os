/** Workspace identity is infrastructure, not evidence inferred from text. */
export type LearningLanguage = 'en' | 'ja'
export const languageDatabases: Record<LearningLanguage, string> = {
  en: 'jove-english-os', ja: 'jove-english-os-ja',
}
export function assertLearningLanguage(value: unknown): asserts value is LearningLanguage {
  if (value !== 'en' && value !== 'ja') throw new Error('Unsupported learning language')
}
