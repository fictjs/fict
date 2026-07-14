import * as vscode from 'vscode'

export { compileDocumentSource } from '../compiler/tooling'

const COMPILED_SCHEME = 'fict-compiled'

function toCompiledUri(sourceUri: vscode.Uri): vscode.Uri {
  const encoded = encodeURIComponent(sourceUri.toString())
  return vscode.Uri.parse(`${COMPILED_SCHEME}://${encoded}.js`)
}

export class CompiledOutputProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>()
  private readonly contentByUri = new Map<string, string>()

  readonly onDidChange = this.emitter.event

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contentByUri.get(uri.toString()) ?? '// No compiled output.'
  }

  setContent(sourceUri: vscode.Uri, content: string): vscode.Uri {
    const compiledUri = toCompiledUri(sourceUri)
    this.contentByUri.set(compiledUri.toString(), content)
    this.emitter.fire(compiledUri)
    return compiledUri
  }
}
