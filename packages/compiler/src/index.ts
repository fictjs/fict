/**
 * OXC/Rust compiler package root.
 *
 * The package root exposes the serializable native request API after M7 promotion. The
 * Babel-based compiler remains available only through `@fictjs/compiler/legacy` during the
 * compatibility window.
 */
export { nativeCompilerInfo, transformSync, transform, scanSync } from './native-loader'
export { scan, analyzeSync, analyze } from './native-loader'
export type { NativeCompilerInfo } from './native-loader'
export { COMPILER_PROTOCOL_VERSION, MODULE_REACTIVE_METADATA_VERSION } from './types'
export type * from './types'
export type * from './tooling/types'
