export interface FictSSRSession {
  ssrEnabled: boolean
  scopeCounter: number
  scopeRegistry: Map<string, unknown>
  boundaryScopes: Map<string, Set<string>>
  snapshotState: unknown | null
  streamHooks: unknown | null
  boundaryStack: string[]
}

const sessionStack: FictSSRSession[] = []

export function __fictCreateSSRSession(): FictSSRSession {
  return {
    ssrEnabled: false,
    scopeCounter: 0,
    scopeRegistry: new Map(),
    boundaryScopes: new Map(),
    snapshotState: null,
    streamHooks: null,
    boundaryStack: [],
  }
}

export function __fictRunWithSSRSession<T>(session: FictSSRSession, fn: () => T): T {
  sessionStack.push(session)
  try {
    return fn()
  } finally {
    sessionStack.pop()
  }
}

export function __fictGetCurrentSSRSession(): FictSSRSession | null {
  return sessionStack[sessionStack.length - 1] ?? null
}

export function __fictResetSSRSession(session: FictSSRSession): void {
  session.scopeCounter = 0
  session.scopeRegistry = new Map()
  session.boundaryScopes = new Map()
  session.snapshotState = null
  session.streamHooks = null
  session.boundaryStack.length = 0
}
