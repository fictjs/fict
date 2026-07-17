import type * as vscode from 'vscode'
import diagnosticRegistry from '../../../../diagnostics/registry.json'

import {
  getEditorNativeCompiler,
  sourceLanguageForDocument,
  type NativeAnalyzer,
} from '../compiler/native'

import {
  analyzeStaticFictSource,
  isLikelyFictSource,
  isSupportedLanguageId,
  mergeLiveTraceUpdates,
} from './static-analyzer'
import type { AnalyzerSettings, FictDocumentAnalysis, LiveTraceLineUpdate } from './types'

const DEFAULT_SETTINGS: AnalyzerSettings = {
  mode: 'compiler',
  verbosity: 'minimal',
  includeRegions: true,
  includeDiagnostics: true,
}

export function resolveAnalyzerSettings(config: vscode.WorkspaceConfiguration): AnalyzerSettings {
  const modeValue = config.get<string>('trace.mode')
  const verbosityValue = config.get<string>('trace.verbosity')

  const mode = modeValue === 'static' || modeValue === 'live' ? modeValue : 'compiler'
  const verbosity = verbosityValue === 'verbose' ? 'verbose' : 'minimal'

  return {
    mode,
    verbosity,
    includeRegions: config.get<boolean>('trace.showRegionShading', false),
    includeDiagnostics: true,
  }
}

function asFictAnalysis(result: {
  fileName: string
  components: FictDocumentAnalysis['components']
  diagnostics: FictDocumentAnalysis['diagnostics']
}): FictDocumentAnalysis {
  return {
    ...result,
    mode: 'compiler',
    isFictFile: true,
    generatedAt: Date.now(),
  }
}

function shouldFallbackToStaticAnalysis(result: {
  components: FictDocumentAnalysis['components']
  diagnostics: FictDocumentAnalysis['diagnostics']
}): boolean {
  const fallback = diagnosticRegistry.integrations.vscodeStaticAnalysisFallback
  const hasHIRFailure = result.diagnostics.some(
    diagnostic =>
      fallback.includePrefixes.some(prefix => diagnostic.code.startsWith(prefix)) &&
      !fallback.excludePrefixes.some(prefix => diagnostic.code.startsWith(prefix)),
  )

  return result.components.length === 0 && hasHIRFailure
}

export function mergeComponentTraces(
  analysis: FictDocumentAnalysis,
  cursorLine: number,
): FictDocumentAnalysis['components'][number]['trace'] {
  const component =
    analysis.components.find(item => cursorLine >= item.startLine && cursorLine <= item.endLine) ??
    analysis.components[0]

  return component?.trace ?? []
}

export async function analyzeDocument(
  document: vscode.TextDocument,
  settings: AnalyzerSettings = DEFAULT_SETTINGS,
  liveLineUpdates?: Map<number, LiveTraceLineUpdate>,
  nativeAnalyzer?: NativeAnalyzer,
): Promise<FictDocumentAnalysis | null> {
  if (!isSupportedLanguageId(document.languageId)) {
    return null
  }

  const source = document.getText()
  const fileName = document.uri.fsPath || document.fileName
  const isFictFile = isLikelyFictSource(source)

  if (!isFictFile) {
    return null
  }

  if (settings.mode === 'static') {
    return analyzeStaticFictSource(source, fileName, settings.verbosity)
  }

  try {
    const compiler = nativeAnalyzer ?? getEditorNativeCompiler()
    const compilerAnalysis = compiler.analyzeSync({
      code: source,
      filename: fileName,
      moduleId: document.uri.toString(),
      language: sourceLanguageForDocument(document),
      options: {
        includeRegions: settings.includeRegions,
        includeDiagnostics: settings.includeDiagnostics,
        verbosity: settings.verbosity,
        compilerOptions: {
          dev: false,
          strictGuarantee: true,
        },
      },
    })

    let analysis = shouldFallbackToStaticAnalysis(compilerAnalysis)
      ? {
          ...analyzeStaticFictSource(source, fileName, settings.verbosity),
          diagnostics: compilerAnalysis.diagnostics,
          mode: settings.mode,
        }
      : asFictAnalysis(compilerAnalysis)
    analysis.mode = settings.mode

    if (settings.mode === 'live' && liveLineUpdates) {
      analysis = {
        ...analysis,
        components: mergeLiveTraceUpdates(analysis.components, liveLineUpdates),
      }
    }

    return analysis
  } catch (error) {
    const fallback = analyzeStaticFictSource(source, fileName, settings.verbosity)
    fallback.mode = settings.mode

    if (settings.includeDiagnostics) {
      const message = error instanceof Error ? error.message : String(error)
      const code =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'FICT_NATIVE_COMPILER_LOAD_FAILED'
          ? 'FICT-NATIVE-LOAD'
          : 'FICT-NATIVE-HOST'
      fallback.diagnostics = [
        {
          code,
          message: message.split('\n')[0] ?? message,
          severity: 'error',
          line: 1,
          column: 1,
        },
      ]
    }

    return fallback
  }
}
