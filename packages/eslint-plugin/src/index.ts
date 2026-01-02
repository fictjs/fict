import type { ESLint } from 'eslint'

import noDirectMutation from './rules/no-direct-mutation'
import noEmptyEffect from './rules/no-empty-effect'
import noInlineFunctions from './rules/no-inline-functions'
import noMemoSideEffects from './rules/no-memo-side-effects'
import noNestedComponents from './rules/no-nested-components'
import noStateInLoop from './rules/no-state-in-loop'
import noStateDestructureWrite from './rules/no-state-destructure-write'
import noStateOutsideComponent from './rules/no-state-outside-component'
import requireComponentReturn from './rules/require-component-return'
import requireListKey from './rules/require-list-key'

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
    'no-state-outside-component': noStateOutsideComponent,
    'no-nested-components': noNestedComponents,
    'require-list-key': requireListKey,
    'no-memo-side-effects': noMemoSideEffects,
    'require-component-return': requireComponentReturn,
  },
  configs: {
    recommended: {
      plugins: ['fict'],
      rules: {
        'fict/no-state-in-loop': 'error',
        'fict/no-direct-mutation': 'warn',
        'fict/no-empty-effect': 'warn', // FICT-E001
        'fict/no-inline-functions': 'warn', // FICT-X003
        'fict/no-state-destructure-write': 'error',
        'fict/no-state-outside-component': 'error',
        'fict/no-nested-components': 'error', // FICT-C003
        'fict/require-list-key': 'error', // FICT-J002
        'fict/no-memo-side-effects': 'warn', // FICT-M003
        'fict/require-component-return': 'warn', // FICT-C004
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
  noStateOutsideComponent,
  noNestedComponents,
  requireListKey,
  noMemoSideEffects,
  requireComponentReturn,
}
