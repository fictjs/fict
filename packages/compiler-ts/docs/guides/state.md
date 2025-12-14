# State Management

Learn how to manage reactive state in Fict.

## Creating State with `$state`

Use `$state` to create reactive values that trigger updates when they change:

```tsx
import { $state } from 'fict'

function Counter() {
  let count = $state(0)

  return <button onClick={() => count++}>{count}</button>
}
```

### Type Inference

TypeScript automatically infers the type from the initial value:

```tsx
let count = $state(0) // number
let name = $state('Alice') // string
let user = $state<User | null>(null) // User | null
```

## Reading State

State values are plain values - just use them directly:

```tsx
let count = $state(5)

console.log(count) // 5
console.log(count * 2) // 10

if (count > 0) {
  console.log('Positive')
}
```

## Updating State

Update state with normal assignments:

```tsx
let count = $state(0)

// Simple assignment
count = 5

// Increment/decrement
count++
count--

// Compound assignment
count += 10
count -= 5
count *= 2
```

## Objects and Arrays

State can hold objects and arrays:

```tsx
let user = $state({
  name: 'Alice',
  age: 30,
})

let todos = $state([
  { id: 1, text: 'Learn Fict' },
  { id: 2, text: 'Build app' },
])
```

### Updating Objects (Immutable Pattern)

For best reactivity, use immutable updates:

```tsx
// ✅ Good - creates new object
user = { ...user, age: 31 }

// ⚠️ Avoid - direct mutation
user.age = 31 // Won't trigger updates for nested properties
```

### Updating Arrays

Use immutable array methods:

```tsx
// Add item
todos = [...todos, { id: 3, text: 'New todo' }]

// Remove item
todos = todos.filter(t => t.id !== 2)

// Update item
todos = todos.map(t => (t.id === 1 ? { ...t, done: true } : t))

// Sort
todos = [...todos].sort((a, b) => a.id - b.id)
```

## Derived Values

Derived values automatically recompute when their dependencies change:

```tsx
let price = $state(100)
let quantity = $state(2)

// Automatically tracked as derived
const subtotal = price * quantity
const tax = subtotal * 0.1
const total = subtotal + tax

return <div>Total: ${total}</div>
```

### Derived values are `const`

Derived values must be declared with `const`:

```tsx
// ✅ Good
const doubled = count * 2

// ❌ Error - derived values must be const
let doubled = count * 2
```

### Complex Derivations

Use any JavaScript expression:

```tsx
let items = $state([1, 2, 3, 4, 5])

const evenItems = items.filter(x => x % 2 === 0)
const sum = items.reduce((a, b) => a + b, 0)
const first = items[0]
const hasItems = items.length > 0
```

## Conditional Derived Values

You can use control flow in derived values:

```tsx
let score = $state(85)

const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : 'D'

const message = `You got a ${grade}!`
```

## Rules and Best Practices

### ✅ Do's

- Declare state at the top level of your component
- Use `const` for derived values
- Use immutable updates for objects and arrays
- Read state values directly - they're just regular values

### ❌ Don'ts

- Don't declare `$state` inside loops
- Don't declare `$state` inside conditionals
- Don't declare `$state` inside event handlers
- Don't mutate nested properties directly (use spread instead)

## Example: Todo List

Here's a complete example:

```tsx
import { $state } from 'fict'

interface Todo {
  id: number
  text: string
  done: boolean
}

function TodoList() {
  let todos = $state<Todo[]>([])
  let newTodoText = $state('')

  // Derived values
  const remaining = todos.filter(t => !t.done).length
  const completed = todos.filter(t => t.done).length

  const addTodo = () => {
    if (!newTodoText.trim()) return

    todos = [
      ...todos,
      {
        id: Date.now(),
        text: newTodoText,
        done: false,
      },
    ]

    newTodoText = ''
  }

  const toggleTodo = (id: number) => {
    todos = todos.map(t => (t.id === id ? { ...t, done: !t.done } : t))
  }

  const deleteTodo = (id: number) => {
    todos = todos.filter(t => t.id !== id)
  }

  return (
    <div>
      <h1>Todos</h1>
      <p>
        {remaining} remaining, {completed} completed
      </p>

      <input
        value={newTodoText}
        onInput={e => (newTodoText = e.currentTarget.value)}
        placeholder="What needs to be done?"
      />
      <button onClick={addTodo}>Add</button>

      <ul>
        {todos.map(todo => (
          <li key={todo.id}>
            <input type="checkbox" checked={todo.done} onChange={() => toggleTodo(todo.id)} />
            <span style={{ textDecoration: todo.done ? 'line-through' : 'none' }}>{todo.text}</span>
            <button onClick={() => deleteTodo(todo.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

## Next Steps

- Learn about [Effects](./effects.md) for side effects
- Explore [Control Flow](./control-flow.md) for conditionals and lists
- Read the [API Reference](../api/state.md)
