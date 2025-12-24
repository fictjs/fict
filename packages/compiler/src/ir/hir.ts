/**
 * High-level Intermediate Representation (HIR) scaffolding.
 *
 * This is a minimal, non-executing definition set meant to unblock
 * the experimental HIR/SSA pipeline. It keeps constructs high-level
 * (conditionals/loops/logical expressions) to preserve source shape.
 */

export type BlockId = number

/** Terminator of a basic block */
export type Terminator =
  | { kind: 'Return'; argument?: Expression }
  | { kind: 'Throw'; argument: Expression }
  | { kind: 'Jump'; target: BlockId }
  | { kind: 'Branch'; test: Expression; consequent: BlockId; alternate: BlockId }
  | {
      kind: 'Switch'
      discriminant: Expression
      cases: { test?: Expression; target: BlockId }[]
    }
  | { kind: 'Unreachable' }
  | { kind: 'Break'; target: BlockId; label?: string }
  | { kind: 'Continue'; target: BlockId; label?: string }
  | {
      kind: 'ForOf'
      variable: string
      /** Variable declaration kind (const, let, var) */
      variableKind: 'const' | 'let' | 'var'
      /** Original pattern for destructuring (stored as Babel AST node for now) */
      pattern?: any
      iterable: Expression
      body: BlockId
      exit: BlockId
    }
  | {
      kind: 'ForIn'
      variable: string
      /** Variable declaration kind (const, let, var) */
      variableKind: 'const' | 'let' | 'var'
      /** Original pattern for destructuring (stored as Babel AST node for now) */
      pattern?: any
      object: Expression
      body: BlockId
      exit: BlockId
    }
  | {
      kind: 'Try'
      tryBlock: BlockId
      catchBlock?: BlockId
      catchParam?: string
      finallyBlock?: BlockId
      exit: BlockId
    }

/** A single HIR instruction, kept coarse for now */
export type Instruction =
  | {
      kind: 'Assign'
      target: Identifier
      value: Expression
      declarationKind?: 'const' | 'let' | 'var'
    }
  | { kind: 'Expression'; value: Expression }
  | {
      kind: 'Phi'
      variable: string
      target: Identifier
      sources: { block: BlockId; id: Identifier }[]
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

export interface Identifier {
  kind: 'Identifier'
  name: string
}

export interface Literal {
  kind: 'Literal'
  value: string | number | boolean | null | undefined
}

export interface CallExpression {
  kind: 'CallExpression'
  callee: Expression
  arguments: Expression[]
}

export interface MemberExpression {
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

  if (expr.kind === 'MemberExpression') {
    const segments: PathSegment[] = []
    let hasOptional = false
    let current: Expression = expr

    // Walk up the member expression chain
    while (current.kind === 'MemberExpression') {
      const member = current as MemberExpression

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

export interface BinaryExpression {
  kind: 'BinaryExpression'
  operator: string
  left: Expression
  right: Expression
}

export interface UnaryExpression {
  kind: 'UnaryExpression'
  operator: string
  argument: Expression
  prefix: boolean
}

export interface ConditionalExpression {
  kind: 'ConditionalExpression'
  test: Expression
  consequent: Expression
  alternate: Expression
}

export interface LogicalExpression {
  kind: 'LogicalExpression'
  operator: '&&' | '||' | '??'
  left: Expression
  right: Expression
}

export interface ArrayExpression {
  kind: 'ArrayExpression'
  elements: Expression[]
}

export interface ObjectProperty {
  kind: 'Property'
  key: Identifier | Literal
  value: Expression
  shorthand?: boolean
}

export interface ObjectExpression {
  kind: 'ObjectExpression'
  properties: (ObjectProperty | SpreadElement)[]
}

export interface JSXElementExpression {
  kind: 'JSXElement'
  tagName: string | Expression // string for intrinsic, Expression for component
  isComponent: boolean
  attributes: JSXAttribute[]
  children: JSXChild[]
}

export interface JSXAttribute {
  name: string
  value: Expression | null // null means boolean attribute
  isSpread?: boolean
  spreadExpr?: Expression
}

export type JSXChild =
  | { kind: 'text'; value: string }
  | { kind: 'expression'; value: Expression }
  | { kind: 'element'; value: JSXElementExpression }

export interface ArrowFunctionExpression {
  kind: 'ArrowFunction'
  params: Identifier[]
  body: Expression | BasicBlock[]
  isExpression: boolean // true if body is Expression, false if block
  isAsync?: boolean
}

export interface FunctionExpression {
  kind: 'FunctionExpression'
  name?: string
  params: Identifier[]
  body: BasicBlock[]
  isAsync?: boolean
}

export interface AssignmentExpression {
  kind: 'AssignmentExpression'
  operator: string
  left: Expression
  right: Expression
}

export interface UpdateExpression {
  kind: 'UpdateExpression'
  operator: '++' | '--'
  argument: Expression
  prefix: boolean
}

export interface TemplateLiteral {
  kind: 'TemplateLiteral'
  quasis: string[]
  expressions: Expression[]
}

export interface SpreadElement {
  kind: 'SpreadElement'
  argument: Expression
}

export interface BasicBlock {
  id: BlockId
  instructions: Instruction[]
  terminator: Terminator
}

export interface HIRFunction {
  name?: string
  params: Identifier[]
  blocks: BasicBlock[]
  /** Original Babel param AST nodes for proper props pattern lowering */
  rawParams?: any[]
  /** Optional SSA version map for consumers */
  ssaMap?: Map<string, number>
  /** Optional metadata about the origin of this function */
  meta?: {
    fromExpression?: boolean
    isArrow?: boolean
    hasExpressionBody?: boolean
  }
}

export interface HIRProgram {
  functions: HIRFunction[]
  /** Import statements and other preamble to preserve */
  preamble: any[]
  /** Export statements and other postamble to preserve */
  postamble: any[]
  /** Original program body (for stable reordering during codegen) */
  originalBody?: any[]
}
