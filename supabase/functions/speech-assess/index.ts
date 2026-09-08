import { createSpeechHandler } from '../_shared/jove-runtime.js'

Deno.serve(createSpeechHandler({ env: (name: string) => Deno.env.get(name) }))
