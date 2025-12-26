import type {
  BasicBlock,
  Expression,
  HIRFunction,
  HIRProgram,
  JSXChild,
  JSXElementExpression,
} from './hir'

function formatExpression(expr: Expression, depth = 0): string {
  const _indent = '  '.repeat(depth)
  switch (expr.kind) {
    case 'Identifier':
      return expr.name
    case 'Literal':
      return JSON.stringify(expr.value)
    case 'CallExpression':
      return `${formatExpression(expr.callee, depth)}(${expr.arguments.map(a => formatExpression(a, depth)).join(', ')})`
    case 'MemberExpression':
      if (expr.computed) {
        return `${formatExpression(expr.object, depth)}[${formatExpression(expr.property, depth)}]`
      }
      return `${formatExpression(expr.object, depth)}.${formatExpression(expr.property, depth)}`
    case 'BinaryExpression':
      return `(${formatExpression(expr.left, depth)} ${expr.operator} ${formatExpression(expr.right, depth)})`
    case 'UnaryExpression':
      return expr.prefix
        ? `${expr.operator}${formatExpression(expr.argument, depth)}`
        : `${formatExpression(expr.argument, depth)}${expr.operator}`
    case 'LogicalExpression':
      return `(${formatExpression(expr.left, depth)} ${expr.operator} ${formatExpression(expr.right, depth)})`
    case 'ConditionalExpression':
      return `(${formatExpression(expr.test, depth)} ? ${formatExpression(expr.consequent, depth)} : ${formatExpression(expr.alternate, depth)})`
    case 'ArrayExpression':
      return `[${expr.elements.map(e => formatExpression(e, depth)).join(', ')}]`
    case 'ObjectExpression':
      return `{${expr.properties
        .map(p => {
          if (p.kind === 'SpreadElement') {
            return `...${formatExpression(p.argument, depth)}`
          }
          return `${formatExpression(p.key, depth)}: ${formatExpression(p.value, depth)}`
        })
        .join(', ')}}`
    case 'JSXElement':
      return formatJSXElement(expr, depth)
    case 'ArrowFunction':
      return `(${expr.params.map(p => p.name).join(', ')}) => ${Array.isArray(expr.body) ? '{...}' : formatExpression(expr.body as Expression, depth)}`
    case 'FunctionExpression':
      return `function ${expr.name ?? ''}(${expr.params.map(p => p.name).join(', ')}) {...}`
    case 'AssignmentExpression':
      return `${formatExpression(expr.left, depth)} ${expr.operator} ${formatExpression(expr.right, depth)}`
    case 'UpdateExpression':
      return expr.prefix
        ? `${expr.operator}${formatExpression(expr.argument, depth)}`
        : `${formatExpression(expr.argument, depth)}${expr.operator}`
    case 'TemplateLiteral':
      return '`...`'
    case 'SpreadElement':
      return `...${formatExpression(expr.argument, depth)}`
    default:
      return '<?>'
  }
}

function formatJSXElement(jsx: JSXElementExpression, depth: number): string {
  const tag = typeof jsx.tagName === 'string' ? jsx.tagName : formatExpression(jsx.tagName, depth)
  const attrs = jsx.attributes
    .map(a => {
      if (a.isSpread) return `{...${a.spreadExpr ? formatExpression(a.spreadExpr, depth) : '?'}}`
      if (!a.value) return a.name
      return `${a.name}={${formatExpression(a.value, depth)}}`
    })
    .join(' ')

  if (jsx.children.length === 0) {
    return `<${tag}${attrs ? ' ' + attrs : ''} />`
  }

  const children = jsx.children.map(c => formatJSXChild(c, depth)).join('')
  return `<${tag}${attrs ? ' ' + attrs : ''}>${children}</${tag}>`
}

function formatJSXChild(child: JSXChild, depth: number): string {
  switch (child.kind) {
    case 'text':
      return child.value.trim()
    case 'expression':
      return `{${formatExpression(child.value, depth)}}`
    case 'element':
      return formatJSXElement(child.value, depth)
  }
}

function formatInstruction(i: any): string {
  if (i.kind === 'Assign' && i.target) {
    const value = i.value ? ` = ${formatExpression(i.value, 0)}` : ''
    return `    ${i.kind} ${i.target.name}${value}`
  }
  if (i.kind === 'Phi' && i.target) {
    const sources = i.sources?.map((s: any) => `${s.block}:${s.id.name}`).join(', ') ?? ''
    return `    Phi ${i.variable} -> ${i.target.name} <- ${sources}`
  }
  if (i.kind === 'Expression' && i.value) {
    return `    ${i.kind} ${formatExpression(i.value, 0)}`
  }
  return `    ${i.kind}`
}

function printBlock(block: BasicBlock): string {
  const instructions = block.instructions.map(formatInstruction).join('\n') || '    ;'
  return [`  block ${block.id}:`, instructions, `    ${block.terminator.kind.toLowerCase()}`].join(
    '\n',
  )
}

function printFunction(fn: HIRFunction): string {
  const header = `function ${fn.name ?? '<anonymous>'}(${fn.params.map(p => p.name).join(', ')})`
  const blocks = fn.blocks.map(printBlock).join('\n')
  return [header, blocks].filter(Boolean).join('\n')
}

/**
 * Text printer for early snapshots. Intentionally simple; will evolve
 * alongside the HIR structure.
 */
export function printHIR(program: HIRProgram): string {
  if (!program.functions.length) return '<hir empty>'
  return program.functions.map(printFunction).join('\n\n')
}
