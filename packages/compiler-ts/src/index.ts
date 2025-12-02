import * as ts from 'typescript'

// ============================================================================
// Types and Constants
// ============================================================================

interface TransformContext {
  stateVars: Set<string>
  memoVars: Set<string>
  shadowedVars: Set<string>
  helpersUsed: HelperUsage
  factory: ts.NodeFactory
  context: ts.TransformationContext
  sourceFile: ts.SourceFile
  options: FictCompilerOptions
  dependencyGraph: Map<string, Set<string>>
  derivedDecls: Map<string, ts.Node>
  hasStateImport: boolean
  hasEffectImport: boolean
  exportedNames: Set<string>
}

interface HelperUsage {
  signal: boolean
  memo: boolean
  effect: boolean
  createElement: boolean
  conditional: boolean
  list: boolean
  insert: boolean
  onDestroy: boolean
}

export interface CompilerWarning {
  code: string
  message: string
  fileName: string
  line: number
  column: number
}

export interface FictCompilerOptions {
  dev?: boolean
  sourcemap?: boolean
  onWarn?: (warning: CompilerWarning) => void
}

const RUNTIME_MODULE = 'fict-runtime'
const RUNTIME_HELPERS = {
  signal: 'createSignal',
  memo: 'createMemo',
  effect: 'createEffect',
  createElement: 'createElement',
  conditional: 'createConditional',
  list: 'createList',
  insert: 'insert',
  onDestroy: 'onDestroy',
} as const

const RUNTIME_ALIASES = {
  signal: '__fictSignal',
  memo: '__fictMemo',
  effect: '__fictEffect',
  createElement: '__fictCreateElement',
  conditional: '__fictConditional',
  list: '__fictList',
  insert: '__fictInsert',
  onDestroy: '__fictOnDestroy',
} as const

// Attributes that should NOT be wrapped in reactive functions
const NON_REACTIVE_ATTRS = new Set(['key', 'ref'])

// ============================================================================
// Main Transformer
// ============================================================================

export function createFictTransformer(
  _program?: ts.Program | null,
  _options: FictCompilerOptions = {},
): ts.TransformerFactory<ts.SourceFile> {
  return context => {
    const factory = context.factory

    return sourceFile => {
      const macroInfo = analyzeMacroImports(sourceFile)
      const exportedNames = collectExportedNames(sourceFile)
      // Phase 1: Collect all $state variables
      const stateVars = new Set<string>()
      collectStateVariables(sourceFile, stateVars)

      // Phase 2: Track memo variables and used helpers
      const memoVars = new Set<string>()
      const helpersUsed: HelperUsage = {
        signal: false,
        memo: false,
        effect: false,
        createElement: false,
        conditional: false,
        list: false,
        insert: false,
        onDestroy: false,
      }

      // Phase 3: Create transform context and visitor
      const ctx: TransformContext = {
        stateVars,
        memoVars,
        shadowedVars: new Set(),
        helpersUsed,
        factory,
        context,
        sourceFile,
        options: _options,
        dependencyGraph: new Map(),
        derivedDecls: new Map(),
        hasStateImport: macroInfo.hasStateImport,
        hasEffectImport: macroInfo.hasEffectImport,
        exportedNames,
      }

      const visitor = createVisitor(ctx)
      const transformed = (ts.visitNode(sourceFile, visitor) ?? sourceFile) as ts.SourceFile
      detectDerivedCycles(ctx)
      return addRuntimeImports(transformed, helpersUsed, factory)
    }
  }
}

// ============================================================================
// Visitor Factory
// ============================================================================

function createVisitor(ctx: TransformContext): ts.Visitor {
  return createVisitorWithOptions(ctx, { disableRegionTransform: false, disableMemoize: false })
}

interface VisitorOptions {
  disableRegionTransform: boolean
  disableMemoize: boolean
}

function createVisitorWithOptions(ctx: TransformContext, opts: VisitorOptions): ts.Visitor {
  const { stateVars, memoVars, shadowedVars, helpersUsed, factory, context } = ctx

  const visitor: ts.Visitor = node => {
    // Handle control flow statements - disable region transform for nested blocks
    if (
      ts.isIfStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isSwitchStatement(node) ||
      ts.isCaseClause(node) ||
      ts.isDefaultClause(node)
    ) {
      // Visit nested blocks with region transform disabled
      const nestedVisitor = createVisitorWithOptions(ctx, {
        ...opts,
        disableRegionTransform: true,
      })
      return ts.visitEachChild(node, nestedVisitor, context)
    }

    // Handle blocks to enable Region grouping (Rule D)
    // Only for function bodies, not for nested blocks
    if (!opts.disableRegionTransform && ts.isBlock(node)) {
      return transformBlock(node, ctx, opts)
    }

    // Handle top-level source file (needed for module scope grouping)
    if (!opts.disableRegionTransform && ts.isSourceFile(node)) {
      const updatedStatements = transformStatementList(
        node.statements,
        ctx,
        opts,
        /*isSourceFile*/ true,
      )
      return factory.updateSourceFile(node, updatedStatements as ts.NodeArray<ts.Statement>)
    }

    // Handle imports - strip $state/$effect from 'fict' imports
    if (ts.isImportDeclaration(node)) {
      return stripMacroImports(factory, node)
    }

    // Handle function declarations/expressions - track parameter shadowing
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node)
    ) {
      return handleFunctionWithShadowing(node, ctx, opts)
    }

    // Handle variable declarations
    if (ts.isVariableDeclaration(node) && node.initializer) {
      return handleVariableDeclaration(node, ctx, visitor, opts)
    }

    // Handle $effect calls
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

    // Handle JSX expressions: {expr}
    if (ts.isJsxExpression(node) && node.expression) {
      return handleJsxExpression(node, ctx, visitor)
    }

    // Warn on deep property mutations and dynamic assignments
    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind) &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
    ) {
      return handlePropertyMutation(node, ctx, visitor)
    }

    // Handle assignment expressions: count = x, count += x
    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      isAssignmentOperator(node.operatorToken.kind)
    ) {
      return handleAssignmentExpression(node, ctx, visitor)
    }

    // Handle increment/decrement: count++, count--, ++count, --count
    // Only handle ++ and -- operators, not ! or other prefix operators
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      isTrackedAndNotShadowed(node.operand.text, stateVars, memoVars, shadowedVars) &&
      isIncrementOrDecrement(node.operator)
    ) {
      return handleUnaryExpression(node, factory)
    }

    // Warn on deep property increments/decrements
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (ts.isPropertyAccessExpression(node.operand) || ts.isElementAccessExpression(node.operand)) &&
      isIncrementOrDecrement(node.operator)
    ) {
      return handlePropertyUnaryMutation(node, ctx, visitor)
    }

    if (ts.isElementAccessExpression(node)) {
      return handleElementAccess(node, ctx, visitor)
    }

    // Handle shorthand properties: { count } -> { count: count() }
    if (
      ts.isShorthandPropertyAssignment(node) &&
      isTrackedAndNotShadowed(node.name.text, stateVars, memoVars, shadowedVars)
    ) {
      return factory.createPropertyAssignment(node.name, createGetterCall(factory, node.name.text))
    }

    // Handle identifier references
    if (
      ts.isIdentifier(node) &&
      isTrackedAndNotShadowed(node.text, stateVars, memoVars, shadowedVars)
    ) {
      if (shouldTransformIdentifier(node)) {
        return createGetterCall(factory, node.text)
      }
    }

    // Default: recursively visit children
    return ts.visitEachChild(node, visitor, context)
  }

  return visitor
}

// ============================================================================
// Rule D: Control Flow Region Grouping
// ============================================================================

function transformBlock(node: ts.Block, ctx: TransformContext, opts: VisitorOptions): ts.Block {
  const statements = transformStatementList(node.statements, ctx, opts, false)
  return ctx.factory.updateBlock(node, statements as ts.NodeArray<ts.Statement>)
}

/**
 * Helper function to generate region memo and getter declarations
 * Extracted to avoid code duplication between fast path and fallback path
 */
interface RegionMemoResult {
  memoDecl: ts.VariableStatement
  getterDecls: ts.VariableStatement[]
  regionId: ts.Identifier
}

function generateRegionMemo(
  regionStatements: ts.Statement[],
  orderedOutputs: string[],
  ctx: TransformContext,
): RegionMemoResult {
  const { factory, memoVars } = ctx

  const returnStatement = factory.createReturnStatement(
    factory.createObjectLiteralExpression(
      orderedOutputs.map(name => factory.createShorthandPropertyAssignment(name)),
      false,
    ),
  )

  const memoArrow = factory.createArrowFunction(
    undefined,
    undefined,
    [],
    undefined,
    factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    factory.createBlock([...regionStatements, returnStatement], true),
  )

  ctx.helpersUsed.memo = true
  const regionId = factory.createUniqueName(`__fictRegion`)

  const memoDecl = factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [
        factory.createVariableDeclaration(
          regionId,
          undefined,
          undefined,
          factory.createCallExpression(factory.createIdentifier(RUNTIME_ALIASES.memo), undefined, [
            memoArrow,
          ]),
        ),
      ],
      ts.NodeFlags.Const,
    ),
  )

  const getterDecls = orderedOutputs.map(name =>
    factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        [
          factory.createVariableDeclaration(
            factory.createIdentifier(name),
            undefined,
            undefined,
            factory.createArrowFunction(
              undefined,
              undefined,
              [],
              undefined,
              factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
              factory.createPropertyAccessExpression(
                factory.createCallExpression(regionId, undefined, []),
                factory.createIdentifier(name),
              ),
            ),
          ),
        ],
        ts.NodeFlags.Const,
      ),
    ),
  )

  // Register outputs as memo vars
  orderedOutputs.forEach(out => memoVars.add(out))

  return { memoDecl, getterDecls, regionId }
}

function transformStatementList(
  statements: ts.NodeArray<ts.Statement>,
  ctx: TransformContext,
  opts: VisitorOptions,
  _isSourceFile: boolean,
): ts.NodeArray<ts.Statement> {
  const { factory } = ctx
  const derivedOutputs = collectDerivedOutputs(statements, ctx)
  const baseVisitor = createVisitorWithOptions(ctx, opts)
  let regionCreated = false

  // If fewer than 2 derived outputs exist in this block, fallback to default walking
  if (derivedOutputs.size < 2) {
    const visited = statements
      .map(stmt => ts.visitNode(stmt, baseVisitor))
      .filter((stmt): stmt is ts.Statement => stmt !== undefined)
    return factory.createNodeArray(visited)
  }

  if (!derivedOutputs.size) {
    const visited = statements
      .map(stmt => ts.visitNode(stmt, baseVisitor))
      .filter((stmt): stmt is ts.Statement => stmt !== undefined)
    return factory.createNodeArray(visited)
  }

  const result: ts.Statement[] = []
  let index = 0

  while (index < statements.length) {
    const region = findNextRegion(statements, derivedOutputs, ctx, index)

    if (region === null) {
      const visited = ts.visitNode(statements[index], baseVisitor) as ts.Statement | undefined
      if (visited) {
        result.push(visited)
      }
      index++
      continue
    }

    const { start, end, outputs } = region

    // Exclude trailing return statements from the region
    let regionEnd = end
    while (regionEnd >= start && ts.isReturnStatement(statements[regionEnd]!)) {
      regionEnd--
    }
    if (regionEnd < start) {
      index = end + 1
      continue
    }

    // Emit statements before the region untouched (visited)
    if (start > index) {
      for (let i = index; i < start; i++) {
        const visited = ts.visitNode(statements[i], baseVisitor) as ts.Statement
        if (visited) {
          result.push(visited)
        }
      }
    }

    // Safety: skip grouping if any output is reassigned after the region
    const startAfterRegion = regionEnd + 1
    const referencedOutside = collectReferencedOutputs(statements, outputs, startAfterRegion, ctx)
    const activeOutputs = referencedOutside.size ? referencedOutside : outputs

    const reassignedLater = hasAssignmentsOutside(statements, activeOutputs, startAfterRegion)
    if (reassignedLater || activeOutputs.size < 2) {
      for (let i = start; i <= end; i++) {
        const visited = ts.visitNode(statements[i], baseVisitor) as ts.Statement
        if (visited) {
          result.push(visited)
        }
      }
      index = end + 1
      continue
    }

    // Transform the region statements with memoization disabled (to avoid nested memos)
    const innerVisitor = createVisitorWithOptions(ctx, {
      disableRegionTransform: true,
      disableMemoize: true,
    })
    const regionStatements = statements.slice(start, regionEnd + 1).map(stmt => {
      return ts.visitNode(stmt, innerVisitor) as ts.Statement
    })

    let orderedOutputs = collectOutputsInOrder(regionStatements, activeOutputs)
    if (!orderedOutputs.length) {
      orderedOutputs = Array.from(activeOutputs)
    }

    // Use the extracted helper function to generate region memo
    const { memoDecl, getterDecls } = generateRegionMemo(regionStatements, orderedOutputs, ctx)

    result.push(memoDecl, ...getterDecls)
    regionCreated = true

    // Re-emit trailing statements (e.g., return) that were excluded from the region
    for (let i = regionEnd + 1; i <= end; i++) {
      const visited = ts.visitNode(statements[i], baseVisitor) as ts.Statement
      if (visited) {
        result.push(visited)
      }
    }
    index = end + 1
  }

  if (regionCreated || derivedOutputs.size < 2) {
    return factory.createNodeArray(result)
  }

  // Fallback: if no regions were formed but multiple derived outputs exist, group the first span
  const firstTouched = statements.findIndex(stmt =>
    statementTouchesOutputs(stmt, derivedOutputs, ctx),
  )
  const lastTouched = (() => {
    for (let i = statements.length - 1; i >= 0; i--) {
      if (statementTouchesOutputs(statements[i]!, derivedOutputs, ctx)) return i
    }
    return -1
  })()

  if (firstTouched === -1 || lastTouched === -1 || firstTouched > lastTouched) {
    return factory.createNodeArray(result)
  }

  let regionEnd = lastTouched
  while (regionEnd >= firstTouched && ts.isReturnStatement(statements[regionEnd]!)) {
    regionEnd--
  }
  if (regionEnd < firstTouched) {
    return factory.createNodeArray(result)
  }

  const startAfterRegion = regionEnd + 1
  const referencedOutside = collectReferencedOutputs(
    statements,
    derivedOutputs,
    startAfterRegion,
    ctx,
  )
  const activeOutputs = referencedOutside.size ? referencedOutside : derivedOutputs
  if (activeOutputs.size < 2) {
    return factory.createNodeArray(result)
  }

  const before: ts.Statement[] = []
  for (let i = 0; i < firstTouched; i++) {
    const visited = ts.visitNode(statements[i], baseVisitor) as ts.Statement
    if (visited) before.push(visited)
  }

  const innerVisitor = createVisitorWithOptions(ctx, {
    disableRegionTransform: true,
    disableMemoize: true,
  })
  const regionStatements = statements.slice(firstTouched, regionEnd + 1).map(stmt => {
    return ts.visitNode(stmt, innerVisitor) as ts.Statement
  })

  const orderedOutputs = collectOutputsInOrder(regionStatements, activeOutputs)
  if (!orderedOutputs.length) {
    return factory.createNodeArray(result)
  }

  const { memoDecl, getterDecls } = generateRegionMemo(regionStatements, orderedOutputs, ctx)

  const after: ts.Statement[] = []
  for (let i = regionEnd + 1; i < statements.length; i++) {
    const visited = ts.visitNode(statements[i], baseVisitor) as ts.Statement
    if (visited) after.push(visited)
  }

  return factory.createNodeArray<ts.Statement>([...before, memoDecl, ...getterDecls, ...after])
}

function collectReferencedOutputs(
  statements: ts.NodeArray<ts.Statement>,
  outputs: Set<string>,
  startIndex: number,
  ctx: TransformContext,
): Set<string> {
  const referenced = new Set<string>()
  const visit = (node: ts.Node, shadow: Set<string>): void => {
    if (ts.isFunctionLike(node)) return
    if (ts.isIdentifier(node) && outputs.has(node.text) && !shadow.has(node.text)) {
      referenced.add(node.text)
    }
    const nextShadow = new Set(shadow)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      nextShadow.add(node.name.text)
    }
    ts.forEachChild(node, child => visit(child, nextShadow))
  }

  for (let i = startIndex; i < statements.length; i++) {
    const stmt = statements[i]
    if (stmt) visit(stmt, new Set(ctx.shadowedVars))
  }
  return referenced
}

interface RegionCandidate {
  start: number
  end: number
  outputs: Set<string>
}

function findNextRegion(
  statements: ts.NodeArray<ts.Statement>,
  derivedOutputs: Set<string>,
  ctx: TransformContext,
  startIndex: number,
): RegionCandidate | null {
  let start = -1
  let end = -1
  const outputs = new Set<string>()

  for (let i = startIndex; i < statements.length; i++) {
    const stmt = statements[i]
    if (!stmt) continue
    const touched = statementTouchesOutputs(stmt, derivedOutputs, ctx)
    if (!touched) {
      if (start !== -1) break
      continue
    }

    if (start === -1) start = i
    end = i
    collectOutputsFromStatement(stmt, derivedOutputs, outputs, ctx)
    if (containsEarlyReturn(stmt)) {
      // Stop region detection if control flow escapes mid-block
      break
    }
  }

  if (start === -1 || outputs.size === 0) return null
  return { start, end, outputs }
}

function collectDerivedOutputs(
  statements: ts.NodeArray<ts.Statement>,
  ctx: TransformContext,
): Set<string> {
  const outputs = new Set<string>()
  const localStateVars = collectLocalStateVars(statements, ctx)
  let changed = true

  while (changed) {
    changed = false
    const tracked = new Set<string>([
      ...ctx.stateVars,
      ...ctx.memoVars,
      ...localStateVars,
      ...outputs,
    ])
    for (const stmt of statements) {
      if (collectOutputsFromStatement(stmt, tracked, outputs, ctx)) {
        changed = true
      }
    }
  }

  if (outputs.size < 2 && localStateVars.size) {
    for (const stmt of statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) &&
            decl.initializer &&
            !isStateCall(decl.initializer) &&
            referencesNames(decl.initializer, localStateVars, new Set(ctx.shadowedVars))
          ) {
            outputs.add(decl.name.text)
          }
        }
      }

      if (
        ts.isExpressionStatement(stmt) &&
        ts.isBinaryExpression(stmt.expression) &&
        ts.isIdentifier(stmt.expression.left) &&
        isAssignmentOperator(stmt.expression.operatorToken.kind) &&
        referencesNames(stmt.expression.right, localStateVars, new Set(ctx.shadowedVars))
      ) {
        outputs.add(stmt.expression.left.text)
      }
    }
  }

  return outputs
}

function collectLocalStateVars(
  statements: ts.NodeArray<ts.Statement>,
  ctx: TransformContext,
): Set<string> {
  const locals = new Set<string>()
  const { shadowedVars } = ctx

  const visit = (node: ts.Node, shadow: Set<string>): void => {
    if (ts.isFunctionLike(node)) return

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      !shadow.has(node.name.text) &&
      isStateCall(node.initializer)
    ) {
      locals.add(node.name.text)
    }

    const nextShadow = new Set(shadow)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      nextShadow.add(node.name.text)
    }
    ts.forEachChild(node, child => visit(child, nextShadow))
  }

  for (const stmt of statements) {
    visit(stmt, new Set(shadowedVars))
  }

  return locals
}

function referencesNames(expr: ts.Expression, names: Set<string>, shadow: Set<string>): boolean {
  let found = false
  const visit = (node: ts.Node, localShadow: Set<string>): void => {
    if (found) return
    if (ts.isFunctionLike(node)) return

    if (ts.isIdentifier(node) && names.has(node.text) && !localShadow.has(node.text)) {
      found = true
      return
    }

    const nextShadow = new Set(localShadow)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      nextShadow.add(node.name.text)
    }
    ts.forEachChild(node, child => visit(child, nextShadow))
  }
  visit(expr, shadow)
  return found
}

function collectOutputsFromStatement(
  stmt: ts.Statement,
  tracked: Set<string>,
  outputs: Set<string>,
  ctx: TransformContext,
): boolean {
  let changed = false

  // Track which variables are declared at the top level of this statement
  // Variables declared in nested blocks (if/switch) should not be outputs
  const topLevelDeclarations = new Set<string>()

  // First pass: collect top-level variable declarations
  if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) {
        topLevelDeclarations.add(decl.name.text)
        if (decl.initializer && isStateCall(decl.initializer)) {
          tracked.add(decl.name.text)
        }
      }
    }
  }

  const visit = (
    node: ts.Node,
    shadow: Set<string>,
    controlFlowTracked = false,
    isTopLevel = true,
  ): void => {
    if (ts.isFunctionLike(node)) return

    if (ts.isIfStatement(node)) {
      const condTracked = dependsOnTracked(
        node.expression as ts.Expression,
        ctx.stateVars,
        ctx.memoVars,
        shadow,
        tracked,
      )
      // Enter nested block - not top level anymore
      visit(node.thenStatement, shadow, controlFlowTracked || condTracked, false)
      if (node.elseStatement) {
        visit(node.elseStatement, shadow, controlFlowTracked || condTracked, false)
      }
      return
    }

    // Handle switch statements similarly to if statements
    if (ts.isSwitchStatement(node)) {
      const condTracked = dependsOnTracked(
        node.expression as ts.Expression,
        ctx.stateVars,
        ctx.memoVars,
        shadow,
        tracked,
      )
      // Visit all case clauses - not top level
      for (const caseClause of node.caseBlock.clauses) {
        ts.forEachChild(caseClause, child =>
          visit(child, shadow, controlFlowTracked || condTracked, false),
        )
      }
      return
    }

    // Handle block statements (entering nested scope)
    if (ts.isBlock(node)) {
      ts.forEachChild(node, child => visit(child, shadow, controlFlowTracked, false))
      return
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const nextShadow = new Set(shadow)
      nextShadow.add(node.name.text)
      const isFunctionInitializer =
        ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)
      if (!isFunctionInitializer) {
        // Only add to outputs if:
        // 1. It's declared at top level of the statement, OR
        // 2. It's a variable declared earlier (top-level declarations are already tracked)
        const isTopLevelDecl = topLevelDeclarations.has(node.name.text)
        if (isTopLevel || isTopLevelDecl) {
          if (
            !isStateCall(node.initializer) &&
            dependsOnTracked(node.initializer, ctx.stateVars, ctx.memoVars, nextShadow, tracked)
          ) {
            if (!outputs.has(node.name.text)) {
              outputs.add(node.name.text)
              changed = true
            }
          }
        }
      }
      ts.forEachChild(node, child => visit(child, nextShadow, controlFlowTracked, false))
      return
    }

    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      isAssignmentOperator(node.operatorToken.kind)
    ) {
      const target = node.left.text
      if (!shadow.has(target)) {
        if (
          controlFlowTracked ||
          dependsOnTracked(
            node.right as ts.Expression,
            ctx.stateVars,
            ctx.memoVars,
            shadow,
            tracked,
          )
        ) {
          if (!outputs.has(target)) {
            outputs.add(target)
            changed = true
          }
        }
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const nextShadow = new Set(shadow)
      nextShadow.add(node.name.text)
      ts.forEachChild(node, child => visit(child, nextShadow, controlFlowTracked, false))
      return
    }

    ts.forEachChild(node, child => visit(child, shadow, controlFlowTracked, isTopLevel))
  }

  visit(stmt, new Set(ctx.shadowedVars), false, true)
  return changed
}

function statementTouchesOutputs(
  stmt: ts.Statement,
  outputs: Set<string>,
  ctx: TransformContext,
): boolean {
  let touches = false

  const visit = (node: ts.Node, shadow: Set<string>): void => {
    if (touches) return
    if (ts.isFunctionLike(node)) return

    if (ts.isIdentifier(node) && outputs.has(node.text) && !shadow.has(node.text)) {
      touches = true
      return
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      outputs.has(node.name.text)
    ) {
      touches = true
      return
    }

    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      outputs.has(node.left.text) &&
      isAssignmentOperator(node.operatorToken.kind)
    ) {
      touches = true
      return
    }

    const nextShadow = new Set(shadow)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      nextShadow.add(node.name.text)
    }
    ts.forEachChild(node, child => visit(child, nextShadow))
  }

  visit(stmt, new Set(ctx.shadowedVars))
  return touches
}

function collectOutputsInOrder(statements: ts.Statement[], outputs: Set<string>): string[] {
  const order: string[] = []
  const seen = new Set<string>()

  const visit = (node: ts.Node, shadow: Set<string>): void => {
    if (ts.isFunctionLike(node)) return

    if (ts.isIdentifier(node) && outputs.has(node.text) && !shadow.has(node.text)) {
      if (!seen.has(node.text)) {
        seen.add(node.text)
        order.push(node.text)
      }
    }

    const nextShadow = new Set(shadow)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      nextShadow.add(node.name.text)
    }
    ts.forEachChild(node, child => visit(child, nextShadow))
  }

  for (const stmt of statements) {
    visit(stmt, new Set())
  }

  return order
}

function hasAssignmentsOutside(
  statements: ts.NodeArray<ts.Statement>,
  outputs: Set<string>,
  startIndex: number,
): boolean {
  for (let i = startIndex; i < statements.length; i++) {
    const stmt = statements[i]
    if (stmt && statementAssignsOutputs(stmt, outputs)) {
      return true
    }
  }
  return false
}

function statementAssignsOutputs(stmt: ts.Statement, outputs: Set<string>): boolean {
  let assigns = false
  const visit = (node: ts.Node, shadow: Set<string>): void => {
    if (assigns) return
    if (ts.isFunctionLike(node)) return

    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      isAssignmentOperator(node.operatorToken.kind) &&
      outputs.has(node.left.text) &&
      !shadow.has(node.left.text)
    ) {
      assigns = true
      return
    }

    const nextShadow = new Set(shadow)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      nextShadow.add(node.name.text)
    }
    ts.forEachChild(node, child => visit(child, nextShadow))
  }

  visit(stmt, new Set())
  return assigns
}

function containsEarlyReturn(stmt: ts.Statement): boolean {
  let hasReturn = false
  const visit = (node: ts.Node): void => {
    if (hasReturn) return
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
      hasReturn = true
      return
    }
    if (ts.isFunctionLike(node)) return
    ts.forEachChild(node, visit)
  }
  visit(stmt)
  return hasReturn
}

// ============================================================================
// Function Shadowing Handling
// ============================================================================

function handleFunctionWithShadowing(
  node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
  ctx: TransformContext,
  opts: VisitorOptions,
): ts.Node {
  const { stateVars, memoVars, shadowedVars, factory, context } = ctx

  // Collect parameter names that shadow tracked variables
  const paramNames = collectParameterNames(node.parameters)
  const newShadowed = new Set(shadowedVars)

  for (const name of paramNames) {
    if (stateVars.has(name) || memoVars.has(name)) {
      newShadowed.add(name)
    }
  }

  const functionMemoVars = new Set(memoVars)

  // Use a provisional context to build destructuring plan
  const provisionalCtx: TransformContext = {
    ...ctx,
    shadowedVars: newShadowed,
    memoVars: functionMemoVars,
  }

  const provisionalVisitor = createVisitorWithOptions(provisionalCtx, opts)
  const enablePropTracking = functionContainsJsx(node)
  const destructPlan = enablePropTracking
    ? buildPropsDestructurePlan(node, provisionalCtx, provisionalVisitor)
    : null
  if (destructPlan) {
    destructPlan.trackedNames.forEach(name => functionMemoVars.add(name))
  }

  // Remove destructured prop names from shadowing so their getters are callable
  const activeShadowed = new Set(newShadowed)
  if (destructPlan) {
    destructPlan.trackedNames.forEach(name => activeShadowed.delete(name))
  }

  // Create final context with updated shadowed vars
  const newCtx: TransformContext = {
    ...ctx,
    shadowedVars: activeShadowed,
    memoVars: functionMemoVars,
  }

  const innerVisitor = createVisitorWithOptions(newCtx, opts)
  const updatedParams =
    destructPlan?.parameters ??
    ts.factory.createNodeArray(
      node.parameters.map(param => ts.visitEachChild(param, innerVisitor, context)),
    )

  const updatedBody = transformFunctionBody(node.body, destructPlan, innerVisitor, factory)

  // Create inner visitor with new context
  if (ts.isArrowFunction(node)) {
    return factory.updateArrowFunction(
      node,
      node.modifiers,
      node.typeParameters,
      updatedParams,
      node.type,
      node.equalsGreaterThanToken,
      updatedBody ?? node.body,
    )
  }

  if (ts.isFunctionExpression(node)) {
    const ensuredBody = (updatedBody as ts.Block | undefined) ?? (node.body as ts.Block)
    return factory.updateFunctionExpression(
      node,
      node.modifiers,
      node.asteriskToken,
      node.name,
      node.typeParameters,
      updatedParams,
      node.type,
      ensuredBody,
    )
  }

  const ensuredBody = (updatedBody as ts.Block | undefined) ?? (node.body as ts.Block)
  return factory.updateFunctionDeclaration(
    node,
    node.modifiers,
    node.asteriskToken,
    node.name,
    node.typeParameters,
    updatedParams,
    node.type,
    ensuredBody,
  )
}

// ============================================================================
// Props Destructuring Handling (Rule E)
// ============================================================================

interface PropsDestructurePlan {
  parameters: ts.NodeArray<ts.ParameterDeclaration>
  prologue: ts.Statement[]
  trackedNames: string[]
}

function buildPropsDestructurePlan(
  node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
  ctx: TransformContext,
  visitor: ts.Visitor,
): PropsDestructurePlan | null {
  const parameters: ts.ParameterDeclaration[] = []
  const prologue: ts.Statement[] = []
  const trackedNames: string[] = []
  let changed = false

  for (const param of node.parameters) {
    if (ts.isObjectBindingPattern(param.name) || ts.isArrayBindingPattern(param.name)) {
      changed = true
      const alias = ctx.factory.createUniqueName('__props')
      const updatedParam = ctx.factory.updateParameterDeclaration(
        param,
        param.modifiers,
        param.dotDotDotToken,
        alias,
        param.questionToken,
        param.type,
        param.initializer ? (ts.visitNode(param.initializer, visitor) as ts.Expression) : undefined,
      )
      parameters.push(updatedParam)

      const { statements, names } = createPropGetterDeclarations(param.name, alias, ctx, visitor)
      statements.forEach(stmt => prologue.push(stmt))
      names.forEach(name => trackedNames.push(name))
    } else {
      parameters.push(ts.visitEachChild(param, visitor, ctx.context))
    }
  }

  if (!changed) return null
  return {
    parameters: ctx.factory.createNodeArray(parameters),
    prologue,
    trackedNames,
  }
}

function createPropGetterDeclarations(
  binding: ts.BindingName,
  base: ts.Expression,
  ctx: TransformContext,
  visitor: ts.Visitor,
): { statements: ts.Statement[]; names: string[] } {
  const statements: ts.Statement[] = []
  const names: string[] = []
  const { factory } = ctx

  const combineWithDefault = (
    accessExpr: ts.Expression,
    initializer: ts.Expression,
  ): ts.Expression => {
    const visitedInit = ts.visitNode(initializer, visitor) as ts.Expression
    return factory.createConditionalExpression(
      factory.createBinaryExpression(
        accessExpr,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        factory.createIdentifier('undefined'),
      ),
      undefined,
      visitedInit,
      undefined,
      accessExpr,
    )
  }

  const emitGetter = (
    id: ts.Identifier,
    accessExpr: ts.Expression,
    initializer?: ts.Expression,
  ) => {
    const tmp = factory.createUniqueName('__fictProp')
    const visitedInitializer = initializer
      ? (ts.visitNode(initializer, visitor) as ts.Expression)
      : undefined

    const returnExpr = visitedInitializer
      ? factory.createConditionalExpression(
          factory.createBinaryExpression(
            tmp,
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            factory.createIdentifier('undefined'),
          ),
          undefined,
          visitedInitializer,
          undefined,
          tmp,
        )
      : tmp

    const getter = factory.createArrowFunction(
      undefined,
      undefined,
      [],
      undefined,
      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      factory.createBlock(
        [
          factory.createVariableStatement(
            undefined,
            factory.createVariableDeclarationList(
              [factory.createVariableDeclaration(tmp, undefined, undefined, accessExpr)],
              ts.NodeFlags.Const,
            ),
          ),
          factory.createReturnStatement(returnExpr),
        ],
        true,
      ),
    )

    statements.push(
      factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [factory.createVariableDeclaration(id, undefined, undefined, getter)],
          ts.NodeFlags.Const,
        ),
      ),
    )
    names.push(id.text)
  }

  const visitBinding = (name: ts.BindingName, currentBase: ts.Expression): void => {
    if (ts.isIdentifier(name)) {
      emitGetter(name, currentBase)
      return
    }

    if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        if (!ts.isBindingElement(element)) continue
        const propertyName = element.propertyName

        if (ts.isOmittedExpression(element.name)) continue
        if (element.dotDotDotToken) {
          emitWarning(
            ctx,
            element,
            'FICT-E',
            'Object rest in props destructuring falls back to non-reactive binding.',
          )
          const destructuring = factory.createVariableStatement(
            undefined,
            factory.createVariableDeclarationList(
              [
                factory.createVariableDeclaration(
                  factory.createObjectBindingPattern([element]),
                  undefined,
                  undefined,
                  currentBase,
                ),
              ],
              ts.NodeFlags.Const,
            ),
          )
          statements.push(destructuring)
          continue
        }

        const safePropertyName =
          propertyName &&
          ts.isPropertyName(propertyName) &&
          !ts.isComputedPropertyName(propertyName)
            ? propertyName
            : ts.isIdentifier(element.name) || ts.isStringLiteral(element.name)
              ? element.name
              : null
        if (!safePropertyName) continue

        let accessExpr = createPropertyAccessFromName(factory, currentBase, safePropertyName)
        if (element.initializer) {
          accessExpr = combineWithDefault(accessExpr, element.initializer)
        }

        if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
          visitBinding(element.name, accessExpr)
        } else if (ts.isIdentifier(element.name)) {
          emitGetter(element.name, accessExpr, element.initializer)
        }
      }
      return
    }

    if (ts.isArrayBindingPattern(name)) {
      name.elements.forEach((element, index) => {
        if (ts.isOmittedExpression(element)) return
        if (!ts.isBindingElement(element)) return
        let accessExpr: ts.Expression = factory.createElementAccessExpression(
          currentBase,
          factory.createNumericLiteral(index),
        )
        if (element.initializer) {
          accessExpr = combineWithDefault(accessExpr, element.initializer)
        }
        if (element.dotDotDotToken) {
          emitWarning(
            ctx,
            element,
            'FICT-E',
            'Array rest in props destructuring falls back to non-reactive binding.',
          )
          const destructuring = factory.createVariableStatement(
            undefined,
            factory.createVariableDeclarationList(
              [
                factory.createVariableDeclaration(
                  factory.createArrayBindingPattern([element]),
                  undefined,
                  undefined,
                  currentBase,
                ),
              ],
              ts.NodeFlags.Const,
            ),
          )
          statements.push(destructuring)
          return
        }

        if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
          visitBinding(element.name, accessExpr)
        } else if (ts.isIdentifier(element.name)) {
          emitGetter(element.name, accessExpr, element.initializer)
        }
      })
    }
  }

  visitBinding(binding, base)
  return { statements, names }
}

function createPropertyAccessFromName(
  factory: ts.NodeFactory,
  base: ts.Expression,
  name: ts.PropertyName,
): ts.Expression {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return factory.createPropertyAccessExpression(base, name)
  }
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return factory.createElementAccessExpression(base, name)
  }
  if (ts.isComputedPropertyName(name)) {
    return factory.createElementAccessExpression(base, name.expression)
  }
  return factory.createElementAccessExpression(base, name as ts.Expression)
}

function transformFunctionBody(
  body: ts.ConciseBody | undefined,
  plan: PropsDestructurePlan | null,
  visitor: ts.Visitor,
  factory: ts.NodeFactory,
): ts.ConciseBody | undefined {
  const visitedBody = body ? (ts.visitNode(body, visitor) as ts.ConciseBody) : body
  if (!plan || !plan.prologue.length) return visitedBody

  const visitedPrologue = plan.prologue.map(stmt => ts.visitNode(stmt, visitor) as ts.Statement)

  if (visitedBody && ts.isBlock(visitedBody)) {
    return factory.updateBlock(
      visitedBody,
      factory.createNodeArray([...visitedPrologue, ...visitedBody.statements]),
    )
  }

  const returnStmt = visitedBody
    ? factory.createReturnStatement(visitedBody as ts.Expression)
    : factory.createReturnStatement()

  return factory.createBlock([...visitedPrologue, returnStmt], true)
}

function functionContainsJsx(
  node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
): boolean {
  let found = false
  const visit = (child: ts.Node): void => {
    if (found) return
    if (
      ts.isJsxElement(child) ||
      ts.isJsxSelfClosingElement(child) ||
      ts.isJsxFragment(child) ||
      ts.isJsxOpeningElement(child) ||
      ts.isJsxOpeningFragment(child)
    ) {
      found = true
      return
    }
    ts.forEachChild(child, visit)
  }

  if (node.body) visit(node.body)
  return found
}

/**
 * Collect all parameter names from a parameter list
 */
function collectParameterNames(parameters: ts.NodeArray<ts.ParameterDeclaration>): Set<string> {
  const names = new Set<string>()

  for (const param of parameters) {
    collectBindingNames(param.name, names)
  }

  return names
}

/**
 * Collect names from a binding pattern (handles destructuring)
 */
function collectBindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text)
  } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        collectBindingNames(element.name, names)
      }
    }
  }
}

// ============================================================================
// Variable Declaration Handling
// ============================================================================

function handleVariableDeclaration(
  node: ts.VariableDeclaration,
  ctx: TransformContext,
  visitor: ts.Visitor,
  opts: VisitorOptions,
): ts.VariableDeclaration {
  const { stateVars, memoVars, shadowedVars, helpersUsed, factory, context } = ctx

  if (!ts.isIdentifier(node.name) || !node.initializer) {
    if (node.initializer && isStateCall(node.initializer)) {
      throw new Error(formatError(ctx.sourceFile, node, '$state() must assign to an identifier'))
    }
    return ts.visitEachChild(node, visitor, context) as ts.VariableDeclaration
  }

  const visitedInit = ts.visitNode(node.initializer, visitor) as ts.Expression

  // Handle $state declarations
  if (isStateCall(visitedInit)) {
    if (!ctx.hasStateImport) {
      throw new Error(
        formatError(ctx.sourceFile, node, '$state() must be imported from "fict" before use'),
      )
    }
    ensureValidStatePlacement(node, ctx)
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

  // Handle derived values (const declarations that depend on state/memo)
  if (
    shouldMemoize(node, stateVars) &&
    dependsOnTracked(
      node.initializer,
      stateVars,
      memoVars,
      shadowedVars,
      opts.disableMemoize ? new Set(ctx.dependencyGraph.keys()) : undefined,
    )
  ) {
    recordDerivedDependencies(node.name.text, node.initializer, ctx)
    if (opts.disableMemoize) {
      return factory.updateVariableDeclaration(
        node,
        node.name,
        node.exclamationToken,
        node.type,
        visitedInit,
      )
    }

    memoVars.add(node.name.text)

    const isModuleScope = isTopLevelDeclaration(node)
    const isExported = isExportedDeclaration(node, ctx)
    const useGetterOnly = !isModuleScope && !isExported && shouldEmitGetter(node.name.text, ctx)
    if (!useGetterOnly) {
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

    const getter = factory.createArrowFunction(
      undefined,
      undefined,
      [],
      undefined,
      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      visitedInit,
    )

    return factory.updateVariableDeclaration(
      node,
      node.name,
      node.exclamationToken,
      node.type,
      getter,
    )
  }

  // Default: just update with visited initializer
  return factory.updateVariableDeclaration(
    node,
    node.name,
    node.exclamationToken,
    node.type,
    visitedInit,
  )
}

// ============================================================================
// JSX Expression Handling (Core of reactive DOM binding)
// ============================================================================

function handleJsxExpression(
  node: ts.JsxExpression,
  ctx: TransformContext,
  visitor: ts.Visitor,
): ts.JsxExpression {
  const { stateVars, memoVars, shadowedVars, factory } = ctx
  const expr = node.expression

  if (!expr) {
    return node
  }

  // Check if we're inside a JSX attribute
  const parent = node.parent
  const isInAttribute = ts.isJsxAttribute(parent)

  // Determine if this expression should be wrapped
  let shouldWrap = false

  if (isInAttribute && ts.isJsxAttribute(parent)) {
    const attrName = parent.name.getText()
    // Don't wrap event handlers, key, or ref
    if (isEventHandler(attrName) || NON_REACTIVE_ATTRS.has(attrName)) {
      shouldWrap = false
    } else {
      // Wrap if the expression depends on reactive values
      shouldWrap = dependsOnTracked(expr, stateVars, memoVars, shadowedVars)
    }
  } else {
    // JSX child expression - wrap if depends on reactive values
    // But don't wrap if it's already a function
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
      shouldWrap = false
    } else {
      shouldWrap = dependsOnTracked(expr, stateVars, memoVars, shadowedVars)
    }
  }

  // First, recursively transform the expression (converts identifiers to getter calls)
  const transformedExpr = ts.visitNode(expr, visitor) as ts.Expression

  // Attribute bindings keep the existing reactive wrapper behavior
  if (isInAttribute) {
    if (shouldWrap) {
      const wrappedExpr = factory.createArrowFunction(
        undefined,
        undefined,
        [],
        undefined,
        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        transformedExpr,
      )
      return factory.updateJsxExpression(node, wrappedExpr)
    }

    if (transformedExpr !== expr) {
      return factory.updateJsxExpression(node, transformedExpr)
    }

    return node
  }

  // Child expressions lower to binding helpers when reactive
  if (shouldWrap) {
    const lowered =
      createConditionalBinding(transformedExpr, ctx) ??
      createListBinding(transformedExpr, ctx) ??
      createInsertBinding(transformedExpr, ctx)

    return factory.updateJsxExpression(node, lowered)
  }

  if (transformedExpr !== expr) {
    return factory.updateJsxExpression(node, transformedExpr)
  }

  return node
}

function createConditionalBinding(
  expr: ts.Expression,
  ctx: TransformContext,
): ts.Expression | null {
  const { factory, helpersUsed } = ctx

  let condition: ts.Expression | null = null
  let whenTrue: ts.Expression | null = null
  let whenFalse: ts.Expression | null = null

  if (ts.isConditionalExpression(expr)) {
    condition = expr.condition
    whenTrue = expr.whenTrue
    whenFalse = expr.whenFalse
  } else if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    condition = expr.left
    whenTrue = expr.right
  }

  if (!condition || !whenTrue) return null

  helpersUsed.createElement = true
  helpersUsed.conditional = true

  const args: ts.Expression[] = [
    factory.createArrowFunction(
      undefined,
      undefined,
      [],
      undefined,
      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      condition,
    ),
    factory.createArrowFunction(
      undefined,
      undefined,
      [],
      undefined,
      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      whenTrue,
    ),
    factory.createIdentifier(RUNTIME_ALIASES.createElement),
  ]

  if (whenFalse) {
    args.push(
      factory.createArrowFunction(
        undefined,
        undefined,
        [],
        undefined,
        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        whenFalse,
      ),
    )
  }

  const handleExpr = factory.createCallExpression(
    factory.createIdentifier(RUNTIME_ALIASES.conditional),
    undefined,
    args,
  )

  return wrapBindingHandle(handleExpr, ctx)
}

function createListBinding(expr: ts.Expression, ctx: TransformContext): ts.Expression | null {
  const { factory, helpersUsed } = ctx

  if (
    !ts.isCallExpression(expr) ||
    !ts.isPropertyAccessExpression(expr.expression) ||
    expr.expression.name.text !== 'map'
  ) {
    return null
  }

  const callback = expr.arguments[0]
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return null
  }

  const listExpr = expr.expression.expression

  helpersUsed.createElement = true
  helpersUsed.list = true

  const renderArrow = callback as ts.ArrowFunction | ts.FunctionExpression

  const listCall = factory.createCallExpression(
    factory.createIdentifier(RUNTIME_ALIASES.list),
    undefined,
    [
      factory.createArrowFunction(
        undefined,
        undefined,
        [],
        undefined,
        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        listExpr,
      ),
      renderArrow,
      factory.createIdentifier(RUNTIME_ALIASES.createElement),
    ],
  )

  return wrapBindingHandle(listCall, ctx)
}

function createInsertBinding(expr: ts.Expression, ctx: TransformContext): ts.Expression {
  const { factory, helpersUsed } = ctx

  helpersUsed.insert = true
  helpersUsed.createElement = true
  helpersUsed.onDestroy = true

  const fragId = factory.createUniqueName('__fictFrag')
  const disposeId = factory.createUniqueName('__fictDispose')

  const createFrag = factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [
        factory.createVariableDeclaration(
          fragId,
          undefined,
          undefined,
          factory.createCallExpression(
            factory.createPropertyAccessExpression(
              factory.createIdentifier('document'),
              factory.createIdentifier('createDocumentFragment'),
            ),
            undefined,
            [],
          ),
        ),
      ],
      ts.NodeFlags.Const,
    ),
  )

  const disposeStmt = factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [
        factory.createVariableDeclaration(
          disposeId,
          undefined,
          undefined,
          factory.createCallExpression(
            factory.createIdentifier(RUNTIME_ALIASES.insert),
            undefined,
            [
              fragId,
              factory.createArrowFunction(
                undefined,
                undefined,
                [],
                undefined,
                factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                expr,
              ),
              factory.createIdentifier(RUNTIME_ALIASES.createElement),
            ],
          ),
        ),
      ],
      ts.NodeFlags.Const,
    ),
  )

  const onDestroyCall = factory.createExpressionStatement(
    factory.createCallExpression(factory.createIdentifier(RUNTIME_ALIASES.onDestroy), undefined, [
      disposeId,
    ]),
  )

  const returnFrag = factory.createReturnStatement(fragId)

  const block = factory.createBlock([createFrag, disposeStmt, onDestroyCall, returnFrag], true)

  return factory.createParenthesizedExpression(
    factory.createCallExpression(
      factory.createArrowFunction(
        undefined,
        undefined,
        [],
        undefined,
        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        block,
      ),
      undefined,
      [],
    ),
  )
}

function wrapBindingHandle(handleExpr: ts.Expression, ctx: TransformContext): ts.Expression {
  const { factory, helpersUsed } = ctx
  helpersUsed.onDestroy = true

  const handleId = factory.createUniqueName('__fictBinding')

  const handleDecl = factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [factory.createVariableDeclaration(handleId, undefined, undefined, handleExpr)],
      ts.NodeFlags.Const,
    ),
  )

  const registerDispose = factory.createExpressionStatement(
    factory.createCallExpression(factory.createIdentifier(RUNTIME_ALIASES.onDestroy), undefined, [
      factory.createPropertyAccessExpression(handleId, factory.createIdentifier('dispose')),
    ]),
  )

  const returnMarker = factory.createReturnStatement(
    factory.createPropertyAccessExpression(handleId, factory.createIdentifier('marker')),
  )

  const block = factory.createBlock([handleDecl, registerDispose, returnMarker], true)

  return factory.createParenthesizedExpression(
    factory.createCallExpression(
      factory.createArrowFunction(
        undefined,
        undefined,
        [],
        undefined,
        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        block,
      ),
      undefined,
      [],
    ),
  )
}

// ============================================================================
// Assignment and Unary Expression Handling
// ============================================================================

function handlePropertyMutation(
  node: ts.BinaryExpression,
  ctx: TransformContext,
  visitor: ts.Visitor,
): ts.Expression {
  const { factory, stateVars } = ctx
  const root = getRootIdentifier(node.left)
  if (root && stateVars.has(root.text)) {
    emitWarning(
      ctx,
      node,
      'FICT-M',
      'Direct mutation of nested property will not trigger updates; use an immutable update or $store().',
    )
  }

  if (
    ts.isElementAccessExpression(node.left) &&
    isDynamicElementAccess(node.left) &&
    isTrackedRoot(node.left.expression, ctx)
  ) {
    emitWarning(ctx, node, 'FICT-H', 'Dynamic property access widens dependency tracking scope.')
  }

  const updatedLeft = ts.visitNode(node.left, visitor) as ts.Expression
  const updatedRight = ts.visitNode(node.right, visitor) as ts.Expression
  return factory.updateBinaryExpression(node, updatedLeft, node.operatorToken, updatedRight)
}

function handlePropertyUnaryMutation(
  node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
  ctx: TransformContext,
  visitor: ts.Visitor,
): ts.Expression {
  const { factory, stateVars } = ctx
  const root = getRootIdentifier(node.operand)
  if (root && stateVars.has(root.text)) {
    emitWarning(
      ctx,
      node,
      'FICT-M',
      'Direct mutation of nested property will not trigger updates; use an immutable update or $store().',
    )
  }
  const updatedOperand = ts.visitNode(node.operand, visitor) as ts.Expression
  return ts.isPrefixUnaryExpression(node)
    ? factory.updatePrefixUnaryExpression(node, updatedOperand)
    : factory.updatePostfixUnaryExpression(node as ts.PostfixUnaryExpression, updatedOperand)
}

function handleElementAccess(
  node: ts.ElementAccessExpression,
  ctx: TransformContext,
  visitor: ts.Visitor,
): ts.ElementAccessExpression {
  const parent = node.parent
  const isWriteContext =
    !!parent &&
    ((ts.isBinaryExpression(parent) &&
      parent.left === node &&
      isAssignmentOperator(parent.operatorToken.kind)) ||
      ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
        parent.operand === node &&
        isIncrementOrDecrement(parent.operator)))

  if (!isWriteContext && isDynamicElementAccess(node) && isTrackedRoot(node.expression, ctx)) {
    emitWarning(ctx, node, 'FICT-H', 'Dynamic property access widens dependency tracking scope.')
  }

  const updatedExpression = ts.visitNode(node.expression, visitor) as ts.LeftHandSideExpression
  if (!node.argumentExpression) {
    return ctx.factory.createElementAccessExpression(
      updatedExpression,
      ctx.factory.createIdentifier('undefined'),
    )
  }
  const updatedArgument = ts.visitNode(node.argumentExpression, visitor) as ts.Expression
  return ctx.factory.updateElementAccessExpression(node, updatedExpression, updatedArgument)
}

function handleAssignmentExpression(
  node: ts.BinaryExpression,
  ctx: TransformContext,
  visitor: ts.Visitor,
): ts.Expression {
  const { stateVars, memoVars, shadowedVars, factory } = ctx
  const name = (node.left as ts.Identifier).text

  if (!isTrackedAndNotShadowed(name, stateVars, memoVars, shadowedVars) || !stateVars.has(name)) {
    // Not a state variable or is shadowed - just visit children
    const right = ts.visitNode(node.right, visitor) as ts.Expression
    return factory.updateBinaryExpression(node, node.left, node.operatorToken, right)
  }

  const right = ts.visitNode(node.right, visitor) as ts.Expression
  const setter = factory.createIdentifier(name)
  const getterCall = createGetterCall(factory, name)

  // Simple assignment: count = value
  if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return factory.createCallExpression(setter, undefined, [right])
  }

  // Compound assignment: count += value, count -= value, etc.
  const op = toBinaryOperator(node.operatorToken.kind)
  if (op) {
    return factory.createCallExpression(setter, undefined, [
      factory.createBinaryExpression(getterCall, op, right),
    ])
  }

  // Fallback
  return factory.createCallExpression(setter, undefined, [right])
}

function handleUnaryExpression(
  node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
  factory: ts.NodeFactory,
): ts.Expression {
  const name = (node.operand as ts.Identifier).text
  const setter = factory.createIdentifier(name)
  const getterCall = createGetterCall(factory, name)

  const isIncrement = node.operator === ts.SyntaxKind.PlusPlusToken
  const delta = factory.createNumericLiteral(1)
  const op = isIncrement ? ts.SyntaxKind.PlusToken : ts.SyntaxKind.MinusToken

  return factory.createCallExpression(setter, undefined, [
    factory.createBinaryExpression(getterCall, op, delta),
  ])
}

// ============================================================================
// Helper Functions
// ============================================================================

function analyzeMacroImports(sourceFile: ts.SourceFile): {
  hasStateImport: boolean
  hasEffectImport: boolean
} {
  let hasStateImport = false
  let hasEffectImport = false

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.moduleSpecifier.text === 'fict') {
        const clause = node.importClause
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            const imported = element.propertyName ? element.propertyName.text : element.name.text
            if (imported === '$state') hasStateImport = true
            if (imported === '$effect') hasEffectImport = true
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return { hasStateImport, hasEffectImport }
}

function collectExportedNames(sourceFile: ts.SourceFile): Set<string> {
  const exported = new Set<string>()
  for (const stmt of sourceFile.statements) {
    if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause) {
      if (ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          const localName = el.propertyName ? el.propertyName.text : el.name.text
          exported.add(localName)
        }
      }
    }

    if (ts.isExportAssignment(stmt) && ts.isIdentifier(stmt.expression)) {
      exported.add(stmt.expression.text)
    }
  }
  return exported
}

function emitWarning(ctx: TransformContext, node: ts.Node, code: string, message: string): void {
  const { line, character } = ctx.sourceFile.getLineAndCharacterOfPosition(node.getStart())
  const warning: CompilerWarning = {
    code,
    message,
    fileName: ctx.sourceFile.fileName,
    line: line + 1,
    column: character + 1,
  }

  if (ctx.options.onWarn) {
    ctx.options.onWarn(warning)
  } else {
    console.warn(
      `[${warning.code}] ${warning.fileName}:${warning.line}:${warning.column} ${message}`,
    )
  }
}

/**
 * Collect all $state variable declarations in the source file
 */
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

/**
 * Check if a node is a $state() call
 */
function isStateCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === '$state'
  )
}

/**
 * Check if an expression depends on any tracked (state or memo) variables
 * that are not currently shadowed
 */
function dependsOnTracked(
  expr: ts.Expression,
  stateVars: Set<string>,
  memoVars: Set<string>,
  shadowedVars: Set<string>,
  additionalTracked?: Set<string>,
): boolean {
  let depends = false
  const visit = (node: ts.Node, locals: Set<string>): void => {
    if (depends) return

    if (ts.isIdentifier(node)) {
      const name = node.text
      if (!locals.has(name)) {
        const tracked = isTracked(name, stateVars, memoVars, additionalTracked)
        const parent = node.parent
        const shorthandUse =
          !!parent && ts.isShorthandPropertyAssignment(parent) && parent.name === node
        if (tracked && (shouldTransformIdentifier(node) || shorthandUse)) {
          depends = true
          return
        }
      }
    }

    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node)
    ) {
      const next = new Set(locals)
      const paramNames = collectParameterNames(node.parameters)
      for (const name of paramNames) {
        next.add(name)
      }
      ts.forEachChild(node, child => visit(child, next))
      return
    }

    ts.forEachChild(node, child => visit(child, locals))
  }
  visit(expr, new Set(shadowedVars))
  return depends
}

function collectIdentifierDependencies(
  expr: ts.Expression,
  shadowedVars: Set<string>,
): Set<string> {
  const deps = new Set<string>()
  const visit = (node: ts.Node, locals: Set<string>): void => {
    if (ts.isFunctionLike(node)) return

    if (ts.isIdentifier(node) && !locals.has(node.text) && shouldTransformIdentifier(node)) {
      deps.add(node.text)
    }

    const next = new Set(locals)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      next.add(node.name.text)
    }

    ts.forEachChild(node, child => visit(child, next))
  }

  visit(expr, new Set(shadowedVars))
  return deps
}

function recordDerivedDependencies(name: string, expr: ts.Expression, ctx: TransformContext): void {
  if (!ctx.dependencyGraph.has(name)) {
    ctx.dependencyGraph.set(name, new Set())
  }
  const deps = collectIdentifierDependencies(expr, ctx.shadowedVars)
  ctx.dependencyGraph.get(name)!.forEach(existing => deps.add(existing))
  ctx.dependencyGraph.set(name, deps)
  ctx.derivedDecls.set(name, expr)
}

/**
 * Check if a variable name is tracked (either state or memo)
 */
function isTracked(
  name: string,
  stateVars: Set<string>,
  memoVars: Set<string>,
  additionalTracked?: Set<string>,
): boolean {
  return (
    stateVars.has(name) ||
    memoVars.has(name) ||
    (!!additionalTracked && additionalTracked.has(name))
  )
}

/**
 * Check if a variable is tracked and not currently shadowed
 */
function isTrackedAndNotShadowed(
  name: string,
  stateVars: Set<string>,
  memoVars: Set<string>,
  shadowedVars: Set<string>,
): boolean {
  return (stateVars.has(name) || memoVars.has(name)) && !shadowedVars.has(name)
}

/**
 * Detect whether a node is inside a loop statement
 */
function isInsideLoop(node: ts.Node): boolean {
  let current: ts.Node | undefined = node
  while (current) {
    if (
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current)
    ) {
      return true
    }
    if (ts.isSourceFile(current)) break
    if (ts.isFunctionLike(current)) break
    current = current.parent
  }
  return false
}

function isInsideConditional(node: ts.Node): boolean {
  let current: ts.Node | undefined = node
  while (current) {
    if (
      ts.isIfStatement(current) ||
      ts.isSwitchStatement(current) ||
      ts.isConditionalExpression(current) ||
      ts.isCaseClause(current) ||
      ts.isDefaultClause(current)
    ) {
      return true
    }
    if (ts.isFunctionLike(current) || ts.isSourceFile(current)) break
    current = current.parent
  }
  return false
}

function ensureValidStatePlacement(node: ts.VariableDeclaration, ctx: TransformContext): void {
  if (isInsideLoop(node)) {
    throw new Error(formatError(ctx.sourceFile, node, '$state() cannot be declared inside loops'))
  }
  if (isInsideConditional(node)) {
    throw new Error(
      formatError(ctx.sourceFile, node, '$state() must be declared at top-level scope'),
    )
  }
}

function isTopLevelDeclaration(node: ts.VariableDeclaration): boolean {
  const parentList = node.parent
  if (!ts.isVariableDeclarationList(parentList)) return false
  const parentStmt = parentList.parent
  return ts.isVariableStatement(parentStmt) && ts.isSourceFile(parentStmt.parent)
}

function isExportedDeclaration(node: ts.VariableDeclaration, ctx: TransformContext): boolean {
  const parentList = node.parent
  if (!ts.isVariableDeclarationList(parentList)) return false
  const stmt = parentList.parent
  if (!ts.isVariableStatement(stmt)) return false
  if (stmt.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) {
    return true
  }
  return ctx.exportedNames.has(node.name.getText())
}

/**
 * Format an error with line/column info
 */
function formatError(sourceFile: ts.SourceFile, node: ts.Node, message: string): string {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
  return `${message} (at ${sourceFile.fileName}:${line + 1}:${character + 1})`
}

/**
 * Determine if a tracked variable is used in a reactive context (JSX non-event or $effect)
 * If not, it can be emitted as a getter-only derived value.
 */
function shouldEmitGetter(name: string, ctx: TransformContext): boolean {
  const { sourceFile } = ctx
  let reactive = false
  let eventUsage = false
  let otherUsage = false

  const visit = (node: ts.Node, shadow: Set<string>, inFunction: boolean): void => {
    if (!node || reactive) return

    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      const nextShadow = new Set(shadow)
      const params = collectParameterNames(node.parameters)
      for (const p of params) nextShadow.add(p)
      ts.forEachChild(node, child => visit(child, nextShadow, true))
      return
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const nextShadow = new Set(shadow)
      nextShadow.add(node.name.text)
      if (node.initializer) visit(node.initializer, nextShadow, inFunction)
      return
    }

    if (ts.isIdentifier(node) && node.text === name && !shadow.has(name)) {
      if (isInReactiveJsx(node) || isInsideEffect(node)) {
        reactive = true
        return
      }
      if (isInEventHandler(node)) {
        eventUsage = true
      } else if (inFunction) {
        // Reads inside plain functions/handlers should stay live via getter
        eventUsage = true
      } else {
        otherUsage = true
      }
    }

    ts.forEachChild(node, child => visit(child, shadow, inFunction))
  }

  visit(sourceFile, new Set(), false)
  if (reactive || otherUsage) return false
  return eventUsage
}

function isInsideEffect(node: ts.Node): boolean {
  let current: ts.Node | undefined = node
  while (current) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === '$effect'
    ) {
      return true
    }
    current = current.parent
  }
  return false
}

function isInReactiveJsx(node: ts.Node): boolean {
  let current: ts.Node | undefined = node
  while (current) {
    if (ts.isJsxAttribute(current)) {
      const name = current.name.getText()
      if (isEventHandler(name) || NON_REACTIVE_ATTRS.has(name)) {
        return false
      }
      return true
    }
    if (ts.isJsxExpression(current)) return true
    current = current.parent
  }
  return false
}

function isInEventHandler(node: ts.Node): boolean {
  let current: ts.Node | undefined = node
  while (current) {
    if (ts.isJsxAttribute(current)) {
      const name = current.name.getText()
      return isEventHandler(name)
    }
    current = current.parent
  }
  return false
}

/**
 * Check if a variable declaration should be memoized
 */
function shouldMemoize(node: ts.VariableDeclaration, stateVars: Set<string>): boolean {
  const list = node.parent
  if (!list || !ts.isVariableDeclarationList(list)) return false

  const isConst = (list.flags & ts.NodeFlags.Const) === ts.NodeFlags.Const
  if (!isConst || node.initializer === undefined) return false

  // Don't memoize function declarations
  if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
    return false
  }

  // Don't memoize if it's already a state variable
  return !stateVars.has(node.name.getText())
}

/**
 * Create a getter call: name()
 */
function createGetterCall(factory: ts.NodeFactory, name: string): ts.CallExpression {
  return factory.createCallExpression(factory.createIdentifier(name), undefined, [])
}

/**
 * Check if a token is an assignment operator
 */
function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
}

/**
 * Check if an operator is ++ or --
 */
function isIncrementOrDecrement(
  operator: ts.PrefixUnaryOperator | ts.PostfixUnaryOperator,
): boolean {
  return operator === ts.SyntaxKind.PlusPlusToken || operator === ts.SyntaxKind.MinusMinusToken
}

/**
 * Convert compound assignment operator to binary operator
 */
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

function getRootIdentifier(expr: ts.Expression): ts.Identifier | null {
  let current: ts.Expression = expr
  while (true) {
    if (ts.isIdentifier(current)) return current
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current)
    ) {
      current = current.expression
      continue
    }
    return null
  }
}

function isTrackedRoot(expr: ts.Expression, ctx: TransformContext): boolean {
  const root = getRootIdentifier(expr)
  if (!root) return false
  return ctx.stateVars.has(root.text) || ctx.memoVars.has(root.text)
}

function isDynamicElementAccess(node: ts.ElementAccessExpression): boolean {
  const arg = node.argumentExpression
  if (!arg) return true
  return !(
    ts.isStringLiteral(arg) ||
    ts.isNumericLiteral(arg) ||
    ts.isNoSubstitutionTemplateLiteral(arg)
  )
}

/**
 * Check if an attribute name is an event handler (onClick, onSubmit, etc.)
 */
function isEventHandler(name: string): boolean {
  return /^on[A-Z]/.test(name)
}

/**
 * Check if an identifier should be transformed to a getter call
 * Returns false for declarations, property names, type references, etc.
 */
function shouldTransformIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent
  if (!parent) return false

  // Don't transform if this is the callee of a call expression
  // (e.g., count() - the 'count' identifier)
  if (ts.isCallExpression(parent) && parent.expression === node) return false
  if (ts.isNewExpression(parent) && parent.expression === node) return false

  // Don't transform declarations
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false
  if (ts.isBindingElement(parent) && parent.name === node) return false
  if (ts.isParameter(parent) && parent.name === node) return false
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false
  if (ts.isFunctionExpression(parent) && parent.name === node) return false

  // Don't transform imports/exports
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) {
    return false
  }
  if (ts.isExportSpecifier(parent)) return false

  // Don't transform property names in object literals/assignments
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false
  if (ts.isShorthandPropertyAssignment(parent)) return false

  // Don't transform JSX attribute names
  if (ts.isJsxAttribute(parent) && parent.name === node) return false

  // Don't transform type references
  if (ts.isTypeReferenceNode(parent) || ts.isExpressionWithTypeArguments(parent)) return false
  if (ts.isQualifiedName(parent)) return false

  return true
}

function detectDerivedCycles(ctx: TransformContext): void {
  const filteredGraph = new Map<string, Set<string>>()
  ctx.dependencyGraph.forEach((deps, name) => {
    const filtered = new Set<string>()
    deps.forEach(dep => {
      if (ctx.dependencyGraph.has(dep)) {
        filtered.add(dep)
      }
    })
    filteredGraph.set(name, filtered)
  })

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []

  const dfs = (name: string): void => {
    if (visited.has(name)) return
    if (visiting.has(name)) {
      const cycleStart = stack.indexOf(name)
      const cyclePath = stack.slice(cycleStart).concat(name)
      throw new Error(formatCycleError(ctx, cyclePath))
    }

    visiting.add(name)
    stack.push(name)
    const deps = filteredGraph.get(name)
    if (deps) {
      deps.forEach(dep => dfs(dep))
    }
    stack.pop()
    visiting.delete(name)
    visited.add(name)
  }

  filteredGraph.forEach((_deps, name) => {
    if (!visited.has(name)) dfs(name)
  })
}

function formatCycleError(ctx: TransformContext, path: string[]): string {
  const head = path[0]
  if (!head) return 'Detected cyclic derived dependency'
  const locationNode = ctx.derivedDecls.get(head)
  const msg = `Detected cyclic derived dependency: ${path.join(' -> ')}`
  if (locationNode) {
    return formatError(ctx.sourceFile, locationNode, msg)
  }
  return msg
}

// ============================================================================
// Import Management
// ============================================================================

/**
 * Add runtime imports for used helpers
 */
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
  if (helpers.createElement) {
    neededSpecifiers.push(
      factory.createImportSpecifier(
        false,
        factory.createIdentifier(RUNTIME_HELPERS.createElement),
        factory.createIdentifier(RUNTIME_ALIASES.createElement),
      ),
    )
  }
  if (helpers.conditional) {
    neededSpecifiers.push(
      factory.createImportSpecifier(
        false,
        factory.createIdentifier(RUNTIME_HELPERS.conditional),
        factory.createIdentifier(RUNTIME_ALIASES.conditional),
      ),
    )
  }
  if (helpers.list) {
    neededSpecifiers.push(
      factory.createImportSpecifier(
        false,
        factory.createIdentifier(RUNTIME_HELPERS.list),
        factory.createIdentifier(RUNTIME_ALIASES.list),
      ),
    )
  }
  if (helpers.insert) {
    neededSpecifiers.push(
      factory.createImportSpecifier(
        false,
        factory.createIdentifier(RUNTIME_HELPERS.insert),
        factory.createIdentifier(RUNTIME_ALIASES.insert),
      ),
    )
  }
  if (helpers.onDestroy) {
    neededSpecifiers.push(
      factory.createImportSpecifier(
        false,
        factory.createIdentifier(RUNTIME_HELPERS.onDestroy),
        factory.createIdentifier(RUNTIME_ALIASES.onDestroy),
      ),
    )
  }

  if (!neededSpecifiers.length) return sourceFile

  // Try to add to existing fict-runtime import
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

  // Create new import declaration
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

/**
 * Remove $state and $effect from 'fict' imports
 */
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

// ============================================================================
// Exports
// ============================================================================

export default createFictTransformer
