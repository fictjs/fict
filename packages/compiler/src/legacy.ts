/**
 * Explicit compatibility entrypoint for the Babel-based compiler.
 *
 * The package root remains an equivalent facade during the beta window, but this entrypoint owns a
 * direct implementation edge. Integrations that intentionally use the rollback compiler import
 * this subpath so the eventual Rust-default root change cannot be mistaken for an implicit Babel
 * dependency.
 */
export { default, createFictPlugin, getCompilerCacheFingerprint } from './legacy-compiler'
export type { FictCompilerOptions } from './types'
