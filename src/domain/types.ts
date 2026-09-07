import type { Card } from 'ts-fsrs'

export const skillNames = ['vocabularyRecognition','vocabularyRecall','chunkRecognition','chunkProduction','listeningWords','listeningSentences','naturalListening','speakingFluency','speakingAccuracy','pronunciation','prosody','grammarProduction','reading','writing','interaction','realWorld'] as const
export type SkillName = typeof skillNames[number]
export type Modality = 'recognition' | 'listening' | 'recall' | 'cloze' | 'speaking' | 'transfer'
export type EvidenceSource = 'objective' | 'self-report' | 'ai' | 'text' | 'acoustic'
export interface Skill { id: SkillName; score: number; confidence: number; evidenceCount: number; updatedAt: number }
export interface Profile { id: string; name: string; goal: string; interests: string[]; dailyMinutes: number; fatigue: number; onboarded: boolean; createdAt: number }
export interface Settings {
  theme: 'light' | 'dark' | 'system'; chineseHelp: boolean; accent: string; correctionIntensity: number;
  fastModel: string; strongModel: string; sttModel: string; ttsModel: string; voice: string;
  dailyBudget: number; audioLimitMB: number;
}
export interface StudyEvent {
  id: string; type: string; timestamp: number; sessionId?: string; skill?: SkillName;
  score?: number; source: EvidenceSource; chunkId?: string; modality?: Modality;
  prompted?: boolean; contextId?: string; data?: Record<string, string | number | boolean | string[]>;
}
export interface Chunk {
  id: string; text: string; meaningEn: string; meaningZh: string; sourceSentence: string;
  examples: string[]; register: string; sourceIds: string[];
  readingStrength: number; listeningStrength: number; recallStrength: number; productionStrength: number;
  spontaneousUses: number; createdAt: number;
}
export interface ReviewCard { id: string; chunkId: string; modality: Modality; card: Card; contextIds: string[]; errorId?: string }
export interface ErrorPattern {
  id: string; pattern: string; category: string; original: string; corrected: string; hint: string;
  explanation: string; attempts: number; failures: number; spontaneousSuccesses: number; nextReview: number;
  chunkId?: string;
}
export interface MaterialChunk { text: string; meaningEn: string; meaningZh: string; example: string }
export interface Material {
  id: string; title: string; topic: string; difficulty: number; duration: number;
  transcript: string; translation?: string; sentences: string[]; audioPath?: string; audioId?: string;
  sourceKind: 'curated' | 'text' | 'url' | 'audio' | 'discovery' | 'generated';
  sourceUrl?: string; sourceLabel: string; license?: string; synthetic: boolean; approved: boolean;
  question: string; answer: string; keywords: string[]; chunks: MaterialChunk[]; createdAt: number;
}
export interface StudySession { id: string; kind: string; materialId?: string; startedAt: number; completedAt?: number; stage: string; draft: Record<string, unknown> }
export interface PlanTask { id: string; kind: 'review' | 'listen' | 'learn' | 'shadow' | 'speak' | 'repair' | 'retell' | 'assessment'; title: string; minutes: number; reason: string; done: boolean; materialId?: string }
export interface DailyPlan { id: string; date: string; minutes: number; focus: SkillName; tasks: PlanTask[]; evidenceFingerprint: string; createdAt: number }
export interface Message { id: string; role: 'user' | 'assistant'; text: string; timestamp: number; audioId?: string }
export interface Conversation { id: string; mode: string; scenario: string; messages: Message[]; startedAt: number; completedAt?: number; evaluation?: Evaluation }
export interface Evaluation {
  summary: string; strengths: string[]; errors: { category: string; original: string; corrected: string; hint: string; explanation: string }[];
  comprehension: number | null; accuracy: number | null; fluency: number | null;
  successfulChunks: string[]; nextPrompt: string;
  rubricScores?: { vocabulary: number | null; interaction: number | null; taskCompletion: number | null };
}
export interface Assessment { id: string; timestamp: number; variant: number; stage: string; responses: Record<string, string>; scores: Record<string, number | null>; completedAt?: number }
export interface AudioAsset { id: string; blob: Blob; mimeType: string; createdAt: number; duration: number; kind: 'recording' | 'generated' | 'import'; processed: boolean; label: string }
export interface Usage { id: string; timestamp: number; model: string; purpose: string; tokens: number | null; cost: number | null }

export const defaultSettings: Settings = { theme:'system', chineseHelp:true, accent:'en-US', correctionIntensity:2, fastModel:'', strongModel:'', sttModel:'', ttsModel:'', voice:'', dailyBudget:1, audioLimitMB:200 }
export const defaultProfile = (): Profile => ({ id:'main', name:'Jove', goal:'Real-world conversation', interests:['Technology','Everyday life','Living abroad'], dailyMinutes:45, fatigue:0, onboarded:false, createdAt:Date.now() })
