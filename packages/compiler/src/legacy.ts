/**
 * Explicit compatibility entrypoint for the Babel-based compiler.
 *
 * This entrypoint owns the complete compatibility API after the package root switches to Rust.
 * Integrations that intentionally use the rollback compiler import this subpath so the native root
 * cannot be mistaken for an implicit Babel dependency.
 */
export { default } from './legacy-compiler'
export * from './legacy-compiler'
