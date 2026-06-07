import { transformSync } from '@babel/core'
import { describe, expect, it } from 'vitest'

import createFictPlugin, { type CompilerExplainArtifact } from '../src'

import { transform } from './test-utils'

describe('compiler explain artifact', () => {
  it('emits source, helper, and diagnostic events through the callback', () => {
    const artifacts: CompilerExplainArtifact[] = []

    transform(
      `
        import { $state } from 'fict'

        export function App({ field = 'name' }) {
          let user = $state({ name: 'Ada', city: 'London' })
          if (field) {
            return <div>{user[field]}</div>
          }
          return <span>{user.name}</span>
        }
      `,
      {
        dev: true,
        strictGuarantee: false,
        explain: artifact => artifacts.push(artifact),
      },
      'explain.tsx',
    )

    expect(artifacts).toHaveLength(1)
    const artifact = artifacts[0]
    expect(artifact).toBeDefined()
    if (!artifact) throw new Error('expected explain artifact')
    expect(artifact).toMatchObject({
      version: 1,
    })
    expect(artifact.fileName).toMatch(/explain\.tsx$/)
    expect(artifact.helpers).toContain('__fictUseSignal')
    expect(artifact.events.map(event => event.kind)).toEqual(
      expect.arrayContaining([
        'source-signal',
        'source-control-flow',
        'source-jsx',
        'runtime-helper',
        'diagnostic',
      ]),
    )
    expect(artifact.diagnostics.map(diagnostic => diagnostic.code)).toContain('FICT-H')
  })

  it('attaches the artifact to Babel metadata when explain is true', () => {
    const result = transformSync(
      `
        import { $state } from 'fict'

        export function App() {
          let count = $state(0)
          return <div>{count}</div>
        }
      `,
      {
        filename: 'metadata-explain.tsx',
        configFile: false,
        babelrc: false,
        sourceType: 'module',
        parserOpts: {
          sourceType: 'module',
          plugins: ['typescript', 'jsx'],
        },
        plugins: [
          [
            createFictPlugin,
            {
              dev: false,
              emitModuleMetadata: false,
              strictGuarantee: false,
              explain: true,
            },
          ],
        ],
      },
    )

    const artifact = result?.metadata?.fictExplain as CompilerExplainArtifact | undefined

    expect(artifact?.fileName).toMatch(/metadata-explain\.tsx$/)
    expect(artifact?.events.some(event => event.kind === 'source-signal')).toBe(true)
    expect(artifact?.helpers).toContain('insertBetween')
  })

  it('reports optional runtime creator calls as source memo events', () => {
    const cases = [
      {
        expectedName: 'createMemo',
        source: `
          import { createMemo } from 'fict'

          export function App() {
            const value = createMemo(() => 1)
            return <div>{value}</div>
          }
        `,
      },
      {
        expectedName: 'createMemo',
        source: `
          import { createMemo } from 'fict'

          export function App() {
            const value = createMemo?.(() => 1)
            return <div>{value}</div>
          }
        `,
      },
      {
        expectedName: 'memo',
        source: `
          import { createMemo as memo } from 'fict'

          export function App() {
            const value = memo?.(() => 1)
            return <div>{value}</div>
          }
        `,
      },
      {
        expectedName: 'F.createMemo',
        source: `
          import * as F from 'fict'

          export function App() {
            const value = F.createMemo?.(() => 1)
            return <div>{value}</div>
          }
        `,
      },
      {
        expectedName: 'Runtime.createMemo',
        source: `
          import * as Runtime from '@fictjs/runtime'

          export function App() {
            const value = Runtime['createMemo']?.(() => 1)
            return <div>{value}</div>
          }
        `,
      },
    ]

    for (const [index, { expectedName, source }] of cases.entries()) {
      const artifacts: CompilerExplainArtifact[] = []

      transform(
        source,
        {
          dev: true,
          strictGuarantee: false,
          explain: artifact => artifacts.push(artifact),
        },
        `optional-explain-${index}.tsx`,
      )

      const memoEvent = artifacts[0]?.events.find(
        event => event.kind === 'source-memo' && event.name === expectedName,
      )
      expect(memoEvent).toMatchObject({
        kind: 'source-memo',
        name: expectedName,
      })
      expect(memoEvent?.line).toBeGreaterThan(0)
      expect(memoEvent?.column).toBeGreaterThan(0)
    }
  })

  it('rejects optional state and effect macros before emitting explain artifacts', () => {
    const artifacts: CompilerExplainArtifact[] = []

    expect(() =>
      transform(
        `
          import { $effect } from 'fict'

          export function App() {
            $effect?.(() => {})
            return <div />
          }
        `,
        {
          dev: true,
          strictGuarantee: false,
          explain: artifact => artifacts.push(artifact),
        },
        'optional-effect-explain.tsx',
      ),
    ).toThrow(/optional-call syntax/)
    expect(artifacts).toHaveLength(0)
  })
})
