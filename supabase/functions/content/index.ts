import { createContentHandler } from '../_shared/jove-runtime.js'

Deno.serve(createContentHandler((name: string) => Deno.env.get(name)))
