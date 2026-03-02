import * as vscode from 'vscode'

const FICT_DIAGNOSTIC_SOURCE = 'fict'

function toCodeString(code: string | number | { value: string } | undefined): string | null {
  if (typeof code === 'string' || typeof code === 'number') {
    return String(code)
  }
  if (code && typeof code.value === 'string') {
    return code.value
  }
  return null
}

export class FictCodeActionProvider implements vscode.CodeActionProvider<vscode.CodeAction> {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix]

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<(vscode.CodeAction | vscode.Command)[]> {
    const actions: vscode.CodeAction[] = []

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== FICT_DIAGNOSTIC_SOURCE) continue

      const code = toCodeString(diagnostic.code as string | number | { value: string } | undefined)
      if (!code) continue

      const suppressAction = new vscode.CodeAction(
        `Fict: suppress ${code} for next line`,
        vscode.CodeActionKind.QuickFix,
      )
      suppressAction.diagnostics = [diagnostic]
      suppressAction.isPreferred = true

      const edit = new vscode.WorkspaceEdit()
      const insertPosition = new vscode.Position(diagnostic.range.start.line, 0)
      edit.insert(document.uri, insertPosition, `// fict-ignore-next-line ${code}\n`)
      suppressAction.edit = edit
      actions.push(suppressAction)

      const docsAction = new vscode.CodeAction(
        `Fict: open docs for ${code}`,
        vscode.CodeActionKind.QuickFix,
      )
      docsAction.diagnostics = [diagnostic]
      docsAction.command = {
        command: 'fict.openDiagnosticDocs',
        title: 'Open Diagnostic Docs',
        arguments: [code],
      }
      actions.push(docsAction)
    }

    return actions
  }
}
