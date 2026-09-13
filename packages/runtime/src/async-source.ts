import { AsyncState, readAsyncSnapshot, type AsyncSnapshot } from './async-state'
import { withRootContext } from './lifecycle'
import { createMemo } from './memo'
import {
  createAsyncGraphNode,
  isRunningCleanup,
  registerAsyncRead,
  registerAsyncRejection,
} from './signal'

/** Internal async graph source for cache/query policies that own their transport. */
export interface AsyncSource<T> {
  read(): T
  state(): AsyncSnapshot<T>
  peek(): AsyncSnapshot<T>
  /** Pure, lazily evaluated projection with ordinary equality suppression. */
  derive<U>(fn: () => U): () => U
  begin(retainValue?: boolean): number
  resolve(generation: number, value: T): boolean
  reject(generation: number, error: unknown): boolean
  dispose(): void
}

/**
 * One graph node, sharing the readiness/generation protocol with async memos.
 * The cache explicitly owns this source; a reader's root must not dispose an
 * entry shared by other readers. Policy code cancels transport on eviction.
 */
export function __fictCreateAsyncSource<T>(): AsyncSource<T> {
  const state = new AsyncState<T>()
  const node = withRootContext(undefined, () =>
    createAsyncGraphNode(
      () => state.snapshot,
      () => {
        state.dispose()
        return state.snapshot
      },
      error => {
        throw error
      },
    ),
  )
  const read = () => {
    const snapshot = node.read()
    registerAsyncRead(read)
    if (snapshot.status === 'errored') registerAsyncRejection(snapshot.error)
    return readAsyncSnapshot(snapshot)
  }
  const publish = (accepted: boolean) => {
    if (accepted) node.publish(state.snapshot)
    return accepted
  }
  return {
    read,
    state: node.read,
    peek: () => state.snapshot,
    derive: fn => {
      const projection = withRootContext(undefined, () => createMemo(fn))
      // These are pure snapshot projections. A first read during cleanup must
      // not return an uninitialized memo slot; node.read supplies that flush's
      // stored snapshot without running a producer or establishing new inputs.
      return () => (isRunningCleanup() ? fn() : projection())
    },
    begin: retainValue => {
      const token = state.begin(retainValue)
      node.publish(state.snapshot)
      return token.generation
    },
    resolve: (generation, value) => publish(state.publish(generation, value)),
    reject: (generation, error) => publish(state.reject(generation, error)),
    dispose: node.dispose,
  }
}
