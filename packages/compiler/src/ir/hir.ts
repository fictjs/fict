import type {
  ClassBody,
  Decorator,
  Directive,
  LVal,
  Node,
  SourceLocation,
  Statement,
} from '@babel/types'

import type { ReactiveExportKind } from '../types'

import type { FictMacroKind } from './macro-bindings'

/**
 * High-level Intermediate Representation (HIR) scaffolding.
 *
 * This is a minimal, non-executing definition set meant to unblock
 * the HIR/SSA pipeline. It keeps constructs high-level
 * (conditionals/loops/logical expressions) to preserve source shape.
 */

// ============================================================================
// Babel AST Passthrough Types
// ============================================================================

/**
 * Type alias for Babel Statement nodes that are passed through unchanged.
 * These represent preamble (imports) and postamble (exports) statements.
 */
export type BabelStatement = Statement

/**
 * Type alias for Babel directive prologue entries that should be re-emitted.
 */
export type BabelDirective = Directive

/**
 * Type alias for class body members from Babel AST.
 */
export type BabelClassMember = ClassBody['body'][number]

/**
 * Type alias for class decorators from Babel AST.
 */
export type BabelDecorator = Decorator

/**
 * Type alias for function parameter nodes from Babel AST.
 * These are preserved for proper props pattern lowering.
 * Includes Identifier, Pattern (ObjectPattern, ArrayPattern), and RestElement.
 */
export type BabelParamNode = Node

/**
 * Marker for a function that was extracted and needs to be re-exported.
 * Used in postamble to reconstruct export statements during codegen.
 */
export interface ExportFunctionMarker {
  kind: 'ExportFunction'
  name: string | undefined
}

/**
 * Marker for a default export that was extracted.
 */
export interface ExportDefaultMarker {
  kind: 'ExportDefault'
  name: string | null
}

/**
 * Items that can appear in preamble/postamble.
 * Can be either Babel Statement nodes or HIR-specific markers.
 */
export type PreambleItem = BabelStatement
export type PostambleItem = BabelStatement | ExportFunctionMarker | ExportDefaultMarker

/**
 * Unified error class for HIR-related errors.
 * Provides consistent error reporting across the HIR pipeline.
 */
export class HIRError extends Error {
  constructor(
    message: string,
    public readonly code: HIRErrorCode,
    public readonly context?: {
      blockId?: BlockId | undefined
      variable?: string | undefined
      file?: string | undefined
      line?: number | undefined
    },
  ) {
    super(`[HIR] ${message}`)
    this.name = 'HIRError'
  }

  /**
   * Create a formatted error message with context
   */
  toString(): string {
    let msg = this.message
    if (this.context) {
      const parts: string[] = []
      if (this.context.file) parts.push(`file: ${this.context.file}`)
      if (this.context.line) parts.push(`line: ${this.context.line}`)
      if (this.context.blockId !== undefined) parts.push(`block: ${this.context.blockId}`)
      if (this.context.variable) parts.push(`variable: ${this.context.variable}`)
      if (parts.length > 0) {
        msg += ` (${parts.join(', ')})`
      }
    }
    return msg
  }
}

/**
 * Error codes for HIR-related errors
 */
export type HIRErrorCode =
  | 'BUILD_ERROR' // Error during HIR construction
  | 'SSA_ERROR' // Error during SSA conversion
  | 'STRUCTURIZE_ERROR' // Error during CFG structurization
  | 'CODEGEN_ERROR' // Error during code generation
  | 'OPTIMIZE_ERROR' // Error during HIR optimization
  | 'SCOPE_ERROR' // Error in reactive scope analysis
  | 'VALIDATION_ERROR' // Error in HIR validation
  | 'CYCLE_ERROR' // Cyclic dependency detected
  | 'DEPTH_EXCEEDED' // Recursion depth exceeded

export type BlockId = number

export interface SourceInfo {
  loc?: SourceLocation | null | undefined
}

/**
 * SSA naming constants and utilities.
 * Using a unique separator '$$ssa' to avoid conflicts with user variable names.
 * Format: {originalName}$$ssa{version}
 * Example: count -> count$$ssa1, count$$ssa2
 */
export const SSA_SEPARATOR = '$$ssa'
export const SSA_PATTERN = /\$\$ssa\d+$/
const GENERATED_SSA_NAMES = new Set<string>()

/**
 * Create an SSA-versioned variable name.
 * @param baseName - The original variable name
 * @param version - The SSA version number
 */
export function makeSSAName(baseName: string, version: number): string {
  const name = `${baseName}${SSA_SEPARATOR}${version}`
  GENERATED_SSA_NAMES.add(name)
  return name
}

export function resetGeneratedSSANames(): void {
  GENERATED_SSA_NAMES.clear()
}

/**
 * Extract the base name from an SSA-versioned variable name.
 * Returns the original name if no SSA suffix is present.
 * @param name - The potentially SSA-versioned variable name
 */
export function getSSABaseName(name: string): string {
  if (GENERATED_SSA_NAMES.has(name)) {
    return name.replace(SSA_PATTERN, '')
  }
  // If the name already contains the SSA pattern but wasn't generated here,
  // treat it as a user-defined identifier to avoid collisions.
  return SSA_PATTERN.test(name) ? name : name
}

/**
 * Check if a variable name is SSA-versioned.
 * @param name - The variable name to check
 */
export function isSSAName(name: string): boolean {
  return GENERATED_SSA_NAMES.has(name) || SSA_PATTERN.test(name)
}

/** Terminator of a basic block */
export type Terminator =
  | ({ kind: 'Return'; argument?: Expression | undefined } & SourceInfo)
  | ({ kind: 'Throw'; argument: Expression } & SourceInfo)
  | ({ kind: 'Jump'; target: BlockId } & SourceInfo)
  | ({ kind: 'Branch'; test: Expression; consequent: BlockId; alternate: BlockId } & SourceInfo)
  | ({
      kind: 'Switch'
      discriminant: Expression
      cases: { test?: Expression | undefined; target: BlockId; syntheticDefault?: boolean }[]
    } & SourceInfo)
  | ({ kind: 'Unreachable' } & SourceInfo)
  | ({ kind: 'Break'; target: BlockId; label?: string | undefined } & SourceInfo)
  | ({ kind: 'Continue'; target: BlockId; label?: string | undefined } & SourceInfo)
  | ({
      kind: 'ForOf'
      variable: string
      /** Whether the loop left side declared a new binding or assigned an existing target. */
      leftKind?: 'declaration' | 'assignment' | undefined
      /** Variable declaration kind (const, let, var) */
      variableKind: 'const' | 'let' | 'var'
      /** Original pattern for destructuring (stored as Babel AST node) */
      pattern?: LVal | undefined
      /** Original non-identifier assignment target, such as `obj.value`. */
      assignmentTarget?: Expression | undefined
      /** Whether this is a `for await...of` loop. */
      await?: boolean | undefined
      iterable: Expression
      body: BlockId
      exit: BlockId
    } & SourceInfo)
  | ({
      kind: 'ForIn'
      variable: string
      /** Whether the loop left side declared a new binding or assigned an existing target. */
      leftKind?: 'declaration' | 'assignment' | undefined
      /** Variable declaration kind (const, let, var) */
      variableKind: 'const' | 'let' | 'var'
      /** Original pattern for destructuring (stored as Babel AST node) */
      pattern?: LVal | undefined
      /** Original non-identifier assignment target, such as `obj.key`. */
      assignmentTarget?: Expression | undefined
      object: Expression
      body: BlockId
      exit: BlockId
    } & SourceInfo)
  | ({
      kind: 'Try'
      tryBlock: BlockId
      catchBlock?: BlockId | undefined
      catchParam?: string | undefined
      catchPattern?: LVal | undefined
      finallyBlock?: BlockId | undefined
      exit: BlockId
    } & SourceInfo)

/** Instruction interfaces for proper type narrowing */
export interface AssignInstruction extends SourceInfo {
  kind: 'Assign'
  target: Identifier
  value: Expression
  declarationKind?: 'const' | 'let' | 'var' | 'function' | undefined
  /** Assignment came from a source mutation statement and must remain observable. */
  isMutation?: boolean | undefined
  /** Function declaration came from a lexical block and must not flow outside it. */
  blockScopedFunction?: boolean | undefined
  /** Declaration-time work that must stay eager even when it reads reactive values. */
  preserveEagerEvaluation?: boolean | undefined
}

export interface ExpressionInstruction extends SourceInfo {
  kind: 'Expression'
  value: Expression
}

export interface DebuggerInstruction extends SourceInfo {
  kind: 'Debugger'
}

export interface PhiInstruction extends SourceInfo {
  kind: 'Phi'
  variable: string
  target: Identifier
  sources: { block: BlockId; id: Identifier }[]
}

/** A single HIR instruction */
export type Instruction =
  | AssignInstruction
  | ExpressionInstruction
  | DebuggerInstruction
  | PhiInstruction

/** Type guard for Phi instructions */
export function isPhiInstruction(instr: Instruction): instr is PhiInstruction {
  return instr.kind === 'Phi'
}

/** Type guard for Assign instructions */
export function isAssignInstruction(instr: Instruction): instr is AssignInstruction {
  return instr.kind === 'Assign'
}

/** Minimal expression placeholder; future work will refine variants */
export type Expression =
  | Identifier
  | Literal
  | ImportExpression
  | MetaProperty
  | CallExpression
  | MemberExpression
  | BinaryExpression
  | UnaryExpression
  | ConditionalExpression
  | LogicalExpression
  | ArrayExpression
  | ObjectExpression
  | JSXElementExpression
  | ArrowFunctionExpression
  | FunctionExpression
  | AssignmentExpression
  | UpdateExpression
  | TemplateLiteral
  | SpreadElement
  | AwaitExpression
  | NewExpression
  | SequenceExpression
  | YieldExpression
  | OptionalCallExpression
  | TaggedTemplateExpression
  | ClassExpression
  | ThisExpression
  | SuperExpression
  | OptionalMemberExpression

export interface Identifier extends SourceInfo {
  kind: 'Identifier'
  name: string
}

export interface Literal extends SourceInfo {
  kind: 'Literal'
  value: string | number | boolean | bigint | null | undefined | RegExp
}

export interface ImportExpression extends SourceInfo {
  kind: 'ImportExpression'
  source: Expression
  options?: Expression | undefined
}

export interface MetaProperty extends SourceInfo {
  kind: 'MetaProperty'
  meta: Identifier
  property: Identifier
}

export interface CallExpression extends SourceInfo {
  kind: 'CallExpression'
  callee: Expression
  arguments: Expression[]
  /** Compiler-confirmed macro/helper call kind. */
  macro?: FictMacroKind | undefined
  /** Optional purity hint (e.g., from @__PURE__ annotations) */
  pure?: boolean | undefined
}

export interface MemberExpression extends SourceInfo {
  kind: 'MemberExpression'
  object: Expression
  property: Expression
  computed: boolean
  optional?: boolean | undefined
}

/**
 * Represents a dependency path through optional chains.
 * Example: a?.b?.c has path [{property: 'b', optional: true}, {property: 'c', optional: true}]
 * with base identifier 'a'.
 */
export interface DependencyPath {
  /** Base identifier of the path */
  base: string
  /** Path segments from base to leaf */
  segments: PathSegment[]
  /** Whether any segment is optional */
  hasOptional: boolean
}

export interface PathSegment {
  /** Property name or computed key */
  property: string
  /** Whether this access is optional (?.) */
  optional: boolean
  /** Whether this is a computed access ([]) */
  computed: boolean
}

/**
 * Extract a dependency path from a member expression chain.
 * Returns undefined if the expression doesn't form a valid path.
 */
export function extractDependencyPath(expr: Expression): DependencyPath | undefined {
  if (expr.kind === 'Identifier') {
    return {
      base: expr.name,
      segments: [],
      hasOptional: false,
    }
  }

  if (expr.kind === 'MemberExpression' || expr.kind === 'OptionalMemberExpression') {
    const segments: PathSegment[] = []
    let hasOptional = false
    let current: Expression = expr

    // Walk up the member expression chain (handles both MemberExpression and OptionalMemberExpression)
    while (current.kind === 'MemberExpression' || current.kind === 'OptionalMemberExpression') {
      const member = current as MemberExpression | OptionalMemberExpression

      // Get property name
      let propertyName: string
      if (!member.computed && member.property.kind === 'Identifier') {
        propertyName = member.property.name
      } else if (
        member.property.kind === 'Literal' &&
        (typeof member.property.value === 'string' || typeof member.property.value === 'number')
      ) {
        propertyName = String(member.property.value)
      } else {
        // Dynamic computed property - collect the key expression separately.
        return undefined
      }

      segments.unshift({
        property: propertyName,
        optional: member.optional ?? false,
        computed: member.computed,
      })

      if (member.optional) {
        hasOptional = true
      }

      current = member.object
    }

    // Base should be an identifier
    if (current.kind !== 'Identifier') {
      return undefined
    }

    return {
      base: current.name,
      segments,
      hasOptional,
    }
  }

  return undefined
}

/**
 * Convert a dependency path to a string representation.
 * Example: { base: 'a', segments: [{property: 'b'}, {property: 'c'}] } => 'a.b.c'
 */
export function pathToString(path: DependencyPath): string {
  let result = path.base
  for (const seg of path.segments) {
    if (seg.optional) {
      result += '?.'
    } else {
      result += '.'
    }
    if (seg.computed) {
      result += `[${seg.property}]`
    } else {
      result += seg.property
    }
  }
  return result
}

export interface BinaryExpression extends SourceInfo {
  kind: 'BinaryExpression'
  operator: string
  left: Expression
  right: Expression
}

export interface UnaryExpression extends SourceInfo {
  kind: 'UnaryExpression'
  operator: string
  argument: Expression
  prefix: boolean
}

export interface ConditionalExpression extends SourceInfo {
  kind: 'ConditionalExpression'
  test: Expression
  consequent: Expression
  alternate: Expression
}

export interface LogicalExpression extends SourceInfo {
  kind: 'LogicalExpression'
  operator: '&&' | '||' | '??'
  left: Expression
  right: Expression
}

export interface ArrayExpression extends SourceInfo {
  kind: 'ArrayExpression'
  elements: (Expression | null)[]
}

export interface ObjectProperty extends SourceInfo {
  kind: 'Property'
  key: Expression
  computed?: boolean | undefined
  value: Expression
  shorthand?: boolean | undefined
  /**
   * Property kind for object methods/getters/setters.
   * Undefined or 'init' indicates a standard property initializer.
   */
  propertyKind?: 'init' | 'method' | 'get' | 'set' | undefined
}

export interface ObjectExpression extends SourceInfo {
  kind: 'ObjectExpression'
  properties: (ObjectProperty | SpreadElement)[]
}

export interface JSXElementExpression extends SourceInfo {
  kind: 'JSXElement'
  tagName: string | Expression // string for intrinsic, Expression for component
  isComponent: boolean
  /** True only for source JSX fragment syntax (`<>...</>`). */
  isFragmentSyntax?: boolean | undefined
  /** True when source JSX authored child syntax before HIR child normalization. */
  hasAuthoredChildren?: boolean | undefined
  attributes: JSXAttribute[]
  children: JSXChild[]
}

export interface JSXAttribute extends SourceInfo {
  name: string
  value: Expression | null // null means boolean attribute
  isSpread?: boolean | undefined
  spreadExpr?: Expression | undefined
}

export type JSXChild =
  | { kind: 'text'; value: string; loc?: SourceLocation | null | undefined }
  | { kind: 'expression'; value: Expression; loc?: SourceLocation | null | undefined }
  | { kind: 'element'; value: JSXElementExpression; loc?: SourceLocation | null | undefined }

export interface ArrowFunctionExpression extends SourceInfo {
  kind: 'ArrowFunction'
  params: Identifier[]
  /** Original Babel param AST nodes for preserving patterns/rest params */
  rawParams?: BabelParamNode[] | undefined
  body: Expression | BasicBlock[]
  isExpression: boolean // true if body is Expression, false if block
  isAsync?: boolean | undefined
  noMemo?: boolean | undefined
  pure?: boolean | undefined
  /** Marks this function as a reactive scope callback (e.g., renderHook(() => ...)). */
  reactiveScope?: string | undefined
}

export interface FunctionExpression extends SourceInfo {
  kind: 'FunctionExpression'
  name?: string | undefined
  params: Identifier[]
  /** Original Babel param AST nodes for preserving patterns/rest params */
  rawParams?: BabelParamNode[] | undefined
  body: BasicBlock[]
  isAsync?: boolean | undefined
  isGenerator?: boolean | undefined
  noMemo?: boolean | undefined
  pure?: boolean | undefined
  /** Marks this function as a reactive scope callback (e.g., renderHook(() => ...)). */
  reactiveScope?: string | undefined
}

export interface AssignmentExpression extends SourceInfo {
  kind: 'AssignmentExpression'
  operator: string
  left: Expression
  right: Expression
}

export interface UpdateExpression extends SourceInfo {
  kind: 'UpdateExpression'
  operator: '++' | '--'
  argument: Expression
  prefix: boolean
}

export type TemplateQuasi = string | { raw: string; cooked: string | null }

export interface TemplateLiteral extends SourceInfo {
  kind: 'TemplateLiteral'
  quasis: TemplateQuasi[]
  expressions: Expression[]
}

export interface SpreadElement extends SourceInfo {
  kind: 'SpreadElement'
  argument: Expression
}

export interface AwaitExpression extends SourceInfo {
  kind: 'AwaitExpression'
  argument: Expression
}

export interface NewExpression extends SourceInfo {
  kind: 'NewExpression'
  callee: Expression
  arguments: Expression[]
}

export interface SequenceExpression extends SourceInfo {
  kind: 'SequenceExpression'
  expressions: Expression[]
}

export interface YieldExpression extends SourceInfo {
  kind: 'YieldExpression'
  argument: Expression | null
  delegate: boolean
}

export interface OptionalCallExpression extends SourceInfo {
  kind: 'OptionalCallExpression'
  callee: Expression
  arguments: Expression[]
  optional: boolean
  /** Compiler-confirmed macro/helper call kind. */
  macro?: FictMacroKind | undefined
  /** Optional purity hint (e.g., from @__PURE__ annotations) */
  pure?: boolean | undefined
}

export interface TaggedTemplateExpression extends SourceInfo {
  kind: 'TaggedTemplateExpression'
  tag: Expression
  quasi: TemplateLiteral
}

export interface ClassExpression extends SourceInfo {
  kind: 'ClassExpression'
  name?: string | undefined
  superClass?: Expression | undefined
  /** Class-level decorators - stored as Babel AST nodes */
  decorators?: BabelDecorator[] | undefined
  /** Class body elements - stored as Babel AST nodes */
  body: BabelClassMember[]
}

export interface ThisExpression extends SourceInfo {
  kind: 'ThisExpression'
}

export interface SuperExpression extends SourceInfo {
  kind: 'SuperExpression'
}

export interface OptionalMemberExpression extends SourceInfo {
  kind: 'OptionalMemberExpression'
  object: Expression
  property: Expression
  computed: boolean
  optional: boolean
}

export interface BasicBlock {
  id: BlockId
  instructions: Instruction[]
  terminator: Terminator
  /** Binding-only declarations that must remain after return/throw to preserve hoisting and TDZ. */
  postTerminatorStatements?: BabelStatement[] | undefined
  /** Exit block for a source bare block whose declarations need lexical scope. */
  lexicalScopeExit?: BlockId | undefined
  /** Source loop shape for loops that may not have a natural back-edge, e.g. immediate break. */
  sourceLoop?:
    | { kind: 'while'; body: BlockId; exit: BlockId }
    | { kind: 'for'; body: BlockId; update: BlockId; exit: BlockId; init?: Instruction[] }
    | { kind: 'doWhile'; condition: BlockId; exit: BlockId }
    | undefined
}

export interface LabeledStatementMeta {
  label: string
  /**
   * Explicit exit boundary for generic labeled statements.
   * Loop/switch labels don't need this because their hosts are structurized directly.
   */
  exitBlock?: BlockId | undefined
}

export interface HIRFunction extends SourceInfo {
  name?: string | undefined
  params: Identifier[]
  blocks: BasicBlock[]
  /** Original Babel param AST nodes for proper props pattern lowering */
  rawParams?: BabelParamNode[] | undefined
  /** Optional SSA version map for consumers */
  ssaMap?: Map<string, number> | undefined
  /** Optional metadata about the origin of this function */
  meta?:
    | {
        fromExpression?: boolean | undefined
        functionExpressionName?: string | undefined
        anonymousDefaultExport?: boolean | undefined
        defaultExportExpression?: boolean | undefined
        directives?: BabelDirective[] | undefined
        isArrow?: boolean | undefined
        hasExpressionBody?: boolean | undefined
        isAsync?: boolean | undefined
        isGenerator?: boolean | undefined
        noMemo?: boolean | undefined
        pure?: boolean | undefined
        /**
         * Hook return info parsed from @fictReturn JSDoc annotation.
         * Allows cross-module hook return type declarations.
         */
        hookReturnInfo?: {
          objectProps?: Map<string, ReactiveExportKind> | undefined
          arrayProps?: Map<number, ReactiveExportKind> | undefined
          directAccessor?: ReactiveExportKind | undefined
        }
        /** Labels attached to structured hosts or explicit labeled-statement entry blocks. */
        labeledStatements?: Map<BlockId, LabeledStatementMeta> | undefined
      }
    | undefined
}

export interface HIRProgram {
  functions: HIRFunction[]
  /** Import statements and other preamble to preserve */
  preamble: PreambleItem[]
  /** Export statements and other postamble to preserve */
  postamble: PostambleItem[]
  /** Original program body for stable reordering during codegen (Babel Statement nodes) */
  originalBody?: BabelStatement[]
  /** Program directive prologue entries preserved during codegen. */
  directives?: BabelDirective[] | undefined
}
