import { createRequire } from 'node:module'

import type { AnalyzeResult } from './tooling/types'
import type {
  AnalyzeRequest,
  CompileRequest,
  CompileResult,
  ScanRequest,
  ScanResult,
} from './types'

export type NativeLibc = 'gnu' | 'musl'

export interface NativeCompilerInfo {
  backend: 'rust'
  nativeTarget: string
  oxcVersion: string
  nodeApiVersion: number
  compilerBuildId: string
  compilerProtocolVersion: number
  metadataSchemaVersion: number
}

export interface NativeParseProbeResult {
  statementCount: number
  diagnosticCount: number
}

export interface NativeCompilerBinding {
  nativeCompilerInfo(): NativeCompilerInfo
  parseTsxProbeSync(source: string): NativeParseProbeResult
  parseTsxProbeAsync(source: string): Promise<NativeParseProbeResult>
  transformSync(request: CompileRequest): CompileResult
  transform(request: CompileRequest): Promise<CompileResult>
  scanSync(request: ScanRequest): ScanResult
  scan(request: ScanRequest): Promise<ScanResult>
  analyzeSync(request: AnalyzeRequest): AnalyzeResult
  analyze(request: AnalyzeRequest): Promise<AnalyzeResult>
}

export interface NativeLoaderOptions {
  nativePath?: string
  platform?: NodeJS.Platform
  arch?: string
  report?: unknown
  load?: (id: string) => unknown
}

export class NativeCompilerLoadError extends Error {
  readonly code = 'FICT_NATIVE_COMPILER_LOAD_FAILED'
  readonly target: string
  readonly attempted: readonly string[]

  constructor(message: string, target: string, attempted: readonly string[] = []) {
    super(message)
    this.name = 'NativeCompilerLoadError'
    this.target = target
    this.attempted = attempted
  }
}

const requireFromCompiler = createRequire(import.meta.url)
const OXC_RUNTIME_HELPER_PREFIX = '@oxc-project/runtime/helpers/'
const EXPECTED_OXC_VERSION = '0.139.0'
const EXPECTED_COMPILER_PROTOCOL_VERSION = 1
const EXPECTED_METADATA_SCHEMA_VERSION = 1

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function detectLinuxLibc(report: unknown = process.report?.getReport()): NativeLibc {
  if (!isRecord(report) || !isRecord(report.header)) return 'musl'
  return typeof report.header.glibcVersionRuntime === 'string' ? 'gnu' : 'musl'
}

export function resolveNativeTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  report?: unknown,
): string {
  const libc = platform === 'linux' ? detectLinuxLibc(report) : null
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return `darwin-${arch}`
  }
  if (platform === 'linux' && (arch === 'arm64' || arch === 'x64')) {
    return `linux-${arch}-${libc}`
  }
  if (platform === 'win32' && (arch === 'arm64' || arch === 'x64')) {
    return `win32-${arch}-msvc`
  }

  throw new NativeCompilerLoadError(
    `The Fict Rust compiler does not provide a native package for ${platform}/${arch}${libc ? ` (${libc})` : ''}.`,
    `${platform}-${arch}${libc ? `-${libc}` : ''}`,
  )
}

export function nativeCompilerPackageName(target: string): string {
  return `@fictjs/compiler-${target}`
}

export function nativeCompilerRustTarget(target: string): string {
  const rustTargets: Readonly<Record<string, string>> = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64-gnu': 'aarch64-unknown-linux-gnu',
    'linux-arm64-musl': 'aarch64-unknown-linux-musl',
    'linux-x64-gnu': 'x86_64-unknown-linux-gnu',
    'linux-x64-musl': 'x86_64-unknown-linux-musl',
    'win32-arm64-msvc': 'aarch64-pc-windows-msvc',
    'win32-x64-msvc': 'x86_64-pc-windows-msvc',
  }
  const rustTarget = rustTargets[target]
  if (!rustTarget) {
    throw new NativeCompilerLoadError(
      `The Fict Rust compiler does not recognize native target ${target}.`,
      target,
    )
  }
  return rustTarget
}

/** Resolve an OXC-generated helper from the compiler's pinned runtime dependency. */
export function resolveNativeCompilerRuntimeHelper(request: string): string | undefined {
  if (!request.startsWith(OXC_RUNTIME_HELPER_PREFIX)) return undefined
  const subpath = request.slice(OXC_RUNTIME_HELPER_PREFIX.length)
  if (!subpath || subpath.split('/').some(segment => !/^[A-Za-z0-9_-]+$/.test(segment))) {
    return undefined
  }
  return requireFromCompiler.resolve(request)
}

function toNativeBinding(
  value: unknown,
  candidate: string,
  expectedNativeTarget: string,
): NativeCompilerBinding {
  const possibleDefault = isRecord(value) ? value.default : undefined
  const binding = isRecord(possibleDefault) ? possibleDefault : value
  if (
    !isRecord(binding) ||
    typeof binding.nativeCompilerInfo !== 'function' ||
    typeof binding.parseTsxProbeSync !== 'function' ||
    typeof binding.parseTsxProbeAsync !== 'function' ||
    typeof binding.transformSync !== 'function' ||
    typeof binding.transform !== 'function' ||
    typeof binding.scanSync !== 'function' ||
    typeof binding.scan !== 'function' ||
    typeof binding.analyzeSync !== 'function' ||
    typeof binding.analyze !== 'function'
  ) {
    throw new Error(`Native package ${candidate} does not expose the Fict compiler binding.`)
  }

  const typed = binding as unknown as NativeCompilerBinding
  const info = typed.nativeCompilerInfo()
  const expectedBuildPrefix =
    `fict-rust-p${EXPECTED_COMPILER_PROTOCOL_VERSION}` +
    `-oxc${EXPECTED_OXC_VERSION}-m${EXPECTED_METADATA_SCHEMA_VERSION}-`
  const sourceHash = info.compilerBuildId?.slice(expectedBuildPrefix.length)
  if (
    info.backend !== 'rust' ||
    info.nativeTarget !== expectedNativeTarget ||
    info.nodeApiVersion < 10 ||
    info.oxcVersion !== EXPECTED_OXC_VERSION ||
    info.compilerProtocolVersion !== EXPECTED_COMPILER_PROTOCOL_VERSION ||
    info.metadataSchemaVersion !== EXPECTED_METADATA_SCHEMA_VERSION ||
    !info.compilerBuildId?.startsWith(expectedBuildPrefix) ||
    !/^[0-9a-f]{64}$/.test(sourceHash ?? '')
  ) {
    throw new Error(`Native package ${candidate} reported incompatible compiler metadata.`)
  }
  return typed
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function loadNativeCompilerBinding(
  options: NativeLoaderOptions = {},
): NativeCompilerBinding {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const report = options.report ?? process.report?.getReport()
  const target = resolveNativeTarget(platform, arch, report)
  const expectedNativeTarget = nativeCompilerRustTarget(target)
  const load = options.load ?? requireFromCompiler
  const candidates = options.nativePath ? [options.nativePath] : [nativeCompilerPackageName(target)]
  const failures: string[] = []

  for (const candidate of candidates) {
    try {
      return toNativeBinding(load(candidate), candidate, expectedNativeTarget)
    } catch (error) {
      failures.push(`${candidate}: ${errorMessage(error)}`)
    }
  }

  throw new NativeCompilerLoadError(
    [
      `Unable to load the Fict Rust compiler for ${platform}/${arch} (${target}).`,
      `Attempted: ${candidates.join(', ')}.`,
      ...failures,
      'Reinstall @fictjs/compiler with optional dependencies enabled or provide nativePath explicitly.',
    ].join(' '),
    target,
    candidates,
  )
}
