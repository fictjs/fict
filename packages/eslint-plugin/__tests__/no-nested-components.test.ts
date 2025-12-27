import { RuleTester } from 'eslint'

import rule from '../src/rules/no-nested-components'

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

tester.run('no-nested-components', rule as any, {
  valid: [
    {
      code: `
        function Child() {
          return <div>ok</div>
        }
        function Parent() {
          return <Child />
        }
      `,
    },
    {
      code: `
        const Parent = () => {
          const useHelper = () => 1
          return <div>{useHelper()}</div>
        }
      `,
    },
  ],
  invalid: [
    {
      code: `
        function Parent() {
          function Child() {
            return <div>Child</div>
          }
          return <Child />
        }
      `,
      errors: [{ messageId: 'nestedComponent' }],
    },
    {
      code: `
        const Parent = () => {
          const Child = () => <span>hi</span>
          return <Child />
        }
      `,
      errors: [{ messageId: 'nestedComponent' }],
    },
  ],
})
