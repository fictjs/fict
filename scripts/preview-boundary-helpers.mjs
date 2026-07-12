const legacyLoaderSpecifiers = [
  ['fict', 'loader'].join('/'),
  ['@fictjs', 'runtime', 'loader'].join('/'),
]

export function hasLegacyLoaderReference(source) {
  const normalized = source
    .replace(/\\+\//g, '/')
    .replace(/\\x2f/gi, '/')
    .replace(/\\u002f/gi, '/')
    .replace(/\\u\{0*2f\}/gi, '/')

  return legacyLoaderSpecifiers.some(specifier => normalized.includes(specifier))
}
