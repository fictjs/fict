import { $state, render } from 'fict'

interface Todo {
  id: number
  text: string
  completed: boolean
}

export function App() {
  let todos: Todo[] = $state([])
  let inputText = $state('')
  let nextId = $state(1)
  let filter = $state<'all' | 'active' | 'completed'>('all')

  const addTodo = () => {
    const text = inputText.trim()
    if (text) {
      todos = [...todos, { id: nextId, text, completed: false }]
      nextId = nextId + 1
      inputText = ''
    }
  }

  const toggleTodo = (id: number) => {
    todos = todos.map(todo => (todo.id === id ? { ...todo, completed: !todo.completed } : todo))
  }

  const removeTodo = (id: number) => {
    todos = todos.filter(todo => todo.id !== id)
  }

  const clearCompleted = () => {
    todos = todos.filter(todo => !todo.completed)
  }

  const filteredTodos = () => {
    if (filter === 'active') return todos.filter(t => !t.completed)
    if (filter === 'completed') return todos.filter(t => t.completed)
    return todos
  }

  const activeCount = () => todos.filter(t => !t.completed).length
  const completedCount = () => todos.filter(t => t.completed).length

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>📝 Fict Todos</h1>

      <div style={styles.inputRow}>
        <input
          type="text"
          value={inputText}
          onInput={(e: Event) => {
            inputText = (e.target as HTMLInputElement).value
          }}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === 'Enter') addTodo()
          }}
          placeholder="What needs to be done?"
          style={styles.input}
        />
        <button onClick={addTodo} style={styles.addButton}>
          Add
        </button>
      </div>

      <div style={styles.filters}>
        <button
          onClick={() => (filter = 'all')}
          style={{
            ...styles.filterButton,
            ...(filter === 'all' ? styles.filterButtonActive : {}),
          }}
        >
          All ({todos.length})
        </button>
        <button
          onClick={() => (filter = 'active')}
          style={{
            ...styles.filterButton,
            ...(filter === 'active' ? styles.filterButtonActive : {}),
          }}
        >
          Active ({activeCount()})
        </button>
        <button
          onClick={() => (filter = 'completed')}
          style={{
            ...styles.filterButton,
            ...(filter === 'completed' ? styles.filterButtonActive : {}),
          }}
        >
          Completed ({completedCount()})
        </button>
      </div>

      <ul style={styles.todoList}>
        {filteredTodos().map(todo => (
          <li key={todo.id} style={styles.todoItem}>
            <input
              type="checkbox"
              checked={todo.completed}
              onChange={() => toggleTodo(todo.id)}
              style={styles.checkbox}
            />
            <span
              style={{
                ...styles.todoText,
                ...(todo.completed ? styles.todoTextCompleted : {}),
              }}
            >
              {todo.text}
            </span>
            <button onClick={() => removeTodo(todo.id)} style={styles.removeButton}>
              ✕
            </button>
          </li>
        ))}
      </ul>

      {todos.length > 0 && (
        <div style={styles.footer}>
          <span style={styles.footerText}>
            {activeCount()} item{activeCount() !== 1 ? 's' : ''} left
          </span>
          {completedCount() > 0 && (
            <button onClick={clearCompleted} style={styles.clearButton}>
              Clear completed
            </button>
          )}
        </div>
      )}

      {todos.length === 0 && <p style={styles.emptyState}>No todos yet. Add one above!</p>}
    </div>
  )
}

const styles = {
  container: {
    maxWidth: '500px',
    margin: '40px auto',
    padding: '24px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    backgroundColor: '#ffffff',
    borderRadius: '12px',
    boxShadow: '0 4px 20px rgba(0, 0, 0, 0.1)',
  },
  title: {
    textAlign: 'center' as const,
    color: '#333',
    marginBottom: '24px',
    fontSize: '28px',
  },
  inputRow: {
    display: 'flex',
    gap: '8px',
    marginBottom: '16px',
  },
  input: {
    flex: '1',
    padding: '12px 16px',
    fontSize: '16px',
    border: '2px solid #e0e0e0',
    borderRadius: '8px',
    outline: 'none',
    transition: 'border-color 0.2s',
  },
  addButton: {
    padding: '12px 24px',
    fontSize: '16px',
    backgroundColor: '#4f46e5',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontWeight: '600' as const,
    transition: 'background-color 0.2s',
  },
  filters: {
    display: 'flex',
    gap: '8px',
    marginBottom: '16px',
    justifyContent: 'center',
  },
  filterButton: {
    padding: '8px 16px',
    fontSize: '14px',
    backgroundColor: '#f3f4f6',
    color: '#374151',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  filterButtonActive: {
    backgroundColor: '#4f46e5',
    color: 'white',
  },
  todoList: {
    listStyle: 'none',
    padding: '0',
    margin: '0',
  },
  todoItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px',
    backgroundColor: '#f9fafb',
    borderRadius: '8px',
    marginBottom: '8px',
    transition: 'background-color 0.2s',
  },
  checkbox: {
    width: '20px',
    height: '20px',
    cursor: 'pointer',
  },
  todoText: {
    flex: '1',
    fontSize: '16px',
    color: '#374151',
    transition: 'all 0.2s',
  },
  todoTextCompleted: {
    textDecoration: 'line-through',
    color: '#9ca3af',
  },
  removeButton: {
    padding: '4px 8px',
    fontSize: '14px',
    backgroundColor: 'transparent',
    color: '#ef4444',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    opacity: '0.6',
    transition: 'opacity 0.2s',
  },
  footer: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: '16px',
    paddingTop: '16px',
    borderTop: '1px solid #e5e7eb',
  },
  footerText: {
    fontSize: '14px',
    color: '#6b7280',
  },
  clearButton: {
    padding: '8px 12px',
    fontSize: '14px',
    backgroundColor: 'transparent',
    color: '#ef4444',
    border: '1px solid #ef4444',
    borderRadius: '6px',
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  emptyState: {
    textAlign: 'center' as const,
    color: '#9ca3af',
    fontSize: '16px',
    padding: '24px',
  },
}

const app = document.getElementById('app')
if (app) {
  render(() => <App />, app)
}

export default App
