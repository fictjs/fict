import { createRequire } from 'node:module'

import {
  NativeCompilerLoadError,
  nativeCompilerPackageName,
  nativeCompilerRustTarget,
  nativeTargetCandidates,
  resolveNativeTarget,
} from './native-target'
import type { AnalyzeResult } from './tooling/types'
import type {
  AnalyzeRequest,
  CompileRequest,
  CompileResult,
  ScanRequest,
  ScanResult,
} from './types'

export {
  NativeCompilerLoadError,
  detectLinuxLibc,
  nativeCompilerPackageName,
  nativeCompilerRustTarget,
  resolveNativeTarget,
} from './native-target'
export type { NativeLibc } from './native-target'

export interface NativeCompilerInfo {
  backend: 'rust'
  nativeTarget: string
  oxcVersion: string
  nodeApiVersion: number
  compilerBuildId: string
  compilerBuildRevision: string | null
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

/**
 * Serializable direct-compiler API exposed by `@fictjs/compiler/native`.
 *
 * The facade intentionally omits the parser probes used by release verification. It owns only
 * binding discovery and method forwarding; filesystem resolution and bundler graph callbacks
 * remain integration responsibilities.
 */
export type NativeCompilerFacade = Pick<
  NativeCompilerBinding,
  | 'nativeCompilerInfo'
  | 'transformSync'
  | 'transform'
  | 'scanSync'
  | 'scan'
  | 'analyzeSync'
  | 'analyze'
>

const requireFromCompiler = createRequire(import.meta.url)
const OXC_RUNTIME_HELPER_PREFIX = '@oxc-project/runtime/helpers/'
const EXPECTED_OXC_VERSION = '0.139.0'
const EXPECTED_COMPILER_PROTOCOL_VERSION = 1
const EXPECTED_METADATA_SCHEMA_VERSION = 1

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
  expectedNativeTargets: readonly string[],
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
  if (!expectedNativeTargets.includes(info.nativeTarget)) {
    throw new Error(
      `Native package ${candidate} reported ABI target ${String(info.nativeTarget)}; expected ${expectedNativeTargets.join(' or ')}.`,
    )
  }
  const expectedBuildPrefix =
    `fict-rust-p${EXPECTED_COMPILER_PROTOCOL_VERSION}` +
    `-oxc${EXPECTED_OXC_VERSION}-m${EXPECTED_METADATA_SCHEMA_VERSION}-`
  const sourceHash = info.compilerBuildId?.slice(expectedBuildPrefix.length)
  if (
    info.backend !== 'rust' ||
    info.nodeApiVersion < 10 ||
    info.oxcVersion !== EXPECTED_OXC_VERSION ||
    info.compilerProtocolVersion !== EXPECTED_COMPILER_PROTOCOL_VERSION ||
    info.metadataSchemaVersion !== EXPECTED_METADATA_SCHEMA_VERSION ||
    !info.compilerBuildId?.startsWith(expectedBuildPrefix) ||
    !/^[0-9a-f]{64}$/.test(sourceHash ?? '') ||
    (info.compilerBuildRevision !== null &&
      !/^[0-9a-f]{40}$/.test(info.compilerBuildRevision ?? ''))
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
  const target = resolveNativeTarget(platform, arch, options.report)
  const concreteTargets = nativeTargetCandidates(target)
  const load = options.load ?? requireFromCompiler
  const candidates = options.nativePath
    ? [
        {
          id: options.nativePath,
          expectedNativeTargets: concreteTargets.map(nativeCompilerRustTarget),
        },
      ]
    : concreteTargets.map(concreteTarget => ({
        id: nativeCompilerPackageName(concreteTarget),
        expectedNativeTargets: [nativeCompilerRustTarget(concreteTarget)],
      }))
  const failures: string[] = []

  for (const candidate of candidates) {
    try {
      return toNativeBinding(load(candidate.id), candidate.id, candidate.expectedNativeTargets)
    } catch (error) {
      failures.push(`${candidate.id}: ${errorMessage(error)}`)
    }
  }

  const attempted = candidates.map(candidate => candidate.id)

  throw new NativeCompilerLoadError(
    [
      `Unable to load the Fict Rust compiler for ${platform}/${arch} (${target}).`,
      `Attempted: ${attempted.join(', ')}.`,
      ...failures,
      'Reinstall @fictjs/compiler with optional dependencies enabled or provide nativePath explicitly.',
    ].join(' '),
    target,
    attempted,
  )
}

function defaultNativeLoaderOptions(): NativeLoaderOptions {
  const nativePath = process.env.FICT_COMPILER_NATIVE_PATH
  return nativePath ? { nativePath } : {}
}

/**
 * Create a lazy direct-compiler facade. One validated native binding is shared by every request
 * made through the returned facade, which guarantees a single compiler build id per host facade.
 */
export function createNativeCompilerFacade(options?: NativeLoaderOptions): NativeCompilerFacade {
  let binding: NativeCompilerBinding | undefined
  const compiler = (): NativeCompilerBinding =>
    (binding ??= loadNativeCompilerBinding(options ?? defaultNativeLoaderOptions()))

  return {
    nativeCompilerInfo: () => compiler().nativeCompilerInfo(),
    transformSync: request => compiler().transformSync(request),
    transform: request => compiler().transform(request),
    scanSync: request => compiler().scanSync(request),
    scan: request => compiler().scan(request),
    analyzeSync: request => compiler().analyzeSync(request),
    analyze: request => compiler().analyze(request),
  }
}

const defaultNativeCompiler = createNativeCompilerFacade()

/** Direct OXC/Rust request functions. No function retries through the legacy compiler. */
export const { nativeCompilerInfo, transformSync, transform, scanSync } = defaultNativeCompiler
export const { scan, analyzeSync, analyze } = defaultNativeCompiler
