import { $state, $effect } from 'fict'

export function Counter({ label, initial = 0 }: { label: string; initial?: number }) {
  let count = $state(initial)

  $effect(() => {
    console.log(`[${label}] count changed: ${count}`)
  })

  return (
    <div class="counter">
      <h2>{label}</h2>
      <div class="counter-value">{count}</div>
      <div class="counter-buttons">
        {/* Using onClick without $ - should be auto-extracted */}
        <button class="btn-secondary" onClick$={() => count--}>
          -
        </button>
        <button class="btn-primary" onClick={() => count++}>
          +
        </button>
        <button class="btn-secondary" onClick={() => (count = initial)}>
          Reset
        </button>
      </div>
    </div>
  )
}

export function App() {
  let message = $state('Hello from SSR!')

  return (
    <div>
      <h1>Fict SSR Example</h1>

      <Counter label="Counter A" initial={10} />
      <Counter label="Counter B" initial={20} />

      <div class="info">
        <p>
          This page was <strong>server-side rendered</strong> and is now <strong>resumable</strong>.
        </p>
        <p>
          Click the buttons above - the handlers are lazy-loaded on first interaction. With{' '}
          <code>autoExtractHandlers</code> enabled, even regular <code>onClick</code> handlers are
          auto-extracted when complex enough!
        </p>
        <p>Check the Network tab to see that handler code is only fetched when you click!</p>
      </div>
    </div>
  )
}
