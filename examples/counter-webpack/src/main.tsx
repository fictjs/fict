import { $state, $effect, render } from 'fict'

function Counter() {
  let count = $state(0)
  const double = count * 2

  $effect(() => {
    console.log('Count changed:', count)
  })

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>Fict Counter (Webpack)</h1>
      <div style={{ fontSize: '2rem', margin: '1rem 0' }}>
        <p>Count: {count}</p>
        <p>Double: {double}</p>
      </div>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
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
          onClick={() => count++}
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
