import { createSignal, type Signal } from 'fict-runtime'

const PROXY_CACHE = new WeakMap<object, any>()
const SIGNAL_CACHE = new WeakMap<object, Record<string | symbol, Signal<any>>>()

function getSignal(target: object, prop: string | symbol): Signal<any> {
  let signals = SIGNAL_CACHE.get(target)
  if (!signals) {
    signals = {}
    SIGNAL_CACHE.set(target, signals)
  }
  if (!signals[prop]) {
    signals[prop] = createSignal((target as any)[prop])
  }
  return signals[prop]
}

export function $store<T extends object>(initialValue: T): T {
  if (typeof initialValue !== 'object' || initialValue === null) {
    return initialValue
  }

  if (PROXY_CACHE.has(initialValue)) {
    return PROXY_CACHE.get(initialValue)
  }

  const proxy = new Proxy(initialValue, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)

      // If it's a function (e.g. array methods), just return it bound to the proxy
      // Note: For array mutation methods (push, pop), we might need more complex handling
      // to trigger length updates or specific index updates.
      // For now, we rely on the fact that array mutations usually touch 'length' or indices.
      // However, standard Array methods on a Proxy might not trigger setters for all internal changes
      // if not handled carefully.
      //
      // A simple strategy for arrays: if we access a method, we might want to return a wrapped method
      // that triggers updates. But let's start with simple property access tracking.

      // If the value is an object/array, we recursively wrap it in a store
      if (typeof value === 'object' && value !== null) {
        // We don't track the *access* to the object itself (unless we want to track reference changes),
        // but we return a proxy so that *its* properties are tracked.
        // However, if we replace `store.user = newValue`, the parent setter handles that.
        return $store(value)
      }

      // For primitives, we return the signal value (which tracks the read)
      const signal = getSignal(target, prop)
      return signal()
    },

    set(target, prop, newValue, receiver) {
      const oldValue = Reflect.get(target, prop, receiver)

      // If value hasn't changed, do nothing
      if (oldValue === newValue) {
        return true
      }

      const result = Reflect.set(target, prop, newValue, receiver)

      // Update the signal if it exists
      const signals = SIGNAL_CACHE.get(target)
      if (signals && signals[prop]) {
        signals[prop](newValue)
      }

      // If it's an array and we set an index, we might also need to trigger 'length' if it changed implicitly?
      // Reflect.set handles the actual object update.
      // If we set `arr[10] = 1`, length changes. The proxy should intercept 'length' set too if it happens explicitly.
      // If it happens implicitly, we might miss it unless we check.
      if (Array.isArray(target) && prop !== 'length') {
        // If length changed, we should probably trigger length signal
        // But let's see if the runtime does this automatically via Reflect.set
        // (Reflect.set on array index often triggers length set if it expands)
      }

      return result
    },

    deleteProperty(target, prop) {
      const result = Reflect.deleteProperty(target, prop)
      const signals = SIGNAL_CACHE.get(target)
      if (signals && signals[prop]) {
        // What to set it to? undefined?
        signals[prop](undefined)
      }
      return result
    },
  })

  PROXY_CACHE.set(initialValue, proxy)
  return proxy
}
