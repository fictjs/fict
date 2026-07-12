import { describe, expect, it } from 'vitest'

import { formatValueShort, getTypeName, serialize } from '../src/core/serializer'

describe('safe value serializer', () => {
  it('represents invalid dates without throwing', () => {
    const invalidDate = new Date(Number.NaN)

    expect(serialize(invalidDate)).toEqual({
      type: 'date',
      value: null,
      displayText: 'Invalid Date',
    })
    expect(formatValueShort(invalidDate)).toBe('Invalid Date')
    expect(getTypeName(invalidDate)).toBe('Date')
  })

  it('isolates throwing properties while preserving readable siblings', () => {
    const value: Record<string, unknown> = { safe: 1 }
    let getterReads = 0
    let constructorReads = 0
    Object.defineProperty(value, 'danger', {
      enumerable: true,
      get() {
        getterReads += 1
        throw new Error('getter failed')
      },
    })
    Object.defineProperty(value, 'constructor', {
      get() {
        constructorReads += 1
        throw new Error('constructor getter must not run')
      },
    })

    const result = serialize(value)
    expect(result.type).toBe('object')
    expect(result.constructorName).toBe('Object')
    expect(result.value).toMatchObject({
      safe: { type: 'primitive', value: 1 },
      danger: { type: 'error', displayText: '[Unavailable property]' },
    })
    expect(getterReads).toBe(0)
    expect(constructorReads).toBe(0)
  })

  it('degrades hostile and revoked proxies to stable placeholders', () => {
    const ownKeysProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys failed')
        },
      },
    )
    const revocable = Proxy.revocable({}, {})
    revocable.revoke()

    for (const value of [ownKeysProxy, revocable.proxy]) {
      expect(() => serialize(value)).not.toThrow()
      expect(serialize(value)).toMatchObject({
        type: 'object',
        displayText: '[Uninspectable]',
        expandable: false,
      })
      expect(formatValueShort(value)).toBe('[Uninspectable]')
      expect(getTypeName(value)).toBe('object')
    }
  })

  it('handles throwing array elements, function names, errors, and collection proxies', () => {
    const array = [1, 2]
    Object.defineProperty(array, 1, {
      get() {
        throw new Error('array getter failed')
      },
    })
    const functionProxy = new Proxy(() => {}, {
      get(_target, key) {
        if (key === 'name') throw new Error('name failed')
        return undefined
      },
    })
    const error = new Error('original')
    Object.defineProperty(error, 'message', {
      get() {
        throw new Error('message failed')
      },
    })
    const mapProxy = new Proxy(new Map([['key', 'value']]), {})

    expect(serialize(array).value).toEqual([
      expect.objectContaining({ type: 'primitive', value: 1 }),
      expect.objectContaining({ type: 'error' }),
    ])
    expect(serialize(functionProxy).displayText).toBe('ƒ anonymous()')
    expect(serialize(error)).toMatchObject({ type: 'error', displayText: 'Error' })
    expect(serialize(mapProxy)).toMatchObject({ type: 'object', expandable: false })
    expect(formatValueShort(mapProxy)).toBe('[Uninspectable]')
  })
})
