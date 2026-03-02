import { describe, expect, it } from 'vitest'

import * as compiler from '../src/index'

describe('compiler tooling export surface', () => {
  it('exports analyze and trace helpers from compiler root', () => {
    expect(typeof compiler.analyzeFictFile).toBe('function')
    expect(typeof compiler.inferTraceMarkersForComponent).toBe('function')
  })
})
