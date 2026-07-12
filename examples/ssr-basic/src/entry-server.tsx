import { renderToString } from '@fictjs/ssr'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { App } from './App'

// Set SSR base for QRL URL resolution in dev mode
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const projectRoot = resolve(__dirname, '..')
;(globalThis as Record<string, unknown>).__FICT_SSR_BASE__ = projectRoot

export function render() {
  const html = renderToString(() => <App />, {
    // Preview opt-in: supported SSR does not emit snapshots by default.
    includeSnapshot: true,
    includeContainer: true,
    containerId: 'app',
  })
  return html
}
