/**
 * @fileoverview Deep reactive store implementation for Fict.
 *
 * `$store` creates a deeply reactive proxy that tracks property access at the path level.
 * It is the only user-facing deep store API. Runtime `createStore` remains an
 * internal compiler/resume helper; application code should import `$store`.
 *
 * @example
 * ```typescript
 * const user = $store({ name: 'Alice', address: { city: 'London' } })
 * user.address.city = 'Paris' // Fine-grained reactive update
 * ```
 */

import { createSignal, type Signal } from '@fictjs/runtime/advanced'

/** Function type for bound methods */
type AnyFn = (...args: unknown[]) => unknown

/** Cache entry for bound methods to preserve identity */
interface BoundMethodEntry {
  ref: AnyFn
  bound: AnyFn
}

/** Type for objects with indexable properties */
type IndexableObject = Record<string | symbol, unknown>

/** Symbol to mark proxies and prevent double-wrapping */
const IS_STORE_PROXY = Symbol('fict-store-proxy')

/** WeakSet to track raw objects that have been proxied (for reverse lookup) */
const RAW_TO_PROXY = new WeakMap<object, object>()

/** Cache of proxied objects to avoid duplicate proxies */
const PROXY_CACHE = new WeakMap<object, unknown>()

/** Dev mode detection */
const isDev =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process === 'undefined' || process.env?.NODE_ENV !== 'production'

/** Track if we've warned about direct mutation for a target object */
const MUTATION_WARNED = new WeakSet<object>()

/** Properties to skip for direct mutation warning (built-in/internal properties) */
const SKIP_MUTATION_WARNING_PROPS: (string | symbol)[] = [
  'constructor',
  'prototype',
  '__proto__',
  'toString',
  'valueOf',
  'toLocaleString',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  Symbol.toStringTag,
  Symbol.iterator,
  Symbol.toPrimitive,
]

type SignalBucket = Record<string | symbol, Signal<unknown>>
type PresenceSignalBucket = Record<string | symbol, Signal<boolean>>
interface DescriptorSignalEntry {
  signal: Signal<number>
  version: number
}

type DescriptorSignalBucket = Record<string | symbol, DescriptorSignalEntry>

/** Cache of signals per object property */
const SIGNAL_CACHE = new WeakMap<object, SignalBucket>()

/** Cache of property-presence signals used by the `in` operator. */
const PRESENCE_SIGNAL_CACHE = new WeakMap<object, PresenceSignalBucket>()

/** Cache of descriptor-version signals used by reflection APIs. */
const DESCRIPTOR_SIGNAL_CACHE = new WeakMap<object, DescriptorSignalBucket>()

/** Cache of bound methods to preserve function identity across reads */
const BOUND_METHOD_CACHE = new WeakMap<object, Map<string | symbol, BoundMethodEntry>>()

/** Suppress defineProperty notifications caused by the set trap's Reflect.set receiver path. */
const DEFINE_NOTIFICATION_SUPPRESSIONS = new WeakMap<object, Set<string | symbol>>()

/** Special key for tracking iteration (Object.keys, for-in, etc.) */
const ITERATE_KEY = Symbol('iterate')

/** Tokens used to invalidate a value signal without evaluating an accessor. */
const ACCESSOR_INVALIDATIONS = new WeakSet<object>()

function createAccessorInvalidation(): object {
  const token = {}
  ACCESSOR_INVALIDATIONS.add(token)
  return token
}

function isAccessorInvalidation(value: unknown): boolean {
  return typeof value === 'object' && value !== null && ACCESSOR_INVALIDATIONS.has(value)
}

/**
 * Get or create a signal for a specific property on a target object.
 * @internal
 */
function getSignal(
  target: object,
  prop: string | symbol,
  initialValue?: unknown,
  useProvidedInitial = false,
): Signal<unknown> {
  let signals = SIGNAL_CACHE.get(target)
  if (!signals) {
    signals = Object.create(null) as SignalBucket
    SIGNAL_CACHE.set(target, signals)
  }
  if (!Object.prototype.hasOwnProperty.call(signals, prop)) {
    const initial =
      prop === ITERATE_KEY
        ? 0
        : useProvidedInitial
          ? initialValue
          : (target as IndexableObject)[prop]
    signals[prop] = createSignal(initial)
  }
  return signals[prop]!
}

function getCachedSignal(
  signals: SignalBucket | undefined,
  prop: string | symbol,
): Signal<unknown> | undefined {
  if (!signals || !Object.prototype.hasOwnProperty.call(signals, prop)) return undefined
  return signals[prop]!
}

/**
 * Get or create a signal that tracks whether a property exists on a target.
 * Presence must be tracked separately from value so an own `undefined` key can
 * be distinguished from a missing key.
 * @internal
 */
function getPresenceSignal(target: object, prop: string | symbol): Signal<boolean> {
  let signals = PRESENCE_SIGNAL_CACHE.get(target)
  if (!signals) {
    signals = Object.create(null) as PresenceSignalBucket
    PRESENCE_SIGNAL_CACHE.set(target, signals)
  }
  if (!Object.prototype.hasOwnProperty.call(signals, prop)) {
    signals[prop] = createSignal(Reflect.has(target, prop))
  }
  return signals[prop]!
}

/** Notify `in` subscribers when a property's presence changes. */
function triggerPresence(target: object, prop: string | symbol): void {
  const signals = PRESENCE_SIGNAL_CACHE.get(target)
  if (!signals || !Object.prototype.hasOwnProperty.call(signals, prop)) return
  signals[prop]!(Reflect.has(target, prop))
}

/** Get or create a version signal for an own-property descriptor. */
function getDescriptorSignal(target: object, prop: string | symbol): Signal<number> {
  let signals = DESCRIPTOR_SIGNAL_CACHE.get(target)
  if (!signals) {
    signals = Object.create(null) as DescriptorSignalBucket
    DESCRIPTOR_SIGNAL_CACHE.set(target, signals)
  }
  if (!Object.prototype.hasOwnProperty.call(signals, prop)) {
    signals[prop] = { signal: createSignal(0), version: 0 }
  }
  return signals[prop]!.signal
}

/** Notify descriptor consumers without reading the property's value. */
function triggerDescriptor(target: object, prop: string | symbol): void {
  const signals = DESCRIPTOR_SIGNAL_CACHE.get(target)
  if (!signals || !Object.prototype.hasOwnProperty.call(signals, prop)) return
  const entry = signals[prop]!
  entry.version += 1
  entry.signal(entry.version)
}

/**
 * Trigger iteration signal to notify consumers that keys have changed.
 * @internal
 */
function triggerIteration(target: object): void {
  const signals = SIGNAL_CACHE.get(target)
  const signal = getCachedSignal(signals, ITERATE_KEY)
  if (signal) {
    const current = signal() as number
    signal(current + 1)
  }
}

function getPropertyDescriptor(
  target: object,
  prop: string | symbol,
): PropertyDescriptor | undefined {
  let current: object | null = target
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, prop)
    if (descriptor) return descriptor
    current = Object.getPrototypeOf(current)
  }
  return undefined
}

function canSkipSameValueSet(
  target: object,
  prop: string | symbol,
  descriptor: PropertyDescriptor | undefined,
): boolean {
  return (
    !!descriptor &&
    Object.prototype.hasOwnProperty.call(target, prop) &&
    'value' in descriptor &&
    descriptor.writable === true
  )
}

function mustReturnExactDataValue(target: object, prop: string | symbol): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(target, prop)
  return !!descriptor && 'value' in descriptor && !descriptor.configurable && !descriptor.writable
}

function suppressDefineNotification(target: object, prop: string | symbol): () => void {
  let suppressions = DEFINE_NOTIFICATION_SUPPRESSIONS.get(target)
  if (!suppressions) {
    suppressions = new Set()
    DEFINE_NOTIFICATION_SUPPRESSIONS.set(target, suppressions)
  }
  suppressions.add(prop)
  return () => {
    const current = DEFINE_NOTIFICATION_SUPPRESSIONS.get(target)
    if (!current) return
    current.delete(prop)
    if (current.size === 0) {
      DEFINE_NOTIFICATION_SUPPRESSIONS.delete(target)
    }
  }
}

function isDefineNotificationSuppressed(target: object, prop: string | symbol): boolean {
  return DEFINE_NOTIFICATION_SUPPRESSIONS.get(target)?.has(prop) ?? false
}

function descriptorShapeChanged(
  before: PropertyDescriptor | undefined,
  after: PropertyDescriptor | undefined,
): boolean {
  if (!before || !after) return before !== after
  if (before.enumerable !== after.enumerable || before.configurable !== after.configurable) {
    return true
  }

  const beforeIsData = 'value' in before
  const afterIsData = 'value' in after
  if (beforeIsData !== afterIsData) return true
  if (beforeIsData && afterIsData) return before.writable !== after.writable
  return before.get !== after.get || before.set !== after.set
}

function descriptorContentChanged(
  before: PropertyDescriptor | undefined,
  after: PropertyDescriptor | undefined,
): boolean {
  if (descriptorShapeChanged(before, after)) return true
  if (!before || !after) return false
  if ('value' in before && 'value' in after) return before.value !== after.value
  return false
}

/**
 * Only arrays and plain records support transparent deep proxying. Branded
 * platform objects and class instances rely on their original receiver for
 * internal slots/private fields and are therefore treated as opaque values.
 */
function isWrappableStoreObject(value: object): boolean {
  if (Array.isArray(value)) return true
  const prototype = Object.getPrototypeOf(value)
  if (prototype === null || prototype === Object.prototype) return true

  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')
  return !constructor || constructor.value === Object
}

/**
 * Create a deep reactive store using Proxy.
 *
 * Unlike `$state` (which is shallow and compiler-transformed), `$store` provides:
 * - **Deep reactivity**: Nested objects are automatically wrapped in proxies
 * - **Direct mutation**: Modify properties directly without spread operators
 * - **Path-level tracking**: Only components reading changed paths re-render
 *
 * @param initialValue - The initial object to make reactive
 * @returns A reactive proxy of the object
 *
 * @example
 * ```tsx
 * import { $store } from 'fict'
 *
 * const form = $store({
 *   user: { name: '', email: '' },
 *   settings: { theme: 'light' }
 * })
 *
 * // Direct mutation works
 * form.user.name = 'Alice'
 *
 * // In JSX - only updates when form.user.name changes
 * <input value={form.user.name} />
 * ```
 *
 * @public
 */
export function $store<T extends object>(initialValue: T): T {
  if (typeof initialValue !== 'object' || initialValue === null) {
    return initialValue
  }

  // Prevent double-wrapping - if already a store proxy, return as-is
  if ((initialValue as IndexableObject)[IS_STORE_PROXY]) {
    return initialValue
  }

  if (!isWrappableStoreObject(initialValue)) {
    return initialValue
  }

  // Check if this object was already wrapped (reverse lookup)
  if (RAW_TO_PROXY.has(initialValue)) {
    return RAW_TO_PROXY.get(initialValue) as T
  }

  if (PROXY_CACHE.has(initialValue)) {
    return PROXY_CACHE.get(initialValue) as T
  }

  const proxy = new Proxy(initialValue, {
    get(target, prop, receiver) {
      // Return true for IS_STORE_PROXY to identify this as a store proxy
      if (prop === IS_STORE_PROXY) {
        return true
      }

      const currentValue = Reflect.get(target, prop, receiver ?? proxy)
      // Always touch the signal so reference changes to this property are tracked,
      // even if the value is an object we proxy further.
      const signal = getSignal(target, prop, currentValue, true)
      const trackedValue = signal()

      // Remove "read-time write" - direct mutation is now undefined behavior
      // In dev mode, warn once per object if we detect the underlying object was mutated directly
      if (
        isDev &&
        currentValue !== trackedValue &&
        !isAccessorInvalidation(trackedValue) &&
        !SKIP_MUTATION_WARNING_PROPS.includes(prop) &&
        !MUTATION_WARNED.has(target)
      ) {
        MUTATION_WARNED.add(target)
        console.warn(`[fict] Use $store for ${String(prop)}.`)
      }

      if (typeof currentValue === 'function') {
        if (mustReturnExactDataValue(target, prop)) {
          return currentValue
        }

        let boundMethods = BOUND_METHOD_CACHE.get(target)
        if (!boundMethods) {
          boundMethods = new Map()
          BOUND_METHOD_CACHE.set(target, boundMethods)
        }
        const cached = boundMethods.get(prop)
        if (cached && cached.ref === currentValue) {
          return cached.bound
        }

        const bound = (currentValue as AnyFn).bind(receiver ?? proxy)
        boundMethods.set(prop, { ref: currentValue as AnyFn, bound })
        return bound
      }
      {
        const boundMethods = BOUND_METHOD_CACHE.get(target)
        if (boundMethods && boundMethods.has(prop)) {
          boundMethods.delete(prop)
          if (boundMethods.size === 0) {
            BOUND_METHOD_CACHE.delete(target)
          }
        }
      }

      // If the value is an object/array, we recursively wrap it in a store
      if (typeof currentValue === 'object' && currentValue !== null) {
        if (mustReturnExactDataValue(target, prop)) {
          return currentValue
        }

        return $store(currentValue as Record<string, unknown>)
      }

      // For primitives (and functions), we return the signal value (which tracks the read)
      return currentValue
    },

    set(target, prop, newValue, receiver) {
      const oldLength = Array.isArray(target) ? target.length : undefined
      const hadKey = Object.prototype.hasOwnProperty.call(target, prop)
      const oldOwnDescriptor = Reflect.getOwnPropertyDescriptor(target, prop)
      const descriptor = getPropertyDescriptor(target, prop)

      // Same-value assignment is only inert for own writable data properties.
      if (canSkipSameValueSet(target, prop, descriptor)) {
        const oldValue = Reflect.get(target, prop, receiver)
        if (oldValue === newValue && hadKey) {
          return true
        }
      }

      const releaseDefineSuppression = suppressDefineNotification(target, prop)
      let result: boolean
      try {
        result = Reflect.set(target, prop, newValue, receiver)
      } finally {
        releaseDefineSuppression()
      }
      if (!result) {
        return false
      }

      // IMPORTANT: Clear bound method cache BEFORE updating the signal
      const boundMethods = BOUND_METHOD_CACHE.get(target)
      if (boundMethods && boundMethods.has(prop)) {
        boundMethods.delete(prop)
        if (boundMethods.size === 0) {
          BOUND_METHOD_CACHE.delete(target)
        }
      }

      // Update the signal if it exists
      const signals = SIGNAL_CACHE.get(target)
      const signal = getCachedSignal(signals, prop)
      if (signal) {
        let nextValue = newValue
        if (descriptor && !('value' in descriptor)) {
          try {
            nextValue = Reflect.get(target, prop, receiver)
          } catch {
            nextValue = newValue
          }
        }
        signal(nextValue)
      }
      triggerPresence(target, prop)
      const nextOwnDescriptor = Reflect.getOwnPropertyDescriptor(target, prop)
      if (descriptorContentChanged(oldOwnDescriptor, nextOwnDescriptor)) {
        triggerDescriptor(target, prop)
      }

      // If new property, trigger iteration update
      if (!hadKey) {
        triggerIteration(target)
      }

      // Ensure array length subscribers are notified even if the native push/pop
      // doesn't trigger a separate set trap for "length" (defensive).
      if (Array.isArray(target) && prop !== 'length') {
        const lengthSignal = getCachedSignal(signals, 'length')
        if (lengthSignal) {
          lengthSignal(target.length)
        }
        if (target.length !== oldLength) {
          triggerDescriptor(target, 'length')
        }
      }

      // If it's an array and length changed implicitly, we might need to handle it.
      if (Array.isArray(target) && prop === 'length') {
        const nextLength = target.length
        if (typeof oldLength === 'number' && nextLength < oldLength) {
          for (let i = nextLength; i < oldLength; i += 1) {
            const key = String(i)
            const signal = getCachedSignal(signals, key)
            if (signal) {
              signal(undefined)
            }
            triggerPresence(target, key)
            triggerDescriptor(target, key)
          }
        }
        triggerIteration(target)
      }

      return result
    },

    deleteProperty(target, prop) {
      const hadKey = Object.prototype.hasOwnProperty.call(target, prop)
      const result = Reflect.deleteProperty(target, prop)

      if (result) {
        triggerPresence(target, prop)
        if (hadKey) {
          triggerDescriptor(target, prop)
        }
      }

      if (result && hadKey) {
        const signals = SIGNAL_CACHE.get(target)
        const signal = getCachedSignal(signals, prop)
        if (signal) {
          signal(undefined)
        }

        // Clear bound method cache
        const boundMethods = BOUND_METHOD_CACHE.get(target)
        if (boundMethods && boundMethods.has(prop)) {
          boundMethods.delete(prop)
          if (boundMethods.size === 0) {
            BOUND_METHOD_CACHE.delete(target)
          }
        }

        triggerIteration(target)
      }

      return result
    },

    ownKeys(target) {
      getSignal(target, ITERATE_KEY)()
      return Reflect.ownKeys(target)
    },

    has(target, prop) {
      getPresenceSignal(target, prop)()
      return Reflect.has(target, prop)
    },

    getOwnPropertyDescriptor(target, prop) {
      getDescriptorSignal(target, prop)()
      getSignal(target, ITERATE_KEY)()
      return Reflect.getOwnPropertyDescriptor(target, prop)
    },

    defineProperty(target, prop, descriptor) {
      const hadKey = Object.prototype.hasOwnProperty.call(target, prop)
      const oldLength = Array.isArray(target) ? target.length : undefined
      const oldDescriptor = Reflect.getOwnPropertyDescriptor(target, prop)
      const result = Reflect.defineProperty(target, prop, descriptor)

      if (!result || isDefineNotificationSuppressed(target, prop)) {
        return result
      }

      const nextDescriptor = Reflect.getOwnPropertyDescriptor(target, prop)
      const hasKey = Object.prototype.hasOwnProperty.call(target, prop)
      const signals = SIGNAL_CACHE.get(target)
      const signal = getCachedSignal(signals, prop)
      if (signal) {
        const nextValue =
          nextDescriptor && 'value' in nextDescriptor
            ? nextDescriptor.value
            : createAccessorInvalidation()
        signal(nextValue)
      }
      triggerPresence(target, prop)

      const shapeChanged = descriptorShapeChanged(oldDescriptor, nextDescriptor)
      if (descriptorContentChanged(oldDescriptor, nextDescriptor)) {
        triggerDescriptor(target, prop)
      }
      if (hadKey !== hasKey || shapeChanged) {
        triggerIteration(target)
      }

      if (Array.isArray(target)) {
        const lengthSignal = getCachedSignal(signals, 'length')
        if (target.length !== oldLength) {
          if (lengthSignal) {
            lengthSignal(target.length)
          }
          triggerDescriptor(target, 'length')
        }

        if (prop === 'length' && typeof oldLength === 'number' && target.length < oldLength) {
          for (let i = target.length; i < oldLength; i += 1) {
            const indexSignal = getCachedSignal(signals, String(i))
            if (indexSignal) {
              indexSignal(undefined)
            }
            triggerPresence(target, String(i))
            triggerDescriptor(target, String(i))
          }
          triggerIteration(target)
        }
      }

      const boundMethods = BOUND_METHOD_CACHE.get(target)
      if (boundMethods && boundMethods.has(prop)) {
        boundMethods.delete(prop)
        if (boundMethods.size === 0) {
          BOUND_METHOD_CACHE.delete(target)
        }
      }

      return result
    },
  })

  PROXY_CACHE.set(initialValue, proxy)
  // Register reverse lookup for double-wrap prevention
  RAW_TO_PROXY.set(initialValue, proxy)
  return proxy
}
