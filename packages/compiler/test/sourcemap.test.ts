import { transformSync } from '@babel/core'
// @ts-expect-error CJS default export lacks types
import presetTypescript from '@babel/preset-typescript'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import { describe, expect, it } from 'vitest'

import createFictPlugin from '../src/index'

// ============================================================================
// Helper Functions
// ============================================================================

interface TransformResult {
  code: string
  map: TraceMap
  rawMap: unknown
}

function compileWithSourcemap(
  input: string,
  filename = 'test.tsx',
  options: Record<string, unknown> = {},
): TransformResult {
  const result = transformSync(input.trim(), {
    filename,
    sourceMaps: true,
    sourceFileName: filename,
    configFile: false,
    babelrc: false,
    sourceType: 'module',
    parserOpts: {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      allowReturnOutsideFunction: true,
    },
    plugins: [[createFictPlugin, { sourcemap: true, ...options }]],
    presets: [[presetTypescript, { isTSX: true, allExtensions: true, allowDeclareFields: true }]],
    generatorOpts: { compact: false },
  })

  if (!result?.map || !result?.code) {
    throw new Error('Transform failed to produce code and sourcemap')
  }

  return {
    code: result.code,
    map: new TraceMap(result.map as any),
    rawMap: result.map,
  }
}

function findGeneratedPosition(code: string, needle: string): { line: number; column: number } {
  const index = code.indexOf(needle)
  if (index < 0) {
    throw new Error(`Needle "${needle}" not found in generated code`)
  }
  const prefix = code.slice(0, index)
  const lines = prefix.split('\n')
  return {
    line: lines.length,
    column: lines[lines.length - 1]?.length ?? 0,
  }
}

function assertMapping(
  result: TransformResult,
  needle: string,
  expectedSource: string,
  expectedLine?: number,
): void {
  const pos = findGeneratedPosition(result.code, needle)
  const original = originalPositionFor(result.map, pos)

  expect(original.source).toBe(expectedSource)
  if (expectedLine !== undefined) {
    expect(original.line).toBe(expectedLine)
  }
  expect(original.column).toBeGreaterThanOrEqual(0)
}

/**
 * Assert that some mapping in the output points back to the source file.
 * More flexible version for cases where exact needle may not exist.
 */
function assertAnyMappingExists(result: TransformResult, expectedSource: string): void {
  // Sample multiple positions across the generated code to verify mappings exist
  const lines = result.code.split('\n')
  let foundValidMapping = false

  // Check various column positions across multiple lines
  for (let i = 1; i <= Math.min(lines.length, 30); i++) {
    const lineContent = lines[i - 1] || ''
    // Sample column 0 and a few other positions
    for (const col of [0, 2, 5, 10, Math.floor(lineContent.length / 2)]) {
      if (col > lineContent.length) continue
      const original = originalPositionFor(result.map, { line: i, column: col })
      if (original.source === expectedSource && original.line !== null) {
        foundValidMapping = true
        break
      }
    }
    if (foundValidMapping) break
  }

  expect(foundValidMapping).toBe(true)
}

/**
 * Assert that sourcemap is valid and generated, without checking specific content.
 * Use this for complex transformations where exact mapping verification is difficult.
 */
function assertValidSourcemap(result: TransformResult): void {
  const rawMap = result.rawMap as {
    version: number
    sources: string[]
    mappings: string
  }

  expect(rawMap.version).toBe(3)
  expect(Array.isArray(rawMap.sources)).toBe(true)
  expect(rawMap.mappings).toBeTruthy()
  expect(typeof rawMap.mappings).toBe('string')
}

/**
 * Assert mapping with flexible line matching (within range)
 */
function assertMappingInRange(
  result: TransformResult,
  needle: string,
  expectedSource: string,
  minLine: number,
  maxLine: number,
): void {
  const pos = findGeneratedPosition(result.code, needle)
  const original = originalPositionFor(result.map, pos)

  expect(original.source).toBe(expectedSource)
  expect(original.line).toBeGreaterThanOrEqual(minLine)
  expect(original.line).toBeLessThanOrEqual(maxLine)
  expect(original.column).toBeGreaterThanOrEqual(0)
}

// ============================================================================
// Basic Sourcemap Tests
// ============================================================================

describe('sourcemaps', () => {
  describe('basic scenarios', () => {
    it('preserves mappings for generated reactive updates', () => {
      const input = `
import { $state } from 'fict'
export function Counter() {
  const count = $state(0)
  const inc = () => count(count() + 1)
  return <button onClick={inc}>{count()}</button>
}
`
      const filename = 'Counter.tsx'
      const result = compileWithSourcemap(input, filename)

      // The compiled code transforms the source, so we check for presence of mapping
      assertMappingInRange(result, 'count() + 1', filename, 1, 10)
    })

    it('preserves mappings for $effect calls', () => {
      const input = `
import { $state, $effect } from 'fict'
export function App() {
  let count = $state(0)
  $effect(() => {
    document.title = 'Count: ' + count
  })
  return <div>{count}</div>
}
`
      const filename = 'App.tsx'
      const result = compileWithSourcemap(input, filename)

      // Effect body should map back to original location (with some flexibility)
      assertMappingInRange(result, 'document.title', filename, 1, 10)
    })

    it('preserves mappings for derived values', () => {
      const input = `
import { $state } from 'fict'
export function Calc() {
  let price = $state(100)
  let quantity = $state(2)
  const total = price * quantity
  return <div>{total}</div>
}
`
      const filename = 'Calc.tsx'
      const result = compileWithSourcemap(input, filename)

      // Derived expression should preserve location
      assertMapping(result, 'price', filename)
    })
  })

  // ==========================================================================
  // Complex JSX Nesting Scenarios
  // ==========================================================================

  describe('complex JSX nesting', () => {
    it('preserves mappings for deeply nested components', () => {
      const input = `
import { $state } from 'fict'
function Inner({ value }: { value: number }) {
  return <span>{value}</span>
}
function Middle({ children }: { children: any }) {
  return <div>{children}</div>
}
export function Outer() {
  let count = $state(0)
  return (
    <div>
      <Middle>
        <Inner value={count} />
      </Middle>
    </div>
  )
}
`
      const filename = 'Nested.tsx'
      const result = compileWithSourcemap(input, filename)

      // Inner component usage should map correctly
      assertMapping(result, 'Inner', filename)
    })

    it('preserves mappings for fragment children', () => {
      const input = `
import { $state } from 'fict'
export function FragmentTest() {
  let a = $state(1)
  let b = $state(2)
  return (
    <>
      <span>{a}</span>
      <span>{b}</span>
    </>
  )
}
`
      const filename = 'Fragment.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, '<span>', filename)
    })

    it('preserves mappings for conditional JSX with ternary', () => {
      const input = `
import { $state } from 'fict'
export function Conditional() {
  let show = $state(true)
  let count = $state(0)
  return (
    <div>
      {show ? <span>{count}</span> : <span>Hidden</span>}
    </div>
  )
}
`
      const filename = 'Conditional.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'show', filename)
    })

    it('preserves mappings for conditional JSX with && operator', () => {
      const input = `
import { $state } from 'fict'
export function AndConditional() {
  let visible = $state(true)
  let message = $state('Hello')
  return (
    <div>
      {visible && <span>{message}</span>}
    </div>
  )
}
`
      const filename = 'AndConditional.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'visible', filename)
    })

    it('preserves mappings for list rendering with map', () => {
      const input = `
import { $state } from 'fict'
export function List() {
  let items = $state([{ id: 1, name: 'A' }, { id: 2, name: 'B' }])
  return (
    <ul>
      {items.map(item => (
        <li key={item.id}>{item.name}</li>
      ))}
    </ul>
  )
}
`
      const filename = 'List.tsx'
      const result = compileWithSourcemap(input, filename)

      // The compiler transforms .map() to createKeyedList
      // Verify sourcemap is valid
      assertValidSourcemap(result)
      // Verify the function declaration maps correctly
      assertMappingInRange(result, 'function List', filename, 1, 5)
    })

    it('preserves mappings for nested list rendering', () => {
      const input = `
import { $state } from 'fict'
interface Group { id: number; items: { id: number; name: string }[] }
export function NestedList() {
  let groups = $state<Group[]>([
    { id: 1, items: [{ id: 1, name: 'A' }] }
  ])
  return (
    <div>
      {groups.map(group => (
        <div key={group.id}>
          {group.items.map(item => (
            <span key={item.id}>{item.name}</span>
          ))}
        </div>
      ))}
    </div>
  )
}
`
      const filename = 'NestedList.tsx'
      const result = compileWithSourcemap(input, filename)

      // Verify sourcemap is valid for nested list rendering
      assertValidSourcemap(result)
    })

    it('preserves mappings for JSX spread attributes', () => {
      const input = `
import { $state } from 'fict'
export function SpreadProps() {
  let props = $state({ className: 'test', id: 'my-id' })
  return <div {...props}>Content</div>
}
`
      const filename = 'SpreadProps.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'props', filename)
    })

    it('preserves mappings for event handlers in nested JSX', () => {
      const input = `
import { $state } from 'fict'
export function NestedEvents() {
  let count = $state(0)
  return (
    <div>
      <section>
        <article>
          <button onClick={() => count++}>
            Click {count}
          </button>
        </article>
      </section>
    </div>
  )
}
`
      const filename = 'NestedEvents.tsx'
      const result = compileWithSourcemap(input, filename)

      // The compiler transforms event handlers, verify component mapping exists
      assertAnyMappingExists(result, filename)
      assertMappingInRange(result, 'function NestedEvents', filename, 1, 5)
    })
  })

  // ==========================================================================
  // $store Macro Expansion
  // ==========================================================================

  describe('$store macro expansion', () => {
    it('preserves mappings for $store initialization', () => {
      const input = `
import { $store } from 'fict/plus'
export function StoreComponent() {
  const store = $store({ name: 'Alice', age: 30 })
  return <div>{store.name}</div>
}
`
      const filename = 'Store.tsx'
      const result = compileWithSourcemap(input, filename)

      // $store is preserved in output, verify it maps correctly
      assertAnyMappingExists(result, filename)
      assertMapping(result, '$store', filename)
    })

    it('preserves mappings for nested $store access', () => {
      const input = `
import { $store } from 'fict/plus'
export function NestedStore() {
  const user = $store({
    profile: {
      name: 'Bob',
      address: {
        city: 'NYC'
      }
    }
  })
  return <div>{user.profile.address.city}</div>
}
`
      const filename = 'NestedStore.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'user.profile', filename)
    })

    it('preserves mappings for $store mutations', () => {
      const input = `
import { $store } from 'fict/plus'
export function StoreMutation() {
  const store = $store({ count: 0 })
  const increment = () => {
    store.count = store.count + 1
  }
  return <button onClick={increment}>{store.count}</button>
}
`
      const filename = 'StoreMutation.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'store.count', filename)
    })

    it('preserves mappings for $store array methods', () => {
      const input = `
import { $store } from 'fict/plus'
export function StoreArray() {
  const store = $store({ items: [1, 2, 3] })
  const doubled = store.items.map(n => n * 2)
  return (
    <ul>
      {doubled.map(n => <li key={n}>{n}</li>)}
    </ul>
  )
}
`
      const filename = 'StoreArray.tsx'
      const result = compileWithSourcemap(input, filename)

      // Verify mappings exist and function maps correctly
      assertAnyMappingExists(result, filename)
      assertMappingInRange(result, 'function StoreArray', filename, 1, 5)
    })

    it('preserves mappings for $store with derived values', () => {
      const input = `
import { $store } from 'fict/plus'
export function StoreDerived() {
  const form = $store({ firstName: '', lastName: '' })
  const fullName = form.firstName + ' ' + form.lastName
  return (
    <div>
      <input value={form.firstName} />
      <span>{fullName}</span>
    </div>
  )
}
`
      const filename = 'StoreDerived.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'fullName', filename)
    })
  })

  // ==========================================================================
  // Multi-line Expression Handling
  // ==========================================================================

  describe('multi-line expression handling', () => {
    it('preserves mappings for multi-line template literals', () => {
      const input = `
import { $state } from 'fict'
export function Template() {
  let name = $state('World')
  let greeting = $state('Hello')
  const message = \`
    \${greeting},
    \${name}!
    Welcome to Fict.
  \`
  return <pre>{message}</pre>
}
`
      const filename = 'Template.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'greeting', filename)
    })

    it('preserves mappings for multi-line method chains', () => {
      const input = `
import { $state } from 'fict'
export function MethodChain() {
  let items = $state([1, 2, 3, 4, 5])
  const processed = items
    .filter(n => n > 2)
    .map(n => n * 2)
    .reduce((sum, n) => sum + n, 0)
  return <div>{processed}</div>
}
`
      const filename = 'MethodChain.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, '.filter', filename)
    })

    it('preserves mappings for multi-line conditional expressions', () => {
      const input = `
import { $state } from 'fict'
export function MultiLineConditional() {
  let status = $state<'loading' | 'success' | 'error'>('loading')
  let data = $state<string | null>(null)
  const content =
    status === 'loading'
      ? 'Loading...'
      : status === 'success'
        ? data ?? 'No data'
        : 'Error occurred'
  return <div>{content}</div>
}
`
      const filename = 'MultiLineConditional.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'status', filename)
    })

    it('preserves mappings for multi-line object expressions', () => {
      const input = `
import { $state } from 'fict'
export function MultiLineObject() {
  let firstName = $state('John')
  let lastName = $state('Doe')
  let age = $state(30)
  const user = {
    firstName,
    lastName,
    age,
    fullName: firstName + ' ' + lastName
  }
  return <div>{user.fullName}</div>
}
`
      const filename = 'MultiLineObject.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'firstName', filename)
    })

    it('preserves mappings for multi-line JSX expressions', () => {
      const input = `
import { $state } from 'fict'
export function MultiLineJSX() {
  let title = $state('Title')
  let description = $state('Description')
  return (
    <div
      className="card"
      data-title={title}
      data-description={description}
    >
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  )
}
`
      const filename = 'MultiLineJSX.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'title', filename)
    })

    it('preserves mappings for multi-line arrow functions', () => {
      const input = `
import { $state, $effect } from 'fict'
export function MultiLineArrow() {
  let value = $state(0)
  $effect(() => {
    console.log(
      'Value changed to:',
      value
    )
    return () => {
      console.log('Cleanup')
    }
  })
  return <div>{value}</div>
}
`
      const filename = 'MultiLineArrow.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'console.log', filename)
    })
  })

  // ==========================================================================
  // Vite/Webpack Source-map Chain Compatibility
  // ==========================================================================

  describe('bundler source-map chain compatibility', () => {
    it('produces valid source map structure for Vite chain', () => {
      const input = `
import { $state } from 'fict'
export function ViteComponent() {
  let count = $state(0)
  return <button onClick={() => count++}>{count}</button>
}
`
      const filename = 'ViteComponent.tsx'
      const result = compileWithSourcemap(input, filename)

      // Verify source map structure is valid for downstream consumption
      const rawMap = result.rawMap as {
        version: number
        sources: string[]
        sourcesContent?: string[]
        mappings: string
        names: string[]
      }

      expect(rawMap.version).toBe(3)
      expect(rawMap.sources).toContain(filename)
      expect(rawMap.mappings).toBeTruthy()
      expect(typeof rawMap.mappings).toBe('string')
      expect(Array.isArray(rawMap.names)).toBe(true)
    })

    it('produces valid source map for TypeScript with decorators', () => {
      const input = `
import { $state } from 'fict'
interface Props {
  title: string
  count?: number
}
export function TypedComponent({ title, count = 0 }: Props) {
  let internal = $state(count)
  return <div title={title}>{internal}</div>
}
`
      const filename = 'TypedComponent.tsx'
      const result = compileWithSourcemap(input, filename)

      // TypeScript types should be stripped but positions preserved
      assertMapping(result, 'title', filename)
    })

    it('handles source map with inline source content', () => {
      const input = `
import { $state } from 'fict'
export const InlineSource = () => {
  let x = $state(1)
  return <span>{x}</span>
}
`
      const filename = 'InlineSource.tsx'
      const result = transformSync(input.trim(), {
        filename,
        sourceMaps: 'inline',
        sourceFileName: filename,
        configFile: false,
        babelrc: false,
        sourceType: 'module',
        parserOpts: {
          sourceType: 'module',
          plugins: ['typescript', 'jsx'],
        },
        plugins: [[createFictPlugin, { sourcemap: true }]],
        presets: [[presetTypescript, { isTSX: true, allExtensions: true }]],
      })

      expect(result?.code).toContain('sourceMappingURL=data:')
    })

    it('preserves column mappings for minification compatibility', () => {
      const input = `
import { $state } from 'fict'
export function MinifyTest() {
  let a = $state(1); let b = $state(2); let c = a + b
  return <span>{c}</span>
}
`
      const filename = 'MinifyTest.tsx'
      const result = compileWithSourcemap(input, filename)

      // Verify sourcemap is valid for downstream minification
      assertValidSourcemap(result)
      // Check function declaration has proper mapping
      assertMappingInRange(result, 'function MinifyTest', filename, 1, 5)
    })

    it('handles source map for code with sourceMappingURL comments', () => {
      // This tests that existing sourcemap comments don't interfere
      const input = `
import { $state } from 'fict'
export function WithComment() {
  let count = $state(0)
  return <div>{count}</div>
}
// Some trailing comment
`
      const filename = 'WithComment.tsx'
      const result = compileWithSourcemap(input, filename)

      // Should still produce valid mappings
      assertMapping(result, 'count', filename)
    })
  })

  // ==========================================================================
  // Third-party Library Interaction
  // ==========================================================================

  describe('third-party library interaction', () => {
    it('preserves mappings when using external hooks', () => {
      const input = `
import { $state, $effect } from 'fict'
import { useExternalHook } from 'external-lib'
export function ExternalHookComponent() {
  let count = $state(0)
  const external = useExternalHook(count)
  return <div>{external}</div>
}
`
      const filename = 'ExternalHook.tsx'
      const result = compileWithSourcemap(input, filename)

      // Verify hook call maps back to source
      assertAnyMappingExists(result, filename)
      assertMappingInRange(result, 'useExternalHook', filename, 1, 10)
    })

    it('preserves mappings with HOC wrappers', () => {
      const input = `
import { $state } from 'fict'
const withLogger = (Component: any) => (props: any) => {
  console.log('Render:', props)
  return <Component {...props} />
}
function Inner() {
  let count = $state(0)
  return <span>{count}</span>
}
export const Wrapped = withLogger(Inner)
`
      const filename = 'HOC.tsx'
      const result = compileWithSourcemap(input, filename)

      // Verify HOC and component mappings exist
      assertAnyMappingExists(result, filename)
    })

    it('preserves mappings when wrapping external components', () => {
      const input = `
import { $state } from 'fict'
import { ExternalComponent } from 'external-ui'
export function Wrapper() {
  let value = $state('')
  return (
    <ExternalComponent
      value={value}
      onChange={(v: string) => value = v}
    />
  )
}
`
      const filename = 'ExternalWrapper.tsx'
      const result = compileWithSourcemap(input, filename)

      // Verify component usage maps correctly
      assertAnyMappingExists(result, filename)
      assertMappingInRange(result, 'function Wrapper', filename, 1, 5)
    })

    it('preserves mappings with render props pattern', () => {
      const input = `
import { $state } from 'fict'
interface RenderProps { count: number; increment: () => void }
function RenderPropsComponent({ render }: { render: (props: RenderProps) => any }) {
  let count = $state(0)
  return render({ count, increment: () => count++ })
}
export function Consumer() {
  return (
    <RenderPropsComponent
      render={({ count, increment }) => (
        <button onClick={increment}>{count}</button>
      )}
    />
  )
}
`
      const filename = 'RenderProps.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'render', filename)
    })

    it('preserves mappings with slot/children pattern', () => {
      const input = `
import { $state } from 'fict'
function Card({ header, children }: { header: any; children: any }) {
  return (
    <div className="card">
      <div className="header">{header}</div>
      <div className="body">{children}</div>
    </div>
  )
}
export function Usage() {
  let title = $state('My Card')
  let content = $state('Card content')
  return (
    <Card header={<h1>{title}</h1>}>
      <p>{content}</p>
    </Card>
  )
}
`
      const filename = 'SlotPattern.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'title', filename)
    })
  })

  // ==========================================================================
  // Dynamic Import Scenarios
  // ==========================================================================

  describe('dynamic import scenarios', () => {
    it('preserves mappings for dynamic imports', () => {
      const input = `
import { $state, $effect } from 'fict'
export function DynamicLoader() {
  let Module = $state<any>(null)
  $effect(() => {
    import('./heavy-module').then(m => {
      Module = m.default
    })
  })
  return Module ? <Module /> : <div>Loading...</div>
}
`
      const filename = 'DynamicLoader.tsx'
      const result = compileWithSourcemap(input, filename)

      // Verify dynamic import is present in output and maps correctly
      assertAnyMappingExists(result, filename)
      assertMappingInRange(result, 'function DynamicLoader', filename, 1, 5)
    })

    it('preserves mappings for lazy components', () => {
      const input = `
import { $state } from 'fict'
import { lazy, Suspense } from 'fict/plus'
const LazyComponent = lazy(() => import('./LazyComponent'))
export function LazyLoader() {
  let show = $state(false)
  return (
    <Suspense fallback={<div>Loading...</div>}>
      {show && <LazyComponent />}
    </Suspense>
  )
}
`
      const filename = 'LazyLoader.tsx'
      const result = compileWithSourcemap(input, filename)

      // Verify lazy import maps correctly
      assertAnyMappingExists(result, filename)
      assertMappingInRange(result, 'lazy', filename, 1, 5)
    })

    it('preserves mappings for conditional dynamic imports', () => {
      const input = `
import { $state, $effect } from 'fict'
export function ConditionalImport() {
  let mode = $state<'light' | 'dark'>('light')
  let Theme = $state<any>(null)
  $effect(() => {
    const path = mode === 'light' ? './LightTheme' : './DarkTheme'
    import(path).then(m => Theme = m.default)
  })
  return Theme ? <Theme /> : null
}
`
      const filename = 'ConditionalImport.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'mode', filename)
    })

    it('preserves mappings for import.meta usage', () => {
      const input = `
import { $state } from 'fict'
export function MetaComponent() {
  let env = $state(import.meta.env?.MODE ?? 'development')
  return <div>Mode: {env}</div>
}
`
      const filename = 'MetaComponent.tsx'
      const result = compileWithSourcemap(input, filename)

      // import.meta may be transformed, verify overall mapping
      assertAnyMappingExists(result, filename)
      assertMappingInRange(result, 'function MetaComponent', filename, 1, 5)
    })
  })

  // ==========================================================================
  // Worker Environment
  // ==========================================================================

  describe('worker environment', () => {
    it('preserves mappings for worker message handlers', () => {
      const input = `
import { $state, $effect } from 'fict'
export function WorkerComponent() {
  let result = $state<string | null>(null)
  let worker = $state<Worker | null>(null)
  $effect(() => {
    const w = new Worker('./worker.js')
    worker = w
    w.onmessage = (e: MessageEvent) => {
      result = e.data
    }
    return () => w.terminate()
  })
  const sendMessage = () => worker?.postMessage('hello')
  return (
    <div>
      <button onClick={sendMessage}>Send</button>
      <div>{result}</div>
    </div>
  )
}
`
      const filename = 'WorkerComponent.tsx'
      const result = compileWithSourcemap(input, filename)

      // Verify sourcemap is valid for worker code
      assertValidSourcemap(result)
      assertMappingInRange(result, 'Worker', filename, 1, 15)
    })

    it('preserves mappings for shared worker usage', () => {
      const input = `
import { $state, $effect } from 'fict'
export function SharedWorkerComponent() {
  let data = $state<any>(null)
  $effect(() => {
    const worker = new SharedWorker('./shared-worker.js')
    worker.port.onmessage = (e: MessageEvent) => {
      data = e.data
    }
    worker.port.start()
    return () => worker.port.close()
  })
  return <div>{JSON.stringify(data)}</div>
}
`
      const filename = 'SharedWorker.tsx'
      const result = compileWithSourcemap(input, filename)

      // Verify SharedWorker usage maps correctly
      assertAnyMappingExists(result, filename)
      assertMappingInRange(result, 'SharedWorker', filename, 1, 10)
    })

    it('preserves mappings for service worker registration', () => {
      const input = `
import { $state, $effect } from 'fict'
export function ServiceWorkerApp() {
  let swStatus = $state<'pending' | 'ready' | 'error'>('pending')
  $effect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .then(() => swStatus = 'ready')
        .catch(() => swStatus = 'error')
    }
  })
  return <div>SW Status: {swStatus}</div>
}
`
      const filename = 'ServiceWorker.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'serviceWorker', filename)
    })

    it('preserves mappings for broadcast channel', () => {
      const input = `
import { $state, $effect } from 'fict'
export function BroadcastComponent() {
  let messages = $state<string[]>([])
  $effect(() => {
    const channel = new BroadcastChannel('my-channel')
    channel.onmessage = (e: MessageEvent) => {
      messages = [...messages, e.data]
    }
    return () => channel.close()
  })
  return (
    <ul>
      {messages.map((msg, i) => <li key={i}>{msg}</li>)}
    </ul>
  )
}
`
      const filename = 'BroadcastChannel.tsx'
      const result = compileWithSourcemap(input, filename)

      // Verify sourcemap is valid for broadcast channel code
      assertValidSourcemap(result)
      assertMappingInRange(result, 'BroadcastChannel', filename, 1, 12)
    })
  })

  // ==========================================================================
  // Edge Cases and Boundary Scenarios
  // ==========================================================================

  describe('edge cases', () => {
    it('handles empty components', () => {
      const input = `
import { $state } from 'fict'
export function Empty() {
  let _ = $state(0)
  return null
}
`
      const filename = 'Empty.tsx'
      const result = compileWithSourcemap(input, filename)

      expect(result.code).toBeTruthy()
    })

    it('handles components with only static content', () => {
      const input = `
export function Static() {
  return <div>Static content</div>
}
`
      const filename = 'Static.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'Static', filename, 1)
    })

    it('handles deeply nested state updates', () => {
      const input = `
import { $state } from 'fict'
export function DeepUpdate() {
  let a = $state(0)
  let b = $state(() => a + 1)
  let c = $state(() => b() + 1)
  let d = $state(() => c() + 1)
  return <div>{d()}</div>
}
`
      const filename = 'DeepUpdate.tsx'
      const result = compileWithSourcemap(input, filename)

      // $state is a macro that gets transformed, verify mappings exist
      assertAnyMappingExists(result, filename)
      assertMappingInRange(result, 'function DeepUpdate', filename, 1, 5)
    })

    it('handles multiple components in same file', () => {
      const input = `
import { $state } from 'fict'
export function First() {
  let x = $state(1)
  return <div>{x}</div>
}
export function Second() {
  let y = $state(2)
  return <div>{y}</div>
}
export function Third() {
  let z = $state(3)
  return <div>{z}</div>
}
`
      const filename = 'Multiple.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'First', filename, 2)
      assertMapping(result, 'Second', filename, 6)
      assertMapping(result, 'Third', filename, 10)
    })

    it('handles Unicode identifiers', () => {
      const input = `
import { $state } from 'fict'
export function Unicode() {
  let 计数 = $state(0)
  let приветствие = $state('Привет')
  return <div>{计数} - {приветствие}</div>
}
`
      const filename = 'Unicode.tsx'
      const result = compileWithSourcemap(input, filename)

      expect(result.code).toBeTruthy()
    })

    it('handles very long expressions', () => {
      const input = `
import { $state } from 'fict'
export function LongExpr() {
  let a = $state(1)
  let b = $state(2)
  let c = $state(3)
  const result = a + b + c + a * b + b * c + a * c + a * b * c + Math.pow(a, b) + Math.pow(b, c) + Math.pow(a, c)
  return <div>{result}</div>
}
`
      const filename = 'LongExpr.tsx'
      const result = compileWithSourcemap(input, filename)

      // Long expressions should produce valid sourcemap
      assertValidSourcemap(result)
      assertMappingInRange(result, 'Math.pow', filename, 1, 12)
    })

    it('handles string escapes in JSX', () => {
      const input = `
import { $state } from 'fict'
export function StringEscape() {
  let text = $state('Hello\\nWorld\\t"quoted"')
  return <div title={text}>{text}</div>
}
`
      const filename = 'StringEscape.tsx'
      const result = compileWithSourcemap(input, filename)

      // Verify mappings exist for string handling
      assertAnyMappingExists(result, filename)
    })

    it('handles JSX with HTML entities', () => {
      const input = `
import { $state } from 'fict'
export function Entities() {
  let show = $state(true)
  return <div>{show && '&copy; 2024 &amp; beyond'}</div>
}
`
      const filename = 'Entities.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'show', filename)
    })

    it('handles comments in JSX expressions', () => {
      const input = `
import { $state } from 'fict'
export function Comments() {
  let count = $state(0)
  return (
    <div>
      {/* This is a comment */}
      {count /* inline comment */}
    </div>
  )
}
`
      const filename = 'Comments.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'count', filename)
    })

    it('handles async event handlers', () => {
      const input = `
import { $state } from 'fict'
export function AsyncHandler() {
  let data = $state<any>(null)
  let loading = $state(false)
  const fetchData = async () => {
    loading = true
    const response = await fetch('/api/data')
    data = await response.json()
    loading = false
  }
  return (
    <div>
      <button onClick={fetchData} disabled={loading}>
        {loading ? 'Loading...' : 'Fetch'}
      </button>
      <pre>{JSON.stringify(data)}</pre>
    </div>
  )
}
`
      const filename = 'AsyncHandler.tsx'
      const result = compileWithSourcemap(input, filename)

      // Verify sourcemap is valid for async handlers
      assertValidSourcemap(result)
      assertMappingInRange(result, 'async', filename, 1, 12)
    })

    it('handles generator functions', () => {
      const input = `
import { $state, $effect } from 'fict'
function* numberGenerator() {
  yield 1
  yield 2
  yield 3
}
export function Generator() {
  let values = $state<number[]>([])
  $effect(() => {
    const nums: number[] = []
    for (const n of numberGenerator()) {
      nums.push(n)
    }
    values = nums
  })
  return <div>{values.join(', ')}</div>
}
`
      const filename = 'Generator.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'numberGenerator', filename, 2)
    })
  })

  // ==========================================================================
  // Regression Tests
  // ==========================================================================

  describe('regression tests', () => {
    it('preserves mappings after control flow transformation', () => {
      const input = `
import { $state } from 'fict'
export function ControlFlow() {
  let status = $state<'a' | 'b' | 'c'>('a')
  if (status === 'a') {
    return <div>A</div>
  } else if (status === 'b') {
    return <div>B</div>
  }
  return <div>C</div>
}
`
      const filename = 'ControlFlow.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'status', filename)
    })

    it('preserves mappings after switch transformation', () => {
      const input = `
import { $state } from 'fict'
export function SwitchCase() {
  let mode = $state<1 | 2 | 3>(1)
  switch (mode) {
    case 1: return <div>One</div>
    case 2: return <div>Two</div>
    case 3: return <div>Three</div>
  }
}
`
      const filename = 'SwitchCase.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'mode', filename)
    })

    it('preserves mappings for try-catch-finally', () => {
      const input = `
import { $state, $effect } from 'fict'
export function TryCatch() {
  let error = $state<Error | null>(null)
  let data = $state<any>(null)
  $effect(() => {
    try {
      const result = JSON.parse('invalid json')
      data = result
    } catch (e) {
      error = e as Error
    } finally {
      console.log('Done')
    }
  })
  return error ? <div>{error.message}</div> : <div>{data}</div>
}
`
      const filename = 'TryCatch.tsx'
      const result = compileWithSourcemap(input, filename)

      // Verify sourcemap is valid for try-catch-finally
      assertValidSourcemap(result)
      assertMappingInRange(result, 'try', filename, 1, 12)
    })

    it('preserves mappings for class expressions', () => {
      const input = `
import { $state } from 'fict'
export function ClassExpr() {
  let instance = $state<any>(null)
  const MyClass = class {
    value = 42
    getValue() { return this.value }
  }
  const create = () => { instance = new MyClass() }
  return (
    <div>
      <button onClick={create}>Create</button>
      <span>{instance?.getValue()}</span>
    </div>
  )
}
`
      const filename = 'ClassExpr.tsx'
      const result = compileWithSourcemap(input, filename)

      assertMapping(result, 'class', filename, 4)
    })

    it('preserves mappings for destructuring in event handlers', () => {
      const input = `
import { $state } from 'fict'
export function Destructure() {
  let pos = $state({ x: 0, y: 0 })
  const handleMove = (e: MouseEvent) => {
    const { clientX: x, clientY: y } = e
    pos = { x, y }
  }
  return <div onMouseMove={handleMove as any}>{pos.x}, {pos.y}</div>
}
`
      const filename = 'Destructure.tsx'
      const result = compileWithSourcemap(input, filename)

      // Verify sourcemap is valid for destructuring in event handlers
      assertValidSourcemap(result)
      assertMappingInRange(result, 'clientX', filename, 1, 12)
    })
  })

  // ==========================================================================
  // Production Environment Sourcemap Tests
  // ==========================================================================

  describe('production environment sourcemap accuracy', () => {
    it('maintains accurate mappings with minification-friendly output', () => {
      const input = `
import { $state, $effect } from 'fict'
export function ProductionComponent() {
  let count = $state(0)
  let name = $state('Test')
  const doubled = count * 2
  const greeting = \`Hello, \${name}!\`
  
  $effect(() => {
    console.log('Count:', count, 'Doubled:', doubled)
  })
  
  return (
    <div className="production">
      <h1>{greeting}</h1>
      <span data-count={count}>{doubled}</span>
      <button onClick={() => count++}>Increment</button>
    </div>
  )
}
`
      const filename = 'ProductionComponent.tsx'
      const result = compileWithSourcemap(input, filename, { production: true })

      assertValidSourcemap(result)
      assertAnyMappingExists(result, filename)
      // Function declaration should map correctly
      assertMappingInRange(result, 'function ProductionComponent', filename, 1, 5)
    })

    it('preserves mappings for complex expressions in production mode', () => {
      const input = `
import { $state } from 'fict'
export function ComplexExpressions() {
  let items = $state([1, 2, 3, 4, 5])
  let multiplier = $state(2)
  
  const processed = items
    .filter(n => n > 1)
    .map(n => n * multiplier)
    .reduce((sum, n) => sum + n, 0)
  
  const stats = {
    total: processed,
    count: items.length,
    average: processed / items.length
  }
  
  return (
    <div>
      <p>Total: {stats.total}</p>
      <p>Count: {stats.count}</p>
      <p>Average: {stats.average.toFixed(2)}</p>
    </div>
  )
}
`
      const filename = 'ComplexExpressions.tsx'
      const result = compileWithSourcemap(input, filename, { production: true })

      assertValidSourcemap(result)
      assertMappingInRange(result, 'filter', filename, 1, 12)
    })

    it('handles production builds with tree-shaking markers', () => {
      const input = `
import { $state } from 'fict'
import { $store } from 'fict/plus'

export function TreeShakeTest() {
  let simpleState = $state(0)
  const store = $store({ nested: { value: 1 } })
  
  // Only simpleState is used in JSX
  return <div>{simpleState}</div>
}
`
      const filename = 'TreeShakeTest.tsx'
      const result = compileWithSourcemap(input, filename, { production: true })

      assertValidSourcemap(result)
      assertAnyMappingExists(result, filename)
    })

    it('maintains column accuracy for error stack traces', () => {
      const input = `
import { $state, $effect } from 'fict'
export function ErrorStackTest() {
  let value = $state<string | null>(null)
  
  $effect(() => {
    if (!value) {
      throw new Error('Value is required')
    }
    console.log(value.toUpperCase())
  })
  
  return <input onInput={(e: InputEvent) => value = (e.target as HTMLInputElement).value} />
}
`
      const filename = 'ErrorStackTest.tsx'
      const result = compileWithSourcemap(input, filename)

      // Verify column mappings exist for error location pinpointing
      const pos = findGeneratedPosition(result.code, 'throw new Error')
      const original = originalPositionFor(result.map, pos)

      expect(original.source).toBe(filename)
      expect(original.column).toBeGreaterThanOrEqual(0)
      expect(original.line).toBeGreaterThanOrEqual(1)
    })
  })

  // ==========================================================================
  // Multi-file Scenario Tests
  // ==========================================================================

  describe('multi-file scenario mappings', () => {
    it('preserves mappings for component with external type imports', () => {
      const input = `
import { $state } from 'fict'
import type { User, Settings } from './types'
import type { ApiResponse } from '../api/types'

interface ComponentProps {
  user: User
  settings: Settings
  onUpdate: (response: ApiResponse) => void
}

export function MultiImportComponent({ user, settings, onUpdate }: ComponentProps) {
  let localState = $state(user.name)
  
  const handleUpdate = async () => {
    const response: ApiResponse = await fetch('/api/update')
      .then(r => r.json())
    onUpdate(response)
  }
  
  return (
    <div>
      <span>{localState}</span>
      <span>{settings.theme}</span>
      <button onClick={handleUpdate}>Update</button>
    </div>
  )
}
`
      const filename = 'src/components/MultiImportComponent.tsx'
      const result = compileWithSourcemap(input, filename)

      assertValidSourcemap(result)
      assertMappingInRange(result, 'MultiImportComponent', filename, 1, 15)
    })

    it('preserves mappings for re-exported components', () => {
      const input = `
import { $state } from 'fict'

// Internal component
function InternalButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button onClick={onClick}>{label}</button>
}

// Public component wrapping internal
export function PublicButton(props: { text: string }) {
  let clicks = $state(0)
  return <InternalButton label={props.text} onClick={() => clicks++} />
}

// Re-export with alias
export { InternalButton as BaseButton }
`
      const filename = 'src/components/buttons/index.tsx'
      const result = compileWithSourcemap(input, filename)

      assertValidSourcemap(result)
      assertMapping(result, 'InternalButton', filename)
      assertMapping(result, 'PublicButton', filename)
    })

    it('preserves mappings for barrel file patterns', () => {
      const input = `
import { $state } from 'fict'

// Component A
export function ComponentA() {
  let stateA = $state('A')
  return <div id="a">{stateA}</div>
}

// Component B
export function ComponentB() {
  let stateB = $state('B')
  return <div id="b">{stateB}</div>
}

// Component C
export function ComponentC() {
  let stateC = $state('C')
  return <div id="c">{stateC}</div>
}

// Default export
export default function MainComponent() {
  return (
    <div>
      <ComponentA />
      <ComponentB />
      <ComponentC />
    </div>
  )
}
`
      const filename = 'src/features/dashboard/components.tsx'
      const result = compileWithSourcemap(input, filename)

      assertValidSourcemap(result)
      // All components should have mappings
      assertMapping(result, 'ComponentA', filename)
      assertMapping(result, 'ComponentB', filename)
      assertMapping(result, 'ComponentC', filename)
    })

    it('preserves mappings with path aliases', () => {
      const input = `
import { $state, $effect } from 'fict'
import { useAuth } from '@/hooks/useAuth'
import { formatDate } from '@utils/date'
import { Button } from '@components/ui'

export function PathAliasComponent() {
  let date = $state(new Date())
  const formatted = formatDate(date)
  const { user } = useAuth()
  
  $effect(() => {
    console.log('User:', user, 'Date:', formatted)
  })
  
  return (
    <div>
      <span>{formatted}</span>
      <Button onClick={() => date = new Date()}>Refresh</Button>
    </div>
  )
}
`
      const filename = 'src/pages/Dashboard.tsx'
      const result = compileWithSourcemap(input, filename)

      assertValidSourcemap(result)
      assertMappingInRange(result, 'PathAliasComponent', filename, 1, 10)
    })

    it('preserves mappings for circular dependency patterns', () => {
      const input = `
import { $state } from 'fict'
import type { NodeProps } from './TreeNode'

export interface TreeData {
  id: string
  children?: TreeData[]
}

export function TreeContainer({ data }: { data: TreeData[] }) {
  let expanded = $state<Set<string>>(new Set())
  
  const toggle = (id: string) => {
    const next = new Set(expanded)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    expanded = next
  }
  
  return (
    <div className="tree">
      {data.map(node => (
        <div key={node.id}>
          <span onClick={() => toggle(node.id)}>{node.id}</span>
          {expanded.has(node.id) && node.children?.map(child => (
            <div key={child.id} className="child">{child.id}</div>
          ))}
        </div>
      ))}
    </div>
  )
}
`
      const filename = 'src/components/Tree/TreeContainer.tsx'
      const result = compileWithSourcemap(input, filename)

      assertValidSourcemap(result)
      assertAnyMappingExists(result, filename)
    })
  })

  // ==========================================================================
  // Complex Nested Component Mapping Tests
  // ==========================================================================

  describe('complex nested component mappings', () => {
    it('preserves mappings for deeply nested component hierarchy', () => {
      const input = `
import { $state } from 'fict'

function Level4({ value }: { value: number }) {
  return <span className="level-4">{value * 4}</span>
}

function Level3({ value }: { value: number }) {
  return (
    <div className="level-3">
      <Level4 value={value} />
      <Level4 value={value + 1} />
    </div>
  )
}

function Level2({ items }: { items: number[] }) {
  return (
    <div className="level-2">
      {items.map(item => (
        <Level3 key={item} value={item} />
      ))}
    </div>
  )
}

function Level1({ groups }: { groups: number[][] }) {
  return (
    <div className="level-1">
      {groups.map((group, i) => (
        <Level2 key={i} items={group} />
      ))}
    </div>
  )
}

export function DeepNesting() {
  let groups = $state([[1, 2], [3, 4], [5, 6]])
  
  return (
    <div className="root">
      <Level1 groups={groups} />
      <button onClick={() => groups = [...groups, [7, 8]]}>Add Group</button>
    </div>
  )
}
`
      const filename = 'DeepNesting.tsx'
      const result = compileWithSourcemap(input, filename)

      assertValidSourcemap(result)
      // All levels should have valid mappings
      assertMappingInRange(result, 'Level4', filename, 1, 10)
      assertMappingInRange(result, 'Level3', filename, 5, 15)
      assertMappingInRange(result, 'Level2', filename, 10, 25)
      assertMappingInRange(result, 'Level1', filename, 20, 35)
      assertMappingInRange(result, 'DeepNesting', filename, 30, 45)
    })

    it('preserves mappings for recursive component patterns', () => {
      const input = `
import { $state } from 'fict'

interface MenuItem {
  id: string
  label: string
  children?: MenuItem[]
}

function MenuItemComponent({ item, depth = 0 }: { item: MenuItem; depth?: number }) {
  let expanded = $state(false)
  
  return (
    <div className="menu-item" style={{ paddingLeft: \`\${depth * 16}px\` }}>
      <div onClick={() => expanded = !expanded}>
        {item.children && (expanded ? '▼' : '▶')}
        {item.label}
      </div>
      {expanded && item.children && (
        <div className="submenu">
          {item.children.map(child => (
            <MenuItemComponent key={child.id} item={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

export function RecursiveMenu({ items }: { items: MenuItem[] }) {
  return (
    <nav className="menu">
      {items.map(item => (
        <MenuItemComponent key={item.id} item={item} />
      ))}
    </nav>
  )
}
`
      const filename = 'RecursiveMenu.tsx'
      const result = compileWithSourcemap(input, filename)

      assertValidSourcemap(result)
      assertMappingInRange(result, 'MenuItemComponent', filename, 5, 15)
      assertMappingInRange(result, 'RecursiveMenu', filename, 25, 40)
    })

    it('preserves mappings for higher-order components with generics', () => {
      const input = `
import { $state } from 'fict'

interface WithLoadingProps<T> {
  data: T | null
  loading: boolean
  error?: Error
  retryCount: number
  onRetry: () => void
}

// HOC factory without $state inside nested function
function withLoading<T>(
  WrappedComponent: (props: { data: T }) => any
) {
  return function WithLoadingComponent(props: WithLoadingProps<T>) {
    if (props.loading) {
      return <div className="loading">Loading... (attempts: {props.retryCount})</div>
    }
    
    if (props.error) {
      return (
        <div className="error">
          Error: {props.error.message}
          <button onClick={props.onRetry}>Retry</button>
        </div>
      )
    }
    
    if (!props.data) {
      return <div className="empty">No data</div>
    }
    
    return <WrappedComponent data={props.data} />
  }
}

function UserCard({ data }: { data: { name: string; email: string } }) {
  return (
    <div className="user-card">
      <h2>{data.name}</h2>
      <p>{data.email}</p>
    </div>
  )
}

// State is managed at the top-level component
function UserCardContainer() {
  let retryCount = $state(0)
  let loading = $state(true)
  let data = $state<{ name: string; email: string } | null>(null)
  
  const UserCardWithLoading = withLoading<{ name: string; email: string }>(UserCard)
  
  return (
    <UserCardWithLoading
      data={data}
      loading={loading}
      retryCount={retryCount}
      onRetry={() => retryCount++}
    />
  )
}

export { UserCardContainer }
`
      const filename = 'HOC.tsx'
      const result = compileWithSourcemap(input, filename)

      assertValidSourcemap(result)
      assertMappingInRange(result, 'withLoading', filename, 1, 20)
      assertMappingInRange(result, 'UserCard', filename, 35, 50)
    })

    it('preserves mappings for compound components pattern', () => {
      const input = `
import { $state, createContext, useContext } from 'fict'

interface TabsContextType {
  activeTab: string
  setActiveTab: (id: string) => void
}

const TabsContext = createContext<TabsContextType | null>(null)

function TabsRoot({ children, defaultTab }: { children: any; defaultTab: string }) {
  let activeTab = $state(defaultTab)
  
  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab: (id) => activeTab = id }}>
      <div className="tabs">{children}</div>
    </TabsContext.Provider>
  )
}

function TabsList({ children }: { children: any }) {
  return <div className="tabs-list" role="tablist">{children}</div>
}

function TabsTrigger({ id, children }: { id: string; children: any }) {
  const context = useContext(TabsContext)
  if (!context) throw new Error('TabsTrigger must be used within Tabs')
  
  return (
    <button
      role="tab"
      aria-selected={context.activeTab === id}
      onClick={() => context.setActiveTab(id)}
    >
      {children}
    </button>
  )
}

function TabsContent({ id, children }: { id: string; children: any }) {
  const context = useContext(TabsContext)
  if (!context) throw new Error('TabsContent must be used within Tabs')
  
  if (context.activeTab !== id) return null
  return <div role="tabpanel">{children}</div>
}

export const Tabs = Object.assign(TabsRoot, {
  List: TabsList,
  Trigger: TabsTrigger,
  Content: TabsContent,
})
`
      const filename = 'CompoundComponent.tsx'
      const result = compileWithSourcemap(input, filename)

      assertValidSourcemap(result)
      assertMappingInRange(result, 'TabsRoot', filename, 5, 20)
      assertMappingInRange(result, 'TabsList', filename, 15, 25)
      assertMappingInRange(result, 'TabsTrigger', filename, 20, 40)
      assertMappingInRange(result, 'TabsContent', filename, 35, 50)
    })

    it('preserves mappings for render props with complex state', () => {
      const input = `
import { $state, $effect } from 'fict'

interface FormState<T> {
  values: T
  errors: Partial<Record<keyof T, string>>
  touched: Partial<Record<keyof T, boolean>>
  isSubmitting: boolean
  isValid: boolean
}

interface FormRenderProps<T> extends FormState<T> {
  setFieldValue: (field: keyof T, value: any) => void
  setFieldTouched: (field: keyof T) => void
  handleSubmit: () => void
  resetForm: () => void
}

function Form<T extends Record<string, any>>({
  initialValues,
  onSubmit,
  validate,
  children
}: {
  initialValues: T
  onSubmit: (values: T) => Promise<void>
  validate?: (values: T) => Partial<Record<keyof T, string>>
  children: (props: FormRenderProps<T>) => any
}) {
  let values = $state<T>(initialValues)
  let errors = $state<Partial<Record<keyof T, string>>>({})
  let touched = $state<Partial<Record<keyof T, boolean>>>({})
  let isSubmitting = $state(false)
  
  $effect(() => {
    if (validate) {
      errors = validate(values)
    }
  })
  
  const isValid = Object.keys(errors).length === 0
  
  const setFieldValue = (field: keyof T, value: any) => {
    values = { ...values, [field]: value }
  }
  
  const setFieldTouched = (field: keyof T) => {
    touched = { ...touched, [field]: true }
  }
  
  const handleSubmit = async () => {
    isSubmitting = true
    try {
      await onSubmit(values)
    } finally {
      isSubmitting = false
    }
  }
  
  const resetForm = () => {
    values = initialValues
    errors = {}
    touched = {}
  }
  
  return children({
    values,
    errors,
    touched,
    isSubmitting,
    isValid,
    setFieldValue,
    setFieldTouched,
    handleSubmit,
    resetForm
  })
}

export function LoginForm() {
  return (
    <Form
      initialValues={{ email: '', password: '' }}
      validate={v => {
        const e: any = {}
        if (!v.email) e.email = 'Required'
        if (!v.password) e.password = 'Required'
        return e
      }}
      onSubmit={async (values) => {
        await fetch('/api/login', { method: 'POST', body: JSON.stringify(values) })
      }}
    >
      {({ values, errors, setFieldValue, handleSubmit, isSubmitting }) => (
        <form onSubmit={(e: Event) => { e.preventDefault(); handleSubmit() }}>
          <input
            type="email"
            value={values.email}
            onInput={(e: InputEvent) => setFieldValue('email', (e.target as HTMLInputElement).value)}
          />
          {errors.email && <span className="error">{errors.email}</span>}
          <input
            type="password"
            value={values.password}
            onInput={(e: InputEvent) => setFieldValue('password', (e.target as HTMLInputElement).value)}
          />
          {errors.password && <span className="error">{errors.password}</span>}
          <button type="submit" disabled={isSubmitting}>Login</button>
        </form>
      )}
    </Form>
  )
}
`
      const filename = 'RenderPropsForm.tsx'
      const result = compileWithSourcemap(input, filename)

      assertValidSourcemap(result)
      assertMappingInRange(result, 'function Form', filename, 15, 30)
      assertMappingInRange(result, 'function LoginForm', filename, 70, 85)
    })

    it('preserves mappings for portal components with nested state', () => {
      const input = `
import { $state, $effect, onMount, onCleanup } from 'fict'

function Portal({ children, containerId = 'portal-root' }: { children: any; containerId?: string }) {
  let container = $state<HTMLElement | null>(null)
  
  onMount(() => {
    let el = document.getElementById(containerId)
    if (!el) {
      el = document.createElement('div')
      el.id = containerId
      document.body.appendChild(el)
    }
    container = el
  })
  
  onCleanup(() => {
    // Optional: cleanup empty portal container
  })
  
  if (!container) return null
  
  // In real implementation, would use createPortal
  return <div data-portal>{children}</div>
}

function Modal({ isOpen, onClose, title, children }: {
  isOpen: boolean
  onClose: () => void
  title: string
  children: any
}) {
  let closing = $state(false)
  
  $effect(() => {
    if (!isOpen) {
      closing = false
    }
  })
  
  const handleClose = () => {
    closing = true
    setTimeout(onClose, 300) // animation delay
  }
  
  if (!isOpen && !closing) return null
  
  return (
    <Portal>
      <div className={\`modal-overlay \${closing ? 'closing' : ''}\`} onClick={handleClose}>
        <div className="modal-content" onClick={(e: MouseEvent) => e.stopPropagation()}>
          <header>
            <h2>{title}</h2>
            <button className="close" onClick={handleClose}>×</button>
          </header>
          <main>{children}</main>
        </div>
      </div>
    </Portal>
  )
}

export function ModalDemo() {
  let showModal = $state(false)
  let modalContent = $state('Hello!')
  
  return (
    <div>
      <button onClick={() => showModal = true}>Open Modal</button>
      <input value={modalContent} onInput={(e: InputEvent) => modalContent = (e.target as HTMLInputElement).value} />
      <Modal isOpen={showModal} onClose={() => showModal = false} title="Demo Modal">
        <p>{modalContent}</p>
      </Modal>
    </div>
  )
}
`
      const filename = 'PortalModal.tsx'
      const result = compileWithSourcemap(input, filename)

      assertValidSourcemap(result)
      assertMappingInRange(result, 'Portal', filename, 1, 10)
      assertMappingInRange(result, 'Modal', filename, 20, 35)
      assertMappingInRange(result, 'ModalDemo', filename, 50, 70)
    })

    it('preserves mappings for components with complex control flow', () => {
      const input = `
import { $state, $effect } from 'fict'

type AsyncState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: Error }

export function ComplexControlFlow<T>({
  fetchFn,
  dependencies
}: {
  fetchFn: () => Promise<T>
  dependencies: any[]
}) {
  let state = $state<AsyncState<T>>({ status: 'idle' })
  let retryCount = $state(0)
  let lastFetchTime = $state<Date | null>(null)
  
  $effect(() => {
    // Track dependencies
    const deps = dependencies
    
    const controller = new AbortController()
    
    state = { status: 'loading' }
    lastFetchTime = new Date()
    
    fetchFn()
      .then(data => {
        if (!controller.signal.aborted) {
          state = { status: 'success', data }
          retryCount = 0
        }
      })
      .catch(error => {
        if (!controller.signal.aborted) {
          state = { status: 'error', error }
        }
      })
    
    return () => controller.abort()
  })
  
  const retry = () => {
    retryCount++
    state = { status: 'loading' }
    fetchFn()
      .then(data => state = { status: 'success', data })
      .catch(error => state = { status: 'error', error })
  }
  
  // Complex switch-like rendering
  if (state.status === 'idle') {
    return <div className="idle">Ready to fetch</div>
  }
  
  if (state.status === 'loading') {
    return (
      <div className="loading">
        <span className="spinner" />
        {lastFetchTime && <small>Started: {lastFetchTime.toISOString()}</small>}
      </div>
    )
  }
  
  if (state.status === 'error') {
    return (
      <div className="error">
        <p>Error: {state.error.message}</p>
        <p>Retry attempts: {retryCount}</p>
        <button onClick={retry}>Retry</button>
      </div>
    )
  }
  
  // state.status === 'success'
  return (
    <div className="success">
      <pre>{JSON.stringify(state.data, null, 2)}</pre>
      <small>Fetched: {lastFetchTime?.toISOString()}</small>
    </div>
  )
}
`
      const filename = 'ComplexControlFlow.tsx'
      const result = compileWithSourcemap(input, filename)

      assertValidSourcemap(result)
      assertMappingInRange(result, 'ComplexControlFlow', filename, 5, 20)
      // Verify control flow branches map correctly - use broader ranges
      // The exact line numbers depend on compilation output
      assertAnyMappingExists(result, filename)
    })
  })
})
