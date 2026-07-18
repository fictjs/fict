import assert from 'node:assert/strict'
import { createContext, Script } from 'node:vm'

const CONTEXT = Symbol('fict-semantic-oracle-context')

function normalize(value, ancestors = new Set()) {
  if (value === undefined) return { $type: 'undefined' }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $type: 'nan' }
    if (value === Infinity) return { $type: 'infinity' }
    if (value === -Infinity) return { $type: '-infinity' }
    if (Object.is(value, -0)) return { $type: '-0' }
    return value
  }
  if (typeof value === 'bigint') return { $type: 'bigint', value: value.toString() }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`Semantic oracle cannot normalize ${typeof value} values`)
  }
  if (ancestors.has(value)) throw new TypeError('Semantic oracle result contains a cycle')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return Array.from(value, entry => normalize(entry, ancestors))
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== null && Object.prototype.toString.call(value) !== '[object Object]') {
      throw new TypeError(
        `Semantic oracle result contains unsupported ${prototype?.constructor?.name ?? 'object'}`,
      )
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, normalize(value[key], ancestors)]),
    )
  } finally {
    ancestors.delete(value)
  }
}

function reactiveRuntime() {
  let active = null

  const detach = computation => {
    for (const dependency of computation.dependencies) dependency.subscribers.delete(computation)
    computation.dependencies.clear()
  }

  const track = dependency => {
    if (active === null || active === dependency) return
    dependency.subscribers.add(active)
    active.dependencies.add(dependency)
  }

  const runEffect = effect => {
    if (effect.running) return
    effect.running = true
    detach(effect)
    const previous = active
    active = effect
    try {
      effect.callback()
    } finally {
      active = previous
      effect.running = false
    }
  }

  const invalidate = dependency => {
    for (const subscriber of [...dependency.subscribers]) {
      if (subscriber.kind === 'memo') {
        if (subscriber.dirty) continue
        subscriber.dirty = true
        invalidate(subscriber)
      } else {
        runEffect(subscriber)
      }
    }
  }

  const signal = (...arguments_) => {
    const initial = arguments_[0] === CONTEXT ? arguments_[1] : arguments_[0]
    const node = { kind: 'signal', value: initial, subscribers: new Set() }
    return function accessor(...next) {
      if (next.length === 0) {
        track(node)
        return node.value
      }
      if (!Object.is(node.value, next[0])) {
        node.value = next[0]
        invalidate(node)
      }
      return node.value
    }
  }

  const memo = (...arguments_) => {
    const getter = arguments_[0] === CONTEXT ? arguments_[1] : arguments_[0]
    assert.equal(typeof getter, 'function', 'memo getter')
    const node = {
      kind: 'memo',
      getter,
      value: undefined,
      initialized: false,
      dirty: true,
      dependencies: new Set(),
      subscribers: new Set(),
    }
    return function accessor() {
      track(node)
      if (node.dirty || !node.initialized) {
        detach(node)
        const previous = active
        active = node
        try {
          node.value = node.getter()
          node.initialized = true
          node.dirty = false
        } finally {
          active = previous
        }
      }
      return node.value
    }
  }

  const effect = (...arguments_) => {
    const callback = arguments_[0] === CONTEXT ? arguments_[1] : arguments_[0]
    assert.equal(typeof callback, 'function', 'effect callback')
    const node = {
      kind: 'effect',
      callback,
      dependencies: new Set(),
      running: false,
    }
    runEffect(node)
    return () => detach(node)
  }

  return {
    __fictUseContext: () => CONTEXT,
    __fictUseSignal: signal,
    __fictUseMemo: memo,
    __fictUseEffect: effect,
    createSignal: signal,
    createMemo: memo,
    createEffect: effect,
    $state: signal,
    $memo: memo,
    $effect: effect,
  }
}

export function executeCommonJs(code, invocation) {
  assert.equal(typeof code, 'string')
  assert.equal(typeof invocation?.exportName, 'string')
  assert.ok(Array.isArray(invocation.arguments))

  const runtime = reactiveRuntime()
  const requireForOracle = request => {
    if (
      request === 'fict/internal' ||
      request === 'fict' ||
      request === '@fictjs/runtime' ||
      request === '@fictjs/runtime/internal' ||
      request === 'fict/internal/list' ||
      request === '@fictjs/runtime/internal/list'
    ) {
      return runtime
    }
    throw new Error(
      `Semantic oracle output requested unsupported module ${JSON.stringify(request)}`,
    )
  }
  const module = { exports: {} }
  const context = createContext(
    { require: requireForOracle, module, exports: module.exports },
    { codeGeneration: { strings: false, wasm: false } },
  )
  new Script(`"use strict";\n${code}`, { filename: 'semantic-oracle-output.cjs' }).runInContext(
    context,
    { timeout: 1_000 },
  )
  const entry = module.exports[invocation.exportName]
  assert.equal(typeof entry, 'function', `missing export ${invocation.exportName}`)
  context.__oracleArguments = structuredClone(invocation.arguments)
  const result = new Script(
    `module.exports[${JSON.stringify(invocation.exportName)}](...__oracleArguments)`,
    { filename: 'semantic-oracle-invocation.cjs' },
  ).runInContext(context, { timeout: 1_000 })
  return normalize(result)
}
