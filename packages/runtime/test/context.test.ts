import { describe, it, expect } from 'vitest'

import {
  createContext,
  useContext,
  useContextAccessor,
  hasContext,
  render,
  Fragment,
  ErrorBoundary,
  createEffect,
  createMemo,
  untrack,
  onMount,
  onDestroy,
} from '../src/index'
import { createSignal, reactive } from '../src/advanced'
import { __fictProp } from '../src/internal'

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
    it('returns a reactive default accessor outside a provider', () => {
      const ThemeContext = createContext('light')
      const container = document.createElement('div')
      let theme!: () => string

      const Child = () => {
        theme = useContextAccessor(ThemeContext)
        return { type: 'span', props: { children: theme } }
      }

      const dispose = render(() => ({ type: Child, props: {} }), container)

      expect(theme()).toBe('light')
      expect(container.textContent).toBe('light')
      dispose()
    })

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

    it('evaluates provider-owned memos in their creation context', () => {
      const ThemeContext = createContext('default')
      const version = createSignal(0)
      const container = document.createElement('div')
      let lazyMemo!: () => string
      let reactiveMemo!: () => string
      let initialReactiveValue: string | undefined

      const Child = () => {
        lazyMemo = createMemo(() => useContext(ThemeContext))
        reactiveMemo = createMemo(() => {
          version()
          return useContext(ThemeContext)
        })
        initialReactiveValue = reactiveMemo()
        return { type: 'span', props: { children: 'child' } }
      }

      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: 'provided',
            children: { type: Child, props: {} },
          },
        }),
        container,
      )

      expect(initialReactiveValue).toBe('provided')
      expect(lazyMemo()).toBe('provided')

      version(1)
      expect(reactiveMemo()).toBe('provided')

      dispose()
    })

    it('does not let rootless memos borrow a provider context', () => {
      const ThemeContext = createContext('default')
      const rootlessMemo = createMemo(() => useContext(ThemeContext))
      const container = document.createElement('div')
      let captured: string | undefined

      const Child = () => {
        captured = rootlessMemo()
        return { type: 'span', props: { children: captured } }
      }

      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: 'provided',
            children: { type: Child, props: {} },
          },
        }),
        container,
      )

      expect(captured).toBe('default')
      expect(container.textContent).toBe('default')

      dispose()
    })

    it('reruns provider-owned effects in their creation context', async () => {
      const ThemeContext = createContext('default')
      const version = createSignal(0)
      const container = document.createElement('div')
      const seen: string[] = []

      const Child = () => {
        createEffect(() => {
          version()
          seen.push(useContext(ThemeContext))
        })
        return { type: 'span', props: { children: 'child' } }
      }

      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: 'provided',
            children: { type: Child, props: {} },
          },
        }),
        container,
      )

      expect(seen).toEqual(['provided'])

      version(1)
      await tick()
      expect(seen).toEqual(['provided', 'provided'])

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

    it('creates provider marker in container ownerDocument', () => {
      const ThemeContext = createContext('light')
      const foreignDoc = document.implementation.createHTMLDocument('foreign-context')
      const container = foreignDoc.createElement('div')

      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: 'dark',
            children: { type: 'span', props: { children: 'content' } },
          },
        }),
        container as unknown as HTMLElement,
      )

      const marker = Array.from(container.childNodes).find(
        node => node.nodeType === Node.COMMENT_NODE && (node as Comment).data === 'fict:ctx',
      ) as Comment | undefined
      expect(marker).toBeTruthy()
      expect(marker?.ownerDocument).toBe(foreignDoc)

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

    it('static value is available at mount time', async () => {
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

    it('updates accessor consumers without rerunning the component', async () => {
      const ThemeContext = createContext('light')
      const container = document.createElement('div')
      const theme = createSignal('light')
      let currentTheme!: () => string
      let childRuns = 0

      const Child = () => {
        childRuns++
        currentTheme = useContextAccessor(ThemeContext)
        return { type: 'span', props: { children: currentTheme } }
      }

      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: __fictProp(() => theme()),
            children: { type: Child, props: {} },
          },
        }),
        container,
      )

      expect(currentTheme()).toBe('light')
      expect(container.textContent).toBe('light')
      expect(childRuns).toBe(1)

      theme('dark')
      await tick()

      expect(currentTheme()).toBe('dark')
      expect(container.textContent).toBe('dark')
      expect(childRuns).toBe(1)

      dispose()
    })

    it('does not treat nested callback context reads as setup snapshots', async () => {
      const ThemeContext = createContext('light')
      const container = document.createElement('div')
      const theme = createSignal('light')
      const effectTrigger = createSignal(0)
      let eventTheme: string | undefined
      let mountedTheme: string | undefined
      let untrackedEffectTheme: string | undefined
      let childRuns = 0
      let destroyed = 0

      const Child = () => {
        childRuns++
        const currentTheme = useContextAccessor(ThemeContext)
        onMount(() => {
          mountedTheme = useContext(ThemeContext)
        })
        createEffect(() => {
          effectTrigger()
          untrackedEffectTheme = untrack(() => useContext(ThemeContext))
        })
        onDestroy(() => {
          destroyed++
        })
        return {
          type: 'button',
          props: {
            'on:click': () => {
              eventTheme = useContext(ThemeContext)
            },
            children: currentTheme,
          },
        }
      }

      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: __fictProp(() => theme()),
            children: { type: Child, props: {} },
          },
        }),
        container,
      )

      const button = container.querySelector('button')!
      button.click()
      expect(mountedTheme).toBe('light')
      expect(eventTheme).toBe('light')
      expect(untrackedEffectTheme).toBe('light')

      theme('dark')
      await tick()

      expect(container.querySelector('button')).toBe(button)
      expect(button.textContent).toBe('dark')
      expect(childRuns).toBe(1)
      expect(destroyed).toBe(0)

      effectTrigger(1)
      await tick()
      expect(untrackedEffectTheme).toBe('dark')
      expect(container.querySelector('button')).toBe(button)

      dispose()
      expect(destroyed).toBe(1)
    })

    it('does not treat callback ref context reads inside ErrorBoundary as setup snapshots', async () => {
      const ThemeContext = createContext('light')
      const container = document.createElement('div')
      const theme = createSignal('light')
      let refTheme: string | undefined
      let childRuns = 0
      let destroyed = 0

      const Child = () => {
        childRuns++
        const currentTheme = useContextAccessor(ThemeContext)
        onDestroy(() => {
          destroyed++
        })
        return {
          type: 'span',
          props: {
            ref: (element: Element | null) => {
              if (element) refTheme = useContext(ThemeContext)
            },
            children: currentTheme,
          },
        }
      }

      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: __fictProp(() => theme()),
            children: {
              type: ErrorBoundary,
              props: {
                fallback: 'fallback',
                children: { type: Child, props: {} },
              },
            },
          },
        }),
        container,
      )

      const span = container.querySelector('span')!
      expect(refTheme).toBe('light')

      theme('dark')
      await tick()

      expect(container.querySelector('span')).toBe(span)
      expect(span.textContent).toBe('dark')
      expect(childRuns).toBe(1)
      expect(destroyed).toBe(0)

      dispose()
      expect(destroyed).toBe(1)
    })

    it('does not treat ErrorBoundary onError context reads as setup snapshots', async () => {
      const ThemeContext = createContext('light')
      const container = document.createElement('div')
      const theme = createSignal('light')
      let errorTheme: string | undefined
      let childRuns = 0
      let destroyed = 0

      const Child = () => {
        childRuns++
        const currentTheme = useContextAccessor(ThemeContext)
        onDestroy(() => {
          destroyed++
        })
        return { type: 'span', props: { children: currentTheme } }
      }
      const Broken = () => {
        throw new Error('context boundary failure')
      }

      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: __fictProp(() => theme()),
            children: {
              type: Fragment,
              props: {
                children: [
                  { type: Child, props: {} },
                  {
                    type: ErrorBoundary,
                    props: {
                      fallback: 'fallback',
                      onError: () => {
                        errorTheme = useContext(ThemeContext)
                      },
                      children: { type: Broken, props: {} },
                    },
                  },
                ],
              },
            },
          },
        }),
        container,
      )

      const span = container.querySelector('span')!
      expect(errorTheme).toBe('light')
      expect(container.textContent).toBe('lightfallback')

      theme('dark')
      await tick()

      expect(container.querySelector('span')).toBe(span)
      expect(container.textContent).toBe('darkfallback')
      expect(childRuns).toBe(1)
      expect(destroyed).toBe(0)

      dispose()
      expect(destroyed).toBe(1)
    })

    it('keeps legacy setup-time useContext consumers updating through compatibility replay', async () => {
      const ThemeContext = createContext('light')
      const container = document.createElement('div')
      const theme = createSignal('light')
      let childRuns = 0

      const Child = () => {
        childRuns++
        const currentTheme = useContext(ThemeContext)
        return { type: 'span', props: { children: currentTheme } }
      }

      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: __fictProp(() => theme()),
            children: { type: Child, props: {} },
          },
        }),
        container,
      )

      expect(container.textContent).toBe('light')
      expect(childRuns).toBe(1)

      theme('dark')
      await tick()

      expect(container.textContent).toBe('dark')
      expect(childRuns).toBe(2)
      dispose()
    })

    it('drops setup snapshot registrations when their reactive branch unmounts', async () => {
      const ThemeContext = createContext('light')
      const container = document.createElement('div')
      const theme = createSignal('light')
      const showLegacy = createSignal(true)
      let legacyDestroyed = 0
      let accessorRuns = 0

      const LegacyChild = () => {
        const currentTheme = useContext(ThemeContext)
        onDestroy(() => {
          legacyDestroyed++
        })
        return { type: 'span', props: { id: 'legacy', children: currentTheme } }
      }

      const AccessorChild = () => {
        accessorRuns++
        const currentTheme = useContextAccessor(ThemeContext)
        return { type: 'span', props: { id: 'accessor', children: currentTheme } }
      }

      const Switcher = () => ({
        type: Fragment,
        props: {
          children: reactive(() =>
            showLegacy() ? { type: LegacyChild, props: {} } : { type: AccessorChild, props: {} },
          ),
        },
      })

      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: __fictProp(() => theme()),
            children: { type: Switcher, props: {} },
          },
        }),
        container,
      )

      expect(container.querySelector('#legacy')?.textContent).toBe('light')
      showLegacy(false)
      await tick()

      const accessor = container.querySelector('#accessor')!
      expect(legacyDestroyed).toBe(1)
      expect(accessorRuns).toBe(1)

      theme('dark')
      await tick()

      expect(container.querySelector('#accessor')).toBe(accessor)
      expect(accessor.textContent).toBe('dark')
      expect(accessorRuns).toBe(1)

      dispose()
    })

    it('updates useContext reads made inside descendant effects', async () => {
      const ThemeContext = createContext('light')
      const theme = createSignal('light')
      const container = document.createElement('div')
      const seen: string[] = []
      let childRuns = 0

      const Child = () => {
        childRuns++
        createEffect(() => {
          seen.push(useContext(ThemeContext))
        })
        return { type: 'span', props: { children: 'child' } }
      }

      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: __fictProp(() => theme()),
            children: { type: Child, props: {} },
          },
        }),
        container,
      )

      expect(seen).toEqual(['light'])
      theme('dark')
      await tick()
      expect(seen).toEqual(['light', 'dark'])
      expect(childRuns).toBe(1)
      dispose()
    })

    it('preserves descendant state, DOM identity, focus, and scroll on value changes', async () => {
      const ThemeContext = createContext('light')
      const theme = createSignal('light')
      const container = document.createElement('div')
      document.body.appendChild(container)
      let setLocal!: (value: number) => void
      let childRuns = 0
      let destroyed = 0

      const Child = () => {
        childRuns++
        const currentTheme = useContextAccessor(ThemeContext)
        const local = createSignal(0)
        setLocal = value => local(value)
        onDestroy(() => {
          destroyed++
        })
        return {
          type: 'section',
          props: {
            children: [
              { type: 'span', props: { id: 'theme-value', children: currentTheme } },
              { type: 'span', props: { id: 'local-value', children: local } },
              { type: 'input', props: { id: 'draft' } },
              { type: 'div', props: { id: 'scroller', children: 'content' } },
            ],
          },
        }
      }

      const dispose = render(
        () => ({
          type: ThemeContext.Provider,
          props: {
            value: __fictProp(() => theme()),
            children: { type: Child, props: {} },
          },
        }),
        container,
      )

      try {
        const input = container.querySelector<HTMLInputElement>('#draft')!
        const scroller = container.querySelector<HTMLElement>('#scroller')!
        input.value = 'draft text'
        input.focus()
        scroller.scrollTop = 24
        setLocal(7)
        await tick()

        theme('dark')
        await tick()

        expect(container.querySelector('#theme-value')?.textContent).toBe('dark')
        expect(container.querySelector('#local-value')?.textContent).toBe('7')
        expect(container.querySelector('#draft')).toBe(input)
        expect(container.querySelector('#scroller')).toBe(scroller)
        expect(input.value).toBe('draft text')
        expect(document.activeElement).toBe(input)
        expect(scroller.scrollTop).toBe(24)
        expect(childRuns).toBe(1)
        expect(destroyed).toBe(0)
      } finally {
        dispose()
        container.remove()
      }

      expect(destroyed).toBe(1)
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
        return { type: 'span', props: { children: reactive(() => ctx.theme()) } }
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

    it('disposes provider child effects on host root dispose', async () => {
      const ThemeContext = createContext('light')
      const trigger = createSignal(0)
      const container = document.createElement('div')
      let runs = 0

      const Child = () => {
        useContext(ThemeContext)
        createEffect(() => {
          trigger()
          runs += 1
        })
        return { type: 'span', props: { children: 'child' } }
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

      expect(runs).toBe(1)
      expect(container.textContent).toBe('child')

      dispose()
      trigger(1)
      await tick()

      expect(runs).toBe(1)
      expect(container.textContent).toBe('')
    })

    it('disposes provider child effects on conditional provider unmount', async () => {
      const ThemeContext = createContext('light')
      const show = createSignal(true)
      const trigger = createSignal(0)
      const container = document.createElement('div')
      let runs = 0

      const Child = () => {
        useContext(ThemeContext)
        createEffect(() => {
          trigger()
          runs += 1
        })
        return { type: 'span', props: { children: 'child' } }
      }

      const dispose = render(
        () => ({
          type: Fragment,
          props: {
            children: reactive(() =>
              show()
                ? {
                    type: ThemeContext.Provider,
                    props: {
                      value: 'dark',
                      children: { type: Child, props: {} },
                    },
                  }
                : null,
            ),
          },
        }),
        container,
      )

      expect(runs).toBe(1)
      expect(container.textContent).toBe('child')

      show(false)
      await tick()
      expect(container.textContent).toBe('')

      trigger(1)
      await tick()
      expect(runs).toBe(1)

      dispose()
    })

    it('runs provider child onDestroy callbacks on host root dispose', () => {
      const ThemeContext = createContext('light')
      const container = document.createElement('div')
      let destroyed = 0

      const Child = () => {
        useContext(ThemeContext)
        onDestroy(() => {
          destroyed += 1
        })
        return { type: 'span', props: { children: 'child' } }
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

      expect(destroyed).toBe(0)

      dispose()

      expect(destroyed).toBe(1)
    })

    it('routes provider child cleanup errors to ancestor boundaries', async () => {
      const ThemeContext = createContext('light')
      const trigger = createSignal(0)
      const container = document.createElement('div')
      let captured: unknown = null
      let shouldThrow = false

      const Child = () => {
        useContext(ThemeContext)
        createEffect(() => {
          trigger()
          return () => {
            if (shouldThrow) {
              throw new Error('provider cleanup boom')
            }
          }
        })
        return { type: 'span', props: { children: 'child' } }
      }

      const dispose = render(
        () => ({
          type: ErrorBoundary,
          props: {
            fallback: 'cleanup-fallback',
            onError: err => {
              captured = err
            },
            children: {
              type: ThemeContext.Provider,
              props: {
                value: 'dark',
                children: { type: Child, props: {} },
              },
            },
          },
        }),
        container,
      )

      expect(container.textContent).toBe('child')

      shouldThrow = true
      trigger(1)
      await tick()

      expect(captured).toBeInstanceOf(Error)
      expect((captured as Error).message).toBe('provider cleanup boom')
      expect(container.textContent).toBe('cleanup-fallback')

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
