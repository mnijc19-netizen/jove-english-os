import type { JapaneseReading } from './japanese-reading'

export const kanaSource = {
  publisher: '国际交流基金 · MARUGOTO Plus',
  hiragana: 'https://a1.marugotoweb.jp/en/hiragana.php',
  katakana: 'https://a1.marugotoweb.jp/en/katakana.php',
  hiraganaDrill: 'https://a1.marugotoweb.jp/en/hiragana_drill.php',
  katakanaDrill: 'https://a1.marugotoweb.jp/en/katakana_drill.php',
  pronunciation: 'https://a1.marugotoweb.jp/en/introduction.php',
  credits: 'https://a1.marugotoweb.jp/en/about_this_site.php',
  policy: 'https://marugotoweb.jp/en/site_policy.php',
  checkedAt: Date.UTC(2026, 8, 19),
}
type Word = [romanization: string, kana: string, meaning: string]
type Row = [characters: string, romanization: string, first: Word, second: Word]
// Our own grouping, examples and checks. No publisher images, drill questions,
// recordings or transcripts are copied. Romanization is a temporary locator,
// not Chinese phonetic spelling or a substitute for hearing the original.
const rows: Row[] = [
  ['あ い う え お', 'a i u e o', ['ai', 'あい', '爱'], ['ue', 'うえ', '上面']],
  ['か き く け こ', 'ka ki ku ke ko', ['kao', 'かお', '脸'], ['ike', 'いけ', '池塘']],
  ['さ し す せ そ', 'sa shi su se so', ['sushi', 'すし', '寿司'], ['asa', 'あさ', '早上']],
  ['た ち つ て と', 'ta chi tsu te to', ['tsuki', 'つき', '月亮'], ['kutsu', 'くつ', '鞋']],
  ['な に ぬ ね の', 'na ni nu ne no', ['neko', 'ねこ', '猫'], ['inu', 'いぬ', '狗']],
  ['は ひ ふ へ ほ', 'ha hi fu he ho', ['hana', 'はな', '花'], ['fune', 'ふね', '船']],
  ['ま み む め も', 'ma mi mu me mo', ['umi', 'うみ', '海'], ['mame', 'まめ', '豆子']],
  ['や ゆ よ', 'ya yu yo', ['yama', 'やま', '山'], ['yuki', 'ゆき', '雪']],
  ['ら り る れ ろ', 'ra ri ru re ro', ['sora', 'そら', '天空'], ['tori', 'とり', '鸟']],
  ['わ を ん', 'wa o n', ['kawa', 'かわ', '河流'], ['hon', 'ほん', '书']],
  ['が ぎ ぐ げ ご', 'ga gi gu ge go', ['kagi', 'かぎ', '钥匙'], ['gogo', 'ごご', '下午']],
  ['ざ じ ず ぜ ぞ', 'za ji zu ze zo', ['mizu', 'みず', '水'], ['kaze', 'かぜ', '风']],
  ['だ ぢ づ で ど', 'da ji zu de do', ['mado', 'まど', '窗户'], ['tsuzuku', 'つづく', '继续']],
  ['ば び ぶ べ ぼ', 'ba bi bu be bo', ['kaban', 'かばん', '包'], ['nabe', 'なべ', '锅']],
  ['ぱ ぴ ぷ ぺ ぽ', 'pa pi pu pe po', ['pan', 'ぱん', '面包'], ['sanpo', 'さんぽ', '散步']],
  ['きゃ きゅ きょ', 'kya kyu kyo', ['kyaku', 'きゃく', '客人'], ['kyonen', 'きょねん', '去年']],
  ['しゃ しゅ しょ', 'sha shu sho', ['shashin', 'しゃしん', '照片'], ['jisho', 'じしょ', '词典']],
]
const katakana = (text: string) => text.replace(/[ぁ-ゖ]/gu, c => String.fromCharCode(c.charCodeAt(0) + 0x60))
const rotate = (values: string[], index: number) => { const offset = index % values.length; return [...values.slice(offset), ...values.slice(0, offset)] }
export const japaneseKana: JapaneseReading[] = (['hiragana', 'katakana'] as const).flatMap(script => rows.map((row, index) => {
  const convert = script === 'katakana' ? katakana : (s: string) => s
  const letters = row[0].split(' ').map(convert), labels = row[1].split(' '), first = row[2], second = row[3]
  const note = convert(index === 9 ? '「ん／ン」也占一拍；助词「を」通常读 o，输入法可能需要 wo。不要按中文字数安排节奏。'
    : index === 12 ? '「じ／ぢ」「ず／づ」在标准语中可能同音，但拼写不能随意互换。先记住当前词语里的写法。'
      : index >= 15 ? '小「ゃ／ゅ／ょ」与前一个字合成一拍，如「きゃ」。其他拗音也遵循这种组合方式，听原声确认，不按两个大字读。'
        : '按原声把字形和声音联系起来；不要用中文谐音代替。遇到不熟悉的例词，可以先看帮助。')
  const words = [first, second].map(([roman, kana, meaning], i) => ({ text: `${roman}（${meaning}）`, reading: convert(kana), meaning,
    choices: rotate([convert(kana), convert([first, second][1 - i]![1]), convert(kana + kana.slice(-1))], index + i) }))
  return {
    id: `ja-kana-${script}-${index + 1}`, band: 0 as const, title: `${script === 'hiragana' ? '平假名' : '片假名'} · ${letters.join(' ')}`,
    passage: letters.join('　'), meaningZh: `${letters.map((letter, i) => `${letter} → ${labels[i]}`).join('；')}。${note}`,
    questions: [0, letters.length - 1].map((i, q) => ({ prompt: `「${letters[i]}」对应哪个临时罗马字标记？`,
      choices: rotate([...new Set([labels[i]!, labels[(i + 1) % labels.length]!, labels[(i + 2) % labels.length]!])], index + q), answer: labels[i]!, why: note })),
    words, transfer: `写下今天最容易混淆的一对字，或一个准备再听的词。不需要先背完字表；接着做生活对话。`,
    kana: { script, targets: letters, sourceUrl: kanaSource[script], drillUrl: script === 'hiragana' ? kanaSource.hiraganaDrill : kanaSource.katakanaDrill,
      guidance: `在原站找到「${letters.join(' ')}」，逐个点击原声：先听、跟读，再看字形。已有基础时可遮住罗马字。${note}` },
  }
}))
const rhythm: { title: string; passage: string; help: string; questions: [string, string[], string][]; words: [Word, Word] }[] = [
  { title: '长音不是多写一个符号', passage: 'おばさん　／　おばあさん', help: '长音会占用时间，也可能改变意思。「おばさん」与「おばあさん」不同；不能只凭汉字含义猜。',
    questions: [['「おばあさん」按拍数划分是多少？', ['四拍', '五拍', '六拍'], '五拍'], ['哪一个表示奶奶／年长女性？', ['おばさん', 'おばあさん', '两者完全一样'], 'おばあさん']],
    words: [['obasan', 'おばさん', '阿姨／中年女性'], ['obaasan', 'おばあさん', '奶奶／年长女性']] },
  { title: '小っ也留出一拍', passage: 'さか　／　さっか', help: '小「っ」表示后续辅音前的阻塞或延长，不单独读 tsu。这里的文字题只检查拍数意识，不判断你录音的时长。',
    questions: [['「さっか」有几拍？', ['一拍', '两拍', '三拍'], '三拍'], ['「さか」和「さっか」是否同一个词？', ['完全相同', '是不同的词', '只取决于汉字'], '是不同的词']],
    words: [['saka', 'さか', '坡'], ['sakka', 'さっか', '作家']] },
  { title: 'ん与拗音的节奏', passage: 'ほん　／　きゃく', help: '「ん」单独占一拍；「きゃ」虽然写两个字符，却合成一拍。听整词、轻拍节奏，不机械地逐字停顿。',
    questions: [['「ほん」有几拍？', ['一拍', '两拍', '三拍'], '两拍'], ['「きゃく」有几拍？', ['一拍', '两拍', '三拍'], '两拍']],
    words: [['hon', 'ほん', '书'], ['kyaku', 'きゃく', '客人']] },
  { title: '助词读法与整句语调', passage: '私は学校へ行きます。', help: '这句中的主题助词「は」读 wa，方向助词「へ」读 e。它们仍写「は／へ」。日语词的高低和整句语调要结合原声听，不把普通话四声套到每个日语字上。',
    questions: [['这句的助词「は」怎么读？', ['ha', 'wa', 'pa'], 'wa'], ['这句的助词「へ」怎么读？', ['he', 'be', 'e'], 'e']],
    words: [['watashi', 'わたし', '我'], ['gakkou', 'がっこう', '学校']] },
]
japaneseKana.push(...rhythm.map((r, index): JapaneseReading => ({ id: `ja-kana-rhythm-${index + 1}`, band: 0, title: r.title, passage: r.passage, meaningZh: r.help,
  questions: r.questions.map(([prompt, choices, answer]) => ({ prompt, choices, answer, why: r.help })),
  words: r.words.map(([roman, reading, meaning], i) => ({ text: `${roman}（${meaning}）`, reading, meaning,
    choices: rotate([reading, r.words[1 - i]![1], reading + reading.slice(-1)], i + index) })), transfer: '对照原声说一个整词或短句，记下下一次要留意的一点。可以在生活练习里录音回放，不需要发音评分。',
  kana: { script: 'rhythm', targets: [], sourceUrl: kanaSource.pronunciation, drillUrl: kanaSource.hiraganaDrill,
    guidance: '打开原站的 Pronunciation（发音）栏目，听节拍与音高示范，再回来看本站的原创对照练习。例词不一定与原站逐字相同。' },
})))
