import { describe, it, expect } from 'vitest'
import * as t from '@babel/types'

import { parseFictReturnAnnotation } from '../src/ir/build-hir'

import { transform } from './test-utils'

function createAnnotatedNode(comment: string): t.Noop {
  const node = t.noop()
  node.leadingComments = [{ type: 'CommentBlock', value: comment }]
  return node
}

describe('Hook Return Annotation (@fictReturn)', () => {
  describe('parseFictReturnAnnotation', () => {
    it('parses object return annotation', () => {
      const node = createAnnotatedNode('* @fictReturn { count: signal, double: memo } ')

      const result = parseFictReturnAnnotation(node)
      expect(result).not.toBeNull()
      expect(result?.objectProps).toBeDefined()
      expect(result?.objectProps?.get('count')).toBe('signal')
      expect(result?.objectProps?.get('double')).toBe('memo')
    })

    it('parses object return annotation with quotes', () => {
      const node = createAnnotatedNode("* @fictReturn { count: 'signal', double: 'memo' } ")

      const result = parseFictReturnAnnotation(node)
      expect(result).not.toBeNull()
      expect(result?.objectProps?.get('count')).toBe('signal')
      expect(result?.objectProps?.get('double')).toBe('memo')
    })

    it('parses quoted object keys', () => {
      const node = createAnnotatedNode(
        '* @fictReturn { "foo-bar": "signal", "default": "memo", "0": "signal" } ',
      )

      const result = parseFictReturnAnnotation(node)
      expect(result).not.toBeNull()
      expect(result?.objectProps?.get('foo-bar')).toBe('signal')
      expect(result?.objectProps?.get('default')).toBe('memo')
      expect(result?.objectProps?.get('0')).toBe('signal')
    })

    it('parses multiline object return annotation', () => {
      const node = createAnnotatedNode(`*
       * @fictReturn {
       *   count: 'signal',
       *   double: 'memo'
       * }
       * Additional text.
       `)

      const result = parseFictReturnAnnotation(node)
      expect(result).not.toBeNull()
      expect(result?.objectProps?.get('count')).toBe('signal')
      expect(result?.objectProps?.get('double')).toBe('memo')
    })

    it('parses array return annotation', () => {
      const node = createAnnotatedNode('* @fictReturn [0: signal, 1: memo] ')

      const result = parseFictReturnAnnotation(node)
      expect(result).not.toBeNull()
      expect(result?.arrayProps).toBeDefined()
      expect(result?.arrayProps?.get(0)).toBe('signal')
      expect(result?.arrayProps?.get(1)).toBe('memo')
    })

    it('parses multiline array return annotation', () => {
      const node = createAnnotatedNode(`*
       * @fictReturn [
       *   0: 'signal',
       *   1: 'memo'
       * ]
       `)

      const result = parseFictReturnAnnotation(node)
      expect(result).not.toBeNull()
      expect(result?.arrayProps?.get(0)).toBe('signal')
      expect(result?.arrayProps?.get(1)).toBe('memo')
    })

    it('ignores object annotation values that only prefix valid accessors', () => {
      const cases = [
        '* @fictReturn { count: "signalized" } ',
        '* @fictReturn { count: signalized } ',
        '* @fictReturn { count: "memoized" } ',
        '* @fictReturn { count: memorandum } ',
      ]

      for (const source of cases) {
        const result = parseFictReturnAnnotation(createAnnotatedNode(source))
        expect(result).toBeNull()
      }
    })

    it('ignores array annotation values that only prefix valid accessors', () => {
      const cases = [
        '* @fictReturn [0: "signalized"] ',
        '* @fictReturn [0: signalized] ',
        '* @fictReturn [0: "memoized"] ',
        '* @fictReturn [0: memorandum] ',
      ]

      for (const source of cases) {
        const result = parseFictReturnAnnotation(createAnnotatedNode(source))
        expect(result).toBeNull()
      }
    })

    it('parses direct accessor annotation - signal', () => {
      const node = createAnnotatedNode("* @fictReturn 'signal' ")

      const result = parseFictReturnAnnotation(node)
      expect(result).not.toBeNull()
      expect(result?.directAccessor).toBe('signal')
    })

    it('parses direct accessor annotation with surrounding JSDoc text', () => {
      const node = createAnnotatedNode(`*
       * Hook result metadata.
       * @fictReturn "signal"
       * Other docs.
       `)

      const result = parseFictReturnAnnotation(node)
      expect(result).not.toBeNull()
      expect(result?.directAccessor).toBe('signal')
    })

    it('parses direct accessor annotation - memo', () => {
      const node = createAnnotatedNode('* @fictReturn "memo" ')

      const result = parseFictReturnAnnotation(node)
      expect(result).not.toBeNull()
      expect(result?.directAccessor).toBe('memo')
    })

    it('parses object-style direct accessor annotation', () => {
      const node = createAnnotatedNode('* @fictReturn { directAccessor: "signal" } ')

      const result = parseFictReturnAnnotation(node)
      expect(result).not.toBeNull()
      expect(result?.directAccessor).toBe('signal')
      expect(result?.objectProps).toBeUndefined()
    })

    it('parses object-style direct memo annotation', () => {
      const node = createAnnotatedNode("* @fictReturn { directAccessor: 'memo' } ")

      const result = parseFictReturnAnnotation(node)
      expect(result).not.toBeNull()
      expect(result?.directAccessor).toBe('memo')
      expect(result?.objectProps).toBeUndefined()
    })

    it('ignores invalid object-style direct accessor values', () => {
      const node = createAnnotatedNode('* @fictReturn { directAccessor: "store" } ')

      const result = parseFictReturnAnnotation(node)
      expect(result).toBeNull()
    })

    it('keeps ordinary object annotations as object properties', () => {
      const node = createAnnotatedNode('* @fictReturn { value: "signal" } ')

      const result = parseFictReturnAnnotation(node)
      expect(result).not.toBeNull()
      expect(result?.directAccessor).toBeUndefined()
      expect(result?.objectProps?.get('value')).toBe('signal')
    })

    it('returns null for node without annotation', () => {
      const node = createAnnotatedNode('* This is a regular comment ')

      const result = parseFictReturnAnnotation(node)
      expect(result).toBeNull()
    })

    it('returns null for null node', () => {
      const result = parseFictReturnAnnotation(null)
      expect(result).toBeNull()
    })
  })

  describe('compilation with @fictReturn annotation', () => {
    it('compiles hook with object return annotation', () => {
      const source = `
        import { $state, $memo } from 'fict'

        /**
         * @fictReturn { count: 'signal', double: 'memo' }
         */
        export function useCounter() {
          let count = $state(0)
          const double = $memo(() => count * 2)
          return { count, double }
        }

        function App() {
          const counter = useCounter()
          return <div>{counter.count} - {counter.double}</div>
        }
      `
      // Should compile without errors
      const output = transform(source)
      expect(output).toContain('useCounter')
      expect(output).toContain('App')
    })

    it('compiles hook with array return annotation', () => {
      const source = `
        import { $state, $memo } from 'fict'

        /**
         * @fictReturn [0: 'signal', 1: 'memo']
         */
        export function useCounter() {
          let count = $state(0)
          const double = $memo(() => count * 2)
          return [count, double]
        }

        function App() {
          const [count, double] = useCounter()
          return <div>{count} - {double}</div>
        }
      `
      // Should compile without errors
      const output = transform(source)
      expect(output).toContain('useCounter')
      expect(output).toContain('App')
    })

    it('consumes hook annotation in component', () => {
      const source = `
        import { $state } from 'fict'

        /**
         * @fictReturn { value: 'signal' }
         */
        function useValue() {
          let value = $state(0)
          return { value }
        }

        function Display() {
          const state = useValue()
          return <span>{state.value}</span>
        }
      `
      const output = transform(source, { fineGrainedDom: true })
      // The hook result should be properly tracked as reactive
      expect(output).toContain('useValue')
      expect(output).toContain('Display')
    })

    it('handles multiple properties in annotation', () => {
      const source = `
        import { $state, $memo } from 'fict'

        /**
         * @fictReturn { a: 'signal', b: 'memo', c: 'signal' }
         */
        function useMultiple() {
          let a = $state(1)
          const b = $memo(() => a + 1)
          let c = $state(3)
          return { a, b, c }
        }

        function App() {
          const state = useMultiple()
          return <div>{state.a} + {state.b} + {state.c}</div>
        }
      `
      const output = transform(source)
      expect(output).toContain('useMultiple')
    })

    it('arrow function hook with annotation', () => {
      const source = `
        import { $state } from 'fict'

        /**
         * @fictReturn { count: 'signal' }
         */
        const useCounter = () => {
          let count = $state(0)
          return { count }
        }

        function App() {
          const { count } = useCounter()
          return <button onClick={() => count++}>{count}</button>
        }
      `
      const output = transform(source)
      expect(output).toContain('useCounter')
    })

    it('consumes object-style direct accessor annotations for opaque hooks', () => {
      const source = `
        import { readCount } from './external'

        /**
         * @fictReturn { directAccessor: "signal" }
         */
        function useCounter() {
          return readCount()
        }

        function App() {
          const count = useCounter()
          return <div>{count}</div>
        }
      `

      const output = transform(source, { fineGrainedDom: true })

      expect(output).toMatch(/count\(\)/)
      expect(output).not.toMatch(/=> count[,)]/)
    })
  })
})
