import * as vscode from 'vscode'

import type { FictDocumentAnalysis } from '../analysis/types'

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderAnalysis(analysis: FictDocumentAnalysis | null): string {
  if (!analysis || analysis.components.length === 0) {
    return '<p>No Fict component analysis is available for the active file.</p>'
  }

  const sections = analysis.components
    .map(component => {
      const traceItems = component.trace
        .map(entry => {
          const markers = entry.markers
            .map(marker => {
              const extras: string[] = []
              if (marker.deps && marker.deps.length > 0)
                extras.push(`deps: ${marker.deps.join(', ')}`)
              if (marker.runCount !== undefined) extras.push(`runs: ${marker.runCount}`)
              if (marker.lastDurationMs !== undefined) {
                extras.push(`last: ${marker.lastDurationMs.toFixed(2)}ms`)
              }
              const detail =
                extras.length > 0 ? ` <em>(${escapeHtml(extras.join(' | '))})</em>` : ''
              return `<li><strong>${escapeHtml(marker.kind)}</strong> - ${escapeHtml(marker.label)}${detail}</li>`
            })
            .join('')

          return `<li><strong>Line ${entry.line}</strong><ul>${markers}</ul></li>`
        })
        .join('')

      return `
        <section>
          <h3>${escapeHtml(component.name)} <small>(L${component.startLine}-${component.endLine})</small></h3>
          <ul>${traceItems || '<li>No markers</li>'}</ul>
        </section>
      `
    })
    .join('')

  return `
    <p><strong>File:</strong> ${escapeHtml(analysis.fileName)}</p>
    <p><strong>Mode:</strong> ${escapeHtml(analysis.mode)}</p>
    ${sections}
  `
}

export class FictInspectorPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null

  show(context: vscode.ExtensionContext, analysis: FictDocumentAnalysis | null): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'fict.inspector',
        'Fict Inspector',
        vscode.ViewColumn.Beside,
        {
          enableScripts: false,
          retainContextWhenHidden: true,
        },
      )

      this.panel.onDidDispose(
        () => {
          this.panel = null
        },
        null,
        context.subscriptions,
      )
    }

    this.panel.webview.html = this.renderHtml(analysis)
    this.panel.reveal(vscode.ViewColumn.Beside)
  }

  update(analysis: FictDocumentAnalysis | null): void {
    if (!this.panel) return
    this.panel.webview.html = this.renderHtml(analysis)
  }

  dispose(): void {
    this.panel?.dispose()
    this.panel = null
  }

  private renderHtml(analysis: FictDocumentAnalysis | null): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Fict Inspector</title>
    <style>
      body {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
        margin: 0;
        padding: 12px;
        color: var(--vscode-editor-foreground);
        background: linear-gradient(
          180deg,
          var(--vscode-editor-background) 0%,
          color-mix(in srgb, var(--vscode-editor-background) 88%, #40644a 12%) 100%
        );
      }

      h2 {
        margin-top: 0;
      }

      section {
        border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent 75%);
        border-radius: 8px;
        padding: 10px;
        margin-bottom: 10px;
        background: color-mix(in srgb, var(--vscode-editor-background) 85%, #2f4f37 15%);
      }

      ul {
        margin: 8px 0;
        padding-left: 18px;
      }

      small {
        opacity: 0.8;
      }
    </style>
  </head>
  <body>
    <h2>Fict Inspector</h2>
    ${renderAnalysis(analysis)}
  </body>
</html>`
  }
}
