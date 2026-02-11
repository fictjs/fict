import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { attachDebugger, detachDebugger, hook } from '../src/core/debugger'
import { MessageSource } from '../src/core/types'

const EFFECT_ID = 900_001

function sendPanelMessage(type: string, payload?: unknown): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        source: MessageSource.Panel,
        type,
        payload,
      },
    }),
  )
}

describe('debugger performance marks', () => {
  beforeEach(() => {
    attachDebugger()
    sendPanelMessage('set:settings', { recordTimeline: true, highPerfMode: false })
  })

  afterEach(() => {
    hook.disposeEffect(EFFECT_ID)
    sendPanelMessage('clear:timeline')
    sendPanelMessage('set:settings', { recordTimeline: true, highPerfMode: false })
    detachDebugger()
    vi.restoreAllMocks()
  })

  it('writes mark/measure entries for batch, flush and effect runs', () => {
    const markSpy = vi.spyOn(performance, 'mark')
    const measureSpy = vi.spyOn(performance, 'measure')

    hook.batchStart()
    hook.flushStart()
    hook.flushEnd()
    hook.batchEnd()
    hook.registerEffect(EFFECT_ID)
    hook.effectRun(EFFECT_ID, 0.6)

    const markNames = markSpy.mock.calls.map(call => String(call[0]))
    const measureNames = measureSpy.mock.calls.map(call => String(call[0]))

    expect(markNames.some(name => name.startsWith('fict.devtools.event.batch:start.'))).toBe(true)
    expect(markNames.some(name => name.startsWith('fict.devtools.event.flush:start.'))).toBe(true)
    expect(markNames.some(name => name.startsWith('fict.devtools.event.effect:run.'))).toBe(true)

    expect(measureNames.some(name => name.startsWith('fict.devtools.batch.'))).toBe(true)
    expect(measureNames.some(name => name.startsWith('fict.devtools.flush.'))).toBe(true)
    expect(measureNames.some(name => name.startsWith('fict.devtools.effect.'))).toBe(true)
  })

  it('still writes effect measure entries when effect duration is 0ms', () => {
    const measureSpy = vi.spyOn(performance, 'measure')

    hook.registerEffect(EFFECT_ID)
    hook.effectRun(EFFECT_ID, 0)

    const effectMeasures = measureSpy.mock.calls
      .map(call => String(call[0]))
      .filter(name => name.startsWith('fict.devtools.effect.'))
    expect(effectMeasures.length).toBeGreaterThan(0)
  })

  it('skips mark/measure instrumentation when highPerfMode is enabled', () => {
    const markSpy = vi.spyOn(performance, 'mark')
    const measureSpy = vi.spyOn(performance, 'measure')

    sendPanelMessage('set:settings', { recordTimeline: true, highPerfMode: true })
    hook.batchStart()
    hook.batchEnd()
    hook.warning('ignored while highPerfMode')

    expect(markSpy).not.toHaveBeenCalled()
    expect(measureSpy).not.toHaveBeenCalled()
  })
})
