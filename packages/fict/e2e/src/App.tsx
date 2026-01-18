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
// 15. Complex Interaction Test - Multi-step workflows
// ============================================================================
function ComplexInteraction() {
  let step = $state(1)
  let formData = $state({ name: '', email: '', confirmed: false })
  let submitted = $state(false)

  const nextStep = () => {
    if (step < 3) step++
  }

  const prevStep = () => {
    if (step > 1) step--
  }

  const submit = () => {
    submitted = true
  }

  const reset = () => {
    step = 1
    formData = { name: '', email: '', confirmed: false }
    submitted = false
  }

  if (submitted) {
    return (
      <section id="complex-interaction">
        <h2>Complex Interaction</h2>
        <div id="submission-result">
          <p>
            Submitted: {formData.name} ({formData.email})
          </p>
          <button id="reset-form" onClick={reset}>
            Start Over
          </button>
        </div>
      </section>
    )
  }

  return (
    <section id="complex-interaction">
      <h2>Complex Interaction</h2>
      <p id="current-step">Step {step} of 3</p>

      {step === 1 && (
        <div id="step-1">
          <input
            id="wizard-name"
            value={formData.name}
            onInput={(e: InputEvent) =>
              (formData = { ...formData, name: (e.target as HTMLInputElement).value })
            }
            placeholder="Name"
          />
        </div>
      )}

      {step === 2 && (
        <div id="step-2">
          <input
            id="wizard-email"
            type="email"
            value={formData.email}
            onInput={(e: InputEvent) =>
              (formData = { ...formData, email: (e.target as HTMLInputElement).value })
            }
            placeholder="Email"
          />
        </div>
      )}

      {step === 3 && (
        <div id="step-3">
          <p>
            Confirm: {formData.name} - {formData.email}
          </p>
          <label>
            <input
              id="wizard-confirm"
              type="checkbox"
              checked={formData.confirmed}
              onChange={() => (formData = { ...formData, confirmed: !formData.confirmed })}
            />
            I confirm this is correct
          </label>
        </div>
      )}

      <div id="wizard-buttons">
        <button id="wizard-prev" onClick={prevStep} disabled={step === 1}>
          Previous
        </button>
        {step < 3 ? (
          <button id="wizard-next" onClick={nextStep}>
            Next
          </button>
        ) : (
          <button id="wizard-submit" onClick={submit} disabled={!formData.confirmed}>
            Submit
          </button>
        )}
      </div>
    </section>
  )
}

// ============================================================================
// 16. Suspense + ErrorBoundary Combined Test
// ============================================================================
const FailableLazyComponent = lazy(
  () =>
    new Promise<{ default: () => any }>((resolve, reject) => {
      setTimeout(() => {
        // Simulate random failure
        if (Math.random() > 0.5) {
          reject(new Error('Failed to load component'))
        } else {
          resolve({
            default: () => <div id="failable-content">Successfully loaded!</div>,
          })
        }
      }, 100)
    }),
)

const AlwaysSuccessLazy = lazy(
  () =>
    new Promise<{ default: () => any }>(resolve => {
      setTimeout(() => {
        resolve({
          default: () => <div id="success-lazy">Success component loaded</div>,
        })
      }, 50)
    }),
)

function SuspenseErrorBoundaryTest() {
  let showFailable = $state(false)
  let showSuccess = $state(false)
  let retryKey = $state(0)

  return (
    <section id="suspense-error-boundary-test">
      <h2>Suspense + ErrorBoundary Combined</h2>

      <button id="show-failable" onClick={() => (showFailable = true)}>
        Load Failable Component
      </button>
      <button id="show-success" onClick={() => (showSuccess = true)}>
        Load Success Component
      </button>
      <button id="retry-failable" onClick={() => (retryKey = retryKey + 1)}>
        Retry
      </button>

      <div id="failable-container">
        {showFailable && (
          <ErrorBoundary
            fallback={err => (
              <div id="failable-error">
                Error loading: {(err as Error).message}
                <button id="error-retry" onClick={() => (retryKey = retryKey + 1)}>
                  Retry
                </button>
              </div>
            )}
            resetKeys={() => retryKey}
          >
            <Suspense fallback={<div id="failable-loading">Loading failable...</div>}>
              <FailableLazyComponent key={retryKey} />
            </Suspense>
          </ErrorBoundary>
        )}
      </div>

      <div id="success-container">
        {showSuccess && (
          <Suspense fallback={<div id="success-loading">Loading success...</div>}>
            <AlwaysSuccessLazy />
          </Suspense>
        )}
      </div>
    </section>
  )
}

// ============================================================================
// 17. Performance Sensitive Operations
// ============================================================================
function PerformanceTest() {
  let items = $state<number[]>([])
  let renderCount = $state(0)
  let batchSize = $state(10)

  const addItems = () => {
    const newItems = Array.from({ length: batchSize }, (_, i) => items.length + i + 1)
    items = [...items, ...newItems]
    renderCount++
  }

  const removeHalf = () => {
    items = items.slice(0, Math.floor(items.length / 2))
    renderCount++
  }

  const reverseAll = () => {
    items = [...items].reverse()
    renderCount++
  }

  const shuffleAll = () => {
    const shuffled = [...items]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
    }
    items = shuffled
    renderCount++
  }

  const clearAll = () => {
    items = []
    renderCount++
  }

  return (
    <section id="performance-test">
      <h2>Performance Test</h2>

      <div id="perf-controls">
        <input
          id="batch-size"
          type="number"
          value={batchSize}
          onInput={(e: InputEvent) =>
            (batchSize = parseInt((e.target as HTMLInputElement).value) || 10)
          }
        />
        <button id="perf-add" onClick={addItems}>
          Add {batchSize} Items
        </button>
        <button id="perf-remove-half" onClick={removeHalf}>
          Remove Half
        </button>
        <button id="perf-reverse" onClick={reverseAll}>
          Reverse
        </button>
        <button id="perf-shuffle" onClick={shuffleAll}>
          Shuffle
        </button>
        <button id="perf-clear" onClick={clearAll}>
          Clear
        </button>
      </div>

      <p id="perf-stats">
        Items: <span id="item-total">{items.length}</span>, Renders:{' '}
        <span id="render-count">{renderCount}</span>
      </p>

      <ul id="perf-list">
        {items.map((item: number) => (
          <li key={item} className="perf-item" data-value={item}>
            Item {item}
          </li>
        ))}
      </ul>
    </section>
  )
}

// ============================================================================
// 18. Keyboard Navigation Test
// ============================================================================
function KeyboardNavigationTest() {
  let selectedIndex = $state(0)
  let items = $state(['Apple', 'Banana', 'Cherry', 'Date', 'Elderberry'])
  let lastKey = $state('')

  const handleKeyDown = (e: KeyboardEvent) => {
    lastKey = e.key
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectedIndex = Math.max(selectedIndex - 1, 0)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // Select action
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      if (items.length > 1) {
        const newItems = items.filter((_: string, i: number) => i !== selectedIndex)
        items = newItems
        selectedIndex = Math.min(selectedIndex, newItems.length - 1)
      }
    }
  }

  return (
    <section id="keyboard-test">
      <h2>Keyboard Navigation</h2>
      <p id="keyboard-instructions">Use Arrow keys to navigate, Delete to remove</p>
      <p id="last-key">Last key: {lastKey}</p>

      <ul
        id="keyboard-list"
        tabIndex={0}
        onKeyDown={handleKeyDown as any}
        style={{ outline: 'none' }}
      >
        {items.map((item: string, index: number) => (
          <li
            key={item}
            className={`keyboard-item ${index === selectedIndex ? 'selected' : ''}`}
            data-index={index}
            style={{
              background: index === selectedIndex ? '#e0e0ff' : 'transparent',
              padding: '8px',
            }}
          >
            {item}
          </li>
        ))}
      </ul>
      <p id="selected-item">Selected: {items[selectedIndex]}</p>
    </section>
  )
}

// ============================================================================
// 19. Drag and Drop Simulation Test
// ============================================================================
function DragDropTest() {
  let items = $state(['Item A', 'Item B', 'Item C', 'Item D'])
  let draggedIndex = $state<number | null>(null)
  let dropTargetIndex = $state<number | null>(null)

  const startDrag = (index: number) => {
    draggedIndex = index
  }

  const endDrag = () => {
    if (draggedIndex !== null && dropTargetIndex !== null && draggedIndex !== dropTargetIndex) {
      const newItems = [...items]
      const [removed] = newItems.splice(draggedIndex, 1)
      newItems.splice(dropTargetIndex, 0, removed!)
      items = newItems
    }
    draggedIndex = null
    dropTargetIndex = null
  }

  const setDropTarget = (index: number) => {
    dropTargetIndex = index
  }

  return (
    <section id="drag-drop-test">
      <h2>Drag and Drop</h2>
      <p id="drag-status">
        {draggedIndex !== null
          ? `Dragging: ${items[draggedIndex]} (target: ${dropTargetIndex !== null ? items[dropTargetIndex] : 'none'})`
          : 'Not dragging'}
      </p>

      <ul id="drag-list">
        {items.map((item: string, index: number) => (
          <li
            key={item}
            className={`drag-item ${index === draggedIndex ? 'dragging' : ''} ${index === dropTargetIndex ? 'drop-target' : ''}`}
            data-index={index}
            draggable={true}
            onDragStart={() => startDrag(index)}
            onDragOver={(e: DragEvent) => {
              e.preventDefault()
              setDropTarget(index)
            }}
            onDrop={() => endDrag()}
            onDragEnd={() => endDrag()}
            style={{
              opacity: index === draggedIndex ? 0.5 : 1,
              background: index === dropTargetIndex ? '#ffffcc' : 'white',
              padding: '10px',
              margin: '5px',
              border: '1px solid #ccc',
              cursor: 'grab',
            }}
          >
            {item}
          </li>
        ))}
      </ul>
      <p id="drag-order">Current order: {items.join(', ')}</p>
    </section>
  )
}

// ============================================================================
// 20. Animation Frame Reactive Test
// ============================================================================
function AnimationFrameTest() {
  let position = $state(0)
  let running = $state(false)
  let frameCount = $state(0)

  createEffect(() => {
    if (!running) return

    let animationId: number
    const animate = () => {
      position = (position + 2) % 300
      frameCount++
      animationId = requestAnimationFrame(animate)
    }
    animationId = requestAnimationFrame(animate)

    return () => cancelAnimationFrame(animationId)
  })

  return (
    <section id="animation-test">
      <h2>Animation Frame Test</h2>
      <button id="toggle-animation" onClick={() => (running = !running)}>
        {running ? 'Stop' : 'Start'} Animation
      </button>
      <button
        id="reset-animation"
        onClick={() => {
          position = 0
          frameCount = 0
        }}
      >
        Reset
      </button>

      <p id="frame-count">Frames: {frameCount}</p>

      <div
        id="animation-container"
        style={{ width: '300px', height: '50px', background: '#eee', position: 'relative' }}
      >
        <div
          id="animated-box"
          style={{
            position: 'absolute',
            left: `${position}px`,
            top: '10px',
            width: '30px',
            height: '30px',
            background: 'blue',
          }}
        />
      </div>
    </section>
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
      <hr />
      <ComplexInteraction />
      <hr />
      <SuspenseErrorBoundaryTest />
      <hr />
      <PerformanceTest />
      <hr />
      <KeyboardNavigationTest />
      <hr />
      <DragDropTest />
      <hr />
      <AnimationFrameTest />
    </div>
  )
}
