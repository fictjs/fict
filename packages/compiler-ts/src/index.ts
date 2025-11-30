import ts from 'typescript'

export interface FictCompilerOptions {
  dev?: boolean
  sourcemap?: boolean
}

interface HelperUsage {
  signal: boolean
  memo: boolean
  effect: boolean
}

const RUNTIME_MODULE = 'fict-runtime'
const RUNTIME_HELPERS = {
  signal: 'createSignal',
  memo: 'createMemo',
  effect: 'createEffect',
} as const

const RUNTIME_ALIASES = {
  signal: '__fictSignal',
  memo: '__fictMemo',
  effect: '__fictEffect',
} as const

export function createFictTransformer(
  _program?: ts.Program | null,
  _options: FictCompilerOptions = {},
): ts.TransformerFactory<ts.SourceFile> {
  return context => {
    const factory = context.factory

    return sourceFile => {
      const stateVars = new Set<string>()
      collectStateVariables(sourceFile, stateVars)

      const memoVars = new Set<string>()
      const helpersUsed: HelperUsage = { signal: false, memo: false, effect: false }

      const visitor: ts.Visitor = node => {
        if (ts.isImportDeclaration(node)) {
          return stripMacroImports(factory, node)
        }

        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const visitedInit = ts.visitNode(node.initializer, visitor) as ts.Expression

          if (isStateCall(visitedInit)) {
            stateVars.add(node.name.text)
            helpersUsed.signal = true

            const newInit = factory.updateCallExpression(
              visitedInit,
              factory.createIdentifier(RUNTIME_ALIASES.signal),
              undefined,
              visitedInit.arguments,
            )

            return factory.updateVariableDeclaration(
              node,
              node.name,
              node.exclamationToken,
              node.type,
              newInit,
            )
          }

          if (
            shouldMemoize(node, stateVars) &&
            dependsOnTracked(visitedInit, stateVars, memoVars)
          ) {
            memoVars.add(node.name.text)
            helpersUsed.memo = true

            const memoCall = factory.createCallExpression(
              factory.createIdentifier(RUNTIME_ALIASES.memo),
              undefined,
              [
                factory.createArrowFunction(
                  undefined,
                  undefined,
                  [],
                  undefined,
                  factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                  visitedInit,
                ),
              ],
            )

            return factory.updateVariableDeclaration(
              node,
              node.name,
              node.exclamationToken,
              node.type,
              memoCall,
            )
          }

          return factory.updateVariableDeclaration(
            node,
            node.name,
            node.exclamationToken,
            node.type,
            visitedInit,
          )
        }

        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === '$effect'
        ) {
          helpersUsed.effect = true
          const updatedArgs = node.arguments.map(arg => ts.visitNode(arg, visitor) as ts.Expression)
          return factory.updateCallExpression(
            node,
            factory.createIdentifier(RUNTIME_ALIASES.effect),
            node.typeArguments,
            updatedArgs,
          )
        }

        if (
          ts.isBinaryExpression(node) &&
          ts.isIdentifier(node.left) &&
          isAssignmentOperator(node.operatorToken.kind)
        ) {
          const name = node.left.text
          if (stateVars.has(name)) {
            const right = ts.visitNode(node.right, visitor) as ts.Expression
            const setter = factory.createIdentifier(name)
            const getterCall = createGetterCall(factory, name)

            if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
              return factory.createCallExpression(setter, undefined, [right])
            }

            const op = toBinaryOperator(node.operatorToken.kind)
            if (op) {
              return factory.createCallExpression(setter, undefined, [
                factory.createBinaryExpression(getterCall, op, right),
              ])
            }

            return factory.createCallExpression(setter, undefined, [right])
          }
        }

        if (
          (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
          ts.isIdentifier(node.operand) &&
          stateVars.has(node.operand.text)
        ) {
          const setter = factory.createIdentifier(node.operand.text)
          const getterCall = createGetterCall(factory, node.operand.text)
          const delta =
            node.operator === ts.SyntaxKind.PlusPlusToken
              ? factory.createNumericLiteral(1)
              : factory.createNumericLiteral(-1)
          return factory.createCallExpression(setter, undefined, [
            factory.createBinaryExpression(
              getterCall,
              node.operator === ts.SyntaxKind.PlusPlusToken
                ? ts.SyntaxKind.PlusToken
                : ts.SyntaxKind.MinusToken,
              delta,
            ),
          ])
        }

        if (
          ts.isShorthandPropertyAssignment(node) &&
          isTracked(node.name.text, stateVars, memoVars)
        ) {
          return factory.createPropertyAssignment(
            node.name,
            createGetterCall(factory, node.name.text),
          )
        }

        if (ts.isIdentifier(node) && isTracked(node.text, stateVars, memoVars)) {
          if (shouldTransformIdentifier(node)) {
            return createGetterCall(factory, node.text)
          }
        }

        return ts.visitEachChild(node, visitor, context)
      }

      const transformed = (ts.visitNode(sourceFile, visitor) ?? sourceFile) as ts.SourceFile
      return addRuntimeImports(transformed, helpersUsed, factory)
    }
  }
}

function collectStateVariables(sourceFile: ts.SourceFile, stateVars: Set<string>): void {
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (isStateCall(node.initializer)) {
        stateVars.add(node.name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function isStateCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === '$state'
  )
}

function dependsOnTracked(
  expr: ts.Expression,
  stateVars: Set<string>,
  memoVars: Set<string>,
): boolean {
  let depends = false
  const visit = (node: ts.Node): void => {
    if (depends) return
    if (ts.isIdentifier(node) && isTracked(node.text, stateVars, memoVars)) {
      depends = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(expr)
  return depends
}

function isTracked(name: string, stateVars: Set<string>, memoVars: Set<string>): boolean {
  return stateVars.has(name) || memoVars.has(name)
}

function shouldMemoize(node: ts.VariableDeclaration, stateVars: Set<string>): boolean {
  const list = node.parent
  const isConst =
    ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) === ts.NodeFlags.Const
  if (!isConst || node.initializer === undefined) return false
  if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    return false
  return !stateVars.has(node.name.getText())
}

function createGetterCall(factory: ts.NodeFactory, name: string): ts.CallExpression {
  return factory.createCallExpression(factory.createIdentifier(name), undefined, [])
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
}

function toBinaryOperator(kind: ts.SyntaxKind): ts.BinaryOperator | undefined {
  switch (kind) {
    case ts.SyntaxKind.PlusEqualsToken:
      return ts.SyntaxKind.PlusToken
    case ts.SyntaxKind.MinusEqualsToken:
      return ts.SyntaxKind.MinusToken
    case ts.SyntaxKind.AsteriskEqualsToken:
      return ts.SyntaxKind.AsteriskToken
    case ts.SyntaxKind.SlashEqualsToken:
      return ts.SyntaxKind.SlashToken
    case ts.SyntaxKind.PercentEqualsToken:
      return ts.SyntaxKind.PercentToken
    default:
      return undefined
  }
}

function shouldTransformIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent
  if (!parent) return false

  if (ts.isCallExpression(parent) && parent.expression === node) return false
  if (ts.isNewExpression(parent) && parent.expression === node) return false

  if (ts.isVariableDeclaration(parent) && parent.name === node) return false
  if (ts.isBindingElement(parent) && parent.name === node) return false
  if (ts.isParameter(parent) && parent.name === node) return false
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false
  if (ts.isFunctionExpression(parent) && parent.name === node) return false
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent))
    return false
  if (ts.isExportSpecifier(parent)) return false
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false
  if (ts.isJsxAttribute(parent)) return false
  if (ts.isTypeReferenceNode(parent) || ts.isExpressionWithTypeArguments(parent)) return false
  if (ts.isQualifiedName(parent)) return false
  if (ts.isShorthandPropertyAssignment(parent)) return false

  return true
}

function addRuntimeImports(
  sourceFile: ts.SourceFile,
  helpers: HelperUsage,
  factory: ts.NodeFactory,
): ts.SourceFile {
  const neededSpecifiers: ts.ImportSpecifier[] = []
  if (helpers.signal) {
    neededSpecifiers.push(
      factory.createImportSpecifier(
        false,
        factory.createIdentifier(RUNTIME_HELPERS.signal),
        factory.createIdentifier(RUNTIME_ALIASES.signal),
      ),
    )
  }
  if (helpers.memo) {
    neededSpecifiers.push(
      factory.createImportSpecifier(
        false,
        factory.createIdentifier(RUNTIME_HELPERS.memo),
        factory.createIdentifier(RUNTIME_ALIASES.memo),
      ),
    )
  }
  if (helpers.effect) {
    neededSpecifiers.push(
      factory.createImportSpecifier(
        false,
        factory.createIdentifier(RUNTIME_HELPERS.effect),
        factory.createIdentifier(RUNTIME_ALIASES.effect),
      ),
    )
  }

  if (!neededSpecifiers.length) return sourceFile

  let injected = false
  const statements = sourceFile.statements.map(stmt => {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text === RUNTIME_MODULE &&
      stmt.importClause?.namedBindings &&
      ts.isNamedImports(stmt.importClause.namedBindings)
    ) {
      const existingNames = new Set(
        stmt.importClause.namedBindings.elements.map(el => el.name.text),
      )
      const additional = neededSpecifiers.filter(spec => !existingNames.has(spec.name.text))
      if (!additional.length) return stmt

      injected = true
      return factory.updateImportDeclaration(
        stmt,
        stmt.modifiers,
        factory.updateImportClause(
          stmt.importClause,
          false,
          stmt.importClause.name,
          factory.createNamedImports([...stmt.importClause.namedBindings.elements, ...additional]),
        ),
        stmt.moduleSpecifier,
        stmt.assertClause,
      )
    }
    return stmt
  })

  if (injected) {
    return factory.updateSourceFile(sourceFile, statements)
  }

  const importDecl = factory.createImportDeclaration(
    undefined,
    factory.createImportClause(false, undefined, factory.createNamedImports(neededSpecifiers)),
    factory.createStringLiteral(RUNTIME_MODULE),
    undefined,
  )

  return factory.updateSourceFile(
    sourceFile,
    ts.factory.createNodeArray([importDecl, ...statements]),
  )
}

function stripMacroImports(
  factory: ts.NodeFactory,
  node: ts.ImportDeclaration,
): ts.ImportDeclaration | undefined {
  if (!ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== 'fict') {
    return node
  }
  const clause = node.importClause
  if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
    return node
  }

  const filtered = clause.namedBindings.elements.filter(
    el => !['$state', '$effect'].includes(el.name.text),
  )

  if (!filtered.length && !clause.name) {
    return undefined
  }

  if (filtered.length === clause.namedBindings.elements.length) {
    return node
  }

  const updatedClause = factory.updateImportClause(
    clause,
    clause.isTypeOnly,
    clause.name,
    factory.createNamedImports(filtered),
  )

  return factory.updateImportDeclaration(
    node,
    node.modifiers,
    updatedClause,
    node.moduleSpecifier,
    node.assertClause,
  )
}

export default createFictTransformer
