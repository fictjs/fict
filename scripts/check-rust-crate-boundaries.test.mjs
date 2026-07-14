import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXPECTED_RUST_PACKAGES,
  validateRustCrateBoundaries,
} from './check-rust-crate-boundaries.mjs'

function dependency(name, optional = false, kind = null) {
  return { name, kind, optional }
}

function validMetadata() {
  const dependencies = new Map([
    ['fict-compiler', [dependency('fict-compiler-preview', true)]],
    ['fict-compiler-napi', [dependency('fict-compiler'), dependency('napi')]],
    ['fict-compiler-oxc', [dependency('oxc')]],
  ])
  return {
    packages: EXPECTED_RUST_PACKAGES.map(name => ({
      name,
      dependencies: dependencies.get(name) ?? [],
      features:
        name === 'fict-compiler' ? { default: [], preview: ['dep:fict-compiler-preview'] } : {},
    })),
  }
}

test('accepts the intended OXC, N-API, and optional Preview boundaries', () => {
  assert.deepEqual(validateRustCrateBoundaries(validMetadata()), [])
})

test('rejects adapter leaks, N-API bypasses, and non-optional Preview', () => {
  const metadata = validMetadata()
  const hir = metadata.packages.find(pkg => pkg.name === 'fict-hir')
  const napi = metadata.packages.find(pkg => pkg.name === 'fict-compiler-napi')
  const compiler = metadata.packages.find(pkg => pkg.name === 'fict-compiler')
  hir.dependencies.push(dependency('oxc'))
  napi.dependencies.push(dependency('fict-compiler-oxc'))
  compiler.dependencies = [dependency('fict-compiler-preview')]
  compiler.features.preview.push('fict-emit')

  assert.deepEqual(validateRustCrateBoundaries(metadata), [
    'fict-compiler-preview must be optional in fict-compiler',
    'fict-compiler-napi must not depend on internal crate fict-compiler-oxc',
    'fict-hir must not depend on OXC package oxc',
    'fict-compiler preview feature must enable only its optional Preview crate',
  ])
})

test('rejects filesystem/network dependencies and standard-library I/O', () => {
  const metadata = validMetadata()
  const compiler = metadata.packages.find(pkg => pkg.name === 'fict-compiler')
  compiler.dependencies.push(dependency('reqwest'))

  assert.deepEqual(
    validateRustCrateBoundaries(metadata, [
      { path: 'crates/fict-compiler/src/lib.rs', content: 'use std::fs;' },
    ]),
    [
      'fict-compiler must not depend on filesystem/network crate reqwest',
      'crates/fict-compiler/src/lib.rs must not access std::fs or std::net',
    ],
  )
})

test('allows test-only integration helpers but still rejects build-time boundary leaks', () => {
  const metadata = validMetadata()
  const compiler = metadata.packages.find(pkg => pkg.name === 'fict-compiler')
  const adapter = metadata.packages.find(pkg => pkg.name === 'fict-compiler-oxc')
  compiler.dependencies.push(dependency('oxc_sourcemap', false, 'dev'))
  adapter.dependencies.push(dependency('fict-reactivity', false, 'dev'))

  assert.deepEqual(validateRustCrateBoundaries(metadata), [])

  compiler.dependencies.push(dependency('oxc', false, 'build'))
  assert.deepEqual(validateRustCrateBoundaries(metadata), [
    'fict-compiler must not depend on OXC package oxc',
  ])
})

test('rejects frontend AST references from typed HIR', () => {
  const sources = [
    {
      path: 'crates/fict-hir/src/lib.rs',
      content: 'pub struct LeakedNode(oxc::ast::AstKind);',
    },
    {
      path: 'crates/fict-compiler-oxc/src/lib.rs',
      content: 'use oxc::ast::ast::Program;',
    },
  ]

  assert.deepEqual(validateRustCrateBoundaries(validMetadata(), sources), [
    'crates/fict-hir/src/lib.rs must not reference frontend-specific AST APIs',
  ])
})
