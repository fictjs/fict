import { describe, expect, it } from 'vitest'

import type { CodegenContext, ModuleBindingKind } from '../src/ir/codegen'
import { shouldAutoExtract } from '../src/ir/codegen-auto-extract'
import type { BasicBlock, Expression, Identifier, Instruction, Literal } from '../src/ir/hir'

const ctx = (overrides: Partial<CodegenContext> = {}): CodegenContext =>
  ({
    autoExtractEnabled: true,
    ...overrides,
  }) as CodegenContext

const id = (name: string): Identifier => ({ kind: 'Identifier', name })

const literal = (value: string | number | boolean | null | undefined): Literal => ({
  kind: 'Literal',
  value,
})

const call = (callee: Expression, args: Expression[] = []): Expression => ({
  kind: 'CallExpression',
  callee,
  arguments: args,
})

const binary = (left: Expression, right: Expression): Expression => ({
  kind: 'BinaryExpression',
  operator: '+',
  left,
  right,
})

const arrow = (body: Expression, options: { isAsync?: boolean } = {}): Expression => ({
  kind: 'ArrowFunction',
  params: [],
  body,
  isExpression: true,
  isAsync: options.isAsync,
})

const block = (instructions: Instruction[], argument?: Expression): BasicBlock => ({
  id: 0,
  instructions,
  terminator: { kind: 'Return', argument },
})

const fn = (body: BasicBlock[]): Expression => ({
  kind: 'FunctionExpression',
  params: [],
  body,
})

const stableModuleCtx = (kind: ModuleBindingKind): CodegenContext =>
  ctx({
    moduleDeclaredNames: new Set(['handle']),
    moduleBindingKinds: new Map([['handle', kind]]),
  })

describe('shouldAutoExtract', () => {
  it('does not extract handlers when auto extraction is disabled', () => {
    expect(shouldAutoExtract(arrow(call(id('save'))), ctx({ autoExtractEnabled: false }))).toBe(
      false,
    )
  })

  it('extracts only stable bare handler identifiers', () => {
    expect(shouldAutoExtract(id('handle'), stableModuleCtx('function'))).toBe(true)
    expect(shouldAutoExtract(id('handle'), stableModuleCtx('const'))).toBe(true)
    expect(shouldAutoExtract(id('handle'), stableModuleCtx('class'))).toBe(true)
    expect(shouldAutoExtract(id('handle'), stableModuleCtx('let'))).toBe(false)
    expect(shouldAutoExtract(id('handle'), ctx())).toBe(false)
  })

  it('rejects mutated function-local handler identifiers', () => {
    const localCtx = ctx({
      currentFunctionDeclaredNames: new Set(['handle']),
      functionBindingKinds: new Map([['handle', 'const']]),
    })
    const mutatedCtx = ctx({
      currentFunctionDeclaredNames: new Set(['handle']),
      functionBindingKinds: new Map([['handle', 'const']]),
      mutatedVars: new Set(['handle']),
    })

    expect(shouldAutoExtract(id('handle'), localCtx)).toBe(true)
    expect(shouldAutoExtract(id('handle'), mutatedCtx)).toBe(false)
  })

  it('extracts inline handlers with external calls, async work, or threshold complexity', () => {
    expect(shouldAutoExtract(arrow(call(id('save'))), ctx({ autoExtractThreshold: 100 }))).toBe(
      true,
    )
    expect(
      shouldAutoExtract(
        arrow({
          kind: 'AwaitExpression',
          argument: call(id('load')),
        }),
        ctx({ autoExtractThreshold: 100 }),
      ),
    ).toBe(true)
    expect(
      shouldAutoExtract(arrow(binary(id('left'), literal(1))), ctx({ autoExtractThreshold: 4 })),
    ).toBe(true)
  })

  it('keeps simple inline handlers below the threshold eager', () => {
    expect(shouldAutoExtract(arrow(id('value')), ctx({ autoExtractThreshold: 4 }))).toBe(false)
  })

  it('checks block-bodied function expressions for external work', () => {
    const handler = fn([
      block(
        [
          {
            kind: 'Expression',
            value: call(id('save')),
          },
        ],
        literal(undefined),
      ),
    ])

    expect(shouldAutoExtract(handler, ctx({ autoExtractThreshold: 100 }))).toBe(true)
  })
})
