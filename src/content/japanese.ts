import type { Material } from '../domain/types'

/** Publisher curriculum + original app practice prompts, not copied exercises.
 * Narrator credits: https://www.irodori.jpf.go.jp/en/about.html
 * Directory: https://www.irodori.jpf.go.jp/en/starter/pdf.html
 * The four graded books are finite courses, not a new-publication feed. */
export const japaneseSource = {
  publisher: '日本国际交流基金 · いろどり',
  directory: 'https://www.irodori.jpf.go.jp/en/starter/pdf.html',
  credits: 'https://www.irodori.jpf.go.jp/en/about.html',
  checkedAt: Date.UTC(2026, 8, 19, 19, 22),
} as const
export interface JapaneseLesson {
  id: string; position: number; title: string; canDo: string
  phrase: string; reading: string; meaningZh: string
  grammarZh: string; soundZh: string; transferZh: string
}
// Short common language examples and authored transfer tasks. Grammar notes are
// specific to Japanese; the English exercise generator is not used here.
const lessons: Omit<JapaneseLesson, 'id' | 'position'>[] = [
  { title: '见面与告别', canDo: '根据时间和对象打招呼，并作出合适回应。', phrase: 'おはようございます。', reading: 'おはようございます', meaningZh: '早上好（礼貌说法）',
    grammarZh: '先把常用问候当作完整表达使用；同事初见和朋友闲聊的礼貌程度不一样。', soundZh: '留意「よう」的时长；先模仿原声节奏，不按汉字或英文重音读。', transferZh: '明早见到新同事，再在下班离开时，各说一句合适的话。' },
  { title: '听不懂也能继续交流', canDo: '礼貌地请对方重复、放慢或确认意思。', phrase: 'もう一度お願いします。', reading: 'もういちどおねがいします', meaningZh: '请再说一遍。',
    grammarZh: '用请求帮助的表达修复对话，不用假装听懂；「もう一度」是一块意思完整的表达。', soundZh: '「もう」有两拍；比较原声和自己的录音，不给音高百分数。', transferZh: '你没听清车站工作人员的回答，请他再说一遍。' },
  { title: '介绍自己', canDo: '说出名字和来自哪里，并向对方询问。', phrase: '中国から来ました。', reading: 'ちゅうごくからきました', meaningZh: '我来自中国。',
    grammarZh: '「から」表示来源。日语在语境清楚时常省略主语，不要逐字套英语句序。', soundZh: '「ちゅ」合为一拍，「う」再占一拍；长音不要吞掉。', transferZh: '向第一次见面的邻居介绍自己，再问对方来自哪里。' },
  { title: '说说住在哪里', canDo: '告诉别人居住地和简单的个人情况。', phrase: 'ここに住んでいます。', reading: 'ここにすんでいます', meaningZh: '我住在这里。',
    grammarZh: '在这句里「に」标记居住地点；先结合自己的情况使用「住んでいます」。', soundZh: '「ん」自己占一拍，别直接跳到「で」。', transferZh: '向新朋友说明住在哪一带，并询问对方。' },
  { title: '说出饮食喜好', canDo: '说明喜欢或不喜欢的食物，听懂对方的选择。', phrase: '魚が好きです。', reading: 'さかながすきです', meaningZh: '我喜欢鱼。',
    grammarZh: '「好き」不是英语 like 那样的动词；把「食物＋が好きです」作为句型使用。', soundZh: '听原声里的「すき」，不强求每个元音同样响亮。', transferZh: '朋友为你选餐，告诉他两种偏好，并问他喜欢什么。' },
  { title: '点餐并确认', canDo: '提出简单点餐请求，确认数量。', phrase: 'これを二つください。', reading: 'これをふたつください', meaningZh: '这个请给我两个。',
    grammarZh: '「を」在这里标记所要的东西；数量表达随物品变化，先练有用的组合。', soundZh: '助词「を」在现代常规发音中读作「お」。', transferZh: '在另一家店为两个人点餐，改变物品和数量。' },
  { title: '介绍房间', canDo: '简单说明房间和物品。', phrase: '台所があります。', reading: 'だいどころがあります', meaningZh: '有厨房。',
    grammarZh: '「あります」用于这里的非生命物体；和人、动物常用的「います」分开练。', soundZh: '按「だ・い・ど・こ・ろ」五拍听读，不按中文字数算。', transferZh: '向即将来访的朋友介绍住处的两个设施。' },
  { title: '找人和找位置', canDo: '询问某人或某处在哪里，并理解简短指引。', phrase: '受付はどこですか。', reading: 'うけつけはどこですか', meaningZh: '接待处在哪里？',
    grammarZh: '「は」提示当前话题，作为助词时读「わ」；不要把它当成所有句子的主语标记。', soundZh: '注意问句的语调，用原声对照，不只把最后一个音拔高。', transferZh: '第一次去一个新场所，先找接待处，再确认位置。' },
  { title: '确认时间安排', canDo: '听出起止时间，说明自己的日程。', phrase: '九時から五時までです。', reading: 'くじからごじまでです', meaningZh: '从九点到五点。',
    grammarZh: '「から／まで」在这里标记时间起点与终点；时刻的读法需要结合词来记。', soundZh: '九点读「くじ」，不要从汉字机械猜读音。', transferZh: '向同事说明一个不同的工作或学习时段。' },
  { title: '借用东西', canDo: '提出一个具体请求，并回应对方。', phrase: 'ペンを貸してください。', reading: 'ぺんをかしてください', meaningZh: '请借我一支笔。',
    grammarZh: '「てください」用于提出请求；注意对象和场合，不把所有请求都处理成命令。', soundZh: '片假名词「ペン」里的「ン」也占一拍。', transferZh: '你需要另一件物品，礼貌地向身边的人借用。' },
  { title: '谈兴趣', canDo: '说出喜欢的活动，并问一个跟进问题。', phrase: '音楽を聞くのが好きです。', reading: 'おんがくをきくのがすきです', meaningZh: '我喜欢听音乐。',
    grammarZh: '「动词辞书形＋の」把活动作为话题内容；这里用于说明爱好。', soundZh: '留意词组之间的停顿，不逐字均匀切开。', transferZh: '在兴趣不同的新朋友面前介绍一项爱好，并继续聊一句。' },
  { title: '邀请与回应', canDo: '邀请别人一起活动，并礼貌接受或婉拒。', phrase: '一緒に行きませんか。', reading: 'いっしょにいきませんか', meaningZh: '要不要一起去？',
    grammarZh: '「ませんか」在邀请语境中不等于简单否定问句；拒绝时保留对方感受。', soundZh: '「っ」占一拍；「しょ」合为一拍。', transferZh: '邀请同事周末做另一件事，再练习对方没空时的回应。' },
  { title: '确认交通方向', canDo: '确认交通工具是否到达目的地。', phrase: '駅に行きますか。', reading: 'えきにいきますか', meaningZh: '去车站吗？',
    grammarZh: '在移动表达中用「に」标记目的地；目的地和出发地点分开听。', soundZh: '「えき」有两拍，别按英语音节规则处理。', transferZh: '目的地换了，在上车前重新向司机确认。' },
  { title: '描述地标', canDo: '用简短描述帮助别人识别建筑。', phrase: '大きい建物です。', reading: 'おおきいたてものです', meaningZh: '是一栋很大的建筑。',
    grammarZh: '「い形容词」可直接修饰名词；不额外插入英语式系动词。', soundZh: '「おおきい」保留长元音，听原声长度后再录一次。', transferZh: '给第一次来的人描述另一座地标。' },
  { title: '询问商品', canDo: '向店员询问需要的物品和位置。', phrase: '電池はありますか。', reading: 'でんちはありますか', meaningZh: '有电池吗？',
    grammarZh: '「ありますか」可在购物场景询问是否有货；不要单靠汉字识别当成会开口。', soundZh: '「でんち」有三拍；注意鼻音的时长。', transferZh: '换一种生活用品，向店员询问有没有。' },
  { title: '问价格', canDo: '询问并确认价格，作出购买决定。', phrase: 'これはいくらですか。', reading: 'これはいくらですか', meaningZh: '这个多少钱？',
    grammarZh: '「これ」指靠近说话者的东西；结合现场位置区分「それ／あれ」。', soundZh: '听数字时先抓金额，不要求第一次就跟上整句。', transferZh: '两件商品之间做选择，分别询问价格并确认要买哪件。' },
  { title: '讲述过去的一件事', canDo: '用简短句子说明昨天或周末做了什么。', phrase: '昨日、映画を見ました。', reading: 'きのうえいがをみました', meaningZh: '昨天看了电影。',
    grammarZh: '「ました」是礼貌过去形式；先对比现在／过去的实际意思，再整理活用。', soundZh: '「きのう」和「えいが」都要注意连续元音的长度。', transferZh: '讲述另一个周末经历，并向对方问同一个问题。' },
  { title: '表达想做的事', canDo: '说明一个愿望或计划，并讨论简单安排。', phrase: '温泉に行きたいです。', reading: 'おんせんにいきたいです', meaningZh: '我想去温泉。',
    grammarZh: '「动词ます形去ます＋たい」表达自己的愿望；不要直接替别人断定想法。', soundZh: '「おんせん」有四拍；以原声为参照，不追求虚构的完美分数。', transferZh: '说一个不同的出行愿望，再询问同伴的想法。' },
]
export const japaneseStarterLessons: JapaneseLesson[] = lessons.map((lesson, index) => ({ ...lesson, position: index + 1, id: `ja-irodori-starter-${index + 1}` }))
export function japaneseStarterMaterials(): Material[] {
  return japaneseStarterLessons.map(lesson => ({
    id: lesson.id, language: 'ja', title: lesson.title, topic: '生活日语', difficulty: 0.1 + (lesson.position - 1) * 0.025,
    duration: 0, transcript: '', sentences: [], sourceKind: 'url', sourceLabel: japaneseSource.publisher,
    sourceUrl: `https://www.irodori.jpf.go.jp/en/starter/audio/lesson${String(lesson.position).padStart(2, '0')}.html`,
    license: 'Publisher playback links only; app examples and prompts are original, not publisher transcripts.', synthetic: false, approved: true,
    question: lesson.canDo, answer: '', keywords: [], createdAt: japaneseSource.checkedAt,
    chunks: [{ text: lesson.phrase, meaningEn: '', meaningZh: lesson.meaningZh, example: lesson.phrase }],
    externalStudy: { publisher: japaneseSource.publisher, level: 'beginner', mission: `先听原站的一段对话，再说明意思。${lesson.canDo}随后录音：${lesson.transferZh}`, checkedAt: japaneseSource.checkedAt },
  }))
}
