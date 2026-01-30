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
export * from './core/plugin'
export * from './core/rpc'

// Vite plugin export
export { default as fictDevTools, type FictDevToolsOptions } from './vite'

// Re-export for convenience
export { attachDebugger, detachDebugger, hook, exposeToConsole } from './core/debugger'
export {
  initHighlighter,
  destroyHighlighter,
  highlight,
  unhighlight,
  startInspecting,
  stopInspecting,
} from './core/highlighter'
export { walkTree, findNodes, findNodeById, flattenTree } from './core/tree-walker'

// Plugin API
export {
  registerPlugin,
  unregisterPlugin,
  getPlugins,
  createPlugin,
  definePlugin,
} from './core/plugin'
export type {
  DevToolsPlugin,
  PluginContext,
  CustomTab,
  InspectorSection,
  NodeAction,
} from './core/plugin'

// RPC API
export {
  RPCClient,
  createPanelRPC,
  createContentRPC,
  createHookRPC,
  createBackgroundRPC,
  defineEndpoint,
  RPCEndpoints,
} from './core/rpc'
export type { RPCMessage, RPCTransport, RPCClientOptions, RPCHandler } from './core/rpc'
