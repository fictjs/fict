import { signal, batch, getActiveSub, type SignalAccessor } from './signal'

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
const defineNotificationSuppressions = new WeakMap<object, Set<string | symbol>>()

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

function enumerableOwnKeys(value: object): (string | symbol)[] {
  const keys: (string | symbol)[] = Object.keys(value)
  for (const key of Object.getOwnPropertySymbols(value)) {
    if (Object.prototype.propertyIsEnumerable.call(value, key)) {
      keys.push(key)
    }
  }
  return keys
}

function getPropertyDescriptor(
  target: object,
  prop: string | symbol,
): PropertyDescriptor | undefined {
  let current: object | null = target
  while (current) {
    const descriptor = Reflect.getOwnPropertyDescriptor(current, prop)
    if (descriptor) return descriptor
    current = Object.getPrototypeOf(current)
  }
  return undefined
}

function mustReturnExactDataValue(target: object, prop: string | symbol): boolean {
  const descriptor = Reflect.getOwnPropertyDescriptor(target, prop)
  return !!descriptor && 'value' in descriptor && !descriptor.configurable && !descriptor.writable
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

function suppressDefineNotification(target: object, prop: string | symbol): () => void {
  let suppressions = defineNotificationSuppressions.get(target)
  if (!suppressions) {
    suppressions = new Set()
    defineNotificationSuppressions.set(target, suppressions)
  }
  suppressions.add(prop)
  return () => {
    const current = defineNotificationSuppressions.get(target)
    if (!current) return
    current.delete(prop)
    if (current.size === 0) {
      defineNotificationSuppressions.delete(target)
    }
  }
}

function isDefineNotificationSuppressed(target: object, prop: string | symbol): boolean {
  return defineNotificationSuppressions.get(target)?.has(prop) ?? false
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

function descriptorValue(
  target: object,
  prop: string | symbol,
  descriptor: PropertyDescriptor | undefined,
  receiver: object,
  fallback: unknown,
): unknown {
  if (!descriptor) return fallback
  if ('value' in descriptor) return descriptor.value
  try {
    return Reflect.get(target, prop, receiver)
  } catch {
    return fallback
  }
}

type ReactiveCollection =
  | Map<unknown, unknown>
  | Set<unknown>
  | WeakMap<object, unknown>
  | WeakSet<object>

function isCollection(value: object): value is ReactiveCollection {
  return (
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet
  )
}

const internalSlotGlobalConstructors = [
  'URL',
  'URLSearchParams',
  'Blob',
  'File',
  'FileList',
  'FormData',
  'Headers',
  'Request',
  'Response',
  'AbortController',
  'AbortSignal',
  'DOMException',
  'EventTarget',
  'Event',
  'Node',
  'Document',
  'Element',
  'Window',
] as const

function isInstanceOfGlobal(value: object, name: (typeof internalSlotGlobalConstructors)[number]) {
  const ctor = (globalThis as Record<string, unknown>)[name]
  if (typeof ctor !== 'function') return false
  try {
    return value instanceof (ctor as new (...args: never[]) => object)
  } catch {
    return false
  }
}

// Objects whose methods depend on internal slots cannot go through the
// generic deep proxy: their methods would be invoked with the proxy as
// `this` and throw "called on incompatible receiver". They are returned
// raw; property-level tracking on the parent still notifies on replacement.
function hasInternalSlots(value: object): boolean {
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Promise ||
    value instanceof Error ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return true
  }

  for (let i = 0; i < internalSlotGlobalConstructors.length; i++) {
    if (isInstanceOfGlobal(value, internalSlotGlobalConstructors[i]!)) return true
  }

  return false
}

const collectionMutators = new Set(['set', 'add', 'delete', 'clear'])

/**
 * Coarse-grained reactive wrapper for Map/Set/WeakMap/WeakSet: methods are
 * dispatched against the raw target (proxies cannot carry collection
 * internal slots), reads subscribe to a per-collection version, and any
 * mutation bumps it. Values read out of collections are returned raw.
 */
function wrapCollection<T extends object>(target: T): T {
  const handler: ProxyHandler<object> = {
    get(t, prop) {
      if (prop === PROXY) return true
      if (prop === TARGET) return t
      if (prop === 'size') {
        track(t, ITERATE_KEY)
        return Reflect.get(t, 'size', t)
      }
      const value = Reflect.get(t, prop, t)
      if (typeof value !== 'function') {
        track(t, prop)
        return value
      }
      if (collectionMutators.has(prop as string)) {
        return function (this: unknown, ...args: unknown[]) {
          const result = (value as (...inner: unknown[]) => unknown).apply(t, args)
          // delete() returning false removed nothing; skip the notification.
          if (prop !== 'delete' || result === true) {
            trigger(t, ITERATE_KEY)
          }
          return result === t ? proxy : result
        }
      }
      return function (this: unknown, ...args: unknown[]) {
        track(t, ITERATE_KEY)
        const result = (value as (...inner: unknown[]) => unknown).apply(t, args)
        return result === t ? proxy : result
      }
    },
  }

  const proxy = new Proxy(target, handler) as T
  return proxy
}

function wrap<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Reflect.get(value, PROXY)) return value

  if (proxyCache.has(value)) return proxyCache.get(value) as T

  if (isCollection(value)) {
    const collectionProxy = wrapCollection(value)
    proxyCache.set(value, collectionProxy)
    return collectionProxy
  }
  if (hasInternalSlots(value)) {
    return value
  }

  const handler: ProxyHandler<object> = {
    get(target, prop, receiver) {
      if (prop === PROXY) return true
      if (prop === TARGET) return target

      const value = Reflect.get(target, prop, receiver)

      // Track property access
      track(target, prop, value, true)

      // Recursively wrap objects
      if (value !== null && typeof value === 'object' && mustReturnExactDataValue(target, prop)) {
        return value
      }
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
      const descriptor = getPropertyDescriptor(target, prop)
      if (canSkipSameValueSet(target, prop, descriptor)) {
        const oldValue = Reflect.get(target, prop, receiver)
        if (oldValue === value) return true
      }

      const releaseDefineSuppression = suppressDefineNotification(target, prop)
      let result: boolean
      try {
        result = Reflect.set(target, prop, value, receiver)
      } finally {
        releaseDefineSuppression()
      }
      if (result) {
        trigger(target, prop, value, true)
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
      trigger(
        target,
        prop,
        descriptorValue(target, prop, nextDescriptor, proxy as object, undefined),
        true,
      )

      if (hadKey !== hasKey || descriptorShapeChanged(oldDescriptor, nextDescriptor)) {
        trigger(target, ITERATE_KEY)
      }

      if (Array.isArray(target)) {
        if (target.length !== oldLength) {
          trigger(target, 'length', target.length, true)
        }
        if (prop === 'length' && typeof oldLength === 'number' && target.length < oldLength) {
          const signals = signalCache.get(target)
          if (signals) {
            for (const key of signals.keys()) {
              if (typeof key !== 'string') continue
              const index = Number(key)
              if (!Number.isInteger(index) || String(index) !== key) continue
              if (index >= target.length && index < oldLength) {
                trigger(target, key, undefined, true)
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

function track(
  target: object,
  prop: string | symbol,
  initialValue?: unknown,
  useProvidedInitial = false,
) {
  // Avoid allocating per-property signals when no reactive subscriber is active.
  if (!getActiveSub()) return

  let signals = signalCache.get(target)
  if (!signals) {
    signals = new Map()
    signalCache.set(target, signals)
  }

  let s = signals.get(prop)
  if (!s) {
    const initial =
      prop === ITERATE_KEY
        ? getIterateVersion(target)
        : useProvidedInitial
          ? initialValue
          : getLastValue(target, prop)
    s = signal(initial)
    signals.set(prop, s)
  }
  s() // subscribe
}

function trigger(
  target: object,
  prop: string | symbol,
  nextValue?: unknown,
  useProvidedValue = false,
) {
  const signals = signalCache.get(target)
  if (signals) {
    const s = signals.get(prop)
    if (s) {
      if (prop === ITERATE_KEY) {
        s(bumpIterateVersion(target))
      } else {
        s(useProvidedValue ? nextValue : getLastValue(target, prop)) // notify with new value
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

  const keys = new Set([...enumerableOwnKeys(realTarget), ...enumerableOwnKeys(realValue)])
  for (const key of keys) {
    const rTarget = realTarget as Record<string | symbol, unknown>
    const rValue = realValue as Record<string | symbol, unknown>
    const hasCurrent = Object.prototype.hasOwnProperty.call(rTarget, key)
    const hasNext = Object.prototype.hasOwnProperty.call(rValue, key)
    const current = rTarget[key]
    const next = rValue[key]

    if (!hasNext && hasCurrent) {
      // deleted
      delete (target as Record<string | symbol, unknown>)[key] // Triggers proxy trap
    } else if (hasNext && (!hasCurrent || current !== next)) {
      if (canReconcileNestedValues(current, next)) {
        reconcile((target as Record<string | symbol, unknown>)[key] as object, next, seen)
      } else {
        ;(target as Record<string | symbol, unknown>)[key] = next // Triggers proxy trap
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
  const presenceSignals = new Map<string | symbol, SignalAccessor<number>>()
  const presenceVersions = new Map<string | symbol, number>()
  const presenceSnapshots = new Map<string | symbol, boolean>()
  const descriptorSignals = new Map<string | symbol, SignalAccessor<number>>()
  const descriptorVersions = new Map<string | symbol, number>()
  const descriptorSnapshots = new Map<string | symbol, PropertyDescriptor | undefined>()
  type Method = (...args: unknown[]) => unknown
  const boundMethodCache = new WeakMap<object, Map<Method, Method>>()
  let prototypeSignal: SignalAccessor<number> | undefined
  let prototypeVersion = 0
  let prototypeSnapshot = Reflect.getPrototypeOf(currentValue as object)
  let iterateSignal: SignalAccessor<number> | undefined
  let iterateVersion = 0
  let ownKeysSnapshot = Reflect.ownKeys(currentValue as object)
  let ownDescriptorSnapshot = snapshotOwnDescriptors(currentValue as object)

  const hasSameOwnKeys = (aKeys: (string | symbol)[], bKeys: (string | symbol)[]): boolean => {
    if (aKeys.length !== bKeys.length) return false
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false
    }
    return true
  }

  function snapshotOwnDescriptors(value: object): Map<string | symbol, PropertyDescriptor> {
    const snapshot = new Map<string | symbol, PropertyDescriptor>()
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
      if (descriptor) snapshot.set(key, descriptor)
    }
    return snapshot
  }

  const ownDescriptorSnapshotChanged = (next: object, nextKeys: (string | symbol)[]): boolean => {
    for (const key of nextKeys) {
      if (
        descriptorShapeChanged(
          ownDescriptorSnapshot.get(key),
          Reflect.getOwnPropertyDescriptor(next, key),
        )
      ) {
        return true
      }
    }
    return false
  }

  const shouldBindMethod = (
    target: object,
    prop: string | symbol,
    value: unknown,
  ): value is Method => {
    if (typeof value !== 'function') return false
    if (Array.isArray(target) || isPlainObject(target)) return false

    let proto = Reflect.getPrototypeOf(target)
    while (proto) {
      const descriptor = Reflect.getOwnPropertyDescriptor(proto, prop)
      if (descriptor) return 'value' in descriptor && descriptor.value === value
      proto = Reflect.getPrototypeOf(proto)
    }
    return false
  }

  const bindMethod = (target: object, method: Method): Method => {
    let methods = boundMethodCache.get(target)
    if (!methods) {
      methods = new Map()
      boundMethodCache.set(target, methods)
    }

    let bound = methods.get(method)
    if (!bound) {
      bound = method.bind(target) as Method
      methods.set(method, bound)
    }
    return bound
  }

  const normalizeReadValue = (target: object, prop: string | symbol, value: unknown): unknown => {
    if (shouldBindMethod(target, prop, value)) {
      return bindMethod(target, value)
    }
    return value
  }

  const getPropSignal = (prop: string | symbol) => {
    let s = signals.get(prop)
    if (!s) {
      s = signal(Reflect.get(currentValue as object, prop), { equals: false })
      signals.set(prop, s)
    }
    return s
  }

  const trackPrototype = () => {
    if (!prototypeSignal) {
      prototypeSignal = signal(prototypeVersion)
    }
    prototypeSignal()
  }

  const bumpPrototype = () => {
    if (!prototypeSignal) return
    prototypeVersion += 1
    prototypeSignal(prototypeVersion)
  }

  const updatePrototype = (next: object): void => {
    const nextPrototype = Reflect.getPrototypeOf(next)
    const changed = prototypeSnapshot !== nextPrototype
    prototypeSnapshot = nextPrototype
    if (changed) {
      bumpPrototype()
    }
  }

  const bumpVersionedSignal = (
    versions: Map<string | symbol, number>,
    s: SignalAccessor<number>,
    prop: string | symbol,
  ) => {
    const nextVersion = (versions.get(prop) ?? 0) + 1
    versions.set(prop, nextVersion)
    s(nextVersion)
  }

  const getPresenceSignal = (prop: string | symbol) => {
    let s = presenceSignals.get(prop)
    if (!s) {
      s = signal(0)
      presenceSignals.set(prop, s)
      presenceVersions.set(prop, 0)
      presenceSnapshots.set(prop, Reflect.has(currentValue as object, prop))
    }
    return s
  }

  const getDescriptorSignal = (prop: string | symbol) => {
    let s = descriptorSignals.get(prop)
    if (!s) {
      s = signal(0)
      descriptorSignals.set(prop, s)
      descriptorVersions.set(prop, 0)
      descriptorSnapshots.set(prop, Reflect.getOwnPropertyDescriptor(currentValue as object, prop))
    }
    return s
  }

  const updatePresenceSignals = (next: object): void => {
    for (const [prop, s] of presenceSignals) {
      const oldHas = presenceSnapshots.get(prop)
      const newHas = Reflect.has(next, prop)
      presenceSnapshots.set(prop, newHas)
      if (oldHas !== newHas) {
        bumpVersionedSignal(presenceVersions, s, prop)
      }
    }
  }

  const updateDescriptorSignals = (next: object): void => {
    for (const [prop, s] of descriptorSignals) {
      const oldDescriptor = descriptorSnapshots.get(prop)
      const newDescriptor = Reflect.getOwnPropertyDescriptor(next, prop)
      descriptorSnapshots.set(prop, newDescriptor)
      if (descriptorContentChanged(oldDescriptor, newDescriptor)) {
        bumpVersionedSignal(descriptorVersions, s, prop)
      }
    }
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
    const changed =
      !hasSameOwnKeys(ownKeysSnapshot, nextKeys) || ownDescriptorSnapshotChanged(next, nextKeys)
    ownKeysSnapshot = nextKeys
    ownDescriptorSnapshot = snapshotOwnDescriptors(next)
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
      return normalizeReadValue(currentValue as object, prop, s())
    },
    getPrototypeOf() {
      trackPrototype()
      return Reflect.getPrototypeOf(currentValue)
    },
    ownKeys() {
      trackIterate()
      return Reflect.ownKeys(currentValue)
    },
    has(target, prop) {
      getPresenceSignal(prop)()
      return Reflect.has(currentValue, prop)
    },
    getOwnPropertyDescriptor(target, prop) {
      getDescriptorSignal(prop)()
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
      updatePresenceSignals(next as object)
      updateDescriptorSignals(next as object)
      updatePrototype(next as object)
      updateIterateFromOwnKeys(next as object)
      return
    }

    // Diff logic
    // We only trigger signals for properties that exist in our cache (tracked)
    // and have changed.
    for (const [prop, s] of signals) {
      const oldHas = Reflect.has(prev as object, prop)
      const newHas = Reflect.has(next as object, prop)
      const oldDescriptor = Reflect.getOwnPropertyDescriptor(prev as object, prop)
      const newDescriptor = Reflect.getOwnPropertyDescriptor(next as object, prop)
      const oldOwn = oldDescriptor !== undefined
      const newOwn = newDescriptor !== undefined
      const oldVal = Reflect.get(prev as object, prop)
      const newVal = Reflect.get(next as object, prop)
      const receiverChanged =
        shouldBindMethod(prev as object, prop, oldVal) ||
        shouldBindMethod(next as object, prop, newVal)
      if (
        oldVal !== newVal ||
        oldHas !== newHas ||
        oldOwn !== newOwn ||
        descriptorShapeChanged(oldDescriptor, newDescriptor) ||
        receiverChanged
      ) {
        s(newVal)
      }
    }
    updatePresenceSignals(next as object)
    updateDescriptorSignals(next as object)
    updatePrototype(next as object)
    updateIterateFromOwnKeys(next as object)

    // Note: If new properties appeared that weren't tracked, we don't care
    // because no one is listening.
    // If we assume shape stability (Keyed List), this is efficient.
  }

  return [read, write] as const
}
