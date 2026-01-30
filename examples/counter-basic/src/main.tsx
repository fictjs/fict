import { $state, $effect, render } from 'fict'

function App() {
  let count = $state(0)
  const double = count * 2
  return <Counter count={count} inc={() => count++} double={double} />
}

function Counter({ count, inc, double }: { count: number; inc: () => void; double: number }) {
  $effect(() => {
    console.log('current', count)
    return () => {
      console.log('prev', count)
    }
  })
  return <button onClick={inc}>{double}</button>
}

render(() => <App />, document.getElementById('app')!)
