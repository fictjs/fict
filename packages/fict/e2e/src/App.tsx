export function App() {
  let count = $state(0)
  const doubled = count * 2

  const increment = () => {
    console.log('Increment clicked, current:', count)
    count++
    console.log('Incremented, new:', count)
  }

  return (
    <div>
      <h1>Fict E2E Test</h1>
      <p>
        Count: <span id="count">{count}</span>
      </p>
      <p>
        Doubled: <span id="doubled">{doubled}</span>
      </p>
      <button id="increment" onClick={increment}>
        Increment
      </button>
    </div>
  )
}
