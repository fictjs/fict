import { RuleTester } from 'eslint'

import rule from '../src/rules/no-state-destructure-write'

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2020, sourceType: 'module' },
})

tester.run('no-state-destructure-write', rule as any, {
  valid: [
    {
      code: `import { $state } from 'fict'; const state = $state({ count: 0 }); const count = () => state().count; count();`,
    },
    {
      code: `import { $state } from 'fict'; const state = $state({ count: 0 }); const { count } = state; console.log(count);`,
    },
    {
      code: `import { $state } from 'fict'; let state = $state({ count: 0 }); const { count } = state; state.count++;`,
    },
    {
      code: `import { $state } from 'fict'; let state = $state({ count: 0 }); const { count } = state; state = { ...state(), count: state().count + 1 };`,
    },
  ],
  invalid: [
    {
      code: `import { $state } from 'fict'; const state = $state({ count: 0 }); const { count } = state; count++;`,
      errors: [{ messageId: 'noWrite' }],
    },
    {
      code: `import { $state } from 'fict'; const state = $state({ count: 0 }); const { count } = state; count = 1;`,
      errors: [{ messageId: 'noWrite' }],
    },
  ],
})
