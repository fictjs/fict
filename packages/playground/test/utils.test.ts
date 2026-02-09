import { describe, expect, it } from 'vitest'

import { normalizeRelativeFilePath, resolveSessionFilePath } from '../src/server/utils'

describe('playground file path safety', () => {
  it('normalizes safe relative paths', () => {
    expect(normalizeRelativeFilePath('./src/main.tsx')).toBe('src/main.tsx')
    expect(normalizeRelativeFilePath('src/../src/App.tsx')).toBe('src/App.tsx')
  })

  it('rejects traversal paths', () => {
    expect(() => normalizeRelativeFilePath('../.env')).toThrow('Path traversal is not allowed')
    expect(() => normalizeRelativeFilePath('/etc/passwd')).toThrow('Path traversal is not allowed')
  })

  it('ensures resolved files stay within session root', () => {
    const root = '/tmp/fict-playground-test'
    expect(resolveSessionFilePath(root, 'src/main.tsx')).toBe(
      '/tmp/fict-playground-test/src/main.tsx',
    )
    expect(() => resolveSessionFilePath(root, '../../escape')).toThrow(
      'Path traversal is not allowed',
    )
  })
})
