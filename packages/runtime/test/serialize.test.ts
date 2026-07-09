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

    it('should preserve negative zero through JSON', () => {
      const result = deserializeValue(JSON.parse(JSON.stringify(serializeValue(-0)))) as number
      expect(Object.is(result, -0)).toBe(true)
      expect(1 / result).toBe(-Infinity)
    })

    it('should keep positive zero distinct from negative zero', () => {
      const result = deserializeValue(JSON.parse(JSON.stringify(serializeValue(0)))) as number
      expect(Object.is(result, -0)).toBe(false)
      expect(Object.is(result, 0)).toBe(true)
    })

    it('should preserve nested negative zero values through JSON', () => {
      const value = {
        object: -0,
        array: [-0],
        map: new Map([['zero', -0]]),
      }
      const result = deserializeValue(JSON.parse(JSON.stringify(serializeValue(value)))) as {
        object: number
        array: number[]
        map: Map<string, number>
      }

      expect(Object.is(result.object, -0)).toBe(true)
      expect(Object.is(result.array[0], -0)).toBe(true)
      expect(Object.is(result.map.get('zero'), -0)).toBe(true)
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

    it('should reject unknown well-known symbol markers', () => {
      expect(() =>
        deserializeValue({ __t: 'sym', v: { k: 'w', n: 'notAWellKnownSymbol' } }),
      ).toThrow('[fict] Unknown well-known symbol marker at $: notAWellKnownSymbol.')
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

    it('should preserve invalid Date through JSON', () => {
      const date = new Date(NaN)
      const result = deserializeValue(JSON.parse(JSON.stringify(serializeValue(date)))) as Date

      expect(result).toBeInstanceOf(Date)
      expect(Number.isNaN(result.getTime())).toBe(true)
    })

    it('should preserve invalid Date inside arrays through JSON', () => {
      const result = deserializeValue(
        JSON.parse(JSON.stringify(serializeValue([new Date(NaN)]))),
      ) as Date[]

      expect(result[0]).toBeInstanceOf(Date)
      expect(Number.isNaN(result[0]!.getTime())).toBe(true)
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

    it('should preserve RegExp lastIndex through JSON', () => {
      const patterns = [/a/g, /a/y, /a/]
      patterns[0]!.lastIndex = 2
      patterns[1]!.lastIndex = 1
      patterns[2]!.lastIndex = 3

      for (const regex of patterns) {
        const result = deserializeValue(JSON.parse(JSON.stringify(serializeValue(regex)))) as RegExp
        expect(result.source).toBe(regex.source)
        expect(result.flags).toBe(regex.flags)
        expect(result.lastIndex).toBe(regex.lastIndex)
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

  describe('built-in own properties', () => {
    it('should reject supported built-ins with enumerable string properties', () => {
      const date = new Date(0) as Date & { extra: string }
      date.extra = 'date'
      const regex = /a/g as RegExp & { extra: string }
      regex.extra = 'regex'
      const map = new Map([['a', 1]]) as Map<string, number> & { extra: string }
      map.extra = 'map'
      const set = new Set([1]) as Set<number> & { extra: string }
      set.extra = 'set'

      expect(() => serializeValue(date)).toThrow(
        /Cannot serialize Date with enumerable own property at \$\."extra"/,
      )
      expect(() => serializeValue(regex)).toThrow(
        /Cannot serialize RegExp with enumerable own property at \$\."extra"/,
      )
      expect(() => serializeValue(map)).toThrow(
        /Cannot serialize Map with enumerable own property at \$\."extra"/,
      )
      expect(() => serializeValue(set)).toThrow(
        /Cannot serialize Set with enumerable own property at \$\."extra"/,
      )
    })

    it('should reject supported built-ins with enumerable symbol properties', () => {
      const key = Symbol.for('fict.serialize.builtin-extra')
      const date = new Date(0)
      const regex = /a/g
      const map = new Map([['a', 1]])
      const set = new Set([1])

      for (const value of [date, regex, map, set]) {
        Object.defineProperty(value, key, { value: 'x', enumerable: true })
      }

      expect(() => serializeValue(date)).toThrow(
        /Cannot serialize Date with enumerable symbol property at \$\."Symbol\(fict\.serialize\.builtin-extra\)"/,
      )
      expect(() => serializeValue(regex)).toThrow(
        /Cannot serialize RegExp with enumerable symbol property at \$\."Symbol\(fict\.serialize\.builtin-extra\)"/,
      )
      expect(() => serializeValue(map)).toThrow(
        /Cannot serialize Map with enumerable symbol property at \$\."Symbol\(fict\.serialize\.builtin-extra\)"/,
      )
      expect(() => serializeValue(set)).toThrow(
        /Cannot serialize Set with enumerable symbol property at \$\."Symbol\(fict\.serialize\.builtin-extra\)"/,
      )
    })

    it('should reject nested supported built-ins with enumerable own properties', () => {
      const date = new Date(0) as Date & { extra: string }
      date.extra = 'date'
      const map = new Map([['a', 1]]) as Map<string, number> & { extra: string }
      map.extra = 'map'
      const set = new Set([1]) as Set<number> & { extra: string }
      set.extra = 'set'

      expect(() => serializeValue({ date })).toThrow(
        /Cannot serialize Date with enumerable own property at \$\."date"\."extra"/,
      )
      expect(() => serializeValue(new Map([['map', map]]))).toThrow(
        /Cannot serialize Map with enumerable own property at \$\.v0\."extra"/,
      )
      expect(() => serializeValue(new Set([set]))).toThrow(
        /Cannot serialize Set with enumerable own property at \$\[0\]\."extra"/,
      )
    })

    it('should ignore non-enumerable properties on supported built-ins', () => {
      const key = Symbol.for('fict.serialize.builtin-hidden')
      const date = new Date(0) as Date & Record<string | symbol, unknown>
      const regex = /a/g as RegExp & Record<string | symbol, unknown>
      const map = new Map([['a', 1]]) as Map<string, number> & Record<string | symbol, unknown>
      const set = new Set([1]) as Set<number> & Record<string | symbol, unknown>

      for (const value of [date, regex, map, set]) {
        Object.defineProperty(value, 'extra', { value: 'x', enumerable: false })
        Object.defineProperty(value, key, { value: 'symbol', enumerable: false })
      }

      const restoredDate = deserializeValue(
        JSON.parse(JSON.stringify(serializeValue(date))),
      ) as Date & Record<string | symbol, unknown>
      const restoredRegex = deserializeValue(
        JSON.parse(JSON.stringify(serializeValue(regex))),
      ) as RegExp & Record<string | symbol, unknown>
      const restoredMap = deserializeValue(JSON.parse(JSON.stringify(serializeValue(map)))) as Map<
        string,
        number
      > &
        Record<string | symbol, unknown>
      const restoredSet = deserializeValue(
        JSON.parse(JSON.stringify(serializeValue(set))),
      ) as Set<number> & Record<string | symbol, unknown>

      expect(restoredDate.getTime()).toBe(0)
      expect(restoredRegex.source).toBe('a')
      expect(restoredRegex.flags).toBe('g')
      expect(restoredMap.get('a')).toBe(1)
      expect(restoredSet.has(1)).toBe(true)

      for (const value of [restoredDate, restoredRegex, restoredMap, restoredSet]) {
        expect(value.extra).toBeUndefined()
        expect(value[key]).toBeUndefined()
      }
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

    it('should reject dense arrays with enumerable non-index properties', () => {
      const arr = [1] as unknown[] & { extra: string }
      arr.extra = 'x'

      expect(() => serializeValue(arr)).toThrow(
        /Cannot serialize array with enumerable non-index property at \$\."extra"/,
      )
    })

    it('should reject sparse arrays with enumerable non-index properties', () => {
      const arr = [1, , 3] as unknown[] & { extra: string }
      arr.extra = 'x'

      expect(() => serializeValue(arr)).toThrow(
        /Cannot serialize array with enumerable non-index property at \$\."extra"/,
      )
    })

    it('should reject arrays with enumerable symbol properties', () => {
      const key = Symbol.for('fict.serialize.array-extra')
      const arr = [1]
      Object.defineProperty(arr, key, { value: 'x', enumerable: true })

      expect(() => serializeValue(arr)).toThrow(
        /Cannot serialize array with enumerable symbol property at \$\."Symbol\(fict\.serialize\.array-extra\)"/,
      )
    })

    it('should ignore non-enumerable array properties', () => {
      const key = Symbol.for('fict.serialize.array-hidden')
      const arr = [1] as unknown[] & Record<string | symbol, unknown>
      Object.defineProperty(arr, 'extra', { value: 'x', enumerable: false })
      Object.defineProperty(arr, key, { value: 'symbol', enumerable: false })

      const result = deserializeValue(JSON.parse(JSON.stringify(serializeValue(arr)))) as unknown[]

      expect(result).toEqual([1])
      expect(Object.keys(result)).toEqual(['0'])
      expect((result as Record<string, unknown>).extra).toBeUndefined()
      expect((result as Record<symbol, unknown>)[key]).toBeUndefined()
    })

    it('should reject nested arrays with enumerable non-index properties', () => {
      const objectArray = [1] as unknown[] & { extra: string }
      objectArray.extra = 'object'
      const mapArray = [2] as unknown[] & { extra: string }
      mapArray.extra = 'map'
      const setArray = [3] as unknown[] & { extra: string }
      setArray.extra = 'set'

      expect(() => serializeValue({ arr: objectArray })).toThrow(
        /Cannot serialize array with enumerable non-index property at \$\."arr"\."extra"/,
      )
      expect(() => serializeValue(new Map([['arr', mapArray]]))).toThrow(
        /Cannot serialize array with enumerable non-index property at \$\.v0\."extra"/,
      )
      expect(() => serializeValue(new Set([setArray]))).toThrow(
        /Cannot serialize array with enumerable non-index property at \$\[0\]\."extra"/,
      )
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

    it('should escape marker-like plain objects', () => {
      const values = [
        { __t: 'u' },
        { __t: 'n' },
        { __t: 'd', v: 0 },
        { __t: 'm', v: [] },
        { __t: 'plain', v: 1 },
      ]

      for (const value of values) {
        const result = deserializeValue(JSON.parse(JSON.stringify(serializeValue(value))))
        expect(result).toEqual(value)
      }
    })

    it('should escape nested marker-like objects', () => {
      const obj = {
        nested: { __t: 'u' },
        list: [{ __t: 'd', v: 0 }],
      }
      const result = deserializeValue(JSON.parse(JSON.stringify(serializeValue(obj)))) as typeof obj

      expect(result).toEqual(obj)
    })

    it('should ignore inherited serialization markers', () => {
      const snapshot = Object.assign(Object.create({ __t: 'u' }) as Record<string, unknown>, {
        safe: 1,
      })

      expect(deserializeValue(snapshot)).toEqual({ safe: 1 })
    })

    it('should preserve own __proto__ data properties during serialization', () => {
      const obj = JSON.parse('{"__proto__":{"polluted":true},"a":1}') as Record<string, unknown>

      const serialized = serializeValue(obj) as Record<string, unknown>
      const result = deserializeValue(JSON.parse(JSON.stringify(serialized))) as Record<
        string,
        unknown
      >

      expect(Object.prototype.hasOwnProperty.call(serialized, '__proto__')).toBe(true)
      expect(Object.getPrototypeOf(serialized)).toBe(Object.prototype)
      expect(
        (Object.getPrototypeOf(serialized) as Record<string, unknown>).polluted,
      ).toBeUndefined()
      expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true)
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
      expect((Object.getPrototypeOf(result) as Record<string, unknown>).polluted).toBeUndefined()
      expect((result.__proto__ as Record<string, unknown>).polluted).toBe(true)
      expect(result.a).toBe(1)
    })

    it('should preserve own __proto__ keys from parsed snapshots', () => {
      const snapshot = JSON.parse('{"__proto__":{"polluted":true},"a":1}')
      const result = deserializeValue(snapshot) as Record<string, unknown>

      expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true)
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
      expect((Object.getPrototypeOf(result) as Record<string, unknown>).polluted).toBeUndefined()
      expect((result.__proto__ as Record<string, unknown>).polluted).toBe(true)
      expect((result as Record<string, unknown>).polluted).toBeUndefined()
      expect(result.a).toBe(1)
    })

    it('should preserve nested __proto__ keys from parsed snapshots', () => {
      const snapshot = JSON.parse('{"nested":{"__proto__":{"polluted":true},"a":1}}')
      const result = deserializeValue(snapshot) as {
        nested: Record<string, unknown>
      }

      expect(Object.prototype.hasOwnProperty.call(result.nested, '__proto__')).toBe(true)
      expect(Object.getPrototypeOf(result.nested)).toBe(Object.prototype)
      expect(
        (Object.getPrototypeOf(result.nested) as Record<string, unknown>).polluted,
      ).toBeUndefined()
      expect((result.nested.__proto__ as Record<string, unknown>).polluted).toBe(true)
      expect(result.nested.a).toBe(1)
    })

    it('should preserve primitive __proto__ values and constructor controls', () => {
      const snapshot = JSON.parse('{"__proto__":"value","constructor":{"safe":true}}')
      const result = deserializeValue(snapshot) as Record<string, unknown>

      expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true)
      expect(result.__proto__).toBe('value')
      expect(result.constructor).toEqual({ safe: true })
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    })

    it('should preserve null-prototype objects', () => {
      const obj = Object.create(null) as Record<string, unknown>
      obj.a = 1

      const result = deserializeValue(JSON.parse(JSON.stringify(serializeValue(obj)))) as Record<
        string,
        unknown
      >

      expect(Object.getPrototypeOf(result)).toBe(null)
      expect(result.a).toBe(1)
      expect('toString' in result).toBe(false)
    })

    it('should preserve nested null-prototype objects', () => {
      const child = Object.create(null) as Record<string, unknown>
      child.a = 1
      const obj = { child }

      const result = deserializeValue(JSON.parse(JSON.stringify(serializeValue(obj)))) as {
        child: Record<string, unknown>
      }

      expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
      expect(Object.getPrototypeOf(result.child)).toBe(null)
      expect(result.child.a).toBe(1)
      expect('toString' in result.child).toBe(false)
    })

    it('should preserve marker-like keys on null-prototype objects', () => {
      const obj = Object.create(null) as Record<string, unknown>
      obj.__t = 'u'
      obj.value = 1

      const result = deserializeValue(JSON.parse(JSON.stringify(serializeValue(obj)))) as Record<
        string,
        unknown
      >

      expect(Object.getPrototypeOf(result)).toBe(null)
      expect(result.__t).toBe('u')
      expect(result.value).toBe(1)
      expect('toString' in result).toBe(false)
    })

    it('should keep ordinary objects on Object.prototype', () => {
      const result = deserializeValue(
        JSON.parse(JSON.stringify(serializeValue({ a: 1 }))),
      ) as Record<string, unknown>

      expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
      expect(result.a).toBe(1)
      expect('toString' in result).toBe(true)
    })

    it('should serialize plain accessor objects as current values', () => {
      const obj = {
        get value() {
          return 2
        },
      }
      const result = deserializeValue(JSON.parse(JSON.stringify(serializeValue(obj)))) as Record<
        string,
        unknown
      >

      expect(result).toEqual({ value: 2 })
    })

    it('should reject unsupported object prototypes', () => {
      class Box {
        v = 3
      }

      const values = [
        new Box(),
        new URL('https://example.com/a?b=1'),
        new Error('boom'),
        new Uint8Array([1, 2]),
      ]

      for (const value of values) {
        expect(() => serializeValue(value)).toThrow(/Cannot serialize unsupported object/)
      }
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

    it('should reject references to missing snapshot paths', () => {
      expect(() => deserializeValue({ __t: 'ref', v: '$.missing' })).toThrow(
        '[fict] Invalid snapshot reference at $: $.missing.',
      )
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

    it('should preserve shared Date and RegExp references', () => {
      const date = new Date(0)
      const invalidDate = new Date(NaN)
      const regex = /a/g
      regex.lastIndex = 1
      const obj = {
        dateA: date,
        dateB: date,
        invalidA: invalidDate,
        invalidB: invalidDate,
        regexA: regex,
        regexB: regex,
        nested: { date, regex },
        array: [date, regex],
        map: new Map<string, Date | RegExp>([
          ['date', date],
          ['regex', regex],
        ]),
        set: new Set([regex]),
      }

      const result = deserializeValue(JSON.parse(JSON.stringify(serializeValue(obj)))) as {
        dateA: Date
        dateB: Date
        invalidA: Date
        invalidB: Date
        regexA: RegExp
        regexB: RegExp
        nested: { date: Date; regex: RegExp }
        array: [Date, RegExp]
        map: Map<string, Date | RegExp>
        set: Set<RegExp>
      }

      expect(result.dateB).toBe(result.dateA)
      expect(result.nested.date).toBe(result.dateA)
      expect(result.array[0]).toBe(result.dateA)
      expect(result.map.get('date')).toBe(result.dateA)
      expect(result.dateA.getTime()).toBe(0)

      expect(result.invalidB).toBe(result.invalidA)
      expect(Number.isNaN(result.invalidA.getTime())).toBe(true)

      expect(result.regexB).toBe(result.regexA)
      expect(result.nested.regex).toBe(result.regexA)
      expect(result.array[1]).toBe(result.regexA)
      expect(result.map.get('regex')).toBe(result.regexA)
      expect(Array.from(result.set)[0]).toBe(result.regexA)
      expect(result.regexA.source).toBe('a')
      expect(result.regexA.flags).toBe('g')
      expect(result.regexA.lastIndex).toBe(1)
    })

    it('should keep references distinct for dotted object keys', () => {
      const shared1 = { id: 'one' }
      const shared2 = { id: 'two' }
      const obj = {
        'a.b': shared1,
        a: { b: shared2 },
        x: shared1,
        y: shared2,
      }

      const result = deserializeValue(JSON.parse(JSON.stringify(serializeValue(obj)))) as {
        'a.b': { id: string }
        a: { b: { id: string } }
        x: { id: string }
        y: { id: string }
      }

      expect(result.x).toBe(result['a.b'])
      expect(result.y).toBe(result.a.b)
      expect(result.x).not.toBe(result.a.b)
      expect(result.x.id).toBe('one')
      expect(result.y.id).toBe('two')
    })

    it('should keep references distinct for bracket-like and empty object keys', () => {
      const empty = { id: 'empty' }
      const bracket = { id: 'bracket' }
      const indexed = { id: 'indexed' }
      const obj = {
        '': empty,
        '[0]': bracket,
        'items[0]': indexed,
        empty,
        bracket,
        indexed,
      }

      const result = deserializeValue(JSON.parse(JSON.stringify(serializeValue(obj)))) as {
        '': { id: string }
        '[0]': { id: string }
        'items[0]': { id: string }
        empty: { id: string }
        bracket: { id: string }
        indexed: { id: string }
      }

      expect(result.empty).toBe(result[''])
      expect(result.bracket).toBe(result['[0]'])
      expect(result.indexed).toBe(result['items[0]'])
      expect(result.empty).not.toBe(result.bracket)
      expect(result.bracket).not.toBe(result.indexed)
    })

    it('should keep string and symbol-key reference paths distinct', () => {
      const symbolKey = Symbol.for('fict.serialize.path')
      const aliasKey = Symbol.for('fict.serialize.alias')
      const stringValue = { id: 'string' }
      const symbolValue = { id: 'symbol' }
      const obj: Record<string | symbol, unknown> = {
        'Symbol(fict.serialize.path)': stringValue,
        [symbolKey]: symbolValue,
        [aliasKey]: stringValue,
      }

      const result = deserializeValue(JSON.parse(JSON.stringify(serializeValue(obj)))) as Record<
        string | symbol,
        { id: string }
      >

      expect(result[aliasKey]).toBe(result['Symbol(fict.serialize.path)'])
      expect(result[aliasKey]).not.toBe(result[symbolKey])
      expect(result[aliasKey]?.id).toBe('string')
      expect(result[symbolKey]?.id).toBe('symbol')
    })

    it('should restore self-references under dotted object keys', () => {
      const dotted: Record<string, unknown> = { name: 'dotted' }
      dotted.self = dotted
      const nested = { name: 'nested' }
      const obj = {
        'a.b': dotted,
        a: { b: nested },
        x: dotted,
      }

      const result = deserializeValue(JSON.parse(JSON.stringify(serializeValue(obj)))) as {
        'a.b': { name: string; self: unknown }
        a: { b: { name: string } }
        x: { name: string; self: unknown }
      }

      expect(result.x).toBe(result['a.b'])
      expect(result.x.self).toBe(result['a.b'])
      expect(result.x).not.toBe(result.a.b)
      expect(result.x.name).toBe('dotted')
      expect(result.a.b.name).toBe('nested')
    })
  })

  describe('functions', () => {
    it('should reject top-level functions during serialization', () => {
      expect(() => serializeValue(() => 'hello')).toThrow(/Cannot serialize function at \$/)
    })

    it('should reject function properties during serialization', () => {
      const obj = {
        name: 'test',
        handler: () => console.log('hello'),
        nested: {
          fn: function () {},
        },
      }

      expect(() => serializeValue(obj)).toThrow(/Cannot serialize function at \$\."handler"/)
      expect(() => serializeValue({ nested: obj.nested })).toThrow(
        /Cannot serialize function at \$\."nested"\."fn"/,
      )
    })

    it('should reject array function entries during serialization', () => {
      expect(() => serializeValue([() => 'x'])).toThrow(/Cannot serialize function at \$\[0\]/)
    })

    it('should reject map function keys and values during serialization', () => {
      expect(() => serializeValue(new Map([[() => 'key', 'value']]))).toThrow(
        /Cannot serialize function at \$\.k0/,
      )
      expect(() => serializeValue(new Map([['key', () => 'value']]))).toThrow(
        /Cannot serialize function at \$\.v0/,
      )
    })

    it('should reject set function entries during serialization', () => {
      expect(() => serializeValue(new Set([() => 'x']))).toThrow(
        /Cannot serialize function at \$\[0\]/,
      )
    })

    it('should keep explicit undefined distinct from rejected functions', () => {
      const result = deserializeValue(
        JSON.parse(JSON.stringify(serializeValue([undefined, { value: undefined }]))),
      ) as [undefined, { value: undefined }]

      expect(0 in result).toBe(true)
      expect(result[0]).toBe(undefined)
      expect(result[1].value).toBe(undefined)
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
