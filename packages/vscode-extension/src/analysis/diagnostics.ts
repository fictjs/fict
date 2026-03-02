import * as vscode from 'vscode'

import type { AnalyzeDiagnostic } from './types'

function toSeverity(severity: AnalyzeDiagnostic['severity']): vscode.DiagnosticSeverity {
  switch (severity) {
    case 'error':
      return vscode.DiagnosticSeverity.Error
    case 'warning':
      return vscode.DiagnosticSeverity.Warning
    case 'hint':
      return vscode.DiagnosticSeverity.Hint
    case 'info':
    default:
      return vscode.DiagnosticSeverity.Information
  }
}

function toRange(diagnostic: AnalyzeDiagnostic): vscode.Range {
  const startLine = Math.max(0, (diagnostic.line || 1) - 1)
  const startColumn = Math.max(0, (diagnostic.column || 1) - 1)
  const endLine = Math.max(startLine, (diagnostic.endLine ?? diagnostic.line ?? 1) - 1)
  const endColumn = Math.max(startColumn + 1, (diagnostic.endColumn ?? diagnostic.column ?? 1) - 1)

  return new vscode.Range(startLine, startColumn, endLine, endColumn)
}

export class FictDiagnosticsManager implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('fict')

  update(uri: vscode.Uri, diagnostics: AnalyzeDiagnostic[]): void {
    if (diagnostics.length === 0) {
      this.collection.delete(uri)
      return
    }

    const mapped = diagnostics.map(item => {
      const diagnostic = new vscode.Diagnostic(
        toRange(item),
        item.message,
        toSeverity(item.severity),
      )
      diagnostic.code = item.code
      diagnostic.source = 'fict'
      return diagnostic
    })

    this.collection.set(uri, mapped)
  }

  clear(uri: vscode.Uri): void {
    this.collection.delete(uri)
  }

  reset(): void {
    this.collection.clear()
  }

  dispose(): void {
    this.collection.dispose()
  }
}
