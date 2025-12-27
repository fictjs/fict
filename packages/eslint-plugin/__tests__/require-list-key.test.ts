import { RuleTester } from 'eslint'

import rule from '../src/rules/require-list-key'

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

tester.run('require-list-key', rule as any, {
  valid: [
    {
      code: `
        const items = []
        const View = () => <ul>{items.map(item => <li key={item.id}>{item.name}</li>)}</ul>
      `,
    },
    {
      code: `
        const items = []
        const View = () => items.map(item => <Fragment key={item.id}>{item.name}</Fragment>)
      `,
    },
  ],
  invalid: [
    {
      code: `
        const items = []
        const View = () => <ul>{items.map(item => <li>{item.name}</li>)}</ul>
      `,
      errors: [{ messageId: 'missingKey' }],
    },
    {
      code: `
        const items = []
        const View = () => items.map(item => <section>{item.name}</section>)
      `,
      errors: [{ messageId: 'missingKey' }],
    },
  ],
})
