/**
 * @fileoverview Context API for Fict
 *
 * Provides a way to pass data through the component tree without having to pass
 * props down manually at every level. Context is designed for:
 *
 * - SSR isolation (different request = different context values)
 * - Multi-instance support (multiple app roots with different values)
 * - Subtree scoping (override values in specific parts of the tree)
 *
 * ## Design Principles
 *
 * 1. **Reuses existing RootContext hierarchy** - Uses parent chain for value lookup,
 *    consistent with handleError/handleSuspend mechanisms.
 *
 * 2. **Zero extra root creation overhead** - Provider doesn't create new root,
 *    only mounts value on current root.
 *
 * 3. **Auto-aligned with insert/suspense boundaries** - Because they create child
 *    roots that inherit parent, context values propagate correctly.
 *
 * ## Usage
 *
 * ```tsx
 * // Create context with default value
 * const ThemeContext = createContext<'light' | 'dark'>('light')
 *
 * // Provide value to subtree
 * function App() {
 *   return (
 *     <ThemeContext.Provider value="dark">
 *       <ThemedComponent />
 *     </ThemeContext.Provider>
 *   )
 * }
 *
 * // Consume value
 * function ThemedComponent() {
 *   const theme = useContext(ThemeContext)
 *   return <div class={theme}>...</div>
 * }
 * ```
 *
 * @module
 */

import { createElement } from './dom'
import {
  createRootContext,
  destroyRoot,
  flushOnMount,
  getCurrentRoot,
  popRoot,
  pushRoot,
  type RootContext,
} from './lifecycle'
import { insertNodesBefore, removeNodes, toNodeArray } from './node-ops'
import { createRenderEffect } from './effect'
import type { BaseProps, FictNode } from './types'

// ============================================================================
// Types
// ============================================================================

/**
 * Context object created by createContext.
 * Contains the Provider component and serves as a key for context lookup.
 */
export interface Context<T> {
  /** Unique identifier for this context */
  readonly id: symbol
  /** Default value when no provider is found */
  readonly defaultValue: T
  /** Provider component for supplying context values */
  Provider: ContextProvider<T>
  /** Display name for debugging */
  displayName?: string
}

/**
 * Props for the Context Provider component
 */
export interface ProviderProps<T> extends BaseProps {
  /** The value to provide to the subtree */
  value: T
}

/**
 * Provider component type
 */
export type ContextProvider<T> = (props: ProviderProps<T>) => FictNode

// ============================================================================
// Internal Context Storage
// ============================================================================

/**
 * WeakMap to store context values per RootContext.
 * Using WeakMap ensures proper garbage collection when roots are destroyed.
 */
const contextStorage = new WeakMap<RootContext, Map<symbol, unknown>>()

/**
 * Get the context map for a root, creating it if needed
 */
function getContextMap(root: RootContext): Map<symbol, unknown> {
  let map = contextStorage.get(root)
  if (!map) {
    map = new Map()
    contextStorage.set(root, map)
  }
  return map
}

// ============================================================================
// Context API
// ============================================================================

/**
 * Creates a new context with the given default value.
 *
 * Context provides a way to pass values through the component tree without
 * explicit props drilling. It's especially useful for:
 *
 * - Theme data
 * - Locale/i18n settings
 * - Authentication state
 * - Feature flags
 * - Any data that many components at different nesting levels need
 *
 * @param defaultValue - The value to use when no Provider is found above in the tree
 * @returns A context object with a Provider component
 *
 * @example
 * ```tsx
 * // Create a theme context
 * const ThemeContext = createContext<'light' | 'dark'>('light')
 *
 * // Use the provider
 * function App() {
 *   return (
 *     <ThemeContext.Provider value="dark">
 *       <Content />
 *     </ThemeContext.Provider>
 *   )
 * }
 *
 * // Consume the context
 * function Content() {
 *   const theme = useContext(ThemeContext)
 *   return <div class={`theme-${theme}`}>Hello</div>
 * }
 * ```
 */
export function createContext<T>(defaultValue: T): Context<T> {
  const id = Symbol('fict.context')

  const context: Context<T> = {
    id,
    defaultValue,
    Provider: null as unknown as ContextProvider<T>,
  }

  // Create the Provider component
  context.Provider = function Provider(props: ProviderProps<T>): FictNode {
    const hostRoot = getCurrentRoot()

    // Create a child root for the provider's subtree
    // This establishes the provider boundary - children will look up from here
    const providerRoot = createRootContext(hostRoot)

    // Store the context value on this root
    const contextMap = getContextMap(providerRoot)
    contextMap.set(id, props.value)

    // Create DOM structure
    const fragment = document.createDocumentFragment()
    const marker = document.createComment('fict:ctx')
    fragment.appendChild(marker)

    let cleanup: (() => void) | undefined
    let activeNodes: Node[] = []

    const renderChildren = (children: FictNode) => {
      // Cleanup previous render
      if (cleanup) {
        cleanup()
        cleanup = undefined
      }
      if (activeNodes.length) {
        removeNodes(activeNodes)
        activeNodes = []
      }

      if (children == null || children === false) {
        return
      }

      const prev = pushRoot(providerRoot)
      let nodes: Node[] = []
      try {
        const output = createElement(children)
        nodes = toNodeArray(output)
        const parentNode = marker.parentNode as (ParentNode & Node) | null
        if (parentNode) {
          insertNodesBefore(parentNode, nodes, marker)
        }
      } finally {
        popRoot(prev)
        flushOnMount(providerRoot)
      }

      cleanup = () => {
        destroyRoot(providerRoot)
        removeNodes(nodes)
      }
      activeNodes = nodes
    }

    // Initial render
    createRenderEffect(() => {
      // Update context value on re-render (if value prop changes reactively)
      contextMap.set(id, props.value)
      renderChildren(props.children)
    })

    return fragment
  }

  return context
}

/**
 * Reads the current value of a context.
 *
 * useContext looks up through the RootContext parent chain to find the
 * nearest Provider for this context. If no Provider is found, returns
 * the context's default value.
 *
 * @param context - The context object created by createContext
 * @returns The current context value
 *
 * @example
 * ```tsx
 * const ThemeContext = createContext('light')
 *
 * function ThemedButton() {
 *   const theme = useContext(ThemeContext)
 *   return <button class={theme === 'dark' ? 'btn-dark' : 'btn-light'}>Click</button>
 * }
 * ```
 */
export function useContext<T>(context: Context<T>): T {
  let root = getCurrentRoot()

  // Walk up the parent chain looking for the context value
  while (root) {
    const contextMap = contextStorage.get(root)
    if (contextMap && contextMap.has(context.id)) {
      return contextMap.get(context.id) as T
    }
    root = root.parent
  }

  // No provider found, return default value
  return context.defaultValue
}

/**
 * Checks if a context value is currently provided in the tree.
 *
 * Useful for conditional behavior when a provider may or may not exist.
 *
 * @param context - The context object to check
 * @returns true if a Provider exists above in the tree
 *
 * @example
 * ```tsx
 * function OptionalTheme() {
 *   if (hasContext(ThemeContext)) {
 *     const theme = useContext(ThemeContext)
 *     return <div class={theme}>Themed content</div>
 *   }
 *   return <div>Default content</div>
 * }
 * ```
 */
export function hasContext<T>(context: Context<T>): boolean {
  let root = getCurrentRoot()

  while (root) {
    const contextMap = contextStorage.get(root)
    if (contextMap && contextMap.has(context.id)) {
      return true
    }
    root = root.parent
  }

  return false
}
