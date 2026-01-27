/**
 * @fileoverview Deep reactive store implementation for Fict.
 *
 * $store creates a deeply reactive proxy that tracks property access at the path level.
 * Unlike $state (which is shallow), $store allows direct mutation of nested properties.
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

/** Track if we've warned about direct mutation for a specific target+property */
const MUTATION_WARNED = new WeakMap<object, Set<string | symbol>>()

/** Properties to skip for direct mutation warning (built-in/internal properties) */
const SKIP_MUTATION_WARNING_PROPS = new Set<string | symbol>([
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
])

/** Cache of signals per object property */
const SIGNAL_CACHE = new WeakMap<object, Record<string | symbol, Signal<unknown>>>()

/** Cache of bound methods to preserve function identity across reads */
const BOUND_METHOD_CACHE = new WeakMap<object, Map<string | symbol, BoundMethodEntry>>()

/** Special key for tracking iteration (Object.keys, for-in, etc.) */
const ITERATE_KEY = Symbol('iterate')

/**
 * Get or create a signal for a specific property on a target object.
 * @internal
 */
function getSignal(target: object, prop: string | symbol): Signal<unknown> {
  let signals = SIGNAL_CACHE.get(target)
  if (!signals) {
    signals = {}
    SIGNAL_CACHE.set(target, signals)
  }
  if (!signals[prop]) {
    const initial = prop === ITERATE_KEY ? 0 : (target as IndexableObject)[prop]
    signals[prop] = createSignal(initial)
  }
  return signals[prop]
}

/**
 * Trigger iteration signal to notify consumers that keys have changed.
 * @internal
 */
function triggerIteration(target: object): void {
  const signals = SIGNAL_CACHE.get(target)
  if (signals && signals[ITERATE_KEY]) {
    const current = signals[ITERATE_KEY]() as number
    signals[ITERATE_KEY](current + 1)
  }
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

      // Always touch the signal so reference changes to this property are tracked,
      // even if the value is an object we proxy further.
      const signal = getSignal(target, prop)
      const trackedValue = signal()

      const currentValue = Reflect.get(target, prop, receiver ?? proxy)

      // Remove "read-time write" - direct mutation is now undefined behavior
      // In dev mode, warn once per property if we detect the underlying object was mutated directly
      if (isDev && currentValue !== trackedValue && !SKIP_MUTATION_WARNING_PROPS.has(prop)) {
        let warnedProps = MUTATION_WARNED.get(target)
        if (!warnedProps) {
          warnedProps = new Set()
          MUTATION_WARNED.set(target, warnedProps)
        }
        if (!warnedProps.has(prop)) {
          warnedProps.add(prop)
          console.warn(
            `[fict] $store detected direct mutation of underlying object for property "${String(prop)}". ` +
              `This is undefined behavior. Always mutate through the store proxy, not the original object.`,
          )
        }
      }

      if (typeof currentValue === 'function') {
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
        return $store(currentValue as Record<string, unknown>)
      }

      // For primitives (and functions), we return the signal value (which tracks the read)
      return currentValue
    },

    set(target, prop, newValue, receiver) {
      const oldLength = Array.isArray(target) && prop === 'length' ? target.length : undefined
      const oldValue = Reflect.get(target, prop, receiver)
      const hadKey = Object.prototype.hasOwnProperty.call(target, prop)

      // If value hasn't changed, do nothing
      if (oldValue === newValue && hadKey) {
        return true
      }

      const result = Reflect.set(target, prop, newValue, receiver)

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
      if (signals && signals[prop]) {
        signals[prop](newValue)
      }

      // If new property, trigger iteration update
      if (!hadKey) {
        triggerIteration(target)
      }

      // Ensure array length subscribers are notified even if the native push/pop
      // doesn't trigger a separate set trap for "length" (defensive).
      if (Array.isArray(target) && prop !== 'length') {
        const signals = SIGNAL_CACHE.get(target)
        if (signals && signals.length) {
          signals.length(target.length)
        }
      }

      // If it's an array and length changed implicitly, we might need to handle it.
      if (Array.isArray(target) && prop === 'length') {
        const nextLength = target.length
        if (typeof oldLength === 'number' && nextLength < oldLength) {
          const signals = SIGNAL_CACHE.get(target)
          if (signals) {
            for (let i = nextLength; i < oldLength; i += 1) {
              const key = String(i)
              if (signals[key]) {
                signals[key](undefined)
              }
            }
          }
        }
        triggerIteration(target)
      }

      return result
    },

    deleteProperty(target, prop) {
      const hadKey = Object.prototype.hasOwnProperty.call(target, prop)
      const result = Reflect.deleteProperty(target, prop)

      if (result && hadKey) {
        const signals = SIGNAL_CACHE.get(target)
        if (signals && signals[prop]) {
          signals[prop](undefined)
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
      getSignal(target, prop)()
      return Reflect.has(target, prop)
    },
  })

  PROXY_CACHE.set(initialValue, proxy)
  // Register reverse lookup for double-wrap prevention
  RAW_TO_PROXY.set(initialValue, proxy)
  return proxy
}
