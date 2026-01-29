/**
 * Fict DevTools
 *
 * Developer tools for Fict applications
 */

// Core exports
export * from './core/types'
export * from './core/serializer'
export * from './core/debugger'
export * from './core/highlighter'
export * from './core/tree-walker'

// Vite plugin export
export { default as fictDevTools, type FictDevToolsOptions } from './vite'

// Re-export for convenience
export { attachDebugger, detachDebugger, hook } from './core/debugger'
export {
  initHighlighter,
  destroyHighlighter,
  highlight,
  unhighlight,
  startInspecting,
  stopInspecting,
} from './core/highlighter'
export { walkTree, findNodes, findNodeById, flattenTree } from './core/tree-walker'
