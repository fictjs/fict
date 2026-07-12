import { renderToPipeableStream, type RenderToStreamOptions } from '@fictjs/ssr'
import { createStreamingApp } from './App'

export function render(html: string, options: RenderToStreamOptions = {}) {
  const StreamingPage = createStreamingApp()
  return renderToPipeableStream(() => <StreamingPage />, {
    ...options,
    mode: 'shell',
    html,
    containerId: 'app',
    includeContainer: true,
    // Keep this fixture on the supported streaming contract; resumability is
    // validated separately by examples/ssr-basic.
    includeSnapshot: false,
  })
}
