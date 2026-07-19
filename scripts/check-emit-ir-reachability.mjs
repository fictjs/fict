import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..')
const PRODUCER_FILES = [
  'crates/fict-emit/src/lower.rs',
  'crates/fict-emit/src/conditional_return.rs',
  'crates/fict-emit/src/control_flow_region.rs',
]

function enumBody(source, name) {
  const declaration = new RegExp(`\\bpub\\s+enum\\s+${name}\\s*\\{`).exec(source)
  if (!declaration) throw new Error(`unable to locate pub enum ${name}`)

  const open = source.indexOf('{', declaration.index)
  let depth = 1
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(open + 1, index)
  }
  throw new Error(`unterminated pub enum ${name}`)
}

export function emitOperationVariants(source) {
  const variants = []
  let delimiterDepth = 0
  for (const line of enumBody(source, 'EmitOperation').split(/\r?\n/u)) {
    const code = line.replace(/\/\/.*$/u, '').trim()
    if (delimiterDepth === 0) {
      const variant = /^([A-Z][A-Za-z0-9_]*)\b/u.exec(code)?.[1]
      if (variant) variants.push(variant)
    }
    for (const character of code) {
      if ('({['.includes(character)) delimiterDepth += 1
      if (')}]'.includes(character)) delimiterDepth -= 1
      if (delimiterDepth < 0) throw new Error('malformed EmitOperation declaration')
    }
  }
  if (delimiterDepth !== 0 || variants.length === 0 || new Set(variants).size !== variants.length) {
    throw new Error('malformed EmitOperation declaration')
  }
  return variants
}

function withoutRustComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '')
}

export function missingEmitOperationProducers(irSource, producerSources) {
  const producers = producerSources.map(withoutRustComments)
  return emitOperationVariants(irSource).filter(variant => {
    const construction = new RegExp(
      `(?:\\.push\\(\\s*|\\.map\\(\\s*\\|[^|]*\\|\\s*)EmitOperation::${variant}\\b`,
      'u',
    )
    return !producers.some(source => construction.test(source))
  })
}

export async function checkEmitIrReachability(root = DEFAULT_ROOT) {
  const irSource = await readFile(path.join(root, 'crates/fict-emit/src/ir.rs'), 'utf8')
  const producerSources = await Promise.all(
    PRODUCER_FILES.map(file => readFile(path.join(root, file), 'utf8')),
  )
  const missing = missingEmitOperationProducers(irSource, producerSources)
  if (missing.length > 0) {
    throw new Error(`EmitOperation variants without HIR lowering producers: ${missing.join(', ')}`)
  }
  return emitOperationVariants(irSource)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkEmitIrReachability()
    .then(variants => {
      console.log(`EmitIR reachability check passed for ${variants.length} operation variants.`)
    })
    .catch(error => {
      console.error(error.message)
      process.exitCode = 1
    })
}
