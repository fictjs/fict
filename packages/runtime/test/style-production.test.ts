import { afterEach, describe, expect, it, vi } from 'vitest'

type BindingModule = typeof import('../src/binding')

async function loadBindingForEnv(nodeEnv: string): Promise<BindingModule> {
  const previousEnv = process.env.NODE_ENV
  process.env.NODE_ENV = nodeEnv
  vi.resetModules()
  try {
    return await import('../src/binding')
  } finally {
    process.env.NODE_ENV = previousEnv
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('production style units', () => {
  it('keeps standard unitless CSS properties unitless in production', async () => {
    const { setStyle } = await loadBindingForEnv('production')
    const el = document.createElement('div')

    setStyle(el, {
      flex: 1,
      lineHeight: 1,
      fontWeight: 700,
      order: 2,
      strokeWidth: 3,
      opacity: 0.5,
      marginTop: 4,
    })

    expect(el.style.flex).not.toContain('px')
    expect(el.style.lineHeight).toBe('1')
    expect(el.style.fontWeight).toBe('700')
    expect(el.style.order).toBe('2')
    expect(el.style.getPropertyValue('stroke-width')).toBe('3')
    expect(el.style.opacity).toBe('0.5')
    expect(el.style.marginTop).toBe('4px')
  })

  it('keeps numeric CSS custom properties unitless in production', async () => {
    const { setStyle } = await loadBindingForEnv('production')
    const el = document.createElement('div')

    setStyle(el, {
      '--gap': 1,
      '--name': 'x',
      marginTop: 1,
    })

    expect(el.style.getPropertyValue('--gap')).toBe('1')
    expect(el.style.getPropertyValue('--name')).toBe('x')
    expect(el.style.marginTop).toBe('1px')
  })
})
