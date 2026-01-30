import { createMemo } from './memo'

const PROP_GETTER_MARKER = Symbol.for('fict:prop-getter')
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
    if (Object.isExtensible(getter)) {
      try {
        ;(getter as (() => T) & { [PROP_GETTER_MARKER]?: boolean })[PROP_GETTER_MARKER] = true
      } catch {
        // Ignore marker failures on non-standard function objects.
      }
    }
  }
  return getter
}

function isPropGetter(value: unknown): value is () => unknown {
  if (typeof value !== 'function') return false
  const fn = value as (() => unknown) & { [PROP_GETTER_MARKER]?: boolean }
  return propGetters.has(fn as (...args: unknown[]) => unknown) || fn[PROP_GETTER_MARKER] === true
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
 *
 * Uses lazy lookup strategy - properties are only accessed when read,
 * avoiding upfront iteration of all keys.
 */
type MergeSource<T extends Record<string, unknown>> = T | (() => T)

export function mergeProps<T extends Record<string, unknown>>(
  ...sources: (MergeSource<T> | null | undefined)[]
): Record<string, unknown> {
  // Filter out null/undefined sources upfront and store as concrete type
  const validSources: MergeSource<T>[] = sources.filter(
    (s): s is MergeSource<T> => s != null && (typeof s === 'object' || typeof s === 'function'),
  )

  if (validSources.length === 0) {
    return {}
  }

  if (validSources.length === 1 && typeof validSources[0] === 'object') {
    // Return source directly to preserve getter behavior (consistent with multi-source)
    return validSources[0]!
  }

  const resolveSource = (src: MergeSource<T>): T | undefined => {
    const value = typeof src === 'function' ? src() : src
    if (!value || typeof value !== 'object') return undefined
    return unwrapProps(value as T)
  }

  const hasProp = (prop: string | symbol) => {
    for (const src of validSources) {
      const raw = resolveSource(src)
      if (raw && prop in raw) {
        return true
      }
    }
    return false
  }

  const readProp = (prop: string | symbol) => {
    // Only return undefined if no source has this Symbol property
    // Search sources in reverse order (last wins)
    for (let i = validSources.length - 1; i >= 0; i--) {
      const src = validSources[i]!
      const raw = resolveSource(src)
      if (!raw || !(prop in raw)) continue

      const value = (raw as Record<string | symbol, unknown>)[prop]
      // Preserve prop getters - let child component's createPropsProxy unwrap lazily
      // Note: For Symbol properties, we still wrap in getter if source is dynamic
      if (typeof src === 'function' && !isPropGetter(value)) {
        return __fictProp(() => {
          const latest = resolveSource(src)
          if (!latest || !(prop in latest)) return undefined
          return (latest as Record<string | symbol, unknown>)[prop]
        })
      }
      return value
    }
    return undefined
  }

  return new Proxy({} as Record<string, unknown>, {
    get(_, prop) {
      return readProp(prop)
    },

    has(_, prop) {
      return hasProp(prop)
    },

    ownKeys() {
      const keys = new Set<string | symbol>()
      for (const src of validSources) {
        const raw = resolveSource(src)
        if (raw) {
          for (const key of Reflect.ownKeys(raw)) {
            keys.add(key)
          }
        }
      }
      return Array.from(keys)
    },

    getOwnPropertyDescriptor(_, prop) {
      if (!hasProp(prop)) return undefined
      return {
        enumerable: true,
        configurable: true,
        get: () => readProp(prop),
      }
    },
  })
}

export type PropGetter<T> = (() => T) & { __fictProp: true }

export interface PropOptions {
  unwrap?: boolean
}

/**
 * Create a keyed prop getter that tracks both the key and the target access.
 * Useful for dynamic property access like obj[key] where key is reactive.
 */
export function keyed<T, K extends string | number | symbol>(
  target: T | PropGetter<T>,
  key: K | (() => K),
  options?: PropOptions,
): PropGetter<unknown> {
  return prop(() => {
    const resolvedTarget = isPropGetter(target) ? (target as () => T)() : target
    const resolvedKey = typeof key === 'function' ? (key as () => K)() : key
    return (resolvedTarget as Record<string | number | symbol, unknown>)[resolvedKey]
  }, options)
}
/**
 * Memoize a prop getter to cache expensive computations.
 * Use when prop expressions involve heavy calculations or you need lazy, reactive props.
 * Set { unwrap: false } to keep nested prop getters as values.
 *
 * @example
 * ```tsx
 * // Without prop - recomputes on every access
 * <Child data={expensiveComputation(list, filter)} />
 *
 * // With prop - cached until dependencies change, auto-unwrapped by props proxy
 * const memoizedData = prop(() => expensiveComputation(list, filter))
 * <Child data={memoizedData} />
 * ```
 */
export function prop<T>(getter: () => T, options?: PropOptions): PropGetter<T> {
  if (isPropGetter(getter)) {
    return getter as PropGetter<T>
  }
  // Capture getter to avoid type narrowing from isPropGetter guard
  const fn: () => T = getter
  const unwrap = options?.unwrap !== false
  // Wrap in prop so component props proxy auto-unwraps when passed down.
  return __fictProp(
    createMemo(() => {
      const value = fn()
      if (unwrap && isPropGetter(value)) {
        return (value as () => T)()
      }
      return value
    }),
  ) as PropGetter<T>
}
