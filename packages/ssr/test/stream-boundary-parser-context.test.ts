import { describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'

import type { FictNode } from '@fictjs/runtime'
import { Suspense, createSuspenseToken } from '@fictjs/runtime'

import { renderToStream } from '../src/index'

function createPendingBoundary(fallback: FictNode): FictNode {
  const token = createSuspenseToken()

  function Pending(): FictNode {
    throw token.token
  }

  return Suspense({ fallback, children: { type: Pending, props: {} } })
}

function createDeferredBoundary(
  fallback: FictNode,
  resolved: FictNode,
  onResolve: () => void,
): { render: () => FictNode; resolve: () => void } {
  const token = createSuspenseToken()
  let ready = false

  function Pending(): FictNode {
    if (!ready) throw token.token
    return resolved
  }

  return {
    render: () => Suspense({ fallback, children: { type: Pending, props: {} }, onResolve }),
    resolve: () => {
      ready = true
      token.resolve()
    },
  }
}

function createShellStream(view: () => FictNode): ReadableStream<Uint8Array> {
  return renderToStream(view, {
    mode: 'shell',
    includeSnapshot: false,
    streamRuntime: 'external',
    streamRuntimeSrc: '/fict-stream-runtime.js',
  })
}

async function expectShellRejection(view: () => FictNode, pattern: RegExp): Promise<void> {
  const reader = createShellStream(view).getReader()
  try {
    await expect(reader.read()).rejects.toThrowError(pattern)
  } finally {
    await reader.cancel().catch(() => {})
  }
}

async function readShellAndCancel(view: () => FictNode): Promise<string> {
  const reader = createShellStream(view).getReader()
  try {
    const first = await reader.read()
    return new TextDecoder().decode(first.value)
  } finally {
    await reader.cancel()
  }
}

async function expectDeferredPatchRejection(
  stream: ReadableStream<Uint8Array>,
  resolve: () => void,
  pattern: RegExp,
): Promise<void> {
  const reader = stream.getReader()
  try {
    const shell = await reader.read()
    expect(new TextDecoder().decode(shell.value)).toContain('fict:suspense-start:')
    resolve()
    await expect(reader.read()).rejects.toThrowError(pattern)
  } finally {
    await reader.cancel().catch(() => {})
  }
}

function unwrapResolvedHost(container: Element): void {
  const host = container.querySelector('fict-host[data-fict-host]')
  if (!host?.parentNode) {
    throw new Error('Expected the resolved component host before streaming serialization.')
  }
  const parent = host.parentNode
  while (host.firstChild) parent.insertBefore(host.firstChild, host)
  parent.removeChild(host)
}

describe('streaming boundary HTML parser context validation', () => {
  it.each([
    'iframe',
    'noembed',
    'noframes',
    'noscript',
    'script',
    'style',
    'xmp',
    'textarea',
    'title',
    'plaintext',
  ])('rejects a streaming boundary whose markers become text inside <%s>', async tagName => {
    await expectShellRejection(
      () => ({
        type: tagName,
        props: {
          ...(tagName === 'script' ? { type: 'application/json' } : null),
          children: createPendingBoundary('pending'),
        },
      }),
      tagName === 'plaintext'
        ? /Cannot serialize HTML <plaintext>.*no closing tag/i
        : new RegExp(`streaming Suspense boundary.*<${tagName}>`, 'i'),
    )
  })

  it('rejects a direct row boundary that the parser splits across table and tbody', async () => {
    await expectShellRejection(
      () => ({
        type: 'table',
        props: {
          children: createPendingBoundary({
            type: 'tr',
            props: { children: { type: 'td', props: { children: 'pending' } } },
          }),
        },
      }),
      /streaming Suspense boundary.*<table>.*<tr>/i,
    )
  })

  it('rejects a direct column boundary that the parser splits across table and colgroup', async () => {
    await expectShellRejection(
      () => ({
        type: 'table',
        props: {
          children: createPendingBoundary({ type: 'col', props: {} }),
        },
      }),
      /streaming Suspense boundary.*<table>.*<col>/i,
    )
  })

  it('rejects a direct cell boundary that the parser splits across tbody and tr', async () => {
    await expectShellRejection(
      () => ({
        type: 'table',
        props: {
          children: {
            type: 'tbody',
            props: {
              children: createPendingBoundary({
                type: 'td',
                props: { children: 'pending' },
              }),
            },
          },
        },
      }),
      /streaming Suspense boundary.*<tbody>.*<td>/i,
    )
  })

  it('rejects foster-parented text inside a direct table boundary', async () => {
    await expectShellRejection(
      () => ({
        type: 'table',
        props: { children: createPendingBoundary('pending') },
      }),
      /streaming Suspense boundary.*<table>.*non-whitespace text/i,
    )
  })

  it.each(['select', 'option'])(
    'rejects non-portable element content inside <%s>',
    async tagName => {
      const view =
        tagName === 'select'
          ? () => ({
              type: 'select',
              props: {
                children: createPendingBoundary({
                  type: 'div',
                  props: { children: 'pending' },
                }),
              },
            })
          : () => ({
              type: 'select',
              props: {
                children: {
                  type: 'option',
                  props: {
                    children: createPendingBoundary({
                      type: 'div',
                      props: { children: 'pending' },
                    }),
                  },
                },
              },
            })

      await expectShellRejection(
        view,
        new RegExp(`streaming Suspense boundary.*<${tagName}>.*<div>`, 'i'),
      )
    },
  )

  it('rejects streaming boundary ids inside cloneable template content', async () => {
    await expectShellRejection(
      () => ({
        type: 'template',
        props: {
          children: createPendingBoundary({ type: 'span', props: { children: 'pending' } }),
        },
      }),
      /template.*streaming Suspense boundary.*cloned/i,
    )
  })

  it('rejects a deferred patch that changes an explicit table section into a direct row', async () => {
    const window = parseHTML('<!doctype html><html><head></head><body><main></main></body></html>')
    const container = window.document.querySelector('main') as HTMLElement
    const boundary = createDeferredBoundary(
      {
        type: 'tbody',
        props: {
          children: {
            type: 'tr',
            props: { children: { type: 'td', props: { children: 'pending' } } },
          },
        },
      },
      {
        type: 'tr',
        props: { children: { type: 'td', props: { children: 'resolved' } } },
      },
      () => unwrapResolvedHost(container),
    )
    const stream = renderToStream(
      () => ({ type: 'table', props: { children: boundary.render() } }),
      {
        mode: 'shell',
        includeSnapshot: false,
        streamRuntime: 'external',
        streamRuntimeSrc: '/fict-stream-runtime.js',
        window,
        document: window.document,
        container,
      },
    )

    await expectDeferredPatchRejection(
      stream,
      boundary.resolve,
      /streaming Suspense boundary.*<table>.*<tr>/i,
    )
  })

  it('rejects a deferred patch that changes a row into a direct table cell', async () => {
    const window = parseHTML('<!doctype html><html><head></head><body><main></main></body></html>')
    const container = window.document.querySelector('main') as HTMLElement
    const boundary = createDeferredBoundary(
      {
        type: 'tr',
        props: { children: { type: 'td', props: { children: 'pending' } } },
      },
      { type: 'td', props: { children: 'resolved' } },
      () => unwrapResolvedHost(container),
    )
    const stream = renderToStream(
      () => ({
        type: 'table',
        props: {
          children: {
            type: 'tbody',
            props: { children: boundary.render() },
          },
        },
      }),
      {
        mode: 'shell',
        includeSnapshot: false,
        streamRuntime: 'external',
        streamRuntimeSrc: '/fict-stream-runtime.js',
        window,
        document: window.document,
        container,
      },
    )

    await expectDeferredPatchRejection(
      stream,
      boundary.resolve,
      /streaming Suspense boundary.*<tbody>.*<td>/i,
    )
  })

  it.each([
    {
      name: 'explicit tbody under table',
      view: () => ({
        type: 'table',
        props: {
          children: createPendingBoundary({
            type: 'tbody',
            props: {
              children: {
                type: 'tr',
                props: { children: { type: 'td', props: { children: 'pending' } } },
              },
            },
          }),
        },
      }),
    },
    {
      name: 'row under tbody',
      view: () => ({
        type: 'table',
        props: {
          children: {
            type: 'tbody',
            props: {
              children: createPendingBoundary({
                type: 'tr',
                props: { children: { type: 'td', props: { children: 'pending' } } },
              }),
            },
          },
        },
      }),
    },
    {
      name: 'cell under tr',
      view: () => ({
        type: 'table',
        props: {
          children: {
            type: 'tbody',
            props: {
              children: {
                type: 'tr',
                props: {
                  children: createPendingBoundary({
                    type: 'td',
                    props: { children: 'pending' },
                  }),
                },
              },
            },
          },
        },
      }),
    },
    {
      name: 'column under colgroup',
      view: () => ({
        type: 'table',
        props: {
          children: {
            type: 'colgroup',
            props: { children: createPendingBoundary({ type: 'col', props: {} }) },
          },
        },
      }),
    },
    {
      name: 'option under select',
      view: () => ({
        type: 'select',
        props: {
          children: createPendingBoundary({
            type: 'option',
            props: { children: 'pending' },
          }),
        },
      }),
    },
    {
      name: 'text under option',
      view: () => ({
        type: 'select',
        props: {
          children: {
            type: 'option',
            props: { children: createPendingBoundary('pending') },
          },
        },
      }),
    },
  ])('allows parser-stable boundary content: $name', async ({ view }) => {
    const shell = await readShellAndCancel(view)

    expect(shell).toContain('fict:suspense-start:')
    expect(shell).toContain('fict:suspense-end:')
  })
})
