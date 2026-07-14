import type {
  AnalyzeRequest,
  AnalyzeResult,
  CompileRequest,
  CompileResult,
} from '../../../packages/compiler/dist/index.js'
import {
  loadNativeCompilerBinding,
  type NativeCompilerBinding,
} from '../../../packages/compiler/dist/native-loader.js'

const request: CompileRequest = {
  code: 'export const value: number = 1',
  filename: 'value.ts',
  language: 'ts',
}
const binding: NativeCompilerBinding = loadNativeCompilerBinding({
  nativePath: '/tmp/fict-compiler.node',
})
const syncResult: CompileResult = binding.transformSync(request)
const asyncResult: Promise<CompileResult> = binding.transform(request)
const analyzeRequest: AnalyzeRequest = {
  code: 'export function App() { return <div /> }',
  filename: 'App.tsx',
  options: { verbosity: 'verbose' },
}
const analysis: AnalyzeResult = binding.analyzeSync(analyzeRequest)
const asyncAnalysis: Promise<AnalyzeResult> = binding.analyze(analyzeRequest)

void syncResult
void asyncResult
void analysis
void asyncAnalysis
