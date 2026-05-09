export function createUncompiledMacroError(macroName: '$state' | '$effect'): Error {
  const isDev =
    typeof __DEV__ !== 'undefined'
      ? __DEV__
      : typeof process === 'undefined' || process.env?.NODE_ENV !== 'production'
  return new Error(
    isDev
      ? `${macroName}() is a Fict compile-time macro that ran at runtime because this file was not transformed. Check @fictjs/vite-plugin, test transforms, or package aliases.`
      : 'FICT_E_UNCOMPILED',
  )
}
