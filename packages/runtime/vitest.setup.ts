import { afterEach, beforeEach } from 'vitest'

import { enableFineGrainedRuntime, disableFineGrainedRuntime } from './src/feature-flags'

beforeEach(() => {
  enableFineGrainedRuntime()
})

afterEach(() => {
  disableFineGrainedRuntime()
})
