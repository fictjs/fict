/**
 * @fileoverview Fict Slim entrypoint
 *
 * Exposes compiler macros only. Intended for users who want the smallest
 * runtime surface and rely on the compiler to erase macro calls.
 *
 * @public
 * @packageDocumentation
 */

/**
 * Compiler macro for reactive state.
 * This is transformed at compile time and should never be called at runtime.
 */
export function $state<T>(_initialValue: T): T {
  throw new Error('$state() is a compiler macro and should be transformed at compile time')
}

/**
 * Compiler macro for reactive effects.
 * This is transformed at compile time and should never be called at runtime.
 */
export function $effect(_fn: () => void | (() => void)): void {
  throw new Error('$effect() is a compiler macro and should be transformed at compile time')
}
