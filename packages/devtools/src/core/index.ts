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
export * from './plugin'
export * from './rpc'

// Re-export commonly used items
export { default as hook } from './debugger'
export { attachDebugger, detachDebugger } from './debugger'
export { default as highlighter } from './highlighter'
export { default as treeWalker } from './tree-walker'

// Plugin API
export {
  registerPlugin,
  unregisterPlugin,
  getPlugins,
  getPluginTabs,
  getPluginTimelineLayers,
  createPlugin,
  definePlugin,
} from './plugin'
export type {
  DevToolsPlugin,
  PluginContext,
  CustomTab,
  InspectorSection,
  NodeAction,
} from './plugin'

// RPC API
export {
  RPCClient,
  ChromeExtensionTransport,
  BroadcastChannelTransport,
  PostMessageTransport,
  MultiTransport,
  createPanelRPC,
  createContentRPC,
  createHookRPC,
  createBackgroundRPC,
  defineEndpoint,
  RPCEndpoints,
} from './rpc'
export type { RPCMessage, RPCTransport, RPCClientOptions, RPCHandler } from './rpc'
