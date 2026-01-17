import { RuleTester } from 'eslint'

import rule from '../src/rules/no-unsupported-props-destructure'

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

tester.run('no-unsupported-props-destructure', rule as any, {
  valid: [
    {
      code: `
        function Comp({ a, b = 1 }) {
          return <div>{a + b}</div>
        }
      `,
    },
    {
      code: `
        const Comp = ({ a, ...rest }) => <div {...rest} />
      `,
    },
    {
      code: `
        function Comp({ user: { name } }) {
          return <div>{name}</div>
        }
      `,
    },
  ],
  invalid: [
    {
      code: `
        function Comp({ [key]: value }) {
          return value
        }
      `,
      errors: [{ messageId: 'computedKey' }],
    },
    {
      code: `
        function Comp({ list: [head, ...rest] }) {
          return head
        }
      `,
      errors: [{ messageId: 'arrayRest' }],
    },
    {
      code: `
        function Comp({ user: { ...rest } }) {
          return rest
        }
      `,
      errors: [{ messageId: 'nestedRest' }],
    },
    {
      code: `
        function Comp([value]) {
          return value
        }
      `,
      errors: [{ messageId: 'fallback' }],
    },
    {
      code: `
        function Comp(props, { ...rest }) {
          return <div {...rest} />
        }
      `,
      errors: [{ messageId: 'nonFirstParam' }],
    },
  ],
})
