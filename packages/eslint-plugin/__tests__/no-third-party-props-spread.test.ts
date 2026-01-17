import { RuleTester } from 'eslint'

import rule from '../src/rules/no-third-party-props-spread'

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

tester.run('no-third-party-props-spread', rule as any, {
  valid: [
    {
      code: `
        import local from './local'
        function Comp() {
          return <Child {...local} />
        }
      `,
    },
    {
      code: `
        import third from 'lib'
        function Comp() {
          return <Child {...mergeProps(third)} />
        }
      `,
    },
    {
      code: `
        import third from 'lib'
        function Comp() {
          return <Child {...third()} />
        }
      `,
    },
    {
      code: `
        import ui from '@ui/button'
        function Comp() {
          return <Child {...ui} />
        }
      `,
      options: [{ internalPrefixes: ['@ui/'] }],
    },
    {
      code: `
        import cfg from 'shared-config'
        function Comp() {
          return <Child {...cfg} />
        }
      `,
      options: [{ allow: ['shared-config'] }],
    },
    {
      code: `
        function Comp() {
          return <Child {...{ id: 'ok' }} />
        }
      `,
    },
  ],
  invalid: [
    {
      code: `
        import third from 'lib'
        function Comp() {
          return <Child {...third} />
        }
      `,
      errors: [{ messageId: 'thirdPartySpread' }],
    },
    {
      code: `
        import { third } from 'lib'
        function Comp() {
          return <Child {...third.props} />
        }
      `,
      errors: [{ messageId: 'thirdPartySpread' }],
    },
    {
      code: `
        import third from 'lib'
        function Comp() {
          return <Child {...third()} />
        }
      `,
      options: [{ includeCallExpressions: true }],
      errors: [{ messageId: 'thirdPartySpread' }],
    },
  ],
})
