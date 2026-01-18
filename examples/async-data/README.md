# Fict Async Data Example

A comprehensive async data fetching example demonstrating Fict's `resource` API with `Suspense`.

## Features

- 🔄 Async data fetching with `resource` API
- ⏳ Loading states with `Suspense`
- ⚠️ Error handling with `ErrorBoundary`
- 🔁 Refresh/refetch functionality
- 📦 Automatic caching
- 🎯 Reactive data dependencies

## Getting Started

```bash
pnpm install
pnpm dev
```

## Key Concepts Demonstrated

- **`resource()`**: Creates an async data primitive with built-in caching
- **`Suspense`**: Declarative loading states while data is being fetched
- **`ErrorBoundary`**: Graceful error handling with retry capability
- **Reactive fetching**: Changing `userId` automatically triggers new fetch
- **`refresh()`**: Manual refetch of data
