export function createUncompiledMacroError(macroName: '$state' | '$effect'): Error {
  const isDev =
    typeof __DEV__ !== 'undefined'
      ? __DEV__
      : typeof process === 'undefined' || process.env?.NODE_ENV !== 'production'
  return new Error(isDev ? `${macroName}() compile-only.` : 'FICT_E_UNCOMPILED')
}
