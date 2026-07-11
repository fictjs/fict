import { describe, it, expect } from 'vitest'

import type { FictNode } from '@fictjs/runtime'
import { Suspense, createSuspenseToken } from '@fictjs/runtime'
import { renderToStream } from '../src/index'

import { parseHTML } from 'linkedom'

const decoder = new TextDecoder()

async function readReadableStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let out = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  return out
}

function applyStreamPatch(document: Document, win: Window, id: string): void {
  const tpl = document.querySelector(
    `template[data-fict-suspense="${id}"]`,
  ) as HTMLTemplateElement | null
  if (!tpl) return

  let start: Comment | null = null
  let end: Comment | null = null
  const showComment = (win as any).NodeFilter?.SHOW_COMMENT ?? 128
  const walker = document.createTreeWalker(document, showComment)
  while (walker.nextNode()) {
    const node = walker.currentNode as Comment
    if (node.data === `fict:suspense-start:${id}`) start = node
    if (node.data === `fict:suspense-end:${id}`) end = node
    if (start && end) break
  }
  if (!start || !end || !end.parentNode) return

  let fragment: DocumentFragment = tpl.content
  const namespace = tpl.getAttribute('data-fict-patch-namespace')
  if (namespace) {
    const expectedTag = namespace === 'svg' ? 'svg' : namespace === 'mathml' ? 'math' : null
    const wrapper = fragment.firstElementChild
    if (!expectedTag || !wrapper || wrapper.localName !== expectedTag) return
    const namespacedContent = document.createDocumentFragment()
    while (wrapper.firstChild) namespacedContent.appendChild(wrapper.firstChild)
    fragment = namespacedContent
  }

  let node = start.nextSibling
  while (node && node !== end) {
    const next = node.nextSibling
    node.parentNode?.removeChild(node)
    node = next
  }
  end.parentNode.insertBefore(fragment, end)
  tpl.parentNode?.removeChild(tpl)
}

function readBoundaryText(document: Document, win: Window, id: string): string {
  let start: Comment | null = null
  let end: Comment | null = null
  const showComment = (win as any).NodeFilter?.SHOW_COMMENT ?? 128
  const walker = document.createTreeWalker(document, showComment)
  while (walker.nextNode()) {
    const node = walker.currentNode as Comment
    if (node.data === `fict:suspense-start:${id}`) start = node
    if (node.data === `fict:suspense-end:${id}`) end = node
    if (start && end) break
  }
  if (!start || !end) return ''
  let text = ''
  let node = start.nextSibling
  while (node && node !== end) {
    if (node.nodeType === 1) {
      text += (node as Element).textContent ?? ''
    } else if (node.nodeType === 3) {
      text += node.nodeValue ?? ''
    }
    node = node.nextSibling
  }
  return text
}

describe('@fictjs/ssr streaming patcher', () => {
  it('applies boundary patch output to DOM', async () => {
    const token = createSuspenseToken()
    let ready = false

    function AsyncChild(): FictNode {
      if (!ready) throw token.token
      return { type: 'span', props: { children: 'Patched' } }
    }

    function App(): FictNode {
      return {
        type: Suspense,
        props: {
          fallback: { type: 'div', props: { children: 'Pending' } },
          children: { type: AsyncChild, props: {} },
        },
      }
    }

    const stream = renderToStream(() => ({ type: App, props: {} }), { mode: 'shell' })
    const readAll = readReadableStream(stream)

    await Promise.resolve()
    ready = true
    token.resolve()

    const html = await readAll
    const win = parseHTML(html) as Window & typeof globalThis
    const document = win.document as Document

    const template = document.querySelector('template[data-fict-suspense]')
    expect(template).not.toBeNull()
    const id = (template as HTMLTemplateElement).getAttribute('data-fict-suspense')
    expect(id).toBeTruthy()

    const before = readBoundaryText(document, win as unknown as Window, id!)
    expect(before).toContain('Pending')
    expect(before).not.toContain('Patched')

    applyStreamPatch(document, win as unknown as Window, id!)

    const after = readBoundaryText(document, win as unknown as Window, id!)
    expect(after).toContain('Patched')
    expect(after).not.toContain('Pending')
  })

  it.each([
    {
      rootTag: 'svg',
      childTag: 'circle',
      fallbackTag: 'rect',
      namespace: 'http://www.w3.org/2000/svg',
    },
    {
      rootTag: 'math',
      childTag: 'mi',
      fallbackTag: 'mtext',
      namespace: 'http://www.w3.org/1998/Math/MathML',
    },
  ])(
    'preserves the $rootTag namespace when applying a streamed patch',
    async ({ rootTag, childTag, fallbackTag, namespace }) => {
      const token = createSuspenseToken()
      let ready = false

      function AsyncChild(): FictNode {
        if (!ready) throw token.token
        return { type: childTag, props: { 'data-stream-child': '', children: 'resolved' } }
      }

      function App(): FictNode {
        return {
          type: rootTag,
          props: {
            children: {
              type: Suspense,
              props: {
                fallback: { type: fallbackTag, props: { children: 'pending' } },
                children: { type: AsyncChild, props: {} },
              },
            },
          },
        }
      }

      const stream = renderToStream(() => ({ type: App, props: {} }), { mode: 'shell' })
      const readAll = readReadableStream(stream)
      await Promise.resolve()
      ready = true
      token.resolve()

      const output = await readAll
      const win = parseHTML(output) as Window & typeof globalThis
      const document = win.document as Document
      const template = document.querySelector(
        'template[data-fict-suspense]',
      ) as HTMLTemplateElement | null
      expect(template).not.toBeNull()
      const patchNamespace = rootTag === 'svg' ? 'svg' : 'mathml'
      expect(template!.getAttribute('data-fict-patch-namespace')).toBe(patchNamespace)
      expect(template!.content.firstElementChild?.localName).toBe(rootTag)

      applyStreamPatch(
        document,
        win as unknown as Window,
        template!.getAttribute('data-fict-suspense')!,
      )

      const child = document.querySelector(`[data-stream-child]`)
      expect(child?.localName).toBe(childTag)
      if (rootTag === 'svg') {
        expect(child?.namespaceURI).toBe(namespace)
      }
    },
  )

  it.each(['foreignObject', 'title', 'desc'])(
    'does not force streamed children of SVG <%s> into the SVG namespace',
    async integrationTag => {
      const token = createSuspenseToken()
      let ready = false

      function AsyncChild(): FictNode {
        if (!ready) throw token.token
        return { type: 'div', props: { 'data-stream-child': '', children: 'resolved' } }
      }

      function App(): FictNode {
        return {
          type: 'svg',
          props: {
            children: {
              type: integrationTag,
              props: {
                children: {
                  type: Suspense,
                  props: {
                    fallback: { type: 'span', props: { children: 'pending' } },
                    children: { type: AsyncChild, props: {} },
                  },
                },
              },
            },
          },
        }
      }

      const stream = renderToStream(() => ({ type: App, props: {} }), { mode: 'shell' })
      const readAll = readReadableStream(stream)
      await Promise.resolve()
      ready = true
      token.resolve()

      const output = await readAll
      const win = parseHTML(output) as Window & typeof globalThis
      const document = win.document as Document
      const template = document.querySelector(
        'template[data-fict-suspense]',
      ) as HTMLTemplateElement | null
      expect(template).not.toBeNull()
      expect(template!.hasAttribute('data-fict-patch-namespace')).toBe(false)
    },
  )
})
