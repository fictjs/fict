import { describe, expect, it } from 'vitest'

import * as compiler from '../src/legacy'

describe('legacy compiler tooling export surface', () => {
  it('exports analyze and trace helpers from the compatibility entrypoint', () => {
    expect(typeof compiler.analyzeFictFile).toBe('function')
    expect(typeof compiler.inferTraceMarkersForComponent).toBe('function')
    expect(typeof compiler.minimizeSourceByLines).toBe('function')
  })
})
