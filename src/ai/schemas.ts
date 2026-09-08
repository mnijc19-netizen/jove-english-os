import { z } from 'zod'

const phrase = z.string().trim().min(1).max(1000)
export const lookupSchema = z.strictObject({
  // Preserve exact requested spelling/case/spacing; validate identity after parsing.
  text: z.string().min(1).max(200),
  meaningEn: z.string().trim().min(1).max(500),
  meaningZh: z.string().max(500),
  example: z.string().trim().min(1).max(600),
})

export const evaluationSchema = z.strictObject({
  summary: phrase,
  strengths: z.array(phrase).max(5),
  errors: z.array(z.strictObject({ category: z.enum(['grammar', 'vocabulary', 'meaning', 'interaction', 'register', 'spelling', 'structure']), original: phrase, corrected: phrase, hint: phrase, explanation: phrase })).max(3),
  comprehension: z.number().min(0).max(1).nullable(),
  accuracy: z.number().min(0).max(1).nullable(),
  fluency: z.null().describe('Text cannot establish acoustic fluency, pronunciation or prosody.'),
  successfulChunks: z.array(phrase).max(20),
  nextPrompt: phrase,
  rubricScores: z.strictObject({
    vocabulary: z.number().min(0).max(1).nullable(),
    interaction: z.number().min(0).max(1).nullable(),
    taskCompletion: z.number().min(0).max(1).nullable(),
  }).optional(),
})

// Added by the transport from the provider response, never requested from LLM text.
export const evaluatedResultSchema = evaluationSchema.extend({
  provenance: z.strictObject({ provider: z.string().min(1).max(100), model: z.string().min(1).max(200) }).optional(),
})

// The provider owns educational content only, never approval, provenance or audio locations.
export const materialSchema = z.strictObject({
  title: z.string().min(1).max(160), topic: z.string().min(1).max(200),
  difficulty: z.number().min(0).max(1),
  duration: z.number().min(1).max(1800).describe('Estimated reading/listening seconds, not measured audio duration.'),
  transcript: z.string().min(1).max(16000), translation: z.string().max(16000),
  sentences: z.array(z.string().min(1).max(2000)).min(1).max(100),
  question: phrase, answer: phrase, keywords: z.array(phrase).min(1).max(20),
  chunks: z.array(z.strictObject({ text: phrase, meaningEn: phrase, meaningZh: z.string().max(1000), example: phrase })).min(1).max(12),
})

export const catalogSchema = z.object({ data: z.array(z.object({
  id: z.string().min(1).max(200), name: z.string().max(300),
  architecture: z.object({ input_modalities: z.array(z.string()), output_modalities: z.array(z.string()) }),
  supported_parameters: z.array(z.string()).nullish(), supported_voices: z.array(z.string()).nullish(),
})) })

export const completionSchema = z.object({
  id: z.string().optional(), model: z.string().optional(), usage: z.unknown().optional(), error: z.unknown().optional(),
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    message: z.object({ content: z.string().nullable().optional(), annotations: z.array(z.unknown()).optional(), refusal: z.string().nullable().optional(), tool_calls: z.array(z.unknown()).optional() }).optional(),
    delta: z.object({ content: z.string().nullable().optional(), tool_calls: z.array(z.unknown()).optional() }).optional(),
  })).optional(),
})
