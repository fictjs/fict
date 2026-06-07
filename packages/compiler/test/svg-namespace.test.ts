import { describe, expect, it } from 'vitest'
import { transform } from './test-utils'

describe('SVG/MathML Namespace Support ()', () => {
  it('preserves JSX namespaced intrinsic tags', () => {
    const source = `
      export function App() {
        return <svg:path d="M0 0" xlink:href="#a"><svg:title /></svg:path>
      }
    `
    const output = transform(source)
    expect(output).toContain('<svg:path')
    expect(output).toContain('d=\\"M0 0\\"')
    expect(output).toContain('xlink:href=\\"#a\\"')
    expect(output).toContain('<svg:title></svg:title>')
    expect(output).toContain('</svg:path>')
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

    it('passes SVG namespace to dynamic string intrinsic slots', () => {
      const source = `
        export function App({ Tag }) {
          return (
            <svg>
              <Tag data-id="direct" />
            </svg>
          )
        }
      `
      const output = transform(source, { dev: false })

      expect(output).toContain('createElementInNamespace')
      expect(output).toMatch(/createElementInNamespace\([^)]*,\s*"svg"\)/)
    })

    it('adds isSVG flag for standalone SVG intrinsic component roots', () => {
      const source = `
        function CircleIcon() {
          return <circle data-id="circle" />
        }
        function PathIcon() {
          return <path data-id="path" d="M0 0" />
        }
        function GroupIcon() {
          return <g data-id="group"><path data-id="nested" d="M0 0" /></g>
        }
        export function App() {
          return <svg><CircleIcon /><PathIcon /><GroupIcon /></svg>
        }
      `
      const output = transform(source, { dev: false })

      expect(output).toMatch(/template\([^)]*circle[^)]*,\s*void 0,\s*true\)/)
      expect(output).toMatch(/template\([^)]*path[^)]*,\s*void 0,\s*true\)/)
      expect(output).toMatch(/template\([^)]*<g[^)]*,\s*void 0,\s*true\)/)
    })

    it('does not pass SVG namespace to dynamic tags inside foreignObject', () => {
      const source = `
        export function App({ Tag }) {
          return (
            <svg>
              <foreignObject>
                <Tag data-id="html" />
              </foreignObject>
            </svg>
          )
        }
      `
      const output = transform(source, { dev: false })

      expect(output).not.toContain('createElementInNamespace')
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

    it('keeps dynamic SVG integration point elements in the SVG namespace', () => {
      const source = `
        import { $state } from 'fict'
        export function App() {
          const show = $state(true)
          return (
            <svg>
              {show && <foreignObject><div data-id="html" /></foreignObject>}
            </svg>
          )
        }
      `
      const output = transform(source)

      expect(output).toMatch(/template\([^)]*foreignObject[^)]*,\s*void 0,\s*true\)/)
    })

    it.each(['title', 'desc'])('exits SVG namespace inside %s integration point', parentTag => {
      const source = `
          import { $state } from 'fict'
          export function App() {
            const show = $state(true)
            return (
              <svg>
                <${parentTag}>
                  {show && <circle data-id="${parentTag}-circle"></circle>}
                  {show && <div data-id="${parentTag}-div">html</div>}
                </${parentTag}>
                <g>{show && <circle data-id="svg-circle"></circle>}</g>
              </svg>
            )
          }
        `
      const output = transform(source)

      expect(output).toContain(`<circle data-id=\\"${parentTag}-circle\\">`)
      expect(output).toContain(`<div data-id=\\"${parentTag}-div\\">`)
      expect(output).not.toMatch(
        new RegExp(`template\\([^)]*${parentTag}-circle[^)]*,\\s*void 0,\\s*true\\)`),
      )
      expect(output).not.toMatch(
        new RegExp(`template\\([^)]*${parentTag}-div[^)]*,\\s*void 0,\\s*true\\)`),
      )
      expect(output).toMatch(/template\([^)]*svg-circle[^)]*,\s*void 0,\s*true\)/)
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

    it('passes MathML namespace to dynamic string intrinsic slots', () => {
      const source = `
        export function App({ Tag }) {
          return (
            <math>
              <Tag data-id="direct">x</Tag>
            </math>
          )
        }
      `
      const output = transform(source, { dev: false })

      expect(output).toContain('createElementInNamespace')
      expect(output).toMatch(/createElementInNamespace\([^)]*,\s*"mathml"\)/)
    })

    it('adds isMathML flag for standalone MathML intrinsic component roots', () => {
      const source = `
        function Token() {
          return <mi data-id="token">x</mi>
        }
        export function App() {
          return <math><Token /></math>
        }
      `
      const output = transform(source, { dev: false })

      expect(output).toMatch(/template\([^)]*mi[^)]*,\s*void 0,\s*void 0,\s*true\)/)
    })

    it('exits MathML namespace inside annotation-xml with HTML encoding', () => {
      const source = `
        import { $state } from 'fict'
        export function App() {
          const show = $state(true)
          return (
            <math>
              <annotation-xml encoding="text/html">
                {show && <mi data-id="html-mi">y</mi>}
              </annotation-xml>
              <annotation-xml encoding="APPLICATION/XHTML+XML">
                {show && <mi data-id="xhtml-mi">z</mi>}
              </annotation-xml>
            </math>
          )
        }
      `
      const output = transform(source)

      expect(output).toContain('<mi data-id=\\"html-mi\\">')
      expect(output).toContain('<mi data-id=\\"xhtml-mi\\">')
      expect(output).not.toMatch(/template\([^)]*html-mi[^)]*,\s*void 0,\s*void 0,\s*true\)/)
      expect(output).not.toMatch(/template\([^)]*xhtml-mi[^)]*,\s*void 0,\s*void 0,\s*true\)/)
    })

    it('keeps non-HTML annotation-xml dynamic children in MathML namespace', () => {
      const source = `
        import { $state } from 'fict'
        export function App() {
          const show = $state(true)
          return (
            <math>
              <annotation-xml encoding="application/xml">
                {show && <mi data-id="math-mi">y</mi>}
              </annotation-xml>
            </math>
          )
        }
      `
      const output = transform(source)

      expect(output).toContain('<mi data-id=\\"math-mi\\">')
      expect(output).toMatch(/template\([^)]*math-mi[^)]*,\s*void 0,\s*void 0,\s*true\)/)
    })

    it('keeps dynamic MathML annotation-xml elements in the MathML namespace', () => {
      const source = `
        import { $state } from 'fict'
        export function App() {
          const show = $state(true)
          return (
            <math>
              {show && <annotation-xml encoding="text/html"><div data-id="html" /></annotation-xml>}
            </math>
          )
        }
      `
      const output = transform(source)

      expect(output).toMatch(/template\([^)]*annotation-xml[^)]*,\s*void 0,\s*void 0,\s*true\)/)
    })

    it.each(['mi', 'mo', 'mn', 'ms', 'mtext'])(
      'exits MathML namespace for dynamic children under %s text integration points',
      parentTag => {
        const source = `
          import { $state } from 'fict'
          export function App() {
            const show = $state(true)
            return (
              <math>
                <${parentTag}>
                  {show && <mi data-id="${parentTag}-child">y</mi>}
                </${parentTag}>
              </math>
            )
          }
        `
        const output = transform(source)

        expect(output).toContain(`<mi data-id=\\"${parentTag}-child\\">`)
        expect(output).not.toMatch(
          new RegExp(`template\\([^)]*${parentTag}-child[^)]*,\\s*void 0,\\s*void 0,\\s*true\\)`),
        )
      },
    )

    it('keeps MathML-only text integration point exceptions in MathML namespace', () => {
      const source = `
        import { $state } from 'fict'
        export function App() {
          const show = $state(true)
          return (
            <math>
              <mtext>
                {show && <mglyph data-id="glyph"></mglyph>}
                {show && <malignmark data-id="align"></malignmark>}
              </mtext>
            </math>
          )
        }
      `
      const output = transform(source)

      expect(output).toMatch(/template\([^)]*glyph[^)]*,\s*void 0,\s*void 0,\s*true\)/)
      expect(output).toMatch(/template\([^)]*align[^)]*,\s*void 0,\s*void 0,\s*true\)/)
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

    it('passes SVG namespace to keyed list callbacks that return dynamic tags', () => {
      const source = `
        export function App() {
          const items = ['a']
          const Tag = 'circle'
          return (
            <svg>
              {items.map(item => <Tag key={item} data-id="list" />)}
            </svg>
          )
        }
      `
      const output = transform(source, { dev: false })

      expect(output).toContain('createKeyedList')
      expect(output).toMatch(/createKeyedList\([\s\S]*,\s*true,\s*"svg"\)/)
    })
  })
})
