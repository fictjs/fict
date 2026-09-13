/** Causal readiness accounting, independent of reactive graph/cache policy. */
export type TransitionContext = ReadonlySet<TransitionScope> | undefined

let current: TransitionContext

export function captureTransitionContext(): TransitionContext {
  if (!current) return undefined
  const active = new Set([...current].filter(scope => scope.active))
  return active.size ? active : undefined
}

export function withTransitionContext<T>(context: TransitionContext, fn: () => T): T {
  const previous = current
  current = context
  try {
    return fn()
  } finally {
    current = previous
  }
}

export class TransitionScope {
  active = true
  private count = 1
  private closed = false
  private finishQueued = false
  private finished: (() => void) | undefined

  constructor(finished: () => void) {
    this.finished = finished
  }

  retain(): () => void {
    if (!this.active) return () => {}
    this.count++
    let released = false
    return () => {
      if (released) return
      released = true
      this.release()
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.release()
  }

  cancel(): void {
    if (!this.active) return
    this.active = false
    const finished = this.finished
    this.finished = undefined
    if (finished) withTransitionContext(undefined, finished)
  }

  private release(): void {
    if (!this.active || --this.count !== 0 || this.finishQueued) return
    this.finishQueued = true
    // Publication may schedule another computation before this turn completes.
    // Recheck after its synchronous registration instead of reporting a gap.
    void Promise.resolve().then(() => {
      this.finishQueued = false
      if (this.count === 0) this.cancel()
    })
  }
}
