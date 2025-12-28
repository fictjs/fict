import { describe, it, expect } from 'vitest'
import * as t from '@babel/types'
import { parse } from '@babel/core'
import traverse from '@babel/traverse'
import { extractStaticHtml } from '../src/fine-grained-dom'

describe('extractStaticHtml', () => {
  const parseJSX = (code: string): t.JSXElement => {
    const ast = parse(code, {
      sourceType: 'module',
      configFile: false,
      babelrc: false,
      parserOpts: {
        plugins: ['jsx', 'typescript'],
      },
    })
    if (!ast) throw new Error('Failed to parse')
    let jsx: t.JSXElement | null = null
    traverse(ast, {
      JSXElement(path) {
        if (!jsx) jsx = path.node
      },
    })
    if (!jsx) throw new Error('No JSX found')
    return jsx
  }

  it('extracts simple static HTML', () => {
    const code = '<div id="test" class="foo">Hello</div>'
    const params = extractStaticHtml(parseJSX(code), t)
    expect(params.html).toBe('<div id="test" class="foo">Hello</div>')
    expect(params.hasDynamic).toBe(false)
  })

  it('handles boolean attributes', () => {
    const code = '<button disabled>Click</button>'
    const params = extractStaticHtml(parseJSX(code), t)
    expect(params.html).toBe('<button disabled>Click</button>')
  })

  it('identifies dynamic attributes and returns bindings', () => {
    // Our extraction logic currently SKIPS dynamic attributes in the HTML string
    // and sets hasDynamic = true
    const code = '<div id={dynamic}></div>'
    const params = extractStaticHtml(parseJSX(code), t)
    expect(params.html).toBe('<div></div>')
    expect(params.hasDynamic).toBe(true)
    expect(params.bindings).toHaveLength(1)
    expect(params.bindings[0].type).toBe('attr')
    expect(params.bindings[0].name).toBe('id')
    expect(params.bindings[0].path).toEqual([]) // root element
  })

  it('handles child expressions with correct paths', () => {
    // <div>Text {name} <span>Static</span></div>
    // Children: [Text(0), Expression(1), Element(2)]
    const code = '<div>Text {name} <span>Static</span></div>'
    const params = extractStaticHtml(parseJSX(code), t)
    expect(params.html).toBe('<div>Text  <span>Static</span></div>')
    expect(params.hasDynamic).toBe(true)
    expect(params.bindings).toHaveLength(1)
    expect(params.bindings[0].type).toBe('text')
    expect(params.bindings[0].path).toEqual([1])
  })

  it('handles nested structures and paths', () => {
    // <ul>
    //   <li>{item}</li> (path: 0 -> 0)
    // </ul>
    const code = '<ul><li>{item}</li></ul>'
    const params = extractStaticHtml(parseJSX(code), t)
    expect(params.html).toBe('<ul><li> </li></ul>')
    expect(params.hasDynamic).toBe(true)
    expect(params.bindings).toHaveLength(1)
    expect(params.bindings[0].type).toBe('text')
    expect(params.bindings[0].path).toEqual([0, 0])
  })
})
