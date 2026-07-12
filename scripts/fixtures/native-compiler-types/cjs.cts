import type { CompileRequest, CompileResult } from '../../../packages/compiler/dist/index.cjs'
import {
  loadNativeCompilerBinding,
  type NativeCompilerBinding,
} from '../../../packages/compiler/dist/native-loader.cjs'

const request: CompileRequest = {
  code: 'module.exports = 1',
  filename: 'value.cjs',
  language: 'js',
  moduleKind: 'commonjs',
}
const binding: NativeCompilerBinding = loadNativeCompilerBinding({
  nativePath: 'C:\\fict-compiler.node',
})
const syncResult: CompileResult = binding.transformSync(request)
const asyncResult: Promise<CompileResult> = binding.transform(request)

void syncResult
void asyncResult
