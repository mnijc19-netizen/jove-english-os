import { z } from 'zod'

/** A tutor may explain an answer, never write a mastery score or invent audio evidence. */
export const starterFeedbackSchema = z.strictObject({
  verdict: z.enum(['valid', 'partial', 'invalid', 'uncertain']),
  feedbackZh: z.string().trim().min(1).max(300),
  correction: z.string().trim().min(1).max(160).nullable(),
  nextAction: z.enum(['continue', 'retry', 'simplify', 'clarify']),
  evidence: z.string().trim().min(1).max(500),
})
export type StarterFeedbackOutput = z.infer<typeof starterFeedbackSchema>
export type StarterFeedback = StarterFeedbackOutput & {
  source: 'course-rule' | 'ai'; model?: string
}
