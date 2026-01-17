import { RuleTester } from 'eslint'

import rule from '../src/rules/no-computed-props-key'

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

tester.run('no-computed-props-key', rule as any, {
  valid: [
    {
      code: `
        function Comp() {
          return <div {...{ id: 'ok' }} />
        }
      `,
    },
  ],
  invalid: [
    {
      code: `
        function Comp() {
          return <div {...{ [key]: value }} />
        }
      `,
      errors: [{ messageId: 'computedKey' }],
    },
  ],
})
