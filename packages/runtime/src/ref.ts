import type { RefObject } from './types'

/**
 * Create a ref object for DOM element references.
 *
 * @returns A ref object with a `current` property initialized to `null`
 *
 * @example
 * ```tsx
 * import { createRef } from 'fict'
 *
 * function Component() {
 *   const inputRef = createRef<HTMLInputElement>()
 *
 *   $effect(() => {
 *     inputRef.current?.focus()
 *   })
 *
 *   return <input ref={inputRef} />
 * }
 * ```
 */
export function createRef<T extends HTMLElement = HTMLElement>(): RefObject<T> {
  return { current: null }
}
