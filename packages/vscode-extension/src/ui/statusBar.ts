import * as vscode from 'vscode'

import type { FictDocumentAnalysis } from '../analysis/types'

function countRegions(analysis: FictDocumentAnalysis): number {
  const visit = (
    regions: NonNullable<FictDocumentAnalysis['components'][number]['regions']>,
  ): number => {
    return regions.reduce((total, region) => {
      const children = region.children ? visit(region.children) : 0
      return total + 1 + children
    }, 0)
  }

  return analysis.components.reduce((total, component) => {
    if (!component.regions) return total
    return total + visit(component.regions)
  }, 0)
}

export class FictStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 120)
    this.item.name = 'Fict Status'
    this.item.command = 'fict.openCompiledOutput'
  }

  update(analysis: FictDocumentAnalysis | null): void {
    if (!analysis || !analysis.isFictFile) {
      this.item.hide()
      return
    }

    const regions = countRegions(analysis)
    this.item.text = `Fict: ${analysis.components.length} components, ${regions} regions`
    this.item.tooltip = `Trace mode: ${analysis.mode}`
    this.item.show()
  }

  hide(): void {
    this.item.hide()
  }

  dispose(): void {
    this.item.dispose()
  }
}
