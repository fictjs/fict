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

  let node = start.nextSibling
  while (node && node !== end) {
    const next = node.nextSibling
    node.parentNode?.removeChild(node)
    node = next
  }

  const fragment = tpl.content ?? document.createRange().createContextualFragment(tpl.innerHTML)
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
})
