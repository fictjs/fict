export interface FictSSRSession {
  ssrEnabled: boolean
  scopeCounter: number
  scopeRegistry: Map<string, unknown>
  boundaryScopes: Map<string, Set<string>>
  snapshotState: unknown | null
  streamHooks: unknown | null
  boundaryStack: string[]
  manifest?: Record<string, string> | undefined
}

export interface FictSSRSessionCarrier {
  getStore(): FictSSRSession | undefined
  run<T>(session: FictSSRSession, fn: () => T): T
}

const sessionStack: FictSSRSession[] = []
const carrierRegistrations: {
  carrier: FictSSRSessionCarrier
  active: boolean
}[] = []
let sessionCarrier: FictSSRSessionCarrier | null = null
let activeSSRSessionCount = 0

export function __fictCreateSSRSession(): FictSSRSession {
  return {
    ssrEnabled: false,
    scopeCounter: 0,
    scopeRegistry: new Map(),
    boundaryScopes: new Map(),
    snapshotState: null,
    streamHooks: null,
    boundaryStack: [],
    manifest: undefined,
  }
}

export function __fictRunWithSSRSession<T>(session: FictSSRSession, fn: () => T): T {
  const release = __fictRetainSSRSession()

  let result: T
  try {
    result = sessionCarrier ? sessionCarrier.run(session, fn) : runWithSessionStack(session, fn)
  } catch (error) {
    release()
    throw error
  }

  let asynchronous: boolean
  try {
    asynchronous = isPromiseLike(result)
  } catch (error) {
    release()
    throw error
  }

  if (asynchronous) {
    // Return the tracked promise so an ignored rejection keeps the platform's
    // normal unhandled-rejection behavior. Async callers must not rely on
    // promise identity; the internal helper only preserves the settled value.
    return Promise.resolve(result).then(
      value => {
        release()
        return value
      },
      error => {
        release()
        throw error
      },
    ) as T
  } else {
    release()
  }

  return result
}

function runWithSessionStack<T>(session: FictSSRSession, fn: () => T): T {
  sessionStack.push(session)
  try {
    return fn()
  } finally {
    sessionStack.pop()
  }
}

export function __fictGetCurrentSSRSession(): FictSSRSession | null {
  return sessionCarrier?.getStore() ?? sessionStack[sessionStack.length - 1] ?? null
}

export function __fictInstallSSRSessionCarrier(carrier: FictSSRSessionCarrier): () => void {
  const registration = { carrier, active: true }
  carrierRegistrations.push(registration)
  sessionCarrier = carrier
  let restored = false

  return () => {
    if (restored) return
    restored = true
    registration.active = false
    while (carrierRegistrations[carrierRegistrations.length - 1]?.active === false) {
      carrierRegistrations.pop()
    }
    sessionCarrier = carrierRegistrations[carrierRegistrations.length - 1]?.carrier ?? null
  }
}

export function __fictRetainSSRSession(): () => void {
  activeSSRSessionCount += 1
  let released = false

  return () => {
    if (released) return
    released = true
    activeSSRSessionCount = Math.max(0, activeSSRSessionCount - 1)
  }
}

export function __fictIsSSRSessionActive(): boolean {
  return activeSSRSessionCount > 0
}

export function __fictResetSSRSession(session: FictSSRSession): void {
  session.scopeCounter = 0
  session.scopeRegistry = new Map()
  session.boundaryScopes = new Map()
  session.snapshotState = null
  session.streamHooks = null
  session.boundaryStack.length = 0
  session.manifest = undefined
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  )
}
