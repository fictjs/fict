import * as vscode from 'vscode'

import type {
  LineTrace,
  RegionInfoSerializable,
  TraceMarker,
  TraceMarkerKind,
} from '../analysis/types'

export interface TraceDecorationApplyOptions {
  showOnce: boolean
  showRegionShading: boolean
  regions?: RegionInfoSerializable[]
}

function pickPrimaryMarker(markers: TraceMarker[], showOnce: boolean): TraceMarkerKind | null {
  if (markers.some(marker => marker.kind === 'effect')) return 'effect'
  if (markers.some(marker => marker.kind === 'reactive')) return 'reactive'
  if (!showOnce) return null
  if (markers.some(marker => marker.kind === 'once')) return 'once'
  return null
}

function labelForKind(kind: TraceMarkerKind): string {
  if (kind === 'once') return 'Runs ONCE'
  if (kind === 'reactive') return 'Runs on dependency changes'
  return 'Effect'
}

function appendMarkerDetail(markdown: vscode.MarkdownString, marker: TraceMarker): void {
  markdown.appendMarkdown(`**${labelForKind(marker.kind)}** - ${marker.label}`)

  const details: string[] = []
  if (marker.deps && marker.deps.length > 0) {
    details.push(`deps: ${marker.deps.join(', ')}`)
  }
  if (marker.regionId !== undefined) {
    details.push(`region: #${marker.regionId}`)
  }
  if (marker.runCount !== undefined) {
    details.push(`runs: ${marker.runCount}`)
  }
  if (marker.lastDurationMs !== undefined) {
    details.push(`last: ${marker.lastDurationMs.toFixed(2)}ms`)
  }
  if (details.length > 0) {
    markdown.appendMarkdown(`\n\n_${details.join(' | ')}_`)
  }

  markdown.appendMarkdown('\n\n')
}

function buildHoverMarkdown(markers: TraceMarker[]): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString()
  markdown.isTrusted = false

  for (const marker of markers) {
    appendMarkerDetail(markdown, marker)
  }

  return markdown
}

function flattenRegions(regions: RegionInfoSerializable[] | undefined): RegionInfoSerializable[] {
  if (!regions || regions.length === 0) return []
  const flattened: RegionInfoSerializable[] = []

  const visit = (region: RegionInfoSerializable): void => {
    flattened.push(region)
    region.children?.forEach(child => visit(child))
  }

  regions.forEach(region => visit(region))
  return flattened
}

export class TraceDecorationManager implements vscode.Disposable {
  private readonly onceType: vscode.TextEditorDecorationType
  private readonly reactiveType: vscode.TextEditorDecorationType
  private readonly effectType: vscode.TextEditorDecorationType
  private readonly regionType: vscode.TextEditorDecorationType

  constructor(context: vscode.ExtensionContext) {
    this.onceType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: context.asAbsolutePath('media/trace-once.svg'),
      gutterIconSize: 'contain',
    })

    this.reactiveType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: context.asAbsolutePath('media/trace-reactive.svg'),
      gutterIconSize: 'contain',
    })

    this.effectType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: context.asAbsolutePath('media/trace-effect.svg'),
      gutterIconSize: 'contain',
    })

    this.regionType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      light: {
        backgroundColor: 'rgba(53, 94, 59, 0.08)',
      },
      dark: {
        backgroundColor: 'rgba(110, 170, 120, 0.12)',
      },
    })
  }

  apply(
    editor: vscode.TextEditor,
    traces: LineTrace[],
    options: TraceDecorationApplyOptions,
  ): void {
    const once: vscode.DecorationOptions[] = []
    const reactive: vscode.DecorationOptions[] = []
    const effect: vscode.DecorationOptions[] = []

    for (const trace of traces) {
      const lineIndex = trace.line - 1
      if (lineIndex < 0 || lineIndex >= editor.document.lineCount) continue

      const primary = pickPrimaryMarker(trace.markers, options.showOnce)
      if (!primary) continue

      const decoration: vscode.DecorationOptions = {
        range: new vscode.Range(lineIndex, 0, lineIndex, 0),
        hoverMessage: buildHoverMarkdown(trace.markers),
      }

      if (primary === 'effect') {
        effect.push(decoration)
      } else if (primary === 'reactive') {
        reactive.push(decoration)
      } else {
        once.push(decoration)
      }
    }

    editor.setDecorations(this.onceType, once)
    editor.setDecorations(this.reactiveType, reactive)
    editor.setDecorations(this.effectType, effect)

    if (!options.showRegionShading || !options.regions || options.regions.length === 0) {
      editor.setDecorations(this.regionType, [])
      return
    }

    const regions = flattenRegions(options.regions)
    const regionDecorations: vscode.DecorationOptions[] = []

    for (const region of regions) {
      if (region.startLine === undefined || region.endLine === undefined) continue
      const start = Math.max(0, region.startLine - 1)
      const end = Math.max(start, region.endLine - 1)

      regionDecorations.push({
        range: new vscode.Range(start, 0, end, 0),
        hoverMessage: new vscode.MarkdownString(
          `**Region #${region.id}**\n\nDeps: ${region.dependencies.join(', ') || '(none)'}`,
        ),
      })
    }

    editor.setDecorations(this.regionType, regionDecorations)
  }

  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.onceType, [])
    editor.setDecorations(this.reactiveType, [])
    editor.setDecorations(this.effectType, [])
    editor.setDecorations(this.regionType, [])
  }

  dispose(): void {
    this.onceType.dispose()
    this.reactiveType.dispose()
    this.effectType.dispose()
    this.regionType.dispose()
  }
}
