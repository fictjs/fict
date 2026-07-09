declare const __FICT_NODE_REQUIRE__: ((specifier: string) => unknown) | undefined

/**
 * Resolve Node's module-local `require` without introducing a Node builtin
 * import into the edge-compatible ESM build.
 *
 * The CJS build replaces `__FICT_NODE_REQUIRE__` with its local `require`.
 * Source/ESM execution can still opt in through a host-provided global.
 */
export function getNodeRequire(): ((specifier: string) => unknown) | null {
  if (typeof __FICT_NODE_REQUIRE__ === 'function') {
    return __FICT_NODE_REQUIRE__
  }

  const direct = (globalThis as Record<string, unknown>).require
  if (typeof direct === 'function') {
    return direct as (specifier: string) => unknown
  }

  try {
    return Function('return typeof require === "function" ? require : null')() as
      | ((specifier: string) => unknown)
      | null
  } catch {
    return null
  }
}
