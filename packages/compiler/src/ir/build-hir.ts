import { transformFromAstSync } from '@babel/core'
import type * as BabelCore from '@babel/core'
// @ts-expect-error - CommonJS module without proper types
import transformDestructuring from '@babel/plugin-transform-destructuring'
import * as t from '@babel/types'

import {
  HIRError,
  type ArrayExpression as HArrayExpression,
  type ArrowFunctionExpression as HArrowFunctionExpression,
  type AssignmentExpression as HAssignmentExpression,
  type BabelStatement,
  type BasicBlock,
  type BinaryExpression as HBinaryExpression,
  type CallExpression as HCallExpression,
  type ConditionalExpression as HConditionalExpression,
  type Expression,
  type FunctionExpression as HFunctionExpression,
  type HIRFunction,
  type HIRProgram,
  type Identifier as HIdentifier,
  type JSXAttribute as HJSXAttribute,
  type JSXChild as HJSXChild,
  type JSXElementExpression as HJSXElementExpression,
  type Literal as HLiteral,
  type LogicalExpression as HLogicalExpression,
  type MemberExpression as HMemberExpression,
  type ObjectExpression as HObjectExpression,
  type PostambleItem,
  type PreambleItem,
  type SpreadElement as HSpreadElement,
  type TemplateLiteral as HTemplateLiteral,
  type UnaryExpression as HUnaryExpression,
  type UpdateExpression as HUpdateExpression,
} from './hir'
import type { CompilerWarning } from '../types'

interface BuildHIROptions {
  dev?: boolean
  fileName?: string
  onWarn?: (warning: CompilerWarning) => void
}

interface BlockBuilder {
  block: BasicBlock
  sealed: boolean
}

let destructuringTempCounter = 0
let activeBuildOptions: BuildHIROptions | undefined

const getLoc = (node?: BabelCore.types.Node | null): BabelCore.types.SourceLocation | null => {
  return node?.loc ?? null
}

const resolveDestructuringPlugin = (): any => {
  const mod: any = transformDestructuring
  return mod?.default ?? mod
}

const createAssignmentDestructuringPlugin = () => {
  const pluginFactory = resolveDestructuringPlugin()
  if (typeof pluginFactory !== 'function') {
    throw new Error('Expected @babel/plugin-transform-destructuring to export a function')
  }
  const plugin = pluginFactory(
    {
      assertVersion() {},
      assumption() {
        return undefined
      },
      types: t,
    } as any,
    {},
  )

  return {
    visitor: {
      AssignmentExpression(
        path: BabelCore.NodePath<BabelCore.types.AssignmentExpression>,
        state: BabelCore.PluginPass,
      ) {
        if (!t.isObjectPattern(path.node.left) && !t.isArrayPattern(path.node.left)) return
        const visitor = plugin.visitor?.AssignmentExpression
        if (!visitor) return
        visitor.call(this, path, state)
      },
    },
  }
}

const expandDestructuringAssignments = (ast: BabelCore.types.File): BabelCore.types.File => {
  const result = transformFromAstSync(ast, undefined, {
    configFile: false,
    babelrc: false,
    ast: true,
    code: false,
    plugins: [createAssignmentDestructuringPlugin()],
  })
  return (result?.ast as BabelCore.types.File) ?? ast
}

const reportUnsupportedExpression = (
  node: BabelCore.types.Node,
  overrideMessage?: string,
): never => {
  const loc = getLoc(node)
  const line = loc?.start.line ?? 0
  const column = loc?.start.column ?? 0
  const fileName = activeBuildOptions?.fileName ?? '<unknown>'
  const message = overrideMessage ?? `Unsupported expression '${node.type}' in HIR conversion`

  if (activeBuildOptions?.onWarn) {
    activeBuildOptions.onWarn({
      code: 'FICT-HIR-UNSUPPORTED',
      message,
      fileName,
      line,
      column,
    })
  }

  throw new HIRError(message, 'BUILD_ERROR', {
    file: fileName,
    line: loc?.start.line,
  })
}

interface MacroAliases {
  state?: Set<string>
  effect?: Set<string>
}

interface ResolvedMacroAliases {
  state: Set<string>
  effect: Set<string>
}

const DEFAULT_MACRO_ALIASES: ResolvedMacroAliases = {
  state: new Set(['$state']),
  effect: new Set(['$effect']),
}

let activeMacroAliases: ResolvedMacroAliases = DEFAULT_MACRO_ALIASES

function resolveMacroAliases(aliases?: MacroAliases): ResolvedMacroAliases {
  return {
    state: new Set([...(aliases?.state ?? []), ...DEFAULT_MACRO_ALIASES.state]),
    effect: new Set([...(aliases?.effect ?? []), ...DEFAULT_MACRO_ALIASES.effect]),
  }
}

function normalizeMacroCallee(callee: BabelCore.types.Expression): BabelCore.types.Expression {
  if (!t.isIdentifier(callee)) return callee
  if (activeMacroAliases.state.has(callee.name)) {
    return t.identifier('$state')
  }
  if (activeMacroAliases.effect.has(callee.name)) {
    return t.identifier('$effect')
  }
  return callee
}

function normalizeVarKind(
  kind: BabelCore.types.VariableDeclaration['kind'],
): 'const' | 'let' | 'var' {
  return kind === 'const' || kind === 'let' || kind === 'var' ? kind : 'let'
}

function hasNoMemoDirective(directives?: BabelCore.types.Directive[] | null): boolean {
  if (!directives) return false
  return directives.some(d => d.value.value === 'use no memo')
}

function hasNoMemoDirectiveInStatements(body: BabelCore.types.Statement[]): boolean {
  const first = body[0]
  return !!(
    first &&
    t.isExpressionStatement(first) &&
    t.isStringLiteral(first.expression) &&
    first.expression.value === 'use no memo'
  )
}

const PURE_DIRECTIVE_TEXT = 'use pure'

function hasPureDirective(directives?: BabelCore.types.Directive[] | null): boolean {
  if (!directives) return false
  return directives.some(d => d.value.value === PURE_DIRECTIVE_TEXT)
}

function hasPureDirectiveInStatements(body: BabelCore.types.Statement[]): boolean {
  const first = body[0]
  return !!(
    first &&
    t.isExpressionStatement(first) &&
    t.isStringLiteral(first.expression) &&
    first.expression.value === PURE_DIRECTIVE_TEXT
  )
}

function hasPureAnnotation(node: BabelCore.types.Node | null | undefined): boolean {
  if (!node) return false
  const comments = node.leadingComments ?? []
  return comments.some(c => /@__PURE__|#__PURE__/.test(c.value))
}

/**
 * Parsed @fictReturn annotation result.
 */
export interface ParsedFictReturn {
  objectProps?: Map<string, 'signal' | 'memo'>
  arrayProps?: Map<number, 'signal' | 'memo'>
  directAccessor?: 'signal' | 'memo'
}

/**
 * Parse @fictReturn JSDoc annotation from one or more nodes.
 *
 * Supported formats:
 * - Object return: @fictReturn { count: 'signal', double: 'memo' }
 * - Array return: @fictReturn [0: 'signal', 1: 'memo']
 * - Direct accessor: @fictReturn 'signal' or @fictReturn 'memo'
 *
 * @param node - The function node to parse annotations from
 * @returns Parsed return info or null if no annotation found
 */
export function parseFictReturnAnnotation(
  node: BabelCore.types.Node | null | undefined | (BabelCore.types.Node | null | undefined)[],
): ParsedFictReturn | null {
  if (!node) return null

  const nodes = Array.isArray(node) ? node : [node]
  for (const current of nodes) {
    if (!current) continue
    const comments = current.leadingComments ?? []
    for (const comment of comments) {
      // Match @fictReturn annotation
      const match = comment.value.match(/@fictReturn\s+(.+?)(?:\s*\*\/|\s*$|\n)/s)
      if (!match) continue

      const content = match[1].trim()

      // Direct accessor: 'signal' or 'memo'
      if (content === "'signal'" || content === '"signal"') {
        return { directAccessor: 'signal' }
      }
      if (content === "'memo'" || content === '"memo"') {
        return { directAccessor: 'memo' }
      }

      // Object format: { key: 'signal', key2: 'memo' }
      const objectMatch = content.match(/^\{([^}]+)\}$/)
      if (objectMatch) {
        const objectProps = new Map<string, 'signal' | 'memo'>()
        const propsStr = objectMatch[1]
        // Parse key: 'value' pairs
        const propPattern = /(\w+)\s*:\s*['"]?(signal|memo)['"]?/g
        let propMatch
        while ((propMatch = propPattern.exec(propsStr)) !== null) {
          objectProps.set(propMatch[1], propMatch[2] as 'signal' | 'memo')
        }
        if (objectProps.size > 0) {
          return { objectProps }
        }
      }

      // Array format: [0: 'signal', 1: 'memo']
      const arrayMatch = content.match(/^\[([^\]]+)\]$/)
      if (arrayMatch) {
        const arrayProps = new Map<number, 'signal' | 'memo'>()
        const propsStr = arrayMatch[1]
        // Parse index: 'value' pairs
        const propPattern = /(\d+)\s*:\s*['"]?(signal|memo)['"]?/g
        let propMatch
        while ((propMatch = propPattern.exec(propsStr)) !== null) {
          arrayProps.set(parseInt(propMatch[1], 10), propMatch[2] as 'signal' | 'memo')
        }
        if (arrayProps.size > 0) {
          return { arrayProps }
        }
      }
    }
  }

  return null
}

/**
 * Extract identifiers from destructuring patterns.
 * Handles object patterns, array patterns, rest elements, and assignment patterns.
 */
function extractIdentifiersFromPattern(pattern: BabelCore.types.Pattern): HIdentifier[] {
  const ids: HIdentifier[] = []

  if (t.isObjectPattern(pattern)) {
    for (const prop of pattern.properties) {
      if (t.isObjectProperty(prop)) {
        if (t.isIdentifier(prop.value)) {
          ids.push({ kind: 'Identifier', name: prop.value.name })
        } else if (t.isAssignmentPattern(prop.value)) {
          // Handle default values: { a = 1 }
          if (t.isIdentifier(prop.value.left)) {
            ids.push({ kind: 'Identifier', name: prop.value.left.name })
          } else if (t.isPattern(prop.value.left)) {
            ids.push(...extractIdentifiersFromPattern(prop.value.left))
          }
        } else if (t.isObjectPattern(prop.value) || t.isArrayPattern(prop.value)) {
          ids.push(...extractIdentifiersFromPattern(prop.value))
        }
      } else if (t.isRestElement(prop) && t.isIdentifier(prop.argument)) {
        ids.push({ kind: 'Identifier', name: prop.argument.name })
      }
    }
  } else if (t.isArrayPattern(pattern)) {
    for (const elem of pattern.elements) {
      if (!elem) continue
      if (t.isIdentifier(elem)) {
        ids.push({ kind: 'Identifier', name: elem.name })
      } else if (t.isPattern(elem)) {
        ids.push(...extractIdentifiersFromPattern(elem))
      } else if (t.isRestElement(elem) && t.isIdentifier(elem.argument)) {
        ids.push({ kind: 'Identifier', name: elem.argument.name })
      }
    }
  } else if (t.isAssignmentPattern(pattern)) {
    if (t.isIdentifier(pattern.left)) {
      ids.push({ kind: 'Identifier', name: pattern.left.name })
    } else if (t.isPattern(pattern.left)) {
      ids.push(...extractIdentifiersFromPattern(pattern.left))
    }
  }

  return ids
}

/**
 * Build a simple list of BasicBlocks from a list of statements.
 * This is a simplified version for arrow function block bodies.
 * Does not handle complex control flow (use convertFunction for that).
 */
/**
 * Build basic blocks from a list of statements (simplified version for nested functions).
 * This version handles common control flow structures to properly capture arrow function bodies.
 */
function _buildBlocksFromStatements(statements: BabelCore.types.Statement[]): BasicBlock[] {
  const blocks: BasicBlock[] = []
  let nextBlockId = 0
  let tempCounter = 0

  const createBlock = (): BasicBlock => ({
    id: nextBlockId++,
    instructions: [],
    terminator: { kind: 'Unreachable' },
  })

  const currentBlock = createBlock()
  blocks.push(currentBlock)

  // Simple recursive processor for nested statements
  const processStmts = (stmts: BabelCore.types.Statement[], target: BasicBlock): void => {
    for (let index = 0; index < stmts.length; index++) {
      const stmt = stmts[index]
      if (t.isReturnStatement(stmt)) {
        target.terminator = {
          kind: 'Return',
          argument: stmt.argument ? convertExpression(stmt.argument) : undefined,
        }
        return // Stop processing after return
      }
      if (t.isThrowStatement(stmt)) {
        target.terminator = {
          kind: 'Throw',
          argument: convertExpression(stmt.argument as BabelCore.types.Expression),
        }
        return // Stop processing after throw
      }
      if (t.isExpressionStatement(stmt)) {
        const handled = handleExpressionStatement(stmt.expression, instr =>
          target.instructions.push(instr),
        )
        if (!handled) {
          target.instructions.push({
            kind: 'Expression',
            value: convertExpression(stmt.expression),
          })
        }
        continue
      }
      if (t.isVariableDeclaration(stmt)) {
        for (const decl of stmt.declarations) {
          const declKind = normalizeVarKind(stmt.kind)
          if (t.isIdentifier(decl.id)) {
            target.instructions.push({
              kind: 'Assign',
              target: { kind: 'Identifier', name: decl.id.name },
              value: decl.init
                ? convertExpression(decl.init)
                : ({ kind: 'Literal', value: undefined } as HLiteral),
              declarationKind: declKind,
            })
            continue
          }

          if (t.isObjectPattern(decl.id)) {
            const tempName = `__destruct_${tempCounter++}`
            target.instructions.push({
              kind: 'Assign',
              target: { kind: 'Identifier', name: tempName },
              value: decl.init
                ? convertExpression(decl.init)
                : ({ kind: 'Literal', value: undefined } as HLiteral),
              declarationKind: declKind,
            })

            const excludeKeys: BabelCore.types.Expression[] = []

            decl.id.properties.forEach(prop => {
              if (t.isObjectProperty(prop)) {
                const keyName = t.isIdentifier(prop.key)
                  ? prop.key.name
                  : t.isStringLiteral(prop.key)
                    ? prop.key.value
                    : t.isNumericLiteral(prop.key)
                      ? String(prop.key.value)
                      : null
                if (!keyName) return
                excludeKeys.push(t.stringLiteral(keyName))
                if (t.isIdentifier(prop.value)) {
                  const memberExpr = t.memberExpression(
                    t.identifier(tempName),
                    t.identifier(keyName),
                    false,
                  )
                  target.instructions.push({
                    kind: 'Assign',
                    target: { kind: 'Identifier', name: prop.value.name },
                    value: convertExpression(memberExpr),
                    declarationKind: declKind,
                  })
                }
              } else if (t.isRestElement(prop) && t.isIdentifier(prop.argument)) {
                const restExpr = t.callExpression(t.identifier('__fictPropsRest'), [
                  t.identifier(tempName),
                  t.arrayExpression(excludeKeys),
                ])
                target.instructions.push({
                  kind: 'Assign',
                  target: { kind: 'Identifier', name: prop.argument.name },
                  value: convertExpression(restExpr),
                  declarationKind: declKind,
                })
              }
            })
          }

          if (t.isArrayPattern(decl.id)) {
            const tempName = `__destruct_${tempCounter++}`
            target.instructions.push({
              kind: 'Assign',
              target: { kind: 'Identifier', name: tempName },
              value: decl.init
                ? convertExpression(decl.init)
                : ({ kind: 'Literal', value: undefined } as HLiteral),
              declarationKind: declKind,
            })

            decl.id.elements.forEach((elem, index) => {
              if (!elem) return
              if (t.isIdentifier(elem)) {
                const memberExpr = t.memberExpression(
                  t.identifier(tempName),
                  t.numericLiteral(index),
                  true,
                )
                target.instructions.push({
                  kind: 'Assign',
                  target: { kind: 'Identifier', name: elem.name },
                  value: convertExpression(memberExpr),
                  declarationKind: declKind,
                })
              } else if (t.isRestElement(elem) && t.isIdentifier(elem.argument)) {
                const sliceCall = t.callExpression(
                  t.memberExpression(t.identifier(tempName), t.identifier('slice')),
                  [t.numericLiteral(index)],
                )
                target.instructions.push({
                  kind: 'Assign',
                  target: { kind: 'Identifier', name: elem.argument.name },
                  value: convertExpression(sliceCall),
                  declarationKind: declKind,
                })
              }
            })
          }
        }
        continue
      }
      if (t.isFunctionDeclaration(stmt) && stmt.id) {
        target.instructions.push({
          kind: 'Assign',
          target: { kind: 'Identifier', name: stmt.id.name },
          value: convertExpression(
            t.functionExpression(
              stmt.id,
              stmt.params as any,
              stmt.body,
              stmt.generator,
              stmt.async,
            ),
          ),
        })
        continue
      }
      if (t.isBlockStatement(stmt)) {
        // Process nested block statements
        processStmts(stmt.body, target)
        continue
      }
      if (t.isIfStatement(stmt)) {
        // For if statements in nested functions, create proper branch structure
        const consequentBlock = createBlock()
        const alternateBlock = createBlock()
        const joinBlock = createBlock()

        blocks.push(consequentBlock, alternateBlock, joinBlock)

        target.terminator = {
          kind: 'Branch',
          test: convertExpression(stmt.test as BabelCore.types.Expression),
          consequent: consequentBlock.id,
          alternate: alternateBlock.id,
        }

        // Process consequent
        if (t.isBlockStatement(stmt.consequent)) {
          processStmts(stmt.consequent.body, consequentBlock)
        } else {
          processStmts([stmt.consequent], consequentBlock)
        }
        if (consequentBlock.terminator.kind === 'Unreachable') {
          consequentBlock.terminator = { kind: 'Jump', target: joinBlock.id }
        }

        // Process alternate
        if (stmt.alternate) {
          if (t.isBlockStatement(stmt.alternate)) {
            processStmts(stmt.alternate.body, alternateBlock)
          } else {
            processStmts([stmt.alternate], alternateBlock)
          }
          if (alternateBlock.terminator.kind === 'Unreachable') {
            alternateBlock.terminator = { kind: 'Jump', target: joinBlock.id }
          }
        } else {
          alternateBlock.terminator = { kind: 'Jump', target: joinBlock.id }
        }

        const remaining = stmts.slice(index + 1)
        if (remaining.length > 0) {
          processStmts(remaining, joinBlock)
        }
        return
      }
      // For other statement types (for, while, etc.), convert to expression if possible
      // or skip to keep the builder total
    }
  }

  processStmts(statements, currentBlock)
  return blocks
}

/**
 * Experimental: Build a high-level IR from a Babel AST.
 *
 * This is intentionally minimal but now emits a simple CFG:
 * - Collects top-level function declarations or const function expressions.
 * - Preserves import/export statements in preamble/postamble.
 * - Emits basic blocks, branching on IfStatement into separate blocks with a join.
 * - Unhandled constructs are represented as undefined literals to keep traversal total.
 *
 * Future work will expand this into a full CFG + SSA builder.
 */
export function buildHIR(
  ast: BabelCore.types.File,
  macroAliases?: MacroAliases,
  options?: BuildHIROptions,
): HIRProgram {
  const prevMacroAliases = activeMacroAliases
  const prevOptions = activeBuildOptions
  activeMacroAliases = resolveMacroAliases(macroAliases)
  activeBuildOptions = options
  try {
    const expandedAst = expandDestructuringAssignments(ast)
    const functions: HIRFunction[] = []
    const preamble: PreambleItem[] = []
    const postamble: PostambleItem[] = []
    const originalBody = [...expandedAst.program.body] as BabelStatement[]
    const programNoMemo =
      hasNoMemoDirective(expandedAst.program.directives) ||
      hasNoMemoDirectiveInStatements(expandedAst.program.body as BabelCore.types.Statement[])
    const programPure =
      hasPureDirective(expandedAst.program.directives) ||
      hasPureDirectiveInStatements(expandedAst.program.body as BabelCore.types.Statement[])

    // Track which function names we've processed to avoid duplicates in export
    const processedFunctions = new Set<string>()

    for (const stmt of expandedAst.program.body) {
      // Import declarations go to preamble
      if (t.isImportDeclaration(stmt)) {
        preamble.push(stmt)
        continue
      }

      // Function declarations
      if (t.isFunctionDeclaration(stmt) && stmt.body) {
        const name = stmt.id?.name
        if (name) processedFunctions.add(name)
        functions.push(
          convertFunction(name, stmt.params, stmt.body.body, {
            noMemo: programNoMemo,
            pure: programPure,
            directives: stmt.body.directives,
            loc: getLoc(stmt),
            isAsync: stmt.async,
            astNode: stmt,
          }),
        )
        continue
      }

      // Export named declarations
      if (t.isExportNamedDeclaration(stmt)) {
        const decl = stmt.declaration
        if (decl && t.isFunctionDeclaration(decl) && decl.body) {
          // Export function declaration - convert to HIR and preserve export wrapper
          const name = decl.id?.name
          if (name) processedFunctions.add(name)
          functions.push(
            convertFunction(name, decl.params, decl.body.body, {
              noMemo: programNoMemo,
              pure: programPure,
              directives: decl.body.directives,
              loc: getLoc(decl),
              isAsync: decl.async,
              astNode: [decl, stmt],
            }),
          )
          // We'll recreate the export in codegen
          postamble.push({ kind: 'ExportFunction', name })
        } else if (decl && t.isVariableDeclaration(decl)) {
          // Check if it's a function expression
          let hasFunction = false
          for (const v of decl.declarations) {
            if (!t.isIdentifier(v.id)) continue
            const name = v.id.name
            if (t.isFunctionExpression(v.init) || t.isArrowFunctionExpression(v.init)) {
              hasFunction = true
              processedFunctions.add(name)
              const body = v.init.body
              const params = v.init.params
              const isArrow = t.isArrowFunctionExpression(v.init)
              const hasExpressionBody = isArrow && !t.isBlockStatement(body)
              const fnHIR = t.isBlockStatement(body)
                ? convertFunction(name, params, body.body, {
                    noMemo: programNoMemo,
                    pure: programPure,
                    directives: body.directives,
                    loc: getLoc(v.init ?? v),
                    isAsync: v.init.async,
                    astNode: [v.init, v, decl, stmt],
                  })
                : convertFunction(name, params, [t.returnStatement(body as any)], {
                    noMemo: programNoMemo,
                    pure: programPure,
                    loc: getLoc(v.init ?? v),
                    isAsync: v.init.async,
                    astNode: [v.init, v, decl, stmt],
                  })
              fnHIR.meta = {
                ...(fnHIR.meta ?? {}),
                fromExpression: true,
                isArrow,
                hasExpressionBody,
              }
              functions.push(fnHIR)
              postamble.push({ kind: 'ExportFunction', name })
            }
          }
          if (!hasFunction) {
            // Non-function export - preserve as-is
            postamble.push(stmt)
          }
        } else if (!decl && stmt.specifiers.length > 0) {
          // Export specifiers (e.g., export { foo, bar })
          postamble.push(stmt)
        } else {
          postamble.push(stmt)
        }
        continue
      }

      // Export default declaration
      if (t.isExportDefaultDeclaration(stmt)) {
        const decl = stmt.declaration
        if (t.isFunctionDeclaration(decl) && decl.body) {
          const name = decl.id?.name || '__default'
          processedFunctions.add(name)
          functions.push(
            convertFunction(name, decl.params, decl.body.body, {
              noMemo: programNoMemo,
              pure: programPure,
              directives: decl.body.directives,
              loc: getLoc(decl),
              isAsync: decl.async,
              astNode: [decl, stmt],
            }),
          )
          postamble.push({ kind: 'ExportDefault', name })
        } else if (t.isIdentifier(decl)) {
          postamble.push({ kind: 'ExportDefault', name: decl.name })
        } else {
          postamble.push(stmt)
        }
        continue
      }

      // Variable declarations - check for function expressions
      if (t.isVariableDeclaration(stmt)) {
        let hasFunction = false
        for (const decl of stmt.declarations) {
          if (!t.isIdentifier(decl.id)) continue
          const name = decl.id.name
          if (t.isFunctionExpression(decl.init) || t.isArrowFunctionExpression(decl.init)) {
            hasFunction = true
            processedFunctions.add(name)
            const body = decl.init.body
            const params = decl.init.params
            const isArrow = t.isArrowFunctionExpression(decl.init)
            const hasExpressionBody = isArrow && !t.isBlockStatement(body)
            const fnHIR = t.isBlockStatement(body)
              ? convertFunction(name, params, body.body, {
                  noMemo: programNoMemo,
                  pure: programPure,
                  directives: body.directives,
                  loc: getLoc(decl.init ?? decl),
                  isAsync: decl.init.async,
                  astNode: [decl.init, decl, stmt],
                })
              : convertFunction(
                  name,
                  params,
                  [t.returnStatement(body as BabelCore.types.Expression)],
                  {
                    noMemo: programNoMemo,
                    pure: programPure,
                    loc: getLoc(decl.init ?? decl),
                    isAsync: decl.init.async,
                    astNode: [decl.init, decl, stmt],
                  },
                )
            fnHIR.meta = { ...(fnHIR.meta ?? {}), fromExpression: true, isArrow, hasExpressionBody }
            functions.push(fnHIR)
          }
        }
        if (!hasFunction) {
          // Non-function variable declaration - preserve
          postamble.push(stmt)
        }
        continue
      }

      // Other statements go to postamble
      postamble.push(stmt)
    }

    return { functions, preamble, postamble, originalBody }
  } finally {
    activeMacroAliases = prevMacroAliases
    activeBuildOptions = prevOptions
  }
}

function convertFunction(
  name: string | undefined,
  params: BabelCore.types.Node[],
  body: BabelCore.types.Statement[],
  options?: {
    noMemo?: boolean
    pure?: boolean
    directives?: BabelCore.types.Directive[] | null
    loc?: BabelCore.types.SourceLocation | null
    isAsync?: boolean
    /** Original AST node(s) for parsing @fictReturn annotations */
    astNode?: BabelCore.types.Node | null | (BabelCore.types.Node | null | undefined)[]
  },
): HIRFunction {
  const paramIds: HIdentifier[] = []
  for (const p of params) {
    if (t.isIdentifier(p)) {
      paramIds.push({ kind: 'Identifier', name: p.name })
    } else if (t.isObjectPattern(p) || t.isArrayPattern(p)) {
      // Handle destructuring parameters: ({ a, b }) or ([first, second])
      paramIds.push(...extractIdentifiersFromPattern(p))
    } else if (t.isAssignmentPattern(p)) {
      // Handle default value patterns: (a = 1) or ({ x } = {})
      if (t.isIdentifier(p.left)) {
        paramIds.push({ kind: 'Identifier', name: p.left.name })
      } else if (t.isObjectPattern(p.left) || t.isArrayPattern(p.left)) {
        paramIds.push(...extractIdentifiersFromPattern(p.left))
      }
    } else if (t.isRestElement(p) && t.isIdentifier(p.argument)) {
      // Handle rest parameters: (...args)
      paramIds.push({ kind: 'Identifier', name: p.argument.name })
    }
    // Other unsupported patterns are skipped to keep builder total
  }

  const bodyStatements = [...body]
  const hasNoMemoInBody = hasNoMemoDirectiveInStatements(bodyStatements)
  const hasPureInBody = hasPureDirectiveInStatements(bodyStatements)
  while (hasNoMemoDirectiveInStatements(bodyStatements)) {
    bodyStatements.shift()
  }
  while (hasPureDirectiveInStatements(bodyStatements)) {
    bodyStatements.shift()
  }

  const blocks: BasicBlock[] = []
  let nextBlockId = 0

  const createBlock = (): BlockBuilder => ({
    block: { id: nextBlockId++, instructions: [], terminator: { kind: 'Unreachable' } },
    sealed: false,
  })

  let current = createBlock()
  blocks.push(current.block)

  const sealCurrent = (terminator: BasicBlock['terminator']) => {
    if (current.sealed) return
    current.block.terminator = terminator
    current.sealed = true
  }

  const startNewBlock = (): BlockBuilder => {
    const bb = createBlock()
    blocks.push(bb.block)
    current = bb
    return bb
  }

  // Create CFG build context for nested control flow support
  const cfgContext: CFGBuildContext = {
    blocks,
    nextBlockId: () => nextBlockId++,
    createBlock,
    loopStack: [],
  }

  for (const stmt of bodyStatements) {
    if (t.isReturnStatement(stmt)) {
      const returnExpr = stmt.argument ? convertExpression(stmt.argument) : undefined
      sealCurrent({ kind: 'Return', argument: returnExpr })
      current = startNewBlock()
      continue
    }
    if (t.isExpressionStatement(stmt)) {
      const handled = handleExpressionStatement(stmt.expression, instr =>
        current.block.instructions.push(instr),
      )
      if (!handled) {
        current.block.instructions.push({
          kind: 'Expression',
          value: convertExpression(stmt.expression),
        })
      }
      continue
    }
    if (t.isVariableDeclaration(stmt)) {
      const declKind = normalizeVarKind(stmt.kind)
      for (const decl of stmt.declarations) {
        if (t.isIdentifier(decl.id)) {
          current.block.instructions.push({
            kind: 'Assign',
            target: { kind: 'Identifier', name: decl.id.name },
            value: decl.init
              ? convertExpression(decl.init)
              : ({ kind: 'Literal', value: undefined } as HLiteral),
            declarationKind: declKind,
          })
          continue
        }

        if (t.isObjectPattern(decl.id)) {
          const useTemp = !(decl.init && t.isIdentifier(decl.init))
          const tempName = `__destruct_${destructuringTempCounter++}`
          // When useTemp is true, we convert and store the HIR expression
          // When useTemp is false, we keep the Babel expression for member access
          const hirExpr: Expression | undefined =
            useTemp && decl.init ? convertExpression(decl.init) : undefined
          const babelSourceExpr: BabelCore.types.Expression | undefined =
            decl.init && !useTemp ? (decl.init as BabelCore.types.Expression) : undefined

          if (useTemp) {
            current.block.instructions.push({
              kind: 'Assign',
              target: { kind: 'Identifier', name: tempName },
              value: hirExpr ?? ({ kind: 'Literal', value: undefined } as HLiteral),
              declarationKind: declKind,
            })
          }

          const excludeKeys: BabelCore.types.Expression[] = []

          decl.id.properties.forEach(prop => {
            if (t.isObjectProperty(prop)) {
              const keyName = t.isIdentifier(prop.key)
                ? prop.key.name
                : t.isStringLiteral(prop.key)
                  ? prop.key.value
                  : t.isNumericLiteral(prop.key)
                    ? String(prop.key.value)
                    : null
              if (!keyName) return
              excludeKeys.push(t.stringLiteral(keyName))
              if (t.isIdentifier(prop.value)) {
                const memberExpr = t.memberExpression(
                  useTemp
                    ? t.identifier(tempName)
                    : (babelSourceExpr as BabelCore.types.Expression),
                  t.identifier(keyName),
                  false,
                )
                current.block.instructions.push({
                  kind: 'Assign',
                  target: { kind: 'Identifier', name: prop.value.name },
                  value: convertExpression(memberExpr),
                  declarationKind: declKind,
                })
              }
            } else if (t.isRestElement(prop) && t.isIdentifier(prop.argument)) {
              const restExpr = t.callExpression(t.identifier('__fictPropsRest'), [
                useTemp ? t.identifier(tempName) : (babelSourceExpr as BabelCore.types.Expression),
                t.arrayExpression(excludeKeys),
              ])
              current.block.instructions.push({
                kind: 'Assign',
                target: { kind: 'Identifier', name: prop.argument.name },
                value: convertExpression(restExpr),
                declarationKind: declKind,
              })
            }
          })
        }

        if (t.isArrayPattern(decl.id)) {
          const tempName = `__destruct_${destructuringTempCounter++}`
          current.block.instructions.push({
            kind: 'Assign',
            target: { kind: 'Identifier', name: tempName },
            value: decl.init
              ? convertExpression(decl.init)
              : ({ kind: 'Literal', value: undefined } as HLiteral),
            declarationKind: declKind,
          })

          decl.id.elements.forEach((elem, index) => {
            if (!elem) return
            if (t.isIdentifier(elem)) {
              const memberExpr = t.memberExpression(
                t.identifier(tempName),
                t.numericLiteral(index),
                true,
              )
              current.block.instructions.push({
                kind: 'Assign',
                target: { kind: 'Identifier', name: elem.name },
                value: convertExpression(memberExpr),
                declarationKind: declKind,
              })
            } else if (t.isRestElement(elem) && t.isIdentifier(elem.argument)) {
              const sliceCall = t.callExpression(
                t.memberExpression(t.identifier(tempName), t.identifier('slice')),
                [t.numericLiteral(index)],
              )
              current.block.instructions.push({
                kind: 'Assign',
                target: { kind: 'Identifier', name: elem.argument.name },
                value: convertExpression(sliceCall),
                declarationKind: declKind,
              })
            }
          })
        }
      }
      continue
    }
    if (t.isFunctionDeclaration(stmt) && stmt.id) {
      // Nested function declarations are converted to assignments of function expressions
      const fnExpr = t.functionExpression(
        stmt.id,
        stmt.params as any,
        stmt.body,
        stmt.generator,
        stmt.async,
      )
      current.block.instructions.push({
        kind: 'Assign',
        target: { kind: 'Identifier', name: stmt.id.name },
        value: convertExpression(fnExpr),
      })
      continue
    }
    if (t.isBlockStatement(stmt)) {
      let blockCursor = current
      for (const inner of stmt.body) {
        blockCursor = processStatement(inner, blockCursor, blockCursor.block.id, cfgContext)
      }
      current = blockCursor
      continue
    }
    if (t.isIfStatement(stmt)) {
      const branchSource = current
      const consequentBlock = createBlock()
      const alternateBlock = createBlock()
      const joinBlock = createBlock()

      blocks.push(consequentBlock.block, alternateBlock.block, joinBlock.block)

      // Set branch terminator on source block
      const testExpr = convertExpression(stmt.test as BabelCore.types.Expression)
      branchSource.block.terminator = {
        kind: 'Branch',
        test: testExpr,
        consequent: consequentBlock.block.id,
        alternate: alternateBlock.block.id,
      }
      branchSource.sealed = true

      // Fill consequent with nested control flow support
      fillStatements(stmt.consequent, consequentBlock, joinBlock.block.id, cfgContext)
      // Fill alternate
      if (stmt.alternate) {
        fillStatements(stmt.alternate, alternateBlock, joinBlock.block.id, cfgContext)
      } else {
        // empty alternate jumps to join
        alternateBlock.block.terminator = { kind: 'Jump', target: joinBlock.block.id }
        alternateBlock.sealed = true
      }

      current = joinBlock as BlockBuilder
      continue
    }
    if (t.isWhileStatement(stmt)) {
      const condBlock = createBlock()
      const bodyBlock = createBlock()
      const exitBlock = createBlock()

      blocks.push(condBlock.block, bodyBlock.block, exitBlock.block)

      // jump from current to condition
      current.block.terminator = { kind: 'Jump', target: condBlock.block.id }
      current.sealed = true

      // condition branch
      const testExpr = convertExpression(stmt.test as BabelCore.types.Expression)
      condBlock.block.terminator = {
        kind: 'Branch',
        test: testExpr,
        consequent: bodyBlock.block.id,
        alternate: exitBlock.block.id,
      }
      condBlock.sealed = true

      // Push loop context for break/continue
      cfgContext.loopStack.push({
        breakTarget: exitBlock.block.id,
        continueTarget: condBlock.block.id,
      })

      // body: after body, jump back to condition (with nested control flow support)
      fillStatements(stmt.body, bodyBlock, condBlock.block.id, cfgContext)

      // Pop loop context
      cfgContext.loopStack.pop()

      current = exitBlock as BlockBuilder
      continue
    }
    if (t.isForStatement(stmt)) {
      const condBlock = createBlock()
      const bodyBlock = createBlock()
      const updateBlock = createBlock()
      const exitBlock = createBlock()

      blocks.push(condBlock.block, bodyBlock.block, updateBlock.block, exitBlock.block)

      // init in current block
      if (stmt.init && t.isVariableDeclaration(stmt.init)) {
        const initKind = normalizeVarKind(stmt.init.kind)
        for (const decl of stmt.init.declarations) {
          if (!t.isIdentifier(decl.id) || !decl.init) continue
          current.block.instructions.push({
            kind: 'Assign',
            target: { kind: 'Identifier', name: decl.id.name },
            value: convertExpression(decl.init),
            declarationKind: initKind,
          })
        }
      } else if (stmt.init && t.isExpression(stmt.init)) {
        current.block.instructions.push({
          kind: 'Expression',
          value: convertExpression(stmt.init),
        })
      }

      // jump to condition
      current.block.terminator = { kind: 'Jump', target: condBlock.block.id }
      current.sealed = true

      // condition
      const testExpr = stmt.test
        ? convertExpression(stmt.test as BabelCore.types.Expression)
        : undefined
      if (testExpr) {
        condBlock.block.terminator = {
          kind: 'Branch',
          test: testExpr,
          consequent: bodyBlock.block.id,
          alternate: exitBlock.block.id,
        }
      } else {
        // no test means always true
        condBlock.block.terminator = {
          kind: 'Jump',
          target: bodyBlock.block.id,
        }
      }
      condBlock.sealed = true

      // Push loop context for break/continue
      cfgContext.loopStack.push({
        breakTarget: exitBlock.block.id,
        continueTarget: updateBlock.block.id, // continue goes to update in for loop
      })

      // body (with nested control flow support)
      fillStatements(stmt.body, bodyBlock, updateBlock.block.id, cfgContext)

      // Pop loop context
      cfgContext.loopStack.pop()

      // update
      if (stmt.update && t.isExpression(stmt.update)) {
        updateBlock.block.instructions.push({
          kind: 'Expression',
          value: convertExpression(stmt.update),
        })
      }
      updateBlock.block.terminator = { kind: 'Jump', target: condBlock.block.id }
      updateBlock.sealed = true

      current = exitBlock as BlockBuilder
      continue
    }
    // Handle do-while at top level
    if (t.isDoWhileStatement(stmt)) {
      const bodyBlock = createBlock()
      const condBlock = createBlock()
      const exitBlock = createBlock()

      blocks.push(bodyBlock.block, condBlock.block, exitBlock.block)

      // Jump directly to body
      current.block.terminator = { kind: 'Jump', target: bodyBlock.block.id }
      current.sealed = true

      // Push loop context for break/continue BEFORE processing body
      cfgContext.loopStack.push({
        breakTarget: exitBlock.block.id,
        continueTarget: condBlock.block.id,
      })

      // Body goes to condition (with nested control flow support)
      fillStatements(stmt.body, bodyBlock, condBlock.block.id, cfgContext)

      // Pop loop context AFTER processing body
      cfgContext.loopStack.pop()

      // Condition branches back to body or exits
      const testExpr = convertExpression(stmt.test as BabelCore.types.Expression)
      condBlock.block.terminator = {
        kind: 'Branch',
        test: testExpr,
        consequent: bodyBlock.block.id,
        alternate: exitBlock.block.id,
      }
      condBlock.sealed = true

      current = exitBlock as BlockBuilder
      continue
    }
    // Handle switch at top level
    if (t.isSwitchStatement(stmt)) {
      const exitBlock = createBlock()
      blocks.push(exitBlock.block)

      const cases: { test?: Expression; target: number }[] = []
      let defaultTarget: number | undefined

      for (const switchCase of stmt.cases) {
        const caseBlock = createBlock()
        blocks.push(caseBlock.block)

        if (switchCase.test) {
          cases.push({
            test: convertExpression(switchCase.test as BabelCore.types.Expression),
            target: caseBlock.block.id,
          })
        } else {
          defaultTarget = caseBlock.block.id
        }

        // Process case statements
        let caseBuilder: BlockBuilder = caseBlock
        for (const s of switchCase.consequent) {
          if (t.isBreakStatement(s)) {
            caseBuilder.block.terminator = { kind: 'Jump', target: exitBlock.block.id }
            caseBuilder.sealed = true
            break
          }
          caseBuilder = processStatement(s, caseBuilder, exitBlock.block.id, cfgContext)
        }

        // Fall through if not sealed
        if (!caseBuilder.sealed) {
          caseBuilder.block.terminator = { kind: 'Jump', target: exitBlock.block.id }
          caseBuilder.sealed = true
        }
      }

      // Add default case
      if (defaultTarget === undefined) {
        cases.push({ target: exitBlock.block.id })
      } else {
        cases.push({ target: defaultTarget })
      }

      current.block.terminator = {
        kind: 'Switch',
        discriminant: convertExpression(stmt.discriminant as BabelCore.types.Expression),
        cases,
      }
      current.sealed = true

      current = exitBlock as BlockBuilder
      continue
    }
    // Handle for-of at top level
    if (t.isForOfStatement(stmt)) {
      const bodyBlock = createBlock()
      const exitBlock = createBlock()

      blocks.push(bodyBlock.block, exitBlock.block)

      // Get the iteration variable info (name, kind, pattern)
      const left = stmt.left
      let varName = '_item'
      let varKind: 'const' | 'let' | 'var' = 'const'
      let pattern: any = undefined

      if (t.isVariableDeclaration(left) && left.declarations[0]) {
        varKind = left.kind as 'const' | 'let' | 'var'
        const decl = left.declarations[0]
        if (t.isIdentifier(decl.id)) {
          varName = decl.id.name
        } else if (t.isObjectPattern(decl.id) || t.isArrayPattern(decl.id)) {
          // Destructuring pattern - store the pattern and generate a temp name
          varName = `__forOf_${bodyBlock.block.id}`
          pattern = decl.id
        }
      } else if (t.isIdentifier(left)) {
        varName = left.name
        varKind = 'let' // Existing variable assignment
      }

      // Create ForOf terminator
      const iterableExpr = convertExpression(stmt.right as BabelCore.types.Expression)

      current.block.terminator = {
        kind: 'ForOf',
        variable: varName,
        variableKind: varKind,
        pattern,
        iterable: iterableExpr,
        body: bodyBlock.block.id,
        exit: exitBlock.block.id,
      }
      current.sealed = true

      // Push loop context
      cfgContext.loopStack.push({
        breakTarget: exitBlock.block.id,
        continueTarget: bodyBlock.block.id,
      })

      // Process body
      fillStatements(stmt.body, bodyBlock, exitBlock.block.id, cfgContext)

      // Pop loop context
      cfgContext.loopStack.pop()

      current = exitBlock as BlockBuilder
      continue
    }
    // Handle for-in at top level
    if (t.isForInStatement(stmt)) {
      const bodyBlock = createBlock()
      const exitBlock = createBlock()

      blocks.push(bodyBlock.block, exitBlock.block)

      // Get the iteration variable info (name, kind, pattern)
      const left = stmt.left
      let varName = '_item'
      let varKind: 'const' | 'let' | 'var' = 'const'
      let pattern: any = undefined

      if (t.isVariableDeclaration(left) && left.declarations[0]) {
        varKind = left.kind as 'const' | 'let' | 'var'
        const decl = left.declarations[0]
        if (t.isIdentifier(decl.id)) {
          varName = decl.id.name
        } else if (t.isObjectPattern(decl.id) || t.isArrayPattern(decl.id)) {
          // Destructuring pattern - store the pattern and generate a temp name
          varName = `__forIn_${bodyBlock.block.id}`
          pattern = decl.id
        }
      } else if (t.isIdentifier(left)) {
        varName = left.name
        varKind = 'let' // Existing variable assignment
      }

      // Create ForIn terminator
      const objectExpr = convertExpression(stmt.right as BabelCore.types.Expression)

      current.block.terminator = {
        kind: 'ForIn',
        variable: varName,
        variableKind: varKind,
        pattern,
        object: objectExpr,
        body: bodyBlock.block.id,
        exit: exitBlock.block.id,
      }
      current.sealed = true

      // Push loop context
      cfgContext.loopStack.push({
        breakTarget: exitBlock.block.id,
        continueTarget: bodyBlock.block.id,
      })

      // Process body
      fillStatements(stmt.body, bodyBlock, exitBlock.block.id, cfgContext)

      // Pop loop context
      cfgContext.loopStack.pop()

      current = exitBlock as BlockBuilder
      continue
    }
    // Handle try-catch-finally at top level
    if (t.isTryStatement(stmt)) {
      const tryBlock = createBlock()
      const catchBlock = stmt.handler ? createBlock() : null
      const finallyBlock = stmt.finalizer ? createBlock() : null
      const exitBlock = createBlock()

      blocks.push(tryBlock.block, exitBlock.block)
      if (catchBlock) blocks.push(catchBlock.block)
      if (finallyBlock) blocks.push(finallyBlock.block)

      // Get catch param name
      let catchParamName: string | undefined
      if (stmt.handler?.param && t.isIdentifier(stmt.handler.param)) {
        catchParamName = stmt.handler.param.name
      }

      // Create Try terminator
      current.block.terminator = {
        kind: 'Try',
        tryBlock: tryBlock.block.id,
        catchBlock: catchBlock?.block.id,
        catchParam: catchParamName,
        finallyBlock: finallyBlock?.block.id,
        exit: exitBlock.block.id,
      }
      current.sealed = true

      // Process try block
      fillStatements(stmt.block, tryBlock, finallyBlock?.block.id ?? exitBlock.block.id, cfgContext)

      // Process catch block
      if (catchBlock && stmt.handler) {
        fillStatements(
          stmt.handler.body,
          catchBlock,
          finallyBlock?.block.id ?? exitBlock.block.id,
          cfgContext,
        )
      }

      // Process finally block
      if (finallyBlock && stmt.finalizer) {
        fillStatements(stmt.finalizer, finallyBlock, exitBlock.block.id, cfgContext)
      }

      current = exitBlock as BlockBuilder
      continue
    }
  }

  // Seal final block if not sealed
  if (!current.sealed) {
    current.block.terminator = { kind: 'Unreachable' }
    current.sealed = true
  }

  const hasNoMemo =
    !!options?.noMemo || hasNoMemoDirective(options?.directives ?? null) || hasNoMemoInBody
  const hasPure = !!options?.pure || hasPureDirective(options?.directives ?? null) || hasPureInBody
  const isAsync = !!options?.isAsync

  // Parse @fictReturn annotation for cross-module hook return info
  const fictReturnInfo = parseFictReturnAnnotation(options?.astNode)

  const hasMeta = hasNoMemo || hasPure || fictReturnInfo || isAsync

  return {
    rawParams: params,
    name,
    params: paramIds,
    blocks,
    meta: hasMeta
      ? {
          ...(hasNoMemo ? { noMemo: true } : null),
          ...(hasPure ? { pure: true } : null),
          ...(fictReturnInfo ? { hookReturnInfo: fictReturnInfo } : null),
          ...(isAsync ? { isAsync: true } : null),
        }
      : undefined,
    loc: options?.loc ?? null,
  }
}

/**
 * Build an HIR function from a list of statements.
 * Useful for lowering top-level (non-export) statement sequences with the same codegen path as functions.
 */
export function convertStatementsToHIRFunction(
  name: string,
  statements: BabelCore.types.Statement[],
): HIRFunction {
  return convertFunction(name, [], statements, { loc: getLoc(statements[0]) })
}

function convertAssignmentValue(expr: BabelCore.types.AssignmentExpression): Expression {
  const right = convertExpression(expr.right as BabelCore.types.Expression)
  if (expr.operator === '=') return right

  const operatorMap: Record<string, string> = {
    '+=': '+',
    '-=': '-',
    '*=': '*',
    '/=': '/',
    '%=': '%',
    '**=': '**',
  }
  const mapped = operatorMap[expr.operator]
  if (mapped && t.isIdentifier(expr.left)) {
    return {
      kind: 'BinaryExpression',
      operator: mapped,
      left: { kind: 'Identifier', name: expr.left.name },
      right,
    }
  }

  return right
}

type InstructionPush = (instr: BasicBlock['instructions'][number]) => void

function unwrapExpression(expr: BabelCore.types.Expression): BabelCore.types.Expression {
  let current: BabelCore.types.Expression = expr
  while (true) {
    if (
      t.isTSAsExpression(current) ||
      t.isTSTypeAssertion(current) ||
      t.isTSNonNullExpression(current) ||
      t.isTSSatisfiesExpression(current) ||
      t.isTSInstantiationExpression(current) ||
      t.isTypeCastExpression(current)
    ) {
      current = current.expression as BabelCore.types.Expression
      continue
    }
    if (t.isParenthesizedExpression(current)) {
      current = current.expression as BabelCore.types.Expression
      continue
    }
    return current
  }
}

function handleExpressionStatement(
  expr: BabelCore.types.Expression,
  push: InstructionPush,
): boolean {
  const unwrapped = unwrapExpression(expr)
  if (!t.isAssignmentExpression(unwrapped)) return false

  if (t.isIdentifier(unwrapped.left)) {
    push({
      kind: 'Assign',
      target: { kind: 'Identifier', name: unwrapped.left.name },
      value: convertAssignmentValue(unwrapped),
    })
    return true
  }

  return false
}

/**
 * Context for building nested control flow structures.
 * This enables recursive handling of if/for/while inside branches.
 */
interface LoopContext {
  breakTarget: number
  continueTarget: number
  label?: string
}

interface CFGBuildContext {
  blocks: BasicBlock[]
  nextBlockId: () => number
  createBlock: () => BlockBuilder
  loopStack: LoopContext[]
}

/**
 * Fill statements into a block, handling nested control flow recursively.
 * Returns the final block after processing all statements.
 */
function fillStatements(
  stmt: BabelCore.types.Statement,
  bb: BlockBuilder,
  jumpTarget: number,
  ctx?: CFGBuildContext,
): BlockBuilder {
  // Note: push and seal are not used directly here but kept for consistency
  // with processStatement. The function delegates to processStatement.

  if (t.isBlockStatement(stmt)) {
    let current = bb
    for (const s of stmt.body) {
      current = processStatement(s, current, jumpTarget, ctx)
      if (current.sealed) {
        // If sealed with return/throw, stop processing
        const term = current.block.terminator
        if (term.kind === 'Return' || term.kind === 'Throw') {
          return current
        }
      }
    }
    if (!current.sealed) {
      current.block.terminator = { kind: 'Jump', target: jumpTarget }
      current.sealed = true
    }
    return current
  }

  const result = processStatement(stmt, bb, jumpTarget, ctx)
  if (!result.sealed) {
    result.block.terminator = { kind: 'Jump', target: jumpTarget }
    result.sealed = true
  }
  return result
}

/**
 * Process a single statement, potentially creating new blocks for control flow.
 */
function processStatement(
  stmt: BabelCore.types.Statement,
  bb: BlockBuilder,
  jumpTarget: number,
  ctx?: CFGBuildContext,
): BlockBuilder {
  const push = (instr: BasicBlock['instructions'][number]) => bb.block.instructions.push(instr)

  if (t.isExpressionStatement(stmt)) {
    if (!handleExpressionStatement(stmt.expression, push)) {
      push({ kind: 'Expression', value: convertExpression(stmt.expression) })
    }
    return bb
  }

  if (t.isVariableDeclaration(stmt)) {
    for (const decl of stmt.declarations) {
      const declKind = normalizeVarKind(stmt.kind)
      if (t.isIdentifier(decl.id)) {
        push({
          kind: 'Assign',
          target: { kind: 'Identifier', name: decl.id.name },
          value: decl.init
            ? convertExpression(decl.init)
            : ({ kind: 'Literal', value: undefined } as HLiteral),
          declarationKind: declKind,
        })
        continue
      }
      if (t.isObjectPattern(decl.id)) {
        const tempName = `__destruct_${destructuringTempCounter++}`
        push({
          kind: 'Assign',
          target: { kind: 'Identifier', name: tempName },
          value: decl.init
            ? convertExpression(decl.init)
            : ({ kind: 'Literal', value: undefined } as HLiteral),
          declarationKind: declKind,
        })
        const excludeKeys: BabelCore.types.Expression[] = []
        decl.id.properties.forEach(prop => {
          if (t.isObjectProperty(prop)) {
            const keyName = t.isIdentifier(prop.key)
              ? prop.key.name
              : t.isStringLiteral(prop.key)
                ? prop.key.value
                : t.isNumericLiteral(prop.key)
                  ? String(prop.key.value)
                  : null
            if (!keyName) return
            excludeKeys.push(t.stringLiteral(keyName))
            if (t.isIdentifier(prop.value)) {
              const memberExpr = t.memberExpression(
                t.identifier(tempName),
                t.identifier(keyName),
                false,
              )
              push({
                kind: 'Assign',
                target: { kind: 'Identifier', name: prop.value.name },
                value: convertExpression(memberExpr),
                declarationKind: declKind,
              })
            }
          } else if (t.isRestElement(prop) && t.isIdentifier(prop.argument)) {
            const restExpr = t.callExpression(t.identifier('__fictPropsRest'), [
              t.identifier(tempName),
              t.arrayExpression(excludeKeys),
            ])
            push({
              kind: 'Assign',
              target: { kind: 'Identifier', name: prop.argument.name },
              value: convertExpression(restExpr),
              declarationKind: declKind,
            })
          }
        })
      }
      if (t.isArrayPattern(decl.id)) {
        const tempName = `__destruct_${destructuringTempCounter++}`
        push({
          kind: 'Assign',
          target: { kind: 'Identifier', name: tempName },
          value: decl.init
            ? convertExpression(decl.init)
            : ({ kind: 'Literal', value: undefined } as HLiteral),
          declarationKind: declKind,
        })
        decl.id.elements.forEach((elem, index) => {
          if (!elem) return
          if (t.isIdentifier(elem)) {
            const memberExpr = t.memberExpression(
              t.identifier(tempName),
              t.numericLiteral(index),
              true,
            )
            push({
              kind: 'Assign',
              target: { kind: 'Identifier', name: elem.name },
              value: convertExpression(memberExpr),
              declarationKind: declKind,
            })
          } else if (t.isRestElement(elem) && t.isIdentifier(elem.argument)) {
            const sliceCall = t.callExpression(
              t.memberExpression(t.identifier(tempName), t.identifier('slice')),
              [t.numericLiteral(index)],
            )
            push({
              kind: 'Assign',
              target: { kind: 'Identifier', name: elem.argument.name },
              value: convertExpression(sliceCall),
              declarationKind: declKind,
            })
          }
        })
      }
    }
    return bb
  }

  if (t.isFunctionDeclaration(stmt) && stmt.id) {
    const fnExpr = t.functionExpression(
      stmt.id,
      stmt.params as any,
      stmt.body,
      stmt.generator,
      stmt.async,
    )
    push({
      kind: 'Assign',
      target: { kind: 'Identifier', name: stmt.id.name },
      value: convertExpression(fnExpr),
      declarationKind: 'function',
    })
    return bb
  }

  if (t.isReturnStatement(stmt)) {
    bb.block.terminator = {
      kind: 'Return',
      argument: stmt.argument ? convertExpression(stmt.argument) : undefined,
    }
    bb.sealed = true
    return bb
  }

  if (t.isThrowStatement(stmt)) {
    bb.block.terminator = {
      kind: 'Throw',
      argument: convertExpression(stmt.argument as BabelCore.types.Expression),
    }
    bb.sealed = true
    return bb
  }

  // Handle break statement
  if (t.isBreakStatement(stmt) && ctx) {
    const label = stmt.label?.name
    const loopCtx = label
      ? ctx.loopStack.find(l => l.label === label)
      : ctx.loopStack[ctx.loopStack.length - 1]
    if (loopCtx) {
      bb.block.terminator = { kind: 'Break', target: loopCtx.breakTarget, label }
      bb.sealed = true
    } else {
      // Break statement outside of loop or labeled statement
      const message = label
        ? `Break statement with label '${label}' is not within a labeled statement`
        : 'Break statement is not within a loop or switch statement'
      throw new HIRError(message, 'BUILD_ERROR', { blockId: bb.block.id })
    }
    return bb
  }

  // Handle continue statement
  if (t.isContinueStatement(stmt) && ctx) {
    const label = stmt.label?.name
    const loopCtx = label
      ? ctx.loopStack.find(l => l.label === label)
      : ctx.loopStack[ctx.loopStack.length - 1]
    if (loopCtx) {
      bb.block.terminator = { kind: 'Continue', target: loopCtx.continueTarget, label }
      bb.sealed = true
    } else {
      // Continue statement outside of loop
      const message = label
        ? `Continue statement with label '${label}' is not within a labeled loop`
        : 'Continue statement is not within a loop'
      throw new HIRError(message, 'BUILD_ERROR', { blockId: bb.block.id })
    }
    return bb
  }

  // Handle nested if statement
  if (t.isIfStatement(stmt) && ctx) {
    const consequentBlock = ctx.createBlock()
    const alternateBlock = ctx.createBlock()
    const joinBlock = ctx.createBlock()

    ctx.blocks.push(consequentBlock.block, alternateBlock.block, joinBlock.block)

    // Branch from current block
    const testExpr = convertExpression(stmt.test as BabelCore.types.Expression)
    bb.block.terminator = {
      kind: 'Branch',
      test: testExpr,
      consequent: consequentBlock.block.id,
      alternate: alternateBlock.block.id,
    }
    bb.sealed = true

    // Fill consequent
    fillStatements(stmt.consequent, consequentBlock, joinBlock.block.id, ctx)

    // Fill alternate
    if (stmt.alternate) {
      fillStatements(stmt.alternate, alternateBlock, joinBlock.block.id, ctx)
    } else {
      alternateBlock.block.terminator = { kind: 'Jump', target: joinBlock.block.id }
      alternateBlock.sealed = true
    }

    return joinBlock
  }

  // Handle nested while statement
  if (t.isWhileStatement(stmt) && ctx) {
    const condBlock = ctx.createBlock()
    const bodyBlock = ctx.createBlock()
    const exitBlock = ctx.createBlock()

    ctx.blocks.push(condBlock.block, bodyBlock.block, exitBlock.block)

    // Jump to condition
    bb.block.terminator = { kind: 'Jump', target: condBlock.block.id }
    bb.sealed = true

    // Condition branch
    const testExpr = convertExpression(stmt.test as BabelCore.types.Expression)
    condBlock.block.terminator = {
      kind: 'Branch',
      test: testExpr,
      consequent: bodyBlock.block.id,
      alternate: exitBlock.block.id,
    }
    condBlock.sealed = true

    // Push loop context for break/continue (while has no label here, but could be wrapped by LabeledStatement)
    ctx.loopStack.push({
      breakTarget: exitBlock.block.id,
      continueTarget: condBlock.block.id,
    })

    // Body loops back to condition
    fillStatements(stmt.body, bodyBlock, condBlock.block.id, ctx)

    // Pop loop context
    ctx.loopStack.pop()

    return exitBlock
  }

  // Handle nested for statement
  if (t.isForStatement(stmt) && ctx) {
    const condBlock = ctx.createBlock()
    const bodyBlock = ctx.createBlock()
    const updateBlock = ctx.createBlock()
    const exitBlock = ctx.createBlock()

    ctx.blocks.push(condBlock.block, bodyBlock.block, updateBlock.block, exitBlock.block)

    // Init in current block
    if (stmt.init && t.isVariableDeclaration(stmt.init)) {
      const initKind = normalizeVarKind(stmt.init.kind)
      for (const decl of stmt.init.declarations) {
        if (!t.isIdentifier(decl.id) || !decl.init) continue
        push({
          kind: 'Assign',
          target: { kind: 'Identifier', name: decl.id.name },
          value: convertExpression(decl.init),
          declarationKind: initKind,
        })
      }
    } else if (stmt.init && t.isExpression(stmt.init)) {
      push({
        kind: 'Expression',
        value: convertExpression(stmt.init),
      })
    }

    // Jump to condition
    bb.block.terminator = { kind: 'Jump', target: condBlock.block.id }
    bb.sealed = true

    // Condition
    const testExpr = stmt.test
      ? convertExpression(stmt.test as BabelCore.types.Expression)
      : undefined
    if (testExpr) {
      condBlock.block.terminator = {
        kind: 'Branch',
        test: testExpr,
        consequent: bodyBlock.block.id,
        alternate: exitBlock.block.id,
      }
    } else {
      condBlock.block.terminator = { kind: 'Jump', target: bodyBlock.block.id }
    }
    condBlock.sealed = true

    // Push loop context for break/continue
    ctx.loopStack.push({
      breakTarget: exitBlock.block.id,
      continueTarget: updateBlock.block.id, // continue goes to update in for loop
    })

    // Body goes to update
    fillStatements(stmt.body, bodyBlock, updateBlock.block.id, ctx)

    // Pop loop context
    ctx.loopStack.pop()

    // Update loops back to condition
    if (stmt.update && t.isExpression(stmt.update)) {
      updateBlock.block.instructions.push({
        kind: 'Expression',
        value: convertExpression(stmt.update),
      })
    }
    updateBlock.block.terminator = { kind: 'Jump', target: condBlock.block.id }
    updateBlock.sealed = true

    return exitBlock
  }

  // Handle do-while statement
  if (t.isDoWhileStatement(stmt) && ctx) {
    const bodyBlock = ctx.createBlock()
    const condBlock = ctx.createBlock()
    const exitBlock = ctx.createBlock()

    ctx.blocks.push(bodyBlock.block, condBlock.block, exitBlock.block)

    // Jump directly to body (do-while executes body first)
    bb.block.terminator = { kind: 'Jump', target: bodyBlock.block.id }
    bb.sealed = true

    // Push loop context for break/continue BEFORE processing body
    ctx.loopStack.push({
      breakTarget: exitBlock.block.id,
      continueTarget: condBlock.block.id,
    })

    // Body goes to condition
    fillStatements(stmt.body, bodyBlock, condBlock.block.id, ctx)

    // Pop loop context AFTER processing body
    ctx.loopStack.pop()

    // Condition branches back to body or exits
    const testExpr = convertExpression(stmt.test as BabelCore.types.Expression)
    condBlock.block.terminator = {
      kind: 'Branch',
      test: testExpr,
      consequent: bodyBlock.block.id,
      alternate: exitBlock.block.id,
    }
    condBlock.sealed = true

    return exitBlock
  }

  // Handle for-in statement
  if (t.isForInStatement(stmt) && ctx) {
    const bodyBlock = ctx.createBlock()
    const exitBlock = ctx.createBlock()

    ctx.blocks.push(bodyBlock.block, exitBlock.block)

    // Get the iteration variable info (name, kind, pattern)
    const left = stmt.left
    let varName = '_item'
    let varKind: 'const' | 'let' | 'var' = 'const'
    let pattern: any = undefined

    if (t.isVariableDeclaration(left) && left.declarations[0]) {
      varKind = left.kind as 'const' | 'let' | 'var'
      const decl = left.declarations[0]
      if (t.isIdentifier(decl.id)) {
        varName = decl.id.name
      } else if (t.isObjectPattern(decl.id) || t.isArrayPattern(decl.id)) {
        varName = `__forIn_${bodyBlock.block.id}`
        pattern = decl.id
      }
    } else if (t.isIdentifier(left)) {
      varName = left.name
      varKind = 'let'
    }

    // Create ForIn terminator
    const objectExpr = convertExpression(stmt.right as BabelCore.types.Expression)

    bb.block.terminator = {
      kind: 'ForIn',
      variable: varName,
      variableKind: varKind,
      pattern,
      object: objectExpr,
      body: bodyBlock.block.id,
      exit: exitBlock.block.id,
    }
    bb.sealed = true

    // Push loop context
    ctx.loopStack.push({
      breakTarget: exitBlock.block.id,
      continueTarget: bodyBlock.block.id,
    })

    // Process body
    fillStatements(stmt.body, bodyBlock, exitBlock.block.id, ctx)

    // Pop loop context
    ctx.loopStack.pop()

    return exitBlock
  }

  // Handle for-of statement
  if (t.isForOfStatement(stmt) && ctx) {
    const bodyBlock = ctx.createBlock()
    const exitBlock = ctx.createBlock()

    ctx.blocks.push(bodyBlock.block, exitBlock.block)

    // Get the iteration variable info (name, kind, pattern)
    const left = stmt.left
    let varName = '_item'
    let varKind: 'const' | 'let' | 'var' = 'const'
    let pattern: any = undefined

    if (t.isVariableDeclaration(left) && left.declarations[0]) {
      varKind = left.kind as 'const' | 'let' | 'var'
      const decl = left.declarations[0]
      if (t.isIdentifier(decl.id)) {
        varName = decl.id.name
      } else if (t.isObjectPattern(decl.id) || t.isArrayPattern(decl.id)) {
        varName = `__forOf_${bodyBlock.block.id}`
        pattern = decl.id
      }
    } else if (t.isIdentifier(left)) {
      varName = left.name
      varKind = 'let'
    }

    // Create ForOf terminator
    const iterableExpr = convertExpression(stmt.right as BabelCore.types.Expression)

    bb.block.terminator = {
      kind: 'ForOf',
      variable: varName,
      variableKind: varKind,
      pattern,
      iterable: iterableExpr,
      body: bodyBlock.block.id,
      exit: exitBlock.block.id,
    }
    bb.sealed = true

    // Push loop context
    ctx.loopStack.push({
      breakTarget: exitBlock.block.id,
      continueTarget: bodyBlock.block.id,
    })

    // Process body
    fillStatements(stmt.body, bodyBlock, exitBlock.block.id, ctx)

    // Pop loop context
    ctx.loopStack.pop()

    return exitBlock
  }

  // Handle switch statement
  if (t.isSwitchStatement(stmt) && ctx) {
    const exitBlock = ctx.createBlock()
    ctx.blocks.push(exitBlock.block)

    const cases: { test?: Expression; target: number }[] = []
    let defaultTarget: number | undefined

    for (const switchCase of stmt.cases) {
      const caseBlock = ctx.createBlock()
      ctx.blocks.push(caseBlock.block)

      if (switchCase.test) {
        cases.push({
          test: convertExpression(switchCase.test as BabelCore.types.Expression),
          target: caseBlock.block.id,
        })
      } else {
        defaultTarget = caseBlock.block.id
      }

      // Process case statements
      let current = caseBlock
      for (const s of switchCase.consequent) {
        if (t.isBreakStatement(s)) {
          current.block.terminator = { kind: 'Jump', target: exitBlock.block.id }
          current.sealed = true
          break
        }
        current = processStatement(s, current, exitBlock.block.id, ctx)
      }

      // Fall through to next case if not sealed
      if (!current.sealed) {
        current.block.terminator = { kind: 'Jump', target: exitBlock.block.id }
        current.sealed = true
      }
    }

    // Add default case if not present
    if (defaultTarget === undefined) {
      cases.push({ target: exitBlock.block.id })
    } else {
      cases.push({ target: defaultTarget })
    }

    bb.block.terminator = {
      kind: 'Switch',
      discriminant: convertExpression(stmt.discriminant as BabelCore.types.Expression),
      cases,
    }
    bb.sealed = true

    return exitBlock
  }

  // Handle try-catch-finally
  if (t.isTryStatement(stmt) && ctx) {
    const tryBlock = ctx.createBlock()
    const catchBlock = stmt.handler ? ctx.createBlock() : null
    const finallyBlock = stmt.finalizer ? ctx.createBlock() : null
    const exitBlock = ctx.createBlock()

    ctx.blocks.push(tryBlock.block, exitBlock.block)
    if (catchBlock) ctx.blocks.push(catchBlock.block)
    if (finallyBlock) ctx.blocks.push(finallyBlock.block)

    // Get catch param name
    let catchParamName: string | undefined
    if (stmt.handler?.param && t.isIdentifier(stmt.handler.param)) {
      catchParamName = stmt.handler.param.name
    }

    // Create Try terminator
    bb.block.terminator = {
      kind: 'Try',
      tryBlock: tryBlock.block.id,
      catchBlock: catchBlock?.block.id,
      catchParam: catchParamName,
      finallyBlock: finallyBlock?.block.id,
      exit: exitBlock.block.id,
    }
    bb.sealed = true

    // Process try block
    fillStatements(stmt.block, tryBlock, finallyBlock?.block.id ?? exitBlock.block.id, ctx)

    // Process catch block
    if (catchBlock && stmt.handler) {
      fillStatements(
        stmt.handler.body,
        catchBlock,
        finallyBlock?.block.id ?? exitBlock.block.id,
        ctx,
      )
    }

    // Process finally block
    if (finallyBlock && stmt.finalizer) {
      fillStatements(stmt.finalizer, finallyBlock, exitBlock.block.id, ctx)
    }

    return exitBlock
  }

  // Fallback: seal with jump
  if (!bb.sealed) {
    bb.block.terminator = { kind: 'Jump', target: jumpTarget }
    bb.sealed = true
  }
  return bb
}

function convertExpression(node: BabelCore.types.Expression): Expression {
  const loc = getLoc(node)
  const convertCallArguments = (
    args: (
      | BabelCore.types.Expression
      | BabelCore.types.SpreadElement
      | BabelCore.types.ArgumentPlaceholder
    )[],
  ): Expression[] =>
    args
      .map(arg => {
        if (t.isSpreadElement(arg)) {
          return {
            kind: 'SpreadElement',
            argument: convertExpression(arg.argument as BabelCore.types.Expression),
            loc: getLoc(arg),
          } as HSpreadElement
        }
        if (t.isExpression(arg)) return convertExpression(arg)
        return undefined
      })
      .filter(Boolean) as Expression[]

  if (t.isParenthesizedExpression(node) && t.isExpression(node.expression)) {
    return convertExpression(node.expression)
  }
  if (
    (t.isTSAsExpression(node) ||
      t.isTSTypeAssertion(node) ||
      t.isTSNonNullExpression(node) ||
      t.isTSSatisfiesExpression(node) ||
      t.isTSInstantiationExpression(node) ||
      t.isTypeCastExpression(node)) &&
    t.isExpression(node.expression)
  ) {
    return convertExpression(node.expression)
  }

  if (t.isImportExpression(node)) {
    return {
      kind: 'ImportExpression',
      source: convertExpression(node.source as BabelCore.types.Expression),
      loc,
    }
  }

  if (t.isMetaProperty(node)) {
    return {
      kind: 'MetaProperty',
      meta: { kind: 'Identifier', name: node.meta.name, loc: getLoc(node.meta) } as HIdentifier,
      property: {
        kind: 'Identifier',
        name: node.property.name,
        loc: getLoc(node.property),
      } as HIdentifier,
      loc,
    }
  }

  if (t.isIdentifier(node)) return { kind: 'Identifier', name: node.name, loc }
  if (t.isBigIntLiteral(node)) {
    return { kind: 'Literal', value: BigInt(node.value), loc } as HLiteral
  }
  if (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node)
  )
    return { kind: 'Literal', value: (node as any).value ?? null, loc } as HLiteral
  if (t.isRegExpLiteral(node)) {
    return {
      kind: 'Literal',
      value: new RegExp(node.pattern, node.flags ?? ''),
      loc,
    } as HLiteral
  }
  if (t.isCallExpression(node) && t.isImport(node.callee)) {
    const firstArg = node.arguments[0]
    const source = t.isExpression(firstArg)
      ? convertExpression(firstArg)
      : ({ kind: 'Literal', value: undefined, loc } as HLiteral)
    return { kind: 'ImportExpression', source, loc }
  }
  if (t.isCallExpression(node)) {
    const callee = normalizeMacroCallee(node.callee as BabelCore.types.Expression)
    const pure = hasPureAnnotation(node) || hasPureAnnotation(node.callee as any)
    const call: HCallExpression = {
      kind: 'CallExpression',
      callee: convertExpression(callee),
      arguments: convertCallArguments(node.arguments),
      ...(pure ? { pure: true } : null),
      loc,
    }
    return call
  }
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    const propertyNode = t.isPrivateName(node.property)
      ? t.identifier(node.property.id.name)
      : (node.property as BabelCore.types.Node)
    const isOptional = t.isOptionalMemberExpression(node)
    const object = convertExpression(node.object as BabelCore.types.Expression)
    const property = t.isExpression(propertyNode)
      ? convertExpression(propertyNode)
      : ({ kind: 'Literal', value: undefined } as HLiteral)

    if (isOptional) {
      // Use OptionalMemberExpression for proper dependency tracking
      const optionalMember: Expression = {
        kind: 'OptionalMemberExpression',
        object,
        property,
        computed: node.computed,
        optional: node.optional ?? true,
        loc,
      }
      return optionalMember
    }

    const member: HMemberExpression = {
      kind: 'MemberExpression',
      object,
      property,
      computed: node.computed,
      optional: false,
      loc,
    }
    return member
  }
  if (t.isBinaryExpression(node)) {
    const bin: HBinaryExpression = {
      kind: 'BinaryExpression',
      operator: node.operator,
      left: convertExpression(node.left as BabelCore.types.Expression),
      right: convertExpression(node.right as BabelCore.types.Expression),
      loc,
    }
    return bin
  }
  if (t.isUnaryExpression(node)) {
    const un: HUnaryExpression = {
      kind: 'UnaryExpression',
      operator: node.operator,
      argument: convertExpression(node.argument as BabelCore.types.Expression),
      prefix: node.prefix,
      loc,
    }
    return un
  }
  if (t.isLogicalExpression(node)) {
    const log: HLogicalExpression = {
      kind: 'LogicalExpression',
      operator: node.operator as HLogicalExpression['operator'],
      left: convertExpression(node.left as BabelCore.types.Expression),
      right: convertExpression(node.right as BabelCore.types.Expression),
      loc,
    }
    return log
  }
  if (t.isConditionalExpression(node)) {
    const cond: HConditionalExpression = {
      kind: 'ConditionalExpression',
      test: convertExpression(node.test as BabelCore.types.Expression),
      consequent: convertExpression(node.consequent as BabelCore.types.Expression),
      alternate: convertExpression(node.alternate as BabelCore.types.Expression),
      loc,
    }
    return cond
  }
  if (t.isArrayExpression(node)) {
    const arr: HArrayExpression = {
      kind: 'ArrayExpression',
      elements: (node.elements ?? [])
        .map(el => {
          if (!el) return undefined
          if (t.isSpreadElement(el)) {
            return {
              kind: 'SpreadElement',
              argument: convertExpression(el.argument as BabelCore.types.Expression),
              loc: getLoc(el),
            } as HSpreadElement
          }
          if (t.isExpression(el)) return convertExpression(el)
          return undefined
        })
        .filter(Boolean) as Expression[],
      loc,
    }
    return arr
  }
  if (t.isObjectExpression(node)) {
    const obj: HObjectExpression = {
      kind: 'ObjectExpression',
      properties: node.properties
        .map(prop => {
          if (t.isSpreadElement(prop)) {
            // Handle spread elements
            return {
              kind: 'SpreadElement',
              argument: convertExpression(prop.argument as BabelCore.types.Expression),
              loc: getLoc(prop),
            } as HSpreadElement
          }
          if (t.isObjectMethod(prop)) {
            if (prop.computed) return undefined
            const keyExpr = t.isIdentifier(prop.key)
              ? ({ kind: 'Identifier', name: prop.key.name } as HIdentifier)
              : t.isStringLiteral(prop.key)
                ? ({ kind: 'Literal', value: prop.key.value } as HLiteral)
                : t.isNumericLiteral(prop.key)
                  ? ({ kind: 'Literal', value: prop.key.value } as HLiteral)
                  : undefined
            if (!keyExpr) return undefined
            const fnExpr = t.functionExpression(
              null,
              prop.params,
              prop.body,
              prop.generator,
              prop.async,
            )
            return {
              kind: 'Property',
              key: keyExpr,
              value: convertExpression(fnExpr),
              loc: getLoc(prop),
            }
          }
          if (!t.isObjectProperty(prop) || prop.computed) return undefined
          const keyExpr = t.isIdentifier(prop.key)
            ? ({ kind: 'Identifier', name: prop.key.name } as HIdentifier)
            : t.isStringLiteral(prop.key)
              ? ({ kind: 'Literal', value: prop.key.value } as HLiteral)
              : t.isNumericLiteral(prop.key)
                ? ({ kind: 'Literal', value: prop.key.value } as HLiteral)
                : undefined
          if (!keyExpr) return undefined
          if (!t.isExpression(prop.value)) return undefined
          return {
            kind: 'Property',
            key: keyExpr,
            value: convertExpression(prop.value),
            shorthand: prop.shorthand && t.isIdentifier(prop.value),
            loc: getLoc(prop),
          }
        })
        .filter(Boolean) as HObjectExpression['properties'],
      loc,
    }
    return obj
  }

  // JSX Element
  if (t.isJSXElement(node)) {
    return convertJSXElement(node)
  }

  // JSX Fragment - return as Fragment VNode with children
  if (t.isJSXFragment(node)) {
    const children: HJSXChild[] = []
    for (const child of node.children) {
      if (t.isJSXText(child)) {
        const text = child.value
        if (text.trim()) {
          children.push({ kind: 'text', value: text, loc: getLoc(child) })
        }
      } else if (t.isJSXExpressionContainer(child)) {
        if (!t.isJSXEmptyExpression(child.expression)) {
          children.push({
            kind: 'expression',
            value: convertExpression(child.expression as BabelCore.types.Expression),
            loc: getLoc(child),
          })
        }
      } else if (t.isJSXElement(child)) {
        children.push({
          kind: 'element',
          value: convertJSXElement(child),
          loc: getLoc(child),
        })
      } else if (t.isJSXFragment(child)) {
        // Nested fragment - flatten its children
        for (const fragChild of child.children) {
          if (t.isJSXText(fragChild)) {
            const text = fragChild.value
            if (text.trim()) {
              children.push({ kind: 'text', value: text, loc: getLoc(fragChild) })
            }
          } else if (t.isJSXExpressionContainer(fragChild)) {
            if (!t.isJSXEmptyExpression(fragChild.expression)) {
              children.push({
                kind: 'expression',
                value: convertExpression(fragChild.expression as BabelCore.types.Expression),
                loc: getLoc(fragChild),
              })
            }
          } else if (t.isJSXElement(fragChild)) {
            children.push({
              kind: 'element',
              value: convertJSXElement(fragChild),
              loc: getLoc(fragChild),
            })
          }
        }
      }
    }
    // Return as JSXElement with Fragment type
    return {
      kind: 'JSXElement',
      tagName: { kind: 'Identifier', name: 'Fragment', loc: getLoc(node) } as HIdentifier,
      isComponent: true,
      attributes: [],
      children,
      loc: getLoc(node),
    } as HJSXElementExpression
  }

  // Arrow Function Expression
  if (t.isArrowFunctionExpression(node)) {
    if (t.isBlockStatement(node.body)) {
      const nested = convertFunction(undefined, node.params, node.body.body, {
        noMemo: hasNoMemoDirectiveInStatements(node.body.body),
        pure: hasPureDirectiveInStatements(node.body.body),
        directives: node.body.directives,
        loc: getLoc(node),
        astNode: node,
      })
      const arrow: HArrowFunctionExpression = {
        kind: 'ArrowFunction',
        params: nested.params,
        body: nested.blocks,
        isExpression: false,
        isAsync: node.async,
        loc,
      }
      return arrow
    } else {
      const arrow: HArrowFunctionExpression = {
        kind: 'ArrowFunction',
        params: node.params
          .map(p =>
            t.isPattern(p)
              ? extractIdentifiersFromPattern(p)
              : t.isIdentifier(p)
                ? [{ kind: 'Identifier' as const, name: p.name }]
                : [],
          )
          .flat(),
        body: convertExpression(node.body as BabelCore.types.Expression),
        isExpression: true,
        isAsync: node.async,
        loc,
      }
      return arrow
    }
  }

  // Function Expression
  if (t.isFunctionExpression(node)) {
    const nested = convertFunction(undefined, node.params, node.body.body, {
      noMemo: hasNoMemoDirectiveInStatements(node.body.body),
      pure: hasPureDirectiveInStatements(node.body.body),
      directives: node.body.directives,
      loc: getLoc(node),
      astNode: node,
    })
    const fn: HFunctionExpression = {
      kind: 'FunctionExpression',
      name: node.id?.name ?? '',
      params: nested.params,
      body: nested.blocks,
      isAsync: node.async,
      loc,
    }
    return fn
  }

  // Assignment Expression
  if (t.isAssignmentExpression(node)) {
    if (!t.isExpression(node.left)) {
      const isDestructuring = t.isArrayPattern(node.left) || t.isObjectPattern(node.left)
      const message = isDestructuring
        ? 'Destructuring assignment should have been expanded before HIR conversion.'
        : `Unsupported assignment target '${(node.left as any).type}' in HIR conversion`
      return reportUnsupportedExpression(node.left, message)
    }
    const assign: HAssignmentExpression = {
      kind: 'AssignmentExpression',
      operator: node.operator,
      left: convertExpression(node.left as BabelCore.types.Expression),
      right: convertExpression(node.right as BabelCore.types.Expression),
      loc,
    }
    return assign
  }

  // Update Expression
  if (t.isUpdateExpression(node)) {
    const update: HUpdateExpression = {
      kind: 'UpdateExpression',
      operator: node.operator as '++' | '--',
      argument: convertExpression(node.argument as BabelCore.types.Expression),
      prefix: node.prefix,
      loc,
    }
    return update
  }

  // Template Literal
  if (t.isTemplateLiteral(node)) {
    const template: HTemplateLiteral = {
      kind: 'TemplateLiteral',
      quasis: node.quasis.map(q => q.value.cooked ?? q.value.raw),
      expressions: node.expressions.map(e => convertExpression(e as BabelCore.types.Expression)),
      loc,
    }
    return template
  }

  // Await Expression
  if (t.isAwaitExpression(node)) {
    return {
      kind: 'AwaitExpression',
      argument: convertExpression(node.argument as BabelCore.types.Expression),
      loc,
    }
  }

  // New Expression
  if (t.isNewExpression(node)) {
    return {
      kind: 'NewExpression',
      callee: convertExpression(node.callee as BabelCore.types.Expression),
      arguments: convertCallArguments(node.arguments),
      loc,
    }
  }

  // Sequence Expression
  if (t.isSequenceExpression(node)) {
    return {
      kind: 'SequenceExpression',
      expressions: node.expressions.map(e => convertExpression(e)),
      loc,
    }
  }

  // Yield Expression
  if (t.isYieldExpression(node)) {
    return {
      kind: 'YieldExpression',
      argument: node.argument ? convertExpression(node.argument) : null,
      delegate: node.delegate,
      loc,
    }
  }

  // Optional Call Expression
  if (t.isOptionalCallExpression(node)) {
    const callee = normalizeMacroCallee(node.callee as BabelCore.types.Expression)
    return {
      kind: 'OptionalCallExpression',
      callee: convertExpression(callee),
      arguments: convertCallArguments(node.arguments),
      optional: node.optional,
      ...(hasPureAnnotation(node) || hasPureAnnotation(node.callee as any) ? { pure: true } : null),
      loc,
    }
  }

  // Tagged Template Expression
  if (t.isTaggedTemplateExpression(node)) {
    return {
      kind: 'TaggedTemplateExpression',
      tag: convertExpression(node.tag),
      quasi: {
        kind: 'TemplateLiteral',
        quasis: node.quasi.quasis.map(q => q.value.cooked ?? q.value.raw),
        expressions: node.quasi.expressions.map(e =>
          convertExpression(e as BabelCore.types.Expression),
        ),
        loc: getLoc(node.quasi),
      },
      loc,
    }
  }

  // Class Expression
  if (t.isClassExpression(node)) {
    return {
      kind: 'ClassExpression',
      name: node.id?.name,
      superClass: node.superClass ? convertExpression(node.superClass) : undefined,
      body: node.body.body, // Store as Babel AST for now
      loc,
    }
  }

  // This Expression
  if (t.isThisExpression(node)) {
    return { kind: 'ThisExpression', loc }
  }

  // Super Expression
  if (t.isSuper(node)) {
    return { kind: 'SuperExpression', loc }
  }

  return reportUnsupportedExpression(node)
}

function convertJSXElement(node: BabelCore.types.JSXElement): HJSXElementExpression {
  const opening = node.openingElement
  let tagName: string | Expression
  let isComponent = false

  if (t.isJSXIdentifier(opening.name)) {
    const name = opening.name.name
    const firstChar = name[0]
    if (firstChar && firstChar === firstChar.toUpperCase()) {
      // Component
      tagName = { kind: 'Identifier', name, loc: getLoc(opening.name) } as HIdentifier
      isComponent = true
    } else {
      // Intrinsic element
      tagName = name
    }
  } else if (t.isJSXMemberExpression(opening.name)) {
    // Component.SubComponent
    tagName = convertJSXMemberExpr(opening.name)
    isComponent = true
  } else {
    tagName = 'div' // fallback
  }

  const attributes: HJSXAttribute[] = []
  for (const attr of opening.attributes) {
    if (t.isJSXSpreadAttribute(attr)) {
      attributes.push({
        name: '',
        value: null,
        isSpread: true,
        spreadExpr: convertExpression(attr.argument as BabelCore.types.Expression),
        loc: getLoc(attr),
      })
    } else if (t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name)) {
      let value: Expression | null = null
      if (attr.value) {
        if (t.isStringLiteral(attr.value)) {
          value = { kind: 'Literal', value: attr.value.value, loc: getLoc(attr.value) } as HLiteral
        } else if (
          t.isJSXExpressionContainer(attr.value) &&
          !t.isJSXEmptyExpression(attr.value.expression)
        ) {
          value = convertExpression(attr.value.expression as BabelCore.types.Expression)
        }
      }
      attributes.push({
        name: attr.name.name,
        value,
        loc: getLoc(attr),
      })
    }
  }

  const children: HJSXChild[] = []
  for (const child of node.children) {
    if (t.isJSXText(child)) {
      const text = child.value
      if (text.trim()) {
        children.push({ kind: 'text', value: text, loc: getLoc(child) })
      }
    } else if (t.isJSXExpressionContainer(child)) {
      if (!t.isJSXEmptyExpression(child.expression)) {
        children.push({
          kind: 'expression',
          value: convertExpression(child.expression as BabelCore.types.Expression),
          loc: getLoc(child),
        })
      }
    } else if (t.isJSXElement(child)) {
      children.push({
        kind: 'element',
        value: convertJSXElement(child),
        loc: getLoc(child),
      })
    } else if (t.isJSXFragment(child)) {
      // Flatten fragment children
      for (const fragChild of child.children) {
        if (t.isJSXText(fragChild)) {
          const text = fragChild.value
          if (text.trim()) {
            children.push({ kind: 'text', value: text, loc: getLoc(fragChild) })
          }
        } else if (t.isJSXExpressionContainer(fragChild)) {
          if (!t.isJSXEmptyExpression(fragChild.expression)) {
            children.push({
              kind: 'expression',
              value: convertExpression(fragChild.expression as BabelCore.types.Expression),
              loc: getLoc(fragChild),
            })
          }
        } else if (t.isJSXElement(fragChild)) {
          children.push({
            kind: 'element',
            value: convertJSXElement(fragChild),
            loc: getLoc(fragChild),
          })
        }
      }
    }
  }

  return {
    kind: 'JSXElement',
    tagName,
    isComponent,
    attributes,
    children,
    loc: getLoc(node),
  }
}

function convertJSXMemberExpr(node: BabelCore.types.JSXMemberExpression): Expression {
  let object: Expression
  if (t.isJSXIdentifier(node.object)) {
    object = { kind: 'Identifier', name: node.object.name, loc: getLoc(node.object) } as HIdentifier
  } else {
    object = convertJSXMemberExpr(node.object)
  }
  return {
    kind: 'MemberExpression',
    object,
    property: {
      kind: 'Identifier',
      name: node.property.name,
      loc: getLoc(node.property),
    } as HIdentifier,
    computed: false,
    loc: getLoc(node),
  }
}
