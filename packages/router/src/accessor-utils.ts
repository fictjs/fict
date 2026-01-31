export function wrapAccessor<T extends (...args: any[]) => any>(fn: T): T {
  const wrapped = ((...args: any[]) => {
    if (args.length === 0) return wrapped
    return fn(...(args as Parameters<T>))
  }) as unknown as T
  return wrapped
}

export function wrapValue<T>(value: T): T {
  const wrapped = (() => value) as unknown as T & {
    toString?: () => string
    valueOf?: () => T
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const primitive = value
    wrapped.toString = () => String(primitive)
    wrapped.valueOf = () => primitive
  }

  return wrapped as unknown as T
}
