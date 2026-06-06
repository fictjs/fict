import { describe, it, expect } from 'vitest'
import { serializeValue, deserializeValue } from '../src/resume'

describe('serializeValue / deserializeValue', () => {
  describe('primitives', () => {
    it('should handle null', () => {
      expect(deserializeValue(serializeValue(null))).toBe(null)
    })

    it('should handle booleans', () => {
      expect(deserializeValue(serializeValue(true))).toBe(true)
      expect(deserializeValue(serializeValue(false))).toBe(false)
    })

    it('should handle strings', () => {
      expect(deserializeValue(serializeValue(''))).toBe('')
      expect(deserializeValue(serializeValue('hello'))).toBe('hello')
      expect(deserializeValue(serializeValue('unicode: 你好 🎉'))).toBe('unicode: 你好 🎉')
    })

    it('should handle numbers', () => {
      expect(deserializeValue(serializeValue(0))).toBe(0)
      expect(deserializeValue(serializeValue(42))).toBe(42)
      expect(deserializeValue(serializeValue(-42))).toBe(-42)
      expect(deserializeValue(serializeValue(3.14159))).toBe(3.14159)
    })
  })

  describe('special numbers', () => {
    it('should handle undefined', () => {
      expect(deserializeValue(serializeValue(undefined))).toBe(undefined)
    })

    it('should handle NaN', () => {
      expect(Number.isNaN(deserializeValue(serializeValue(NaN)))).toBe(true)
    })

    it('should handle Infinity', () => {
      expect(deserializeValue(serializeValue(Infinity))).toBe(Infinity)
    })

    it('should handle -Infinity', () => {
      expect(deserializeValue(serializeValue(-Infinity))).toBe(-Infinity)
    })

    it('should handle BigInt', () => {
      expect(deserializeValue(serializeValue(BigInt(123)))).toBe(BigInt(123))
      expect(deserializeValue(serializeValue(BigInt('9007199254740993')))).toBe(
        BigInt('9007199254740993'),
      )
    })

    it('should handle global and well-known symbols', () => {
      const global = Symbol.for('fict.serialize.global')
      const serializedGlobal = JSON.parse(JSON.stringify(serializeValue(global)))
      const serializedIterator = JSON.parse(JSON.stringify(serializeValue(Symbol.iterator)))

      expect(deserializeValue(serializedGlobal)).toBe(global)
      expect(deserializeValue(serializedIterator)).toBe(Symbol.iterator)
    })
  })

  describe('Date', () => {
    it('should serialize and deserialize Date', () => {
      const date = new Date('2024-01-15T12:30:00.000Z')
      const result = deserializeValue(serializeValue(date)) as Date
      expect(result).toBeInstanceOf(Date)
      expect(result.getTime()).toBe(date.getTime())
    })

    it('should handle Date with various times', () => {
      const dates = [
        new Date(0),
        new Date('1999-12-31T23:59:59.999Z'),
        new Date('2050-06-15T00:00:00.000Z'),
      ]
      for (const date of dates) {
        const result = deserializeValue(serializeValue(date)) as Date
        expect(result.getTime()).toBe(date.getTime())
      }
    })
  })

  describe('RegExp', () => {
    it('should serialize and deserialize RegExp', () => {
      const regex = /hello/gi
      const result = deserializeValue(serializeValue(regex)) as RegExp
      expect(result).toBeInstanceOf(RegExp)
      expect(result.source).toBe('hello')
      expect(result.flags).toBe('gi')
    })

    it('should handle complex regex patterns', () => {
      const patterns = [/^[a-z]+$/i, /\d{3}-\d{4}/g, /(?:foo|bar)\s*=\s*(\w+)/gm, /[^\x00-\x7F]/u]
      for (const regex of patterns) {
        const result = deserializeValue(serializeValue(regex)) as RegExp
        expect(result.source).toBe(regex.source)
        expect(result.flags).toBe(regex.flags)
      }
    })
  })

  describe('Map', () => {
    it('should serialize and deserialize empty Map', () => {
      const map = new Map()
      const result = deserializeValue(serializeValue(map)) as Map<unknown, unknown>
      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(0)
    })

    it('should serialize and deserialize Map with primitive keys/values', () => {
      const map = new Map<string, number>([
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ])
      const result = deserializeValue(serializeValue(map)) as Map<string, number>
      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(3)
      expect(result.get('a')).toBe(1)
      expect(result.get('b')).toBe(2)
      expect(result.get('c')).toBe(3)
    })

    it('should serialize and deserialize Map with complex values', () => {
      const map = new Map<string, object>([
        ['date', new Date('2024-01-01')],
        ['regex', /test/i],
        ['nested', { foo: 'bar' }],
      ])
      const result = deserializeValue(serializeValue(map)) as Map<string, unknown>
      expect((result.get('date') as Date).getTime()).toBe(new Date('2024-01-01').getTime())
      expect((result.get('regex') as RegExp).source).toBe('test')
      expect(result.get('nested')).toEqual({ foo: 'bar' })
    })
  })

  describe('Set', () => {
    it('should serialize and deserialize empty Set', () => {
      const set = new Set()
      const result = deserializeValue(serializeValue(set)) as Set<unknown>
      expect(result).toBeInstanceOf(Set)
      expect(result.size).toBe(0)
    })

    it('should serialize and deserialize Set with primitives', () => {
      const set = new Set([1, 2, 3, 'a', 'b'])
      const result = deserializeValue(serializeValue(set)) as Set<number | string>
      expect(result).toBeInstanceOf(Set)
      expect(result.size).toBe(5)
      expect(result.has(1)).toBe(true)
      expect(result.has(2)).toBe(true)
      expect(result.has(3)).toBe(true)
      expect(result.has('a')).toBe(true)
      expect(result.has('b')).toBe(true)
    })

    it('should serialize and deserialize Set with complex values', () => {
      const date = new Date('2024-01-01')
      const set = new Set([date, { foo: 'bar' }])
      const result = deserializeValue(serializeValue(set)) as Set<unknown>
      expect(result.size).toBe(2)
      // Objects become new instances so we check by iteration
      const values = Array.from(result)
      expect((values[0] as Date).getTime()).toBe(date.getTime())
      expect(values[1]).toEqual({ foo: 'bar' })
    })
  })

  describe('arrays', () => {
    it('should serialize and deserialize arrays with mixed types', () => {
      const arr = [1, 'hello', true, null, undefined, NaN, new Date('2024-01-01')]
      const result = deserializeValue(serializeValue(arr)) as unknown[]
      expect(result[0]).toBe(1)
      expect(result[1]).toBe('hello')
      expect(result[2]).toBe(true)
      expect(result[3]).toBe(null)
      expect(result[4]).toBe(undefined)
      expect(Number.isNaN(result[5])).toBe(true)
      expect((result[6] as Date).getTime()).toBe(new Date('2024-01-01').getTime())
    })
  })

  describe('objects', () => {
    it('should serialize and deserialize nested objects', () => {
      const obj = {
        name: 'test',
        count: 42,
        active: true,
        nested: {
          date: new Date('2024-01-01'),
          items: [1, 2, 3],
          map: new Map([['key', 'value']]),
        },
      }
      const result = deserializeValue(serializeValue(obj)) as typeof obj
      expect(result.name).toBe('test')
      expect(result.count).toBe(42)
      expect(result.active).toBe(true)
      expect((result.nested.date as Date).getTime()).toBe(new Date('2024-01-01').getTime())
      expect(result.nested.items).toEqual([1, 2, 3])
      expect(result.nested.map).toBeInstanceOf(Map)
      expect((result.nested.map as Map<string, string>).get('key')).toBe('value')
    })

    it('should serialize symbol values and enumerable symbol keys through JSON', () => {
      const key = Symbol.for('fict.serialize.key')
      const value = Symbol.for('fict.serialize.value')
      const obj: Record<string | symbol, unknown> = {
        a: value,
        [key]: 1,
      }
      const serialized = JSON.parse(JSON.stringify(serializeValue(obj)))
      const result = deserializeValue(serialized) as Record<string | symbol, unknown>

      expect(result.a).toBe(value)
      expect(result[key]).toBe(1)
      expect(Reflect.ownKeys(result)).toEqual(['a', key])
    })
  })

  describe('circular references', () => {
    it('should handle circular object references', () => {
      const obj: Record<string, unknown> = { name: 'root' }
      obj.self = obj
      const result = deserializeValue(serializeValue(obj)) as typeof obj
      expect(result.name).toBe('root')
      expect(result.self).toBe(result) // Same reference
    })

    it('should handle circular array references', () => {
      const arr: unknown[] = [1, 2, 3]
      arr.push(arr)
      const result = deserializeValue(serializeValue(arr)) as unknown[]
      expect(result[0]).toBe(1)
      expect(result[1]).toBe(2)
      expect(result[2]).toBe(3)
      expect(result[3]).toBe(result) // Same reference
    })

    it('should handle deep circular references', () => {
      const a: Record<string, unknown> = { name: 'a' }
      const b: Record<string, unknown> = { name: 'b', parent: a }
      a.child = b
      const result = deserializeValue(serializeValue(a)) as typeof a
      expect(result.name).toBe('a')
      expect((result.child as typeof b).name).toBe('b')
      expect((result.child as typeof b).parent).toBe(result)
    })

    it('should handle multiple references to same object', () => {
      const shared = { value: 42 }
      const obj = {
        a: shared,
        b: shared,
        c: [shared, shared],
      }
      const result = deserializeValue(serializeValue(obj)) as typeof obj
      // All should point to the same deserialized object
      expect(result.a).toBe(result.b)
      expect(result.c[0]).toBe(result.a)
      expect(result.c[1]).toBe(result.a)
      expect(result.a.value).toBe(42)
    })
  })

  describe('functions', () => {
    it('should skip functions during serialization', () => {
      const obj = {
        name: 'test',
        handler: () => console.log('hello'),
        nested: {
          fn: function () {},
        },
      }
      const result = deserializeValue(serializeValue(obj)) as Record<string, unknown>
      expect(result.name).toBe('test')
      expect(result.handler).toBe(undefined)
      expect((result.nested as Record<string, unknown>).fn).toBe(undefined)
    })
  })

  describe('symbols', () => {
    it('should reject local symbols that cannot be restored', () => {
      const localKey = Symbol('local-key')

      expect(() => serializeValue(Symbol('local-value'))).toThrow(/Cannot serialize local symbol/)
      expect(() => serializeValue({ value: Symbol('local-value') })).toThrow(
        /Cannot serialize local symbol/,
      )
      expect(() => serializeValue({ [localKey]: 1 })).toThrow(/Cannot serialize local symbol/)
    })
  })

  describe('edge cases', () => {
    it('should handle empty objects and arrays', () => {
      expect(deserializeValue(serializeValue({}))).toEqual({})
      expect(deserializeValue(serializeValue([]))).toEqual([])
    })

    it('should handle objects with undefined values', () => {
      const obj = { a: 1, b: undefined, c: 3 }
      const result = deserializeValue(serializeValue(obj)) as typeof obj
      expect(result.a).toBe(1)
      expect(result.b).toBe(undefined)
      expect(result.c).toBe(3)
    })

    it('should preserve explicit array undefined entries', () => {
      const arr = [1, undefined, 3]
      const result = deserializeValue(JSON.parse(JSON.stringify(serializeValue(arr)))) as number[]
      expect(result[0]).toBe(1)
      expect(1 in result).toBe(true)
      expect(result[1]).toBe(undefined)
      expect(result[2]).toBe(3)
    })

    it('should preserve sparse array holes through JSON', () => {
      const arr = [1, , 3]
      const result = deserializeValue(JSON.parse(JSON.stringify(serializeValue(arr)))) as number[]

      expect(result).toHaveLength(3)
      expect(0 in result).toBe(true)
      expect(1 in result).toBe(false)
      expect(2 in result).toBe(true)
      expect(Object.keys(result)).toEqual(['0', '2'])
      expect(result[1]).toBeUndefined()
    })
  })
})
