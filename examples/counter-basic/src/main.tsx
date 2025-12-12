import { $state, $effect, render } from 'fict'

function Counter() {
  let count = $state(0)
  const doubled = count * 2

  $effect(() => {
    document.title = `Count: ${count}`
  })

  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Fict Counter Example</h1>
      <p style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>
        Count: <strong>{count}</strong>
      </p>
      <p style={{ fontSize: '1.2rem', marginBottom: '2rem' }}>
        Doubled: <strong>{doubled}</strong>
      </p>
      <div style={{ display: 'flex', gap: '1rem' }}>
        <button
          onClick={() => count--}
          style={{
            padding: '0.5rem 1rem',
            fontSize: '1rem',
            cursor: 'pointer',
          }}
        >
          Decrement
        </button>
        <button
          onClick={() => {
            count = count + 1
          }}
          style={{
            padding: '0.5rem 1rem',
            fontSize: '1rem',
            cursor: 'pointer',
          }}
        >
          Increment
        </button>
        <button
          onClick={() => (count = 0)}
          style={{
            padding: '0.5rem 1rem',
            fontSize: '1rem',
            cursor: 'pointer',
          }}
        >
          Reset
        </button>
      </div>
    </div>
  )
}

const app = document.getElementById('app')
if (app) {
  render(() => <Counter />, app)
}

export default Counter
