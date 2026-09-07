import type { Material } from '../domain/types'

// Editorial difficulty: 0 (simpler) to 1 (more demanding), not a CEFR rating.
// Every script is original project content, reviewed for meaning/chunk alignment.
// The bundled voice is synthetic; it is not a recording of a real conversation.
type DemoScript = Pick<Material, 'id' | 'title' | 'topic' | 'difficulty' | 'duration' | 'sentences' | 'translation' | 'question' | 'answer' | 'keywords' | 'chunks'>

const demo = (script: DemoScript): Material => ({
  ...script,
  transcript: script.sentences.join(' '),
  audioPath: `audio/${script.id}.wav`,
  sourceKind: 'curated',
  sourceLabel: 'Original reviewed demo / synthetic speech',
  license: 'Original project text; no third-party transcript',
  synthetic: true,
  approved: true,
  createdAt: Date.UTC(2026, 8, 7),
})

export const demoMaterials: Material[] = [
  demo({
    id: 'cafe-delay', title: 'A small change of plan', topic: 'Everyday life', difficulty: 0.25, duration: 22,
    sentences: [
      "Hi, I'm on my way to the cafe, but the bus is moving really slowly.",
      "I'm running late, so I should be there in about ten minutes.",
      'Go ahead and find us a table near the window.',
      "I haven't had lunch yet, so I'll order a sandwich when I arrive.",
      "If the cafe is full, let's meet at the bakery across the street instead.",
    ],
    translation: '嗨，我正在去咖啡馆的路上，但公交车开得很慢。我要晚到了，大概十分钟后能到。你先找张靠窗的桌子吧。我还没吃午饭，到了会点个三明治。如果咖啡馆满了，我们就改在街对面的面包店见。',
    question: 'What is the message mainly about, and what should the friend do now?',
    answer: 'The speaker is running late because the bus is slow. The friend should find a table at the cafe; they can meet at the bakery if the cafe is full.',
    keywords: ['late', 'bus', 'table', 'bakery'],
    chunks: [
      { text: 'on my way', meaningEn: 'travelling toward a place now; neutral everyday speech', meaningZh: '正在路上', example: "I'm on my way to the station; meet me by the ticket machines." },
      { text: 'running late', meaningEn: 'behind the planned time; neutral everyday speech', meaningZh: '晚了，赶不上原定时间', example: "I'm running late for our call; could we start at half past two?" },
      { text: 'go ahead', meaningEn: 'start without waiting, or give someone permission; friendly and informal', meaningZh: '先做吧；可以，做吧', example: 'Go ahead and start dinner; I will join you soon.' },
    ],
  }),
  demo({
    id: 'notification-reset', title: 'Make your phone quieter', topic: 'Technology', difficulty: 0.45, duration: 23,
    sentences: [
      'My phone kept lighting up while I was trying to finish a report.',
      'I decided to turn off shopping alerts but leave messages from my team on.',
      'Now I check the other apps after lunch, when I have a little more time.',
      "It helps me keep track of important messages without looking at every sale.",
      "I'm still trying to work out which settings are right for me.",
    ],
    translation: '我写报告时，手机总是亮起来。我决定关掉购物提醒，但保留团队的消息通知。现在我午饭后稍有空闲时再查看其他应用。这样既能留意重要消息，也不用每次促销都看。我还在摸索哪些设置最适合自己。',
    question: 'What change did the speaker make, and why?',
    answer: 'The speaker turned off shopping alerts but kept team messages on to reduce interruptions and keep track of important messages.',
    keywords: ['shopping', 'alerts', 'team', 'messages'],
    chunks: [
      { text: 'turn off', meaningEn: 'stop a device or feature from operating; neutral', meaningZh: '关闭', example: 'Please turn off the kitchen light before you leave.' },
      { text: 'keep track of', meaningEn: 'stay aware of information as it changes; neutral', meaningZh: '持续了解；跟踪记录', example: 'I use a small notebook to keep track of shared bills.' },
      { text: 'work out', meaningEn: 'understand or find a solution by thinking; neutral, especially common in British English', meaningZh: '弄明白；想出办法', example: 'We need to work out how to get home after the last train.' },
    ],
  }),
  demo({
    id: 'shared-kitchen', title: 'A fair plan for the kitchen', topic: 'Living abroad', difficulty: 0.4, duration: 22,
    sentences: [
      'Could we take turns cleaning the kitchen instead of waiting until the weekend?',
      "I'll clean it tonight, and you can do it tomorrow if that works for you.",
      'We also seem to run out of milk before either of us notices.',
      "If you add it to our shared list, I'll pick up a bottle on my way home.",
      "Let's keep the receipts so we can split the cost on Sunday.",
    ],
    translation: '我们能轮流打扫厨房，而不是一直等到周末吗？今晚我来打扫，如果你方便的话，明天就由你来。我们好像总是在谁都没注意时就把牛奶喝完了。你把牛奶加到共享清单里，我下班回家时就顺路买一瓶。我们把小票留着，周日再平摊费用。',
    question: 'What two shared-household problems does the speaker want to solve?',
    answer: 'The speaker wants to take turns cleaning the kitchen and use a shared list to buy milk, then split the cost using receipts.',
    keywords: ['cleaning', 'kitchen', 'milk', 'list'],
    chunks: [
      { text: 'take turns', meaningEn: 'do something one person after another; neutral', meaningZh: '轮流', example: 'We take turns choosing a film for Friday night.' },
      { text: 'run out of', meaningEn: 'have none of something left; neutral', meaningZh: '用完；耗尽', example: "Let's charge the phone before we run out of battery." },
      { text: 'pick up', meaningEn: 'collect or buy something while going somewhere; neutral everyday speech', meaningZh: '顺路取；顺便买', example: 'Could you pick up my parcel from reception?' },
    ],
  }),
  demo({
    id: 'lunch-order', title: 'Ask for the lunch you want', topic: 'Everyday life', difficulty: 0.25, duration: 24,
    sentences: [
      'Could I have the grilled chicken with the sauce on the side, please?',
      'I would also like a salad instead of the fries, if that is possible.',
      "I'm not sure whether the sauce is spicy, so could you check with the kitchen?",
      "There is no rush; I'm waiting for a friend who will be here soon.",
      "We'll order drinks together once she arrives, but you can put my food order through now.",
    ],
    translation: '请给我一份烤鸡，酱汁另放，可以吗？如果可以，我还想把薯条换成沙拉。我不确定酱汁辣不辣，你能帮我向厨房确认一下吗？不用着急；我在等一位很快就到的朋友。她到了以后我们一起点饮料，不过现在可以先帮我下餐点单。',
    question: 'How does the speaker want the meal changed, and what needs checking?',
    answer: 'The speaker wants sauce on the side and salad instead of fries, and asks the server to check whether the sauce is spicy.',
    keywords: ['sauce', 'side', 'salad', 'spicy'],
    chunks: [
      { text: 'on the side', meaningEn: 'served separately from the main food; neutral restaurant request', meaningZh: '另放，单独上', example: 'Could I get the dressing on the side?' },
      { text: 'instead of', meaningEn: 'in place of another option; neutral', meaningZh: '代替；而不是', example: 'Can we meet on Thursday instead of Wednesday?' },
      { text: 'check with', meaningEn: 'ask a person or group to confirm something; neutral', meaningZh: '向某人核实', example: 'I need to check with my manager before I change the schedule.' },
    ],
  }),
  demo({
    id: 'train-change', title: 'Check before you board', topic: 'Living abroad', difficulty: 0.45, duration: 24,
    sentences: [
      "Excuse me, I'm trying to get to the airport, and I think I'm on the wrong platform.",
      'The sign says this train only goes as far as Central Station.',
      'Do I need to get off there and change at Central for the airport train?',
      'I have a suitcase, so a route without too many stairs would really help.',
      'I just want to make sure I can use the ticket I already bought.',
    ],
    translation: '不好意思，我想去机场，但我觉得自己可能站错站台了。标牌上说这趟列车只到中央车站。我需要在那里下车，然后在中央车站换乘机场列车吗？我带着行李箱，所以如果路线不用走太多楼梯会很有帮助。我只是想确认一下，我已经买的票还能不能用。',
    question: 'What does the traveller need help confirming?',
    answer: 'The traveller needs to confirm the route and possible change at Central Station for the airport, and whether the existing ticket is valid.',
    keywords: ['airport', 'change', 'central', 'ticket'],
    chunks: [
      { text: 'get off', meaningEn: 'leave a bus, train, plane, or similar vehicle; neutral', meaningZh: '下车', example: 'Get off at the next stop and walk toward the library.' },
      { text: 'change at', meaningEn: 'switch to another service at a named place; neutral transport language', meaningZh: '在某处换乘', example: 'You can change at Riverside for the blue line.' },
      { text: 'make sure', meaningEn: 'check so that you know something is correct or will happen; neutral', meaningZh: '确保；确认', example: 'Please make sure the front door is locked.' },
    ],
  }),
  demo({
    id: 'team-demo', title: 'Clarify the next step at work', topic: 'Technology', difficulty: 0.65, duration: 24,
    sentences: [
      "I've managed to set up the new task board, but I'm not sure who can edit it.",
      'Could you walk me through the sharing settings before we invite the whole team?',
      'I want everyone to add updates without changing the project deadlines by mistake.',
      "If you are busy now, send me a time that works and I'll get back to you after lunch.",
      'We can test it with one colleague before the meeting tomorrow.',
    ],
    translation: '我已经设好了新的任务看板，但还不确定谁能编辑。邀请整个团队之前，你能带我过一遍共享设置吗？我希望大家都能添加进展，同时避免误改项目截止日期。如果你现在忙，可以发我一个方便的时间，我午饭后回复你。明天开会前，我们可以先找一位同事试用。',
    question: 'Why does the speaker want help before inviting the team?',
    answer: 'The speaker wants to check the sharing settings so colleagues can add updates without changing deadlines by mistake, then test the board with one colleague.',
    keywords: ['sharing', 'settings', 'updates', 'deadlines'],
    chunks: [
      { text: 'set up', meaningEn: 'prepare something so it is ready to use; neutral', meaningZh: '设置；准备好', example: 'Can you help me set up the projector for the workshop?' },
      { text: 'walk me through', meaningEn: 'explain the steps to me carefully; friendly professional or everyday speech', meaningZh: '带我逐步了解', example: 'Could you walk me through the rental application?' },
      { text: 'get back to you', meaningEn: 'contact you later with a reply or more information; neutral and professional', meaningZh: '稍后回复你', example: "I'll check the delivery date and get back to you this afternoon." },
    ],
  }),
]

export interface Mission {
  id: string; title: string; scene: string; opening: string; goals: string[]; topic: string
}

export const missions: Mission[] = [
  { id: 'stranger', title: 'Find the community library', topic: 'Everyday life', scene: 'You are new to the neighbourhood. Ask a passer-by for directions to the library; your phone is out of battery.', opening: 'Hi there. You look a little lost. Can I help?', goals: ['Ask politely where the library is.', 'Clarify one turn or landmark.', 'Repeat the route in your own words and thank the person.'] },
  { id: 'flatmate', title: 'Agree on a quieter evening', topic: 'Living abroad', scene: 'Your flatmate plays music late at night. You have an early shift, and you want a fair agreement.', opening: "Hey, is the music bothering you? I'm having a couple of friends over tonight.", goals: ['Explain your need without blaming your flatmate.', 'Suggest a specific quiet time or headphone option.', 'Respond to a different suggestion and confirm an agreement.'] },
  { id: 'restaurant', title: 'Change an unavailable lunch order', topic: 'Everyday life', scene: 'Order lunch in a cafe. Your first choice is unavailable; ask about another dish and a side.', opening: "Welcome! Just so you know, we've run out of the grilled chicken today. What would you like?", goals: ['Ask about an alternative and its ingredients.', 'Request one change politely.', 'Confirm the final order and price.'] },
  { id: 'shopping', title: 'Return a faulty desk lamp', topic: 'Everyday life', scene: 'A lamp you bought yesterday does not turn on. You have the receipt and would prefer a working replacement.', opening: 'Hello. What seems to be the problem with the lamp?', goals: ['Describe the fault and when you bought it.', 'Ask for a replacement and respond if it is unavailable.', 'Confirm the proposed next step and any wait.'] },
  { id: 'airport', title: 'Find a changed departure gate', topic: 'Living abroad', scene: 'Your flight gate has changed. Ask airport staff where to go and whether you still have time.', opening: 'Yes, the gate has changed to B twenty-four. Do you need a hand finding it?', goals: ['Confirm the gate and boarding time.', 'Ask for directions and how long the walk takes.', 'Check one unclear detail before leaving.'] },
  { id: 'transport', title: 'Get home after a cancellation', topic: 'Living abroad', scene: 'Your usual train is cancelled. Ask station staff for another route to Riverside using your existing ticket.', opening: "I'm afraid the next train to Riverside has been cancelled. Where are you trying to go?", goals: ['State your destination and ask for an alternative.', 'Check the transfer and whether your ticket works.', 'Summarise the route and expected arrival time.'] },
  { id: 'bank', title: 'Ask about an unexpected account fee', topic: 'Living abroad', scene: 'In a fictional bank visit, ask a clerk about an unexpected monthly fee. Use invented amounts; no account details are needed.', opening: 'Good morning. What would you like me to explain about the account?', goals: ['Describe the unexpected fee using an invented amount.', 'Ask when it applies and how to avoid it.', 'Confirm the next step without sharing credentials.'] },
  { id: 'landlord', title: 'Arrange a visit for a leaking tap', topic: 'Living abroad', scene: 'Your kitchen tap keeps dripping. Contact the landlord, describe what you observed, and arrange a repair visit.', opening: 'Hi, I got your message about the kitchen. What exactly is happening?', goals: ['Describe the problem and when it started.', 'Offer two possible times and discuss access.', 'Confirm who will visit and when you will hear back.'] },
  { id: 'work', title: 'Renegotiate a clashing deadline', topic: 'Technology', scene: 'Two work tasks are due this afternoon. Ask your manager which one matters most and propose a realistic plan.', opening: 'How are the report and the demo coming along? We were hoping to see both today.', goals: ['Explain the conflict and current progress clearly.', 'Ask which task has priority and offer a concrete plan.', 'Confirm the revised deliverables and times.'] },
  { id: 'interview', title: 'Explain how you solved a problem', topic: 'Technology', scene: 'You are in a practice job interview. Use a real non-sensitive example or a fictional project; explain your own contribution.', opening: 'Tell me about a time when a project did not go as planned. What did you do?', goals: ['Briefly set out the situation and your responsibility.', 'Explain one specific action and its result.', 'Answer a follow-up and describe what you learned.'] },
  { id: 'clarification', title: 'Check an unclear request', topic: 'Everyday life', scene: 'A volunteer coordinator has given a vague instruction. You need to know what to bring, where to go, and when.', opening: 'Could you bring those things over to the usual place a bit earlier tomorrow?', goals: ['Politely say which part is unclear.', 'Ask specific questions about the items, place, and time.', 'Restate the complete plan and ask for confirmation.'] },
  { id: 'social', title: 'Suggest a different weekend plan', topic: 'Everyday life', scene: 'A new friend invites you to an expensive concert. You would like to spend time together but prefer a cheaper plan.', opening: "A few of us are going to a concert on Saturday. It's quite pricey, but would you like to come?", goals: ['Respond warmly and explain your preference briefly.', 'Suggest a specific alternative activity and time.', 'Respond to the friend and settle the next step.'] },
  { id: 'living-abroad', title: 'Join a local community class', topic: 'Living abroad', scene: 'Ask at a community centre about joining an evening class. You are new in town and do not know the registration process.', opening: 'Welcome to the community centre. Are you looking for a particular class?', goals: ['Explain what you would like to learn and your available days.', 'Ask about cost, level, and what to bring.', 'Confirm how to register and the first meeting details.'] },
]

export interface AssessmentPrompt {
  id: string; listeningMaterialId: string; listening: string; retell: string; conversation: string; missionId: string
}

// Rotating tasks share the rubric below; they are not equated test forms.
export const assessmentPrompts: AssessmentPrompt[] = [
  { id: 'check-in-a', listeningMaterialId: 'cafe-delay', listening: 'Listen once without the transcript. Explain the problem, the immediate plan, and the backup plan.', retell: 'Without reading, leave a 45–60 second message about being delayed on your way to meet someone. Include the reason, an arrival estimate, and an alternative.', conversation: 'Plan a low-cost afternoon with a new friend. Ask about a preference, explain your own, and agree on a time and place.', missionId: 'social' },
  { id: 'check-in-b', listeningMaterialId: 'shared-kitchen', listening: 'Listen once without the transcript. Explain the two household problems and the proposed plan for each.', retell: 'Without reading, leave a 45–60 second message about organising a shared task. Include the problem, who will do what, and how to confirm it is done.', conversation: 'Plan a shared meal with a flatmate. Ask about a preference, explain your own, and agree on who will bring what and when.', missionId: 'flatmate' },
  { id: 'check-in-c', listeningMaterialId: 'team-demo', listening: 'Listen once without the transcript. Explain what is ready, what needs checking, and the proposed next step.', retell: 'Without reading, leave a 45–60 second message about a small work problem. Include what you tried, the help you need, and a time for the next step.', conversation: 'Plan a short practice session with a colleague. Ask about a preference, explain your own, and agree on a goal, time, and place.', missionId: 'work' },
]

export const assessmentRubric = {
  version: 'demo-1',
  dimensions: ['Meaning and key details', 'Task completion', 'Clarification and turn-taking', 'Intelligibility and continuity', 'Independent use of familiar chunks'],
  anchors: ['0: not demonstrated in this attempt', '1: partly demonstrated or needed help', '2: demonstrated independently'],
  limits: 'Use null for unobserved dimensions. Record hints, transcript reveals, replay, text-only responses, and prior material exposure. Intelligibility needs audio evidence. Rotating prompts are editorially comparable, not psychometrically equated; do not report CEFR or guaranteed gains.',
}
