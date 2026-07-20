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
    {
      code: `import { $state } from 'fict'; let state = $state(0); let alias; alias = state; console.log(alias);`,
    },
    {
      code: `let value = 0; let alias = value; alias++;`,
    },
    {
      code: `const values = []; const alias = values; alias.push(1);`,
    },
    {
      code: `const state = $state([]); state.push(1);`,
    },
    {
      code: `const state = $state(0); let snapshot = state * 2; snapshot = 3;`,
    },
    {
      code: `const state = $state(0); const plain = { state: 1 }; const snapshot = plain.state; snapshot++;`,
    },
    {
      code: `
        const state = $state({ count: 0 })
        const { count } = state
        function update(count) { count++ }
        update(1)
      `,
    },
    {
      code: `
        const state = $state({ count: 0 })
        function update(state) {
          const { count } = state
          count++
        }
      `,
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
    {
      code: `const state = $state({ count: 0 }); const { count = 0 } = state; count += 1;`,
      errors: [{ messageId: 'noWrite' }],
    },
    {
      code: `const state = $state(0); const alias = state; alias++;`,
      errors: [{ messageId: 'noWrite' }],
    },
    {
      code: `const state = $state(0); const doubled = state * 2; doubled = 3;`,
      errors: [{ messageId: 'noWrite' }],
    },
    {
      code: `const state = $state(0); let alias; alias = state; alias = 1;`,
      errors: [{ messageId: 'noWrite' }],
    },
    {
      code: `const first = $state(0); const second = $state(1); let alias = first; alias = second;`,
      errors: [{ messageId: 'noWrite' }],
    },
    {
      code: `const first = $state(0); const second = $state(1); let alias; alias = first; alias = second;`,
      errors: [{ messageId: 'noWrite' }],
    },
    {
      code: `const state = $state(0); const alias = state; function update() { alias += 1 }`,
      errors: [{ messageId: 'noWrite' }],
    },
    {
      code: `const state = $state({ count: 0 }); const alias = state; const { count } = alias; count++;`,
      errors: [{ messageId: 'noWrite' }],
    },
    {
      code: `const state = $state({ nested: { count: 0 } }); const { count } = state.nested; count++;`,
      errors: [{ messageId: 'noWrite' }],
    },
    {
      code: `const state = $state({ count: 0 }); const alias = state; const key = 'count'; alias[key] += 1;`,
      errors: [{ messageId: 'noWrite' }],
    },
    {
      code: `const state = $state({ nested: { count: 0 } }); const alias = state; alias.nested.count++;`,
      errors: [{ messageId: 'noWrite' }],
    },
    {
      code: `const state = $state({ count: 0 }); const alias = state; delete alias.count;`,
      errors: [{ messageId: 'noWrite' }],
    },
    {
      code: `const state = $state([]); const alias = state; alias.push(1);`,
      errors: [{ messageId: 'noWrite' }],
    },
    {
      code: `const key = 'count'; const state = $state({ count: 0 }); const { [key]: count } = state; ({ count } = { count: 1 });`,
      errors: [{ messageId: 'noWrite' }],
    },
    {
      code: `
        const state = $state({ count: 0 })
        const { count } = state
        function update(count) { count++ }
        count++
      `,
      errors: [{ messageId: 'noWrite' }],
    },
  ],
})
