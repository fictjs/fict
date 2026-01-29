/**
 * Value Serializer
 *
 * Safely serializes JavaScript values for display in DevTools
 */

import type { SerializedValue } from './types'

const MAX_STRING_LENGTH = 500
const MAX_ARRAY_LENGTH = 100
const MAX_OBJECT_KEYS = 50
const MAX_DEPTH = 5

/**
 * Serialize a value for safe display in DevTools
 */
export function serialize(value: unknown, depth = 0): SerializedValue {
  // Create a fresh WeakSet for each top-level call to avoid cross-call contamination
  return serializeInternal(value, depth, new WeakSet<object>())
}

/**
 * Internal serialization with circular reference tracking
 */
function serializeInternal(value: unknown, depth: number, seen: WeakSet<object>): SerializedValue {
  // Handle null
  if (value === null) {
    return { type: 'null', value: null, displayText: 'null' }
  }

  // Handle undefined
  if (value === undefined) {
    return { type: 'undefined', value: undefined, displayText: 'undefined' }
  }

  const type = typeof value

  // Primitives
  if (type === 'string') {
    const str = value as string
    const truncated = str.length > MAX_STRING_LENGTH ? str.slice(0, MAX_STRING_LENGTH) + '...' : str
    return {
      type: 'primitive',
      value: truncated,
      displayText: JSON.stringify(truncated),
    }
  }

  if (type === 'number' || type === 'boolean') {
    return {
      type: 'primitive',
      value,
      displayText: String(value),
    }
  }

  if (type === 'bigint') {
    return {
      type: 'bigint',
      value: String(value),
      displayText: `${value}n`,
    }
  }

  if (type === 'symbol') {
    return {
      type: 'symbol',
      value: String(value),
      displayText: String(value),
    }
  }

  if (type === 'function') {
    const fn = value as (...args: unknown[]) => unknown
    const name = fn.name || 'anonymous'
    return {
      type: 'function',
      value: null,
      displayText: `ƒ ${name}()`,
    }
  }

  // Objects
  if (type === 'object') {
    const obj = value as object

    // Check for circular reference
    if (seen.has(obj)) {
      return {
        type: 'circular',
        value: null,
        displayText: '[Circular]',
      }
    }

    // Check depth limit
    if (depth >= MAX_DEPTH) {
      return {
        type: 'object',
        value: null,
        displayText: '[Object]',
        expandable: true,
      }
    }

    seen.add(obj)

    try {
      // Date
      if (obj instanceof Date) {
        return {
          type: 'date',
          value: obj.toISOString(),
          displayText: obj.toISOString(),
        }
      }

      // RegExp
      if (obj instanceof RegExp) {
        return {
          type: 'regexp',
          value: obj.toString(),
          displayText: obj.toString(),
        }
      }

      // Error
      if (obj instanceof Error) {
        return {
          type: 'error',
          value: {
            name: obj.name,
            message: obj.message,
            stack: obj.stack,
          },
          displayText: `${obj.name}: ${obj.message}`,
        }
      }

      // Map
      if (obj instanceof Map) {
        const entries: [string, SerializedValue][] = []
        let count = 0
        for (const [key, val] of obj) {
          if (count >= MAX_ARRAY_LENGTH) break
          entries.push([String(key), serializeInternal(val, depth + 1, seen)])
          count++
        }
        return {
          type: 'map',
          value: entries,
          displayText: `Map(${obj.size})`,
          expandable: obj.size > 0,
          keys: entries.map(e => e[0]),
        }
      }

      // Set
      if (obj instanceof Set) {
        const items: SerializedValue[] = []
        let count = 0
        for (const item of obj) {
          if (count >= MAX_ARRAY_LENGTH) break
          items.push(serializeInternal(item, depth + 1, seen))
          count++
        }
        return {
          type: 'set',
          value: items,
          displayText: `Set(${obj.size})`,
          expandable: obj.size > 0,
        }
      }

      // Array
      if (Array.isArray(obj)) {
        const items: SerializedValue[] = []
        const len = Math.min(obj.length, MAX_ARRAY_LENGTH)
        for (let i = 0; i < len; i++) {
          items.push(serializeInternal(obj[i], depth + 1, seen))
        }
        return {
          type: 'array',
          value: items,
          displayText: `Array(${obj.length})`,
          expandable: obj.length > 0,
        }
      }

      // Plain object
      const keys = Object.keys(obj).slice(0, MAX_OBJECT_KEYS)
      const entries: Record<string, SerializedValue> = {}
      for (const key of keys) {
        entries[key] = serializeInternal((obj as Record<string, unknown>)[key], depth + 1, seen)
      }

      const constructorName = obj.constructor?.name || 'Object'

      return {
        type: 'object',
        value: entries,
        displayText:
          constructorName === 'Object'
            ? `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', ...' : ''}}`
            : constructorName,
        expandable: keys.length > 0,
        keys,
        constructorName,
      }
    } finally {
      seen.delete(obj)
    }
  }

  // Unknown type
  return {
    type: 'primitive',
    value: String(value),
    displayText: String(value),
  }
}

/**
 * Deserialize a value from DevTools input
 */
export function deserialize(input: string): unknown {
  const trimmed = input.trim()

  // Handle special values
  if (trimmed === 'undefined') return undefined
  if (trimmed === 'null') return null
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'NaN') return NaN
  if (trimmed === 'Infinity') return Infinity
  if (trimmed === '-Infinity') return -Infinity

  // Handle bigint
  if (/^-?\d+n$/.test(trimmed)) {
    return BigInt(trimmed.slice(0, -1))
  }

  // Handle number
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) {
    return Number(trimmed)
  }

  // Try JSON parse
  try {
    return JSON.parse(trimmed)
  } catch {
    // Return as string if not valid JSON
    return trimmed
  }
}

/**
 * Format a value for display (short version)
 */
export function formatValueShort(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'

  const type = typeof value

  if (type === 'string') {
    const str = value as string
    if (str.length > 50) {
      return JSON.stringify(str.slice(0, 50) + '...')
    }
    return JSON.stringify(str)
  }

  if (type === 'number' || type === 'boolean') {
    return String(value)
  }

  if (type === 'bigint') {
    return `${value}n`
  }

  if (type === 'symbol') {
    return String(value)
  }

  if (type === 'function') {
    return `ƒ ${(value as (...args: unknown[]) => unknown).name || 'anonymous'}()`
  }

  if (Array.isArray(value)) {
    return `Array(${value.length})`
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (value instanceof Map) {
    return `Map(${value.size})`
  }

  if (value instanceof Set) {
    return `Set(${value.size})`
  }

  if (value instanceof Error) {
    return `${value.name}: ${value.message}`
  }

  if (type === 'object') {
    const constructor = (value as object).constructor?.name
    if (constructor && constructor !== 'Object') {
      return constructor
    }
    const keys = Object.keys(value as object)
    if (keys.length <= 3) {
      return `{${keys.join(', ')}}`
    }
    return `{${keys.slice(0, 3).join(', ')}, ...}`
  }

  return String(value)
}

/**
 * Get the type name of a value
 */
export function getTypeName(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'

  const type = typeof value

  if (type !== 'object') {
    return type
  }

  if (Array.isArray(value)) {
    return 'array'
  }

  const constructor = (value as object).constructor?.name
  return constructor || 'object'
}
