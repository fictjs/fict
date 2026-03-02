import * as vscode from 'vscode'

import type { FictDocumentAnalysis, RegionInfoSerializable } from '../analysis/types'

type TreeNode =
  | {
      kind: 'component'
      uri: vscode.Uri
      componentIndex: number
      label: string
      startLine: number
      endLine: number
      regions: RegionInfoSerializable[]
    }
  | {
      kind: 'region'
      uri: vscode.Uri
      componentIndex: number
      region: RegionInfoSerializable
    }

export class FictComponentTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | null>()
  readonly onDidChangeTreeData = this.emitter.event

  private readonly analysisByUri = new Map<string, FictDocumentAnalysis>()
  private activeUri: string | null = null

  setActiveDocument(uri: vscode.Uri | null): void {
    this.activeUri = uri ? uri.toString() : null
    this.refresh()
  }

  update(uri: vscode.Uri, analysis: FictDocumentAnalysis | null): void {
    if (analysis) {
      this.analysisByUri.set(uri.toString(), analysis)
    } else {
      this.analysisByUri.delete(uri.toString())
    }
    this.refresh()
  }

  clear(uri: vscode.Uri): void {
    this.analysisByUri.delete(uri.toString())
    this.refresh()
  }

  refresh(): void {
    this.emitter.fire(undefined)
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === 'component') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed)
      item.description = `L${element.startLine}-${element.endLine}`
      item.contextValue = 'fict.component'
      item.command = {
        command: 'fict.revealRange',
        title: 'Reveal Component',
        arguments: [element.uri, element.startLine, element.endLine],
      }
      return item
    }

    const item = new vscode.TreeItem(
      `Region #${element.region.id}`,
      element.region.children && element.region.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    )

    const start = element.region.startLine ?? '?'
    const end = element.region.endLine ?? '?'
    item.description = `L${start}-${end}`
    item.tooltip = `Deps: ${element.region.dependencies.join(', ') || '(none)'}`
    item.contextValue = 'fict.region'
    item.command = {
      command: 'fict.revealRange',
      title: 'Reveal Region',
      arguments: [
        element.uri,
        element.region.startLine ?? 1,
        element.region.endLine ?? element.region.startLine ?? 1,
      ],
    }
    return item
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!this.activeUri) return []
    const analysis = this.analysisByUri.get(this.activeUri)
    if (!analysis) return []

    const uri = vscode.Uri.file(analysis.fileName)

    if (!element) {
      return analysis.components.map((component, componentIndex) => ({
        kind: 'component' as const,
        uri,
        componentIndex,
        label: component.name,
        startLine: component.startLine,
        endLine: component.endLine,
        regions: component.regions ?? [],
      }))
    }

    if (element.kind === 'component') {
      return element.regions.map(region => ({
        kind: 'region' as const,
        uri,
        componentIndex: element.componentIndex,
        region,
      }))
    }

    return (element.region.children ?? []).map(region => ({
      kind: 'region' as const,
      uri,
      componentIndex: element.componentIndex,
      region,
    }))
  }
}
