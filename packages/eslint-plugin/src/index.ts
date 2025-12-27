import type { ESLint } from 'eslint'

import noDirectMutation from './rules/no-direct-mutation'
import noEmptyEffect from './rules/no-empty-effect'
import noInlineFunctions from './rules/no-inline-functions'
import noStateInLoop from './rules/no-state-in-loop'
import noStateDestructureWrite from './rules/no-state-destructure-write'

const plugin: ESLint.Plugin = {
  meta: {
    name: 'eslint-plugin-fict',
    version: '0.0.1',
  },
  rules: {
    'no-state-in-loop': noStateInLoop,
    'no-direct-mutation': noDirectMutation,
    'no-empty-effect': noEmptyEffect,
    'no-inline-functions': noInlineFunctions,
    'no-state-destructure-write': noStateDestructureWrite,
  },
  configs: {
    recommended: {
      plugins: ['fict'],
      rules: {
        'fict/no-state-in-loop': 'error',
        'fict/no-direct-mutation': 'warn',
        'fict/no-empty-effect': 'warn',
        'fict/no-inline-functions': 'warn',
        'fict/no-state-destructure-write': 'error',
      },
    },
  },
}

export default plugin
export {
  noStateInLoop,
  noDirectMutation,
  noEmptyEffect,
  noInlineFunctions,
  noStateDestructureWrite,
}
