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
const UNINSPECTABLE_TEXT = '[Uninspectable]'

interface SafeReadResult {
  ok: boolean
  value?: unknown
}

function safeRead(target: object, key: PropertyKey): SafeReadResult {
  try {
    let current: object | null = target
    for (let depth = 0; current && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor) {
        return 'value' in descriptor ? { ok: true, value: descriptor.value } : { ok: false }
      }
      current = Object.getPrototypeOf(current)
    }
    return { ok: true, value: undefined }
  } catch {
    return { ok: false }
  }
}

function safeFunctionName(fn: object): string {
  const result = safeRead(fn, 'name')
  return result.ok && typeof result.value === 'string' && result.value ? result.value : 'anonymous'
}

function isInstanceOf(
  value: object,
  constructor: { [Symbol.hasInstance](candidate: unknown): boolean },
): boolean {
  try {
    return value instanceof constructor
  } catch {
    return false
  }
}

function isArray(value: object): boolean {
  try {
    return Array.isArray(value)
  } catch {
    return false
  }
}

function safeConstructorName(value: object): string {
  try {
    let prototype = Object.getPrototypeOf(value)
    for (let depth = 0; prototype && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor')
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'function') {
        const name = safeFunctionName(descriptor.value)
        return name === 'anonymous' ? 'Object' : name
      }
      prototype = Object.getPrototypeOf(prototype)
    }
  } catch {
    // Proxies may reject prototype or descriptor inspection.
  }
  return 'Object'
}

function uninspectableValue(value: object): SerializedValue {
  const constructorName = safeConstructorName(value)
  return {
    type: 'object',
    value: null,
    displayText:
      constructorName === 'Object'
        ? UNINSPECTABLE_TEXT
        : `${constructorName} ${UNINSPECTABLE_TEXT}`,
    expandable: false,
    constructorName,
  }
}

function unreadableProperty(): SerializedValue {
  return {
    type: 'error',
    value: null,
    displayText: '[Unavailable property]',
    expandable: false,
  }
}

function safeStringProperty(value: object, key: PropertyKey, fallback: string): string {
  const result = safeRead(value, key)
  return result.ok && typeof result.value === 'string' ? result.value : fallback
}

function readCollectionSize(value: object, prototype: object): number | null {
  try {
    const getter = Object.getOwnPropertyDescriptor(prototype, 'size')?.get
    if (!getter) return null
    const size = Reflect.apply(getter, value, []) as unknown
    return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : null
  } catch {
    return null
  }
}

/**
 * Serialize a value for safe display in DevTools
 */
export function serialize(value: unknown, depth = 0): SerializedValue {
  // Create a fresh WeakSet for each top-level call to avoid cross-call contamination
  const normalizedDepth = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0
  try {
    return serializeInternal(value, normalizedDepth, new WeakSet<object>())
  } catch {
    return value !== null && (typeof value === 'object' || typeof value === 'function')
      ? uninspectableValue(value as object)
      : { type: 'primitive', value: null, displayText: UNINSPECTABLE_TEXT }
  }
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
    const name = safeFunctionName(fn)
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
      if (isInstanceOf(obj, Date)) {
        const timestamp = Date.prototype.getTime.call(obj)
        if (!Number.isFinite(timestamp)) {
          return {
            type: 'date',
            value: null,
            displayText: 'Invalid Date',
          }
        }
        const iso = new Date(timestamp).toISOString()
        return {
          type: 'date',
          value: iso,
          displayText: iso,
        }
      }

      // RegExp
      if (isInstanceOf(obj, RegExp)) {
        const display = RegExp.prototype.toString.call(obj)
        return {
          type: 'regexp',
          value: display,
          displayText: display,
        }
      }

      // Error
      if (isInstanceOf(obj, Error)) {
        const name = safeStringProperty(obj, 'name', 'Error')
        const message = safeStringProperty(obj, 'message', '')
        const stack = safeStringProperty(obj, 'stack', '') || undefined
        return {
          type: 'error',
          value: {
            name,
            message,
            stack,
          },
          displayText: message ? `${name}: ${message}` : name,
        }
      }

      // Map
      if (isInstanceOf(obj, Map)) {
        const size = readCollectionSize(obj, Map.prototype)
        if (size === null) return uninspectableValue(obj)
        const entries: [string, SerializedValue][] = []
        let count = 0
        for (const [key, val] of Map.prototype.entries.call(obj)) {
          if (count >= MAX_ARRAY_LENGTH) break
          entries.push([formatValueShort(key), serializeInternal(val, depth + 1, seen)])
          count++
        }
        return {
          type: 'map',
          value: entries,
          displayText: `Map(${size})`,
          expandable: size > 0,
          keys: entries.map(e => e[0]),
        }
      }

      // Set
      if (isInstanceOf(obj, Set)) {
        const size = readCollectionSize(obj, Set.prototype)
        if (size === null) return uninspectableValue(obj)
        const items: SerializedValue[] = []
        let count = 0
        for (const item of Set.prototype.values.call(obj)) {
          if (count >= MAX_ARRAY_LENGTH) break
          items.push(serializeInternal(item, depth + 1, seen))
          count++
        }
        return {
          type: 'set',
          value: items,
          displayText: `Set(${size})`,
          expandable: size > 0,
        }
      }

      // Array
      if (isArray(obj)) {
        const lengthResult = safeRead(obj, 'length')
        if (
          !lengthResult.ok ||
          typeof lengthResult.value !== 'number' ||
          !Number.isSafeInteger(lengthResult.value) ||
          lengthResult.value < 0
        ) {
          return uninspectableValue(obj)
        }
        const length = lengthResult.value
        const items: SerializedValue[] = []
        const len = Math.min(length, MAX_ARRAY_LENGTH)
        for (let i = 0; i < len; i++) {
          const item = safeRead(obj, i)
          items.push(
            item.ok ? serializeInternal(item.value, depth + 1, seen) : unreadableProperty(),
          )
        }
        return {
          type: 'array',
          value: items,
          displayText: `Array(${length})`,
          expandable: length > 0,
        }
      }

      // Plain object
      const keys = Object.keys(obj).slice(0, MAX_OBJECT_KEYS)
      const entries = Object.create(null) as Record<string, SerializedValue>
      for (const key of keys) {
        const property = safeRead(obj, key)
        entries[key] = property.ok
          ? serializeInternal(property.value, depth + 1, seen)
          : unreadableProperty()
      }

      const constructorName = safeConstructorName(obj)

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
    } catch {
      return uninspectableValue(obj)
    } finally {
      seen.delete(obj)
    }
  }

  // Unknown type
  return {
    type: 'primitive',
    value: null,
    displayText: UNINSPECTABLE_TEXT,
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
  try {
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

    if (type === 'number' || type === 'boolean') return String(value)
    if (type === 'bigint') return `${value}n`
    if (type === 'symbol') return String(value)
    if (type === 'function') return `ƒ ${safeFunctionName(value as object)}()`

    if (type === 'object') {
      const objectValue = value as object
      if (isArray(objectValue)) {
        const length = safeRead(objectValue, 'length')
        return length.ok &&
          typeof length.value === 'number' &&
          Number.isSafeInteger(length.value) &&
          length.value >= 0
          ? `Array(${length.value})`
          : UNINSPECTABLE_TEXT
      }

      if (isInstanceOf(objectValue, Date)) {
        const timestamp = Date.prototype.getTime.call(objectValue)
        return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : 'Invalid Date'
      }

      if (isInstanceOf(objectValue, Map)) {
        const size = readCollectionSize(objectValue, Map.prototype)
        return size === null ? UNINSPECTABLE_TEXT : `Map(${size})`
      }

      if (isInstanceOf(objectValue, Set)) {
        const size = readCollectionSize(objectValue, Set.prototype)
        return size === null ? UNINSPECTABLE_TEXT : `Set(${size})`
      }

      if (isInstanceOf(objectValue, Error)) {
        const name = safeStringProperty(objectValue, 'name', 'Error')
        const message = safeStringProperty(objectValue, 'message', '')
        return message ? `${name}: ${message}` : name
      }

      const constructorName = safeConstructorName(objectValue)
      if (constructorName !== 'Object') return constructorName
      const keys = Object.keys(objectValue)
      return keys.length <= 3 ? `{${keys.join(', ')}}` : `{${keys.slice(0, 3).join(', ')}, ...}`
    }

    return String(value)
  } catch {
    return UNINSPECTABLE_TEXT
  }
}

/**
 * Get the type name of a value
 */
export function getTypeName(value: unknown): string {
  try {
    if (value === null) return 'null'
    if (value === undefined) return 'undefined'

    const type = typeof value
    if (type !== 'object') return type

    const objectValue = value as object
    if (isArray(objectValue)) return 'array'

    const constructorName = safeConstructorName(objectValue)
    return constructorName === 'Object' ? 'object' : constructorName
  } catch {
    return 'object'
  }
}
