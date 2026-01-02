import { RuleTester } from 'eslint'

import rule from '../src/rules/no-state-outside-component'

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

tester.run('no-state-outside-component', rule as any, {
  valid: [
    {
      code: `import { $state } from 'fict'; function Component() { const count = $state(0); return <div>{count}</div>; }`,
    },
    {
      code: `import { $state } from 'fict'; const Component = () => { const count = $state(0); return <div>{count}</div>; };`,
    },
    {
      code: `import { $state } from 'fict'; function useCounter() { const count = $state(0); return { count }; }`,
    },
  ],
  invalid: [
    {
      code: `import { $state } from 'fict'; const count = $state(0);`,
      errors: [{ messageId: 'moduleScope' }],
    },
    {
      code: `import { $state } from 'fict'; function helper() { const count = $state(0); }`,
      errors: [{ messageId: 'componentOnly' }],
    },
    {
      code: `import { $state } from 'fict'; function Component() { if (true) { const count = $state(0); } return null; }`,
      errors: [{ messageId: 'topLevel' }],
    },
    {
      code: `import { $state } from 'fict'; function Component() { function inner() { const count = $state(0); } return null; }`,
      errors: [{ messageId: 'topLevel' }],
    },
  ],
})
