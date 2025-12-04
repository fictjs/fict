import { describe, it, expect } from 'vitest'

import {
  Fragment,
  createConditional,
  createElement,
  createEffect,
  createList,
  createSignal,
  onCleanup,
  render,
  enableFineGrainedRuntime,
  disableFineGrainedRuntime,
} from '..'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

interface ScenarioResult {
  snapshots: string[]
  attr: string | null
}

async function runScenario(
  flagEnabled: boolean,
  scenario: (container: HTMLElement) => Promise<ScenarioResult>,
): Promise<ScenarioResult> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  if (flagEnabled) {
    enableFineGrainedRuntime()
  } else {
    disableFineGrainedRuntime()
  }
  try {
    return await scenario(container)
  } finally {
    container.remove()
    disableFineGrainedRuntime()
  }
}

describe('fine-grained runtime flag integration', () => {
  it('counter scenario matches across modes', async () => {
    const baseline = await runScenario(false, counterScenario)
    const flagged = await runScenario(true, counterScenario)

    expect(flagged.snapshots).toEqual(baseline.snapshots)
    expect(baseline.attr).toBeNull()
    expect(flagged.attr).toBe('1')
  })

  it('keyed list scenario matches across modes', async () => {
    const baseline = await runScenario(false, keyedListScenario)
    const flagged = await runScenario(true, keyedListScenario)

    expect(flagged.snapshots).toEqual(baseline.snapshots)
    expect(baseline.attr).toBeNull()
    expect(flagged.attr).toBe('1')
  })

  it('nested conditional scenario matches across modes', async () => {
    const baseline = await runScenario(false, nestedConditionalScenario)
    const flagged = await runScenario(true, nestedConditionalScenario)

    expect(flagged.snapshots).toEqual(baseline.snapshots)
    expect(baseline.attr).toBeNull()
    expect(flagged.attr).toBe('1')
  })
})

async function counterScenario(container: HTMLElement): Promise<ScenarioResult> {
  const count = createSignal(0)
  const snapshots: string[] = []

  const teardown = render(() => {
    const button = document.createElement('button')
    createEffect(() => {
      button.textContent = `Count: ${count()}`
    })
    return button
  }, container)

  snapshots.push(container.textContent || '')
  count(1)
  await tick()
  snapshots.push(container.textContent || '')

  teardown()
  return { snapshots, attr: container.getAttribute('data-fict-fine-grained') }
}

async function keyedListScenario(container: HTMLElement): Promise<ScenarioResult> {
  const items = createSignal([
    { id: 1, text: 'one' },
    { id: 2, text: 'two' },
  ])
  const snapshots: string[] = []

  const teardown = render(() => {
    const binding = createList(
      () => items(),
      item => ({
        type: Fragment,
        props: { children: [item.text, item.text.toUpperCase()] },
        key: undefined,
      }),
      createElement,
      item => item.id,
    )
    onCleanup(() => binding.dispose())
    return binding.marker
  }, container)

  snapshots.push(container.textContent || '')

  items([
    { id: 2, text: 'dos' },
    { id: 1, text: 'uno' },
  ])
  await tick()
  snapshots.push(container.textContent || '')

  items([{ id: 2, text: 'done' }])
  await tick()
  snapshots.push(container.textContent || '')

  teardown()
  return { snapshots, attr: container.getAttribute('data-fict-fine-grained') }
}

async function nestedConditionalScenario(container: HTMLElement): Promise<ScenarioResult> {
  const showOuter = createSignal(true)
  const showInner = createSignal(true)
  const snapshots: string[] = []

  const teardown = render(() => {
    const binding = createConditional(
      () => showOuter(),
      () =>
        createConditional(
          () => showInner(),
          () => 'INNER',
          createElement,
          () => 'FALLBACK',
        ),
      createElement,
      () => 'OUTER',
    )
    onCleanup(() => binding.dispose())
    return binding.marker
  }, container)

  snapshots.push(container.textContent || '')

  showInner(false)
  await tick()
  snapshots.push(container.textContent || '')

  showOuter(false)
  await tick()
  snapshots.push(container.textContent || '')

  teardown()
  return { snapshots, attr: container.getAttribute('data-fict-fine-grained') }
}
