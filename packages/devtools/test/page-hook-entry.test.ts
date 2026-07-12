import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

type HookGlobal = typeof globalThis & {
  __FICT_DEVTOOLS_HOOK__?: { registerRoot?: (id: number) => void }
  __FICT_DEVTOOLS_PAGE_BRIDGE__?: { dispose(): void }
}

describe('extension main-world page hook', () => {
  afterEach(() => {
    const global = globalThis as HookGlobal
    global.__FICT_DEVTOOLS_PAGE_BRIDGE__?.dispose()
    delete global.__FICT_DEVTOOLS_PAGE_BRIDGE__
    delete global.__FICT_DEVTOOLS_HOOK__
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('declares a document-start MAIN-world entry separate from the isolated bridge', () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'manifest.json'), 'utf8')) as {
      content_scripts?: Array<{ js?: string[]; run_at?: string; world?: string }>
    }

    expect(manifest.content_scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          js: ['page-hook.js'],
          run_at: 'document_start',
          world: 'MAIN',
        }),
        expect.objectContaining({ js: ['content.js'], run_at: 'document_start' }),
      ]),
    )
  })

  it('installs the debugger before announcing Fict runtime activity', async () => {
    const messages: unknown[] = []
    vi.spyOn(window, 'postMessage').mockImplementation((message: unknown) => {
      messages.push(message)
    })

    await import('../src/page/index')

    const hook = (globalThis as HookGlobal).__FICT_DEVTOOLS_HOOK__
    expect(hook).toBeDefined()
    expect(
      messages.some(
        message =>
          typeof message === 'object' &&
          message !== null &&
          (message as { type?: string }).type === 'fict-detected',
      ),
    ).toBe(false)

    hook?.registerRoot?.(1)

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'fict-devtools-hook', type: 'fict-detected' }),
      ]),
    )
  })
})
