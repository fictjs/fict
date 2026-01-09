/**
 * Slim fine-grained runtime entry for bundle-sensitive builds.
 *
 * Exposes only the DOM + signals surface required by compiler output and
 * leaves out stores, resources, SSR, devtools, etc.
 */

// Reactive primitives
export { createSignal, createSelector, $state } from './signal'
export { createMemo } from './memo'
export { createEffect, createRenderEffect } from './effect'
export { effectScope, createScope, runInScope, type ReactiveScope } from './scope'
export { batch, untrack } from './scheduler'

// DOM rendering
export { render, template, createElement } from './dom'
export { Fragment } from './jsx'

// Core bindings used by compiler output
export {
  insert,
  bindText,
  bindAttribute,
  bindProperty,
  bindClass,
  bindStyle,
  bindEvent,
  bindRef,
  createConditional,
  delegateEvents,
  clearDelegatedEvents,
} from './binding'

// Keyed list helpers (fine-grained DOM)
export {
  createKeyedListContainer,
  createKeyedList,
  createKeyedBlock,
  moveMarkerBlock,
  destroyMarkerBlock,
  insertNodesBefore,
  removeNodes,
  toNodeArray,
  getFirstNodeAfter,
} from './list-helpers'

// Minimal hooks surface for builds that rely on hook helpers
export {
  __fictUseContext,
  __fictUseSignal,
  __fictUseMemo,
  __fictUseEffect,
  __fictRender,
  __fictPushContext,
  __fictPopContext,
  __fictResetContext,
} from './hooks'

// Props helpers (kept minimal for compatibility with compiler output)
export {
  __fictProp,
  __fictProp as prop,
  __fictPropsRest,
  mergeProps,
  useProp,
  createPropsProxy,
} from './props'
export { onDestroy } from './lifecycle'
