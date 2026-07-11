import { __fictGetCurrentSSRSession } from './ssr-session'

export interface SSRStreamHooks {
  registerBoundary?: (start: Comment, end: Comment) => string | null
  boundaryPending?: (id: string) => void
  boundaryResolved?: (id: string) => void
  boundaryAbandoned?: (id: string) => void
  onError?: (error: unknown, boundaryId?: string) => void
}

let ssrStreamHooks: SSRStreamHooks | null = null
const boundaryStack: string[] = []

function getHooks(): SSRStreamHooks | null {
  const session = __fictGetCurrentSSRSession()
  return session ? (session.streamHooks as SSRStreamHooks | null) : ssrStreamHooks
}

function setHooks(hooks: SSRStreamHooks | null): void {
  const session = __fictGetCurrentSSRSession()
  if (session) {
    session.streamHooks = hooks
    return
  }
  ssrStreamHooks = hooks
}

function getBoundaryStack(): string[] {
  return __fictGetCurrentSSRSession()?.boundaryStack ?? boundaryStack
}

export function __fictSetSSRStreamHooks(hooks: SSRStreamHooks | null): void {
  setHooks(hooks)
  if (!hooks) {
    getBoundaryStack().length = 0
  }
}

export function __fictGetSSRStreamHooks(): SSRStreamHooks | null {
  return getHooks()
}

export function __fictPushSSRBoundary(id: string): void {
  getBoundaryStack().push(id)
}

export function __fictPopSSRBoundary(expected?: string): void {
  const stack = getBoundaryStack()
  if (stack.length === 0) return
  const top = stack[stack.length - 1]
  if (expected && top !== expected) {
    stack.pop()
    return
  }
  stack.pop()
}

export function __fictGetCurrentSSRBoundary(): string | null {
  const stack = getBoundaryStack()
  return stack.length > 0 ? stack[stack.length - 1]! : null
}
