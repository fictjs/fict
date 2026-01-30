import { describe, it, expect } from 'vitest'
import { parseSync } from '@babel/core'
import type * as BabelTypes from '@babel/types'
import {
  buildHIR,
  analyzeObjectShapes,
  shouldUseWholeObjectSubscription,
  getPropertySubscription,
  needsSpreadWrapping,
  printShapeAnalysis,
} from '../src/ir'

const parseFile = (code: string) =>
  parseSync(code, {
    filename: 'module.tsx',
    parserOpts: { sourceType: 'module', plugins: ['typescript', 'jsx'] },
    ast: true,
    code: false,
    cloneInputAst: false,
  })!

describe('Object Shape Lattice Analysis', () => {
  describe('analyzeObjectShapes', () => {
    it('should track known keys from object literals', () => {
      const ast = parseFile(`
        function test() {
          const obj = { a: 1, b: 2, c: 3 }
          return obj
        }
      `)
      const hir = buildHIR(ast)
      expect(hir.functions.length).toBeGreaterThan(0)
      const result = analyzeObjectShapes(hir.functions[0])

      const objShape = result.shapes.get('obj')
      expect(objShape).toBeDefined()
      expect(objShape!.knownKeys).toContain('a')
      expect(objShape!.knownKeys).toContain('b')
      expect(objShape!.knownKeys).toContain('c')
    })

    it('should track property reads on objects', () => {
      const ast = parseFile(`
        function test(props) {
          const x = props.foo
          const y = props.bar
          return x + y
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      const subscriptions = getPropertySubscription('props', result)
      expect(subscriptions).toBeDefined()
      expect(subscriptions!.has('foo')).toBe(true)
      expect(subscriptions!.has('bar')).toBe(true)
    })

    it('tracks store properties without forcing whole-object subscription', () => {
      const ast = parseFile(`
        import { $store } from 'fict'
        function test() {
          const store = $store({ a: 1, b: 2 })
          const value = store.a
          return value
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      const storeShape = result.shapes.get('store')
      expect(storeShape).toBeDefined()
      expect(storeShape!.source.kind).toBe('store')
      expect(shouldUseWholeObjectSubscription('store', result)).toBe(false)
      const subscriptions = getPropertySubscription('store', result)
      expect(subscriptions).toBeDefined()
      expect(subscriptions!.has('a')).toBe(true)
    })

    it('narrows dynamic store keys when key set is known', () => {
      const ast = parseFile(`
        import { $store } from 'fict'
        function test() {
          const store = $store({ a: 1, b: 2 })
          const key = 'a'
          return store[key]
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      expect(shouldUseWholeObjectSubscription('store', result)).toBe(false)
      const subscriptions = getPropertySubscription('store', result)
      expect(subscriptions).toBeDefined()
      expect(subscriptions!.has('a')).toBe(true)
    })

    it('should detect dynamic property access', () => {
      const ast = parseFile(`
        function test(props, key) {
          const value = props[key]
          return value
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      const propsShape = result.shapes.get('props')
      expect(propsShape).toBeDefined()
      expect(propsShape!.dynamicAccess).toBe(true)
      expect(shouldUseWholeObjectSubscription('props', result)).toBe(true)
    })

    it('should narrow dynamic keys within if branches', () => {
      const ast = parseFile(`
        function test(props, key) {
          if (key === 'a') {
            return props[key]
          }
          if (key === 'b') {
            return props[key]
          }
          return null
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      expect(shouldUseWholeObjectSubscription('props', result)).toBe(false)
      const subscriptions = getPropertySubscription('props', result)
      expect(subscriptions).toBeDefined()
      expect(subscriptions!.has('a')).toBe(true)
      expect(subscriptions!.has('b')).toBe(true)
    })

    it('should narrow dynamic keys within switch cases', () => {
      const ast = parseFile(`
        function test(props, key) {
          switch (key) {
            case 'a':
              return props[key]
            case 'b':
              return props[key]
            default:
              return null
          }
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      expect(shouldUseWholeObjectSubscription('props', result)).toBe(false)
      const subscriptions = getPropertySubscription('props', result)
      expect(subscriptions).toBeDefined()
      expect(subscriptions!.has('a')).toBe(true)
      expect(subscriptions!.has('b')).toBe(true)
    })

    it('should narrow dynamic keys from literal assignments', () => {
      const ast = parseFile(`
        function test(props) {
          const key = 'a'
          return props[key]
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      expect(shouldUseWholeObjectSubscription('props', result)).toBe(false)
      const subscriptions = getPropertySubscription('props', result)
      expect(subscriptions).toBeDefined()
      expect(subscriptions!.has('a')).toBe(true)
    })

    it('should narrow dynamic keys from conditional assignments', () => {
      const ast = parseFile(`
        function test(props, flag) {
          const key = flag ? 'a' : 'b'
          return props[key]
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      expect(shouldUseWholeObjectSubscription('props', result)).toBe(false)
      const subscriptions = getPropertySubscription('props', result)
      expect(subscriptions).toBeDefined()
      expect(subscriptions!.has('a')).toBe(true)
      expect(subscriptions!.has('b')).toBe(true)
    })

    it('should narrow dynamic keys from array key sets', () => {
      const ast = parseFile(`
        function test(props, idx) {
          const keys = ['a', 'b']
          const key = keys[idx]
          return props[key]
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      expect(shouldUseWholeObjectSubscription('props', result)).toBe(false)
      const subscriptions = getPropertySubscription('props', result)
      expect(subscriptions).toBeDefined()
      expect(subscriptions!.has('a')).toBe(true)
      expect(subscriptions!.has('b')).toBe(true)
    })

    it('should narrow dynamic keys from Object.keys of object literal', () => {
      const ast = parseFile(`
        function test(props, idx) {
          const keys = Object.keys({ a: 1, b: 2 })
          const key = keys[idx]
          return props[key]
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      expect(shouldUseWholeObjectSubscription('props', result)).toBe(false)
      const subscriptions = getPropertySubscription('props', result)
      expect(subscriptions).toBeDefined()
      expect(subscriptions!.has('a')).toBe(true)
      expect(subscriptions!.has('b')).toBe(true)
    })

    it('should narrow dynamic keys across OR conditions', () => {
      const ast = parseFile(`
        function test(props, key) {
          if (key === 'a' || key === 'b') {
            return props[key]
          }
          return null
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      expect(shouldUseWholeObjectSubscription('props', result)).toBe(false)
      const subscriptions = getPropertySubscription('props', result)
      expect(subscriptions).toBeDefined()
      expect(subscriptions!.has('a')).toBe(true)
      expect(subscriptions!.has('b')).toBe(true)
    })

    it('should narrow dynamic keys across AND conditions', () => {
      const ast = parseFile(`
        function test(props, key, ok) {
          if (key === 'a' && ok) {
            return props[key]
          }
          return null
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      expect(shouldUseWholeObjectSubscription('props', result)).toBe(false)
      const subscriptions = getPropertySubscription('props', result)
      expect(subscriptions).toBeDefined()
      expect(subscriptions!.has('a')).toBe(true)
    })

    it('should not narrow dynamic keys with loose equality', () => {
      const ast = parseFile(`
        function test(props, key) {
          if (key == 'a') {
            return props[key]
          }
          return null
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      const propsShape = result.shapes.get('props')
      expect(propsShape).toBeDefined()
      expect(propsShape!.dynamicAccess).toBe(true)
      expect(shouldUseWholeObjectSubscription('props', result)).toBe(true)
    })

    it('should clear narrowing after update expressions', () => {
      const ast = parseFile(`
        function test(props, key) {
          if (key === 'a') {
            props[key]
          }
          key++
          return props[key]
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      const propsShape = result.shapes.get('props')
      expect(propsShape).toBeDefined()
      expect(propsShape!.dynamicAccess).toBe(true)
      expect(shouldUseWholeObjectSubscription('props', result)).toBe(true)
    })

    it('should preserve narrowing inside for loops before updates', () => {
      const ast = parseFile(`
        function test(props, key) {
          if (key === 'a') {
            for (; key === 'a'; key++) {
              return props[key]
            }
          }
          return null
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      expect(shouldUseWholeObjectSubscription('props', result)).toBe(false)
      const subscriptions = getPropertySubscription('props', result)
      expect(subscriptions).toBeDefined()
      expect(subscriptions!.has('a')).toBe(true)
    })

    it('should narrow keys from for-of over key arrays', () => {
      const ast = parseFile(`
        function test(props) {
          const keys = ['a', 'b']
          for (const key of keys) {
            return props[key]
          }
          return null
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      expect(shouldUseWholeObjectSubscription('props', result)).toBe(false)
      const subscriptions = getPropertySubscription('props', result)
      expect(subscriptions).toBeDefined()
      expect(subscriptions!.has('a')).toBe(true)
      expect(subscriptions!.has('b')).toBe(true)
    })

    it('should narrow keys from for-in over known objects', () => {
      const ast = parseFile(`
        function test(props) {
          const obj = { a: 1, b: 2 }
          for (const key in obj) {
            return props[key]
          }
          return null
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      expect(shouldUseWholeObjectSubscription('props', result)).toBe(false)
      const subscriptions = getPropertySubscription('props', result)
      expect(subscriptions).toBeDefined()
      expect(subscriptions!.has('a')).toBe(true)
      expect(subscriptions!.has('b')).toBe(true)
    })

    it('should not leak narrowing into for-of shadowed bindings', () => {
      const ast = parseFile(`
        function test(props, key, items) {
          if (key === 'a') {
            for (const key of items) {
              return props[key]
            }
          }
          return null
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      const propsShape = result.shapes.get('props')
      expect(propsShape).toBeDefined()
      expect(propsShape!.dynamicAccess).toBe(true)
      expect(shouldUseWholeObjectSubscription('props', result)).toBe(true)
    })

    it('should track object escaping through return', () => {
      const ast = parseFile(`
        function test(props) {
          return props
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      const propsShape = result.shapes.get('props')
      expect(propsShape).toBeDefined()
      expect(propsShape!.escapes).toBe(true)
    })

    it('should track object escaping through function calls', () => {
      const ast = parseFile(`
        function test(props) {
          doSomething(props)
          return null
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      const propsShape = result.shapes.get('props')
      expect(propsShape).toBeDefined()
      expect(propsShape!.escapes).toBe(true)
    })

    it('should detect spread operations', () => {
      const ast = parseFile(`
        function test(props) {
          const merged = { ...props, extra: 1 }
          return merged
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      const propsShape = result.shapes.get('props')
      expect(propsShape).toBeDefined()
      expect(propsShape!.isSpread).toBe(true)
      expect(needsSpreadWrapping('props', result)).toBe(true)
    })

    it('should track mutable keys on assignment', () => {
      const ast = parseFile(`
        function test(obj) {
          obj.foo = 1
          obj.bar = 2
          return obj
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      const objShape = result.shapes.get('obj')
      expect(objShape).toBeDefined()
      expect(objShape!.mutableKeys).toContain('foo')
      expect(objShape!.mutableKeys).toContain('bar')
    })

    it('should identify props parameter specially', () => {
      const ast = parseFile(`
        function Component(props) {
          return props.name
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      const propsShape = result.shapes.get('props')
      expect(propsShape).toBeDefined()
      expect(propsShape!.source.kind).toBe('props')
    })

    it('should use property subscription for simple prop access', () => {
      const ast = parseFile(`
        function Component(props) {
          const name = props.name
          const age = props.age
          return name + age
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      expect(shouldUseWholeObjectSubscription('props', result)).toBe(false)
      const subscriptions = getPropertySubscription('props', result)
      expect(subscriptions).toBeDefined()
      expect(subscriptions!.has('name')).toBe(true)
      expect(subscriptions!.has('age')).toBe(true)
    })

    it('should fallback to whole-object subscription for complex patterns', () => {
      const ast = parseFile(`
        function Component(props, dynamicKey) {
          const value = props[dynamicKey]
          return value
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      expect(shouldUseWholeObjectSubscription('props', result)).toBe(true)
    })

    it('should handle nested member expressions', () => {
      const ast = parseFile(`
        function Component(props) {
          const name = props.user.name
          const email = props.user.email
          return name + email
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      // Should track access to 'user' on props
      const subscriptions = getPropertySubscription('props', result)
      expect(subscriptions).toBeDefined()
      expect(subscriptions!.has('user')).toBe(true)
    })

    it('should handle JSX attribute access', () => {
      const ast = parseFile(`
        function Component(props) {
          return <div className={props.className}>{props.children}</div>
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      const subscriptions = getPropertySubscription('props', result)
      expect(subscriptions).toBeDefined()
      expect(subscriptions!.has('className')).toBe(true)
      expect(subscriptions!.has('children')).toBe(true)
    })

    it('should handle JSX spread attributes', () => {
      const ast = parseFile(`
        function Component(props) {
          return <div {...props} />
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      const propsShape = result.shapes.get('props')
      expect(propsShape).toBeDefined()
      expect(propsShape!.isSpread).toBe(true)
    })

    it('should handle conditional expressions', () => {
      const ast = parseFile(`
        function Component(props) {
          const value = props.condition ? props.a : props.b
          return value
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      const subscriptions = getPropertySubscription('props', result)
      expect(subscriptions).toBeDefined()
      expect(subscriptions!.has('condition')).toBe(true)
      expect(subscriptions!.has('a')).toBe(true)
      expect(subscriptions!.has('b')).toBe(true)
    })
  })

  describe('printShapeAnalysis', () => {
    it('should produce readable output', () => {
      const ast = parseFile(`
        function Component(props) {
          const name = props.name
          return name
        }
      `)
      const hir = buildHIR(ast)
      const result = analyzeObjectShapes(hir.functions[0])

      const output = printShapeAnalysis(result)
      expect(output).toContain('Object Shape Analysis')
      expect(output).toContain('props')
      expect(output).toContain('source: props')
    })
  })
})
