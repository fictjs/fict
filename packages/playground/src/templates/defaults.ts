import type { PlaygroundTemplate } from '../server/types'

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Fict Playground Session</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`

const counterApp =
  `import { $effect, $state } from 'fict'

export function App() {
  let count = $state(0)
  let step = $state(1)

  $effect(() => {
    document.title = ` +
  '`Counter ${count}`' +
  `
  })

  const dec = () => {
    count = count - step
  }

  const inc = () => {
    count = count + step
  }

  return (
    <main class="shell">
      <h1>Fict Playground</h1>
      <p>Counter example running with real @fictjs/vite-plugin transform.</p>
      <section class="card">
        <div class="value">{count}</div>
        <div class="row">
          <button onClick={dec}>-</button>
          <button onClick={inc}>+</button>
        </div>
      </section>
      <label class="step">
        Step:
        <input
          type="range"
          min="1"
          max="10"
          value={step}
          onInput={event => {
            step = Number((event.target as HTMLInputElement).value)
          }}
        />
        <span>{step}</span>
      </label>
    </main>
  )
}
`

const todosApp = `import { $state } from 'fict'

interface Todo {
  id: number
  text: string
  done: boolean
}

export function App() {
  let input = $state('')
  let nextId = $state(1)
  let todos: Todo[] = $state([])

  const add = () => {
    const text = input.trim()
    if (!text) return
    todos = [...todos, { id: nextId, text, done: false }]
    nextId = nextId + 1
    input = ''
  }

  const toggle = (id: number) => {
    todos = todos.map(todo => (todo.id === id ? { ...todo, done: !todo.done } : todo))
  }

  const remove = (id: number) => {
    todos = todos.filter(todo => todo.id !== id)
  }

  return (
    <main class="shell">
      <h1>Todos</h1>
      <div class="row">
        <input
          value={input}
          onInput={event => {
            input = (event.target as HTMLInputElement).value
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') add()
          }}
          placeholder="What needs to be done?"
        />
        <button onClick={add}>Add</button>
      </div>
      <ul class="list">
        {todos.map(todo => (
          <li key={todo.id} class={todo.done ? 'done' : ''}>
            <label>
              <input type="checkbox" checked={todo.done} onChange={() => toggle(todo.id)} />
              <span>{todo.text}</span>
            </label>
            <button onClick={() => remove(todo.id)}>x</button>
          </li>
        ))}
      </ul>
    </main>
  )
}
`

const asyncApp = `import { $state, ErrorBoundary, Suspense } from 'fict'
import { resource } from 'fict/plus'

interface Repo {
  id: number
  name: string
  stars: number
}

const reposResource = resource<Repo[], string>({
  suspense: true,
  fetch: async ({ signal }, query) => {
    await new Promise(resolve => setTimeout(resolve, 450))
    if (signal.aborted) throw new Error('aborted')
    const sample: Repo[] = [
      { id: 1, name: 'fict', stars: 1810 },
      { id: 2, name: 'fict-router', stars: 620 },
      { id: 3, name: 'fict-testing-library', stars: 430 },
    ]
    return sample.filter(repo => repo.name.includes(query.toLowerCase()))
  },
})

function RepoList(props: { query: string }) {
  const result = reposResource.read(props.query)
  return (
    <ul class="list">
      {result.data?.map(repo => (
        <li key={repo.id}>
          <strong>{repo.name}</strong>
          <span>★ {repo.stars}</span>
        </li>
      ))}
    </ul>
  )
}

export function App() {
  let query = $state('fict')

  return (
    <main class="shell">
      <h1>Async Resource Lab</h1>
      <p>Suspense + ErrorBoundary + resource() in one place.</p>
      <input
        value={query}
        onInput={event => {
          query = (event.target as HTMLInputElement).value
        }}
      />
      <ErrorBoundary fallback={(error, reset) => <button onClick={reset}>Retry: {error.message}</button>}>
        <Suspense fallback={<p>Loading repos...</p>}>
          <RepoList query={query.trim() || 'fict'} />
        </Suspense>
      </ErrorBoundary>
    </main>
  )
}
`

const resumableApp = `import { $state } from 'fict'

export function App() {
  let count = $state(0)

  return (
    <main class="shell">
      <h1>Resumable Lab</h1>
      <p>This template uses onClick$ handlers and resumable transform output.</p>
      <div class="card">
        <button onClick$={() => count--}>-</button>
        <span class="value">{count}</span>
        <button onClick$={() => count++}>+</button>
      </div>
    </main>
  )
}
`

const baseMain = `import { render } from 'fict'

import { App } from './App'
import './styles.css'

render(() => <App />, document.getElementById('app')!)
`

const resumableMain = `import { installResumableLoader } from 'fict/loader'
import { render } from 'fict'

import { App } from './App'
import './styles.css'

render(() => <App />, document.getElementById('app')!)

installResumableLoader({
  document,
  events: ['click'],
})
`

const styles = `:root {
  color-scheme: light;
  --bg: #f4efe8;
  --panel: #ffffff;
  --text: #1d1d1f;
  --accent: #cf4122;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: 'Space Grotesk', 'Segoe UI', sans-serif;
  color: var(--text);
  background: radial-gradient(circle at 20% 20%, #ffe9dc 0%, #f4efe8 55%, #e5ddd2 100%);
}

#app {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.shell {
  width: min(720px, 100%);
  padding: 28px;
  border-radius: 20px;
  background: var(--panel);
  box-shadow: 0 18px 45px rgba(19, 20, 23, 0.14);
  display: grid;
  gap: 14px;
}

.card {
  display: flex;
  align-items: center;
  gap: 12px;
}

.row {
  display: flex;
  gap: 10px;
}

.value {
  font-size: clamp(2rem, 5vw, 3.2rem);
  font-weight: 700;
  min-width: 3ch;
  text-align: center;
}

input,
button {
  font: inherit;
}

button {
  border: 0;
  border-radius: 10px;
  padding: 10px 14px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}

input[type='text'],
input[type='range'],
input:not([type]) {
  width: 100%;
  border-radius: 10px;
  border: 1px solid #ceb8a2;
  padding: 9px 12px;
  background: #fffefc;
}

.step {
  display: flex;
  align-items: center;
  gap: 10px;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}

.list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border: 1px solid #ece1d4;
  border-radius: 10px;
  padding: 10px 12px;
  background: #fffdf8;
}

.list li.done span {
  text-decoration: line-through;
  opacity: 0.65;
}
`

const tsConfig = {
  compilerOptions: {
    target: 'ES2020',
    module: 'ESNext',
    moduleResolution: 'bundler',
    jsx: 'preserve',
    jsxImportSource: 'fict',
    strict: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
    types: ['node'],
  },
  include: ['src'],
}

function withBaseFiles(
  appContent: string,
  entryFile = 'src/App.tsx',
  mainContent = baseMain,
): Record<string, string> {
  return {
    'index.html': html,
    'tsconfig.json': `${JSON.stringify(tsConfig, null, 2)}\n`,
    'src/main.tsx': mainContent,
    [entryFile]: appContent,
    'src/styles.css': styles,
  }
}

export const defaultPlaygroundTemplates: PlaygroundTemplate[] = [
  {
    id: 'counter',
    name: 'Counter',
    description: 'State + effect baseline using the same compile pipeline as real apps.',
    entryFile: 'src/App.tsx',
    files: withBaseFiles(counterApp),
  },
  {
    id: 'todos',
    name: 'Todos',
    description: 'Collection mutation and keyed list rendering semantics.',
    entryFile: 'src/App.tsx',
    files: withBaseFiles(todosApp),
  },
  {
    id: 'async-resource',
    name: 'Async Resource',
    description: 'resource() + Suspense + ErrorBoundary behavior with diagnostics.',
    entryFile: 'src/App.tsx',
    files: withBaseFiles(asyncApp),
  },
  {
    id: 'resumable-lab',
    name: 'Resumable Lab',
    description: 'onClick$ handlers with resumable + function splitting enabled.',
    entryFile: 'src/App.tsx',
    files: withBaseFiles(resumableApp, 'src/App.tsx', resumableMain),
    recommendedConfig: {
      resumable: true,
      functionSplitting: true,
      profile: 'app-default',
    },
  },
]
