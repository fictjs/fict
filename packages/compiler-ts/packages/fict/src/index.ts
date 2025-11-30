/**
 * Fict - Reactive UI with zero boilerplate
 *
 * Main package that re-exports the runtime and provides compile-time macros.
 *
 * @example
 * ```tsx
 * import { $state, $effect, render } from 'fict'
 *
 * function Counter() {
 *   let count = $state(0)
 *   const doubled = count * 2
 *
 *   return (
 *     <div>
 *       <p>{doubled}</p>
 *       <button onClick={() => count++}>Increment</button>
 *     </div>
 *   )
 * }
 *
 * render(() => <Counter />, document.getElementById('app')!)
 * ```
 */

// Re-export everything from runtime
export * from 'fict-runtime'

// Export compile-time macros (these are stripped by the compiler)
// They're exported here for type-checking purposes
export { $state, $effect } from 'fict-runtime'
