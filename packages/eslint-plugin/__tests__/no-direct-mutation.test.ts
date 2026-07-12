import { RuleTester } from 'eslint'

import rule from '../src/rules/no-direct-mutation'

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2020, sourceType: 'module' },
})

tester.run('no-direct-mutation', rule as any, {
  valid: [
    {
      code: `const value = { count: 0 }; value.count++; delete value.count;`,
    },
    {
      code: `
        function App() {
          const state = $state({ count: 0 })
          function update(state) {
            state.count++
            delete state.count
          }
          update({ count: 1 })
          return null
        }
      `,
    },
    {
      code: `
        function App() {
          const state = $state({ count: 0 })
          { const state = { count: 1 }; state.count++ }
          return null
        }
      `,
    },
  ],
  invalid: [
    {
      code: `function App() { const state = $state({ count: 0 }); state.count = 1; return null }`,
      errors: [{ messageId: 'noDirectMutation' }],
    },
    {
      code: `function App() { const state = $state({ nested: { count: 0 } }); state.nested.count += 1; return null }`,
      errors: [{ messageId: 'noDirectMutation' }],
    },
    {
      code: `function App() { const state = $state({ count: 0 }); state.count++; ++state.count; return null }`,
      errors: [{ messageId: 'noDirectMutation' }, { messageId: 'noDirectMutation' }],
    },
    {
      code: `function App() { const state = $state({ nested: { count: 0 } }); delete state.nested.count; delete state.nested?.count; return null }`,
      errors: [{ messageId: 'noDirectMutation' }, { messageId: 'noDirectMutation' }],
    },
    {
      code: `
        function App() {
          const state = $state({ count: 0 })
          { const state = { count: 1 }; state.count++ }
          state.count++
          return null
        }
      `,
      errors: [{ messageId: 'noDirectMutation' }],
    },
  ],
})
