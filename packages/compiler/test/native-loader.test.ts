import { describe, expect, it, vi } from 'vitest'

import {
  NativeCompilerLoadError,
  analyze,
  analyzeSync,
  createNativeCompilerFacade,
  detectLinuxLibc,
  loadNativeCompilerBinding,
  nativeCompilerInfo,
  nativeCompilerPackageName,
  nativeCompilerRustTarget,
  resolveNativeCompilerRuntimeHelper,
  resolveNativeTarget,
  scan,
  scanSync,
  transform,
  transformSync,
  type NativeCompilerBinding,
} from '../src/native-loader'
import type { AnalyzeResult } from '../src/tooling/types'
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

function createBinding(nativeTarget = 'aarch64-apple-darwin'): NativeCompilerBinding {
  return {
    nativeCompilerInfo: () => ({
      backend: 'rust',
      nativeTarget,
      oxcVersion: '0.139.0',
      nodeApiVersion: 10,
      compilerBuildId: `fict-rust-p1-oxc0.139.0-m1-${'0'.repeat(64)}`,
      compilerBuildRevision: null,
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
  it('exports the complete serializable direct compiler facade', () => {
    expect(typeof nativeCompilerInfo).toBe('function')
    expect(typeof transformSync).toBe('function')
    expect(typeof transform).toBe('function')
    expect(typeof scanSync).toBe('function')
    expect(typeof scan).toBe('function')
    expect(typeof analyzeSync).toBe('function')
    expect(typeof analyze).toBe('function')
  })

  it('lazily loads one validated binding and forwards every request API', async () => {
    const binding = createBinding()
    const load = vi.fn(() => binding)
    const facade = createNativeCompilerFacade({
      nativePath: '/tmp/fict-compiler.node',
      platform: 'darwin',
      arch: 'arm64',
      load,
    })
    const compileRequest = { code: '', filename: 'module.tsx' }
    const scanRequest = { code: '', filename: 'module.tsx' }
    const analyzeRequest = { code: '', filename: 'module.tsx' }

    expect(load).not.toHaveBeenCalled()
    expect(facade.nativeCompilerInfo()).toEqual(binding.nativeCompilerInfo())
    expect(facade.transformSync(compileRequest)).toEqual(createCompileResult())
    expect(await facade.transform(compileRequest)).toEqual(createCompileResult())
    expect(facade.scanSync(scanRequest)).toEqual(createScanResult())
    expect(await facade.scan(scanRequest)).toEqual(createScanResult())
    expect(facade.analyzeSync(analyzeRequest)).toEqual(createAnalyzeResult())
    expect(await facade.analyze(analyzeRequest)).toEqual(createAnalyzeResult())
    expect(load).toHaveBeenCalledOnce()
  })

  it('resolves the supported platform package matrix', () => {
    expect(resolveNativeTarget('darwin', 'arm64')).toBe('darwin-arm64')
    expect(resolveNativeTarget('darwin', 'x64')).toBe('darwin-x64')
    expect(resolveNativeTarget('linux', 'x64', { header: { glibcVersionRuntime: '2.39' } })).toBe(
      'linux-x64-gnu',
    )
    expect(
      resolveNativeTarget('linux', 'arm64', {
        header: { platform: 'linux', reportVersion: 5 },
      }),
    ).toBe('linux-arm64-musl')
    expect(resolveNativeTarget('linux', 'x64', null)).toBe('linux-x64-unknown')
    expect(resolveNativeTarget('win32', 'x64')).toBe('win32-x64-msvc')
    expect(resolveNativeTarget('win32', 'arm64')).toBe('win32-arm64-msvc')
  })

  it('detects glibc only from an explicit runtime report marker', () => {
    expect(detectLinuxLibc({ header: { glibcVersionRuntime: '2.39' } })).toBe('gnu')
    expect(detectLinuxLibc({ header: { platform: 'linux', reportVersion: 5 } })).toBe('musl')
    expect(detectLinuxLibc(null)).toBe('unknown')
    expect(detectLinuxLibc({})).toBe('unknown')
    expect(detectLinuxLibc({ header: {} })).toBe('unknown')
    expect(detectLinuxLibc({ header: { glibcVersionRuntime: '' } })).toBe('unknown')
    expect(detectLinuxLibc({ header: { glibcVersionRuntime: 239 } })).toBe('unknown')
  })

  it('treats a disabled process report as unknown instead of throwing', () => {
    if (!process.report) throw new Error('Node process reports are unavailable in this test host')
    const getReport = vi.spyOn(process.report, 'getReport').mockImplementation(() => {
      throw new Error('report disabled by sandbox')
    })

    try {
      expect(resolveNativeTarget('linux', 'x64')).toBe('linux-x64-unknown')
    } finally {
      getReport.mockRestore()
    }
  })

  it('loads and validates the platform optional package', () => {
    const binding = createBinding('x86_64-unknown-linux-gnu')
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

  it.each([
    ['x64', 'x86_64-unknown-linux-gnu', '@fictjs/compiler-linux-x64-gnu'],
    ['arm64', 'aarch64-unknown-linux-gnu', '@fictjs/compiler-linux-arm64-gnu'],
  ])('tries the common GNU %s package first when Linux libc is unknown', (arch, rustTarget, id) => {
    const binding = createBinding(rustTarget)
    const load = vi.fn(() => binding)

    expect(loadNativeCompilerBinding({ platform: 'linux', arch, report: null, load })).toBe(binding)
    expect(load).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledWith(id)
  })

  it('does not probe GNU when a valid process report identifies musl', () => {
    const binding = createBinding('x86_64-unknown-linux-musl')
    const load = vi.fn(() => binding)

    expect(
      loadNativeCompilerBinding({
        platform: 'linux',
        arch: 'x64',
        report: { header: { platform: 'linux', reportVersion: 5 } },
        load,
      }),
    ).toBe(binding)
    expect(load).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledWith('@fictjs/compiler-linux-x64-musl')
  })

  it('falls back to musl when the GNU package is unavailable', () => {
    const binding = createBinding('x86_64-unknown-linux-musl')
    const load = vi.fn((id: string) => {
      if (id.endsWith('-gnu')) throw new Error('GNU package not installed')
      return binding
    })

    expect(loadNativeCompilerBinding({ platform: 'linux', arch: 'x64', report: null, load })).toBe(
      binding,
    )
    expect(load.mock.calls.map(([id]) => id)).toEqual([
      '@fictjs/compiler-linux-x64-gnu',
      '@fictjs/compiler-linux-x64-musl',
    ])
  })

  it('aggregates ABI mismatches from every unknown-libc candidate', () => {
    const load = vi.fn((id: string) =>
      id.endsWith('-gnu')
        ? createBinding('x86_64-unknown-linux-musl')
        : createBinding('x86_64-unknown-linux-gnu'),
    )

    expect.assertions(6)
    try {
      loadNativeCompilerBinding({ platform: 'linux', arch: 'x64', report: null, load })
    } catch (error) {
      expect(error).toBeInstanceOf(NativeCompilerLoadError)
      expect(error).toMatchObject({
        target: 'linux-x64-unknown',
        attempted: ['@fictjs/compiler-linux-x64-gnu', '@fictjs/compiler-linux-x64-musl'],
      })
      expect(String(error)).toContain(
        'reported ABI target x86_64-unknown-linux-musl; expected x86_64-unknown-linux-gnu',
      )
      expect(String(error)).toContain(
        'reported ABI target x86_64-unknown-linux-gnu; expected x86_64-unknown-linux-musl',
      )
      expect(load).toHaveBeenCalledTimes(2)
      expect(load.mock.calls.map(([id]) => id)).toEqual([
        '@fictjs/compiler-linux-x64-gnu',
        '@fictjs/compiler-linux-x64-musl',
      ])
    }
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

  it.each(['x86_64-unknown-linux-gnu', 'x86_64-unknown-linux-musl'])(
    'accepts an explicit %s binding when Linux libc is unknown',
    nativeTarget => {
      const binding = createBinding(nativeTarget)
      const load = vi.fn(() => binding)

      expect(
        loadNativeCompilerBinding({
          nativePath: '/tmp/fict-compiler.node',
          platform: 'linux',
          arch: 'x64',
          report: null,
          load,
        }),
      ).toBe(binding)
      expect(load).toHaveBeenCalledOnce()
    },
  )

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

  it('rejects a malformed compiled source revision', () => {
    const binding = createBinding()
    binding.nativeCompilerInfo = () => ({
      ...createBinding().nativeCompilerInfo(),
      compilerBuildRevision: 'local-build',
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
    ).toThrow('reported ABI target x86_64-apple-darwin; expected aarch64-apple-darwin')
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
