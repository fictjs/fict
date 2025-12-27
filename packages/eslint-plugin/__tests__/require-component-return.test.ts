import { RuleTester } from 'eslint'

import rule from '../src/rules/require-component-return'

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

tester.run('require-component-return', rule as any, {
  valid: [
    {
      code: `
        function App() {
          return <div>ok</div>
        }
      `,
    },
    {
      code: `
        const App = () => <span>ok</span>
      `,
    },
    {
      code: `
        function App() {
          if (Math.random() > 0.5) return <div />
          return null
        }
      `,
    },
  ],
  invalid: [
    {
      code: `
        function App() {
          const count = $state(0)
        }
      `,
      errors: [{ messageId: 'missingReturn' }],
    },
    {
      code: `
        const App = () => {
          const count = $state(0)
          if (count > 1) {
            console.log(count)
          }
        }
      `,
      errors: [{ messageId: 'missingReturn' }],
    },
  ],
})
