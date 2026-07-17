export type NativeLibc = 'gnu' | 'musl' | 'unknown'

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readProcessReport(): unknown {
  try {
    return process.report?.getReport()
  } catch {
    return null
  }
}

export function detectLinuxLibc(report: unknown = readProcessReport()): NativeLibc {
  if (!isRecord(report) || !isRecord(report.header)) return 'unknown'
  if (Object.prototype.hasOwnProperty.call(report.header, 'glibcVersionRuntime')) {
    const glibcVersion = report.header.glibcVersionRuntime
    return typeof glibcVersion === 'string' && glibcVersion.trim() ? 'gnu' : 'unknown'
  }
  return report.header.platform === 'linux' && typeof report.header.reportVersion === 'number'
    ? 'musl'
    : 'unknown'
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

export function nativeTargetCandidates(target: string): readonly string[] {
  if (target === 'linux-arm64-unknown') {
    return ['linux-arm64-gnu', 'linux-arm64-musl']
  }
  if (target === 'linux-x64-unknown') {
    return ['linux-x64-gnu', 'linux-x64-musl']
  }
  return [target]
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
