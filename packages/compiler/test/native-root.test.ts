import { describe, expect, it } from 'vitest'

import * as compiler from '../src'
import * as native from '../src/native-loader'

describe('@fictjs/compiler Rust-default root', () => {
  it('exposes the native request API without the legacy Babel plugin', () => {
    expect(compiler.nativeCompilerInfo).toBe(native.nativeCompilerInfo)
    expect(compiler.transformSync).toBe(native.transformSync)
    expect(compiler.transform).toBe(native.transform)
    expect(compiler.scanSync).toBe(native.scanSync)
    expect(compiler.scan).toBe(native.scan)
    expect(compiler.analyzeSync).toBe(native.analyzeSync)
    expect(compiler.analyze).toBe(native.analyze)
    expect(compiler).not.toHaveProperty('createFictPlugin')
    expect(compiler).not.toHaveProperty('default')
  })
})
