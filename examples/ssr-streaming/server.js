import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isProduction = process.env.NODE_ENV === 'production'

async function createServer() {
  const app = express()
  let vite
  let template
  let render

  if (isProduction) {
    app.use(express.static(path.resolve(__dirname, 'dist/client'), { index: false }))
    template = fs.readFileSync(path.resolve(__dirname, 'dist/client/index.html'), 'utf-8')
    const serverEntry = await import('./dist/server/entry-server.js')
    render = serverEntry.render
  } else {
    const { createServer: createViteServer } = await import('vite')
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'custom',
    })
    app.use(vite.middlewares)
    template = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf-8')
  }

  app.use(async (req, res) => {
    try {
      let html = template
      if (!isProduction) {
        html = await vite.transformIndexHtml(req.originalUrl, html)
        const serverEntry = await vite.ssrLoadModule('/src/entry-server.tsx')
        render = serverEntry.render
      }

      let didError = false
      const { pipe, shellReady, allReady } = render(html, {
        onError(error) {
          didError = true
          console.error(error)
        },
      })

      await shellReady
      res.status(didError ? 500 : 200)
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      pipe(res)
      allReady.catch(error => console.error(error))
    } catch (error) {
      if (!isProduction && vite) {
        vite.ssrFixStacktrace(error)
      }
      console.error(error)
      res.status(500).end(error instanceof Error ? error.message : String(error))
    }
  })

  const port = Number(process.env.PORT || 3001)
  app.listen(port, () => {
    console.log(`SSR streaming example running at http://localhost:${port}`)
  })
}

createServer()
