import {
  analyze,
  analyzeSync,
  nativeCompilerInfo,
  scan,
  scanSync,
  transform,
  transformSync,
  type AnalyzeRequest,
  type AnalyzeResult,
  type CompileRequest,
  type CompileResult,
  type ScanRequest,
  type ScanResult,
} from '../../../packages/compiler/dist/index.js'
import {
  createNativeCompilerFacade,
  loadNativeCompilerBinding,
  type NativeCompilerBinding,
  type NativeCompilerFacade,
} from '../../../packages/compiler/dist/native-loader.js'
import legacyCompiler, {
  createFictPlugin as explicitLegacyCompiler,
} from '../../../packages/compiler/dist/legacy.js'
import {
  parseModuleReactiveMetadata,
  resolvePackageModuleMetadata,
} from '../../../packages/compiler/dist/graph-host.js'

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
const facade: NativeCompilerFacade = createNativeCompilerFacade({
  nativePath: '/tmp/fict-compiler.node',
})
const directSyncResult: CompileResult = transformSync(request)
const directAsyncResult: Promise<CompileResult> = transform(request)
const scanRequest: ScanRequest = request
const directScanResult: ScanResult = scanSync(scanRequest)
const directAsyncScanResult: Promise<ScanResult> = scan(scanRequest)
const directAnalysis: AnalyzeResult = analyzeSync(analyzeRequest)
const directAsyncAnalysis: Promise<AnalyzeResult> = analyze(analyzeRequest)
const buildId: string = nativeCompilerInfo().compilerBuildId
const buildRevision: string | null = nativeCompilerInfo().compilerBuildRevision
const legacyFactory: typeof explicitLegacyCompiler = legacyCompiler
const parsedMetadata = parseModuleReactiveMetadata('{"version":1,"exports":{}}')
const packageMetadata = resolvePackageModuleMetadata('fict-library', import.meta.filename)

void syncResult
void asyncResult
void analysis
void asyncAnalysis
void facade
void directSyncResult
void directAsyncResult
void directScanResult
void directAsyncScanResult
void directAnalysis
void directAsyncAnalysis
void buildId
void buildRevision
void legacyFactory
void parsedMetadata
void packageMetadata
