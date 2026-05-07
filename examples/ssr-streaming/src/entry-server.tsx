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
    includeSnapshot: true,
  })
}
