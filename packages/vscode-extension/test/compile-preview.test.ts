import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({
  Uri: {
    parse(value: string) {
      return {
        toString: () => value,
      }
    },
  },
  EventEmitter: class<T> {
    readonly event = vi.fn()
    fire = vi.fn()
    dispose = vi.fn()
  },
}))

import { compileDocumentSource } from '../src/commands/compilePreview'

function createDocument(source: string, fileName = '/tmp/App.tsx') {
  return {
    fileName,
    getText: () => source,
  } as const
}

describe('compile preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('compiles supported source for preview', () => {
    const output = compileDocumentSource(
      createDocument(
        "import { $state } from 'fict'\nexport function App(){ let count = $state(0); return <button>{count}</button> }\n",
      ) as never,
    )

    expect(output).toContain('__fictUseSignal')
  })

  it('compiles angle-bracket assertions in TypeScript-only documents', () => {
    const output = compileDocumentSource(
      createDocument(
        "import { $state } from 'fict'\nexport function useValue(input: unknown) { const asserted = <number>input; const value = $state(asserted); return value }\n",
        '/tmp/use-value.ts',
      ) as never,
    )

    expect(output).toContain('__fictUseSignal')
    expect(output).not.toContain('<number>')
  })

  it('preserves strict guarantee failures in preview compilation', () => {
    expect(() =>
      compileDocumentSource(
        createDocument(
          "import { $state } from 'fict'\nexport function App(){ let state = $state({ count: 0 }); state.count = 1; return <div>{state.count}</div> }\n",
        ) as never,
      ),
    ).toThrow(/FICT-M/)
  })
})
