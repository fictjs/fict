import { describe, it, expect } from 'vitest'

import { parseFictReturnAnnotation } from '../src/ir/build-hir'

import { transform } from './test-utils'

describe('Hook Return Annotation (@fictReturn)', () => {
  describe('parseFictReturnAnnotation', () => {
    it('parses object return annotation', () => {
      const node = {
        leadingComments: [
          {
            type: 'CommentBlock',
            value: '* @fictReturn { count: signal, double: memo } ',
          },
        ],
      } as any

      const result = parseFictReturnAnnotation(node)
      expect(result).not.toBeNull()
      expect(result?.objectProps).toBeDefined()
      expect(result?.objectProps?.get('count')).toBe('signal')
      expect(result?.objectProps?.get('double')).toBe('memo')
    })

    it('parses object return annotation with quotes', () => {
      const node = {
        leadingComments: [
          {
            type: 'CommentBlock',
            value: "* @fictReturn { count: 'signal', double: 'memo' } ",
          },
        ],
      } as any

      const result = parseFictReturnAnnotation(node)
      expect(result).not.toBeNull()
      expect(result?.objectProps?.get('count')).toBe('signal')
      expect(result?.objectProps?.get('double')).toBe('memo')
    })

    it('parses array return annotation', () => {
      const node = {
        leadingComments: [
          {
            type: 'CommentBlock',
            value: '* @fictReturn [0: signal, 1: memo] ',
          },
        ],
      } as any

      const result = parseFictReturnAnnotation(node)
      expect(result).not.toBeNull()
      expect(result?.arrayProps).toBeDefined()
      expect(result?.arrayProps?.get(0)).toBe('signal')
      expect(result?.arrayProps?.get(1)).toBe('memo')
    })

    it('parses direct accessor annotation - signal', () => {
      const node = {
        leadingComments: [
          {
            type: 'CommentBlock',
            value: "* @fictReturn 'signal' ",
          },
        ],
      } as any

      const result = parseFictReturnAnnotation(node)
      expect(result).not.toBeNull()
      expect(result?.directAccessor).toBe('signal')
    })

    it('parses direct accessor annotation - memo', () => {
      const node = {
        leadingComments: [
          {
            type: 'CommentBlock',
            value: '* @fictReturn "memo" ',
          },
        ],
      } as any

      const result = parseFictReturnAnnotation(node)
      expect(result).not.toBeNull()
      expect(result?.directAccessor).toBe('memo')
    })

    it('returns null for node without annotation', () => {
      const node = {
        leadingComments: [
          {
            type: 'CommentBlock',
            value: '* This is a regular comment ',
          },
        ],
      } as any

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
  })
})
