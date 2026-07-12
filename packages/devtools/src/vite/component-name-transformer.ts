export type SerializableComponentNameTransformer = (name: string) => string

export function serializeComponentNameTransformer(
  transformer: SerializableComponentNameTransformer | undefined,
): string {
  if (!transformer) return 'undefined'

  const source = Function.prototype.toString.call(transformer).trim()
  if (!source || source.includes('[native code]') || /^async\b/.test(source)) {
    throw new TypeError(
      '[fict-devtools] componentNameTransformer must be a synchronous, self-contained JavaScript function.',
    )
  }

  if (/^function(?:\s|\*)/.test(source) || /^(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(source)) {
    return `(${source})`
  }

  if (/^[A-Za-z_$][\w$]*\s*\(/.test(source)) {
    return `(function ${source})`
  }

  throw new TypeError(
    '[fict-devtools] componentNameTransformer could not be serialized for the browser runtime.',
  )
}
