import { createHash } from 'node:crypto'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'

import type { ModuleReactiveMetadata, RawSourceMap } from '@fictjs/compiler'

export type CompilerShadowDifferenceCategory =
  | 'status'
  | 'diagnostics'
  | 'metadata'
  | 'semantic-events'
  | 'helpers'
  | 'source-map'
  | 'artifacts'
  | 'output'

export interface CompilerShadowDiagnostic {
  code: string
  severity: 'error' | 'warning' | 'info'
  line?: number
  column?: number
}

export interface CompilerShadowSemanticEvent {
  kind: string
  name?: string
  code?: string
}

export interface CompilerShadowBackendSnapshot {
  status: 'success' | 'failure'
  code: string
  diagnostics: readonly CompilerShadowDiagnostic[]
  metadata?: ModuleReactiveMetadata
  semanticEvents?: readonly CompilerShadowSemanticEvent[]
  helpers?: readonly string[]
  sourceMap?: RawSourceMap | null
  artifacts?: readonly { id: string; kind: string; code: string }[]
}

export interface CompilerShadowAllowlistRule {
  id: string
  category: CompilerShadowDifferenceCategory
  reason: string
  moduleHash?: string
  legacyDigest?: string
  rustDigest?: string
}

export interface CompilerShadowAllowlist {
  version: 1
  rules: CompilerShadowAllowlistRule[]
}

export interface CompilerShadowDifference {
  category: CompilerShadowDifferenceCategory
  legacyDigest: string
  rustDigest: string
  disposition: 'expected' | 'unexplained'
  allowlistRuleId?: string
}

export interface CompilerShadowModuleResult {
  moduleHash: string
  sourceDigest: string
  equivalent: boolean
  differences: CompilerShadowDifference[]
}

export interface CompilerShadowArtifact {
  schemaVersion: 2
  backend: 'shadow'
  compilerBuildId: string
  compilerBuildRevision: string | null
  allowlistVersion: number | null
  summary: {
    modules: number
    equivalentModules: number
    expectedDifferences: number
    unexplainedDifferences: number
  }
  modules: CompilerShadowModuleResult[]
}

export interface CompilerShadowRecorderOptions {
  root: string
  compilerBuildId: string
  compilerBuildRevision: string | null
  reportPath: string
  allowlistPath?: string
  onResult?: (result: CompilerShadowModuleResult) => void
}

const STRUCTURAL_WILDCARD_CATEGORIES = new Set<CompilerShadowDifferenceCategory>([
  'helpers',
  'output',
])

function stableValue(value: unknown): unknown {
  if (value === undefined) return { $type: 'undefined' }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Shadow values must contain finite numbers')
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value !== 'object') {
    throw new TypeError(`Shadow values cannot contain ${typeof value} values`)
  }
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    output[key] = stableValue((value as Record<string, unknown>)[key])
  }
  return output
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')}`
}

function normalizeHelperName(name: string): string {
  return name
    .replace(/^__fict/, '')
    .replace(/^fict/i, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toLowerCase()
}

function normalizeDiagnostics(
  diagnostics: readonly CompilerShadowDiagnostic[],
): CompilerShadowDiagnostic[] {
  return diagnostics
    .map(diagnostic => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
      ...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function normalizeSemanticEvents(
  events: readonly CompilerShadowSemanticEvent[] | undefined,
): CompilerShadowSemanticEvent[] {
  const normalized = (events ?? [])
    .filter(event => event.kind.startsWith('source-'))
    .map(event => ({
      kind: event.kind,
      ...(event.name ? { name: event.name } : {}),
      ...(event.code ? { code: event.code } : {}),
    }))
  return Array.from(
    new Map(normalized.map(event => [JSON.stringify(event), event] as const)).values(),
  ).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function normalizeHelpers(helpers: readonly string[] | undefined): string[] {
  return Array.from(new Set((helpers ?? []).map(normalizeHelperName))).sort()
}

function sourceMapSummary(
  sourceMap: RawSourceMap | null | undefined,
  source: string,
): Record<string, unknown> {
  if (!sourceMap) return { present: false }
  return {
    present: true,
    version: sourceMap.version,
    hasMappings: sourceMap.mappings.length > 0,
    sourceCount: sourceMap.sources.length,
    sourceContentCount: sourceMap.sourcesContent?.length ?? 0,
    containsExactSource: sourceMap.sourcesContent?.includes(source) ?? false,
  }
}

function artifactSummary(
  artifacts: CompilerShadowBackendSnapshot['artifacts'],
): { kind: string; codeDigest: string }[] {
  return (artifacts ?? [])
    .map(artifact => ({ kind: artifact.kind, codeDigest: digest(artifact.code) }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function categoryValue(
  category: CompilerShadowDifferenceCategory,
  snapshot: CompilerShadowBackendSnapshot,
  source: string,
): unknown {
  switch (category) {
    case 'status':
      return snapshot.status
    case 'diagnostics':
      return normalizeDiagnostics(snapshot.diagnostics)
    case 'metadata':
      return snapshot.metadata ?? null
    case 'semantic-events':
      return normalizeSemanticEvents(snapshot.semanticEvents)
    case 'helpers':
      return normalizeHelpers(snapshot.helpers)
    case 'source-map':
      return sourceMapSummary(snapshot.sourceMap, source)
    case 'artifacts':
      return artifactSummary(snapshot.artifacts)
    case 'output':
      return snapshot.code.replace(/\r\n?/g, '\n')
  }
}

function validateDigest(value: string | undefined, label: string): void {
  if (value === undefined) return
  if (value !== '*' && !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be "*" or a sha256 digest`)
  }
}

export function validateCompilerShadowAllowlist(value: unknown): CompilerShadowAllowlist {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Compiler shadow allowlist must be an object')
  }
  const candidate = value as Partial<CompilerShadowAllowlist>
  if (candidate.version !== 1 || !Array.isArray(candidate.rules)) {
    throw new TypeError('Compiler shadow allowlist must use schema version 1')
  }
  const ids = new Set<string>()
  const categories = new Set<CompilerShadowDifferenceCategory>([
    'status',
    'diagnostics',
    'metadata',
    'semantic-events',
    'helpers',
    'source-map',
    'artifacts',
    'output',
  ])
  for (const rule of candidate.rules) {
    if (!rule || typeof rule !== 'object') throw new TypeError('Allowlist rules must be objects')
    if (typeof rule.id !== 'string' || !rule.id.trim() || ids.has(rule.id)) {
      throw new TypeError('Allowlist rule ids must be unique non-empty strings')
    }
    ids.add(rule.id)
    if (!categories.has(rule.category))
      throw new TypeError(`Unknown shadow category ${rule.category}`)
    if (typeof rule.reason !== 'string' || rule.reason.trim().length < 20) {
      throw new TypeError(`Allowlist rule ${rule.id} must document a meaningful reason`)
    }
    validateDigest(rule.moduleHash, `${rule.id}.moduleHash`)
    validateDigest(rule.legacyDigest, `${rule.id}.legacyDigest`)
    validateDigest(rule.rustDigest, `${rule.id}.rustDigest`)
    const usesWildcard =
      rule.moduleHash === '*' || rule.legacyDigest === '*' || rule.rustDigest === '*'
    if (usesWildcard && !STRUCTURAL_WILDCARD_CATEGORIES.has(rule.category)) {
      throw new TypeError(
        `Allowlist rule ${rule.id} cannot wildcard semantic category ${rule.category}`,
      )
    }
    if (
      !STRUCTURAL_WILDCARD_CATEGORIES.has(rule.category) &&
      (rule.moduleHash === undefined ||
        rule.legacyDigest === undefined ||
        rule.rustDigest === undefined)
    ) {
      throw new TypeError(
        `Allowlist rule ${rule.id} must pin moduleHash, legacyDigest, and rustDigest for semantic category ${rule.category}`,
      )
    }
  }
  return candidate as CompilerShadowAllowlist
}

function readAllowlist(filename: string | undefined): CompilerShadowAllowlist | null {
  if (!filename) return null
  return validateCompilerShadowAllowlist(JSON.parse(readFileSync(filename, 'utf8')))
}

function ruleMatches(
  rule: CompilerShadowAllowlistRule,
  moduleHash: string,
  category: CompilerShadowDifferenceCategory,
  legacyDigest: string,
  rustDigest: string,
): boolean {
  return (
    rule.category === category &&
    (rule.moduleHash === undefined || rule.moduleHash === '*' || rule.moduleHash === moduleHash) &&
    (rule.legacyDigest === undefined ||
      rule.legacyDigest === '*' ||
      rule.legacyDigest === legacyDigest) &&
    (rule.rustDigest === undefined || rule.rustDigest === '*' || rule.rustDigest === rustDigest)
  )
}

const COMPARISON_CATEGORIES: CompilerShadowDifferenceCategory[] = [
  'status',
  'diagnostics',
  'metadata',
  'semantic-events',
  'helpers',
  'source-map',
  'artifacts',
  'output',
]

export class CompilerShadowRecorder {
  readonly reportPath: string
  private readonly root: string
  private readonly compilerBuildId: string
  private readonly compilerBuildRevision: string | null
  private readonly allowlist: CompilerShadowAllowlist | null
  private readonly onResult: ((result: CompilerShadowModuleResult) => void) | undefined
  private readonly results = new Map<string, CompilerShadowModuleResult>()

  constructor(options: CompilerShadowRecorderOptions) {
    this.root = path.resolve(options.root)
    this.compilerBuildId = options.compilerBuildId
    this.compilerBuildRevision = options.compilerBuildRevision
    this.reportPath = path.resolve(this.root, options.reportPath)
    this.allowlist = readAllowlist(
      options.allowlistPath ? path.resolve(this.root, options.allowlistPath) : undefined,
    )
    this.onResult = options.onResult
  }

  reset(): void {
    this.results.clear()
  }

  record(
    moduleId: string,
    source: string,
    legacy: CompilerShadowBackendSnapshot,
    rust: CompilerShadowBackendSnapshot,
  ): CompilerShadowModuleResult {
    const relativeIdentity = path
      .relative(this.root, path.resolve(moduleId))
      .split(path.sep)
      .join('/')
    const moduleHash = digest(relativeIdentity)
    const sourceDigest = digest(source)
    const differences: CompilerShadowDifference[] = []

    for (const category of COMPARISON_CATEGORIES) {
      const legacyDigest = digest(categoryValue(category, legacy, source))
      const rustDigest = digest(categoryValue(category, rust, source))
      if (legacyDigest === rustDigest) continue
      const rule = this.allowlist?.rules.find(candidate =>
        ruleMatches(candidate, moduleHash, category, legacyDigest, rustDigest),
      )
      differences.push({
        category,
        legacyDigest,
        rustDigest,
        disposition: rule ? 'expected' : 'unexplained',
        ...(rule ? { allowlistRuleId: rule.id } : {}),
      })
    }

    const result: CompilerShadowModuleResult = {
      moduleHash,
      sourceDigest,
      equivalent: differences.length === 0,
      differences,
    }
    this.results.set(`${moduleHash}:${sourceDigest}`, result)
    this.onResult?.(result)
    return result
  }

  artifact(): CompilerShadowArtifact {
    const modules = [...this.results.values()].sort((left, right) =>
      `${left.moduleHash}:${left.sourceDigest}`.localeCompare(
        `${right.moduleHash}:${right.sourceDigest}`,
      ),
    )
    const differences = modules.flatMap(module => module.differences)
    return {
      schemaVersion: 2,
      backend: 'shadow',
      compilerBuildId: this.compilerBuildId,
      compilerBuildRevision: this.compilerBuildRevision,
      allowlistVersion: this.allowlist?.version ?? null,
      summary: {
        modules: modules.length,
        equivalentModules: modules.filter(module => module.equivalent).length,
        expectedDifferences: differences.filter(item => item.disposition === 'expected').length,
        unexplainedDifferences: differences.filter(item => item.disposition === 'unexplained')
          .length,
      },
      modules,
    }
  }

  async write(): Promise<CompilerShadowArtifact> {
    const artifact = this.artifact()
    await fs.mkdir(path.dirname(this.reportPath), { recursive: true })
    await fs.writeFile(this.reportPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
    return artifact
  }
}
