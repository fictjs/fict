/**
 * Package-root compatibility facade for the beta rollout.
 *
 * The root deliberately preserves the Babel plugin API until M7 promotion is authorized. The
 * implementation lives behind a legacy-owned module so a later Rust-default root can replace this
 * facade without making `@fictjs/compiler/legacy` depend on, or cycle through, the new root.
 */
export { createFictPlugin as default } from './legacy-compiler'
export * from './legacy-compiler'
