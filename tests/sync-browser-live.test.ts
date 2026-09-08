import { afterAll, beforeAll, describe, it } from 'vitest'
import { registerSyncBrowserJourneys } from './sync-browser-journey'

registerSyncBrowserJourneys({ beforeAll, afterAll, it, describe: (name, enabled, body) => describe.skipIf(!enabled)(name, body) })
