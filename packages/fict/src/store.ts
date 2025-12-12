import { createSignal, type Signal } from '@fictjs/runtime'

type AnyFn = (...args: unknown[]) => unknown
interface BoundMethodEntry {
  ref: AnyFn
  bound: AnyFn
}

const PROXY_CACHE = new WeakMap<object, unknown>()
const SIGNAL_CACHE = new WeakMap<object, Record<string | symbol, Signal<unknown>>>()
const BOUND_METHOD_CACHE = new WeakMap<object, Map<string | symbol, BoundMethodEntry>>()
const ITERATE_KEY = Symbol('iterate')

function getSignal(target: object, prop: string | symbol): Signal<unknown> {
  let signals = SIGNAL_CACHE.get(target)
  if (!signals) {
    signals = {}
    SIGNAL_CACHE.set(target, signals)
  }
  if (!signals[prop]) {
    const initial = prop === ITERATE_KEY ? 0 : (target as Record<string | symbol, unknown>)[prop]
    signals[prop] = createSignal(initial)
  }
  return signals[prop]
}

function triggerIteration(target: object) {
  const signals = SIGNAL_CACHE.get(target)
  if (signals && signals[ITERATE_KEY]) {
    const current = signals[ITERATE_KEY]() as number
    signals[ITERATE_KEY](current + 1)
  }
}

export function $store<T extends object>(initialValue: T): T {
  if (typeof initialValue !== 'object' || initialValue === null) {
    return initialValue
  }

  if (PROXY_CACHE.has(initialValue)) {
    return PROXY_CACHE.get(initialValue) as T
  }

  const proxy = new Proxy(initialValue, {
    get(target, prop, receiver) {
      // Always touch the signal so reference changes to this property are tracked,
      // even if the value is an object we proxy further.
      const signal = getSignal(target, prop)
      const trackedValue = signal()

      const currentValue = Reflect.get(target, prop, receiver ?? proxy)
      if (currentValue !== trackedValue) {
        // If the value has changed (e.g. via direct mutation of the underlying object not via proxy),
        // we update the signal to keep it in sync.
        // Note: This is a bit of a heuristic. Ideally all mutations go through proxy.
        signal(currentValue)
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

      // If the value is an object/array, we recursively wrap it in a store
      if (typeof currentValue === 'object' && currentValue !== null) {
        return $store(currentValue as Record<string, unknown>)
      }

      // For primitives (and functions), we return the signal value (which tracks the read)
      return currentValue
    },

    set(target, prop, newValue, receiver) {
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
          signals.length((target as unknown as { length: number }).length)
        }
      }

      // If it's an array and length changed implicitly, we might need to handle it.
      // But usually 'length' is set explicitly or handled by the runtime.
      if (Array.isArray(target) && prop === 'length') {
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
  return proxy
}
