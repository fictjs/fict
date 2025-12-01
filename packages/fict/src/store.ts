import { createSignal, type Signal } from 'fict-runtime'

type AnyFn = (...args: unknown[]) => unknown
interface BoundMethodEntry {
  ref: AnyFn
  bound: AnyFn
}

const PROXY_CACHE = new WeakMap<object, unknown>()
const SIGNAL_CACHE = new WeakMap<object, Record<string | symbol, Signal<unknown>>>()
const BOUND_METHOD_CACHE = new WeakMap<object, Map<string | symbol, BoundMethodEntry>>()

function getSignal(target: object, prop: string | symbol): Signal<unknown> {
  let signals = SIGNAL_CACHE.get(target)
  if (!signals) {
    signals = {}
    SIGNAL_CACHE.set(target, signals)
  }
  if (!signals[prop]) {
    const initial = (target as Record<string | symbol, unknown>)[prop]
    signals[prop] = createSignal(initial)
  }
  return signals[prop]
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
      if (typeof currentValue === 'object' && currentValue !== null) {
        return $store(currentValue as Record<string, unknown>)
      }

      // For primitives (and functions), we return the signal value (which tracks the read)
      return currentValue
    },

    set(target, prop, newValue, receiver) {
      const oldValue = Reflect.get(target, prop, receiver)

      // If value hasn't changed, do nothing
      if (oldValue === newValue) {
        return true
      }

      const result = Reflect.set(target, prop, newValue, receiver)

      // IMPORTANT: Clear bound method cache BEFORE updating the signal
      // This ensures that if a function property is reassigned and the signal update
      // triggers effects that immediately access the property, they get the new bound method
      const boundMethods = BOUND_METHOD_CACHE.get(target)
      if (boundMethods && boundMethods.has(prop)) {
        boundMethods.delete(prop)
      }

      // Update the signal if it exists
      // This may trigger effects that access the property, so cache must be cleared first
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

      // Clear bound method cache when a property is deleted
      const boundMethods = BOUND_METHOD_CACHE.get(target)
      if (boundMethods && boundMethods.has(prop)) {
        boundMethods.delete(prop)
      }

      return result
    },
  })

  PROXY_CACHE.set(initialValue, proxy)
  return proxy
}
