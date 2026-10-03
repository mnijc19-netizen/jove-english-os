import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import manifest from '../public/audio/starter/manifest.json'
import { starterDemonstrationPath, starterDemonstrationTexts } from '../src/domain/starter'
import {
  starterContentPolicy,
  starterFeedbackFixtures,
  starterLesson,
  starterLessons,
  type StarterLesson,
} from '../src/content/starter-courses'

const languageIds = (language: 'en' | 'ja') => [1, 2, 3].map(position => `${language}-starter-${position}`)
const hasChinese = (value: string) => /\p{Script=Han}/u.test(value)

describe('original Chinese-native absolute-beginner starter content', () => {
  it('exports the exact six stable version-one lesson contracts and safe ID lookup', () => {
    const contract: readonly StarterLesson[] = starterLessons
    expect(contract).toHaveLength(6)
    expect(contract.map(lesson => lesson.id)).toEqual([...languageIds('en'), ...languageIds('ja')])
    expect(new Set(contract.map(lesson => lesson.id)).size).toBe(6)
    for (const lesson of contract) {
      expect(lesson.version).toBe(1)
      expect(starterLesson(lesson.id)).toBe(lesson)
      expect(Object.keys(lesson).sort()).toEqual([
        'id', 'language', 'version', 'position', 'titleZh', 'goalZh', 'prerequisites',
        'minutes', 'model', 'recognition', 'scaffold', 'expression', 'transfer', 'sound',
      ].sort())
      expect(lesson.minutes.quick).toBeGreaterThanOrEqual(3)
      expect(lesson.minutes.quick).toBeLessThanOrEqual(lesson.minutes.standard)
      expect(lesson.minutes.standard).toBeLessThanOrEqual(15)
      for (const value of [lesson.titleZh, lesson.goalZh, lesson.model.meaningZh, lesson.model.explanationZh]) {
        expect(value.length).toBeGreaterThan(0)
        expect(hasChinese(value)).toBe(true)
      }
    }
    expect(starterLesson('unknown')).toBeUndefined()
    expect(starterLesson('EN-starter-1')).toBeUndefined()
    expect(starterLesson('en-starter-4')).toBeUndefined()
    expect(starterLesson('ja-starter-4')).toBeUndefined()
  })

  it('keeps prerequisites taught earlier in the same language, with no script entry gate', () => {
    for (const language of ['en', 'ja'] as const) {
      const lessons = starterLessons.filter(lesson => lesson.language === language)
      expect(lessons.map(lesson => lesson.position)).toEqual([1, 2, 3])
      expect(lessons[0]!.prerequisites).toEqual([])
      expect(lessons[1]!.prerequisites).toEqual([lessons[0]!.id])
      expect(lessons[2]!.prerequisites).toEqual([lessons[1]!.id])
      for (const lesson of lessons) for (const prerequisiteId of lesson.prerequisites) {
        const prerequisite = starterLesson(prerequisiteId)
        expect(prerequisite).toBeDefined()
        expect(prerequisite!.language).toBe(language)
        expect(prerequisite!.position).toBeLessThan(lesson.position)
      }
    }
  })

  it.each(starterLessons.map(lesson => [lesson.id, lesson] as const))('%s teaches its small target before recognition and supported expression', (_id, lesson) => {
    expect(lesson.model.text.length).toBeLessThanOrEqual(40)
    expect(lesson.scaffold.answer).toBe(lesson.model.text)
    expect(lesson.expression.reference).toBe(lesson.model.text)
    expect(lesson.scaffold.pieces.join('').replace(/ /g, '')).toBe(lesson.model.text.replace(/ /g, ''))
    expect(lesson.scaffold.pieces.length).toBeGreaterThanOrEqual(2)
    expect(lesson.scaffold.pieces.length).toBeLessThanOrEqual(4)
    expect(lesson.recognition.choices.length).toBeGreaterThanOrEqual(2)
    expect(lesson.recognition.choices.length).toBeLessThanOrEqual(3)
    expect(new Set(lesson.recognition.choices.map(choice => choice.id)).size).toBe(lesson.recognition.choices.length)
    expect(lesson.recognition.choices.filter(choice => choice.id === lesson.recognition.answerId)).toHaveLength(1)
    for (const value of [
      lesson.recognition.promptZh, ...lesson.recognition.choices.map(choice => choice.textZh), lesson.recognition.explanationZh,
      lesson.scaffold.promptZh, lesson.scaffold.explanationZh, lesson.expression.promptZh,
    ]) expect(hasChinese(value)).toBe(true)
    expect(lesson.expression.accepted).toContain(lesson.expression.reference)
    expect(new Set(lesson.expression.accepted).size).toBe(lesson.expression.accepted.length)
    expect(lesson.expression.errors.length).toBeGreaterThanOrEqual(2)
    for (const error of lesson.expression.errors) {
      expect(error.input).not.toBe(error.corrected)
      expect(error.corrected).toBe(lesson.model.text)
      expect(hasChinese(error.feedbackZh)).toBe(true)
    }
  })

  it('provides three distinct contexts per lesson rather than one mandatory repeated script', () => {
    const ids: string[] = []
    for (const lesson of starterLessons) {
      expect(lesson.transfer.length).toBeGreaterThanOrEqual(3)
      expect(new Set(lesson.transfer.map(variant => variant.promptZh)).size).toBe(lesson.transfer.length)
      for (const variant of lesson.transfer) {
        ids.push(variant.id)
        expect(variant.id.startsWith(`${lesson.id}-`)).toBe(true)
        expect(hasChinese(variant.promptZh)).toBe(true)
        expect(hasChinese(variant.meaningZh)).toBe(true)
        expect(hasChinese(variant.explanationZh)).toBe(true)
        expect(Object.keys(variant).sort()).toEqual([
          'id', 'promptZh', 'reference', 'accepted', 'meaningZh', 'explanationZh',
          ...(lesson.language === 'ja' ? ['romaji'] : []),
        ].sort())
        if (lesson.language === 'ja') {
          expect(variant.romaji).toBeDefined()
          expect(variant.romaji).toMatch(/\p{Script=Latin}/u)
          expect(variant.romaji).not.toMatch(/[ぁ-んァ-ヶ]/u)
        } else expect(variant.romaji).toBeUndefined()
        expect(variant.accepted).toContain(variant.reference)
        expect(new Set(variant.accepted).size).toBe(variant.accepted.length)
      }
    }
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives each English reference an accurate context-specific Chinese meaning', () => {
    const meanings: Record<string, string> = {
      'en-starter-1-group': '你好，我是 Jove。',
      'en-starter-1-online': '你好，我是 Jove。',
      'en-starter-1-partner': '我是 Jove。',
      'en-starter-2-station': '你是 Jove 吗？',
      'en-starter-2-team': '你是 Jove 吗？',
      'en-starter-2-call': '你好，你是 Jove 吗？',
      'en-starter-3-meal': '水，麻烦你。',
      'en-starter-3-work': '我需要水，麻烦你。',
      'en-starter-3-home': '我需要一点水，麻烦你。',
    }
    const contexts = starterLessons.filter(lesson => lesson.language === 'en').flatMap(lesson => lesson.transfer)
    expect(contexts).toHaveLength(Object.keys(meanings).length)
    for (const context of contexts) expect(context.meaningZh).toBe(meanings[context.id])
    const partner = starterLesson('en-starter-1')!.transfer.find(context => context.id.endsWith('-partner'))!
    expect(partner.meaningZh).not.toBe(starterLesson('en-starter-1')!.model.meaningZh)
    expect(partner.explanationZh).toContain('已经问好')
    const meal = starterLesson('en-starter-3')!.transfer.find(context => context.id.endsWith('-meal'))!
    expect(meal.explanationZh).toContain('不必补成完整句')
  })

  it('keeps Japanese temporary romanization and register aligned with the actual context reference', () => {
    const expected: Record<string, [string, string]> = {
      'ja-starter-1-desk': ['早上好。（礼貌）', 'ohayō gozaimasu'],
      'ja-starter-1-colleague': ['早上好。（礼貌）', 'ohayō gozaimasu'],
      'ja-starter-1-friend': ['早上好。（熟人之间的轻松说法）', 'ohayō'],
      'ja-starter-2-group': ['我是乔布。（礼貌的姓名介绍）', 'Jōbu desu'],
      'ja-starter-2-desk': ['我是乔布。（礼貌的姓名介绍）', 'Jōbu desu'],
      'ja-starter-2-call': ['我是乔布。（礼貌的姓名介绍）', 'Jōbu desu'],
      'ja-starter-3-shop': ['谢谢你。（礼貌）', 'arigatō gozaimasu'],
      'ja-starter-3-friend': ['谢谢。（熟人之间的轻松说法）', 'arigatō'],
      'ja-starter-3-reply': ['不用谢。', 'dō itashimashite'],
    }
    const contexts = starterLessons.filter(lesson => lesson.language === 'ja').flatMap(lesson => lesson.transfer)
    expect(contexts).toHaveLength(Object.keys(expected).length)
    for (const context of contexts) expect([context.meaningZh, context.romaji]).toEqual(expected[context.id])
    for (const id of ['ja-starter-1-friend', 'ja-starter-3-friend']) {
      const context = contexts.find(context => context.id === id)!
      expect(context.romaji).not.toContain('gozaimasu')
      expect(context.explanationZh).toContain('熟朋友')
    }
  })

  it('explains JA3 reply as answering another person’s thanks, never as the thank-you model', () => {
    const lesson = starterLesson('ja-starter-3')!
    const reply = lesson.transfer.find(context => context.id === 'ja-starter-3-reply')!
    expect(reply.reference).toBe('どういたしまして。')
    expect(reply.meaningZh).toBe('不用谢。')
    expect(reply.meaningZh).not.toBe(lesson.model.meaningZh)
    expect(reply.explanationZh).toContain('回答别人的道谢')
    expect(reply.explanationZh).toContain('不是向对方说谢谢')
    expect(reply.explanationZh).toContain('いえいえ')
    expect(reply.romaji).toBe('dō itashimashite')
    expect(reply.romaji).not.toBe(lesson.model.romaji)
  })

  it('accepts common English contractions and meaning-preserving alternatives', () => {
    expect(starterLesson('en-starter-1')!.expression.accepted).toEqual(expect.arrayContaining([
      "Hi, I'm Jove.", 'Hi, I am Jove.', 'Hi, my name is Jove.',
    ]))
    expect(starterLesson('en-starter-2')!.expression.accepted).toEqual(expect.arrayContaining([
      'Are you Jove?', "You're Jove, right?", 'Is your name Jove?',
    ]))
    expect(starterLesson('en-starter-3')!.expression.accepted).toEqual(expect.arrayContaining([
      "I'd like some water, please.", 'I would like some water, please.', 'Water, please.', 'A water, please.',
    ]))
  })

  it('teaches Japanese omissions, register and temporary romanization without requiring an input method', () => {
    for (const lesson of starterLessons.filter(value => value.language === 'ja')) {
      expect(lesson.model.reading).toBeDefined()
      expect(lesson.model.romaji).toBeDefined()
      expect(lesson.model.explanationZh).toMatch(/罗马字/)
      expect(lesson.scaffold.promptZh).toMatch(/点/)
      expect(lesson.model.explanationZh).toMatch(/不要求|不用/)
      expect(lesson.sound.notesZh).toMatch(/临时提示/)
    }
    const introduce = starterLesson('ja-starter-2')!
    expect(introduce.expression.accepted).toEqual(expect.arrayContaining(['ジョーブです。', '私はジョーブです。', 'わたしはジョーブです。']))
    expect(introduce.model.explanationZh).toMatch(/不必每次/)
    const morning = starterLesson('ja-starter-1')!
    expect(morning.model.explanationZh).toMatch(/熟朋友/)
    expect(morning.transfer.find(variant => variant.id.endsWith('-friend'))!.accepted).toContain('おはよう。')
    const thanks = starterLesson('ja-starter-3')!
    expect(thanks.model.explanationZh).toMatch(/どういたしまして/)
    expect(thanks.transfer.find(variant => variant.id.endsWith('-reply'))!.accepted).toContain('いえいえ。')
  })

  it('references only original supplemental synthetic assets, never copied or falsely approved audio', () => {
    for (const lesson of starterLessons) {
      expect(lesson.sound.status).toBe('pending-review')
      expect(lesson.sound.sourceLabel).toMatch(/原创合成语音：Windows System\.Speech/)
      expect(lesson.sound.sourceLabel).toContain(lesson.language === 'en' ? 'Microsoft Zira Desktop (en-US)' : 'Microsoft Haruka Desktop (ja-JP)')
      expect(lesson.sound.audioPath).toBe(`audio/starter/${lesson.id}.wav`)
      expect(lesson.sound.audioPath).not.toMatch(/^https?:|\.\.|[?#]/)
      expect(lesson.sound.sourceUrl).toBeUndefined()
      expect(lesson.sound.notesZh).toMatch(/不是真人|不是来自真人/)
      expect(lesson.sound.notesZh).toMatch(/试听核对/)
      expect(lesson.sound.notesZh).toMatch(/不能因文件存在/)
    }
    expect(starterContentPolicy.authorship).toBe('original')
    expect(starterContentPolicy.languageReview).toBe('pending-independent-review')
    expect(starterContentPolicy.providerAccuracy).toBe('not-measured')
  })

  it('matches fourteen ordered synthetic demonstration assets and their file/text hashes without claiming listening quality', () => {
    const expected = starterLessons.flatMap(lesson => {
      const texts = starterDemonstrationTexts(lesson)
      expect(texts).toEqual([...new Set([lesson.model.text, lesson.scaffold.answer, lesson.expression.reference, ...lesson.transfer.map(context => context.reference)])])
      return texts.map((text, index) => {
        const path = `audio/starter/${lesson.id}${index ? `-${index}` : ''}.wav`
        expect(starterDemonstrationPath(lesson, text)).toBe(path)
        if (index === 0) expect(lesson.sound.audioPath).toBe(path)
        return { lessonId: lesson.id, lessonVersion: lesson.version, language: lesson.language, text, path,
          voice: lesson.language === 'en' ? 'Microsoft Zira Desktop' : 'Microsoft Haruka Desktop' }
      })
    })
    expect(expected).toHaveLength(14)
    expect(manifest.assets).toHaveLength(14)
    expect(manifest.assets.map(({ lessonId, lessonVersion, language, text, path, voice }) => ({ lessonId, lessonVersion, language, text, path, voice }))).toEqual(expected)
    expect(new Set(manifest.assets.map(asset => asset.path)).size).toBe(14)
    expect(manifest).toMatchObject({ version: 1, generator: 'Windows System.Speech',
      rights: 'Original course examples; no copied publisher media',
      qualityClaim: 'Supplemental localized synthetic demonstration, not human speech or calibrated acoustic assessment' })
    const audioRoot = new URL('../public/audio/starter/', import.meta.url)
    expect(readdirSync(audioRoot).filter(name => name.endsWith('.wav')).sort()).toEqual(expected.map(asset => asset.path.replace('audio/starter/', '')).sort())
    for (const asset of manifest.assets) {
      expect(asset.path).toMatch(/^audio\/starter\/(en|ja)-starter-[1-3](?:-[1-2])?\.wav$/)
      expect(asset).toMatchObject({ synthetic: true, rate: 0, sampleRate: 22050, channels: 1, bitsPerSample: 16 })
      expect(starterLesson(asset.lessonId)!.sound.status).toBe('pending-review')
      const bytes = readFileSync(new URL(asset.path.replace('audio/starter/', ''), audioRoot))
      expect(bytes.byteLength).toBe(asset.byteLength)
      expect(bytes.byteLength).toBeGreaterThan(44)
      expect(bytes.toString('ascii', 0, 4)).toBe('RIFF')
      expect(bytes.toString('ascii', 8, 12)).toBe('WAVE')
      expect(bytes.readUInt32LE(4) + 8).toBe(bytes.byteLength)
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256)
      expect(asset.textSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(createHash('sha256').update(asset.text, 'utf8').digest('hex')).toBe(asset.textSha256)
    }
    // Hash/header integrity is not decoding, audible-text verification or a quality score.
  })

  it('provides exactly 100 deterministic, context-unique editorial evaluation fixtures, 50 per language', () => {
    expect(starterFeedbackFixtures).toHaveLength(100)
    expect(new Set(starterFeedbackFixtures.map(fixture => fixture.id)).size).toBe(100)
    expect(new Set(starterFeedbackFixtures.map(fixture => JSON.stringify([fixture.language, fixture.lessonId, fixture.promptZh, fixture.input]))).size).toBe(100)
    for (const language of ['en', 'ja'] as const) {
      const fixtures = starterFeedbackFixtures.filter(fixture => fixture.language === language)
      expect(fixtures).toHaveLength(50)
      expect(new Set(fixtures.map(fixture => fixture.lessonId)).size).toBe(3)
      for (const verdict of ['accept', 'repair', 'clarify']) expect(fixtures.some(fixture => fixture.expected === verdict)).toBe(true)
    }
    for (const fixture of starterFeedbackFixtures) {
      expect(starterLesson(fixture.lessonId)!.language).toBe(fixture.language)
      expect(hasChinese(fixture.promptZh)).toBe(true)
      expect(hasChinese(fixture.feedbackZh)).toBe(true)
      expect(fixture.input.trim().length).toBeGreaterThan(0)
      expect(fixture.id.startsWith(`${fixture.lessonId}-feedback-`)).toBe(true)
      if (fixture.expected === 'repair') {
        expect(fixture.corrected).toBeDefined()
        expect(fixture.corrected).not.toBe(fixture.input)
      } else expect(fixture.corrected).toBeUndefined()
    }
    // This checks the corpus, not an AI evaluator: no success-rate assertion here.
  })

  it('does not accept a negated keyword, a swapped person, or another task merely for containing the target', () => {
    for (const input of ["I don't need water.", 'Hi, you are Jove.', 'ジョーブではありません。', 'あなたはジョーブです。']) {
      expect(starterFeedbackFixtures.find(fixture => fixture.input === input)!.expected).toBe('clarify')
    }
    expect(starterFeedbackFixtures.find(fixture => fixture.input === "What's your name?")!.feedbackZh).toContain('语法没有错')
  })

  it('changes thank-you/reply judgments with context instead of treating Japanese phrases as universal keys', () => {
    for (const input of ['どういたしまして。', 'いえいえ。']) {
      const cases = starterFeedbackFixtures.filter(fixture => fixture.lessonId === 'ja-starter-3' && fixture.input === input)
      expect(cases).toHaveLength(2)
      expect(new Set(cases.map(fixture => fixture.promptZh)).size).toBe(2)
      expect(cases.map(fixture => fixture.expected).sort()).toEqual(['accept', 'clarify'])
    }
    expect(starterFeedbackFixtures.find(fixture => fixture.input === 'A water, please.')!.expected).toBe('accept')
  })

  it('keeps lesson packages and fixture expectations immutable at runtime', () => {
    expect(Object.isFrozen(starterLessons)).toBe(true)
    expect(Object.isFrozen(starterFeedbackFixtures)).toBe(true)
    for (const lesson of starterLessons) {
      expect(Object.isFrozen(lesson)).toBe(true)
      expect(Object.isFrozen(lesson.model)).toBe(true)
      expect(Object.isFrozen(lesson.expression.accepted)).toBe(true)
      expect(Object.isFrozen(lesson.transfer)).toBe(true)
      for (const context of lesson.transfer) expect(Object.isFrozen(context)).toBe(true)
      expect(Object.isFrozen(lesson.sound)).toBe(true)
    }
    for (const fixture of starterFeedbackFixtures) expect(Object.isFrozen(fixture)).toBe(true)
  })
})
