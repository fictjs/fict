import { describe, expect, it } from 'vitest'
import { parseSync, traverse } from '@babel/core'
import * as t from '@babel/types'
import { DirectiveType, parseDirectives, hasDirective, removeDirective } from '../src/utils'

const parseProgram = (code: string) =>
  parseSync(code, {
    filename: 'module.tsx',
    parserOpts: { sourceType: 'module', plugins: ['typescript', 'jsx'] },
    ast: true,
    code: false,
    cloneInputAst: false,
  })!

describe('DirectiveType', () => {
  it('should have correct values', () => {
    expect(DirectiveType.FictCompiler).toBe('use fict-compiler')
    expect(DirectiveType.FictCompilerDisable).toBe('use fict-compiler-disable')
    expect(DirectiveType.NoMemo).toBe('use no memo')
  })
})

describe('parseDirectives', () => {
  it('should detect use fict-compiler directive', () => {
    const ast = parseProgram(`
      "use fict-compiler"
      const x = 1
    `)

    let results: any[] = []
    traverse(ast, {
      Program(path) {
        results = parseDirectives(path as any, t)
      },
    })

    expect(results.some(r => r.type === DirectiveType.FictCompiler)).toBe(true)
  })

  it('should detect use no memo directive', () => {
    const ast = parseProgram(`
      "use no memo"
      function Foo() {}
    `)

    let results: any[] = []
    traverse(ast, {
      Program(path) {
        results = parseDirectives(path as any, t)
      },
    })

    expect(results.some(r => r.type === DirectiveType.NoMemo)).toBe(true)
  })

  it('should detect use fict-compiler-disable directive', () => {
    const ast = parseProgram(`
      "use fict-compiler-disable"
      const x = 1
    `)

    let results: any[] = []
    traverse(ast, {
      Program(path) {
        results = parseDirectives(path as any, t)
      },
    })

    expect(results.some(r => r.type === DirectiveType.FictCompilerDisable)).toBe(true)
  })

  it('should return empty array when no directives', () => {
    const ast = parseProgram(`
      const x = 1
    `)

    let results: any[] = []
    traverse(ast, {
      Program(path) {
        results = parseDirectives(path as any, t)
      },
    })

    expect(results.length).toBe(0)
  })
})

describe('hasDirective', () => {
  it('should return true when directive exists', () => {
    const ast = parseProgram(`
      "use fict-compiler"
      const x = 1
    `)

    let found = false
    traverse(ast, {
      Program(path) {
        found = hasDirective(path as any, DirectiveType.FictCompiler, t)
      },
    })

    expect(found).toBe(true)
  })

  it('should return false when directive does not exist', () => {
    const ast = parseProgram(`
      const x = 1
    `)

    let found = false
    traverse(ast, {
      Program(path) {
        found = hasDirective(path as any, DirectiveType.FictCompiler, t)
      },
    })

    expect(found).toBe(false)
  })
})
