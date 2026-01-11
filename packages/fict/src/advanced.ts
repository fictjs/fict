/**
 * @fileoverview Fict Advanced APIs
 *
 * This module exports advanced APIs for power users and library authors.
 * These APIs require deeper understanding of Fict internals.
 *
 * @advanced
 * @packageDocumentation
 */

// Re-export all advanced APIs from runtime
export {
  // Reactive Scope Management
  createScope,
  runInScope,
  effectScope,
  type ReactiveScope,

  // Fine-grained Subscription
  createSelector,

  // Versioned Signal
  createVersionedSignal,
  type VersionedSignal,
  type VersionedSignalOptions,

  // High-Level Binding Factories
  createTextBinding,
  createChildBinding,
  createAttributeBinding,
  createStyleBinding,
  createClassBinding,
  createShow,

  // Utilities
  isReactive,
  unwrap,
  useProp,

  // Debugging & DevTools
  getDevtoolsHook,
  setCycleProtectionOptions,
  type FictDevtoolsHook,

  // Low-level Primitives
  createRenderEffect,
} from '@fictjs/runtime/advanced'
