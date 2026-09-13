import { $async, $state, ErrorBoundary, Suspense, onCleanup } from 'fict'

export const signals: AbortSignal[] = []
export const cleanups: boolean[] = []

function Value(props: { value: string }) {
  return <span data-value>{props.value}</span>
}

export function App(props: { input: string | Promise<string>; request: () => Promise<string> }) {
  let input = $state(props.input)
  const value = $async(context => {
    signals.push(context.signal)
    onCleanup(() => cleanups.push(context.signal.aborted))
    return input
  })
  return (
    <main>
      <button onClick={() => (input = props.request())}>Refresh</button>
      <ErrorBoundary fallback={error => <p data-error>{String(error)}</p>}>
        <Suspense fallback={<p data-pending>Loading</p>}>
          <Value value={value} />
        </Suspense>
      </ErrorBoundary>
    </main>
  )
}
