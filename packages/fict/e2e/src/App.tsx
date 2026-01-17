import {
  createContext,
  useContext,
  ErrorBoundary,
  Suspense,
  $memo,
  $store,
  prop,
  createEffect,
  onMount,
  onCleanup,
  $state,
} from 'fict'
import { lazy, resource } from 'fict/plus'

// ============================================================================
// 1. Basic Reactivity Test
// ============================================================================
function BasicReactivity() {
  let count = $state(0)
  const doubled = count * 2

  const increment = () => {
    console.log('Increment clicked, current:', count)
    count++
    console.log('Incremented, new:', count)
  }

  const decrement = () => {
    count--
  }

  return (
    <section id="basic-reactivity">
      <h2>Basic Reactivity</h2>
      <p>
        Count: <span id="count">{count}</span>
      </p>
      <p>
        Doubled: <span id="doubled">{doubled}</span>
      </p>
      <button id="increment" onClick={increment}>
        Increment
      </button>
      <button id="decrement" onClick={decrement}>
        Decrement
      </button>
    </section>
  )
}

// ============================================================================
// 2. Conditional Rendering Test
// ============================================================================
function ConditionalRendering() {
  let show = $state(true)
  let mode = $state<'a' | 'b' | 'c'>('a')

  return (
    <section id="conditional-rendering">
      <h2>Conditional Rendering</h2>

      {/* Boolean toggle */}
      <button id="toggle-show" onClick={() => (show = !show)}>
        Toggle Show
      </button>
      <div id="show-result">{show && <span id="shown-element">I am visible</span>}</div>

      {/* Ternary */}
      <div id="ternary-result">{show ? <span>Show is true</span> : <span>Show is false</span>}</div>

      {/* Multi-branch */}
      <div>
        <button id="set-mode-a" onClick={() => (mode = 'a')}>
          Mode A
        </button>
        <button id="set-mode-b" onClick={() => (mode = 'b')}>
          Mode B
        </button>
        <button id="set-mode-c" onClick={() => (mode = 'c')}>
          Mode C
        </button>
      </div>
      <div id="mode-result">
        {mode === 'a' && <span>Mode A active</span>}
        {mode === 'b' && <span>Mode B active</span>}
        {mode === 'c' && <span>Mode C active</span>}
      </div>
    </section>
  )
}

// ============================================================================
// 3. List Rendering Test
// ============================================================================
interface ListItem {
  id: number
  text: string
}

function ListRendering() {
  let items = $state<ListItem[]>([
    { id: 1, text: 'Item 1' },
    { id: 2, text: 'Item 2' },
    { id: 3, text: 'Item 3' },
  ])
  let nextId = $state(4)

  const addItem = () => {
    items = [...items, { id: nextId, text: `Item ${nextId}` }]
    nextId++
  }

  const removeItem = (id: number) => {
    items = items.filter((item: ListItem) => item.id !== id)
  }

  const reverseItems = () => {
    items = [...items].reverse()
  }

  return (
    <section id="list-rendering">
      <h2>List Rendering</h2>
      <button id="add-item" onClick={addItem}>
        Add Item
      </button>
      <button id="reverse-items" onClick={reverseItems}>
        Reverse
      </button>
      <ul id="item-list">
        {items.map((item: ListItem) => (
          <li key={item.id} class="list-item" data-id={item.id}>
            {item.text}
            <button class="remove-item" onClick={() => removeItem(item.id)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <p id="item-count">Total: {items.length}</p>
    </section>
  )
}

// ============================================================================
// 4. Form Input Test
// ============================================================================
function FormInput() {
  let text = $state('')
  let checked = $state(false)
  let selected = $state('option1')
  let submitted = $state('')

  const handleSubmit = (e: Event) => {
    e.preventDefault()
    submitted = `Text: ${text}, Checked: ${checked}, Selected: ${selected}`
  }

  return (
    <section id="form-input">
      <h2>Form Input</h2>
      <form onSubmit={handleSubmit}>
        <div>
          <input
            id="text-input"
            type="text"
            value={text}
            onInput={(e: InputEvent) => (text = (e.target as HTMLInputElement).value)}
            placeholder="Type something..."
          />
          <span id="text-preview">Preview: {text}</span>
        </div>

        <div>
          <label>
            <input
              id="checkbox-input"
              type="checkbox"
              checked={checked}
              onChange={() => (checked = !checked)}
            />
            Check me
          </label>
          <span id="checkbox-status">{checked ? 'Checked' : 'Unchecked'}</span>
        </div>

        <div>
          <select
            id="select-input"
            value={selected}
            onChange={(e: Event) => (selected = (e.target as HTMLSelectElement).value)}
          >
            <option value="option1">Option 1</option>
            <option value="option2">Option 2</option>
            <option value="option3">Option 3</option>
          </select>
          <span id="select-preview">Selected: {selected}</span>
        </div>

        <button id="submit-form" type="submit">
          Submit
        </button>
      </form>
      <p id="form-result">{submitted}</p>
    </section>
  )
}

// ============================================================================
// 5. Component Props Test
// ============================================================================
interface ChildProps {
  name: string
  count: number
  onIncrement: () => void
}

function ChildComponent(props: ChildProps) {
  return (
    <div id="child-component" class="child">
      <p id="child-name">Hello, {props.name}!</p>
      <p id="child-count">Count from parent: {props.count}</p>
      <button id="child-increment" onClick={props.onIncrement}>
        Increment in child
      </button>
    </div>
  )
}

function ComponentProps() {
  let name = $state('World')
  let count = $state(0)

  return (
    <section id="component-props">
      <h2>Component Props</h2>
      <input
        id="name-input"
        value={name}
        onInput={(e: InputEvent) => (name = (e.target as HTMLInputElement).value)}
      />
      <ChildComponent name={name} count={count} onIncrement={() => count++} />
    </section>
  )
}

// ============================================================================
// 6. Store Test (Deep Reactivity)
// ============================================================================
function StoreTest() {
  const store = $store({
    user: {
      name: 'Alice',
      age: 25,
      address: {
        city: 'Beijing',
      },
    },
    items: ['a', 'b', 'c'],
  })

  return (
    <section id="store-test">
      <h2>Store (Deep Reactivity)</h2>
      <p id="store-name">Name: {store.user.name}</p>
      <p id="store-city">City: {store.user.address.city}</p>
      <p id="store-items">Items: {store.items.join(', ')}</p>

      <button id="update-name" onClick={() => (store.user.name = 'Bob')}>
        Change Name to Bob
      </button>
      <button id="update-city" onClick={() => (store.user.address.city = 'Shanghai')}>
        Change City to Shanghai
      </button>
      <button id="add-store-item" onClick={() => store.items.push('d')}>
        Add Item
      </button>
    </section>
  )
}

// ============================================================================
// 7. Context API Test
// ============================================================================
const ThemeContext = createContext<'light' | 'dark'>('light')

function ThemedButton() {
  const theme = useContext(ThemeContext)
  return (
    <button
      id="themed-button"
      style={{
        background: theme === 'dark' ? '#333' : '#fff',
        color: theme === 'dark' ? '#fff' : '#333',
      }}
    >
      Theme: {theme}
    </button>
  )
}

function ContextTest() {
  let theme = $state<'light' | 'dark'>('light')

  return (
    <section id="context-test">
      <h2>Context API</h2>
      <button id="toggle-theme" onClick={() => (theme = theme === 'light' ? 'dark' : 'light')}>
        Toggle Theme
      </button>
      <ThemeContext.Provider value={theme}>
        <ThemedButton />
      </ThemeContext.Provider>
    </section>
  )
}

// ============================================================================
// 8. ErrorBoundary Test
// ============================================================================
function ThrowingComponent(props: { shouldThrow: boolean }) {
  if (props.shouldThrow) {
    throw new Error('Intentional error for testing')
  }
  createEffect(() => {
    if (props.shouldThrow) {
      throw new Error('Intentional error for testing')
    }
  })
  return <span id="no-error">No error occurred</span>
}

function ErrorBoundaryTest() {
  let showChild = $state(true)
  let shouldThrow = $state(false)
  let remountTimer: ReturnType<typeof setTimeout> | undefined

  const scheduleRemount = () => {
    if (remountTimer !== undefined) {
      clearTimeout(remountTimer)
    }
    remountTimer = setTimeout(() => {
      showChild = true
      remountTimer = undefined
    }, 0)
  }

  const triggerError = () => {
    shouldThrow = true
    showChild = false
    scheduleRemount()
  }

  const reset = () => {
    showChild = false
    shouldThrow = false
    scheduleRemount()
  }

  onCleanup(() => {
    if (remountTimer !== undefined) {
      clearTimeout(remountTimer)
      remountTimer = undefined
    }
  })

  return (
    <section id="error-boundary-test">
      <h2>Error Boundary</h2>
      <button id="trigger-error" onClick={triggerError}>
        Trigger Error
      </button>
      <button id="reset-error" onClick={reset}>
        Reset
      </button>
      <div id="error-container">
        {showChild && (
          <ErrorBoundary
            fallback={err => <div id="error-fallback">Error: {(err as Error).message}</div>}
          >
            <ThrowingComponent shouldThrow={prop(() => shouldThrow)} />
          </ErrorBoundary>
        )}
      </div>
    </section>
  )
}

// ============================================================================
// 9. Style Binding Test
// ============================================================================
function StyleBinding() {
  let isActive = $state(false)
  let color = $state('red')
  let size = $state(16)

  return (
    <section id="style-binding">
      <h2>Style Binding</h2>

      {/* Class binding */}
      <button id="toggle-active" onClick={() => (isActive = !isActive)}>
        Toggle Active
      </button>
      <div id="class-target" class={{ active: isActive, base: true } as any}>
        Class binding test
      </div>

      {/* Style binding */}
      <div>
        <input
          id="color-input"
          value={color}
          onInput={(e: InputEvent) => (color = (e.target as HTMLInputElement).value)}
        />
        <input
          id="size-input"
          type="number"
          value={size}
          onInput={(e: InputEvent) => (size = parseInt((e.target as HTMLInputElement).value) || 16)}
        />
      </div>
      <div id="style-target" style={{ color: color, fontSize: `${size}px` }}>
        Dynamic style
      </div>
    </section>
  )
}

// ============================================================================
// 10. Lifecycle Test
// ============================================================================
function LifecycleChild({ id }: { id: number; key?: number }) {
  onMount(() => {
    console.log(`Child ${id} mounted`)
    const el = document.getElementById('lifecycle-log')
    if (el) el.textContent += `Mounted: ${id}\n`
  })

  onCleanup(() => {
    console.log(`Child ${id} cleanup`)
  })

  return <span class="lifecycle-child">Child {id}</span>
}

function LifecycleTest() {
  let children = $state([1, 2])
  let nextId = $state(3)

  const addChild = () => {
    children = [...children, nextId]
    nextId++
  }

  const removeChild = () => {
    children = children.slice(0, -1)
  }

  return (
    <section id="lifecycle-test">
      <h2>Lifecycle</h2>
      <button id="add-lifecycle-child" onClick={addChild}>
        Add Child
      </button>
      <button id="remove-lifecycle-child" onClick={removeChild}>
        Remove Child
      </button>
      <pre id="lifecycle-log"></pre>
      <div id="lifecycle-children">
        {children.map((id: number) => (
          <LifecycleChild key={id} id={id} />
        ))}
      </div>
    </section>
  )
}

// ============================================================================
// 11. Effect Test - using a simpler side-effect pattern
// ============================================================================
function EffectTest() {
  let count = $state(0)
  // Simple derived value to test reactivity
  const countMessage = `Current count: ${count}`

  return (
    <section id="effect-test">
      <h2>Effect Test</h2>
      <button id="effect-increment" onClick={() => count++}>
        Increment
      </button>
      <p id="effect-count">{count}</p>
      <p id="effect-message">{countMessage}</p>
    </section>
  )
}

// ============================================================================
// 12. Memo Test - using derived values
// ============================================================================
function MemoTest() {
  let a = $state(1)
  let b = $state(2)
  // Derived value (compiled to memo)
  const sum = a + b

  return (
    <section id="memo-test">
      <h2>Memo Test</h2>
      <p id="memo-values">
        a = {a}, b = {b}
      </p>
      <p id="memo-sum">Sum: {sum}</p>
      <button id="increment-a" onClick={() => a++}>
        Increment A
      </button>
      <button id="increment-b" onClick={() => b++}>
        Increment B
      </button>
    </section>
  )
}

// ============================================================================
// 13. Suspense + Lazy Loading Test
// ============================================================================

// Simulated lazy component - returns after delay
const LazyComponent = lazy(
  () =>
    new Promise<{ default: () => any }>(resolve => {
      setTimeout(() => {
        resolve({
          default: () => <div id="lazy-content">Lazy component loaded!</div>,
        })
      }, 100)
    }),
)

function SuspenseLazyTest() {
  let showLazy = $state(false)

  return (
    <section id="suspense-lazy-test">
      <h2>Suspense + Lazy Loading</h2>
      <button id="load-lazy" onClick={() => (showLazy = true)}>
        Load Lazy Component
      </button>
      <div id="lazy-container">
        {showLazy && (
          <Suspense fallback={<div id="lazy-loading">Loading...</div>}>
            <LazyComponent />
          </Suspense>
        )}
      </div>
    </section>
  )
}

// ============================================================================
// 14. Resource (Async Data Fetching) Test
// ============================================================================

// Simulated API resource
const userResource = resource<{ name: string; email: string }, string>({
  fetch: async (_, userId: string) => {
    await new Promise(r => setTimeout(r, 100))
    return {
      name: `User ${userId}`,
      email: `user${userId}@example.com`,
    }
  },
  key: ['user'],
})

function ResourceTest() {
  let userId = $state('1')
  let showData = $state(false)

  const handleLoad = () => {
    showData = true
  }

  const handleChangeUser = () => {
    userId = userId === '1' ? '2' : '1'
  }

  return (
    <section id="resource-test">
      <h2>Resource (Async Data)</h2>
      <button id="load-resource" onClick={handleLoad}>
        Load User Data
      </button>
      <button id="change-user" onClick={handleChangeUser}>
        Switch User (Current: {userId})
      </button>
      <div id="resource-container">
        {showData && (
          <Suspense fallback={<div id="resource-loading">Fetching user...</div>}>
            <UserDisplay userId={userId} />
          </Suspense>
        )}
      </div>
    </section>
  )
}

function UserDisplay(props: { userId: string }) {
  const result = userResource.read(() => props.userId)

  return (
    <div id="user-data">
      <p id="user-name">Name: {result.data?.name ?? 'N/A'}</p>
      <p id="user-email">Email: {result.data?.email ?? 'N/A'}</p>
      <button id="refresh-resource" onClick={() => result.refresh()}>
        Refresh
      </button>
    </div>
  )
}

// ============================================================================
// Main App
// ============================================================================
export function App() {
  return (
    <div>
      <h1>Fict E2E Test Suite</h1>
      <BasicReactivity />
      <hr />
      <ConditionalRendering />
      <hr />
      <ListRendering />
      <hr />
      <FormInput />
      <hr />
      <ComponentProps />
      <hr />
      <StoreTest />
      <hr />
      <ContextTest />
      <hr />
      <ErrorBoundaryTest />
      <hr />
      <StyleBinding />
      <hr />
      <LifecycleTest />
      <hr />
      <EffectTest />
      <hr />
      <MemoTest />
      <hr />
      <SuspenseLazyTest />
      <hr />
      <ResourceTest />
    </div>
  )
}
