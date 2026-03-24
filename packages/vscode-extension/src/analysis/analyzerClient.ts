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

function shouldFallbackToStaticAnalysis(result: {
  components: FictDocumentAnalysis['components']
  diagnostics: FictDocumentAnalysis['diagnostics']
}): boolean {
  const hasHIRFailure = result.diagnostics.some(diagnostic => {
    return (
      diagnostic.code === 'FICT-HIR-UNSUPPORTED' ||
      (diagnostic.code === 'FICT-COMPILE' && diagnostic.message.includes('[HIR]'))
    )
  })

  return result.components.length === 0 && hasHIRFailure
}

function extractLocationFromCompilerMessage(
  message: string,
): { line: number; column: number } | null {
  const lineMatch = /^>\s+(\d+)\s+\|/m.exec(message)
  const columnMatch = /^\s*\|\s+(\^+)/m.exec(message)
  if (!lineMatch || !columnMatch) return null

  const line = Number.parseInt(lineMatch[1] ?? '', 10)
  const carets = columnMatch[1]
  if (!Number.isFinite(line) || !carets) return null

  const markerIndex = columnMatch.index + columnMatch[0].indexOf(carets)
  const lineStart = message.lastIndexOf('\n', columnMatch.index) + 1
  const column = markerIndex - lineStart + 1

  return { line, column }
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
      const location = extractLocationFromCompilerMessage(message)
      fallback.diagnostics = [
        {
          code: 'FICT-COMPILE',
          message: message.split('\n')[0] ?? message,
          severity: 'error',
          line: location?.line ?? 1,
          column: location?.column ?? 1,
        },
      ]
    }

    return fallback
  }
}
