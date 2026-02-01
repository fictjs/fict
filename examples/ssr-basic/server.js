import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isProduction = process.env.NODE_ENV === 'production'

// Load manifest for production builds BEFORE importing server entry
// This allows __fictQrl to resolve URLs during SSR render
if (isProduction) {
  const manifestPath = path.resolve(__dirname, 'dist/client/fict.manifest.json')
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
      globalThis.__FICT_MANIFEST__ = manifest
    } catch {
      // Ignore manifest loading errors
    }
  }
}

async function createServer() {
  const app = express()

  let vite
  let template
  let render

  if (isProduction) {
    // Production: serve static files from dist/client
    app.use(express.static(path.resolve(__dirname, 'dist/client'), { index: false }))

    // Read template and import render function
    template = fs.readFileSync(path.resolve(__dirname, 'dist/client/index.html'), 'utf-8')
    const serverEntry = await import('./dist/server/entry-server.js')
    render = serverEntry.render
  } else {
    // Development: use Vite middleware
    const { createServer: createViteServer } = await import('vite')
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'custom',
    })
    app.use(vite.middlewares)

    // Read template fresh on each request
    template = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf-8')
  }

  app.use('*', async (req, res) => {
    const url = req.originalUrl

    try {
      let html = template

      if (!isProduction) {
        // In dev, transform the template and load the module fresh
        html = await vite.transformIndexHtml(url, html)
        const { render: devRender } = await vite.ssrLoadModule('/src/entry-server.tsx')
        render = devRender
      }

      // Render the app HTML
      const appHtml = render()

      // Replace the placeholder with rendered content
      // Note: Use function replacement to avoid $$ being interpreted as escape sequence
      html = html.replace('<!--app-html-->', () => appHtml)

      res.status(200).set({ 'Content-Type': 'text/html' }).end(html)
    } catch (e) {
      if (!isProduction && vite) {
        vite.ssrFixStacktrace(e)
      }
      console.error(e)
      res.status(500).end(e.message)
    }
  })

  const port = process.env.PORT || 3000
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`)
    console.log(`Mode: ${isProduction ? 'production' : 'development'}`)
  })
}

createServer()
