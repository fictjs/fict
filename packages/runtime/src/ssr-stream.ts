export interface SSRStreamHooks {
  registerBoundary?: (start: Comment, end: Comment) => string | null
  boundaryPending?: (id: string) => void
  boundaryResolved?: (id: string) => void
}

let ssrStreamHooks: SSRStreamHooks | null = null
const boundaryStack: string[] = []

export function __fictSetSSRStreamHooks(hooks: SSRStreamHooks | null): void {
  ssrStreamHooks = hooks
  if (!hooks) {
    boundaryStack.length = 0
  }
}

export function __fictGetSSRStreamHooks(): SSRStreamHooks | null {
  return ssrStreamHooks
}

export function __fictPushSSRBoundary(id: string): void {
  boundaryStack.push(id)
}

export function __fictPopSSRBoundary(expected?: string): void {
  if (boundaryStack.length === 0) return
  const top = boundaryStack[boundaryStack.length - 1]
  if (expected && top !== expected) {
    boundaryStack.pop()
    return
  }
  boundaryStack.pop()
}

export function __fictGetCurrentSSRBoundary(): string | null {
  return boundaryStack.length > 0 ? boundaryStack[boundaryStack.length - 1]! : null
}
