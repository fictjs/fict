import { $state, render, onDestroy } from 'fict'
let cleaned = 0
function App() {
  let count = $state(1)
  let visible = $state(true)
  const value = count * 2
  onDestroy(() => cleaned++)
  return (
    <main>
      <button id="inc" onClick={() => count++}>
        increment
      </button>
      <button id="toggle" onClick={() => (visible = !visible)}>
        toggle
      </button>
      {visible && <span id="value">{value}</span>}
    </main>
  )
}
export function mount(root, unused, options) {
  return render(
    () =>
      options.svg ? (
        <svg>
          <App />
        </svg>
      ) : (
        <App />
      ),
    root,
  )
}
export function observe() {
  const node = document.querySelector('#value')
  return { text: node?.textContent ?? null, namespace: node?.namespaceURI ?? null, cleaned }
}
