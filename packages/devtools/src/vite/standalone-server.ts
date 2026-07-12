import { createServer, type Server } from 'node:http'

export interface StandaloneDevToolsServer {
  url: string
  close: () => Promise<void>
}

export function validateStandalonePort(port: number): number {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError(
      `[fict-devtools] "port" must be an integer between 0 and 65535; received ${String(port)}.`,
    )
  }
  return port
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function createLauncherHtml(devtoolsUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fict DevTools</title>
  <style>
    html, body, iframe { width: 100%; height: 100%; margin: 0; border: 0; overflow: hidden; }
  </style>
</head>
<body>
  <iframe src="${escapeHtmlAttribute(devtoolsUrl)}" title="Fict DevTools" referrerpolicy="no-referrer"></iframe>
</body>
</html>`
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  server.closeAllConnections?.()
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
      else resolve()
    })
  })
}

export function startStandaloneDevToolsServer(
  port: number,
  devtoolsUrl: string,
): Promise<StandaloneDevToolsServer> {
  const validatedPort = validateStandalonePort(port)
  const target = new URL(devtoolsUrl)
  const html = createLauncherHtml(target.toString())
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' })
      response.end()
      return
    }
    if (pathname !== '/' && pathname !== '/index.html') {
      response.writeHead(404)
      response.end('Not Found')
      return
    }

    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; frame-src ${target.origin}; style-src 'unsafe-inline'`,
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(request.method === 'HEAD' ? undefined : html)
  })

  return new Promise((resolve, reject) => {
    const handleError = (error: Error) => {
      server.off('listening', handleListening)
      reject(error)
    }
    const handleListening = () => {
      server.off('error', handleError)
      const address = server.address()
      if (!address || typeof address === 'string') {
        void closeServer(server)
        reject(new Error('[fict-devtools] Failed to resolve the standalone DevTools address.'))
        return
      }
      server.unref()
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => closeServer(server),
      })
    }

    server.once('error', handleError)
    server.once('listening', handleListening)
    server.listen(validatedPort, '127.0.0.1')
  })
}
