import { $state, $effect, render } from 'fict'

function Counter() {
  let count = $state(0)
  const double = count * 2
  let message = 'Keep going...'
  let color = 'black'
  if (count >= 3) {
    message = 'Threshold Reached!'
    color = 'red'
    if (count === 3) {
      console.log('Just hit 3!')
    }
    return (
      <div style={{ color }}>
        <h1>Count1: {count}</h1>
        <h2>Double1: {double}</h2>
        <p>{message}</p>
        <button onClick={() => count++}>Increment1</button>
      </div>
    )
  }
  return (
    <div style={{ color }}>
      <h1>Count: {count}</h1>
      <h2>Double: {double}</h2>
      <p>{message}</p>
      <button onClick={() => count++}>Increment</button>
    </div>
  )
}

const app = document.getElementById('app')
if (app) {
  render(() => <Counter />, app)
}

export default Counter
