import type { ESLint } from 'eslint'

import noEmptyEffect from './rules/no-empty-effect'
import noDirectMutation from './rules/no-direct-mutation'
import noStateInLoop from './rules/no-state-in-loop'

const plugin: ESLint.Plugin = {
  meta: {
    name: 'eslint-plugin-fict',
    version: '0.0.1',
  },
  rules: {
    'no-state-in-loop': noStateInLoop,
    'no-direct-mutation': noDirectMutation,
    'no-empty-effect': noEmptyEffect,
  },
  configs: {
    recommended: {
      plugins: ['fict'],
      rules: {
        'fict/no-state-in-loop': 'error',
        'fict/no-direct-mutation': 'warn',
        'fict/no-empty-effect': 'warn',
      },
    },
  },
}

export default plugin
export { noStateInLoop, noDirectMutation, noEmptyEffect }
