const propGetters = new WeakSet<(...args: unknown[]) => unknown>()
const rawToProxy = new WeakMap<object, object>()
const proxyToRaw = new WeakMap<object, object>()

/**
 * @internal
 * Marks a zero-arg getter so props proxy can lazily evaluate it.
 * Users normally never call this directly; the compiler injects it.
 */
export function __fictProp<T>(getter: () => T): () => T {
  if (typeof getter === 'function' && getter.length === 0) {
    propGetters.add(getter)
  }
  return getter
}

function isPropGetter(value: unknown): value is () => unknown {
  return typeof value === 'function' && propGetters.has(value as (...args: unknown[]) => unknown)
}

export function createPropsProxy<T extends Record<string, unknown>>(props: T): T {
  if (!props || typeof props !== 'object') {
    return props
  }

  if (proxyToRaw.has(props)) {
    return props
  }

  const cached = rawToProxy.get(props)
  if (cached) {
    return cached as T
  }

  const proxy = new Proxy(props, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (isPropGetter(value)) {
        return value()
      }
      return value
    },
    set(target, prop, value, receiver) {
      return Reflect.set(target, prop, value, receiver)
    },
    has(target, prop) {
      return prop in target
    },
    ownKeys(target) {
      return Reflect.ownKeys(target)
    },
    getOwnPropertyDescriptor(target, prop) {
      return Object.getOwnPropertyDescriptor(target, prop)
    },
  })

  rawToProxy.set(props, proxy)
  proxyToRaw.set(proxy, props)

  return proxy as T
}

export function unwrapProps<T extends Record<string, unknown>>(props: T): T {
  if (!props || typeof props !== 'object') {
    return props
  }
  return (proxyToRaw.get(props) as T | undefined) ?? props
}

/**
 * Create a rest-like props object while preserving prop getters.
 * Excludes the specified keys from the returned object.
 */
export function __fictPropsRest<T extends Record<string, unknown>>(
  props: T,
  exclude: (string | number | symbol)[],
): Record<string, unknown> {
  const raw = unwrapProps(props)
  const out: Record<string, unknown> = {}
  const excludeSet = new Set(exclude)

  for (const key of Reflect.ownKeys(raw)) {
    if (excludeSet.has(key)) continue
    out[key as string] = (raw as Record<string | symbol, unknown>)[key]
  }

  // Wrap in props proxy so getters remain lazy when accessed via rest
  return createPropsProxy(out)
}

/**
 * Merge multiple props-like objects while preserving lazy getters.
 * Later sources override earlier ones.
 */
export function mergeProps<T extends Record<string, unknown>>(
  ...sources: (T | null | undefined)[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  for (const src of sources) {
    if (!src || typeof src !== 'object') continue
    const raw = unwrapProps(src as Record<string, unknown>)
    for (const key of Reflect.ownKeys(raw)) {
      out[key as string] = (raw as Record<string | symbol, unknown>)[key]
    }
  }

  return createPropsProxy(out)
}
