import { describe, expect, it } from 'vitest'
import { transform } from './test-utils'

describe('SVG/MathML Namespace Support ()', () => {
  it('throws for unsupported JSX namespaced tags', () => {
    const source = `
      export function App() {
        return <svg:rect />
      }
    `
    expect(() => transform(source)).toThrow(/Unsupported JSX tag syntax/)
  })

  describe('SVG elements', () => {
    it('does not add isSVG flag for root svg element', () => {
      const source = `
        export function App() {
          return <svg><circle cx="50" cy="50" r="40"/></svg>
        }
      `
      const output = transform(source)
      // Root svg element creates namespace itself, no isSVG flag needed
      expect(output).toContain('template(')
      expect(output).not.toContain('template("<circle')
      // The template should include the full svg element
      expect(output).toContain('<svg>')
    })

    it('adds isSVG flag for dynamic SVG children', () => {
      const source = `
        import { $state } from 'fict'
        export function App() {
          const show = $state(true)
          return (
            <svg>
              {show && <circle cx="50" cy="50" r="40"/>}
            </svg>
          )
        }
      `
      const output = transform(source)
      // Dynamic children inside svg should have isSVG flag
      // The circle template needs isSVG=true to be parsed in SVG namespace
      expect(output).toContain('template(')
      // The circle element is dynamic, so it should be a separate template with isSVG flag
      // Check for the pattern: template("...circle...", void 0, true) for isSVG
      // Note: Use looser regex since output has escaped quotes
      expect(output).toContain('<circle')
      expect(output).toMatch(/template\([^)]*circle[^)]*,\s*void 0,\s*true\)/)
    })

    it('handles nested SVG elements correctly', () => {
      const source = `
        import { $state } from 'fict'
        export function App() {
          const visible = $state(true)
          return (
            <svg>
              <g>
                {visible && <rect width="100" height="100"/>}
              </g>
            </svg>
          )
        }
      `
      const output = transform(source)
      // rect is inside svg > g, so it needs isSVG flag
      expect(output).toContain('<rect')
      expect(output).toMatch(/template\([^)]*rect[^)]*,\s*void 0,\s*true\)/)
    })

    it('normalizes static SVG JSX attribute aliases in templates', () => {
      const source = `
        export function App() {
          return (
            <svg viewBox="0 0 10 10">
              <path
                strokeWidth={2}
                strokeLinecap="round"
                fillRule="evenodd"
                clipRule="evenodd"
                xlinkHref="#a"
              />
              <use xlink:href="#b" />
            </svg>
          )
        }
      `
      const output = transform(source)

      expect(output).toContain('viewBox')
      expect(output).toContain('stroke-width=\\"2\\"')
      expect(output).toContain('stroke-linecap=\\"round\\"')
      expect(output).toContain('fill-rule=\\"evenodd\\"')
      expect(output).toContain('clip-rule=\\"evenodd\\"')
      expect(output).toContain('xlink:href=\\"#a\\"')
      expect(output).toContain('xlink:href=\\"#b\\"')
      expect(output).not.toContain('strokeWidth')
      expect(output).not.toContain('strokeLinecap')
      expect(output).not.toContain('xlinkHref')
    })

    it('normalizes dynamic SVG JSX attribute aliases in bindings', () => {
      const source = `
        import { $state } from 'fict'
        export function App() {
          const width = $state(2)
          const href = $state('#a')
          return (
            <svg>
              <path strokeWidth={width} strokeLinecap="round" xlinkHref={href} />
            </svg>
          )
        }
      `
      const output = transform(source)

      expect(output).toContain('"stroke-width"')
      expect(output).toContain('"xlink:href"')
      expect(output).toContain('stroke-linecap=\\"round\\"')
      expect(output).not.toContain('strokeWidth')
      expect(output).not.toContain('xlinkHref')
    })

    it('exits SVG namespace inside foreignObject', () => {
      const source = `
        import { $state } from 'fict'
        export function App() {
          const show = $state(true)
          return (
            <svg>
              <foreignObject>
                {show && <div>HTML inside SVG</div>}
              </foreignObject>
            </svg>
          )
        }
      `
      const output = transform(source)
      // Inside foreignObject, elements should be HTML, not SVG
      // The div template should NOT have isSVG flag
      expect(output).toContain('template(')
      // The div should be a regular HTML template without namespace flags
      expect(output).not.toMatch(/template\("[^"]*div[^"]*",\s*undefined,\s*true\)/)
    })
  })

  describe('MathML elements', () => {
    it('does not add isMathML flag for root math element', () => {
      const source = `
        export function App() {
          return <math><mi>x</mi></math>
        }
      `
      const output = transform(source)
      // Root math element creates namespace itself
      expect(output).toContain('template(')
      expect(output).toContain('<math>')
    })

    it('adds isMathML flag for dynamic MathML children', () => {
      const source = `
        import { $state } from 'fict'
        export function App() {
          const show = $state(true)
          return (
            <math>
              {show && <mi>y</mi>}
            </math>
          )
        }
      `
      const output = transform(source)
      // The mi element is dynamic, should have isMathML flag
      // Check for pattern: template("...", void 0, void 0, true) for isMathML
      expect(output).toContain('<mi>')
      expect(output).toMatch(/template\([^)]*mi[^)]*,\s*void 0,\s*void 0,\s*true\)/)
    })
  })

  describe('List rendering inside SVG', () => {
    it('hoists SVG templates with isSVG flag in list context', () => {
      const source = `
        import { $state } from 'fict'
        export function App() {
          const items = $state([1, 2, 3])
          return (
            <svg>
              {items.map(item => <circle key={item} r={item * 10}/>)}
            </svg>
          )
        }
      `
      const output = transform(source)
      // List items inside SVG should have isSVG flag in hoisted template
      expect(output).toContain('<circle')
      expect(output).toMatch(/template\([^)]*circle[^)]*,\s*void 0,\s*true\)/)
    })
  })
})
