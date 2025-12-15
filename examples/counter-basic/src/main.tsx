import { $state, $effect, render } from 'fict'

function Counter() {
  let count = $state(0)
  let count1 = $state(0)
  const doubled = count * 2
  console.log('doubled', doubled)
  $effect(() => {
    document.title = `Count: ${count}`
  })
  if (!(count % 2)) {
    console.log('test')
    return (
      <>
        <button onClick={() => count++} data-testid="count">
          Count: {count} is divisible by 2, doubled: {doubled}
        </button>
        <button onClick={() => count1++} data-testid="count1">
          Count1: {count1}
        </button>
      </>
    )
  }
  console.log('test1')
  return (
    <>
      <button onClick={() => count++} data-testid="count">
        Count: {count} is not divisible by 2, count1: {doubled}
      </button>
      <button onClick={() => count1++} data-testid="count1">
        Count1: {count1}
      </button>
    </>
  )
}

const app = document.getElementById('app')
if (app) {
  render(() => <Counter />, app)
}

export default Counter
