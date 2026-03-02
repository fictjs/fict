import * as vscode from 'vscode'

import {
  analyzeDocument,
  mergeComponentTraces,
  resolveAnalyzerSettings,
} from './analysis/analyzerClient'
import { FictDiagnosticsManager } from './analysis/diagnostics'
import { LiveTraceClient } from './analysis/live-client'
import { LiveTraceStore } from './analysis/live-trace'
import type { FictDocumentAnalysis } from './analysis/types'
import { CompiledOutputProvider, compileDocumentSource } from './commands/compilePreview'
import { buildReactivityExplanation } from './commands/explain'
import { FictCodeActionProvider } from './ui/codeActions'
import { TraceDecorationManager } from './ui/decorations'
import { FictFileDecorationProvider } from './ui/fileDecorations'
import { FictStatusBar } from './ui/statusBar'
import { FictComponentTreeProvider } from './ui/treeView'

const ANALYZE_DEBOUNCE_MS = 220
const OUTPUT_CHANNEL_NAME = 'Fict'

const DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { language: 'typescriptreact' },
  { language: 'javascriptreact' },
  { language: 'typescript' },
  { language: 'javascript' },
]

let output: vscode.OutputChannel | null = null
let analysisTimer: NodeJS.Timeout | null = null

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME)

  const traceDecorations = new TraceDecorationManager(context)
  const diagnostics = new FictDiagnosticsManager()
  const fileDecorations = new FictFileDecorationProvider()
  const statusBar = new FictStatusBar()
  const treeProvider = new FictComponentTreeProvider()
  const compiledOutputProvider = new CompiledOutputProvider()
  const liveTraceStore = new LiveTraceStore()
  const analysisByUri = new Map<string, FictDocumentAnalysis>()

  const liveTraceClient = new LiveTraceClient(liveTraceStore, {
    onFileUpdate: updatedFile => {
      const active = vscode.window.activeTextEditor
      if (!active) return
      const activeFile = active.document.uri.fsPath || active.document.fileName
      if (updatedFile === activeFile) {
        scheduleAnalysis(active)
      }
    },
    onLog: message => {
      output?.appendLine(message)
    },
  })

  const applyAnalysisToEditor = (
    editor: vscode.TextEditor,
    analysis: FictDocumentAnalysis | null,
  ): void => {
    const uri = editor.document.uri
    const config = vscode.workspace.getConfiguration('fict')

    if (!analysis || !analysis.isFictFile) {
      traceDecorations.clear(editor)
      diagnostics.clear(uri)
      fileDecorations.update(uri, null)
      statusBar.update(null)
      treeProvider.update(uri, null)
      return
    }

    const cursorLine = editor.selection.active.line + 1
    const activeComponent =
      analysis.components.find(
        item => cursorLine >= item.startLine && cursorLine <= item.endLine,
      ) ?? analysis.components[0]

    let traces = mergeComponentTraces(analysis, cursorLine)
    if (config.get<boolean>('trace.showInJsxOnly', false)) {
      traces = traces.filter(line =>
        line.markers.some(marker => marker.label.includes('JSX expression updates')),
      )
    }

    traceDecorations.apply(editor, traces, {
      showOnce: config.get<boolean>('trace.showOnce', true),
      showRegionShading: config.get<boolean>('trace.showRegionShading', false),
      regions: activeComponent?.regions,
    })

    diagnostics.update(uri, analysis.diagnostics)
    fileDecorations.update(uri, analysis)
    statusBar.update(analysis)
    treeProvider.update(uri, analysis)
    treeProvider.setActiveDocument(uri)
  }

  const runAnalysis = async (editor?: vscode.TextEditor): Promise<void> => {
    const activeEditor = editor ?? vscode.window.activeTextEditor
    if (!activeEditor) return

    const config = vscode.workspace.getConfiguration('fict')
    const enabled = config.get<boolean>('trace.enabled', true)
    const uriKey = activeEditor.document.uri.toString()

    if (!enabled) {
      analysisByUri.delete(uriKey)
      applyAnalysisToEditor(activeEditor, null)
      return
    }

    const settings = resolveAnalyzerSettings(config)
    const filePath = activeEditor.document.uri.fsPath || activeEditor.document.fileName

    if (settings.mode === 'live') {
      const serverUrl = config.get<string>('dev.serverUrl', '').trim()
      if (serverUrl) {
        const connected = liveTraceClient.connect(serverUrl)
        if (connected) {
          liveTraceClient.subscribe(filePath)
        }
      }
    } else {
      liveTraceClient.unsubscribe(filePath)
    }

    const liveUpdates =
      settings.mode === 'live' ? liveTraceStore.getLineUpdates(filePath) : undefined
    const analysis = await analyzeDocument(activeEditor.document, settings, liveUpdates)

    if (!analysis) {
      analysisByUri.delete(uriKey)
      applyAnalysisToEditor(activeEditor, null)
      return
    }

    analysisByUri.set(uriKey, analysis)
    applyAnalysisToEditor(activeEditor, analysis)
  }

  const scheduleAnalysis = (editor?: vscode.TextEditor): void => {
    if (analysisTimer) {
      clearTimeout(analysisTimer)
    }

    analysisTimer = setTimeout(() => {
      void runAnalysis(editor)
    }, ANALYZE_DEBOUNCE_MS)
  }

  const refreshTrace = vscode.commands.registerCommand('fict.refreshTrace', async () => {
    await runAnalysis(vscode.window.activeTextEditor)
    output?.appendLine('Trace refreshed')
  })

  const explainReactivity = vscode.commands.registerCommand(
    'fict.explainReactivityHere',
    async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return

      const uriKey = editor.document.uri.toString()
      let analysis = analysisByUri.get(uriKey)
      if (!analysis) {
        await runAnalysis(editor)
        analysis = analysisByUri.get(uriKey)
      }

      if (!analysis) {
        void vscode.window.showInformationMessage(
          'Fict could not infer reactive markers for this file.',
        )
        return
      }

      const explanation = buildReactivityExplanation(analysis, editor.selection.active.line + 1)
      output?.appendLine(explanation)
      output?.show(true)
      void vscode.window.showInformationMessage('Fict explanation written to output panel.')
    },
  )

  const openCompiledOutput = vscode.commands.registerCommand(
    'fict.openCompiledOutput',
    async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return

      try {
        const compiled = compileDocumentSource(editor.document)
        const previewUri = compiledOutputProvider.setContent(editor.document.uri, compiled)
        const previewDoc = await vscode.workspace.openTextDocument(previewUri)
        await vscode.window.showTextDocument(previewDoc, {
          viewColumn: vscode.ViewColumn.Beside,
          preview: false,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        output?.appendLine(`Compile preview failed: ${message}`)
        void vscode.window.showErrorMessage(`Fict compile preview failed: ${message}`)
      }
    },
  )

  const revealRange = vscode.commands.registerCommand(
    'fict.revealRange',
    async (uri: vscode.Uri, startLine: number, endLine: number) => {
      const document = await vscode.workspace.openTextDocument(uri)
      const editor = await vscode.window.showTextDocument(document)
      const start = Math.max(0, startLine - 1)
      const end = Math.max(start, endLine - 1)
      const range = new vscode.Range(start, 0, end, 0)
      editor.selection = new vscode.Selection(range.start, range.start)
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    },
  )

  const openDiagnosticDocs = vscode.commands.registerCommand(
    'fict.openDiagnosticDocs',
    async (code: string) => {
      const anchor = String(code).toLowerCase()
      const uri = vscode.Uri.parse(
        `https://github.com/fictjs/fict/blob/main/docs/diagnostic-codes.md#${anchor}`,
      )
      await vscode.env.openExternal(uri)
    },
  )

  context.subscriptions.push(
    output,
    traceDecorations,
    diagnostics,
    statusBar,
    refreshTrace,
    explainReactivity,
    openCompiledOutput,
    revealRange,
    openDiagnosticDocs,
    vscode.window.createTreeView('fict.components', { treeDataProvider: treeProvider }),
    vscode.window.registerFileDecorationProvider(fileDecorations),
    vscode.workspace.registerTextDocumentContentProvider('fict-compiled', compiledOutputProvider),
    vscode.languages.registerCodeActionsProvider(DOCUMENT_SELECTOR, new FictCodeActionProvider(), {
      providedCodeActionKinds: FictCodeActionProvider.providedCodeActionKinds,
    }),
    vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor | undefined) => {
      treeProvider.setActiveDocument(editor?.document.uri ?? null)
      scheduleAnalysis(editor)
    }),
    vscode.window.onDidChangeTextEditorSelection((event: vscode.TextEditorSelectionChangeEvent) => {
      const analysis = analysisByUri.get(event.textEditor.document.uri.toString())
      if (!analysis) return
      applyAnalysisToEditor(event.textEditor, analysis)
    }),
    vscode.workspace.onDidOpenTextDocument((document: vscode.TextDocument) => {
      const editor = vscode.window.visibleTextEditors.find(
        (item: vscode.TextEditor) => item.document.uri.toString() === document.uri.toString(),
      )
      if (editor) {
        scheduleAnalysis(editor)
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document: vscode.TextDocument) => {
      analysisByUri.delete(document.uri.toString())
      diagnostics.clear(document.uri)
      fileDecorations.clear(document.uri)
      treeProvider.clear(document.uri)
      liveTraceStore.clearFile(document.uri.fsPath || document.fileName)
    }),
    vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) => {
      const active = vscode.window.activeTextEditor
      if (!active) return
      if (active.document.uri.toString() !== event.document.uri.toString()) return
      scheduleAnalysis(active)
    }),
    vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
      if (!event.affectsConfiguration('fict')) return
      scheduleAnalysis(vscode.window.activeTextEditor)
    }),
    {
      dispose: () => {
        if (analysisTimer) {
          clearTimeout(analysisTimer)
          analysisTimer = null
        }
        liveTraceClient.dispose()
      },
    },
  )

  output.appendLine('Fict VSCode extension activated')
  scheduleAnalysis(vscode.window.activeTextEditor)
}

export function deactivate(): void {
  output?.appendLine('Fict VSCode extension deactivated')
  output?.dispose()
  output = null
}
