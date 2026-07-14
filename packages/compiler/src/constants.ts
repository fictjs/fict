/**
 * @fileoverview Compiler Constants for Runtime Integration
 *
 * IMPORTANT: Runtime helper constants are generated from
 * packages/runtime/runtime-abi.json. Edit the manifest and regenerate both
 * compiler and Rust tables instead of changing helper names in this file.
 *
 * API Stability: Tier 2 (Internal Stable)
 * - RUNTIME_HELPERS names/signatures must remain stable for v1.x
 * - Compiled code depends on these helper names
 * - Changes require runtime version bump and migration guide
 *
 * @see docs/api-freeze-v1.md for full API stability policy
 */

import {
  RUNTIME_HELPER_MODULES,
  RUNTIME_MODULES,
  RUNTIME_DELEGATED_EVENTS,
} from './runtime-abi.generated'
import type { RUNTIME_HELPERS } from './runtime-abi.generated'

export { RUNTIME_ABI_VERSION, RUNTIME_ALIASES, RUNTIME_HELPERS } from './runtime-abi.generated'

// ============================================================================
// Runtime Constants
// ============================================================================

export type RuntimeImportFamily = 'fict' | 'runtime'

const FICT_RUNTIME_IMPORT_MODULES = new Set([
  'fict',
  'fict/advanced',
  'fict/internal',
  'fict/internal/list',
  'fict/jsx-runtime',
  'fict/jsx-dev-runtime',
  'fict/experimental/loader',
  'fict/plus',
  'fict/slim',
])

const STANDALONE_RUNTIME_IMPORT_MODULES = new Set([
  '@fictjs/runtime',
  '@fictjs/runtime/advanced',
  '@fictjs/runtime/internal',
  '@fictjs/runtime/internal/list',
  '@fictjs/runtime/jsx-runtime',
  '@fictjs/runtime/jsx-dev-runtime',
  '@fictjs/runtime/experimental/loader',
])

/**
 * Compiler-generated helpers should follow the package family that the source
 * module already uses. This keeps `fict` apps self-contained while preserving
 * direct `@fictjs/runtime` usage for lower-level integrations.
 */
export const DEFAULT_RUNTIME_IMPORT_FAMILY: RuntimeImportFamily = 'fict'

/**
 * Infer which package family compiler-generated helpers should use.
 *
 * Rules:
 * - Prefer `fict` whenever a module already imports from the main framework.
 * - Fall back to `@fictjs/runtime` only for runtime-only modules.
 * - Default to `fict` when there is no signal in source imports.
 */
export function detectRuntimeImportFamily(body: readonly unknown[]): RuntimeImportFamily {
  let sawFictFamily = false
  let sawStandaloneRuntimeFamily = false

  for (const stmt of body) {
    const source =
      stmt && typeof stmt === 'object' && 'source' in stmt
        ? (stmt as { source?: { value?: string } | null }).source?.value
        : undefined
    if (typeof source !== 'string') continue

    if (FICT_RUNTIME_IMPORT_MODULES.has(source)) {
      sawFictFamily = true
      continue
    }

    if (STANDALONE_RUNTIME_IMPORT_MODULES.has(source)) {
      sawStandaloneRuntimeFamily = true
    }
  }

  if (sawFictFamily) return 'fict'
  if (sawStandaloneRuntimeFamily) return 'runtime'
  return DEFAULT_RUNTIME_IMPORT_FAMILY
}

export function isRuntimeImportModule(source: string): boolean {
  return FICT_RUNTIME_IMPORT_MODULES.has(source) || STANDALONE_RUNTIME_IMPORT_MODULES.has(source)
}

/**
 * The runtime module path for compiler-generated imports.
 * Uses the internal subpath to access compiler-dependent APIs.
 */
export function getRuntimeModule(family: RuntimeImportFamily): string {
  return RUNTIME_MODULES[family].internal
}

/**
 * Runtime helper function names used by compiler-generated code.
 * @internal These names are part of the compiler-runtime ABI contract.
 */
export type RuntimeHelperName = keyof typeof RUNTIME_HELPERS

/**
 * Optional per-helper module overrides.
 *
 * By default, helpers are imported from {@link getRuntimeModule}. Use this map
 * to route heavyweight helpers to narrower subpath entry points so bundlers
 * don't pull the full internal barrel.
 */
export function getRuntimeHelperModule(
  family: RuntimeImportFamily,
  helper: RuntimeHelperName,
): string {
  if (RUNTIME_HELPER_MODULES[helper] === 'list') {
    return RUNTIME_MODULES[family].list
  }

  return getRuntimeModule(family)
}

// Attributes that should NOT be wrapped in reactive functions
export const NON_REACTIVE_ATTRS = new Set(['key', 'ref'])

/**
 * Events that should use event delegation for performance.
 * These events bubble and are commonly used across many elements.
 * Must match the runtime's DelegatedEvents set.
 */
export const DelegatedEvents = new Set<string>(RUNTIME_DELEGATED_EVENTS)

// Functions that are known to be safe (read-only, won't mutate passed objects)
export const SAFE_FUNCTIONS = new Set([
  // Console methods
  'console.log',
  'console.info',
  'console.warn',
  'console.error',
  'console.debug',
  'console.trace',
  'console.dir',
  'console.table',
  // JSON methods
  'JSON.stringify',
  'JSON.parse',
  // Object methods (read-only)
  'Object.keys',
  'Object.values',
  'Object.entries',
  'Object.isFrozen',
  'Object.isSealed',
  'Object.isExtensible',
  'Object.getOwnPropertyNames',
  'Object.getOwnPropertyDescriptor',
  'Object.getPrototypeOf',
  // Array methods (read-only)
  'Array.isArray',
  'Array.from',
  'Array.of',
  // Math methods
  'Math.abs',
  'Math.ceil',
  'Math.floor',
  'Math.round',
  'Math.max',
  'Math.min',
  'Math.pow',
  'Math.sqrt',
  'Math.random',
  'Math.sin',
  'Math.cos',
  'Math.tan',
  'Math.log',
  'Math.exp',
  'Math.sign',
  'Math.trunc',
  // Type conversion/checking
  'String',
  'Number',
  'Boolean',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'typeof',
  // Date methods (read-only)
  'Date.now',
  'Date.parse',
])
