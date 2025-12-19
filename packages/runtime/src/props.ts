const propGetters = new WeakSet<Function>()
const rawToProxy = new WeakMap<object, object>()
const proxyToRaw = new WeakMap<object, object>()

export function __fictProp<T>(getter: () => T): () => T {
  if (typeof getter === 'function' && getter.length === 0) {
    propGetters.add(getter)
  }
  return getter
}

function isPropGetter(value: unknown): value is () => unknown {
  return typeof value === 'function' && propGetters.has(value)
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
