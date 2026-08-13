type ExecutionPhase = 'component' | 'callback' | 'none'

let executionPhase: ExecutionPhase = 'none'

/** Run only the synchronous body of a component as render execution. */
export function runComponentRender<T>(fn: () => T): T {
  const previousPhase = executionPhase
  executionPhase = 'component'
  try {
    return fn()
  } finally {
    executionPhase = previousPhase
  }
}

/** Keep nested lifecycle/reactive/event callbacks outside their caller's render phase. */
export function runOutsideComponentRender<T>(fn: () => T): T {
  const previousPhase = executionPhase
  executionPhase = 'callback'
  try {
    return fn()
  } finally {
    executionPhase = previousPhase
  }
}

export function isComponentRenderActive(): boolean {
  return executionPhase === 'component'
}

/** Test-only reset used together with the hook context reset. */
export function resetComponentRenderPhase(): void {
  executionPhase = 'none'
}
