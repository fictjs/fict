import { $state, render } from 'fict'

function App() {
  let count = $state(0)
  return <button onClick={() => count++}>{count}</button>
}

render(() => <App />, document.body)
