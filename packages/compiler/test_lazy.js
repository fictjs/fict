// Isolated test to understand lazy conditional behavior
const { transformCommonJS } = require('./dist/test/test-utils.js')

const source = `
import { $state, render } from 'fict'

export const computeLog = []
export let setCount

function record(label, value) {
  computeLog.push(label + ':' + value)
  return label + '=' + value
}

export function App() {
  let count = $state(0)
  setCount = value => { count = value }

  const fallbackSummary = record('fallback', count)
  const richStats = record('rich-stats', count * 10)
  const richBadge = record('rich-badge', count + 1000)

  return (
    <section data-mode={count > 1 ? 'rich' : 'fallback'}>
      {count > 1 ? (
        <div data-id="rich">
          <span data-id="stats">{richStats}</span>
          <span data-id="badge">{richBadge}</span>
        </div>
      ) : (
        <p data-id="fallback">{fallbackSummary}</p>
      )}
    </section>
  )
}

export function mount(el) {
  computeLog.length = 0
  return render(() => <App />, el)
}
`

console.log('=== COMPILING WITH lazyConditional: true, fineGrainedDom: false ===')
try {
  const output = transformCommonJS(source, { lazyConditional: true, fineGrainedDom: false })
  console.log(output)
} catch (e) {
  console.error('Error:', e.message)
  console.log('\n=== Trying without lazyConditional ===')
  const output2 = transformCommonJS(source, { fineGrainedDom: false })
  console.log(output2)
}
