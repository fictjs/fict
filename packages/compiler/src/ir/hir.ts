import type { SourceLocation, Statement, ClassBody, Node } from '@babel/types'

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
 * Type alias for class body members from Babel AST.
 */
export type BabelClassMember = ClassBody['body'][number]

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
      blockId?: BlockId
      variable?: string
      file?: string
      line?: number
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
  | 'SCOPE_ERROR' // Error in reactive scope analysis
  | 'VALIDATION_ERROR' // Error in HIR validation
  | 'CYCLE_ERROR' // Cyclic dependency detected
  | 'DEPTH_EXCEEDED' // Recursion depth exceeded

export type BlockId = number

export interface SourceInfo {
  loc?: SourceLocation | null
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

/**
 * Extract the base name from an SSA-versioned variable name.
 * Returns the original name if no SSA suffix is present.
 * @param name - The potentially SSA-versioned variable name
 */
export function getSSABaseName(name: string): string {
  // Skip internal names that start with __ (these are compiler-generated)
  if (name.startsWith('__')) return name
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
  | ({ kind: 'Return'; argument?: Expression } & SourceInfo)
  | ({ kind: 'Throw'; argument: Expression } & SourceInfo)
  | ({ kind: 'Jump'; target: BlockId } & SourceInfo)
  | ({ kind: 'Branch'; test: Expression; consequent: BlockId; alternate: BlockId } & SourceInfo)
  | ({
      kind: 'Switch'
      discriminant: Expression
      cases: { test?: Expression; target: BlockId }[]
    } & SourceInfo)
  | ({ kind: 'Unreachable' } & SourceInfo)
  | ({ kind: 'Break'; target: BlockId; label?: string } & SourceInfo)
  | ({ kind: 'Continue'; target: BlockId; label?: string } & SourceInfo)
  | ({
      kind: 'ForOf'
      variable: string
      /** Variable declaration kind (const, let, var) */
      variableKind: 'const' | 'let' | 'var'
      /** Original pattern for destructuring (stored as Babel AST node) */
      pattern?: any
      iterable: Expression
      body: BlockId
      exit: BlockId
    } & SourceInfo)
  | ({
      kind: 'ForIn'
      variable: string
      /** Variable declaration kind (const, let, var) */
      variableKind: 'const' | 'let' | 'var'
      /** Original pattern for destructuring (stored as Babel AST node) */
      pattern?: any
      object: Expression
      body: BlockId
      exit: BlockId
    } & SourceInfo)
  | ({
      kind: 'Try'
      tryBlock: BlockId
      catchBlock?: BlockId
      catchParam?: string
      finallyBlock?: BlockId
      exit: BlockId
    } & SourceInfo)

/** Instruction interfaces for proper type narrowing */
export interface AssignInstruction extends SourceInfo {
  kind: 'Assign'
  target: Identifier
  value: Expression
  declarationKind?: 'const' | 'let' | 'var' | 'function'
}

export interface ExpressionInstruction extends SourceInfo {
  kind: 'Expression'
  value: Expression
}

export interface PhiInstruction extends SourceInfo {
  kind: 'Phi'
  variable: string
  target: Identifier
  sources: { block: BlockId; id: Identifier }[]
}

/** A single HIR instruction */
export type Instruction = AssignInstruction | ExpressionInstruction | PhiInstruction

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
  value: string | number | boolean | null | undefined
}

export interface CallExpression extends SourceInfo {
  kind: 'CallExpression'
  callee: Expression
  arguments: Expression[]
  /** Optional purity hint (e.g., from @__PURE__ annotations) */
  pure?: boolean
}

export interface MemberExpression extends SourceInfo {
  kind: 'MemberExpression'
  object: Expression
  property: Expression
  computed: boolean
  optional?: boolean
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
      if (member.property.kind === 'Identifier') {
        propertyName = member.property.name
      } else if (member.property.kind === 'Literal' && typeof member.property.value === 'string') {
        propertyName = member.property.value
      } else {
        // Complex computed property - can't track
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
  elements: Expression[]
}

export interface ObjectProperty extends SourceInfo {
  kind: 'Property'
  key: Identifier | Literal
  value: Expression
  shorthand?: boolean
}

export interface ObjectExpression extends SourceInfo {
  kind: 'ObjectExpression'
  properties: (ObjectProperty | SpreadElement)[]
}

export interface JSXElementExpression extends SourceInfo {
  kind: 'JSXElement'
  tagName: string | Expression // string for intrinsic, Expression for component
  isComponent: boolean
  attributes: JSXAttribute[]
  children: JSXChild[]
}

export interface JSXAttribute extends SourceInfo {
  name: string
  value: Expression | null // null means boolean attribute
  isSpread?: boolean
  spreadExpr?: Expression
}

export type JSXChild =
  | { kind: 'text'; value: string; loc?: SourceLocation | null }
  | { kind: 'expression'; value: Expression; loc?: SourceLocation | null }
  | { kind: 'element'; value: JSXElementExpression; loc?: SourceLocation | null }

export interface ArrowFunctionExpression extends SourceInfo {
  kind: 'ArrowFunction'
  params: Identifier[]
  body: Expression | BasicBlock[]
  isExpression: boolean // true if body is Expression, false if block
  isAsync?: boolean
}

export interface FunctionExpression extends SourceInfo {
  kind: 'FunctionExpression'
  name?: string
  params: Identifier[]
  body: BasicBlock[]
  isAsync?: boolean
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

export interface TemplateLiteral extends SourceInfo {
  kind: 'TemplateLiteral'
  quasis: string[]
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
  /** Optional purity hint (e.g., from @__PURE__ annotations) */
  pure?: boolean
}

export interface TaggedTemplateExpression extends SourceInfo {
  kind: 'TaggedTemplateExpression'
  tag: Expression
  quasi: TemplateLiteral
}

export interface ClassExpression extends SourceInfo {
  kind: 'ClassExpression'
  name?: string
  superClass?: Expression
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
}

export interface HIRFunction extends SourceInfo {
  name?: string
  params: Identifier[]
  blocks: BasicBlock[]
  /** Original Babel param AST nodes for proper props pattern lowering */
  rawParams?: BabelParamNode[]
  /** Optional SSA version map for consumers */
  ssaMap?: Map<string, number>
  /** Optional metadata about the origin of this function */
  meta?: {
    fromExpression?: boolean
    isArrow?: boolean
    hasExpressionBody?: boolean
    isAsync?: boolean
    noMemo?: boolean
    pure?: boolean
    /**
     * Hook return info parsed from @fictReturn JSDoc annotation.
     * Allows cross-module hook return type declarations.
     */
    hookReturnInfo?: {
      objectProps?: Map<string, 'signal' | 'memo'>
      arrayProps?: Map<number, 'signal' | 'memo'>
      directAccessor?: 'signal' | 'memo'
    }
  }
}

export interface HIRProgram {
  functions: HIRFunction[]
  /** Import statements and other preamble to preserve */
  preamble: PreambleItem[]
  /** Export statements and other postamble to preserve */
  postamble: PostambleItem[]
  /** Original program body for stable reordering during codegen (Babel Statement nodes) */
  originalBody?: BabelStatement[]
}
