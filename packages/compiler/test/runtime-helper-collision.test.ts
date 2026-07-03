import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

describe('runtime helper name collisions', () => {
  it('aliases runtime helper imports when source declares the default helper names', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        const __fictUseSignal = () => 'local signal'
        const __fictUseContext = () => 'local context'
        const __fictUseMemo = () => 'local memo'

        export function useProbe() {
          let count = $state(1)
          const doubled = count * 2
          return doubled
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).toMatch(/__fictUseSignal as __fictUseSignal_1/)
    expect(output).toMatch(/__fictUseContext as __fictUseContext_1/)
    expect(output).toMatch(/__fictUseMemo as __fictUseMemo_1/)
    expect(output).toContain('const __fictUseSignal = () => "local signal";')
    expect(output).toContain('const __fictUseContext = () => "local context";')
    expect(output).toContain('const __fictUseMemo = () => "local memo";')
    expect(output).toMatch(/const __fictCtx = __fictUseContext_1\(\)/)
    expect(output).toMatch(/const count = __fictUseSignal_1\(__fictCtx, 1/)
    expect(output).toMatch(/const __region_0 = __fictUseMemo_1\(__fictCtx/)
    expect(output).toMatch(/const doubled = count\(\) \* 2/)
  })

  it('aliases helper imports when named default function exports declare helper names', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        export default function __fictUseSignal() {
          return null
        }

        export function useProbe() {
          let count = $state(1)
          return count
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).toMatch(/__fictUseSignal as __fictUseSignal_1/)
    expect(output).toContain('export default function __fictUseSignal()')
    expect(output).toMatch(/const count = __fictUseSignal_1\(__fictCtx, 1/)
  })

  it('aliases helper imports when named default class exports declare helper names', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        export default class __fictUseContext {}

        export function useProbe() {
          let count = $state(1)
          return count
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).toMatch(/__fictUseContext as __fictUseContext_1/)
    expect(output).toContain('export default class __fictUseContext')
    expect(output).toMatch(/const __fictCtx = __fictUseContext_1\(\)/)
  })

  it('keeps existing internal helper aliases usable with default exports', () => {
    const output = transform(
      `
        import { $state } from 'fict'
        import { __fictUseSignal } from 'fict/internal'

        export default function LocalDefault() {
          return __fictUseSignal
        }

        export function useProbe() {
          let count = $state(1)
          return count
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).not.toMatch(/__fictUseSignal as __fictUseSignal_1/)
    expect(output).toMatch(/import \{ __fictUseSignal \} from ['"]fict\/internal['"]/)
    expect(output).toMatch(/const count = __fictUseSignal\(__fictCtx, 1/)
  })

  it('aliases readable helper imports shadowed by a local in another function', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        export function A() {
          let n = $state(0)
          return <div>{n}</div>
        }

        export function B() {
          const template = 5
          const insertBetween = 6
          let m = $state(0)
          return <span>{m}</span>
        }
      `,
      { dev: false },
    )

    // A emits template()/insertBetween(); B declares locals of the same name.
    // The shared module import must be aliased so B's body does not shadow it.
    expect(output).toMatch(/template as template_1/)
    expect(output).toMatch(/insertBetween as insertBetween_1/)
    expect(output).toMatch(/const __tmpl_\d+ = template_1\(/)
  })

  it('does not alias helper imports for anonymous default exports', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        export default function() {
          return null
        }

        export function useProbe() {
          let count = $state(1)
          return count
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).not.toContain('__fictUseSignal_1')
    expect(output).toContain('export default function ()')
    expect(output).toMatch(/const count = __fictUseSignal\(__fictCtx, 1/)
  })

  it('imports runtime helpers when helper names are only re-exported from another module', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        export { __fictUseSignal } from './runtime-alias'

        export function App() {
          let count = $state(1)
          return <span>{count}</span>
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).toMatch(/import \{[^}]*__fictUseSignal[^}]*\} from ["']fict\/internal["']/)
    expect(output).toMatch(/import \{[^}]*__fictUseMemo[^}]*\} from ["']fict\/internal["']/)
    expect(output).toMatch(/import \{[^}]*template[^}]*\} from ["']fict\/internal["']/)
    expect(output).toMatch(/import \{[^}]*insertBetween[^}]*\} from ["']fict\/internal["']/)
    expect(output).toMatch(/export \{ __fictUseSignal \} from ["']\.\/runtime-alias["'];/)
    expect(output).toMatch(/const count = __fictUseSignal\(__fictCtx, 1/)
  })

  it('keeps local export specifiers in the declared-name set', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        const __fictUseSignal = () => 'local signal'
        export { __fictUseSignal }

        export function useProbe() {
          let count = $state(1)
          return count
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).toMatch(/__fictUseSignal as __fictUseSignal_1/)
    expect(output).toContain('const __fictUseSignal = () => "local signal";')
    expect(output).toContain('export { __fictUseSignal };')
    expect(output).toMatch(/const count = __fictUseSignal_1\(__fictCtx, 1/)
  })

  it('imports helpers for renamed re-exported helper names', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        export { __fictUseSignal as forwardedSignal } from './runtime-alias'

        export function useProbe() {
          let count = $state(1)
          return count
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).toMatch(/import \{[^}]*__fictUseSignal[^}]*\} from ["']fict\/internal["']/)
    expect(output).toMatch(
      /export \{ __fictUseSignal as forwardedSignal \} from ["']\.\/runtime-alias["'];/,
    )
    expect(output).toMatch(/const count = __fictUseSignal\(__fictCtx, 1/)
  })

  it('imports helpers for string-literal re-exported helper names', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        export { __fictUseSignal as "helper-signal" } from './runtime-alias'

        export function useProbe() {
          let count = $state(1)
          return count
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).toMatch(/import \{[^}]*__fictUseSignal[^}]*\} from ["']fict\/internal["']/)
    expect(output).toMatch(
      /export \{ __fictUseSignal as "helper-signal" \} from ["']\.\/runtime-alias["'];/,
    )
    expect(output).toMatch(/const count = __fictUseSignal\(__fictCtx, 1/)
  })

  it('preserves user for-of and for-in marker-named calls', () => {
    const output = transform(
      `
        const __fictForOf = () => 'local for-of'
        const __fictForIn = () => 'local for-in'

        function __forOf(items, cb) {
          return 'user:' + items.length
        }

        function __forIn(obj, cb) {
          return 'user:' + Object.keys(obj).length
        }

        export function probe() {
          return __forOf([1], item => item) + __forIn({ a: 1 }, key => key)
        }
      `,
      { dev: false, optimize: false },
    )

    expect(output).toContain('const __fictForOf = () => "local for-of";')
    expect(output).toContain('const __fictForIn = () => "local for-in";')
    expect(output).toMatch(/function __forOf\(/)
    expect(output).toMatch(/function __forIn\(/)
    expect(output).toMatch(/__forOf\(\[1\], item => item\)/)
    expect(output).toMatch(/__forIn\(\{\s*a: 1\s*\}, key => key\)/)
    expect(output).not.toMatch(/function __fictForOf_?\d*\(/)
    expect(output).not.toMatch(/function __fictForIn_?\d*\(/)
    expect(output).not.toMatch(/__fictForOf_?\d*\(\[1\]/)
    expect(output).not.toMatch(/__fictForIn_?\d*\(\{\s*a: 1\s*\}/)
  })

  it('preserves imported parameter and nested marker-named calls', () => {
    const importedOutput = transform(
      `
        import { __forOf, __forIn } from './iter'

        export function probe() {
          return __forOf([1], item => item) + __forIn({ a: 1 }, key => key)
        }
      `,
      { dev: false, optimize: false },
    )

    expect(importedOutput).toMatch(/import \{ __forOf, __forIn \} from ['"]\.\/iter['"]/)
    expect(importedOutput).toMatch(/__forOf\(\[1\], item => item\)/)
    expect(importedOutput).toMatch(/__forIn\(\{\s*a: 1\s*\}, key => key\)/)
    expect(importedOutput).not.toContain('__fictForOf')
    expect(importedOutput).not.toContain('__fictForIn')

    const scopedOutput = transform(
      `
        export function withParams(__forOf, __forIn) {
          return __forOf([1], item => item) + __forIn({ a: 1 }, key => key)
        }

        export function nested() {
          const __forOf = (items, cb) => items.map(cb).join(',')
          const __forIn = (obj, cb) => Object.keys(obj).map(cb).join(',')
          return __forOf([1], item => item) + __forIn({ a: 1 }, key => key)
        }
      `,
      { dev: false, optimize: false },
    )

    expect(scopedOutput).toMatch(/function withParams\(__forOf, __forIn\)/)
    expect(scopedOutput).toMatch(/__forOf\(\[1\], item => item\)/)
    expect(scopedOutput).toMatch(/__forIn\(\{\s*a: 1\s*\}, key => key\)/)
    expect(scopedOutput).not.toContain('__fictForOf')
    expect(scopedOutput).not.toContain('__fictForIn')
  })
})
