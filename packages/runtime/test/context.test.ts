import { describe, it, expect } from 'vitest'

import { createContext, useContext, hasContext, createSignal, render, Fragment } from '../src/index'

const tick = () => Promise.resolve()

describe('Context', () => {
  describe('createContext', () => {
    it('creates a context with default value', () => {
      const ThemeContext = createContext('light')
      expect(ThemeContext.defaultValue).toBe('light')
      expect(typeof ThemeContext.id).toBe('symbol')
      expect(typeof ThemeContext.Provider).toBe('function')
    })

    it('creates a context with object default value', () => {
      const UserContext = createContext({ name: 'guest', role: 'anonymous' })
      expect(UserContext.defaultValue).toEqual({ name: 'guest', role: 'anonymous' })
    })
  })

  describe('useContext', () => {
    it('returns default value when no provider exists', () => {
      const ThemeContext = createContext('light')
      const container = document.createElement('div')
      let capturedTheme: string | undefined

      const Child = () => {
        capturedTheme = useContext(ThemeContext)
        return { type: 'span', props: { children: capturedTheme } }
      }

      const dispose = render(() => ({ type: Child, props: {} }), container)

      expect(capturedTheme).toBe('light')
      expect(container.textContent).toBe('light')

      dispose()
    })

    it('returns provided value from nearest provider', () => {
      const ThemeContext = createContext('light')
      const container = document.createElement('div')
      let capturedTheme: string | undefined

      const Child = () => {
        capturedTheme = useContext(ThemeContext)
        return { type: 'span', props: { children: capturedTheme } }
      }

      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: 'dark',
            children: { type: Child, props: {} },
          },
        }),
        container,
      )

      expect(capturedTheme).toBe('dark')
      expect(container.textContent).toBe('dark')

      dispose()
    })

    it('supports nested providers with different values', () => {
      const ThemeContext = createContext('default')
      const container = document.createElement('div')
      const capturedThemes: string[] = []

      const Child = () => {
        capturedThemes.push(useContext(ThemeContext))
        return { type: 'span', props: { children: useContext(ThemeContext) } }
      }

      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: 'outer',
            children: {
              type: Fragment,
              props: {
                children: [
                  { type: Child, props: {} },
                  {
                    type: ThemeContext.Provider,
                    props: {
                      value: 'inner',
                      children: { type: Child, props: {} },
                    },
                  },
                ],
              },
            },
          },
        }),
        container,
      )

      expect(capturedThemes).toEqual(['outer', 'inner'])
      expect(container.textContent).toBe('outerinner')

      dispose()
    })

    it('supports multiple contexts', () => {
      const ThemeContext = createContext('light')
      const LangContext = createContext('en')
      const container = document.createElement('div')
      let theme: string | undefined
      let lang: string | undefined

      const Child = () => {
        theme = useContext(ThemeContext)
        lang = useContext(LangContext)
        return { type: 'span', props: { children: `${theme}-${lang}` } }
      }

      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: 'dark',
            children: {
              type: LangContext.Provider,
              props: {
                value: 'zh',
                children: { type: Child, props: {} },
              },
            },
          },
        }),
        container,
      )

      expect(theme).toBe('dark')
      expect(lang).toBe('zh')
      expect(container.textContent).toBe('dark-zh')

      dispose()
    })
  })

  describe('hasContext', () => {
    it('returns false when no provider exists', () => {
      const ThemeContext = createContext('light')
      const container = document.createElement('div')
      let hasTheme: boolean | undefined

      const Child = () => {
        hasTheme = hasContext(ThemeContext)
        return { type: 'span', props: { children: hasTheme ? 'yes' : 'no' } }
      }

      const dispose = render(() => ({ type: Child, props: {} }), container)

      expect(hasTheme).toBe(false)
      expect(container.textContent).toBe('no')

      dispose()
    })

    it('returns true when provider exists', () => {
      const ThemeContext = createContext('light')
      const container = document.createElement('div')
      let hasTheme: boolean | undefined

      const Child = () => {
        hasTheme = hasContext(ThemeContext)
        return { type: 'span', props: { children: hasTheme ? 'yes' : 'no' } }
      }

      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: 'dark',
            children: { type: Child, props: {} },
          },
        }),
        container,
      )

      expect(hasTheme).toBe(true)
      expect(container.textContent).toBe('yes')

      dispose()
    })
  })

  describe('Provider', () => {
    it('renders children correctly', () => {
      const ThemeContext = createContext('light')
      const container = document.createElement('div')

      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: 'dark',
            children: { type: 'span', props: { children: 'content' } },
          },
        }),
        container,
      )

      expect(container.textContent).toBe('content')

      dispose()
    })

    it('handles null children', () => {
      const ThemeContext = createContext('light')
      const container = document.createElement('div')

      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: 'dark',
            children: null,
          },
        }),
        container,
      )

      expect(container.innerHTML).toContain('fict:ctx')

      dispose()
    })

    it('handles array children', () => {
      const ThemeContext = createContext('light')
      const container = document.createElement('div')

      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: 'dark',
            children: [
              { type: 'span', props: { children: 'A' } },
              { type: 'span', props: { children: 'B' } },
            ],
          },
        }),
        container,
      )

      expect(container.textContent).toBe('AB')

      dispose()
    })

    it('static value is captured at mount time (Fict fine-grained model)', async () => {
      // In Fict's fine-grained model, component functions execute only once.
      // Provider's value is captured at mount time and is static.
      // For reactive context values, use a store inside the Provider.
      const CountContext = createContext(0)
      const container = document.createElement('div')
      let capturedCount: number | undefined

      const Child = () => {
        capturedCount = useContext(CountContext)
        return { type: 'span', props: { children: String(capturedCount) } }
      }

      const dispose = render(
        () => ({
          type: CountContext.Provider,
          props: {
            value: 42, // Static value
            children: { type: Child, props: {} },
          },
        }),
        container,
      )

      expect(capturedCount).toBe(42)
      expect(container.textContent).toBe('42')

      dispose()
    })

    it('supports reactive context value using store pattern', async () => {
      // For truly reactive context values, pass a signal/store as the value
      // and consume it reactively in child components
      const ThemeContext = createContext({ theme: createSignal('light') })
      const container = document.createElement('div')
      let capturedTheme: string | undefined

      const Child = () => {
        const ctx = useContext(ThemeContext)
        // Access the signal reactively
        capturedTheme = ctx.theme()
        return { type: 'span', props: { children: () => ctx.theme() } }
      }

      const themeSignal = createSignal<'light' | 'dark'>('light')
      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: { theme: themeSignal },
            children: { type: Child, props: {} },
          },
        }),
        container,
      )

      expect(capturedTheme).toBe('light')

      themeSignal('dark')
      await tick()

      // The span content is reactive because it uses a getter
      expect(container.textContent).toBe('dark')

      dispose()
    })
  })

  describe('edge cases', () => {
    it('works with deeply nested components', () => {
      const ThemeContext = createContext('light')
      const container = document.createElement('div')
      let capturedTheme: string | undefined

      const Level3 = () => {
        capturedTheme = useContext(ThemeContext)
        return { type: 'span', props: { children: capturedTheme } }
      }

      const Level2 = () => {
        return { type: Level3, props: {} }
      }

      const Level1 = () => {
        return { type: Level2, props: {} }
      }

      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: 'dark',
            children: { type: Level1, props: {} },
          },
        }),
        container,
      )

      expect(capturedTheme).toBe('dark')
      expect(container.textContent).toBe('dark')

      dispose()
    })

    it('handles undefined default value', () => {
      const OptionalContext = createContext<string | undefined>(undefined)
      const container = document.createElement('div')
      let capturedValue: string | undefined

      const Child = () => {
        capturedValue = useContext(OptionalContext)
        return { type: 'span', props: { children: capturedValue ?? 'none' } }
      }

      const dispose = render(() => ({ type: Child, props: {} }), container)

      expect(capturedValue).toBeUndefined()
      expect(container.textContent).toBe('none')

      dispose()
    })

    it('handles null as provided value', () => {
      const NullableContext = createContext<string | null>('default')
      const container = document.createElement('div')
      let capturedValue: string | null | undefined

      const Child = () => {
        capturedValue = useContext(NullableContext)
        return { type: 'span', props: { children: capturedValue ?? 'null' } }
      }

      const dispose = render(
        () => ({
          type: NullableContext.Provider,
          props: {
            value: null,
            children: { type: Child, props: {} },
          },
        }),
        container,
      )

      expect(capturedValue).toBeNull()
      expect(container.textContent).toBe('null')

      dispose()
    })
  })
})
