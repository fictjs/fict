#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXPECTED_RUST_PACKAGES = [
  'fict-compiler',
  'fict-compiler-napi',
  'fict-compiler-oxc',
  'fict-compiler-preview',
  'fict-diagnostics',
  'fict-emit',
  'fict-hir',
  'fict-metadata',
  'fict-reactivity',
]

const EXPECTED_PACKAGE_SET = new Set(EXPECTED_RUST_PACKAGES)

const ALLOWED_INTERNAL_DEPENDENCIES = new Map([
  ['fict-diagnostics', new Set()],
  ['fict-hir', new Set(['fict-diagnostics'])],
  ['fict-reactivity', new Set(['fict-diagnostics', 'fict-hir'])],
  ['fict-metadata', new Set(['fict-diagnostics', 'fict-hir'])],
  ['fict-emit', new Set(['fict-diagnostics', 'fict-hir', 'fict-metadata', 'fict-reactivity'])],
  ['fict-compiler-oxc', new Set(['fict-diagnostics', 'fict-emit', 'fict-hir', 'fict-metadata'])],
  [
    'fict-compiler-preview',
    new Set(['fict-diagnostics', 'fict-emit', 'fict-hir', 'fict-metadata']),
  ],
  [
    'fict-compiler',
    new Set([
      'fict-compiler-oxc',
      'fict-compiler-preview',
      'fict-diagnostics',
      'fict-emit',
      'fict-hir',
      'fict-metadata',
      'fict-reactivity',
    ]),
  ],
  ['fict-compiler-napi', new Set(['fict-compiler'])],
])

const FORBIDDEN_IO_DEPENDENCIES = new Set([
  'curl',
  'glob',
  'globset',
  'hyper',
  'ignore',
  'notify',
  'reqwest',
  'tokio',
  'ureq',
  'walkdir',
])

const FRONTEND_AST_REFERENCE = /\b(?:oxc(?:::|_)|Babel[A-Z]|babel::)/u

function isOxcDependency(name) {
  return name === 'oxc' || name.startsWith('oxc_') || name.startsWith('oxc-')
}

function isNapiDependency(name) {
  return name === 'napi' || name.startsWith('napi-')
}

function packageByName(metadata) {
  return new Map(metadata.packages.map(pkg => [pkg.name, pkg]))
}

export function validateRustCrateBoundaries(metadata, sourceFiles = []) {
  const errors = []
  const packages = packageByName(metadata)

  for (const expected of EXPECTED_RUST_PACKAGES) {
    if (!packages.has(expected)) errors.push(`Missing required Rust workspace package: ${expected}`)
  }
  for (const name of packages.keys()) {
    if (!EXPECTED_PACKAGE_SET.has(name)) {
      errors.push(`Unreviewed Rust workspace package is outside the boundary map: ${name}`)
    }
  }

  for (const pkg of packages.values()) {
    const allowedInternal = ALLOWED_INTERNAL_DEPENDENCIES.get(pkg.name) ?? new Set()
    for (const dependency of pkg.dependencies) {
      // Test-only helpers do not enter a crate's production or build graph. They may cross
      // adapter boundaries to assert integration behavior, while normal and build dependencies
      // remain subject to the architectural rules below.
      if (dependency.kind === 'dev') continue
      if (EXPECTED_PACKAGE_SET.has(dependency.name) && !allowedInternal.has(dependency.name)) {
        errors.push(`${pkg.name} must not depend on internal crate ${dependency.name}`)
      }
      if (isOxcDependency(dependency.name) && pkg.name !== 'fict-compiler-oxc') {
        errors.push(`${pkg.name} must not depend on OXC package ${dependency.name}`)
      }
      if (isNapiDependency(dependency.name) && pkg.name !== 'fict-compiler-napi') {
        errors.push(`${pkg.name} must not depend on N-API package ${dependency.name}`)
      }
      if (FORBIDDEN_IO_DEPENDENCIES.has(dependency.name)) {
        errors.push(`${pkg.name} must not depend on filesystem/network crate ${dependency.name}`)
      }
      if (dependency.name === 'fict-compiler-preview') {
        if (pkg.name !== 'fict-compiler') {
          errors.push(`${pkg.name} must not depend on the Preview compiler crate`)
        } else if (!dependency.optional) {
          errors.push('fict-compiler-preview must be optional in fict-compiler')
        }
      }
    }
  }

  const compiler = packages.get('fict-compiler')
  if (compiler) {
    const defaultFeatures = compiler.features?.default ?? []
    if (defaultFeatures.some(feature => feature.includes('preview'))) {
      errors.push('fict-compiler default features must not enable Preview')
    }
    const previewFeatures = compiler.features?.preview ?? []
    if (previewFeatures.length !== 1 || previewFeatures[0] !== 'dep:fict-compiler-preview') {
      errors.push('fict-compiler preview feature must enable only its optional Preview crate')
    }
  }

  for (const source of sourceFiles) {
    if (/\bstd\s*::\s*(?:fs|net)\b/u.test(source.content)) {
      errors.push(`${source.path} must not access std::fs or std::net`)
    }
    const normalizedPath = source.path.replaceAll('\\', '/')
    if (
      (normalizedPath.includes('/fict-hir/') || normalizedPath.startsWith('crates/fict-hir/')) &&
      FRONTEND_AST_REFERENCE.test(source.content)
    ) {
      errors.push(`${source.path} must not reference frontend-specific AST APIs`)
    }
  }

  return errors
}

function collectRustSources(directory) {
  const sources = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      sources.push(...collectRustSources(entryPath))
    } else if (entry.isFile() && entry.name.endsWith('.rs')) {
      sources.push({ path: entryPath, content: readFileSync(entryPath, 'utf8') })
    }
  }
  return sources
}

export function runRustCrateBoundaryCheck(rootDirectory = process.cwd()) {
  const metadata = JSON.parse(
    execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
      cwd: rootDirectory,
      encoding: 'utf8',
    }),
  )
  const sources = collectRustSources(path.join(rootDirectory, 'crates')).filter(source =>
    source.path.split(path.sep).includes('src'),
  )
  const errors = validateRustCrateBoundaries(metadata, sources)
  if (errors.length > 0) {
    throw new Error(`Rust crate boundary check failed:\n- ${errors.join('\n- ')}`)
  }
  return metadata.packages.length
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    const packageCount = runRustCrateBoundaryCheck()
    console.log(`Rust crate boundary check passed for ${packageCount} workspace crates.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
