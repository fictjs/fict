import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

import {
  MODULE_REACTIVE_METADATA_VERSION,
  resolveStrictGuarantee,
  type CompileRequest,
  type FictDiagnostic,
  type ModuleReactiveMetadata,
  type NativeCompilerExplainArtifact,
  type NativeCompilerOptions,
  type NativeTypeScriptOptions,
  type RawSourceMap,
  type ResolvedMetadataInput,
  type ScanResult,
  type SourceLanguage,
} from '@fictjs/compiler'
import { loadNativeCompilerBinding, type NativeCompilerBinding } from '@fictjs/compiler/native'

import { isUnresolvedPackageResolution, readPackageMetadataAtBoundary } from './package-metadata'
import {
  createLocalResolutionKey,
  getLoaderBinding,
  normalizeFileName,
  normalizeWebpackResource,
  registerFictModule,
  storeFictModuleMetadata,
} from './shared'

export type FictWebpackTypeScriptOptions = NativeTypeScriptOptions

export interface FictWebpackLoaderOptions extends Omit<
  NativeCompilerOptions,
  'explain' | 'preview' | 'sourcemap' | 'typescript'
> {
  /** Enable TypeScript syntax lowering. Native mode infers the grammar from the filename. */
  typescript?: boolean
  /** Serializable OXC TypeScript lowering controls. */
  typescriptOptions?: FictWebpackTypeScriptOptions
  /** Receive native compiler diagnostics after Webpack-owned graph preparation. */
  onDiagnostic?: (diagnostic: FictDiagnostic) => void
  /** Request or consume the native structured explain artifact. */
  explain?: boolean | ((artifact: NativeCompilerExplainArtifact) => void)
  /** Webpack resumability is not supported until the integration owns chunks and a manifest. */
  resumable?: false | undefined
  /** Public module identities are integration-owned and unavailable in the Webpack loader. */
  publicModuleId?: never
  /** Explicit native addon path for local development and release verification. @internal */
  nativeCompilerPath?: string
}

interface FictLoaderContext {
  async(): (error?: Error | null, content?: string, sourceMap?: RawSourceMap | null) => void
  addDependency(file: string): void
  addMissingDependency(file: string): void
  cacheable(flag?: boolean): void
  emitWarning?(warning: Error): void
  getOptions(): FictWebpackLoaderOptions
  mode?: string
  resource: string
  resourcePath: string
  rootContext: string
  sourceMap: boolean
}

const nativeBindings = new Map<string, NativeCompilerBinding>()

function getNativeCompiler(options: FictWebpackLoaderOptions): NativeCompilerBinding {
  const nativePath = options.nativeCompilerPath ?? process.env.FICT_COMPILER_NATIVE_PATH
  const key = nativePath ?? '<platform-package>'
  let binding = nativeBindings.get(key)
  if (!binding) {
    binding = loadNativeCompilerBinding(nativePath ? { nativePath } : {})
    nativeBindings.set(key, binding)
  }
  return binding
}

function normalizeInputSourceMap(sourceMap: string | object | undefined): RawSourceMap | undefined {
  if (!sourceMap) return undefined
  if (typeof sourceMap !== 'string') {
    return sourceMap as RawSourceMap
  }
  try {
    return JSON.parse(sourceMap) as RawSourceMap
  } catch {
    return undefined
  }
}

function resolveThroughExistingAncestor(filename: string): string {
  let current = filename
  const missingSegments: string[] = []
  while (true) {
    try {
      return path.join(realpathSync(current), ...missingSegments)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return filename
      missingSegments.unshift(path.basename(current))
      current = parent
    }
  }
}

function unsupportedResumabilityError(options: FictWebpackLoaderOptions): Error | null {
  if ((options as { resumable?: unknown }).resumable === true) {
    return new Error(
      '[fict] @fictjs/webpack-plugin does not support `resumable: true`: the Webpack ' +
        'integration does not emit split handler chunks, assign public resumable module ' +
        'identities, or generate a resumability manifest. Remove `resumable: true` or use ' +
        '@fictjs/vite-plugin for resumable builds.',
    )
  }
  if (options.publicModuleId !== undefined) {
    return new Error(
      '[fict] `publicModuleId` is integration-owned and cannot enable Webpack resumability: ' +
        '@fictjs/webpack-plugin does not emit split handler chunks, assign public resumable ' +
        'module identities, or generate a resumability manifest. Remove `publicModuleId` or ' +
        'use @fictjs/vite-plugin for resumable builds.',
    )
  }
  return null
}

function stableStringify(value: unknown): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map(
      key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`
}

function metadataSnapshot(
  request: string,
  resolvedId: string | null,
  status: ResolvedMetadataInput['status'],
  metadata: ModuleReactiveMetadata | null,
): ResolvedMetadataInput {
  return {
    request,
    resolvedId,
    status,
    metadata,
    fingerprint: createHash('sha256')
      .update(stableStringify({ request, resolvedId, status, metadata }))
      .digest('hex'),
  }
}

function opaqueMetadataSnapshot(request: string, moduleIdentifier: string): ResolvedMetadataInput {
  return metadataSnapshot(request, `webpack:opaque:${moduleIdentifier}:${request}`, 'opaque', null)
}

function missingMetadataSnapshot(request: string): ResolvedMetadataInput {
  return metadataSnapshot(request, null, 'missing', null)
}

function resolveMetadataSnapshot(
  sourceRequest: string,
  moduleIdentifier: string,
  binding: NonNullable<ReturnType<typeof getLoaderBinding>>,
  registerMetadataDependency: (dependency: string) => void,
): ResolvedMetadataInput {
  binding.state.metadataSourcesByIdentifier.get(moduleIdentifier)!.add(sourceRequest)
  const packageResolutions = binding.state.packageResolutionsByIdentifier.get(moduleIdentifier)
  if (packageResolutions?.has(sourceRequest)) {
    const packageResolution = packageResolutions.get(sourceRequest)
    if (packageResolution === 'opaque') {
      return opaqueMetadataSnapshot(sourceRequest, moduleIdentifier)
    }
    if (
      !packageResolution ||
      packageResolution === 'unresolved' ||
      isUnresolvedPackageResolution(packageResolution)
    ) {
      return missingMetadataSnapshot(sourceRequest)
    }
    const result = readPackageMetadataAtBoundary(packageResolution, registerMetadataDependency)
    const resolvedId = `${packageResolution.packageJsonPath}#${packageResolution.publicSubpath ?? '.'}`
    if (result.kind === 'resolved') {
      return metadataSnapshot(sourceRequest, resolvedId, 'resolved', result.metadata)
    }
    if (result.kind === 'stale-boundary') throw new Error(result.message)
    return result.kind === 'plain'
      ? metadataSnapshot(sourceRequest, resolvedId, 'opaque', null)
      : missingMetadataSnapshot(sourceRequest)
  }

  if (sourceRequest.includes('!')) {
    return opaqueMetadataSnapshot(sourceRequest, moduleIdentifier)
  }
  const dependency = binding.state.resolvedLocalModules.get(
    createLocalResolutionKey(moduleIdentifier, sourceRequest),
  )
  if (dependency) {
    const metadata = binding.state.moduleMetadata.get(dependency)
    if (!metadata) return missingMetadataSnapshot(sourceRequest)
    return metadataSnapshot(
      sourceRequest,
      dependency,
      binding.state.incompleteModuleMetadata.has(dependency) ? 'incompleteCycle' : 'resolved',
      metadata,
    )
  }
  if (sourceRequest.includes('?')) {
    return opaqueMetadataSnapshot(sourceRequest, moduleIdentifier)
  }

  return binding.state.metadataGraphPrepared
    ? missingMetadataSnapshot(sourceRequest)
    : opaqueMetadataSnapshot(sourceRequest, moduleIdentifier)
}

function rewriteTypeScriptRequest(source: string): string {
  if (!source.startsWith('./') && !source.startsWith('../')) return source
  const match = /^(.*?)(\.tsx?|\.mts|\.cts)([?#].*)?$/.exec(source)
  if (!match) return source
  const extension = match[2]
  const emittedExtension = extension === '.mts' ? '.mjs' : extension === '.cts' ? '.cjs' : '.js'
  return `${match[1]}${emittedExtension}${match[3] ?? ''}`
}

function sourcePositionForByteOffset(
  source: string,
  byteOffset: number,
): { line: number; column: number } {
  const bytes = Buffer.from(source)
  const prefix = bytes.subarray(0, Math.min(Math.max(0, byteOffset), bytes.length)).toString('utf8')
  const lines = prefix.split('\n')
  return {
    line: lines.length,
    column: (lines[lines.length - 1]?.replace(/\r$/, '').length ?? 0) + 1,
  }
}

function nativeCompilerOptions(
  options: FictWebpackLoaderOptions,
  sourcemap: boolean,
): NativeCompilerOptions {
  const typescript = options.typescriptOptions
  return {
    dev: options.dev ?? false,
    sourcemap,
    explain: options.explain === true || typeof options.explain === 'function',
    lazyConditional: options.lazyConditional ?? true,
    getterCache: options.getterCache ?? true,
    fineGrainedDom: options.fineGrainedDom ?? true,
    optimize: options.optimize ?? true,
    optimizeLevel: options.optimizeLevel ?? 'safe',
    inlineDerivedMemos: options.inlineDerivedMemos ?? true,
    strictReactivity: options.strictReactivity ?? false,
    strictGuarantee: resolveStrictGuarantee(options.strictGuarantee),
    warningsAsErrors: options.warningsAsErrors ?? false,
    warningLevels: options.warningLevels ?? {},
    reactiveScopes: options.reactiveScopes ?? [],
    typescript: {
      allowNamespaces: typescript?.allowNamespaces ?? true,
      onlyRemoveTypeImports: typescript?.onlyRemoveTypeImports ?? false,
      optimizeConstEnums: typescript?.optimizeConstEnums ?? false,
      optimizeEnums: typescript?.optimizeEnums ?? false,
      rewriteImportExtensions: typescript?.rewriteImportExtensions ?? false,
      removeClassFieldsWithoutInitializer: typescript?.removeClassFieldsWithoutInitializer ?? false,
    },
  }
}

function nativeDiagnosticsError(
  diagnostics: readonly FictDiagnostic[],
  source: string,
  filename: string,
): Error | null {
  const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error')
  if (errors.length === 0) return null
  const format = (diagnostic: FictDiagnostic): string => {
    const position = diagnostic.primarySpan
      ? sourcePositionForByteOffset(source, diagnostic.primarySpan.start)
      : undefined
    const location = position ? `\n  at ${filename}:${position.line}:${position.column}` : ''
    const help = diagnostic.help ? `\n  help: ${diagnostic.help}` : ''
    return `[${diagnostic.code}] ${diagnostic.message}${location}${help}`
  }
  const error = new SyntaxError(errors.map(format).join('\n')) as SyntaxError & {
    code?: string
    loc?: { line: number; column: number }
  }
  const first = errors[0]!
  error.code = first.code
  if (first.primarySpan) error.loc = sourcePositionForByteOffset(source, first.primarySpan.start)
  return error
}

function runtimeModuleRequests(scan: ScanResult): string[] {
  return Array.from(
    new Set(
      scan.moduleRequests.filter(request => !request.typeOnly).map(request => request.source),
    ),
  ).sort()
}

function configuredSourceLanguage(
  filename: string,
  options: FictWebpackLoaderOptions,
): SourceLanguage | undefined {
  if (options.typescript !== false) return undefined
  return filename.toLowerCase().endsWith('.jsx') || filename.toLowerCase().endsWith('.tsx')
    ? 'jsx'
    : 'js'
}

export default function fictWebpackLoader(
  this: FictLoaderContext,
  source: string,
  inputSourceMap?: string | object,
): void {
  const callback = this.async()
  const options = this.getOptions()
  const resumabilityError = unsupportedResumabilityError(options)
  if (resumabilityError) {
    callback(resumabilityError)
    return
  }

  const binding = getLoaderBinding(this)
  if (!binding) {
    callback(
      new Error(
        '[fict] @fictjs/webpack-plugin/loader requires FictWebpackPlugin in webpack plugins.',
      ),
    )
    return
  }

  this.cacheable(true)
  let moduleIdentifier: string
  try {
    moduleIdentifier = registerFictModule(binding.state, binding.module)
  } catch (error) {
    callback(error instanceof Error ? error : new Error(String(error)))
    return
  }
  binding.state.incompleteModuleMetadata.delete(moduleIdentifier)
  if (!binding.state.moduleMetadata.has(moduleIdentifier)) {
    binding.state.moduleMetadata.set(moduleIdentifier, {
      version: MODULE_REACTIVE_METADATA_VERSION,
      exports: {},
    })
  }
  binding.state.metadataDependenciesByIdentifier.set(moduleIdentifier, new Set())
  binding.state.metadataSourcesByIdentifier.set(moduleIdentifier, new Set())
  binding.state.metadataRequestMappingsByIdentifier.set(moduleIdentifier, new Map())

  const webpackResource = normalizeWebpackResource(this.resource)
  const compilerFilename = normalizeFileName(this.resourcePath)
  const registerMetadataDependency = (dependency: string): void => {
    const normalized = path.resolve(dependency)
    const dependencies = new Set([normalized, resolveThroughExistingAncestor(normalized)])
    for (const watched of dependencies) {
      binding.state.metadataDependenciesByIdentifier.get(moduleIdentifier)!.add(watched)
      if (existsSync(watched)) this.addDependency(watched)
      else this.addMissingDependency(watched)
    }
  }
  const compilerOptions: FictWebpackLoaderOptions = {
    ...options,
    dev: options.dev ?? false,
  }
  let nativeCompiler: NativeCompilerBinding
  try {
    nativeCompiler = getNativeCompiler(compilerOptions)
  } catch (error) {
    callback(error instanceof Error ? error : new Error(String(error)))
    return
  }
  const language = configuredSourceLanguage(compilerFilename, compilerOptions)
  const normalizedInputSourceMap = normalizeInputSourceMap(inputSourceMap)

  void nativeCompiler
    .scan({
      code: source,
      filename: webpackResource,
      moduleId: moduleIdentifier,
      ...(language ? { language } : {}),
    })
    .then(scan => {
      const scanError = nativeDiagnosticsError(scan.diagnostics, source, compilerFilename)
      if (scanError) throw scanError
      const requests = runtimeModuleRequests(scan)
      const requestMappings =
        binding.state.metadataRequestMappingsByIdentifier.get(moduleIdentifier)!
      const metadata = requests.map(sourceRequest => {
        requestMappings.set(
          sourceRequest,
          compilerOptions.typescriptOptions?.rewriteImportExtensions
            ? rewriteTypeScriptRequest(sourceRequest)
            : sourceRequest,
        )
        return resolveMetadataSnapshot(
          sourceRequest,
          moduleIdentifier,
          binding,
          registerMetadataDependency,
        )
      })
      const request: CompileRequest = {
        code: source,
        filename: webpackResource,
        moduleId: moduleIdentifier,
        ...(language ? { language } : {}),
        ...(normalizedInputSourceMap ? { inputSourceMap: normalizedInputSourceMap } : {}),
        options: nativeCompilerOptions(compilerOptions, this.sourceMap),
        metadata,
      }
      return nativeCompiler.transform(request)
    })
    .then(result => {
      for (const diagnostic of result.diagnostics) {
        if (diagnostic.severity !== 'warning') continue
        if (compilerOptions.onDiagnostic) {
          compilerOptions.onDiagnostic(diagnostic)
        } else if (this.emitWarning) {
          const emitted = new Error(`[${diagnostic.code}] ${diagnostic.message}`)
          emitted.name = 'FictCompilerDiagnostic'
          this.emitWarning(emitted)
        }
      }
      if (result.explain && typeof compilerOptions.explain === 'function') {
        compilerOptions.explain(result.explain)
      }
      const transformError = nativeDiagnosticsError(result.diagnostics, source, compilerFilename)
      if (transformError) throw transformError

      if (result.metadataIncomplete) {
        binding.state.incompleteModuleMetadata.add(moduleIdentifier)
      } else {
        binding.state.incompleteModuleMetadata.delete(moduleIdentifier)
      }
      binding.state.moduleMetadata.set(moduleIdentifier, result.moduleMetadata)
      storeFictModuleMetadata(
        binding.state,
        binding.module,
        result.moduleMetadata,
        binding.state.pendingDependencyFingerprints.get(moduleIdentifier) ?? null,
      )
      callback(null, result.code, result.map)
    })
    .catch(error => callback(error instanceof Error ? error : new Error(String(error))))
}
