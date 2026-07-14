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
} from '../../../packages/compiler/dist/index.cjs'
import {
  createNativeCompilerFacade,
  loadNativeCompilerBinding,
  type NativeCompilerBinding,
  type NativeCompilerFacade,
} from '../../../packages/compiler/dist/native-loader.cjs'
import legacyCompiler, {
  createFictPlugin as explicitLegacyCompiler,
} from '../../../packages/compiler/dist/legacy.cjs'
import {
  parseModuleReactiveMetadata,
  resolvePackageModuleMetadata,
} from '../../../packages/compiler/dist/graph-host.cjs'

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
const facade: NativeCompilerFacade = createNativeCompilerFacade({
  nativePath: 'C:\\fict-compiler.node',
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
const packageMetadata = resolvePackageModuleMetadata('fict-library', __filename)

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
