import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..')

export function configuredDiagnosticCodes(source) {
  const match = source.match(/const CONFIGURABLE_DIAGNOSTIC_CODES[^=]*=\s*&\[(?<entries>.*?)\];/s)
  if (!match?.groups?.entries) {
    throw new Error('unable to locate CONFIGURABLE_DIAGNOSTIC_CODES')
  }
  return [...match.groups.entries.matchAll(/"(?<code>FICT-[A-Z0-9-]+)"/g)].map(
    entry => entry.groups.code,
  )
}

export function missingNativeDiagnosticProducers(policySource, producerSources) {
  const configured = configuredDiagnosticCodes(policySource)
  return configured.filter(code => !producerSources.some(source => source.includes(`"${code}"`)))
}

async function rustSourceFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await rustSourceFiles(target)))
    } else if (entry.isFile() && entry.name.endsWith('.rs')) {
      files.push(target)
    }
  }
  return files
}

export async function checkNativeDiagnosticProducers(root = DEFAULT_ROOT) {
  const policyPath = path.join(root, 'crates/fict-compiler/src/diagnostic_policy.rs')
  const policySource = await readFile(policyPath, 'utf8')
  const crateEntries = await readdir(path.join(root, 'crates'), { withFileTypes: true })
  const sourceFiles = []
  for (const entry of crateEntries) {
    if (!entry.isDirectory()) continue
    const sourceDirectory = path.join(root, 'crates', entry.name, 'src')
    try {
      sourceFiles.push(...(await rustSourceFiles(sourceDirectory)))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  const producerSources = await Promise.all(
    sourceFiles.filter(file => file !== policyPath).map(file => readFile(file, 'utf8')),
  )
  const missing = missingNativeDiagnosticProducers(policySource, producerSources)
  if (missing.length > 0) {
    throw new Error(`configurable diagnostics without native producers: ${missing.join(', ')}`)
  }
  return configuredDiagnosticCodes(policySource)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkNativeDiagnosticProducers()
    .then(codes => {
      console.log(`Native diagnostic producer check passed for ${codes.length} configurable codes.`)
    })
    .catch(error => {
      console.error(error.message)
      process.exitCode = 1
    })
}
