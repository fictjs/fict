import { RuleTester } from 'eslint'

import rule from '../src/rules/no-unsafe-props-spread'

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

tester.run('no-unsafe-props-spread', rule as any, {
  valid: [
    {
      code: `
        const props = { id: 'ok' }
        function Parent() {
          return <Child {...props} />
        }
      `,
    },
    {
      code: `
        const data = $state({})
        function Parent() {
          return <Child {...data()} />
        }
      `,
    },
    {
      code: `
        const props = { id: 'ok' }
        function Parent() {
          return <Child {...mergeProps(props)} />
        }
      `,
    },
    {
      code: `
        function Parent() {
          return <Child {...{ id: 'ok' }} />
        }
      `,
    },
    {
      code: `
        import { count } from './state'
        function Parent() {
          return <Child {...count()} />
        }
      `,
      options: [{ accessorModules: ['./state'] }],
    },
  ],
  invalid: [
    {
      code: `
        function Parent() {
          return <Child {...getProps()} />
        }
      `,
      errors: [{ messageId: 'unsafeSpread' }],
    },
    {
      code: `
        function Parent() {
          return <Child {...(cond ? a : b)} />
        }
      `,
      errors: [{ messageId: 'unsafeSpread' }],
    },
    {
      code: `
        function Parent() {
          return <Child {...obj.prop} />
        }
      `,
      errors: [{ messageId: 'unsafeSpread' }],
    },
    {
      code: `
        function Parent() {
          return <Child {...{ [key]: value }} />
        }
      `,
      errors: [{ messageId: 'unsafeSpread' }],
    },
  ],
})
