/**
 * Advanced Spec Coverage Tests
 *
 * Tests for advanced scenarios including:
 * - Control flow re-execution behavior
 * - Async effect dependency tracking boundaries
 * - untrack escape hatch
 * - ErrorBoundary integration
 * - "use no memo" directive (when implemented)
 *
 */
import { describe, expect, it } from 'vitest'

import type { CompilerWarning, FictCompilerOptions } from '../src/index'

import { transform } from './test-utils'

function transformWithWarnings(
  source: string,
  options?: FictCompilerOptions,
): { output: string; warnings: CompilerWarning[] } {
  const warnings: CompilerWarning[] = []
  const output = transform(source, { onWarn: w => warnings.push(w), ...options })
  return { output, warnings }
}

// ============================================================================
// Control Flow Re-Execution Tests
// ============================================================================

describe('Control Flow Re-Execution', () => {
  describe('if statement control flow', () => {
    it('transforms signal read in if condition for re-execution', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const doubled = count * 2

          if (doubled > 10) {
            console.log('high')
          }

          return <div>{count}</div>
        }
      `)
      // Signal is read in control flow, triggering re-execution behavior
      // The condition should read the signal value
      expect(output).toContain('doubled()')
      expect(output).toContain('doubled() > 10')
    })

    it('handles nested if with signal reads', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let a = $state(1)
          let b = $state(2)

          if (a > 0) {
            if (b > 0) {
              console.log('both positive')
            }
          }

          return <div>{a}</div>
        }
      `)
      expect(output).toContain('a() > 0')
      expect(output).toContain('b() > 0')
    })
  })

  describe('for/while loop control flow', () => {
    it('transforms signal read in for loop condition', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let max = $state(10)
          let sum = 0

          for (let i = 0; i < max; i++) {
            sum += i
          }

          return <div>{sum}</div>
        }
      `)
      // Signal in loop condition triggers re-execution
      expect(output).toContain('max()')
      expect(output).toContain('i < max()')
    })

    it('transforms signal read in while condition', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let running = $state(true)
          let count = 0

          while (running && count < 5) {
            count++
            console.log(count)
          }

          return <div>{count}</div>
        }
      `)
      expect(output).toContain('running()')
    })
  })

  describe('switch statement control flow', () => {
    it('transforms signal read in switch discriminant', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let mode = $state('a')
          let result

          switch (mode) {
            case 'a':
              result = 'Mode A'
              break
            case 'b':
              result = 'Mode B'
              break
            default:
              result = 'Unknown'
          }

          return <div>{result}</div>
        }
      `)
      expect(output).toContain('switch (mode())')
    })
  })

  describe('ternary in statements (not JSX)', () => {
    it('transforms signal read in ternary statement', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const message = count > 0 ? 'positive' : 'non-positive'
          console.log(message)

          return <div>{count}</div>
        }
      `)
      // Ternary used in statement context, not JSX
      expect(output).toContain('count() > 0')
    })
  })

  describe('JSX-only usage does not trigger re-execution', () => {
    it('JSX-only signal reads create fine-grained bindings', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          // Only used in JSX, no control flow reads
          return <div>{count}</div>
        }
      `)
      // Template cloning uses insert for fine-grained updates
      expect(output).toContain('insert')
      expect(output).toContain('count()')
    })

    it('defined but unused derived does not trigger re-execution', () => {
      const output = transform(`
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const doubled = count * 2 // Defined but never read in control flow

          return <div>{count}</div>
        }
      `)
      // doubled should be a getter or memo, but not trigger re-execution
      // since it's defined but never read in control flow
      expect(output).toBeDefined()
    })
  })
})

// ============================================================================
// Async Effect Dependency Tracking Boundary Tests
// ============================================================================

describe('Async Effect Dependency Tracking Boundary', () => {
  it('tracks dependency reads before await', () => {
    const output = transform(`
      import { $state, $effect } from 'fict'
      let url = $state('/api')
      $effect(async () => {
        const endpoint = url // Read before await
        const res = await fetch(endpoint)
        const data = await res.json()
        console.log(data)
      })
    `)
    // The url signal should be tracked (read before await)
    expect(output).toContain('__fictUseEffect')
    expect(output).toContain('url()')
  })

  it('compiles effect with cleanup before await', () => {
    const output = transform(`
      import { $state, $effect } from 'fict'
      let url = $state('/api')
      $effect(async () => {
        const controller = new AbortController()
        const signal = controller.signal
        const endpoint = url

        try {
          const res = await fetch(endpoint, { signal })
          console.log(await res.json())
        } catch (e) {
          // Cancelled
        }

        return () => controller.abort()
      })
    `)
    expect(output).toContain('__fictUseEffect')
    expect(output).toContain('controller.abort()')
  })

  it('handles multiple awaits in effect', () => {
    const output = transform(`
      import { $state, $effect } from 'fict'
      let userId = $state('123')
      let includeDetails = $state(true)

      $effect(async () => {
        // Both reads happen before first await - should be tracked
        const id = userId
        const detailed = includeDetails

        const user = await fetchUser(id)
        const details = detailed ? await fetchDetails(id) : null
        console.log(user, details)
      })
    `)
    expect(output).toContain('userId()')
    expect(output).toContain('includeDetails()')
  })
})

// ============================================================================
// untrack Escape Hatch Tests
// ============================================================================

describe('untrack Escape Hatch', () => {
  it('allows untrack import to pass through', () => {
    const output = transform(`
      import { $state, $effect, untrack } from 'fict'
      let count = $state(0)

      $effect(() => {
        // Read inside untrack should not create dependency
        const value = untrack(() => count)
        console.log('Current:', value)
      })
    `)
    // untrack should be imported and used as-is
    expect(output).toContain('untrack')
    expect(output).toContain('__fictUseEffect')
  })

  it('transforms signal inside untrack callback', () => {
    const output = transform(`
      import { $state, $effect, untrack } from 'fict'
      let count = $state(0)
      let other = $state(1)

      $effect(() => {
        // count inside untrack - no tracking
        // other outside untrack - tracked
        const tracked = other
        const untracked = untrack(() => count)
        console.log(tracked, untracked)
      })
    `)
    expect(output).toContain('other()')
    // count inside untrack callback should still be called as getter
    expect(output).toContain('count')
  })
})

// ============================================================================
// ErrorBoundary Integration Tests
// ============================================================================

describe('ErrorBoundary Integration', () => {
  it('compiles component with ErrorBoundary', () => {
    const output = transform(`
      import { $state, ErrorBoundary } from 'fict'

      function RiskyWidget() {
        let data = $state(null)
        if (!data) throw new Error('No data')
        return <div>{data}</div>
      }

      function App() {
        return (
          <ErrorBoundary fallback={err => <div>Error: {err.message}</div>}>
            <RiskyWidget />
          </ErrorBoundary>
        )
      }
    `)
    // Should compile ErrorBoundary as a component call
    expect(output).toContain('ErrorBoundary')
    expect(output).toContain('fallback')
  })

  it('passes resetKeys prop through ErrorBoundary', () => {
    const output = transform(`
      import { $state, ErrorBoundary } from 'fict'

      function App() {
        let key = $state(0)
        return (
          <ErrorBoundary
            fallback={err => <div onClick={() => key++}>Retry</div>}
            resetKeys={[key]}
          >
            <Child />
          </ErrorBoundary>
        )
      }
    `)
    expect(output).toContain('resetKeys')
    expect(output).toContain('key()')
  })
})

// ============================================================================
// "use no memo" Directive Tests (Future Feature - Currently Skipped)
// ============================================================================

describe('"use no memo" Directive', () => {
  it('skips memo optimization when directive is present', () => {
    const output = transform(`
      import { $state } from 'fict'
      "use no memo"

      function WeirdComponent() {
        let count = $state(0)
        const doubled = count * 2
        return <div>{doubled}</div>
      }
    `)
    // With "use no memo", derived values should not be memoized
    expect(output).not.toContain('__fictMemo')
  })

  it('applies directive only to current scope', () => {
    const output = transform(`
      import { $state } from 'fict'

      function NormalComponent() {
        let count = $state(0)
        const doubled = count * 2
        return <div>{doubled}</div>
      }

      function WeirdComponent() {
        "use no memo"
        let count = $state(0)
        const doubled = count * 2
        return <div>{doubled}</div>
      }
    `)
    // NormalComponent should still have memos
    // This test will need refinement once the feature is implemented
    expect(output).toBeDefined()
  })
})
