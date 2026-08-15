import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..')
const DIAGNOSTIC_CODE = /^FICT-[A-Z0-9]+(?:-[A-Z0-9]+)*$/

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function configuredDiagnosticCodes(source) {
  const registry = parseDiagnosticRegistry(source)
  return Object.entries(registry.policy)
    .filter(([, policy]) => policy.allowOverrideOutsideStrict === true)
    .map(([code]) => code)
}

export function missingNativeDiagnosticProducers(policySource, producerSources) {
  const configured = configuredDiagnosticCodes(policySource)
  return configured.filter(code => !producerSources.some(source => source.includes(`"${code}"`)))
}

export function documentedDiagnosticCodes(source) {
  return [...source.matchAll(/^### (?<code>FICT-[A-Z0-9-]+)(?=[: /])/gm)].map(
    match => match.groups.code,
  )
}

export function parseDiagnosticRegistry(source) {
  let registry
  try {
    registry = JSON.parse(source)
  } catch (error) {
    throw new Error(`invalid diagnostic registry JSON: ${error.message}`)
  }
  if (registry?.schemaVersion !== 1 || !isRecord(registry.active)) {
    throw new Error('diagnostic registry must use schemaVersion 1 and define active producers')
  }
  if (!isRecord(registry.aliases) || !isRecord(registry.retired) || !isRecord(registry.policy)) {
    throw new Error('diagnostic registry must define aliases, retired, and policy maps')
  }
  return registry
}

function registryInventory(registry) {
  const active = new Map()
  const documented = []
  for (const [producer, groups] of Object.entries(registry.active)) {
    if (producer !== 'rust' && producer !== 'vscode') {
      throw new Error(`unsupported diagnostic producer: ${producer}`)
    }
    for (const group of ['documented', 'additional']) {
      if (!Array.isArray(groups?.[group])) {
        throw new Error(`diagnostic registry active.${producer}.${group} must be an array`)
      }
      for (const code of groups[group]) {
        if (!DIAGNOSTIC_CODE.test(code)) {
          throw new Error(`invalid diagnostic registry code: ${code}`)
        }
        if (active.has(code)) throw new Error(`duplicate active diagnostic registry code: ${code}`)
        active.set(code, producer)
        if (group === 'documented') documented.push(code)
      }
    }
  }
  const aliases = new Map(Object.entries(registry.aliases))
  const retired = new Map(Object.entries(registry.retired))
  for (const code of [...aliases.keys(), ...retired.keys()]) {
    if (!DIAGNOSTIC_CODE.test(code)) throw new Error(`invalid diagnostic registry code: ${code}`)
    if (active.has(code)) throw new Error(`diagnostic registry code has multiple states: ${code}`)
  }
  for (const code of aliases.keys()) {
    if (retired.has(code)) throw new Error(`diagnostic registry code has multiple states: ${code}`)
  }
  return { active, aliases, documented, retired }
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right))
}

function sourceContainsCode(sources, code) {
  return sources.some(source => source.includes(`"${code}"`) || source.includes(`'${code}'`))
}

export function validateDiagnosticRegistry({
  registrySource,
  rustProducerSources,
  vscodeProducerSources,
  docsSource,
  integrationSources = [],
}) {
  const registry = parseDiagnosticRegistry(registrySource)
  const inventory = registryInventory(registry)
  const activeCodes = new Set(inventory.active.keys())
  for (const [code, policy] of Object.entries(registry.policy)) {
    if (!activeCodes.has(code) || inventory.active.get(code) !== 'rust') {
      throw new Error(`diagnostic policy references inactive Rust code: ${code}`)
    }
    if (
      !isRecord(policy) ||
      !['notApplicable', 'advisory', 'fallback', 'unsupported', 'internal'].includes(
        policy.guaranteeClass,
      ) ||
      typeof policy.allowOverrideOutsideStrict !== 'boolean' ||
      (policy.exact !== undefined && typeof policy.exact !== 'boolean')
    ) {
      throw new Error(`diagnostic policy is malformed: ${code}`)
    }
  }
  for (const [alias, target] of inventory.aliases) {
    if (!activeCodes.has(target)) {
      throw new Error(`diagnostic alias ${alias} targets inactive code ${target}`)
    }
  }
  for (const [code, value] of inventory.retired) {
    if (!Array.isArray(value?.replacements) || value.replacements.length === 0) {
      throw new Error(`retired diagnostic ${code} must name active replacements`)
    }
    for (const replacement of value.replacements) {
      if (!activeCodes.has(replacement)) {
        throw new Error(`retired diagnostic ${code} names inactive replacement ${replacement}`)
      }
    }
  }
  const documented = documentedDiagnosticCodes(docsSource)
  const expectedDocumented = sorted(inventory.documented)
  if (JSON.stringify(sorted(documented)) !== JSON.stringify(expectedDocumented)) {
    throw new Error('diagnostic documentation headings do not match the active registry')
  }
  for (const code of configuredDiagnosticCodes(registrySource)) {
    if (!activeCodes.has(code)) {
      throw new Error(`configurable diagnostic is not active in the registry: ${code}`)
    }
  }
  for (const [code, producer] of inventory.active) {
    const sources = producer === 'rust' ? rustProducerSources : vscodeProducerSources
    if (!sources || !sourceContainsCode(sources, code)) {
      throw new Error(`active ${producer} diagnostic has no production source: ${code}`)
    }
  }
  for (const code of inventory.retired.keys()) {
    if (docsSource.includes(code) || sourceContainsCode(integrationSources, code)) {
      throw new Error(`retired diagnostic remains in documentation or integration code: ${code}`)
    }
  }
  const fallback = registry.integrations?.vscodeStaticAnalysisFallback
  if (!Array.isArray(fallback?.includePrefixes) || !Array.isArray(fallback.excludePrefixes)) {
    throw new Error('diagnostic registry must define VS Code static-analysis fallback prefixes')
  }
  for (const prefix of [...fallback.includePrefixes, ...fallback.excludePrefixes]) {
    if (![...activeCodes].some(code => code.startsWith(prefix))) {
      throw new Error(`VS Code fallback prefix has no active diagnostics: ${prefix}`)
    }
  }
  return {
    activeCodes: sorted(activeCodes),
    documentedCodes: expectedDocumented,
    retiredCodes: sorted(inventory.retired.keys()),
  }
}

async function sourceFiles(directory, extension) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(target, extension)))
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      files.push(target)
    }
  }
  return files
}

export async function checkNativeDiagnosticProducers(root = DEFAULT_ROOT) {
  const registrySource = await readFile(path.join(root, 'diagnostics/registry.json'), 'utf8')
  const docsSource = await readFile(path.join(root, 'docs/diagnostic-codes.md'), 'utf8')
  const crateEntries = await readdir(path.join(root, 'crates'), { withFileTypes: true })
  const rustFiles = []
  for (const entry of crateEntries) {
    if (!entry.isDirectory()) continue
    const sourceDirectory = path.join(root, 'crates', entry.name, 'src')
    try {
      rustFiles.push(...(await sourceFiles(sourceDirectory, '.rs')))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  const rustProducerSources = await Promise.all(rustFiles.map(file => readFile(file, 'utf8')))
  const missing = missingNativeDiagnosticProducers(registrySource, rustProducerSources)
  if (missing.length > 0) {
    throw new Error(`configurable diagnostics without native producers: ${missing.join(', ')}`)
  }
  const vscodeRoot = path.join(root, 'packages/vscode-extension')
  const vscodeFiles = await sourceFiles(path.join(vscodeRoot, 'src'), '.ts')
  const integrationFiles = [
    ...vscodeFiles,
    ...(await sourceFiles(path.join(vscodeRoot, 'test'), '.ts')),
    ...(await sourceFiles(path.join(root, 'packages/vite-plugin/src'), '.ts')),
    ...(await sourceFiles(path.join(root, 'packages/webpack-plugin/src'), '.ts')),
  ]
  const vscodeProducerSources = await Promise.all(vscodeFiles.map(file => readFile(file, 'utf8')))
  const integrationSources = await Promise.all(integrationFiles.map(file => readFile(file, 'utf8')))
  return validateDiagnosticRegistry({
    registrySource,
    rustProducerSources,
    vscodeProducerSources,
    docsSource,
    integrationSources,
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkNativeDiagnosticProducers()
    .then(result => {
      console.log(
        `Diagnostic registry check passed for ${result.activeCodes.length} active, ${result.documentedCodes.length} documented, and ${result.retiredCodes.length} retired codes.`,
      )
    })
    .catch(error => {
      console.error(error.message)
      process.exitCode = 1
    })
}
