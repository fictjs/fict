/**
 * Explicit compatibility entrypoint for the Babel-based compiler.
 *
 * The package root remains an alias during the beta window. Integrations that intentionally use
 * the rollback compiler import this subpath so the eventual Rust-default root change cannot be
 * mistaken for an implicit Babel dependency.
 */
export { createFictPlugin, createFictPlugin as default, getCompilerCacheFingerprint } from './index'
export type { FictCompilerOptions } from './types'
