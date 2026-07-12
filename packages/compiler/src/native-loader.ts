import { createRequire } from 'node:module'

export type NativeLibc = 'gnu' | 'musl'

export interface NativeCompilerInfo {
  backend: 'rust'
  oxcVersion: string
  nodeApiVersion: number
}

export interface NativeParseProbeResult {
  statementCount: number
  diagnosticCount: number
}

export interface NativeCompilerBinding {
  nativeCompilerInfo(): NativeCompilerInfo
  parseTsxProbeSync(source: string): NativeParseProbeResult
  parseTsxProbeAsync(source: string): Promise<NativeParseProbeResult>
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
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return `darwin-${arch}`
  }
  if (platform === 'linux' && (arch === 'arm64' || arch === 'x64')) {
    return `linux-${arch}-${detectLinuxLibc(report)}`
  }
  if (platform === 'win32' && (arch === 'arm64' || arch === 'x64')) {
    return `win32-${arch}-msvc`
  }

  throw new NativeCompilerLoadError(
    `The Fict Rust compiler does not provide a native package for ${platform}/${arch}.`,
    `${platform}-${arch}`,
  )
}

export function nativeCompilerPackageName(target: string): string {
  return `@fictjs/compiler-${target}`
}

function toNativeBinding(value: unknown, candidate: string): NativeCompilerBinding {
  const possibleDefault = isRecord(value) ? value.default : undefined
  const binding = isRecord(possibleDefault) ? possibleDefault : value
  if (
    !isRecord(binding) ||
    typeof binding.nativeCompilerInfo !== 'function' ||
    typeof binding.parseTsxProbeSync !== 'function' ||
    typeof binding.parseTsxProbeAsync !== 'function'
  ) {
    throw new Error(`Native package ${candidate} does not expose the Fict compiler binding.`)
  }

  const typed = binding as unknown as NativeCompilerBinding
  const info = typed.nativeCompilerInfo()
  if (info.backend !== 'rust' || info.nodeApiVersion < 10 || !info.oxcVersion) {
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
  const load = options.load ?? requireFromCompiler
  const candidates = options.nativePath ? [options.nativePath] : [nativeCompilerPackageName(target)]
  const failures: string[] = []

  for (const candidate of candidates) {
    try {
      return toNativeBinding(load(candidate), candidate)
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
