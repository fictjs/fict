import { transformSync } from '@babel/core'
import presetTypescript from '@babel/preset-typescript'
import createFictPlugin from '@fictjs/compiler'
import * as vscode from 'vscode'

const COMPILED_SCHEME = 'fict-compiled'

function documentUsesJsx(document: vscode.TextDocument): boolean {
  if (document.languageId === 'typescriptreact' || document.languageId === 'javascriptreact') {
    return true
  }
  const cleanFileName = document.fileName.split(/[?#]/, 1)[0]?.toLowerCase() ?? ''
  return /\.(?:tsx|jsx)$/.test(cleanFileName)
}

function toCompiledUri(sourceUri: vscode.Uri): vscode.Uri {
  const encoded = encodeURIComponent(sourceUri.toString())
  return vscode.Uri.parse(`${COMPILED_SCHEME}://${encoded}.js`)
}

export function compileDocumentSource(document: vscode.TextDocument): string {
  const isTSX = documentUsesJsx(document)
  const result = transformSync(document.getText(), {
    filename: document.fileName,
    configFile: false,
    babelrc: false,
    sourceType: 'module',
    parserOpts: {
      sourceType: 'module',
      plugins: isTSX ? ['typescript', 'jsx'] : ['typescript'],
      allowReturnOutsideFunction: true,
    },
    plugins: [
      [
        createFictPlugin,
        {
          dev: true,
          filename: document.fileName,
          emitModuleMetadata: false,
        },
      ],
    ],
    presets: [[presetTypescript, { isTSX, allExtensions: true, allowDeclareFields: true }]],
    generatorOpts: {
      compact: false,
    },
  })

  return result?.code ?? '// No compiler output generated.'
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
