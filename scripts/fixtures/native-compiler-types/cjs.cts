import type {
  AnalyzeRequest,
  AnalyzeResult,
  CompileRequest,
  CompileResult,
} from '../../../packages/compiler/dist/index.cjs'
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
const analyzeRequest: AnalyzeRequest = {
  code: 'export function useValue() { return 1 }',
  filename: 'value.ts',
}
const analysis: AnalyzeResult = binding.analyzeSync(analyzeRequest)
const asyncAnalysis: Promise<AnalyzeResult> = binding.analyze(analyzeRequest)

void syncResult
void asyncResult
void analysis
void asyncAnalysis
