import type { CodegenContext } from './codegen'
import type { Expression, HIRFunction, Instruction } from './hir'
import { deSSAVarName } from './regions'
import { structurizeCFG, type StructuredNode } from './structurize'

function collectExpressionIdentifiers(expr: Expression, into: Set<string>): void {
  if (!expr || typeof expr !== 'object') return

  switch (expr.kind) {
    case 'Identifier':
      into.add(deSSAVarName(expr.name))
      return
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      collectExpressionIdentifiers(expr.object as Expression, into)
      if (expr.computed && expr.property.kind !== 'Literal') {
        collectExpressionIdentifiers(expr.property as Expression, into)
      }
      return
    case 'CallExpression':
    case 'OptionalCallExpression': {
      const isMacroCallee =
        expr.callee.kind === 'Identifier' &&
        (expr.callee.name === '$state' ||
          expr.callee.name === '$effect' ||
          expr.callee.name === '$store')
      if (!isMacroCallee) {
        collectExpressionIdentifiers(expr.callee as Expression, into)
      }
      expr.arguments.forEach(arg => collectExpressionIdentifiers(arg as Expression, into))
      return
    }
    case 'BinaryExpression':
    case 'LogicalExpression':
      collectExpressionIdentifiers(expr.left as Expression, into)
      collectExpressionIdentifiers(expr.right as Expression, into)
      return
    case 'UnaryExpression':
      collectExpressionIdentifiers(expr.argument as Expression, into)
      return
    case 'ConditionalExpression':
      collectExpressionIdentifiers(expr.test as Expression, into)
      collectExpressionIdentifiers(expr.consequent as Expression, into)
      collectExpressionIdentifiers(expr.alternate as Expression, into)
      return
    case 'ArrayExpression':
      expr.elements.forEach(el => {
        if (el) collectExpressionIdentifiers(el as Expression, into)
      })
      return
    case 'ObjectExpression':
      expr.properties.forEach(prop => {
        if (prop.kind === 'SpreadElement') {
          collectExpressionIdentifiers(prop.argument as Expression, into)
          return
        }
        if (prop.computed) collectExpressionIdentifiers(prop.key as Expression, into)
        collectExpressionIdentifiers(prop.value as Expression, into)
      })
      return
    case 'TemplateLiteral':
      expr.expressions.forEach(ex => collectExpressionIdentifiers(ex as Expression, into))
      return
    case 'ArrowFunction':
    case 'FunctionExpression':
      // Avoid traversing nested function bodies.
      return
    case 'AssignmentExpression':
      collectExpressionIdentifiers(expr.left as Expression, into)
      collectExpressionIdentifiers(expr.right as Expression, into)
      return
    case 'UpdateExpression':
      collectExpressionIdentifiers(expr.argument as Expression, into)
      return
    case 'AwaitExpression':
      collectExpressionIdentifiers(expr.argument as Expression, into)
      return
    case 'NewExpression':
      collectExpressionIdentifiers(expr.callee as Expression, into)
      expr.arguments.forEach(arg => collectExpressionIdentifiers(arg as Expression, into))
      return
    case 'SequenceExpression':
      expr.expressions.forEach(ex => collectExpressionIdentifiers(ex as Expression, into))
      return
    case 'YieldExpression':
      if (expr.argument) collectExpressionIdentifiers(expr.argument as Expression, into)
      return
    case 'TaggedTemplateExpression':
      collectExpressionIdentifiers(expr.tag as Expression, into)
      expr.quasi.expressions.forEach(ex => collectExpressionIdentifiers(ex as Expression, into))
      return
    case 'SpreadElement':
      collectExpressionIdentifiers(expr.argument as Expression, into)
      return
    case 'JSXElement': {
      if (typeof expr.tagName !== 'string') {
        collectExpressionIdentifiers(expr.tagName as Expression, into)
      }
      expr.attributes.forEach(attr => {
        if (attr.isSpread && attr.spreadExpr) {
          collectExpressionIdentifiers(attr.spreadExpr, into)
          return
        }
        if (attr.value) {
          collectExpressionIdentifiers(attr.value, into)
        }
      })
      expr.children.forEach(child => {
        if (child.kind === 'expression') {
          collectExpressionIdentifiers(child.value as Expression, into)
        } else if (child.kind === 'element') {
          collectExpressionIdentifiers(child.value as Expression, into)
        }
      })
      return
    }
    case 'Literal':
      return
  }
}

export function collectExpressionIdentifiersDeep(
  expr: Expression,
  into: Set<string>,
  bound = new Set<string>(),
): void {
  if (!expr || typeof expr !== 'object') return

  const addIdentifier = (name: string) => {
    const base = deSSAVarName(name)
    if (!bound.has(base)) {
      into.add(base)
    }
  }

  switch (expr.kind) {
    case 'Identifier':
      addIdentifier(expr.name)
      return
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      collectExpressionIdentifiersDeep(expr.object as Expression, into, bound)
      if (expr.computed && expr.property.kind !== 'Literal') {
        collectExpressionIdentifiersDeep(expr.property as Expression, into, bound)
      }
      return
    case 'CallExpression':
    case 'OptionalCallExpression': {
      const isMacroCallee =
        expr.callee.kind === 'Identifier' &&
        (expr.callee.name === '$state' ||
          expr.callee.name === '$effect' ||
          expr.callee.name === '$store')
      // For IIFEs (callee is a function literal), don't traverse into the callee body.
      // IIFEs are snapshots - they execute once and capture values at that moment.
      // Only traverse into the callee for regular calls (identifiers, member expressions).
      const isIIFE =
        expr.callee.kind === 'ArrowFunction' || expr.callee.kind === 'FunctionExpression'
      if (!isMacroCallee && !isIIFE) {
        collectExpressionIdentifiersDeep(expr.callee as Expression, into, bound)
      }
      // Always traverse into arguments - this handles callbacks like array.find(n => n === target)
      expr.arguments.forEach(arg =>
        collectExpressionIdentifiersDeep(arg as Expression, into, bound),
      )
      return
    }
    case 'BinaryExpression':
    case 'LogicalExpression':
      collectExpressionIdentifiersDeep(expr.left as Expression, into, bound)
      collectExpressionIdentifiersDeep(expr.right as Expression, into, bound)
      return
    case 'UnaryExpression':
      collectExpressionIdentifiersDeep(expr.argument as Expression, into, bound)
      return
    case 'ConditionalExpression':
      collectExpressionIdentifiersDeep(expr.test as Expression, into, bound)
      collectExpressionIdentifiersDeep(expr.consequent as Expression, into, bound)
      collectExpressionIdentifiersDeep(expr.alternate as Expression, into, bound)
      return
    case 'ArrayExpression':
      expr.elements.forEach(el => {
        if (el) collectExpressionIdentifiersDeep(el as Expression, into, bound)
      })
      return
    case 'ObjectExpression':
      expr.properties.forEach(prop => {
        if (prop.kind === 'SpreadElement') {
          collectExpressionIdentifiersDeep(prop.argument as Expression, into, bound)
          return
        }
        if (prop.computed) collectExpressionIdentifiersDeep(prop.key as Expression, into, bound)
        collectExpressionIdentifiersDeep(prop.value as Expression, into, bound)
      })
      return
    case 'TemplateLiteral':
      expr.expressions.forEach(ex =>
        collectExpressionIdentifiersDeep(ex as Expression, into, bound),
      )
      return
    case 'ArrowFunction': {
      // Collect identifiers used in the function body, but use SHALLOW traversal
      // to avoid treating nested returned functions as dependencies.
      // E.g., for `numbers.find(n => n === target)`: detect `target`
      // But for `(() => { return () => count })()`: don't detect `count` in the inner function
      const tempSet = new Set<string>()
      if (expr.isExpression && expr.body && !Array.isArray(expr.body)) {
        collectExpressionIdentifiers(expr.body as Expression, tempSet)
      } else if (Array.isArray(expr.body)) {
        for (const block of expr.body) {
          for (const instr of block.instructions) {
            if (instr.kind === 'Assign') {
              collectExpressionIdentifiers(instr.value, tempSet)
            } else if (instr.kind === 'Expression') {
              collectExpressionIdentifiers(instr.value, tempSet)
            } else if (instr.kind === 'Phi') {
              instr.sources.forEach(src => tempSet.add(deSSAVarName(src.id.name)))
            }
          }
          const term = block.terminator
          if (term.kind === 'Branch') {
            collectExpressionIdentifiers(term.test, tempSet)
          } else if (term.kind === 'Switch') {
            collectExpressionIdentifiers(term.discriminant, tempSet)
            term.cases.forEach(c => {
              if (c.test) collectExpressionIdentifiers(c.test, tempSet)
            })
          } else if (term.kind === 'ForOf') {
            collectExpressionIdentifiers(term.iterable, tempSet)
          } else if (term.kind === 'ForIn') {
            collectExpressionIdentifiers(term.object, tempSet)
          } else if (term.kind === 'Return' && term.argument) {
            collectExpressionIdentifiers(term.argument, tempSet)
          } else if (term.kind === 'Throw') {
            collectExpressionIdentifiers(term.argument, tempSet)
          }
        }
      }
      // Filter out bound parameters
      const paramNames = new Set(expr.params.map(p => deSSAVarName(p.name)))
      for (const name of bound) paramNames.add(name)
      for (const dep of tempSet) {
        if (!paramNames.has(dep)) into.add(dep)
      }
      return
    }
    case 'FunctionExpression': {
      // Same logic as ArrowFunction - use shallow traversal inside function bodies
      const tempSet = new Set<string>()
      for (const block of expr.body) {
        for (const instr of block.instructions) {
          if (instr.kind === 'Assign') {
            collectExpressionIdentifiers(instr.value, tempSet)
          } else if (instr.kind === 'Expression') {
            collectExpressionIdentifiers(instr.value, tempSet)
          } else if (instr.kind === 'Phi') {
            instr.sources.forEach(src => tempSet.add(deSSAVarName(src.id.name)))
          }
        }
        const term = block.terminator
        if (term.kind === 'Branch') {
          collectExpressionIdentifiers(term.test, tempSet)
        } else if (term.kind === 'Switch') {
          collectExpressionIdentifiers(term.discriminant, tempSet)
          term.cases.forEach(c => {
            if (c.test) collectExpressionIdentifiers(c.test, tempSet)
          })
        } else if (term.kind === 'ForOf') {
          collectExpressionIdentifiers(term.iterable, tempSet)
        } else if (term.kind === 'ForIn') {
          collectExpressionIdentifiers(term.object, tempSet)
        } else if (term.kind === 'Return' && term.argument) {
          collectExpressionIdentifiers(term.argument, tempSet)
        } else if (term.kind === 'Throw') {
          collectExpressionIdentifiers(term.argument, tempSet)
        }
      }
      // Filter out bound parameters
      const paramNames = new Set(expr.params.map(p => deSSAVarName(p.name)))
      for (const name of bound) paramNames.add(name)
      for (const dep of tempSet) {
        if (!paramNames.has(dep)) into.add(dep)
      }
      return
    }
    case 'AssignmentExpression':
      collectExpressionIdentifiersDeep(expr.left as Expression, into, bound)
      collectExpressionIdentifiersDeep(expr.right as Expression, into, bound)
      return
    case 'UpdateExpression':
      collectExpressionIdentifiersDeep(expr.argument as Expression, into, bound)
      return
    case 'AwaitExpression':
      collectExpressionIdentifiersDeep(expr.argument as Expression, into, bound)
      return
    case 'NewExpression':
      collectExpressionIdentifiersDeep(expr.callee as Expression, into, bound)
      expr.arguments.forEach(arg =>
        collectExpressionIdentifiersDeep(arg as Expression, into, bound),
      )
      return
    case 'SequenceExpression':
      expr.expressions.forEach(ex =>
        collectExpressionIdentifiersDeep(ex as Expression, into, bound),
      )
      return
    case 'YieldExpression':
      if (expr.argument) collectExpressionIdentifiersDeep(expr.argument as Expression, into, bound)
      return
    case 'TaggedTemplateExpression':
      collectExpressionIdentifiersDeep(expr.tag as Expression, into, bound)
      expr.quasi.expressions.forEach(ex =>
        collectExpressionIdentifiersDeep(ex as Expression, into, bound),
      )
      return
    case 'SpreadElement':
      collectExpressionIdentifiersDeep(expr.argument as Expression, into, bound)
      return
    case 'JSXElement': {
      if (typeof expr.tagName !== 'string') {
        collectExpressionIdentifiersDeep(expr.tagName as Expression, into, bound)
      }
      expr.attributes.forEach(attr => {
        if (attr.isSpread && attr.spreadExpr) {
          collectExpressionIdentifiersDeep(attr.spreadExpr, into, bound)
          return
        }
        if (attr.value) {
          collectExpressionIdentifiersDeep(attr.value, into, bound)
        }
      })
      expr.children.forEach(child => {
        if (child.kind === 'expression') {
          collectExpressionIdentifiersDeep(child.value as Expression, into, bound)
        } else if (child.kind === 'element') {
          collectExpressionIdentifiersDeep(child.value as Expression, into, bound)
        }
      })
      return
    }
    case 'Literal':
      return
  }
}

function getExpressionIdentifiers(expr?: Expression | null): Set<string> {
  const deps = new Set<string>()
  if (expr) {
    collectExpressionIdentifiers(expr, deps)
  }
  return deps
}

function getExpressionIdentifiersDeep(expr?: Expression | null): Set<string> {
  const deps = new Set<string>()
  if (expr) {
    collectExpressionIdentifiersDeep(expr, deps)
  }
  return deps
}

function buildControlDependencyMap(fn: HIRFunction): Map<Instruction, Set<string>> {
  const depsByInstruction = new Map<Instruction, Set<string>>()
  let structured: StructuredNode
  try {
    structured = structurizeCFG(fn, {
      warnOnIssues: false,
      throwOnIssues: false,
      useFallback: true,
    })
  } catch {
    return depsByInstruction
  }

  const mergeDeps = (base: Set<string>, extra: Set<string>): Set<string> => {
    if (extra.size === 0) return base
    const merged = new Set(base)
    extra.forEach(dep => merged.add(dep))
    return merged
  }

  const registerInstruction = (instr: Instruction, deps: Set<string>) => {
    depsByInstruction.set(instr, new Set(deps))
  }

  const walk = (node: StructuredNode, activeDeps: Set<string>) => {
    switch (node.kind) {
      case 'sequence':
        node.nodes.forEach(child => walk(child, activeDeps))
        return
      case 'block':
        node.statements.forEach(child => walk(child, activeDeps))
        return
      case 'labeled':
        walk(node.statement, activeDeps)
        return
      case 'instruction':
        registerInstruction(node.instruction, activeDeps)
        return
      case 'if': {
        const condDeps = getExpressionIdentifiers(node.test)
        const nextDeps = mergeDeps(activeDeps, condDeps)
        walk(node.consequent, nextDeps)
        if (node.alternate) walk(node.alternate, nextDeps)
        return
      }
      case 'while': {
        const condDeps = getExpressionIdentifiers(node.test)
        const nextDeps = mergeDeps(activeDeps, condDeps)
        walk(node.body, nextDeps)
        return
      }
      case 'doWhile': {
        const condDeps = getExpressionIdentifiers(node.test)
        const nextDeps = mergeDeps(activeDeps, condDeps)
        walk(node.body, nextDeps)
        return
      }
      case 'for': {
        const initDeps = activeDeps
        node.init?.forEach(instr => registerInstruction(instr, initDeps))
        const condDeps = node.test ? getExpressionIdentifiers(node.test) : new Set<string>()
        const loopDeps = mergeDeps(activeDeps, condDeps)
        node.update?.forEach(instr => registerInstruction(instr, loopDeps))
        walk(node.body, loopDeps)
        return
      }
      case 'forOf': {
        const iterDeps = getExpressionIdentifiers(node.iterable)
        const loopDeps = mergeDeps(activeDeps, iterDeps)
        walk(node.body, loopDeps)
        return
      }
      case 'forIn': {
        const iterDeps = getExpressionIdentifiers(node.object)
        const loopDeps = mergeDeps(activeDeps, iterDeps)
        walk(node.body, loopDeps)
        return
      }
      case 'switch': {
        const discDeps = getExpressionIdentifiers(node.discriminant)
        const nextDeps = mergeDeps(activeDeps, discDeps)
        node.cases.forEach(c => walk(c.body, nextDeps))
        return
      }
      case 'try':
        walk(node.block, activeDeps)
        if (node.handler) walk(node.handler.body, activeDeps)
        if (node.finalizer) walk(node.finalizer, activeDeps)
        return
      case 'stateMachine':
        node.blocks.forEach(block => {
          block.instructions.forEach(instr => registerInstruction(instr, activeDeps))
        })
        return
      case 'return':
      case 'throw':
      case 'break':
      case 'continue':
        return
    }
  }

  walk(structured, new Set())
  return depsByInstruction
}

export function computeReactiveAccessors(
  fn: HIRFunction,
  ctx: CodegenContext,
): { tracked: Set<string>; memo: Set<string>; controlDepsByInstr: Map<Instruction, Set<string>> } {
  const activeReadVars = new Set<string>()
  const dataDepsByTarget = new Map<string, Set<string>>()
  const controlDepsByTarget = new Map<string, Set<string>>()
  const controlDepsByInstr = buildControlDependencyMap(fn)

  const addActiveReads = (expr?: Expression | null, deep = false) => {
    if (!expr) return
    const deps = new Set<string>()
    if (deep) {
      collectExpressionIdentifiersDeep(expr, deps)
    } else {
      collectExpressionIdentifiers(expr, deps)
    }
    deps.forEach(dep => activeReadVars.add(dep))
  }

  const addDepsToTarget = (target: string, deps: Set<string>, map: Map<string, Set<string>>) => {
    if (deps.size === 0) return
    const existing = map.get(target)
    if (!existing) {
      map.set(target, new Set(deps))
      return
    }
    deps.forEach(dep => existing.add(dep))
  }

  for (const block of fn.blocks) {
    for (const instr of block.instructions) {
      if (instr.kind === 'Assign') {
        const target = deSSAVarName(instr.target.name)
        // Use deep traversal to capture dependencies inside callbacks (e.g., array.find(n => n === state))
        const dataDeps = getExpressionIdentifiersDeep(instr.value)
        addDepsToTarget(target, dataDeps, dataDepsByTarget)
        const controlDeps = controlDepsByInstr.get(instr) ?? new Set<string>()
        addDepsToTarget(target, controlDeps, controlDepsByTarget)
      } else if (instr.kind === 'Expression') {
        addActiveReads(instr.value)
      } else if (instr.kind === 'Phi') {
        const target = deSSAVarName(instr.target.name)
        const sources = new Set(instr.sources.map(src => deSSAVarName(src.id.name)))
        addDepsToTarget(target, sources, dataDepsByTarget)
      }
    }
    const term = block.terminator
    if (term.kind === 'Branch') {
      addActiveReads(term.test)
    } else if (term.kind === 'Switch') {
      addActiveReads(term.discriminant)
      term.cases.forEach(c => addActiveReads(c.test))
    } else if (term.kind === 'ForOf') {
      addActiveReads(term.iterable)
    } else if (term.kind === 'ForIn') {
      addActiveReads(term.object)
    } else if (term.kind === 'Return') {
      addActiveReads(term.argument ?? null, true)
    } else if (term.kind === 'Throw') {
      addActiveReads(term.argument)
    }
  }

  const neededVars = new Set(activeReadVars)
  let needsChanged = true
  while (needsChanged) {
    needsChanged = false
    for (const [target, dataDeps] of dataDepsByTarget) {
      if (!neededVars.has(target)) continue
      const controlDeps = controlDepsByTarget.get(target)
      const mergedDeps = new Set(dataDeps)
      controlDeps?.forEach(dep => mergedDeps.add(dep))
      for (const dep of mergedDeps) {
        if (!neededVars.has(dep)) {
          neededVars.add(dep)
          needsChanged = true
        }
      }
    }
  }

  const tracked = new Set(ctx.trackedVars)
  ctx.signalVars?.forEach(dep => tracked.add(dep))
  ctx.aliasVars?.forEach(dep => tracked.add(dep))
  ctx.storeVars?.forEach(dep => tracked.add(dep))
  const memo = new Set(ctx.memoVars)

  const isFunctionVar = (name: string) => ctx.functionVars?.has(name) ?? false
  const isSignal = (name: string) => ctx.signalVars?.has(name) ?? false
  const isStore = (name: string) => ctx.storeVars?.has(name) ?? false
  const isAlias = (name: string) => ctx.aliasVars?.has(name) ?? false
  const hasObservableScope = (name: string) => {
    if (!ctx.scopes) return false
    const direct = ctx.scopes.byName.get(name)
    if ((direct?.hasExternalEffect ?? false) || (direct?.shouldMemoize ?? false)) return true
    return ctx.scopes.scopes.some(
      scope =>
        (scope.hasExternalEffect || scope.shouldMemoize) &&
        Array.from(scope.declarations).some(decl => deSSAVarName(decl) === name),
    )
  }
  const isMutableLocal = (name: string) =>
    (ctx.mutatedVars?.has(name) ?? false) &&
    !isSignal(name) &&
    !isStore(name) &&
    !isAlias(name) &&
    !hasObservableScope(name)

  let changed = true
  while (changed) {
    changed = false
    for (const block of fn.blocks) {
      for (const instr of block.instructions) {
        if (instr.kind === 'Assign') {
          const target = deSSAVarName(instr.target.name)
          if (isFunctionVar(target)) continue

          // Use deep traversal to capture dependencies inside callbacks
          const dataDeps = getExpressionIdentifiersDeep(instr.value)
          const controlDepsForInstr = controlDepsByInstr.get(instr) ?? new Set<string>()
          const hasDataDep = Array.from(dataDeps).some(dep => tracked.has(dep))
          const hasControlDep = Array.from(controlDepsForInstr).some(dep => tracked.has(dep))

          if (!hasDataDep && !hasControlDep) continue
          if (!neededVars.has(target)) continue
          if (isMutableLocal(target)) continue

          if (!tracked.has(target)) {
            tracked.add(target)
            changed = true
          }
          // Check if this is a reactive object call (mergeProps) - should not be added to memo
          // These return objects/getters, not accessor functions
          const isReactiveObjectCall =
            instr.value.kind === 'CallExpression' &&
            instr.value.callee.kind === 'Identifier' &&
            ['mergeProps'].includes(instr.value.callee.name)
          if (hasDataDep && !isSignal(target) && !isStore(target) && !isReactiveObjectCall) {
            memo.add(target)
          }
        } else if (instr.kind === 'Phi') {
          const target = deSSAVarName(instr.target.name)
          if (isFunctionVar(target)) continue
          const hasDep = instr.sources.some(src => tracked.has(deSSAVarName(src.id.name)))
          if (!hasDep || !neededVars.has(target)) continue
          if (!tracked.has(target)) {
            tracked.add(target)
            changed = true
          }
          if (!isSignal(target) && !isStore(target)) {
            memo.add(target)
          }
        }
      }
    }
  }

  return { tracked, memo, controlDepsByInstr }
}
