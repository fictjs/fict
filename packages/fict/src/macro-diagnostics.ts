const UNCOMPILED_MACRO_ERROR_CODE = 'FICT_E_UNCOMPILED'

function isDevMode(): boolean {
  return typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process === 'undefined' || process.env?.NODE_ENV !== 'production'
}

export function createUncompiledMacroError(macroName: '$state' | '$effect'): Error {
  if (!isDevMode()) {
    return new Error(UNCOMPILED_MACRO_ERROR_CODE)
  }

  return new Error(
    `${macroName}() is a Fict compiler macro. It must be transformed by ` +
      '@fictjs/compiler or @fictjs/vite-plugin before runtime. Check that the file is included ' +
      'in the Fict compiler transform and that tests/builds do not import uncompiled TSX.',
  )
}
