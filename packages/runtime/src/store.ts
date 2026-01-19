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
const proxyCache = new WeakMap<object, any>()
// Map of target object -> Map<key, Signal>
const signalCache = new WeakMap<object, Map<string | symbol, SignalAccessor<any>>>()

function wrap<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if ((value as any)[PROXY]) return value

  if (proxyCache.has(value)) return proxyCache.get(value)

  const handler: ProxyHandler<any> = {
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
      const oldLength = isArrayLength ? target.length : undefined
      const hadKey = Object.prototype.hasOwnProperty.call(target, prop)
      const oldValue = Reflect.get(target, prop, receiver)
      if (oldValue === value) return true

      const result = Reflect.set(target, prop, value, receiver)
      if (result) {
        trigger(target, prop)
        if (!hadKey) {
          trigger(target, ITERATE_KEY)
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
  if (value && typeof value === 'object' && (value as any)[PROXY]) {
    return (value as any)[TARGET]
  }
  return value
}

function track(target: object, prop: string | symbol) {
  let signals = signalCache.get(target)
  if (!signals) {
    signals = new Map()
    signalCache.set(target, signals)
  }

  let s = signals.get(prop)
  if (!s) {
    const initial =
      prop === ITERATE_KEY ? (Reflect.ownKeys(target).length as number) : getLastValue(target, prop)
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
        s(Reflect.ownKeys(target).length)
      } else {
        s(getLastValue(target, prop)) // notify with new value
      }
    }
  }
}

function getLastValue(target: any, prop: string | symbol) {
  return target[prop]
}

/**
 * Reconcile a store path with a new value (shallow merge/diff)
 */
function reconcile(target: any, value: any) {
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

  const keys = new Set([...Object.keys(realTarget), ...Object.keys(realValue)])
  for (const key of keys) {
    if (realValue[key] === undefined && realTarget[key] !== undefined) {
      // deleted
      delete target[key] // Triggers proxy trap
    } else if (realTarget[key] !== realValue[key]) {
      target[key] = realValue[key] // Triggers proxy trap
    }
  }

  // Fix array length if needed
  if (Array.isArray(target) && target.length !== realValue.length) {
    target.length = realValue.length
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
  const signals = new Map<string | symbol, SignalAccessor<any>>()
  let iterateSignal: SignalAccessor<number> | undefined

  const getPropSignal = (prop: string | symbol) => {
    let s = signals.get(prop)
    if (!s) {
      s = signal((currentValue as any)[prop])
      signals.set(prop, s)
    }
    return s
  }

  const trackIterate = () => {
    if (!iterateSignal) {
      iterateSignal = signal(Reflect.ownKeys(currentValue).length)
    }
    iterateSignal()
  }

  const updateIterate = (value: T) => {
    if (iterateSignal) {
      iterateSignal(Reflect.ownKeys(value).length)
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
      return Reflect.getOwnPropertyDescriptor(currentValue, prop)
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
        const newVal = (next as any)[prop]
        s(newVal)
      }
      updateIterate(next)
      return
    }

    // Diff logic
    // We only trigger signals for properties that exist in our cache (tracked)
    // and have changed.
    for (const [prop, s] of signals) {
      const oldVal = (prev as any)[prop]
      const newVal = (next as any)[prop]
      if (oldVal !== newVal) {
        s(newVal)
      }
    }
    updateIterate(next)

    // Note: If new properties appeared that weren't tracked, we don't care
    // because no one is listening.
    // If we assume shape stability (Keyed List), this is efficient.
  }

  return [read, write] as const
}
