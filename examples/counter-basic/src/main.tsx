import { $state, $effect } from 'fict-runtime'

function Counter() {
  let count = $state(0)
  const doubled = count * 2

  $effect(() => {
    document.title = `Count: ${count}`
  })

  return (
    <div>
      <h1>Counter</h1>
      <p>Count: {count}</p>
      <p>Doubled: {doubled}</p>
      <button onClick={() => count++}>Increment</button>
      <button onClick={() => count--}>Decrement</button>
    </div>
  )
}

const app = document.getElementById('app')
if (app) {
  app.textContent = 'Render pipeline coming soon'
}

export default Counter
