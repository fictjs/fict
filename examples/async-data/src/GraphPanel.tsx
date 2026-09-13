import { $async, $state, ErrorBoundary, Suspense, useTransition } from 'fict'

// Native async code receives captured inputs. It does not read reactive state
// after await or create computations in a transport continuation.
async function loadResult(id: number, fail: boolean, signal: AbortSignal): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, id % 2 === 0 ? 700 : 300)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('Request cancelled'))
      },
      { once: true },
    )
  })
  if (signal.aborted) throw new Error('Request cancelled')
  if (fail) throw new Error('The example request failed')
  return `Result ${id}`
}

function GraphView() {
  let requestId = $state(1)
  let shouldFail = $state(false)
  const [pending, start] = useTransition()
  const result = $async(context => loadResult(requestId, shouldFail, context.signal))
  const description = `Current result: ${result}`

  return (
    <div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button id="graph-next" onClick={() => start(() => requestId++)}>
          Next result
        </button>
        <button id="graph-fail" onClick={() => start(() => (shouldFail = true))}>
          Simulate error
        </button>
        <button id="graph-recover" onClick={() => start(() => (shouldFail = false))}>
          Recover result
        </button>
        <span id="graph-transition">{pending() ? 'Updating result…' : 'Transition idle'}</span>
      </div>
      <ErrorBoundary
        resetKeys={shouldFail}
        fallback={error => (
          <p id="graph-error" role="alert">
            {String(error)}
          </p>
        )}
      >
        <Suspense
          fallback={
            <p id="graph-loading" role="status">
              Waiting for the current result…
            </p>
          }
        >
          <div id="graph-content">
            <p id="graph-value">{description}</p>
            <label>
              Local note <input id="graph-note" placeholder="Kept while the result refreshes" />
            </label>
          </div>
        </Suspense>
      </ErrorBoundary>
    </div>
  )
}

export function GraphPanel() {
  let visible = $state(true)
  return (
    <section
      aria-label="Async graph example"
      style={{
        padding: '24px',
        marginTop: '24px',
        border: '1px solid #c7d2fe',
        borderRadius: '12px',
      }}
    >
      <h2>Owned async results</h2>
      <p>
        A resolved value feeds an ordinary derivation and the UI. Refresh preserves the note; hiding
        this view cancels its pending work.
      </p>
      <button id="graph-toggle" onClick={() => (visible = !visible)}>
        {visible ? 'Hide async view' : 'Show async view'}
      </button>
      {visible && <GraphView />}
    </section>
  )
}
