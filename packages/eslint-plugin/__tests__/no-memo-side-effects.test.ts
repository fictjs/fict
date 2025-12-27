import { RuleTester } from 'eslint'

import rule from '../src/rules/no-memo-side-effects'

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

tester.run('no-memo-side-effects', rule as any, {
  valid: [
    {
      code: `
        const count = $state(0)
        const doubled = $memo(() => count * 2)
      `,
    },
    {
      code: `
        const count = $state(0)
        const doubled = $memo(() => {
          return count * 2
        })
      `,
    },
  ],
  invalid: [
    {
      code: `
        const count = $state(0)
        const doubled = $memo(() => {
          count++
          return count
        })
      `,
      errors: [{ messageId: 'sideEffectInMemo' }],
    },
    {
      code: `
        const count = $state(0)
        const doubled = $memo(() => {
          $effect(() => console.log(count))
          return count
        })
      `,
      errors: [{ messageId: 'sideEffectInMemo' }],
    },
  ],
})
