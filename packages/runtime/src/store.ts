import { signal, batch, type SignalAccessor } from './signal'

const PROXY = Symbol('fict:store-proxy')
const TARGET = Symbol('fict:store-target')
const ITERATE_KEY = Symbol('fict:iterate')

// ============================================================================
// Store (Deep Proxy)
// ============================================================================

export type Store<T> = T

/**
 * Create a Store: a reactive proxy that allows fine-grained access and mutation.
 *
 * @param initialValue - The initial state object
 * @returns [store, setStore]
 */
export function createStore<T extends object>(
  initialValue: T,
): [Store<T>, (fn: (state: T) => void | T) => void] {
  const unwrapped = unwrap(initialValue)
  const wrapped = wrap(unwrapped)

  function setStore(fn: (state: T) => void | T) {
    batch(() => {
      const result = fn(wrapped)
      if (result !== undefined) {
        reconcile(wrapped, result)
      }
    })
  }

  return [wrapped, setStore]
}

// Map of target object -> Proxy
const proxyCache = new WeakMap<object, unknown>()
// Map of target object -> Map<key, Signal>
const signalCache = new WeakMap<object, Map<string | symbol, SignalAccessor<unknown>>>()
// Map of target object -> monotonically increasing iterate version
const iterateVersionCache = new WeakMap<object, number>()

function getIterateVersion(target: object): number {
  return iterateVersionCache.get(target) ?? 0
}

function bumpIterateVersion(target: object): number {
  const next = getIterateVersion(target) + 1
  iterateVersionCache.set(target, next)
  return next
}

function isArrayIndexKey(prop: string | symbol): prop is string {
  if (typeof prop !== 'string') return false
  const index = Number(prop)
  return Number.isInteger(index) && index >= 0 && String(index) === prop
}

function wrap<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Reflect.get(value, PROXY)) return value

  if (proxyCache.has(value)) return proxyCache.get(value) as T

  const handler: ProxyHandler<object> = {
    get(target, prop, receiver) {
      if (prop === PROXY) return true
      if (prop === TARGET) return target

      const value = Reflect.get(target, prop, receiver)

      // Track property access
      track(target, prop)

      // Recursively wrap objects
      return wrap(value)
    },
    has(target, prop) {
      const result = Reflect.has(target, prop)
      track(target, prop)
      return result
    },
    ownKeys(target) {
      track(target, ITERATE_KEY)
      return Reflect.ownKeys(target)
    },
    getOwnPropertyDescriptor(target, prop) {
      track(target, prop)
      return Reflect.getOwnPropertyDescriptor(target, prop)
    },
    set(target, prop, value, receiver) {
      if (prop === PROXY || prop === TARGET) return false

      const isArrayLength = Array.isArray(target) && prop === 'length'
      const isArrayIndex = Array.isArray(target) && isArrayIndexKey(prop)
      const oldLength =
        (isArrayLength || isArrayIndex) && Array.isArray(target) ? target.length : undefined
      const hadKey = Object.prototype.hasOwnProperty.call(target, prop)
      const oldValue = Reflect.get(target, prop, receiver)
      if (oldValue === value) return true

      const result = Reflect.set(target, prop, value, receiver)
      if (result) {
        trigger(target, prop)
        if (!hadKey) {
          trigger(target, ITERATE_KEY)
        }
        if (isArrayIndex) {
          const nextLength = target.length
          if (typeof oldLength === 'number' && nextLength !== oldLength) {
            trigger(target, 'length')
          }
        }
        if (isArrayLength) {
          const nextLength = target.length
          if (typeof oldLength === 'number' && nextLength < oldLength) {
            const signals = signalCache.get(target)
            if (signals) {
              for (const key of signals.keys()) {
                if (typeof key !== 'string') continue
                const index = Number(key)
                if (!Number.isInteger(index) || String(index) !== key) continue
                if (index >= nextLength && index < oldLength) {
                  trigger(target, key)
                }
              }
            }
          }
          trigger(target, ITERATE_KEY)
        }
      }
      return result
    },
    deleteProperty(target, prop) {
      const hadKey = Object.prototype.hasOwnProperty.call(target, prop)
      const result = Reflect.deleteProperty(target, prop)
      if (result) {
        trigger(target, prop)
        if (hadKey) {
          trigger(target, ITERATE_KEY)
        }
      }
      return result
    },
  }

  const proxy = new Proxy(value, handler)
  proxyCache.set(value, proxy)
  return proxy as T
}

function unwrap<T>(value: T): T {
  if (value && typeof value === 'object' && Reflect.get(value, PROXY)) {
    return Reflect.get(value, TARGET) as T
  }
  return value
}

export function isStoreProxy(value: unknown): boolean {
  return !!(value && typeof value === 'object' && Reflect.get(value as object, PROXY))
}

export function unwrapStore<T>(value: T): T {
  return unwrap(value)
}

function track(target: object, prop: string | symbol) {
  let signals = signalCache.get(target)
  if (!signals) {
    signals = new Map()
    signalCache.set(target, signals)
  }

  let s = signals.get(prop)
  if (!s) {
    const initial = prop === ITERATE_KEY ? getIterateVersion(target) : getLastValue(target, prop)
    s = signal(initial)
    signals.set(prop, s)
  }
  s() // subscribe
}

function trigger(target: object, prop: string | symbol) {
  const signals = signalCache.get(target)
  if (signals) {
    const s = signals.get(prop)
    if (s) {
      if (prop === ITERATE_KEY) {
        s(bumpIterateVersion(target))
      } else {
        s(getLastValue(target, prop)) // notify with new value
      }
    }
  }
}

function getLastValue(target: object, prop: string | symbol) {
  return Reflect.get(target, prop)
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isReconcilableObject(value: unknown): value is object {
  if (value === null || typeof value !== 'object') return false
  const raw = unwrap(value as object)
  return Array.isArray(raw) || isPlainObject(raw)
}

function canReconcileNestedValues(current: unknown, next: unknown): current is object {
  if (!isReconcilableObject(current) || !isReconcilableObject(next)) return false
  const currentRaw = unwrap(current as object)
  const nextRaw = unwrap(next as object)
  return Array.isArray(currentRaw) === Array.isArray(nextRaw)
}

/**
 * Reconcile a store path with a new value (recursive structural diff)
 */
function reconcile(target: object, value: unknown, seenPairs?: WeakMap<object, WeakSet<object>>) {
  if (target === value) return
  if (value === null || typeof value !== 'object') {
    throw new Error(
      `[Fict] Cannot replace store with primitive value: ${String(
        value,
      )}. setStore should return an object/array to merge.`,
    )
  }

  const realTarget = unwrap(target)
  const realValue = unwrap(value)
  const seen = seenPairs ?? new WeakMap<object, WeakSet<object>>()
  let visitedValues = seen.get(realTarget)
  if (!visitedValues) {
    visitedValues = new WeakSet<object>()
    seen.set(realTarget, visitedValues)
  }
  if (visitedValues.has(realValue)) return
  visitedValues.add(realValue)

  const keys = new Set([...Object.keys(realTarget), ...Object.keys(realValue)])
  for (const key of keys) {
    const rTarget = realTarget as Record<string, unknown>
    const rValue = realValue as Record<string, unknown>
    const hasCurrent = Object.prototype.hasOwnProperty.call(rTarget, key)
    const hasNext = Object.prototype.hasOwnProperty.call(rValue, key)
    const current = rTarget[key]
    const next = rValue[key]

    if (!hasNext && hasCurrent) {
      // deleted
      delete (target as Record<string, unknown>)[key] // Triggers proxy trap
    } else if (hasNext && (!hasCurrent || current !== next)) {
      if (canReconcileNestedValues(current, next)) {
        reconcile((target as Record<string, unknown>)[key] as object, next, seen)
      } else {
        ;(target as Record<string, unknown>)[key] = next // Triggers proxy trap
      }
    }
  }

  // Fix array length if needed
  if (
    Array.isArray(realTarget) &&
    Array.isArray(realValue) &&
    realTarget.length !== realValue.length
  ) {
    ;(target as unknown as unknown[]).length = realValue.length
  }
}

// ============================================================================
// Diffing Signal (for List Items)
// ============================================================================

/**
 * Creates a signal that returns a Stable Proxy.
 * Updates to the signal (via set) will diff the new value against the old value
 * and trigger property-specific updates.
 */
export function createDiffingSignal<T extends object>(initialValue: T) {
  let currentValue = unwrap(initialValue)
  const signals = new Map<string | symbol, SignalAccessor<unknown>>()
  let iterateSignal: SignalAccessor<number> | undefined
  let iterateVersion = 0
  let ownKeysSnapshot = Reflect.ownKeys(currentValue as object)

  const hasSameOwnKeys = (aKeys: (string | symbol)[], bKeys: (string | symbol)[]): boolean => {
    if (aKeys.length !== bKeys.length) return false
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false
    }
    return true
  }

  const getPropSignal = (prop: string | symbol) => {
    let s = signals.get(prop)
    if (!s) {
      s = signal(Reflect.get(currentValue as object, prop))
      signals.set(prop, s)
    }
    return s
  }

  const trackIterate = () => {
    if (!iterateSignal) {
      iterateSignal = signal(iterateVersion)
    }
    iterateSignal()
  }

  const bumpIterate = () => {
    if (!iterateSignal) return
    iterateVersion += 1
    iterateSignal(iterateVersion)
  }

  const updateIterateFromOwnKeys = (next: object): void => {
    const nextKeys = Reflect.ownKeys(next)
    const changed = !hasSameOwnKeys(ownKeysSnapshot, nextKeys)
    ownKeysSnapshot = nextKeys
    if (changed) {
      bumpIterate()
    }
  }

  // The stable proxy we return
  const proxy = new Proxy({} as T, {
    get(_, prop) {
      if (prop === PROXY) return true
      if (prop === TARGET) return currentValue

      // Subscribe to property
      const s = getPropSignal(prop)
      return s()
    },
    ownKeys() {
      trackIterate()
      return Reflect.ownKeys(currentValue)
    },
    has(target, prop) {
      getPropSignal(prop)()
      return Reflect.has(currentValue, prop)
    },
    getOwnPropertyDescriptor(target, prop) {
      getPropSignal(prop)()
      const descriptor = Reflect.getOwnPropertyDescriptor(currentValue, prop)
      if (!descriptor) return undefined

      // Proxy target is a synthetic empty object. Returning a non-configurable
      // descriptor from the wrapped value can violate Proxy invariants.
      if (descriptor.configurable !== false) {
        return descriptor
      }

      if ('value' in descriptor) {
        return {
          configurable: true,
          enumerable: descriptor.enumerable ?? true,
          writable: descriptor.writable ?? true,
          value: descriptor.value,
        }
      }

      const normalized: PropertyDescriptor = {
        configurable: true,
        enumerable: descriptor.enumerable ?? true,
      }
      if (descriptor.get) normalized.get = descriptor.get
      if (descriptor.set) normalized.set = descriptor.set
      return normalized
    },
    set(_, prop) {
      throw new Error(
        `[Fict] Cannot set "${String(
          prop,
        )}" on a diffing signal proxy directly. Update the source value and call its writer instead.`,
      )
    },
  })

  const read = () => proxy

  const write = (newValue: T) => {
    const next = unwrap(newValue)
    const prev = currentValue
    currentValue = next

    if (prev === next) {
      // Same ref update: re-evaluate all tracked signals
      // This is necessary for in-place mutations
      for (const [prop, s] of signals) {
        const newVal = Reflect.get(next as object, prop)
        s(newVal)
      }
      updateIterateFromOwnKeys(next as object)
      return
    }

    // Diff logic
    // We only trigger signals for properties that exist in our cache (tracked)
    // and have changed.
    for (const [prop, s] of signals) {
      const oldVal = Reflect.get(prev as object, prop)
      const newVal = Reflect.get(next as object, prop)
      if (oldVal !== newVal) {
        s(newVal)
      }
    }
    updateIterateFromOwnKeys(next as object)

    // Note: If new properties appeared that weren't tracked, we don't care
    // because no one is listening.
    // If we assume shape stability (Keyed List), this is efficient.
  }

  return [read, write] as const
}
