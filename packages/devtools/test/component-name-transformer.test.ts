import { describe, expect, it } from 'vitest'

import { hook, setComponentNameTransformer } from '../src/core/debugger'

describe('component name transformer', () => {
  it('transforms runtime component names and safely falls back', () => {
    const reset = setComponentNameTransformer(name => `Feature/${name}`)
    hook.registerComponent(920_001, 'Counter')
    expect(hook.getComponents().find(component => component.id === 920_001)?.name).toBe(
      'Feature/Counter',
    )

    reset()
    const resetThrowing = setComponentNameTransformer(() => {
      throw new Error('name transform failed')
    })
    expect(() => hook.registerComponent(920_002, 'Fallback')).not.toThrow()
    expect(hook.getComponents().find(component => component.id === 920_002)?.name).toBe('Fallback')
    resetThrowing()
  })
})
