import * as vscode from 'vscode'

import type { FictDocumentAnalysis } from '../analysis/types'

interface FileTraceSummary {
  components: number
  regions: number
}

function countRegions(analysis: FictDocumentAnalysis): number {
  return analysis.components.reduce((total, component) => {
    if (!component.regions) return total
    const countRegion = (region: NonNullable<typeof component.regions>[number]): number => {
      const children = region.children?.reduce((sum, child) => sum + countRegion(child), 0) ?? 0
      return 1 + children
    }

    return total + component.regions.reduce((sum, region) => sum + countRegion(region), 0)
  }, 0)
}

export class FictFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly summaries = new Map<string, FileTraceSummary>()
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>()

  readonly onDidChangeFileDecorations = this.emitter.event

  update(uri: vscode.Uri, analysis: FictDocumentAnalysis | null): void {
    if (!analysis || !analysis.isFictFile) {
      this.summaries.delete(uri.toString())
      this.emitter.fire(uri)
      return
    }

    this.summaries.set(uri.toString(), {
      components: analysis.components.length,
      regions: countRegions(analysis),
    })
    this.emitter.fire(uri)
  }

  clear(uri: vscode.Uri): void {
    this.summaries.delete(uri.toString())
    this.emitter.fire(uri)
  }

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    const summary = this.summaries.get(uri.toString())
    if (!summary) return undefined

    return {
      badge: 'F',
      tooltip: `Fict: ${summary.components} components, ${summary.regions} regions`,
      color: new vscode.ThemeColor('charts.green'),
      propagate: false,
    }
  }
}
