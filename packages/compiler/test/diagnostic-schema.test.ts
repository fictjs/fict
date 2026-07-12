import { describe, expect, it } from 'vitest'

import type { FictDiagnostic } from '../src/index'

describe('native diagnostic TypeScript schema', () => {
  it('exposes the complete structured result shape', () => {
    const diagnostic: FictDiagnostic = {
      code: 'FICT-R006',
      severity: 'warning',
      message: 'control flow requires fallback',
      primarySpan: { start: 4, end: 9 },
      secondaryLabels: [{ span: { start: 12, end: 12 }, message: 'related branch' }],
      help: 'move the expression outside the branch',
      notes: ['strict guarantee escalates this finding'],
      guaranteeClass: 'fallback',
    }

    expect(JSON.parse(JSON.stringify(diagnostic))).toEqual(diagnostic)
  })
})
