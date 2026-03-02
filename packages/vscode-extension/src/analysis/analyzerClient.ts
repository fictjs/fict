import { analyzeFictFile } from '@fictjs/compiler'
import type * as vscode from 'vscode'

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
    const compilerAnalysis = analyzeFictFile(source, fileName, {
      includeRegions: settings.includeRegions,
      includeDiagnostics: settings.includeDiagnostics,
      verbosity: settings.verbosity,
    })

    let analysis = asFictAnalysis(compilerAnalysis)
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
      fallback.diagnostics = [
        {
          code: 'FICT-ANALYZE',
          message,
          severity: 'error',
          line: 1,
          column: 1,
        },
      ]
    }

    return fallback
  }
}
