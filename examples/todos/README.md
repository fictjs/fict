# Fict Todos Example

A simple Todo List application demonstrating Fict's reactive programming model.

## Features

- ✅ Add, toggle, and remove todos
- 🔍 Filter by All / Active / Completed
- 🧹 Clear completed todos
- 💾 Reactive state management with `$state`

## Getting Started

```bash
pnpm install
pnpm dev
```

## Key Concepts Demonstrated

- **`$state`**: Reactive state declarations for todos, input text, and filter
- **Computed values**: Functions like `filteredTodos()`, `activeCount()`, `completedCount()`
- **Event handling**: Input, keyboard, and click events
- **Conditional rendering**: Show/hide elements based on state
- **List rendering**: Mapping over todos array with reactive updates
