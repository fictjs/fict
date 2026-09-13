import assert from 'node:assert/strict'

/** Exercise each distribution in isolation, including the edge entry without Node hooks. */
export async function verifyAsyncRuntime(runtime, advanced, ssr) {
  const signals = []
  let cleaned = 0
  function App(props) {
    const value = advanced.createAsyncMemo(context => {
      signals.push(context.signal)
      runtime.onCleanup(() => cleaned++)
      return props.input
    })
    const derived = runtime.createMemo(() => `value:${value()}`)
    return {
      type: runtime.Suspense,
      props: {
        fallback: { type: 'i', props: { children: 'pending' } },
        children: { type: 'b', props: { children: advanced.reactive(() => derived()) } },
      },
    }
  }
  let finishA, finishB
  const a = new Promise(resolve => {
    finishA = resolve
  })
  const b = new Promise(resolve => {
    finishB = resolve
  })
  const left = ssr.renderToStringAsync(() => ({ type: App, props: { input: a } }))
  const right = ssr.renderToStringAsync(() => ({ type: App, props: { input: b } }))
  finishB('B-private')
  const htmlB = await right
  assert.match(htmlB, /value:B-private/)
  assert.doesNotMatch(htmlB, /A-private|__FICT_SNAPSHOT__/)
  finishA('A-private')
  const htmlA = await left
  assert.match(htmlA, /value:A-private/)
  assert.doesNotMatch(htmlA, /B-private|__FICT_SNAPSHOT__/)
  assert.equal(cleaned, 2)
  assert.ok(signals.every(signal => signal.aborted))

  const reader = ssr
    .renderToStream(() => ({ type: App, props: { input: new Promise(() => {}) } }), {
      mode: 'shell',
    })
    .getReader()
  await reader.read()
  const pendingSignal = signals.at(-1)
  assert.equal(pendingSignal.aborted, false)
  await reader.cancel('consumer left')
  assert.equal(pendingSignal.aborted, true)
  assert.equal(cleaned, 3)
}
