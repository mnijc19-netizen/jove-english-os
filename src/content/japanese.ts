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
  gradedCheckedAt: Date.UTC(2026, 8, 19, 21, 38),
} as const
export interface JapaneseLesson {
  id: string; position: number; course: 'starter' | 'elementary01' | 'elementary02'; title: string; canDo: string
  phrase: string; reading: string; meaningZh: string
  grammarZh: string; soundZh: string; transferZh: string
}
// Short common language examples and authored transfer tasks. Grammar notes are
// specific to Japanese; the English exercise generator is not used here.
type LessonContent = Omit<JapaneseLesson, 'id' | 'position' | 'course'>
const lessons: LessonContent[] = [
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
// Authored examples follow the publisher's everyday themes, not copied lesson
// transcripts. Book labels describe the resources, never certify the learner.
const elementary1: LessonContent[] = [
  { title: '介绍现在的工作', canDo: '说明自己的工作和生活近况，再问对方一个问题。', phrase: 'ホテルで働いています。', reading: 'ほてるではたらいています', meaningZh: '我在酒店工作。', grammarZh: '这里「で」标记活动场所，「ています」说明持续的工作状态；别只按中文汉字猜意思。', soundZh: '把「ホテルで」连成有意义的一组，跟原声听停顿。', transferZh: '向新邻居介绍另一种工作或学习情况，再问问对方。' },
  { title: '聊喜欢做的事情', canDo: '谈兴趣的频率和偏好，并继续交流。', phrase: '休みの日はよく料理をします。', reading: 'やすみのひはよくりょうりをします', meaningZh: '休息日我经常做饭。', grammarZh: '「よく」在这里表示经常；「は」提出休息日这个话题，不逐字翻译成“是”。', soundZh: '「りょう」是两拍，别把「りょ」拆成两拍。', transferZh: '说说另一项休息日活动，再追问同伴多久做一次。' },
  { title: '介绍季节', canDo: '比较家乡和现居地的季节特点。', phrase: '春は暖かくなります。', reading: 'はるはあたたかくなります', meaningZh: '春天会变暖。', grammarZh: '「暖かい」变为「暖かくなる」表达变化，不是静态描述。', soundZh: '先听清「くなります」这个变化表达，再整句说。', transferZh: '比较两个城市的一个季节，说出一项变化。' },
  { title: '聊昨天的天气', canDo: '讲述天气变化以及对安排的影响。', phrase: '昨日は風が強かったです。', reading: 'きのうはかぜがつよかったです', meaningZh: '昨天风很大。', grammarZh: 'い形容词的礼貌过去式是「強かったです」，不把「です」直接改成「でした」。', soundZh: '「かった」里的促音留一拍，别读成「かた」。', transferZh: '说昨天另一种天气，再说你改了什么安排。' },
  { title: '介绍社区生活', canDo: '说明住处的优点和不方便之处。', phrase: 'この町は静かで、住みやすいです。', reading: 'このまちはしずかですみやすいです', meaningZh: '这个地方安静，住起来方便。', grammarZh: 'な形容词用「で」连接描述；「动词ます形去ます＋やすい」表示容易做。', soundZh: '「静かで」后可稍停顿，但整句意思保持连接。', transferZh: '给准备搬家的朋友介绍另一处的优点和一个限制。' },
  { title: '给别人指路', canDo: '按顺序说明路线，并确认对方理解。', phrase: '二つ目の角を右に曲がってください。', reading: 'ふたつめのかどをみぎにまがってください', meaningZh: '请在第二个拐角右转。', grammarZh: '「目」表示顺序；这里「を」标记转弯经过的位置，不把所有「を」都译成宾语。', soundZh: '重点听「二つ目」「右」；没听清先确认，不猜方向。', transferZh: '路线换成第三个拐角左转，给访客说明并确认。' },
  { title: '迟到时及时联系', canDo: '简短说明迟到原因和预计到达时间。', phrase: '電車が遅れているので、少し遅れます。', reading: 'でんしゃがおくれているのですこしおくれます', meaningZh: '电车晚点了，所以我会稍晚到。', grammarZh: '「ので」把情况和结果连接起来；联系别人时还要说明大概多久。', soundZh: '先按原因和结果两组听，再连起来说。', transferZh: '你被另一件事耽搁，向等你的人说明原因和到达时间。' },
  { title: '谈体验和经历', canDo: '询问对方是否有过某种经历并接着聊。', phrase: '着物を着たことがありますか。', reading: 'きものをきたことがありますか', meaningZh: '你穿过和服吗？', grammarZh: '「たことがある」问经历，不等于正在做，也不一定说明具体日期。', soundZh: '「着た」在这里读「きた」；同一汉字在不同词里读法会变。', transferZh: '换一项你感兴趣的体验，问对方并追问感想。' },
  { title: '请教词的读法', canDo: '请别人说明一个词怎么读、什么意思。', phrase: 'この漢字はどう読みますか。', reading: 'このかんじはどうよみますか', meaningZh: '这个汉字怎么读？', grammarZh: '「どう」在这里询问方法；认识中文字形仍要确认日语词中的读法。', soundZh: '「漢字」读「かんじ」，不要套普通话声调。', transferZh: '你看到一张不懂的告示，请人解释一个词，并复述确认。' },
  { title: '询问学习活动', canDo: '询问课程时间、地点和参加方式。', phrase: '土曜日のクラスに参加したいです。', reading: 'どようびのくらすにさんかしたいです', meaningZh: '我想参加周六的课程。', grammarZh: '「参加する」搭配「に」；日语「勉強」通常指学习，不是中文“勉强”。', soundZh: '星期读法整体记在日程里，不按单个汉字推测。', transferZh: '想参加另一项活动，询问时间和报名方法。' },
  { title: '一起准备聚餐', canDo: '商量谁带什么，说明自己的安排。', phrase: '私は飲み物を持っていきます。', reading: 'わたしはのみものをもっていきます', meaningZh: '我会带饮料过去。', grammarZh: '「持っていく」是带到别处去；「持ってくる」以说话场景的方向为参照。', soundZh: '「持って」里的「っ」占一拍；不要漏掉。', transferZh: '为另一次聚会分工，说你带什么，再确认对方的安排。' },
  { title: '描述食物并回应', canDo: '表达对食物的印象，询问做法或原料。', phrase: 'このスープはおいしそうですね。', reading: 'このすーぷはおいしそうですね', meaningZh: '这碗汤看起来很好喝呢。', grammarZh: '「おいしそう」是根据外观判断，不是已尝过的事实；和听说的「そう」分开理解。', soundZh: '「スープ」长音保留；「ね」用来邀请回应，不是机械尾音。', transferZh: '看到朋友做的另一道菜，表达印象并问一个问题。' },
  { title: '报告工作进度', canDo: '说明大致需要多久，并确认后续安排。', phrase: 'あと五分ぐらいで終わります。', reading: 'あとごふんぐらいでおわります', meaningZh: '大约再过五分钟就结束。', grammarZh: '「あと」表示还需多久，「ぐらい」表达估计；不是精确承诺。', soundZh: '分钟读法随数字变化，先记实际要用的组合。', transferZh: '同事问另一件事何时完成，给出估计并确认下一步。' },
  { title: '请求调整工作安排', canDo: '向负责人提出请假或调班请求并说明情况。', phrase: '明日、少し早く帰ってもいいですか。', reading: 'あしたすこしはやくかえってもいいですか', meaningZh: '明天可以稍微早点回去吗？', grammarZh: '「てもいいですか」请求许可；需要看对象，不能只靠加「です」就当作任何场合都得体。', soundZh: '「帰って」留促音；整句说完再听对方回应。', transferZh: '因个人安排需要改变时间，向负责人请求并协商替代方案。' },
  { title: '描述身体不适', canDo: '向工作人员说明哪里不舒服、从何时开始。', phrase: '昨日から頭が痛いです。', reading: 'きのうからあたまがいたいです', meaningZh: '从昨天开始头痛。', grammarZh: '「から」给出开始时间；这是语言表达练习，不根据例句诊断或推荐治疗。', soundZh: '先说清身体部位和时间；紧张时也允许慢慢重复。', transferZh: '模拟向接待人员描述另一种不适及开始时间，不作自我诊断。' },
  { title: '聊日常习惯', canDo: '说出为生活习惯所做的具体尝试。', phrase: '毎日、少し歩くようにしています。', reading: 'まいにちすこしあるくようにしています', meaningZh: '我尽量每天走一走。', grammarZh: '「ようにしている」表示有意识地保持习惯，不等于每一天都毫无例外。', soundZh: '把「ようにしています」当作一组听，别逐字硬切。', transferZh: '介绍另一项你想保持的习惯，并问朋友的方法。' },
  { title: '讲一件物品的来历', canDo: '介绍别人送的东西和相关经历。', phrase: 'これは友達にもらった本です。', reading: 'これはともだちにもらったほんです', meaningZh: '这是朋友送给我的书。', grammarZh: '修饰名词的句子放在「本」前；「もらう」从接受者角度表达。', soundZh: '「もらった本」连成修饰组；促音不要吞掉。', transferZh: '介绍另一件有意义的物品，说是谁给你的以及你的感受。' },
  { title: '一起商量礼物', canDo: '提出建议，听取别人的意见并共同决定。', phrase: 'お茶をあげるのはどうですか。', reading: 'おちゃをあげるのはどうですか', meaningZh: '送茶怎么样？', grammarZh: '「のはどうですか」把建议留给对方回应；授受表达要留意双方关系。', soundZh: '「ちゃ」一拍；听建议语气，不只模仿孤立单词。', transferZh: '为另一位朋友选礼物，给出建议和理由，并回应不同意见。' },
]
const elementary2: LessonContent[] = [
  { title: '说明最近的变化', canDo: '介绍最近发生的变化和现在的生活。', phrase: '先月、この町に引っ越してきました。', reading: 'せんげつこのまちにひっこしてきました', meaningZh: '上个月我搬到这个地方来了。', grammarZh: '「てきました」从现在所在的位置看移动；不要只按中文“来”逐词套用。', soundZh: '「引っ越す」读「ひっこす」，促音单占一拍。', transferZh: '向新认识的人说一项近期变化，再问对方住了多久。' },
  { title: '介绍认识的人', canDo: '描述人的特点并给出具体例子。', phrase: '田中さんはいつも丁寧に説明してくれます。', reading: 'たなかさんはいつもていねいにせつめいしてくれます', meaningZh: '田中先生／女士总是耐心地给我解释。', grammarZh: '「てくれる」从受益者一方表达别人做的事；不是把中文“给”机械插入所有句子。', soundZh: '姓名读法不凭汉字猜；遇到不确定的姓名要向本人确认。', transferZh: '介绍另一位帮助过你的人，说一件具体的事。' },
  { title: '说明不能吃的食物', canDo: '向店员说明饮食限制并确认配料。', phrase: '卵が入っていますか。', reading: 'たまごがはいっていますか', meaningZh: '里面有鸡蛋吗？', grammarZh: '「入っている」表示含有；涉及真实过敏时应明确说明并请店方确认，不能靠语言练习猜测安全性。', soundZh: '先把关键配料说清楚，再确认对方回答中的有／没有。', transferZh: '模拟询问另一种配料，说明不能吃并再次确认。' },
  { title: '理解吃法说明', canDo: '听懂做法顺序和简短建议，再确认细节。', phrase: 'よく混ぜてから食べてください。', reading: 'よくまぜてからたべてください', meaningZh: '请拌匀以后再吃。', grammarZh: '「てから」标记先后顺序；「ないで」表示不做前一动作，意思不同。', soundZh: '重点抓两个动作以及它们的先后，不只听熟悉名词。', transferZh: '向朋友说明另一种食物的吃法，并回答一个疑问。' },
  { title: '为出行提出建议', canDo: '比较出行方案，给出理由和建议。', phrase: '切符は先に買ったほうがいいですよ。', reading: 'きっぷはさきにかったほうがいいですよ', meaningZh: '车票最好先买好。', grammarZh: '「たほうがいい」表达建议，不等于已经做过；语气强度需看关系和场合。', soundZh: '「きっぷ」和「買った」各有促音，分组听后完整说。', transferZh: '朋友换了目的地，比较两个方案并给一条有理由的建议。' },
  { title: '分享旅行感受', canDo: '讲一次出行的好事和遗憾。', phrase: '景色がきれいで、写真をたくさん撮りました。', reading: 'けしきがきれいでしゃしんをたくさんとりました', meaningZh: '景色很美，我拍了很多照片。', grammarZh: '用连接形式组织经历，不必每句话都重复「私は」；主语省略要让对方能理解。', soundZh: '长句先按两段意思听，再减少中间不必要的停顿。', transferZh: '说一次不同出行的两件事，再回应同伴的追问。' },
  { title: '确认活动是否变更', canDo: '理解条件和替代安排，并向别人转述。', phrase: '雨が降ったら、中でやります。', reading: 'あめがふったらなかでやります', meaningZh: '如果下雨，就在室内进行。', grammarZh: '「たら」在这里表达条件，不是已经下雨的事实；同时说明替代地点。', soundZh: '别漏听条件结尾「たら」，否则会把可能安排当成已确定。', transferZh: '为另一场活动说明一种条件及对应的替代安排。' },
  { title: '询问活动中的位置', canDo: '询问信息点或设施在哪里，并解释需求。', phrase: '受付がどこにあるか知っていますか。', reading: 'うけつけがどこにあるかしっていますか', meaningZh: '你知道接待处在哪里吗？', grammarZh: '嵌入的问题用「か」收束，再接「知っていますか」；不是重复两个完整独立问句。', soundZh: '「どこにあるか」作为一组听，理解问题边界。', transferZh: '到另一个活动现场，询问你需要的设施并说明原因。' },
  { title: '谈节庆习惯', canDo: '说明某个节日通常做什么，并比较习惯。', phrase: 'お正月には、家族で集まります。', reading: 'おしょうがつにはかぞくであつまります', meaningZh: '新年时家人会聚在一起。', grammarZh: '习惯表达说明你知道的具体情境，不把个人经验概括为所有人的规矩。', soundZh: '「しょう」有两拍，不能按中文字数来算节奏。', transferZh: '介绍自己熟悉的节日习惯，再问对方家庭的做法。' },
  { title: '请教场合礼仪', canDo: '询问不熟悉场合的做法和注意事项。', phrase: '何を持っていけばいいですか。', reading: 'なにをもっていけばいいですか', meaningZh: '我带什么过去比较好？', grammarZh: '「ばいいですか」寻求建议；不懂当地或对方家的规矩时，询问比猜测可靠。', soundZh: '留意「いけば」的条件形式，再听建议中的关键物品。', transferZh: '第一次参加另一种聚会，请教服装或携带物品并确认。' },
  { title: '购物时处理小问题', canDo: '说明遗忘或出错，请求可行的处理方式。', phrase: '財布を忘れてしまいました。', reading: 'さいふをわすれてしまいました', meaningZh: '我把钱包忘带了。', grammarZh: '「てしまった」在这里带遗憾意味；说明问题后还要询问下一步。', soundZh: '日常口语可能出现缩略，先听懂原声里的完整和缩略形式，不要求一开始就模仿。', transferZh: '模拟购物中的另一项小失误，解释并商量解决办法。' },
  { title: '比较商品特点', canDo: '结合需要比较两件商品并说明选择。', phrase: 'こちらのほうが軽くて、使いやすいです。', reading: 'こちらのほうがかるくてつかいやすいです', meaningZh: '这个更轻，也更好用。', grammarZh: '「ほうが」要有可理解的比较对象；表达选择理由，不只罗列形容词。', soundZh: '听清比较的是哪一件，尤其留意「こちら／そちら」。', transferZh: '为不同需求比较两个物品，说明为什么不选另一件。' },
  { title: '理解公共设施说明', canDo: '询问设施开放时间、规则和可使用的服务。', phrase: 'ここでは写真を撮ってもいいですか。', reading: 'ここではしゃしんをとってもいいですか', meaningZh: '这里可以拍照吗？', grammarZh: '许可和禁止需根据现场规则确认；「てもいい」与「てはいけない」不能混淆。', soundZh: '重点听否定和限制条件，不只听到「いい」就行动。', transferZh: '在另一处设施询问一项活动是否允许，并复述限制。' },
  { title: '把服务需求说具体', canDo: '说明希望如何调整，并确认结果。', phrase: 'もう少し短くしてください。', reading: 'もうすこしみじかくしてください', meaningZh: '请再短一点。', grammarZh: '「い形容词→く＋する」表示把事物变成某种状态；用程度词说清要改多少。', soundZh: '「もう少し」表达小幅调整，不必加重每个音。', transferZh: '模拟一项不同服务，说明具体希望和不希望的改变。' },
  { title: '提醒忘记处理的事情', canDo: '指出还没处理的情况，并商量谁来做。', phrase: '窓が開いたままですよ。', reading: 'まどがあいたままですよ', meaningZh: '窗户还开着呢。', grammarZh: '「まま」说明状态保持未变；「開く」和「開ける」要分清发生变化与人执行动作。', soundZh: '连起来听状态与提醒语气，不用责备口吻机械套句。', transferZh: '发现另一件事情没有收尾，礼貌提醒并提出处理方式。' },
  { title: '听懂紧急指引', canDo: '抓住地点和动作信息，不懂时立即确认。', phrase: 'あわてないで、係の人の話を聞いてください。', reading: 'あわてないでかかりのひとのはなしをきいてください', meaningZh: '请不要慌张，听工作人员的说明。', grammarZh: '「ないで」在这里表达不要做；真实紧急情况遵从现场专业人员指引，本练习不是安全处置教程。', soundZh: '先辨认不要做什么、要做什么；可以请求工作人员重复。', transferZh: '模拟听到一项场所指引，复述关键地点和动作，再确认不懂的部分。' },
  { title: '谈逐渐会做的事', canDo: '说明以前和现在的差别，并给出具体例子。', phrase: '一人で買い物ができるようになりました。', reading: 'ひとりでかいものができるようになりました', meaningZh: '我渐渐能独自购物了。', grammarZh: '「ようになった」表达变化；说明真实能完成的任务，不用课程完成数代替能力。', soundZh: '在熟悉表达里减少逐字停顿，再用新例子检验是否真能说出。', transferZh: '讲一项你有实际证据的变化，并说仍需要帮助的地方。' },
  { title: '讨论下一步打算', canDo: '表达计划、原因和仍未确定的部分。', phrase: '来年、新しい仕事を探そうと思っています。', reading: 'らいねんあたらしいしごとをさがそうとおもっています', meaningZh: '我打算明年找一份新工作。', grammarZh: '「意向形＋と思っている」表达计划；已决定、正在考虑和愿望的确定程度不一样。', soundZh: '先讲清计划，再连上理由，不为追求快而吞掉词尾。', transferZh: '换一个未来计划，说明理由、一个不确定因素并听取建议。' },
]
function courseLessons(content: LessonContent[], course: JapaneseLesson['course']): JapaneseLesson[] {
  return content.map((lesson, index) => ({ ...lesson, course, position: index + 1, id: `ja-irodori-${course}-${index + 1}` }))
}
export const japaneseStarterLessons = courseLessons(lessons, 'starter')
export const japaneseLessons = [...japaneseStarterLessons, ...courseLessons(elementary1, 'elementary01'), ...courseLessons(elementary2, 'elementary02')]
export const japaneseCourseNames = { starter: '入门 · A1 教材', elementary01: '初级 1 · A2 教材', elementary02: '初级 2 · A2 教材' } as const
export function japaneseLessonUrl(lesson: JapaneseLesson): string {
  return `https://www.irodori.jpf.go.jp/en/${lesson.course}/audio/lesson${String(lesson.position).padStart(2, '0')}.html`
}
function materialsFor(selected: JapaneseLesson[]): Material[] {
  return selected.map(lesson => ({
    id: lesson.id, language: 'ja', title: lesson.title, topic: '生活日语', difficulty: lesson.course === 'starter' ? 0.1 + (lesson.position - 1) * 0.025
      : (lesson.course === 'elementary01' ? 0.53 : 0.72) + (lesson.position - 1) * 0.01,
    duration: 0, transcript: '', sentences: [], sourceKind: 'url', sourceLabel: japaneseSource.publisher,
    sourceUrl: japaneseLessonUrl(lesson),
    license: 'Publisher playback links only; app examples and prompts are original, not publisher transcripts.', synthetic: false, approved: true,
    question: lesson.canDo, answer: '', keywords: [], createdAt: lesson.course === 'starter' ? japaneseSource.checkedAt : japaneseSource.gradedCheckedAt,
    chunks: [{ text: lesson.phrase, meaningEn: '', meaningZh: lesson.meaningZh, example: lesson.phrase }],
    externalStudy: { publisher: japaneseSource.publisher, level: lesson.course === 'starter' ? 'beginner' : 'intermediate', mission: `先听原站的一段对话，再说明意思。${lesson.canDo}随后录音：${lesson.transferZh}`, checkedAt: lesson.course === 'starter' ? japaneseSource.checkedAt : japaneseSource.gradedCheckedAt },
  }))
}
export function japaneseStarterMaterials(): Material[] {
  return materialsFor(japaneseStarterLessons)
}
export function japaneseMaterials(): Material[] { return materialsFor(japaneseLessons) }
