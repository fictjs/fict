import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createSessionCompilerInclude } from '../src/server/session-manager'

describe('playground session compiler scope', () => {
  it('includes supported session modules without matching workspace aliases', async () => {
    const { createFilter } = (await import('vite')) as unknown as {
      createFilter: (include?: string[]) => (id: string) => boolean
    }
    const workspaceRoot = path.resolve(process.cwd(), '..', '..')
    const sessionRoot = path.join(workspaceRoot, '.fict-playground', 'sessions', 'test-session')
    const include = createSessionCompilerInclude(sessionRoot)
    const filter = createFilter(include)

    expect(include).toHaveLength(1)
    expect(path.isAbsolute(include[0]!)).toBe(true)
    expect(include[0]).not.toContain('\\')

    for (const extension of ['js', 'jsx', 'ts', 'tsx', 'mjs', 'mts', 'cjs', 'cts']) {
      expect(filter(path.join(sessionRoot, 'src', `hook.${extension}`))).toBe(true)
    }

    for (const packageName of ['runtime', 'fict', 'ssr', 'devtools']) {
      expect(filter(path.join(workspaceRoot, 'packages', packageName, 'src', 'index.ts'))).toBe(
        false,
      )
    }
  })
})
