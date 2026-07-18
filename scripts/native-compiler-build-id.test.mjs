import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(import.meta.dirname, '..')
const nativePath = path.resolve(
  process.env.FICT_COMPILER_NATIVE_PATH ??
    path.join(repositoryRoot, 'target/release/fict_compiler_napi.node'),
)
const binding = require(nativePath)
const info = binding.nativeCompilerInfo()

function collectRustSources(directory, inputs) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) collectRustSources(entryPath, inputs)
    else if (path.extname(entry.name) === '.rs') inputs.push(entryPath)
  }
}

function collectBuildInputs() {
  const inputs = ['Cargo.lock', 'Cargo.toml', 'rust-toolchain.toml'].map(relative =>
    path.join(repositoryRoot, relative),
  )
  const cratesDirectory = path.join(repositoryRoot, 'crates')
  for (const entry of readdirSync(cratesDirectory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory() || !entry.name.startsWith('fict-')) continue
    const crateDirectory = path.join(cratesDirectory, entry.name)
    for (const fileName of ['Cargo.toml', 'build.rs']) {
      const candidate = path.join(crateDirectory, fileName)
      if (existsSync(candidate)) inputs.push(candidate)
    }
    const sourceDirectory = path.join(crateDirectory, 'src')
    if (existsSync(sourceDirectory)) collectRustSources(sourceDirectory, inputs)
  }
  return [...new Set(inputs)].sort(comparePathComponents)
}

function comparePathComponents(left, right) {
  // PathBuf ordering is component-wise, not raw-string ordering.
  const leftComponents = left.split(path.sep)
  const rightComponents = right.split(path.sep)
  for (let index = 0; index < Math.min(leftComponents.length, rightComponents.length); index += 1) {
    if (leftComponents[index] < rightComponents[index]) return -1
    if (leftComponents[index] > rightComponents[index]) return 1
  }
  return leftComponents.length - rightComponents.length
}

function normalizeSourceBytes(source) {
  if (source.indexOf('\r\n') === -1) return source
  const normalized = Buffer.allocUnsafe(source.length)
  let writeIndex = 0
  for (let readIndex = 0; readIndex < source.length; readIndex += 1) {
    if (source[readIndex] === 0x0d && source[readIndex + 1] === 0x0a) {
      normalized[writeIndex++] = 0x0a
      readIndex += 1
    } else {
      normalized[writeIndex++] = source[readIndex]
    }
  }
  return normalized.subarray(0, writeIndex)
}

function computeSourceHash({ mutate } = {}) {
  const hasher = createHash('sha256')
  hasher.update('fict-compiler-build-id-v1\0')
  hasher.update('preview=1\0')
  if (info.compilerBuildRevision !== null) {
    hasher.update('revision\0')
    hasher.update(info.compilerBuildRevision)
    hasher.update('\0')
  }

  for (const input of collectBuildInputs()) {
    const relative = path.relative(repositoryRoot, input).split(path.sep).join('/')
    hasher.update(relative)
    hasher.update('\0')
    const source = normalizeSourceBytes(readFileSync(input))
    hasher.update(mutate?.relative === relative ? mutate.apply(source) : source)
    hasher.update('\0')
  }
  return hasher.digest('hex')
}

test('native build identity matches every declared Rust build input', () => {
  const prefix = [
    'fict-rust',
    `p${info.compilerProtocolVersion}`,
    `oxc${info.oxcVersion}`,
    `m${info.metadataSchemaVersion}`,
  ].join('-')
  assert.equal(info.compilerBuildId, `${prefix}-${computeSourceHash()}`)
})

test('native build identity changes when a compiler source input changes', () => {
  const baseline = computeSourceHash()
  const changed = computeSourceHash({
    mutate: {
      relative: 'crates/fict-compiler/src/lib.rs',
      apply: source => Buffer.concat([source, Buffer.from('\n// simulated source change\n')]),
    },
  })
  assert.notEqual(changed, baseline)
})
