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
 * 2. **Stable provider boundary** - Provider creates one root for context
 *    ownership and preserves its child tree when only the value changes.
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
import { createRenderEffect } from './effect'
import {
  createRootContext,
  destroyRoot,
  flushOnMount,
  getCurrentRoot,
  popRoot,
  pushRoot,
  registerRootCleanup,
  resolveParentOwnerDocument,
  type RootContext,
} from './lifecycle'
import { insertNodesBefore, removeNodes, toNodeArray } from './node-ops'
import { untrack } from './scheduler'
import { computed, createSignal } from './signal'
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

/** Read-only reactive accessor for the nearest context value. */
export type ContextAccessor<T> = () => T

// ============================================================================
// Internal Context Storage
// ============================================================================

/**
 * WeakMap to store context values per RootContext.
 * Using WeakMap ensures proper garbage collection when roots are destroyed.
 */
interface ContextCell {
  read: () => unknown
  write: (value: unknown) => void
}

const contextStorage = new WeakMap<RootContext, Map<symbol, ContextCell>>()

/**
 * Get the context map for a root, creating it if needed
 */
function getContextMap(root: RootContext): Map<symbol, ContextCell> {
  let map = contextStorage.get(root)
  if (!map) {
    map = new Map()
    contextStorage.set(root, map)
  }
  return map
}

function findContextCell(id: symbol): ContextCell | undefined {
  let root = getCurrentRoot()
  while (root) {
    const contextMap = contextStorage.get(root)
    const cell = contextMap?.get(id)
    if (cell) return cell
    root = root.parent
  }
  return undefined
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
    const callSiteRenderNamespace = hostRoot?.renderNamespace

    // Create DOM structure
    const markerOwnerDocument = hostRoot?.ownerDocument ?? document
    const fragment = markerOwnerDocument.createDocumentFragment()
    const marker = markerOwnerDocument.createComment('fict:ctx')
    fragment.appendChild(marker)

    const initialValue = untrack(() => props.value)
    const valueSignal = createSignal(initialValue)
    const providerRoot = createRootContext(hostRoot)
    providerRoot.renderNamespace = callSiteRenderNamespace
    providerRoot.ownerDocument = resolveParentOwnerDocument(
      marker.parentNode,
      providerRoot.ownerDocument ?? marker.ownerDocument ?? markerOwnerDocument,
    )
    getContextMap(providerRoot).set(id, {
      read: () => valueSignal(),
      write: value => valueSignal(value as T),
    })

    let contentRoot: RootContext | undefined
    let activeNodes: Node[] = []

    const cleanupActive = () => {
      try {
        if (contentRoot) {
          const currentRoot = contentRoot
          contentRoot = undefined
          destroyRoot(currentRoot)
        }
      } finally {
        if (activeNodes.length) {
          removeNodes(activeNodes)
          activeNodes = []
        }
      }
    }

    const renderChildren = (children: FictNode) => {
      cleanupActive()

      if (children == null || children === false) {
        return
      }

      // Child identity changes receive a fresh content root, while value-only
      // changes retain this root and all descendant DOM/lifecycle state.
      const nextContentRoot = createRootContext(providerRoot)
      nextContentRoot.renderNamespace = callSiteRenderNamespace
      const markerParent = marker.parentNode
      nextContentRoot.ownerDocument = resolveParentOwnerDocument(
        markerParent,
        nextContentRoot.ownerDocument ?? marker.ownerDocument ?? markerOwnerDocument,
      )

      const prev = pushRoot(nextContentRoot)
      let nodes: Node[] = []
      let didPopRoot = false
      const restoreRoot = () => {
        if (didPopRoot) return
        popRoot(prev)
        didPopRoot = true
      }
      try {
        const output = createElement(children)
        nodes = toNodeArray(output, nextContentRoot.ownerDocument ?? markerOwnerDocument)
        const parentNode = marker.parentNode as (ParentNode & Node) | null
        if (parentNode) {
          nodes = insertNodesBefore(parentNode, nodes, marker)
        }
        restoreRoot()
        flushOnMount(nextContentRoot)
      } catch (err) {
        restoreRoot()
        try {
          destroyRoot(nextContentRoot)
        } finally {
          removeNodes(nodes)
        }
        throw err
      }

      contentRoot = nextContentRoot
      activeNodes = nodes
    }

    registerRootCleanup(() => {
      try {
        cleanupActive()
      } finally {
        contextStorage.delete(providerRoot)
        destroyRoot(providerRoot)
      }
    })

    // Value updates publish through the stable context cell. Descendants that
    // use useContextAccessor (or call useContext inside an effect) update
    // without rebuilding the provider subtree.
    createRenderEffect(() => {
      const cell = getContextMap(providerRoot).get(id)
      cell?.write(props.value)
    })

    const unsetChildren = Symbol('fict.context.unset-children')
    let previousChildren: FictNode | typeof unsetChildren = unsetChildren
    createRenderEffect(() => {
      const children = props.children
      if (previousChildren !== unsetChildren && Object.is(previousChildren, children)) return
      previousChildren = children

      // Rendering descendants must not make this effect subscribe to their
      // signals or to the context value they consume.
      untrack(() => renderChildren(children))
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
  const cell = findContextCell(context.id)
  return cell ? (cell.read() as T) : context.defaultValue
}

/**
 * Returns a read-only reactive accessor for the nearest Provider value.
 *
 * Use this when the Provider's `value` prop itself changes. The accessor keeps
 * descendant component, DOM, focus, and scroll identity intact while bindings
 * react to the new value.
 */
export function useContextAccessor<T>(context: Context<T>): ContextAccessor<T> {
  const cell = findContextCell(context.id)
  return computed(() => (cell ? (cell.read() as T) : context.defaultValue), {
    internal: true,
  })
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
