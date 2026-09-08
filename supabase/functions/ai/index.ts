import { createAIHandler } from '../_shared/jove-runtime.js'

Deno.serve(createAIHandler({ env: (name: string) => Deno.env.get(name) }))
