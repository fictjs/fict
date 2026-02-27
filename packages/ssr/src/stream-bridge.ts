interface NodePassThroughLike {
  pipe: (destination: NodeJS.WritableStream) => unknown
  write: (chunk: string | Uint8Array) => boolean
  end: (...args: unknown[]) => unknown
  destroy?: (error?: Error) => void
}

export interface StreamWriter {
  write: (chunk: string) => void
  close: () => void
  abort: (reason?: unknown) => void
}

export interface QueuedTextStream {
  stream: ReadableStream<Uint8Array>
  writer: StreamWriter
}

export function createQueuedTextStream(): QueuedTextStream {
  const encoder = new TextEncoder()
  const queue: Uint8Array[] = []
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let closed = false
  let aborted: unknown

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl
      for (const chunk of queue) {
        ctrl.enqueue(chunk)
      }
      queue.length = 0
      if (aborted !== undefined) {
        ctrl.error(aborted)
        return
      }
      if (closed) {
        ctrl.close()
      }
    },
  })

  const writer: StreamWriter = {
    write(chunk) {
      if (closed || aborted !== undefined) return
      const data = encoder.encode(chunk)
      if (controller) {
        controller.enqueue(data)
      } else {
        queue.push(data)
      }
    },
    close() {
      if (closed || aborted !== undefined) return
      closed = true
      controller?.close()
    },
    abort(reason?: unknown) {
      if (closed || aborted !== undefined) return
      aborted = reason ?? new Error('Stream aborted')
      controller?.error(aborted)
    },
  }

  return { stream, writer }
}

export interface PipeBridge {
  pipe: (writable: NodeJS.WritableStream) => void
  write: (chunk: string) => void
  close: () => void
  abort: (reason?: unknown) => void
}

export function createPipeBridge(): PipeBridge {
  const nodeBridge = createNodePipeBridge()
  if (nodeBridge) return nodeBridge

  const targets = new Set<NodeJS.WritableStream>()
  const buffer: string[] = []
  let state: 'open' | 'closed' | 'aborted' = 'open'
  let abortReason: Error | null = null

  const safeWrite = (target: NodeJS.WritableStream, chunk: string) => {
    try {
      target.write(chunk)
    } catch {
      // Ignore target write errors to keep stream lifecycle deterministic.
    }
  }

  const safeEnd = (target: NodeJS.WritableStream) => {
    try {
      target.end()
    } catch {
      // Ignore end errors from downstream writable.
    }
  }

  const safeDestroy = (target: NodeJS.WritableStream, reason: Error) => {
    const withDestroy = target as NodeJS.WritableStream & { destroy?: (error?: Error) => void }
    if (typeof withDestroy.destroy === 'function') {
      try {
        withDestroy.destroy(reason)
      } catch {
        // Ignore destroy errors from downstream writable.
      }
      return
    }
    safeEnd(target)
  }

  return {
    pipe(writable) {
      targets.add(writable)
      if (buffer.length > 0) {
        for (const chunk of buffer) {
          safeWrite(writable, chunk)
        }
        buffer.length = 0
      }
      if (state === 'closed') {
        safeEnd(writable)
      } else if (state === 'aborted') {
        safeDestroy(writable, abortReason ?? new Error('Stream aborted'))
      }
    },
    write(chunk) {
      if (state !== 'open') return
      if (targets.size === 0) {
        buffer.push(chunk)
        return
      }
      for (const target of targets) {
        safeWrite(target, chunk)
      }
    },
    close() {
      if (state !== 'open') return
      state = 'closed'
      for (const target of targets) {
        safeEnd(target)
      }
      if (targets.size > 0) {
        buffer.length = 0
      }
    },
    abort(reason?: unknown) {
      if (state !== 'open') return
      state = 'aborted'
      abortReason = reason instanceof Error ? reason : new Error('Stream aborted')
      for (const target of targets) {
        safeDestroy(target, abortReason)
      }
      buffer.length = 0
    },
  }
}

function createNodePipeBridge(): PipeBridge | null {
  const nodeRequire = getNodeRequire()
  if (!nodeRequire) return null
  try {
    const streamModule = nodeRequire('node:stream') as {
      PassThrough?: new (...args: unknown[]) => NodePassThroughLike
    }
    if (!streamModule.PassThrough) return null
    const passThrough = new streamModule.PassThrough()

    return {
      pipe(writable) {
        passThrough.pipe(writable)
      },
      write(chunk) {
        passThrough.write(chunk)
      },
      close() {
        passThrough.end()
      },
      abort(reason?: unknown) {
        const error = reason instanceof Error ? reason : new Error('Stream aborted')
        if (typeof passThrough.destroy === 'function') {
          passThrough.destroy(error)
        } else {
          passThrough.end()
        }
      },
    }
  } catch {
    return null
  }
}

function getNodeRequire(): ((specifier: string) => unknown) | null {
  const g = globalThis as Record<string, unknown>
  const direct = g.require
  if (typeof direct === 'function') {
    return direct as (specifier: string) => unknown
  }
  try {
    return Function('return typeof require === "function" ? require : null')() as
      | ((specifier: string) => unknown)
      | null
  } catch {
    return null
  }
}
