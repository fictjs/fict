import { $state, $effect, render } from 'fict'

function Counter() {
  let count = $state(0)
  $effect(() => {
    console.log('current', count)
    return () => {
      console.log('prev', count)
    }
  })
  return <button onClick={() => count++}>{count}</button>
}

render(() => <Counter />, document.getElementById('app')!)
