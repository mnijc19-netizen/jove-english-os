import { englishContinuingLessons } from './starter-english'
import { japaneseContinuingLessons } from './starter-japanese'

/**
 * Original starter material for a Chinese-native absolute beginner.
 * These editorial fixtures are test expectations, not provider accuracy results.
 * Independent language review and sound review are separate release gates.
 */
export interface StarterLesson {
  id: string
  language: 'en' | 'ja'
  version: number
  position: number
  titleZh: string
  goalZh: string
  prerequisites: string[]
  minutes: { quick: number; standard: number }
  model: { text: string; meaningZh: string; explanationZh: string; reading?: string; romaji?: string }
  recognition: { promptZh: string; choices: { id: string; textZh: string }[]; answerId: string; explanationZh: string }
  scaffold: { promptZh: string; pieces: string[]; answer: string; explanationZh: string }
  expression: { promptZh: string; reference: string; accepted: string[]; errors: { input: string; feedbackZh: string; corrected: string }[] }
  transfer: { id: string; promptZh: string; reference: string; accepted: string[]; meaningZh: string; explanationZh: string; romaji?: string }[]
  sound: { sourceLabel: string; sourceUrl?: string; audioPath?: string; status: 'pending-review' | 'reviewed'; notesZh: string }
  /** Original, small, script/sound teaching. Its check is not spoken mastery. */
  foundation?: {
    titleZh: string; explanationZh: string; examples: { text: string; meaningZh: string }[]
    sourceUrl: string; sourceInstructionZh: string
    check: { promptZh: string; choices: { id: string; textZh: string }[]; answerId: string; explanationZh: string }
  }
}

export type StarterFeedbackVerdict = 'accept' | 'repair' | 'clarify'

export interface StarterFeedbackFixture {
  id: string
  lessonId: string
  language: 'en' | 'ja'
  /** The task context matters: casual speech is not universally wrong. */
  promptZh: string
  input: string
  expected: StarterFeedbackVerdict
  feedbackZh: string
  /** Only an actual repair has a proposed replacement. Clarification is not a grammar failure. */
  corrected?: string
}

export const starterContentPolicy = Object.freeze({
  authorship: 'original',
  languageReview: 'pending-independent-review',
  fixturePurpose: 'deterministic-editorial-feedback-regression',
  providerAccuracy: 'not-measured',
} as const)

function freezeContent<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freezeContent(child)
    Object.freeze(value)
  }
  return value
}

function pendingSound(language: 'en' | 'ja', id: string): StarterLesson['sound'] {
  return {
    sourceLabel: language === 'en'
      ? '原创合成语音：Windows System.Speech / Microsoft Zira Desktop (en-US)'
      : '原创合成语音：Windows System.Speech / Microsoft Haruka Desktop (ja-JP)',
    audioPath: `audio/starter/${id}.wav`,
    status: 'pending-review',
    notesZh: language === 'en'
      ? '使用本站原创文本生成的补充合成示范，不是来自真人的英语听力材料。路径预留给独立生成的文件，生成后仍需试听核对；不能因文件存在就认定自然度或通用美式发音已经通过质量验证。不要用汉字谐音学发音。'
      : '使用本站原创文本生成的补充合成示范，不是真人日语材料。路径预留给独立生成的文件，生成后仍需试听核对长音、停顿与礼貌程度；不能因文件存在就认定自然度或标准发音已经通过质量验证。罗马字是可关闭的临时提示，不表示完整音色或音高，不能用来评分。',
  }
}

export const starterEntryLessons: readonly StarterLesson[] = freezeContent<StarterLesson[]>([
  {
    id: 'en-starter-1', language: 'en', version: 1, position: 1,
    titleZh: '先打招呼，再说自己的名字',
    goalZh: '见到一个人时，能简单打招呼并介绍自己。', prerequisites: [],
    minutes: { quick: 5, standard: 10 },
    model: {
      text: "Hi, I'm Jove.", meaningZh: '你好，我是 Jove。',
      explanationZh: "先把 Hi（你好）和 I'm Jove（我是 Jove）当作两小块理解。I'm 是 I am 的日常缩写，意思相同；Hello 也可以打招呼。名字可以换成你自己的。这次不要求先背字母、拼读整张表或自由写作；看完示范后可以先点词块。My name is Jove（我叫 Jove）也是合理说法，不必为了用另一种说法再重学本课。",
    },
    recognition: {
      promptZh: '刚才这句话主要告诉对方什么？',
      choices: [{ id: 'name', textZh: '说话的人叫 Jove' }, { id: 'drink', textZh: '说话的人想喝水' }],
      answerId: 'name', explanationZh: "I'm Jove 是在介绍说话的人，不是在问对方的名字。",
    },
    scaffold: {
      promptZh: '先不用自己打字。按顺序选两小块和名字，说“你好，我是 Jove”。',
      pieces: ['Hi,', "I'm", 'Jove.'], answer: "Hi, I'm Jove.",
      explanationZh: "Hi 负责打招呼，I'm 后面放自己的名字。先照着组合也算练习，但还不是独立表达。",
    },
    expression: {
      promptZh: '你第一次见到同学。用英语打招呼，并告诉对方你叫 Jove。可以说，也可以先用词块组合。',
      reference: "Hi, I'm Jove.",
      accepted: ["Hi, I'm Jove.", 'Hi, I am Jove.', "Hello, I'm Jove.", 'Hello, I am Jove.', 'Hi, my name is Jove.', 'Hello, my name is Jove.'],
      errors: [
        { input: 'Hi, I Jove.', feedbackZh: '名字已经清楚了。介绍自己时，把 I 后面的 am 补上；也可以直接用小块 I’m。', corrected: "Hi, I'm Jove." },
        { input: 'Hi, I is Jove.', feedbackZh: '说自己用 I am，不用 I is。先把 I’m 当一整块，再试一次。', corrected: "Hi, I'm Jove." },
        { input: 'Hi, you are Jove.', feedbackZh: '这句话说的是“你是 Jove”。现在介绍你自己，把 you are 换成 I’m。', corrected: "Hi, I'm Jove." },
      ],
    },
    transfer: [
      { id: 'en-starter-1-group', promptZh: '加入新的兴趣小组，向身边的人打招呼并介绍自己是 Jove。', reference: "Hi, I'm Jove.", accepted: ["Hi, I'm Jove.", 'Hello, my name is Jove.', 'Hi, I am Jove.'],
        meaningZh: "你好，我是 Jove。", explanationZh: "第一次加入小组，先用 Hi 打招呼，再用 I’m 加自己的名字。这里说的是自己，不是问对方是谁。Hello 或 my name is 也可以。" },
      { id: 'en-starter-1-online', promptZh: '第一次进入线上小组，用一条短消息打招呼并说你叫 Jove。', reference: "Hello, I'm Jove.", accepted: ["Hello, I'm Jove.", "Hi, I'm Jove.", 'Hi, my name is Jove.'],
        meaningZh: "你好，我是 Jove。", explanationZh: "短消息里，Hello 是招呼，I’m Jove 是介绍自己；不用写一大段自我介绍。换成 Hi 或 my name is 仍能完成这次任务。" },
      { id: 'en-starter-1-partner', promptZh: '新搭档已经对你说了 Hi（你好）。接着告诉对方你叫 Jove；不必再重复问好。', reference: "I'm Jove.", accepted: ["I'm Jove.", 'I am Jove.', 'My name is Jove.', "Hi, I'm Jove."],
        meaningZh: "我是 Jove。", explanationZh: "对方已经问好，这次直接报自己的名字就够了。I’m 是 I am 的缩写；这句示范没有再说“你好”，也不要求你重复招呼。" },
    ],
    sound: pendingSound('en', 'en-starter-1'),
  },
  {
    id: 'en-starter-2', language: 'en', version: 1, position: 2,
    titleZh: '确认对方的名字', goalZh: '不确定有没有找对人时，能问“你是 Jove 吗？”。',
    prerequisites: ['en-starter-1'], minutes: { quick: 5, standard: 10 },
    model: {
      text: 'Are you Jove?', meaningZh: '你是 Jove 吗？',
      explanationZh: '这次只学 Are you + 名字？这个问句小块，you 指对方。它用来确认已经听说的名字；不是介绍你自己。问句的声音示范需要另行核对，不能凭打了问号就认定语调正确。若对方问你，Yes, I am（是的，我是）可以作简短回答，No（不是）也能先说明意思；这些回应先看懂，不是新的必做考试。',
    },
    recognition: {
      promptZh: '说 Are you Jove? 的人想做什么？',
      choices: [{ id: 'self', textZh: '介绍自己叫 Jove' }, { id: 'confirm', textZh: '确认对方是不是 Jove' }],
      answerId: 'confirm', explanationZh: 'Are you 把问题指向对方。需要的是对方确认，不是告诉对方你的名字。',
    },
    scaffold: {
      promptZh: '不用自己拼字。组合“你是 Jove 吗？”的三个词块。',
      pieces: ['Are', 'you', 'Jove?'], answer: 'Are you Jove?',
      explanationZh: '这里用 Are you 开头来问对方，再放要确认的名字。',
    },
    expression: {
      promptZh: '你在等一个叫 Jove 的人。面前的人可能就是他，用英语确认名字。',
      reference: 'Are you Jove?',
      accepted: ['Are you Jove?', 'Hi, are you Jove?', 'Hello, are you Jove?', "You're Jove, right?", 'You are Jove, right?', 'Is your name Jove?', "You're Jove?", 'You are Jove?'],
      errors: [
        { input: 'Is you Jove?', feedbackZh: '意思已经接近了。对 you 用 are：把开头换成 Are you。', corrected: 'Are you Jove?' },
        { input: 'Are your Jove?', feedbackZh: 'your 是“你的”，这里要说“你”。换成 you 就可以。', corrected: 'Are you Jove?' },
        { input: 'Are you name Jove?', feedbackZh: '确认人时，Are you 后面直接放名字就够了；先不用加 name。', corrected: 'Are you Jove?' },
      ],
    },
    transfer: [
      { id: 'en-starter-2-station', promptZh: '在车站第一次见网友，约好的名字是 Jove。用一句话确认是不是找对了人。', reference: 'Are you Jove?', accepted: ['Are you Jove?', 'Hi, are you Jove?', 'Is your name Jove?'],
        meaningZh: "你是 Jove 吗？", explanationZh: "你知道要找的名字，但还不确定面前是不是那个人。用 Are you 加名字确认；you 指面前的人，不是在介绍自己。" },
      { id: 'en-starter-2-team', promptZh: '你要把资料交给 Jove，递给面前的人前先确认名字。', reference: 'Are you Jove?', accepted: ['Are you Jove?', "You're Jove, right?", 'You are Jove, right?'],
        meaningZh: "你是 Jove 吗？", explanationZh: "递东西前先确认对象。Are you Jove? 是问对方是否叫 Jove；换成 You’re Jove, right?（你是 Jove，对吗？）也合理，不必只背一种问法。" },
      { id: 'en-starter-2-call', promptZh: '线上通话里有一位新搭档，你想确认对方是 Jove。', reference: 'Hello, are you Jove?', accepted: ['Hello, are you Jove?', 'Are you Jove?', "You're Jove?"],
        meaningZh: "你好，你是 Jove 吗？", explanationZh: "通话开始先问好，再确认对方名字。Hello 是“你好”，后面的 Are you Jove? 才是问题；直接问名字也可以。" },
    ],
    sound: pendingSound('en', 'en-starter-2'),
  },
  {
    id: 'en-starter-3', language: 'en', version: 1, position: 3,
    titleZh: '说出一个简单需要', goalZh: '需要水时，能让对方知道并礼貌提出请求。',
    prerequisites: ['en-starter-2'], minutes: { quick: 5, standard: 10 },
    model: {
      text: 'I need water, please.', meaningZh: '我需要水，麻烦你。',
      explanationZh: 'I need 表示“我需要”，water 是“水”，please 让请求更礼貌。这次把 I need 和 water 分开组合就好，不要求先背语法表。实际点饮料时 Water, please（水，麻烦你）也自然，不一定每次说完整句；a water 可以指一份水，不要因为它与示范不同就判错。其他自然请求也可以，只要意思和情境合适。',
    },
    recognition: {
      promptZh: '听到或看到 I need water, please，对方应该知道你需要什么？',
      choices: [{ id: 'name', textZh: '确认一个人的名字' }, { id: 'water', textZh: '水' }],
      answerId: 'water', explanationZh: 'water 是这次需要的东西。I need 不是问名字的句型。',
    },
    scaffold: {
      promptZh: '选词块，说“我需要水，麻烦你”。先组合，不必自由写句子。',
      pieces: ['I need', 'water,', 'please.'], answer: 'I need water, please.',
      explanationZh: '先说 I need，再说要什么，最后可以加 please。',
    },
    expression: {
      promptZh: '对方可以给你拿水。用英语告诉对方你想要水，语气礼貌即可。',
      reference: 'I need water, please.',
      accepted: ['I need water, please.', 'I need some water, please.', 'Water, please.', 'Some water, please.', 'A water, please.', "I'd like some water, please.", 'I would like some water, please.', 'Can I have some water, please?', 'Could I have some water, please?', 'I want some water, please.'],
      errors: [
        { input: 'I needs water, please.', feedbackZh: '需要什么已经说清楚了。I 后面用 need，不加 s。只改这一个地方再试。', corrected: 'I need water, please.' },
        { input: 'I am need water.', feedbackZh: 'need 本身就表示“需要”，I 后面直接接 need，不用先加 am。', corrected: 'I need water, please.' },
        { input: 'Me need water.', feedbackZh: '这句话能让人猜到意思。这个句型里，把 Me 换成 I；请求时还可以加 please。', corrected: 'I need water, please.' },
      ],
    },
    transfer: [
      { id: 'en-starter-3-meal', promptZh: '吃饭时服务员问你要什么饮料，你只想要水。简单回答即可。', reference: 'Water, please.', accepted: ['Water, please.', 'A water, please.', 'I need water, please.', "I'd like some water, please."],
        meaningZh: "水，麻烦你。", explanationZh: "服务员已经问要什么饮料，只说 Water, please 就能礼貌回答，不必补成完整句。点饮料时 a water 可以指一份水，也不是一概错误。" },
      { id: 'en-starter-3-work', promptZh: '活动结束后口渴，工作人员可以给你拿水。礼貌说出需要。', reference: 'I need water, please.', accepted: ['I need water, please.', 'Can I have some water, please?', 'Could I have some water, please?', 'Some water, please.'],
        meaningZh: "我需要水，麻烦你。", explanationZh: "这里向能够帮你拿水的人提出请求。I need 说出“我需要”，water 是东西，please 使请求更礼貌；用自然的问句请求也可以。" },
      { id: 'en-starter-3-home', promptZh: '朋友问你需要什么，你想请他拿一点水。', reference: 'I need some water, please.', accepted: ['I need some water, please.', 'I need water, please.', 'Water, please.', 'Can I have some water, please?'],
        meaningZh: "我需要一点水，麻烦你。", explanationZh: "对朋友说需要一些水，some water 可以理解成“一点水”，不指定精确数量。不加 some 或直接说 Water, please，在这个情境里也清楚。" },
    ],
    sound: pendingSound('en', 'en-starter-3'),
  },
  {
    id: 'ja-starter-1', language: 'ja', version: 1, position: 1,
    titleZh: '早上礼貌地打招呼', goalZh: '早上见到老师或不熟悉的人，能说一句礼貌的早上好。',
    prerequisites: [], minutes: { quick: 5, standard: 10 },
    model: {
      text: 'おはようございます。', meaningZh: '早上好。（礼貌）', reading: 'おはようございます', romaji: 'ohayō gozaimasu',
      explanationZh: '先理解和模仿这一整句，不要求认识五十音或输入日语。おはよう 是“早上好”，加 ございます 是礼貌说法，适合老师和不熟的人；熟朋友之间也常说短一些的 おはよう。罗马字可暂时帮助跟读，其中 ō 提醒把 o 延长，不能用汉字谐音替代声音示范，也不用现在考声调。',
    },
    recognition: {
      promptZh: '这句礼貌招呼是在什么时候使用的？不必读假名，按刚才的中文解释选。',
      choices: [{ id: 'morning', textZh: '早上见面时' }, { id: 'thanks', textZh: '感谢别人帮忙时' }],
      answerId: 'morning', explanationZh: '这是早上的招呼，不是感谢句。先记住什么时候用就够了。',
    },
    scaffold: {
      promptZh: '按示范点两块，向老师说礼貌的“早上好”；不用自己打日语。',
      pieces: ['おはよう', 'ございます。'], answer: 'おはようございます。',
      explanationZh: '先跟着拼出完整礼貌招呼。点击或照读属于有帮助的练习，不代表已经独立会读假名。',
    },
    expression: {
      promptZh: '早上第一次见到老师，礼貌打个招呼。可以跟说或点词块，不要求日语输入法。',
      reference: 'おはようございます。',
      accepted: ['おはようございます。', 'おはようございます', '先生、おはようございます。'],
      errors: [
        { input: 'おはようです。', feedbackZh: '早上好已经选对了。这里是固定礼貌招呼，用 ございます，不换成 です。', corrected: 'おはようございます。' },
        { input: 'おはよございます。', feedbackZh: '如果这是你自己核对过的文字，这里少了 よ 后面的 う。文字示范写 おはよう；不能据此断定你的实际发音有错。', corrected: 'おはようございます。' },
        { input: 'おはよう。', feedbackZh: '对熟朋友这样说没错。这次对象是第一次见的老师，换成完整礼貌句更合适。', corrected: 'おはようございます。' },
      ],
    },
    transfer: [
      { id: 'ja-starter-1-desk', promptZh: '早上走到旅馆前台，礼貌和工作人员打招呼。', reference: 'おはようございます。', accepted: ['おはようございます。', 'おはようございます'],
        meaningZh: "早上好。（礼貌）", explanationZh: "早上面对不熟悉的工作人员，用完整的 おはようございます 礼貌问好。它是早上的招呼，不是在感谢服务。", romaji: "ohayō gozaimasu" },
      { id: 'ja-starter-1-colleague', promptZh: '早上见到还不熟悉的新同事，礼貌问好。', reference: 'おはようございます。', accepted: ['おはようございます。', 'おはようございます'],
        meaningZh: "早上好。（礼貌）", explanationZh: "还不熟悉的新同事之间，先用完整礼貌招呼。おはようございます 表示早上好，不需要另外添加“我”或对方名字。", romaji: "ohayō gozaimasu" },
      { id: 'ja-starter-1-friend', promptZh: '早上见到熟朋友，轻松说早上好；礼貌说法也可以。', reference: 'おはよう。', accepted: ['おはよう。', 'おはよう', 'おはようございます。'],
        meaningZh: "早上好。（熟人之间的轻松说法）", explanationZh: "这里面对熟朋友，短一些的 おはよう 很自然。这句示范没有 ございます；如果你想保持礼貌，也可以用完整长句，不把两种说法机械判成对错。", romaji: "ohayō" },
    ],
    sound: pendingSound('ja', 'ja-starter-1'),
  },
  {
    id: 'ja-starter-2', language: 'ja', version: 1, position: 2,
    titleZh: '用名字介绍自己', goalZh: '初次见面时，能礼貌地告诉对方自己的名字。',
    prerequisites: ['ja-starter-1'], minutes: { quick: 5, standard: 10 },
    model: {
      text: 'ジョーブです。', meaningZh: '我是乔布。（示范昵称 Jove）', reading: 'ジョーブです', romaji: 'Jōbu desu',
      explanationZh: '这里给示范昵称 Jove 选用写法 ジョーブ。名字后接 です，就能礼貌介绍自己；语境清楚时不必每次加“我”。私はジョーブです（我是乔布）也可以，不因为有无“我”就判错。现在直接点名字块和 です 即可，不要求认识片假名或输入日语。ジョー 中的长音和 です 的自然读法要跟核对过的声音学习，罗马字只作临时辅助。',
    },
    recognition: {
      promptZh: '按照刚才的示范，ジョーブです 是在做什么？',
      choices: [{ id: 'ask', textZh: '问对方叫什么' }, { id: 'introduce', textZh: '告诉对方自己叫乔布' }],
      answerId: 'introduce', explanationZh: '这是报自己的名字。日语在这里可以不说“我”，不是漏写主语就一定错误。',
    },
    scaffold: {
      promptZh: '先点两个词块，礼貌地介绍自己是乔布。',
      pieces: ['ジョーブ', 'です。'], answer: 'ジョーブです。',
      explanationZh: '前面是名字，后面 です 保持礼貌。你可以先用示范昵称，不必为了输入真实姓名而卡住。',
    },
    expression: {
      promptZh: '第一次见到新同学，用示范昵称ジョーブ（乔布）礼貌介绍自己。先跟说或点选也可以。',
      reference: 'ジョーブです。',
      accepted: ['ジョーブです。', 'ジョーブです', '私はジョーブです。', 'わたしはジョーブです。', 'ジョーブといいます。', '私はジョーブといいます。'],
      errors: [
        { input: 'ジョーブます。', feedbackZh: '名字已经说出来了。名字后面用 です，不直接接 ます；只换最后一块再试。', corrected: 'ジョーブです。' },
        { input: 'ジョーブですか。', feedbackZh: '句尾的 か 把它变成了问题。这次是告诉对方自己的名字，不用加 か。', corrected: 'ジョーブです。' },
        { input: 'ジョーブだ。', feedbackZh: '这不是任何情况下都错，但语气较随意。这次初次见面用礼貌的 です 更合适。', corrected: 'ジョーブです。' },
      ],
    },
    transfer: [
      { id: 'ja-starter-2-group', promptZh: '第一次参加兴趣小组，用昵称ジョーブ（乔布）礼貌介绍自己。', reference: 'ジョーブです。', accepted: ['ジョーブです。', '私はジョーブです。', 'ジョーブといいます。'],
        meaningZh: "我是乔布。（礼貌的姓名介绍）", explanationZh: "轮到你介绍自己，直接用名字加 です 即可。情境清楚时省略“我”很自然；加 私は 或换成 といいます 也可以。", romaji: "Jōbu desu" },
      { id: 'ja-starter-2-desk', promptZh: '旅馆前台要确认你是谁，你用昵称ジョーブ（乔布）礼貌报自己的名字。', reference: 'ジョーブです。', accepted: ['ジョーブです。', 'わたしはジョーブです。', '私はジョーブです。'],
        meaningZh: "我是乔布。（礼貌的姓名介绍）", explanationZh: "前台问的是你是谁，所以这次报自己的名字，不是在问工作人员名字。ジョーブ 后接 です 保持礼貌；不用为了补主语而卡住。", romaji: "Jōbu desu" },
      { id: 'ja-starter-2-call', promptZh: '第一次线上见新搭档，礼貌告诉对方你叫ジョーブ（乔布）。', reference: 'ジョーブです。', accepted: ['ジョーブです。', 'ジョーブといいます。', '私はジョーブといいます。'],
        meaningZh: "我是乔布。（礼貌的姓名介绍）", explanationZh: "线上初次见面也能用名字加 です 介绍自己。这里只给一条很短的姓名介绍，不要求额外背长篇自我介绍。", romaji: "Jōbu desu" },
    ],
    sound: pendingSound('ja', 'ja-starter-2'),
  },
  {
    id: 'ja-starter-3', language: 'ja', version: 1, position: 3,
    titleZh: '感谢别人，也能回应感谢', goalZh: '得到帮助时会说谢谢；别人感谢你时知道如何简单回应。',
    prerequisites: ['ja-starter-2'], minutes: { quick: 5, standard: 10 },
    model: {
      text: 'ありがとうございます。', meaningZh: '谢谢你。（礼貌）', reading: 'ありがとうございます', romaji: 'arigatō gozaimasu',
      explanationZh: '先学这一整句礼貌感谢，适合对不熟悉的人说。熟朋友之间可以说短一些的 ありがとう；どうもありがとうございます 是更强调的感谢。再认识一个回应：どういたしまして（不用谢），或轻声说 いえいえ（没事、不用客气）。不要对所有感谢机械套长句；这些是回应别人的感谢，不是代替你向别人道谢。先听示范、点词块，不要求懂汉字读音或自己打字；罗马字中的 ō 只是临时长音提示。',
    },
    recognition: {
      promptZh: '工作人员帮你拿到了东西，你想礼貌感谢，应该表达哪种意思？',
      choices: [{ id: 'thanks', textZh: '谢谢你' }, { id: 'reply', textZh: '不用谢——你在回应别人感谢你' }],
      answerId: 'thanks', explanationZh: '这次是你得到了帮助，用 ありがとうございます 向对方道谢。回应句要在别人感谢你时使用。',
    },
    scaffold: {
      promptZh: '先点词块，向帮助你的工作人员礼貌说谢谢。',
      pieces: ['ありがとう', 'ございます。'], answer: 'ありがとうございます。',
      explanationZh: '先组合一整句感谢。然后可以再听回应“不用谢”，不用一次背很多套话。',
    },
    expression: {
      promptZh: '不熟悉的工作人员帮你拿到了东西，用一句礼貌日语感谢对方。',
      reference: 'ありがとうございます。',
      accepted: ['ありがとうございます。', 'ありがとうございます', 'どうもありがとうございます。', 'どうもありがとうございます'],
      errors: [
        { input: 'ありがとうです。', feedbackZh: '谢谢的意思有了。这里用固定的礼貌句 ありがとうございます，不把末尾换成 です。', corrected: 'ありがとうございます。' },
        { input: 'ありがとうございますか。', feedbackZh: '这是直接感谢，不是在提问；把句尾的 か 去掉就好。', corrected: 'ありがとうございます。' },
        { input: 'どういたしまして。', feedbackZh: '这句话是回应别人感谢你时的“不用谢”。现在是你得到了帮助，换成“谢谢你”。', corrected: 'ありがとうございます。' },
      ],
    },
    transfer: [
      { id: 'ja-starter-3-shop', promptZh: '店员把你需要的东西递给你，礼貌说谢谢。', reference: 'ありがとうございます。', accepted: ['ありがとうございます。', 'どうもありがとうございます。'],
        meaningZh: "谢谢你。（礼貌）", explanationZh: "是店员帮了你，所以由你向店员道谢。用 ありがとうございます 表示礼貌感谢；这时不是回应别人感谢你，不用“不用谢”。", romaji: "arigatō gozaimasu" },
      { id: 'ja-starter-3-friend', promptZh: '熟朋友借给你一支笔，你轻松说声谢谢；礼貌说法也可以。', reference: 'ありがとう。', accepted: ['ありがとう。', 'ありがとう', 'ありがとうございます。', 'どうもありがとう。'],
        meaningZh: "谢谢。（熟人之间的轻松说法）", explanationZh: "熟朋友帮了你，可以轻松说 ありがとう。这句短示范没有 ございます；完整礼貌句也可以，但不要把短句解释成“不用谢”。", romaji: "arigatō" },
      { id: 'ja-starter-3-reply', promptZh: '你刚帮别人拿了东西，对方对你说“谢谢”。简短回应“不用谢”即可。', reference: 'どういたしまして。', accepted: ['どういたしまして。', 'どういたしまして', 'いえいえ。', 'いえいえ', 'いえ、どういたしまして。'],
        meaningZh: "不用谢。", explanationZh: "你帮了对方，对方先道谢；现在你是在回答别人的道谢，不是向对方说谢谢。どういたしまして 表示“不用谢”，也可以轻声说 いえいえ（不用客气），不必每次机械套长句。", romaji: "dō itashimashite" },
    ],
    sound: pendingSound('ja', 'ja-starter-3'),
  },
])

/** Unknown IDs are not silently replaced by another language's lesson. */
export const starterLessons: readonly StarterLesson[] = freezeContent([
  ...starterEntryLessons, ...englishContinuingLessons, ...japaneseContinuingLessons,
])

export function starterLesson(id: string): StarterLesson | undefined {
  return starterLessons.find(lesson => lesson.id === id)
}

type FixtureRow = readonly [input: string, expected: StarterFeedbackVerdict, feedbackZh: string, corrected?: string, promptZh?: string]

function fixtures(lessonId: string, promptZh: string, rows: readonly FixtureRow[]): StarterFeedbackFixture[] {
  const lesson = starterLesson(lessonId)
  if (!lesson) throw new Error(`Unknown starter lesson: ${lessonId}`)
  return rows.map(([input, expected, feedbackZh, corrected, casePromptZh], index) => ({
    id: `${lessonId}-feedback-${String(index + 1).padStart(2, '0')}`,
    lessonId, language: lesson.language, promptZh: casePromptZh ?? promptZh, input, expected, feedbackZh,
    ...(corrected === undefined ? {} : { corrected }),
  }))
}

/**
 * Exactly 50 cases per language. Each row has an authored context and expectation;
 * no live model generated or scored these results. Accepted examples are not an
 * exhaustive whitelist. Clarify cases must not be reported as pronunciation errors.
 */
export const starterFeedbackFixtures: readonly StarterFeedbackFixture[] = freezeContent([
  ...fixtures('en-starter-1', '第一次见面，用英语打招呼并介绍自己叫 Jove。', [
    ["Hi, I'm Jove.", 'accept', '打招呼和介绍名字都清楚，缩写自然。'],
    ['Hi, I am Jove.', 'accept', 'I am 和 I’m 意思相同，不必强制缩写。'],
    ["Hello, I'm Jove.", 'accept', 'Hello 也能打招呼。'],
    ['Hello, I am Jove.', 'accept', '完整形式可以使用。'],
    ['Hi, my name is Jove.', 'accept', '用 my name is 介绍姓名同样合理。'],
    ['Hello, my name is Jove.', 'accept', '不应因为换了句型就判错。'],
    ['Hey, I’m Jove.', 'accept', '对新同伴的轻松招呼可以用 Hey，弯引号不改变意思。'],
    ['Hi! My name is Jove.', 'accept', '拆成两句仍完成任务。'],
    ["Hi there, I'm Jove.", 'accept', 'Hi there 是自然的轻松招呼。'],
    ['hi im jove', 'accept', '当作口语核对文本时，大小写和漏掉撇号不应掩盖清楚的意思；书写形式可另作提示。'],
    ['Hi, I Jove.', 'repair', '意思可理解；I 后补 am，再说一遍。', "Hi, I'm Jove."],
    ['Hello, I is Jove.', 'repair', '说自己用 I am，不用 I is。', 'Hello, I am Jove.'],
    ['Hi, my name Jove.', 'repair', '姓名前补 is。', 'Hi, my name is Jove.'],
    ['Hi, me is Jove.', 'repair', '这个介绍句用 I am。', "Hi, I'm Jove."],
    ["Hello, I'm name Jove.", 'repair', '先用 I’m 直接接名字，不要混合两个句型。', "Hello, I'm Jove."],
    ['Hi, you are Jove.', 'clarify', '句子是在说对方叫 Jove。你是想介绍自己还是确认对方？'],
    ['Hello.', 'clarify', '招呼已经有了；还需要知道你如何介绍自己的名字。'],
    ['你好，我是乔布。', 'clarify', '中文意思正确。可以先点英语词块试一次，不把中文提交算作英语表达。'],
  ]),
  ...fixtures('en-starter-2', '你在等 Jove，用英语确认面前的人是不是 Jove。', [
    ['Are you Jove?', 'accept', '这是清楚的名字确认。'],
    ['Hi, are you Jove?', 'accept', '先招呼再确认很自然。'],
    ['Hello, are you Jove?', 'accept', 'Hello 不影响确认名字。'],
    ["You're Jove, right?", 'accept', '这种确认方式自然，不必强制 Are you。'],
    ['You are Jove, right?', 'accept', '非缩写形式仍可以确认。'],
    ['Is your name Jove?', 'accept', '直接确认姓名也符合任务。'],
    ["You're Jove?", 'accept', '在这个确认情境里可以用陈述结构提问；文字不能评判实际语调。'],
    ['You’re Jove, aren’t you?', 'accept', '反意确认问句可用，不需零基础者模仿这个难度。'],
    ['Is you Jove?', 'repair', 'you 配 are，先换开头。', 'Are you Jove?'],
    ['Are your Jove?', 'repair', '这里指“你”，用 you，不用 your。', 'Are you Jove?'],
    ['Are you name Jove?', 'repair', 'Are you 之后直接放名字。', 'Are you Jove?'],
    ['Do you are Jove?', 'repair', '这个问句用 Are you，不再加 Do。', 'Are you Jove?'],
    ['Are you is Jove?', 'repair', '不要再加 is，Are you 已经构成开头。', 'Are you Jove?'],
    ["What's your name?", 'clarify', '这是询问未知姓名，语法没有错；本题想确认已知名字 Jove。'],
    ['Are you Aki?', 'clarify', '问句结构可以，但确认了另一个名字；请核对你想找的人。'],
    ['Yes, I am.', 'clarify', '这是回答确认问题；本题需要由你向对方提问。'],
  ]),
  ...fixtures('en-starter-3', '对方可以给你拿饮用水，用英语礼貌表达想要水；可以用自然短句。', [
    ['I need water, please.', 'accept', '需要的东西和礼貌请求都清楚。'],
    ['I need some water, please.', 'accept', 'some water 是自然表达。'],
    ['Water, please.', 'accept', '实际请求中短句足够，不必强制主谓完整。'],
    ['A water, please.', 'accept', '点饮用水时 a water 可以指一份水，不应一概判成冠词错误。'],
    ["I'd like some water, please.", 'accept', 'I’d like 是合理的请求方式。'],
    ['I would like some water, please.', 'accept', '非缩写形式同样合理。'],
    ['Can I have some water, please?', 'accept', '问题形式也能礼貌提出请求。'],
    ['Could I have some water, please?', 'accept', '这种自然礼貌请求不应被参考句限制。'],
    ['I needs water, please.', 'repair', 'I 后用 need，不加 s。', 'I need water, please.'],
    ['I am need water.', 'repair', 'need 前不用 am。', 'I need water, please.'],
    ['Me need water.', 'repair', '这个句型用 I 作主语。', 'I need water, please.'],
    ['I needing water, please.', 'repair', '先用简单的 I need，不只放 needing。', 'I need water, please.'],
    ['I need to water, please.', 'repair', 'water 在这里是需要的东西，直接接在 need 后。', 'I need water, please.'],
    ['I need milk, please.', 'clarify', '句子本身可用，但本题需要的是水，不是牛奶；先确认意图。'],
    ["I don't need water.", 'clarify', '这句话表示不需要水，不能因为含 water 就判断完成了请求。'],
    ['water name hello', 'clarify', '只有零散词，无法确定请求；先用一个给出的词块组合。'],
  ]),
  ...fixtures('ja-starter-1', '早上见到老师或不熟悉的工作人员，用日语礼貌说早上好。', [
    ['おはようございます。', 'accept', '符合早上和礼貌的情境。'],
    ['おはようございます', 'accept', '少了句号不影响沟通。'],
    ['先生、おはようございます。', 'accept', '先称呼老师也自然。'],
    ['おはようございます！', 'accept', '感叹号不改变招呼意思。'],
    ['おはよう　ございます。', 'accept', '词块间的空格不应变成语言能力失败。'],
    ['おはようございます、先生。', 'accept', '招呼之后补称呼可以理解，不必只接受一种顺序。'],
    ['みなさん、おはようございます。', 'accept', '向在场的人一起打招呼也符合礼貌晨间情境。'],
    ['おはようございます、ジョーブです。', 'accept', '先问好再介绍名字，不因有额外正确信息判错。'],
    ['おはようです。', 'repair', '固定礼貌招呼使用 ございます。', 'おはようございます。'],
    ['おはよございます。', 'repair', '核对后的文字中少了 う；这是文字修正，不是发音评分。', 'おはようございます。'],
    ['おはようござます。', 'repair', '核对后的文字中 ござ 后补 い。', 'おはようございます。'],
    ['おはよう。', 'repair', '熟朋友之间没有错；本题对老师或不熟的人用完整礼貌句。', 'おはようございます。'],
    ['おはようございますです。', 'repair', '句尾不再追加 です。', 'おはようございます。'],
    ['こんにちは。', 'clarify', '这是白天问好，并非语法错误；本题指定早上，先核对时间。'],
    ['ありがとうございます。', 'clarify', '这是感谢句。本题是在早上见面，不是道谢。'],
    ['早上好。', 'clarify', '中文意思正确，可以先跟着日语示范或点词块，不计作独立日语表达。'],
  ]),
  ...fixtures('ja-starter-2', '初次见面，使用本课示范昵称ジョーブ（乔布）礼貌介绍自己。', [
    ['ジョーブです。', 'accept', '语境清楚时省略“我”是自然的。'],
    ['ジョーブです', 'accept', '少句号不妨碍介绍。'],
    ['私はジョーブです。', 'accept', '说出主语也可以，不强制省略。'],
    ['わたしはジョーブです。', 'accept', '平假名和汉字写法都可。'],
    ['ジョーブといいます。', 'accept', '这也是自然的礼貌姓名介绍。'],
    ['私はジョーブといいます。', 'accept', '自然替代表达，不要求额外学习才准通过。'],
    ['はじめまして、ジョーブです。', 'accept', '增加初次见面的招呼合理，不能因不等于示范而判错。'],
    ['ジョーブ　です。', 'accept', '姓名和句尾间的空格不影响意思。'],
    ['ジョーブと申します。', 'accept', '更郑重的姓名介绍也可，不把这个难度当必备知识。'],
    ['わたしは、ジョーブといいます。', 'accept', '停顿和不同文字形式不改变意思。'],
    ['ジョーブます。', 'repair', '名词名字后接 です，不直接接 ます。', 'ジョーブです。'],
    ['ジョーブですか。', 'repair', '现在要介绍自己，去掉把句子变为问题的 か。', 'ジョーブです。'],
    ['ジョーブだ。', 'repair', '随意语气不等于普遍错误；本题初次见面改用礼貌的 です。', 'ジョーブです。'],
    ['私はのジョーブです。', 'repair', '这里不用在 は 后再接 の，先去掉这个 の。', '私はジョーブです。'],
    ['私をジョーブです。', 'repair', '这个介绍结构先用 私は，或直接省略主语。', 'ジョーブです。'],
    ['あなたはジョーブです。', 'clarify', '说的是对方，不是介绍自己；先确认你指谁。'],
    ['ジョーブではありません。', 'clarify', '这表示不是乔布，不能只因出现名字就判断完成自我介绍。'],
    ['リンです。', 'clarify', '介绍句可以用，但名字和本题示范不一致；若是你的真实名字，应确认后保留，而不是判语法错误。'],
  ]),
  ...fixtures('ja-starter-3', '不熟悉的工作人员把东西递给你，使用礼貌日语感谢对方。', [
    ['ありがとうございます。', 'accept', '完整礼貌感谢正好符合情境。'],
    ['どうもありがとうございます。', 'accept', '加强感谢也合理。'],
    ['ありがとうございます！', 'accept', '标点不同不影响感谢。'],
    ['ありがとう　ございます。', 'accept', '词块空格不妨碍理解。'],
    ['本当にありがとうございます。', 'accept', '更强调感谢，符合情境。'],
    ['助かりました。ありがとうございます。', 'accept', '增加“帮上忙了”的正确表达可以接受，不强制初学者使用。'],
    ['どういたしまして。', 'accept', '在回应别人感谢你的情境中可以说“不用谢”，不要求每次使用长句。', undefined, '你帮别人拿了东西，对方感谢你，用日语简单回应不用谢。'],
    ['いえいえ。', 'accept', '轻声表示不用客气是自然回应，不强制套用完整句。', undefined, '你帮别人拿了东西，对方感谢你，用日语简单回应不用谢。'],
    ['ありがとうです。', 'repair', '本课固定礼貌感谢用 ありがとうございます。', 'ありがとうございます。'],
    ['ありがとうございますか。', 'repair', '直接感谢不需要句尾提问的 か。', 'ありがとうございます。'],
    ['ありがとうござます。', 'repair', '核对后的文字少了 い；不推断实际录音的发音。', 'ありがとうございます。'],
    ['ありがとうございますです。', 'repair', '完整感谢句后不再加 です。', 'ありがとうございます。'],
    ['ありがとう。', 'repair', '熟朋友之间可以；这次是对不熟的工作人员，完整礼貌句更合适。', 'ありがとうございます。'],
    ['どういたしまして。', 'clarify', '这是回应别人感谢你；本题是你感谢工作人员，先确认方向。'],
    ['いえいえ。', 'clarify', '这可以回应感谢或表示客气，但不是本题你向对方道谢的句子。'],
    ['おはようございます！', 'clarify', '这是礼貌问早上好，不是感谢；句子本身没有语法问题。'],
  ]),
])
