import { describe, expect, it } from 'vitest'
import { japaneseContinuingLessons } from '../src/content/starter-japanese'
import { starterEntryLessons, starterLesson, type StarterLesson } from '../src/content/starter-courses'
import { localStarterFeedback, normalizeStarterAnswer, starterDemonstrationPath, type StarterAttempt } from '../src/domain/starter'

const hasChinese = (value: string) => /[\u4e00-\u9fff]/u.test(value)
const sourceUrls = new Set([
  'https://a1.marugotoweb.jp/en/hiragana.php',
  'https://a1.marugotoweb.jp/en/katakana.php',
  'https://a1.marugotoweb.jp/en/hiragana_drill.php',
  'https://a1.marugotoweb.jp/en/katakana_drill.php',
  'https://a1.marugotoweb.jp/en/introduction.php',
])
function attempt(lesson: StarterLesson, response: string, stage: StarterAttempt['stage'] = 'express', contextId = 'expression'): StarterAttempt {
  return { id: `case:${lesson.id}:${stage}`, sessionId: 'isolated-japanese-editorial-test', lessonId: lesson.id,
    lessonVersion: lesson.version, stage, contextId, response, prompted: false, mode: 'text', timestamp: 1_800_000_000_000 }
}
const feedback = (lesson: StarterLesson, response: string, stage?: StarterAttempt['stage'], contextId?: string) =>
  localStarterFeedback(lesson, attempt(lesson, response, stage, contextId))

describe('original Japanese continuation editorial contracts, not human or provider accuracy', () => {
  it('adds exactly 21 frozen sequential lessons without changing the three entry contracts', () => {
    const contract: readonly StarterLesson[] = japaneseContinuingLessons
    expect(contract).toHaveLength(21)
    expect(contract.map(lesson => lesson.position)).toEqual(Array.from({ length: 21 }, (_, index) => index + 4))
    expect(Object.isFrozen(contract)).toBe(true)
    expect(starterEntryLessons.filter(lesson => lesson.language === 'ja').map(lesson => [lesson.id, lesson.version, lesson.position]))
      .toEqual([['ja-starter-1', 1, 1], ['ja-starter-2', 1, 2], ['ja-starter-3', 1, 3]])
    for (const lesson of contract) {
      expect(lesson.id).toBe(`ja-starter-${lesson.position}`)
      expect(lesson.language).toBe('ja')
      expect(lesson.version).toBe(1)
      expect(lesson.prerequisites).toEqual([`ja-starter-${lesson.position - 1}`])
      expect(starterLesson(lesson.prerequisites[0]!)?.language).toBe('ja')
      expect(starterLesson(lesson.id)).toBe(lesson)
      expect(Object.isFrozen(lesson)).toBe(true)
      expect(Object.isFrozen(lesson.model)).toBe(true)
      expect(Object.isFrozen(lesson.expression.accepted)).toBe(true)
      expect(Object.isFrozen(lesson.foundation?.check.choices)).toBe(true)
    }
    expect(JSON.stringify(contract)).not.toContain('话す')
    expect(starterLesson('ja-starter-23')!.transfer[1]!.explanationZh)
      .toContain('話してください（はなしてください）')
  })

  it.each(japaneseContinuingLessons)('$id teaches a bounded task before its text checks and accepts its natural variants', lesson => {
    expect([...lesson.model.text].length).toBeLessThanOrEqual(40)
    expect(lesson.minutes.quick).toBe(5)
    expect(lesson.minutes.standard).toBe(10)
    for (const text of [lesson.titleZh, lesson.goalZh, lesson.model.meaningZh, lesson.model.explanationZh,
      lesson.recognition.promptZh, lesson.scaffold.explanationZh]) expect(hasChinese(text)).toBe(true)
    expect(lesson.model.reading).toMatch(/[\u3040-\u30ff]/u)
    expect(lesson.model.reading).not.toMatch(/[\u4e00-\u9fff]/u)
    expect(lesson.model.romaji).toBeTruthy()
    expect(lesson.scaffold.pieces.length).toBeGreaterThanOrEqual(2)
    expect(lesson.scaffold.pieces.length).toBeLessThanOrEqual(4)
    expect(lesson.scaffold.pieces.join('')).toBe(lesson.model.text)
    expect(lesson.scaffold.answer).toBe(lesson.model.text)
    expect(lesson.expression.reference).toBe(lesson.model.text)
    expect(feedback(lesson, lesson.recognition.answerId, 'recognize').verdict).toBe('valid')
    for (const wrong of lesson.recognition.choices.filter(choice => choice.id !== lesson.recognition.answerId)) {
      expect(feedback(lesson, wrong.id, 'recognize').verdict).toBe('invalid')
    }
    expect(feedback(lesson, lesson.scaffold.answer, 'assemble').verdict).toBe('valid')
    const normalized = lesson.expression.accepted.map(text => normalizeStarterAnswer(text, 'ja'))
    expect(new Set(normalized).size).toBeGreaterThanOrEqual(3)
    for (const text of [lesson.model.text, ...lesson.expression.accepted]) {
      expect(feedback(lesson, text)).toMatchObject({ verdict: 'valid', correction: null, source: 'course-rule' })
      expect(feedback(lesson, `  ${text}  `).verdict).toBe('valid')
    }
    expect(lesson.expression.errors.length).toBeGreaterThanOrEqual(2)
    for (const error of lesson.expression.errors) {
      expect(error.corrected).toBe(lesson.model.text)
      expect(hasChinese(error.feedbackZh)).toBe(true)
      expect(normalized).not.toContain(normalizeStarterAnswer(error.input, 'ja'))
      expect(feedback(lesson, error.input)).toMatchObject({ verdict: 'invalid', correction: lesson.model.text, nextAction: 'retry' })
    }
    // Never reject an unlisted natural alternative merely because it differs
    // from the canonical string. These labels do not measure provider accuracy.
    expect(feedback(lesson, 'すみませんが、もう少し説明していただけますか。'))
      .toMatchObject({ verdict: 'uncertain', correction: null, nextAction: 'clarify' })
  })

  it.each(japaneseContinuingLessons)('$id supplies three separately explained contexts without swapping communicative roles', lesson => {
    expect(lesson.transfer).toHaveLength(3)
    expect(new Set(lesson.transfer.map(item => item.id)).size).toBe(3)
    expect(new Set(lesson.transfer.map(item => item.promptZh)).size).toBe(3)
    expect(new Set(lesson.transfer.map(item => normalizeStarterAnswer(item.reference, 'ja'))).size).toBeGreaterThanOrEqual(2)
    for (const context of lesson.transfer) {
      expect(context.id.startsWith(`${lesson.id}-`)).toBe(true)
      expect(Object.keys(context).sort()).toEqual(['id', 'promptZh', 'reference', 'accepted', 'meaningZh', 'explanationZh', 'romaji'].sort())
      expect(context.accepted).toContain(context.reference)
      expect(context.romaji).toBeTruthy()
      expect(hasChinese(context.meaningZh)).toBe(true)
      expect(hasChinese(context.explanationZh)).toBe(true)
      expect(Object.isFrozen(context)).toBe(true)
      for (const text of context.accepted) {
        expect(feedback(lesson, text, 'transfer', context.id)).toMatchObject({ verdict: 'valid', correction: null })
      }
      for (const error of lesson.expression.errors) {
        const result = feedback(lesson, error.input, 'transfer', context.id)
        if (result.verdict === 'invalid') {
          expect(context.accepted.map(text => normalizeStarterAnswer(text, 'ja')))
            .toContain(normalizeStarterAnswer(result.correction!, 'ja'))
        } else if (result.verdict === 'valid') {
          // A daytime "error" such as こんばんは becomes appropriate in
          // the evening context. Context takes precedence over the old label.
          expect(context.accepted.map(text => normalizeStarterAnswer(text, 'ja')))
            .toContain(normalizeStarterAnswer(error.input, 'ja'))
        } else expect(result.verdict).toBe('uncertain')
      }
    }
  })

  it('gives every lesson an original script-only foundation and an honest external sound boundary', () => {
    for (const lesson of japaneseContinuingLessons) {
      const foundation = lesson.foundation!
      expect(foundation).toBeDefined()
      expect(hasChinese(foundation.titleZh)).toBe(true)
      expect(hasChinese(foundation.explanationZh)).toBe(true)
      expect(foundation.examples.length).toBeGreaterThanOrEqual(2)
      for (const example of foundation.examples) {
        expect(example.text).toBeTruthy()
        expect(hasChinese(example.meaningZh)).toBe(true)
      }
      expect(sourceUrls.has(foundation.sourceUrl)).toBe(true)
      expect(foundation.sourceInstructionZh).toBeTruthy()
      expect(foundation.sourceInstructionZh).not.toMatch(/\d{1,2}:\d{2}/u)
      expect(new Set(foundation.check.choices.map(choice => choice.id)).size).toBe(foundation.check.choices.length)
      expect(foundation.check.choices.some(choice => choice.id === foundation.check.answerId)).toBe(true)
      expect(foundation.check.explanationZh).toContain('不检查听音、口音或音高')
      expect(foundation.check.promptZh).not.toMatch(/听到|听出|听录音|评发音|声学分/u)
      expect(lesson.sound.sourceUrl).toBe(foundation.sourceUrl)
      expect(lesson.sound.status).toBe('pending-review')
      expect(lesson.sound.audioPath).toBeUndefined()
      expect(starterDemonstrationPath(lesson, lesson.model.text)).toBeUndefined()
      expect(lesson.sound.sourceLabel).toContain('非本句录音')
      expect(lesson.sound.notesZh).toMatch(/文字／选句/u)
      expect(lesson.sound.notesZh).toContain('不作声学评分')
    }
  })

  it('covers Japanese script, mora, word reading and register rather than a translated English sequence', () => {
    const foundations = japaneseContinuingLessons.map(lesson => lesson.foundation!)
    const text = foundations.map(item => `${item.titleZh} ${item.explanationZh} ${item.examples.map(example => example.text).join(' ')}`).join('\n')
    for (const group of ['あ・い・う・え・お', 'か・き・く・け・こ', 'さ・し・す・せ・そ', 'た・ち・つ・て・と',
      'な・に・ぬ・ね・の', 'は・ひ・ふ・へ・ほ', 'ま・み・む・め・も', 'や・ゆ・よ', 'ら・り・る・れ・ろ', 'わ・を・ん']) expect(text).toContain(group)
    for (const topic of ['片假名', '浊点', '半浊点', '长元音', '小 っ', '一拍', '鼻音', 'きゃ', '音高', '汉字', '助词']) expect(text).toContain(topic)
    const teaching = japaneseContinuingLessons.map(lesson => `${lesson.goalZh} ${lesson.model.text} ${lesson.model.explanationZh}`).join('\n')
    for (const topic of ['いくら', '二つ', '何時', 'さん', '私の', '好き', 'を', 'に', 'で', 'ます', 'ません', 'ました',
      'てください', 'ましょうか', 'すみません', 'わかりません', '助けて']) expect(teaching).toContain(topic)
    expect(teaching).toContain('不能因为与示范的 に 不同就判错')
    expect(teaching).toContain('さん 不区分先生或女士')
    expect(teaching).toContain('手伝ってください 则是请对方帮你')
  })
})
