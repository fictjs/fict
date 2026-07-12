import { ESLint, type Linter } from 'eslint'
import { describe, it, expect } from 'vitest'

import plugin from '../src/index'

describe('eslint-plugin-fict', () => {
  it('exposes renamed rules', () => {
    expect(plugin.rules?.['no-empty-effect']).toBeDefined()
    expect(plugin.rules?.['no-state-in-loop']).toBeDefined()
    expect(plugin.rules?.['no-direct-mutation']).toBeDefined()
    expect(plugin.rules?.['no-state-destructure-write']).toBeDefined()
    expect(plugin.rules?.['no-state-outside-component']).toBeDefined()
    expect(plugin.rules?.['no-nested-components']).toBeDefined()
    expect(plugin.rules?.['no-computed-props-key']).toBeDefined()
    expect(plugin.rules?.['no-third-party-props-spread']).toBeDefined()
    expect(plugin.rules?.['no-unsafe-props-spread']).toBeDefined()
    expect(plugin.rules?.['no-unsupported-props-destructure']).toBeDefined()
    expect(plugin.rules?.['require-list-key']).toBeDefined()
    expect(plugin.rules?.['no-memo-side-effects']).toBeDefined()
    expect(plugin.rules?.['require-component-return']).toBeDefined()
  })

  it('includes recommended config entries', () => {
    const recommended = plugin.configs?.recommended as Linter.Config
    expect(recommended.plugins?.fict).toBe(plugin)
    expect(recommended.rules?.['fict/no-empty-effect']).toBe('warn')
    expect(recommended.rules?.['fict/no-state-in-loop']).toBe('error')
    expect(recommended.rules?.['fict/no-state-destructure-write']).toBe('error')
    expect(recommended.rules?.['fict/no-state-outside-component']).toBe('error')
    expect(recommended.rules?.['fict/no-nested-components']).toBe('error')
    expect(recommended.rules?.['fict/no-computed-props-key']).toBe('warn')
    expect(recommended.rules?.['fict/no-third-party-props-spread']).toBe('warn')
    expect(recommended.rules?.['fict/no-unsafe-props-spread']).toBe('warn')
    expect(recommended.rules?.['fict/no-unsupported-props-destructure']).toBe('warn')
    expect(recommended.rules?.['fict/require-list-key']).toBe('error')
    expect(recommended.rules?.['fict/no-memo-side-effects']).toBe('warn')
    expect(recommended.rules?.['fict/require-component-return']).toBe('warn')
  })

  it('loads the recommended config directly through the flat-config API', async () => {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: plugin.configs?.recommended as Linter.Config,
    })
    const [result] = await eslint.lintText(
      `function App() { const state = $state({ count: 0 }); state.count++; return <div /> }`,
      { filePath: 'component.js' },
    )

    expect(result?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'fict/no-direct-mutation', severity: 1 }),
      ]),
    )
  })
})
