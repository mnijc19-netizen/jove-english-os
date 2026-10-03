import { describe, expect, it } from 'vitest'
import { englishContinuingLessons } from '../src/content/starter-english'
import { starterEntryLessons, starterLesson, type StarterLesson } from '../src/content/starter-courses'
import { localStarterFeedback, normalizeStarterAnswer, starterDemonstrationPath, type StarterAttempt } from '../src/domain/starter'

const officialSources = [
  'https://learningenglish.voanews.com/a/lets-learn-english-lesson-one/3111026.html',
  'https://learningenglish.voanews.com/a/lets-learn-english-lesson-3-i-am-here/3126527.html',
  'https://learningenglish.voanews.com/a/lets-learn-english-lesson-10/3285228.html',
]
const hasChinese = (text: string) => /\p{Script=Han}/u.test(text)
function attempt(lesson: StarterLesson, response: string, patch: Partial<StarterAttempt> = {}): StarterAttempt {
  return { id: `synthetic:${lesson.id}:answer`, sessionId: `synthetic:${lesson.id}:session`, lessonId: lesson.id,
    lessonVersion: lesson.version, stage: 'express', contextId: `${lesson.id}:introduced`, response,
    prompted: false, mode: 'text', timestamp: Date.UTC(2026, 9, 4, 12), ...patch }
}

// Independently specified meaning pairs protect amount, direction, ownership,
// communicative role, tense and negation, rather than echoing generated fields.
const expectedTransfers: readonly (readonly (readonly [string, string])[])[] = [
  [["It's three dollars.", '它是三美元。'], ["It's five dollars.", '它是五美元。'], ['Two dollars.', '两美元。']],
  [["It's nine thirty.", '现在是九点半。'], ["It's eight o'clock.", '是八点整。'], ["Let's meet at nine thirty.", '我们九点半见。']],
  [['This is my bag.', '这是我的包。'], ["That's my jacket.", '那是我的外套。'], ["It's my bag.", '它是我的包。']],
  [['This is my friend.', '这是我的朋友。'], ['This is my colleague.', '这是我的同事。'], ['This is my neighbor.', '这是我的邻居。']],
  [['This key is mine.', '这把钥匙是我的。'], ['That bag is mine.', '那个包是我的。'], ['Is this key yours?', '这把钥匙是你的吗？']],
  [['The station is near the park.', '车站在公园附近。'], ['The bank is next to the cafe.', '银行紧挨着咖啡馆。'], ['The pharmacy is across the street.', '药店在街对面。']],
  [['Turn left at the bank.', '在银行那里左转。'], ['Turn right at the cafe.', '在咖啡馆那里右转。'], ['Go straight to the station.', '直走到车站。']],
  [['Can I have a spoon, please?', '可以给我一把勺子吗？'], ['Can I have a bag, please?', '可以给我一个袋子吗？'], ['Could I have a fork, please?', '可以给我一把叉子吗？']],
  [['Could you say that again?', '可以再说一遍吗？'], ['Could you speak more slowly?', '可以说得慢一点吗？'], ['Do you mean tomorrow?', '你是指明天吗？']],
  [['I take the bus every morning.', '我每天早上坐公交车。'], ['I walk to work.', '我走路上班。'], ['I start work at nine.', '我九点开始工作。']],
  [['I like tea without sugar.', '我喜欢不加糖的茶。'], ['I prefer coffee.', '我更喜欢咖啡。'], ["I don't like spicy food.", '我不喜欢辣的食物。']],
  [["I'm meeting a friend tomorrow.", '我明天要见一个朋友。'], ["I'm going to study tonight.", '我今晚打算学习。'], ['I can meet you at six.', '我可以六点见你。']],
  [['I went to the store yesterday.', '我昨天去了商店。'], ['I was at home yesterday.', '我昨天在家。'], ['I missed the bus this morning.', '我今天早上没赶上公交车。']],
  [['I think we need more time.', '我觉得我们需要更多时间。'], ['I think this room is too small.', '我觉得这个房间太小。'], ['I think this route is easier.', '我觉得这条路线更容易。']],
  [["I'm late because the bus was slow.", '我迟到了，因为公交车很慢。'], ["I can't come because I'm ill.", '我不能来，因为我生病了。'], ['I need help because this is new.', '我需要帮助，因为这件事是新的。']],
  [["Hi, I'm on my way.", '你好，我正在路上。'], ["Sorry, I'll be ten minutes late.", '抱歉，我会晚十分钟。'], ['Thanks. See you at six.', '谢谢，六点见。']],
  [["The hot water isn't working.", '热水设施不能正常使用。'], ["The heater isn't working.", '暖气不能正常使用。'], ["There's a leak under the sink.", '水槽下面有漏水。']],
  [['Could you check this file, please?', '可以帮忙检查这份文件吗？'], ["I'll send the file by five.", '我会在五点之前发送文件。'], ['When is this due?', '这个什么时候截止？']],
  [['I have a headache.', '我头疼。'], ['My stomach hurts.', '我胃部或腹部疼。'], ["I'm allergic to peanuts.", '我对花生过敏。']],
  [['Please call an ambulance.', '请叫救护车。'], ['Call the fire department, please.', '请联系消防部门。'], ["I'm at the station.", '我在车站。']],
  [['Hi, can we meet at six?', '你好，我们可以六点见面吗？'], ['Sorry, can we meet tomorrow?', '抱歉，我们可以明天见面吗？'], ["I'm at the station. Where are you?", '我在车站。你在哪里？']],
]

describe('original English continuation contract', () => {
  it('adds exactly positions 4–24 after the preserved English entry lessons', () => {
    expect(englishContinuingLessons).toHaveLength(21)
    expect(englishContinuingLessons.map(lesson => lesson.id)).toEqual(Array.from({ length: 21 }, (_, index) => `en-starter-${index + 4}`))
    const originals = starterEntryLessons.filter(lesson => lesson.language === 'en')
    expect(originals.map(lesson => lesson.id)).toEqual(['en-starter-1', 'en-starter-2', 'en-starter-3'])
    for (const original of originals) expect(starterLesson(original.id)).toBe(original)
    for (const [index, lesson] of englishContinuingLessons.entries()) {
      expect(lesson).toMatchObject({ position: index + 4, language: 'en', version: 1, prerequisites: [`en-starter-${index + 3}`] })
      expect(starterLesson(lesson.id)).toBe(lesson)
      const previous = starterLesson(lesson.prerequisites[0]!)!
      expect(previous.language).toBe('en')
      expect(previous.position).toBe(lesson.position - 1)
    }
  })

  it('freezes the standalone export and its nested teaching data without a runtime circular import', () => {
    function expectFrozen(value: unknown) {
      if (value && typeof value === 'object') {
        expect(Object.isFrozen(value)).toBe(true)
        for (const child of Object.values(value)) expectFrozen(child)
      }
    }
    expectFrozen(englishContinuingLessons)
  })

  describe.each(englishContinuingLessons.map(lesson => [lesson.id, lesson] as const))('%s', (_id, lesson) => {
    it('teaches one short bounded model with matching scaffold/reference and Chinese support', () => {
      expect(lesson.model.text.length).toBeLessThanOrEqual(40)
      expect(lesson.scaffold.pieces.length).toBeGreaterThanOrEqual(2)
      expect(lesson.scaffold.pieces.length).toBeLessThanOrEqual(4)
      expect(lesson.scaffold.pieces.join(' ').trim().replace(/\s+/gu, ' ')).toBe(lesson.model.text)
      expect(lesson.scaffold.answer).toBe(lesson.model.text)
      expect(lesson.expression.reference).toBe(lesson.model.text)
      expect(lesson.minutes).toEqual({ quick: 5, standard: 10 })
      for (const text of [lesson.titleZh, lesson.goalZh, lesson.model.meaningZh, lesson.model.explanationZh,
        lesson.scaffold.promptZh, lesson.expression.promptZh]) expect(hasChinese(text)).toBe(true)
      expect(lesson.expression.promptZh).toContain('示范词块')
      expect(lesson.model.explanationZh.length).toBeLessThanOrEqual(500)
      expect(lesson.recognition.explanationZh.length).toBeLessThanOrEqual(120)
      expect(lesson.scaffold.explanationZh.length).toBeLessThanOrEqual(120)
    })

    it('accepts the model and at least two different natural alternatives through real course rules', () => {
      const accepted = lesson.expression.accepted.map(text => normalizeStarterAnswer(text, 'en'))
      expect(new Set(accepted).size).toBeGreaterThanOrEqual(3)
      for (const answer of [lesson.model.text, ...lesson.expression.accepted]) {
        expect(localStarterFeedback(lesson, attempt(lesson, answer))).toMatchObject({ verdict: 'valid', correction: null, source: 'course-rule' })
        expect(localStarterFeedback(lesson, attempt(lesson, ` ${answer.replace(/'/gu, '’').toUpperCase()} `)).verdict).toBe('valid')
      }
      expect(localStarterFeedback(lesson, attempt(lesson, lesson.model.text, { prompted: true })).feedbackZh).toContain('借助帮助')
    })

    it('repairs at least two explicit contextual or form errors without blanket rejecting new answers', () => {
      expect(lesson.expression.errors.length).toBeGreaterThanOrEqual(2)
      for (const error of lesson.expression.errors) {
        expect(error.corrected).toBe(lesson.model.text)
        expect(hasChinese(error.feedbackZh)).toBe(true)
        expect(localStarterFeedback(lesson, attempt(lesson, error.input))).toMatchObject({ verdict: 'invalid', correction: lesson.model.text, nextAction: 'retry' })
      }
      expect(localStarterFeedback(lesson, attempt(lesson, 'Could I explain this another way?'))).toMatchObject({ verdict: 'uncertain', correction: null, nextAction: 'clarify' })
    })

    it('checks the taught understanding and assembled form deterministically', () => {
      expect(localStarterFeedback(lesson, attempt(lesson, lesson.scaffold.answer, { stage: 'assemble', mode: 'choice', prompted: true })).verdict).toBe('valid')
      for (const choice of lesson.recognition.choices)
        expect(localStarterFeedback(lesson, attempt(lesson, choice.id, { stage: 'recognize', mode: 'choice', prompted: true })).verdict)
          .toBe(choice.id === lesson.recognition.answerId ? 'valid' : 'invalid')
      expect(lesson.recognition.choices.find(choice => choice.id === lesson.recognition.answerId)?.textZh).toBe(lesson.model.meaningZh)
    })

    it('has three genuinely distinct, already introduced task contexts with independently matching meanings', () => {
      expect(lesson.transfer).toHaveLength(3)
      expect(new Set(lesson.transfer.map(context => context.id)).size).toBe(3)
      expect(new Set(lesson.transfer.map(context => context.promptZh)).size).toBe(3)
      expect(new Set(lesson.transfer.map(context => context.reference)).size).toBe(3)
      expect(lesson.transfer.map(context => [context.reference, context.meaningZh])).toEqual(expectedTransfers[lesson.position - 4])
      for (const context of lesson.transfer) {
        expect(context.id.startsWith(`${lesson.id}-`)).toBe(true)
        expect(Object.keys(context).sort()).toEqual(['id', 'promptZh', 'reference', 'accepted', 'meaningZh', 'explanationZh'].sort())
        expect(hasChinese(context.promptZh) && hasChinese(context.meaningZh) && hasChinese(context.explanationZh)).toBe(true)
        expect(lesson.model.explanationZh).toContain(`${context.reference}（${context.meaningZh}）`)
        expect(context.promptZh).toContain('示范句块')
        expect(new Set(context.accepted.map(answer => normalizeStarterAnswer(answer, 'en'))).size).toBeGreaterThanOrEqual(3)
        for (const answer of [context.reference, ...context.accepted])
          expect(localStarterFeedback(lesson, attempt(lesson, answer, { stage: 'transfer', contextId: context.id })).verdict).toBe('valid')
        // An error from a different role/amount/direction cannot produce the
        // primary correction when that primary is not accepted here.
        if (!context.accepted.some(answer => normalizeStarterAnswer(answer, 'en') === normalizeStarterAnswer(lesson.model.text, 'en')))
          for (const error of lesson.expression.errors)
            expect(localStarterFeedback(lesson, attempt(lesson, error.input, { stage: 'transfer', contextId: context.id })).correction).toBeNull()
      }
    })

    it('has transparent links-only sound provenance, not an invented playable demonstration', () => {
      expect(lesson.sound.status).toBe('pending-review')
      expect(officialSources).toContain(lesson.sound.sourceUrl)
      expect(lesson.sound).not.toHaveProperty('audioPath')
      expect(lesson.sound.sourceLabel).toContain('本站原创')
      expect(lesson.sound.sourceLabel).toContain('非原站字幕')
      expect(lesson.sound.notesZh).toContain('未知')
      expect(lesson.sound.notesZh).toContain('待人工审校')
      for (const text of [lesson.model.text, ...lesson.transfer.map(context => context.reference)])
        expect(starterDemonstrationPath(lesson, text)).toBeUndefined()
      expect(lesson.sound.sourceUrl).not.toMatch(/(?:[?&#](?:t|start)=|#t=)/u)
    })
  })
})

describe('English letter-to-chunk foundations without acoustic claims', () => {
  const letterNames: Readonly<Record<string, string>> = {
    A: '/eɪ/', B: '/biː/', C: '/siː/', D: '/diː/', E: '/iː/', F: '/ɛf/', G: '/dʒiː/', H: '/eɪtʃ/',
    I: '/aɪ/', J: '/dʒeɪ/', K: '/keɪ/', L: '/ɛl/', M: '/ɛm/', N: '/ɛn/', O: '/oʊ/', P: '/piː/',
    Q: '/kjuː/', R: '/ɑr/', S: '/ɛs/', T: '/tiː/', U: '/juː/', V: '/viː/', W: '/ˈdʌbəljuː/',
    X: '/ɛks/', Y: '/waɪ/', Z: '/ziː/',
  }
  it('distributes all 26 unique letter names and matching upper/lowercase checks across six small groups', () => {
    const taught: string[] = []
    for (const lesson of englishContinuingLessons.slice(0, 6)) {
      const foundation = lesson.foundation!, letters: string[] = []
      expect(foundation.examples.length).toBeGreaterThanOrEqual(4)
      expect(foundation.examples.length).toBeLessThanOrEqual(5)
      for (const example of foundation.examples) {
        const match = /^([A-Z]) ([a-z]) — (.+)$/u.exec(example.text)!
        expect(match).not.toBeNull()
        const letter = match[1]!
        expect(match[2]).toBe(letter.toLowerCase())
        expect(match[3]).toBe(letterNames[letter])
        taught.push(letter); letters.push(letter)
      }
      expect(foundation.check.choices.find(choice => choice.id === foundation.check.answerId)?.textZh)
        .toBe(`字形：${letters.map(letter => letter.toLowerCase()).join(' / ')}`)
      expect(foundation.explanationZh).toContain('不要把字母名称当成所有单词里的读音')
    }
    expect(taught).toEqual('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''))
  })

  const correctForms = ['词形：cat / sit', '词形：bed / hot / cup', '拆分：c-a-t → cat', '词形：cape / kite',
    '词形：ship', '词形：this', '词形：sing / back', '标记：TA-ble', "句块：I'm late / because the bus was slow.",
    "写法：Hi, I'll be there at six.", '词形：room', '词形：files', '数量：30', '句块：Please call / an ambulance.', '词形：station']
  it.each(englishContinuingLessons.map(lesson => [lesson.id, lesson] as const))('%s checks taught script/forms, not listening or pronunciation ability', (_id, lesson) => {
    const foundation = lesson.foundation!
    expect(foundation).toBeDefined()
    expect(foundation.sourceUrl).toBe(officialSources[0])
    for (const text of [foundation.titleZh, foundation.explanationZh, foundation.sourceInstructionZh, foundation.check.promptZh,
      foundation.check.explanationZh, ...foundation.examples.map(example => example.meaningZh)]) expect(hasChinese(text)).toBe(true)
    expect(foundation.sourceInstructionZh).toContain('Learn the alphabet')
    expect(foundation.sourceInstructionZh).toContain('没有声音')
    expect(foundation.sourceInstructionZh).toContain('不保证原站有逐词对照录音')
    expect(foundation.check.explanationZh).toContain('文字辨认，不是声音辨别')
    expect(foundation.check.promptZh).not.toMatch(/听到|听出|听辨|给.{0,4}发音.{0,4}评分/u)
    expect(new Set(foundation.check.choices.map(choice => choice.id)).size).toBe(foundation.check.choices.length)
    expect(foundation.check.choices.filter(choice => choice.id === foundation.check.answerId)).toHaveLength(1)
    expect(new Set(foundation.check.choices.map(choice => choice.textZh)).size).toBe(foundation.check.choices.length)
    if (lesson.position >= 10)
      expect(foundation.check.choices.find(choice => choice.id === foundation.check.answerId)?.textZh).toBe(correctForms[lesson.position - 10])
  })

  it('teaches phonics as limited patterns with explicit exceptions, then stress and meaning chunks', () => {
    const foundationAt = (position: number) => englishContinuingLessons[position - 4]!.foundation!
    expect(foundationAt(10).titleZh).toContain('字母名')
    expect(foundationAt(10).explanationZh).toContain('/eɪ/')
    expect(foundationAt(10).explanationZh).toContain('/æ/')
    expect(foundationAt(12).explanationZh).toContain('并非所有三字母词')
    expect(foundationAt(13).examples.map(example => example.text)).toContain('have / give')
    expect(foundationAt(14).examples.map(example => example.text)).toContain('school')
    expect(foundationAt(15).explanationZh).toContain('/θ/')
    expect(foundationAt(15).explanationZh).toContain('/ð/')
    expect(foundationAt(16).examples.map(example => example.text)).toContain('finger')
    expect(foundationAt(17).explanationZh).toContain('不能总猜第一个音节')
    expect(foundationAt(18).explanationZh).toContain('不是强制每次在那里停顿')
    expect(foundationAt(24).explanationZh).toContain('名称')
  })

  it('keeps health/emergency role-play separate from diagnosis, rescue and fluency guarantees', () => {
    const health = englishContinuingLessons.find(lesson => lesson.position === 22)!
    const emergency = englishContinuingLessons.find(lesson => lesson.position === 23)!
    expect(health.model.explanationZh).toContain('不是让网站诊断病情')
    expect(emergency.model.explanationZh).toContain('不要等网站或 AI')
    expect(englishContinuingLessons.at(-1)!.model.explanationZh).toContain('不代表流利或达到某个等级')
  })
})
