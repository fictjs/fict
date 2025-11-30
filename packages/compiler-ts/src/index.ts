import ts from 'typescript'

// ============================================================================
// Types and Constants
// ============================================================================

export interface FictCompilerOptions {
  dev?: boolean
  sourcemap?: boolean
}

interface TransformContext {
  stateVars: Set<string>
  memoVars: Set<string>
  shadowedVars: Set<string>
  helpersUsed: HelperUsage
  factory: ts.NodeFactory
  context: ts.TransformationContext
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
      // Phase 1: Collect all $state variables
      const stateVars = new Set<string>()
      collectStateVariables(sourceFile, stateVars)

      // Phase 2: Track memo variables and used helpers
      const memoVars = new Set<string>()
      const helpersUsed: HelperUsage = { signal: false, memo: false, effect: false }

      // Phase 3: Create transform context and visitor
      const ctx: TransformContext = {
        stateVars,
        memoVars,
        shadowedVars: new Set(),
        helpersUsed,
        factory,
        context,
      }

      const visitor = createVisitor(ctx)
      const transformed = (ts.visitNode(sourceFile, visitor) ?? sourceFile) as ts.SourceFile
      return addRuntimeImports(transformed, helpersUsed, factory)
    }
  }
}

// ============================================================================
// Visitor Factory
// ============================================================================

function createVisitor(ctx: TransformContext): ts.Visitor {
  const { stateVars, memoVars, shadowedVars, helpersUsed, factory, context } = ctx

  const visitor: ts.Visitor = node => {
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
      return handleFunctionWithShadowing(node, ctx)
    }

    // Handle variable declarations
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      return handleVariableDeclaration(node, ctx, visitor)
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
// Function Shadowing Handling
// ============================================================================

function handleFunctionWithShadowing(
  node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
  ctx: TransformContext,
): ts.Node {
  const { stateVars, memoVars, shadowedVars, helpersUsed, factory, context } = ctx

  // Collect parameter names that shadow tracked variables
  const paramNames = collectParameterNames(node.parameters)
  const newShadowed = new Set(shadowedVars)

  for (const name of paramNames) {
    if (stateVars.has(name) || memoVars.has(name)) {
      newShadowed.add(name)
    }
  }

  // Create new context with updated shadowed vars
  const newCtx: TransformContext = {
    stateVars,
    memoVars,
    shadowedVars: newShadowed,
    helpersUsed,
    factory,
    context,
  }

  // Create inner visitor with new context
  const innerVisitor = createVisitor(newCtx)

  // Visit children with inner visitor
  return ts.visitEachChild(node, innerVisitor, context)
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
): ts.VariableDeclaration {
  const { stateVars, memoVars, shadowedVars, helpersUsed, factory, context } = ctx

  if (!ts.isIdentifier(node.name) || !node.initializer) {
    return ts.visitEachChild(node, visitor, context) as ts.VariableDeclaration
  }

  const visitedInit = ts.visitNode(node.initializer, visitor) as ts.Expression

  // Handle $state declarations
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

  // Handle derived values (const declarations that depend on state/memo)
  if (
    shouldMemoize(node, stateVars) &&
    dependsOnTracked(node.initializer, stateVars, memoVars, shadowedVars)
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

  if (shouldWrap) {
    // Wrap in an arrow function: () => transformedExpr
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

  // Not wrapping, but the expression might have been transformed
  if (transformedExpr !== expr) {
    return factory.updateJsxExpression(node, transformedExpr)
  }

  return node
}

// ============================================================================
// Assignment and Unary Expression Handling
// ============================================================================

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
): boolean {
  let depends = false
  const visit = (node: ts.Node, locals: Set<string>): void => {
    if (depends) return

    if (ts.isIdentifier(node)) {
      const name = node.text
      if (!locals.has(name)) {
        const tracked = isTracked(name, stateVars, memoVars)
        const shorthandUse =
          ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
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

/**
 * Check if a variable name is tracked (either state or memo)
 */
function isTracked(name: string, stateVars: Set<string>, memoVars: Set<string>): boolean {
  return stateVars.has(name) || memoVars.has(name)
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
 * Check if a variable declaration should be memoized
 */
function shouldMemoize(node: ts.VariableDeclaration, stateVars: Set<string>): boolean {
  const list = node.parent
  const isConst =
    ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) === ts.NodeFlags.Const
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
