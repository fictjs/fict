import { describe, expect, it, vi } from 'vitest'

import {
  NativeCompilerLoadError,
  detectLinuxLibc,
  loadNativeCompilerBinding,
  nativeCompilerPackageName,
  nativeCompilerRustTarget,
  resolveNativeCompilerRuntimeHelper,
  resolveNativeTarget,
  type NativeCompilerBinding,
} from '../src/native-loader'
import type { AnalyzeResult } from '../src/tooling'
import {
  COMPILER_PROTOCOL_VERSION,
  MODULE_REACTIVE_METADATA_VERSION,
  type CompileResult,
  type ScanResult,
} from '../src/types'

function createCompileResult(): CompileResult {
  return {
    protocolVersion: COMPILER_PROTOCOL_VERSION,
    code: '',
    map: null,
    diagnostics: [],
    moduleMetadata: { version: MODULE_REACTIVE_METADATA_VERSION, exports: {} },
    metadataDependencies: [],
    unresolvedMetadataRequests: [],
    metadataIncomplete: false,
    explain: null,
    artifacts: [],
    stats: null,
    compilerBuildId: `fict-rust-p1-oxc0.139.0-m1-${'0'.repeat(64)}`,
  }
}

function createScanResult(): ScanResult {
  return {
    protocolVersion: COMPILER_PROTOCOL_VERSION,
    moduleRequests: [],
    hasModuleSyntax: false,
    diagnostics: [],
    compilerBuildId: `fict-rust-p1-oxc0.139.0-m1-${'0'.repeat(64)}`,
  }
}

function createAnalyzeResult(): AnalyzeResult {
  return {
    fileName: 'module.tsx',
    components: [],
    diagnostics: [],
  }
}

function createBinding(): NativeCompilerBinding {
  return {
    nativeCompilerInfo: () => ({
      backend: 'rust',
      nativeTarget: 'aarch64-apple-darwin',
      oxcVersion: '0.139.0',
      nodeApiVersion: 10,
      compilerBuildId: `fict-rust-p1-oxc0.139.0-m1-${'0'.repeat(64)}`,
      compilerProtocolVersion: 1,
      metadataSchemaVersion: 1,
    }),
    parseTsxProbeSync: () => ({ statementCount: 1, diagnosticCount: 0 }),
    parseTsxProbeAsync: async () => ({ statementCount: 1, diagnosticCount: 0 }),
    transformSync: () => createCompileResult(),
    transform: async () => createCompileResult(),
    scanSync: () => createScanResult(),
    scan: async () => createScanResult(),
    analyzeSync: () => createAnalyzeResult(),
    analyze: async () => createAnalyzeResult(),
  }
}

describe('native compiler loader', () => {
  it('resolves the supported platform package matrix', () => {
    expect(resolveNativeTarget('darwin', 'arm64')).toBe('darwin-arm64')
    expect(resolveNativeTarget('darwin', 'x64')).toBe('darwin-x64')
    expect(resolveNativeTarget('linux', 'x64', { header: { glibcVersionRuntime: '2.39' } })).toBe(
      'linux-x64-gnu',
    )
    expect(resolveNativeTarget('linux', 'arm64', { header: {} })).toBe('linux-arm64-musl')
    expect(resolveNativeTarget('win32', 'x64')).toBe('win32-x64-msvc')
    expect(resolveNativeTarget('win32', 'arm64')).toBe('win32-arm64-msvc')
  })

  it('detects glibc only from an explicit runtime report marker', () => {
    expect(detectLinuxLibc({ header: { glibcVersionRuntime: '2.39' } })).toBe('gnu')
    expect(detectLinuxLibc({ header: {} })).toBe('musl')
    expect(detectLinuxLibc(undefined)).toBe('musl')
  })

  it('loads and validates the platform optional package', () => {
    const binding = createBinding()
    binding.nativeCompilerInfo = () => ({
      ...createBinding().nativeCompilerInfo(),
      nativeTarget: 'x86_64-unknown-linux-gnu',
    })
    const load = vi.fn((id: string) => {
      expect(id).toBe('@fictjs/compiler-linux-x64-gnu')
      return binding
    })

    expect(
      loadNativeCompilerBinding({
        platform: 'linux',
        arch: 'x64',
        report: { header: { glibcVersionRuntime: '2.39' } },
        load,
      }),
    ).toBe(binding)
    expect(load).toHaveBeenCalledOnce()
  })

  it('treats an explicit native path as authoritative', () => {
    const binding = createBinding()
    const load = vi.fn(() => ({ default: binding }))

    expect(
      loadNativeCompilerBinding({
        nativePath: '/tmp/fict-compiler.node',
        platform: 'darwin',
        arch: 'arm64',
        load,
      }),
    ).toBe(binding)
    expect(load).toHaveBeenCalledWith('/tmp/fict-compiler.node')
  })

  it('rejects a platform binding built for a different compiler protocol', () => {
    const binding = createBinding()
    binding.nativeCompilerInfo = () => ({
      ...createBinding().nativeCompilerInfo(),
      compilerProtocolVersion: 2,
    })

    expect(() =>
      loadNativeCompilerBinding({
        nativePath: '/tmp/incompatible.node',
        platform: 'darwin',
        arch: 'arm64',
        load: () => binding,
      }),
    ).toThrow('reported incompatible compiler metadata')
  })

  it('rejects a package containing a binding for a different native target', () => {
    const binding = createBinding()
    binding.nativeCompilerInfo = () => ({
      ...createBinding().nativeCompilerInfo(),
      nativeTarget: 'x86_64-apple-darwin',
    })

    expect(() =>
      loadNativeCompilerBinding({
        nativePath: '/tmp/wrong-target.node',
        platform: 'darwin',
        arch: 'arm64',
        load: () => binding,
      }),
    ).toThrow('reported incompatible compiler metadata')
  })

  it('rejects bindings that do not expose the scan protocol', () => {
    const binding = { ...createBinding(), scan: undefined }

    expect(() =>
      loadNativeCompilerBinding({
        nativePath: '/tmp/incomplete.node',
        platform: 'darwin',
        arch: 'arm64',
        load: () => binding,
      }),
    ).toThrow('does not expose the Fict compiler binding')
  })

  it('rejects bindings that do not expose the analysis protocol', () => {
    const binding = { ...createBinding(), analyzeSync: undefined }

    expect(() =>
      loadNativeCompilerBinding({
        nativePath: '/tmp/incomplete.node',
        platform: 'darwin',
        arch: 'arm64',
        load: () => binding,
      }),
    ).toThrow('does not expose the Fict compiler binding')
  })

  it('fails clearly without invoking a legacy compiler fallback', () => {
    const load = vi.fn(() => {
      throw new Error('module not found')
    })

    expect(() =>
      loadNativeCompilerBinding({ platform: 'darwin', arch: 'arm64', load }),
    ).toThrowError(NativeCompilerLoadError)

    try {
      loadNativeCompilerBinding({ platform: 'darwin', arch: 'arm64', load })
    } catch (error) {
      expect(error).toBeInstanceOf(NativeCompilerLoadError)
      expect(error).toMatchObject({
        code: 'FICT_NATIVE_COMPILER_LOAD_FAILED',
        target: 'darwin-arm64',
        attempted: ['@fictjs/compiler-darwin-arm64'],
      })
      expect(String(error)).toContain('optional dependencies enabled')
    }
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('rejects unsupported platforms before attempting a load', () => {
    const load = vi.fn()
    expect(() => loadNativeCompilerBinding({ platform: 'aix', arch: 'ppc64', load })).toThrow(
      /aix\/ppc64/,
    )
    expect(() =>
      loadNativeCompilerBinding({
        platform: 'linux',
        arch: 'ppc64',
        report: { header: { glibcVersionRuntime: '2.39' } },
        load,
      }),
    ).toThrow(/linux\/ppc64 \(gnu\)/)
    expect(load).not.toHaveBeenCalled()
  })

  it('uses stable optional package names', () => {
    expect(nativeCompilerPackageName('linux-x64-musl')).toBe('@fictjs/compiler-linux-x64-musl')
    expect(nativeCompilerRustTarget('linux-x64-musl')).toBe('x86_64-unknown-linux-musl')
  })

  it('resolves only canonical helpers from the pinned OXC runtime', () => {
    expect(resolveNativeCompilerRuntimeHelper('@oxc-project/runtime/helpers/decorate')).toMatch(
      /@oxc-project[/+]runtime.*helpers[/+]decorate\.js$/,
    )
    expect(resolveNativeCompilerRuntimeHelper('@oxc-project/runtime/helpers/../package')).toBe(
      undefined,
    )
    expect(resolveNativeCompilerRuntimeHelper('consumer-package/helpers/decorate')).toBe(undefined)
  })
})
