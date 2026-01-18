# Fict Forms Example

A comprehensive form handling example demonstrating Fict's reactive programming model.

## Features

- ✏️ Text inputs with reactive binding
- 🔘 Radio button group
- ☑️ Checkbox inputs
- 📋 Select dropdown
- ✅ Real-time form validation
- 📊 Live form state preview

## Getting Started

```bash
pnpm install
pnpm dev
```

## Key Concepts Demonstrated

- **`$state`**: Reactive form data object for all form fields
- **Two-way binding**: Using `value` and `onInput` for input binding
- **Form validation**: Real-time validation with error messages
- **Conditional rendering**: Show/hide validation errors and success state
- **`$effect`**: Trigger validation when validating mode is enabled
