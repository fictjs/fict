import { RuleTester } from 'eslint'

import rule from '../src/rules/no-empty-effect'

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

tester.run('no-empty-effect', rule as any, {
  valid: [
    {
      code: `
        const count = $state(0)
        $effect(() => {
          document.title = String(count)
        })
      `,
    },
    {
      code: `
        const count = $state(0)
        $effect(function () {
          console.log(count)
        })
      `,
    },
  ],
  invalid: [
    {
      code: `
        $effect(() => {})
      `,
      errors: [{ messageId: 'emptyEffect' }],
    },
    {
      code: `
        $effect(() => {
          const local = 1
          console.log(local)
        })
      `,
      errors: [{ messageId: 'emptyEffect' }],
    },
  ],
})
