/**
 * Fict DevTools Core
 *
 * Core debugging module exports
 */

export * from './types'
export * from './serializer'
export * from './debugger'
export * from './highlighter'
export * from './tree-walker'

// Re-export commonly used items
export { default as hook } from './debugger'
export { attachDebugger, detachDebugger } from './debugger'
export { default as highlighter } from './highlighter'
export { default as treeWalker } from './tree-walker'
