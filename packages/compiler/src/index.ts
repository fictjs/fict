/**
 * OXC/Rust compiler package root.
 *
 * The package root exposes the serializable OXC/Rust request API. Fict 0.31 has no in-package
 * legacy compiler or per-file fallback path.
 */
export { nativeCompilerInfo, transformSync, transform, scanSync } from './native-loader'
export { scan, analyzeSync, analyze } from './native-loader'
export type { NativeCompilerInfo } from './native-loader'
export { COMPILER_PROTOCOL_VERSION, MODULE_REACTIVE_METADATA_VERSION } from './types'
export type * from './types'
export type * from './tooling/types'
