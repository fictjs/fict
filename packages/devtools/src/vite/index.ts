/**
 * Fict DevTools Vite Plugin
 *
 * Integrates Fict DevTools into Vite development server,
 * providing a standalone DevTools UI without requiring a browser extension.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Plugin, ViteDevServer } from 'vite'

/**
 * Configuration options for the Fict DevTools Vite plugin.
 *
 * ## Auto-injection Behavior
 *
 * The plugin attempts to auto-inject DevTools into your entry file using
 * heuristic-based detection. This works for common patterns like:
 *
 * ```ts
 * import { render } from 'fict'
 * render(App, document.getElementById('root'))
 * ```
 *
 * However, it may not detect edge cases such as:
 * - Aliased render calls: `const mount = render; mount(App, root)`
 * - DOM elements imported from other modules
 * - Dynamic render calls via variables
 *
 * If auto-injection doesn't work for your setup, add this import manually
 * to your entry file:
 *
 * ```ts
 * import 'virtual:fict-devtools'
 * ```
 *
 * The plugin will log warnings when it detects potential entry files that
 * weren't auto-injected.
 */
export interface FictDevToolsOptions {
  /**
   * Enable/disable DevTools
   * @default true in development, false in production
   */
  enabled?: boolean

  /**
   * Open DevTools in a separate browser window
   * @default false
   */
  openInBrowser?: boolean

  /**
   * Port for standalone DevTools server
   * @default 5175
   */
  port?: number

  /**
   * Launch editor when clicking "open in editor"
   * @default 'code' (VS Code)
   */
  launchEditor?: 'code' | 'code-insiders' | 'webstorm' | 'atom' | string

  /**
   * Component name transformer for display
   */
  componentNameTransformer?: (name: string) => string
}

const __dirname = dirname(fileURLToPath(import.meta.url))
// Resolve to package root
// When built for package output, chunks are in dist/, so we go up 1 level
// When running from source (src/vite/), we go up 2 levels
const packageRoot = __dirname.includes('dist')
  ? resolve(__dirname, '..')
  : resolve(__dirname, '../..')

type ParsedAssetRequest = { pathname: string } | { statusCode: 400 | 403; message: string }

/**
 * Decode the request path exactly once and reject path spellings that can be
 * interpreted differently by URL and filesystem implementations.
 */
function parseAssetRequest(rawUrl: string): ParsedAssetRequest {
  const queryIndex = rawUrl.search(/[?#]/)
  const rawPathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex)

  if (!rawPathname.startsWith('/')) {
    return { statusCode: 400, message: 'Invalid DevTools asset path' }
  }

  let pathname: string
  try {
    pathname = decodeURIComponent(rawPathname)
  } catch {
    return { statusCode: 400, message: 'Malformed DevTools asset path' }
  }

  if (pathname.includes('\0')) {
    return { statusCode: 400, message: 'Invalid DevTools asset path' }
  }

  // URL paths use forward slashes. Backslashes and still-encoded path
  // separators/dot segments are ambiguous on Windows or after a second decode.
  if (pathname.includes('\\') || /%(?:00|2e|2f|5c)/i.test(pathname)) {
    return { statusCode: 403, message: 'Forbidden DevTools asset path' }
  }

  if (pathname.split('/').some(segment => segment === '..')) {
    return { statusCode: 403, message: 'Forbidden DevTools asset path' }
  }

  return { pathname }
}

function resolveAssetPath(buildDir: string, pathname: string): string | undefined {
  const relativePath = pathname.replace(/^\/+/, '')
  const staticPath = resolve(buildDir, relativePath)
  const pathFromBuildDir = relative(buildDir, staticPath)

  if (
    pathFromBuildDir === '..' ||
    pathFromBuildDir.startsWith(`..${sep}`) ||
    isAbsolute(pathFromBuildDir)
  ) {
    return undefined
  }

  return staticPath
}

/**
 * Fict DevTools Vite Plugin
 */
export default function fictDevTools(options: FictDevToolsOptions = {}): Plugin[] {
  const { enabled, openInBrowser = false, port: _port = 5175, launchEditor = 'code' } = options

  let server: ViteDevServer
  let resolvedEnabled = enabled

  const virtualModuleId = 'virtual:fict-devtools'
  const resolvedVirtualModuleId = '\0' + virtualModuleId

  return [
    {
      name: 'fict-devtools:serve',
      apply: 'serve',
      enforce: 'pre',

      config() {
        // Exclude devtools packages from prebundling to ensure changes
        // take effect immediately without requiring node_modules reinstall
        return {
          optimizeDeps: {
            exclude: ['@fictjs/devtools', '@fictjs/devtools/core', '@fictjs/devtools/vite'],
          },
        }
      },

      configResolved(config) {
        // Default to enabled in development
        if (resolvedEnabled === undefined) {
          resolvedEnabled = config.mode !== 'production'
        }
      },

      configureServer(_server) {
        if (!resolvedEnabled) return

        server = _server

        // Serve DevTools UI at /__fict-devtools__/
        server.middlewares.use('/__fict-devtools__', (req, res, next) => {
          const request = parseAssetRequest(req.url || '/')
          if ('statusCode' in request) {
            res.statusCode = request.statusCode
            res.end(request.message)
            return
          }

          const { pathname } = request
          const buildDir = resolve(packageRoot, 'build/chrome')

          // Serve panel HTML
          if (pathname === '/' || pathname === '/index.html') {
            res.setHeader('Content-Type', 'text/html')
            res.end(getDevToolsHtml(server.config.base))
            return
          }

          // Map virtual paths to actual build files
          let assetPath = pathname
          if (pathname === '/index.js') {
            assetPath = '/panel.js'
          } else if (pathname === '/styles.css') {
            assetPath = '/assets/panel.css'
          }

          // Serve static assets from build directory
          const staticPath = resolveAssetPath(buildDir, assetPath)
          if (!staticPath) {
            res.statusCode = 403
            res.end('Forbidden DevTools asset path')
            return
          }

          if (existsSync(staticPath)) {
            const content = readFileSync(staticPath)
            const contentType = getContentType(extname(assetPath).slice(1))
            res.setHeader('Content-Type', contentType)
            res.end(content)
            return
          }

          next()
        })

        // Handle open-in-editor requests
        server.middlewares.use('/__open-in-editor', async (req, res) => {
          const url = new URL(req.url || '', `http://${req.headers.host}`)
          const file = url.searchParams.get('file')

          if (!file) {
            res.statusCode = 400
            res.end('Missing file parameter')
            return
          }

          try {
            await openInEditor(file, launchEditor)
            res.statusCode = 200
            res.end('OK')
          } catch (e) {
            res.statusCode = 500
            res.end(String(e))
          }
        })

        // Print DevTools URL when server starts
        server.httpServer?.once('listening', () => {
          const protocol = server.config.server.https ? 'https' : 'http'
          const host = server.config.server.host || 'localhost'
          const serverPort = server.config.server.port || 5173
          const devtoolsUrl = `${protocol}://${host}:${serverPort}/__fict-devtools__/`

          setTimeout(() => {
            server.config.logger.info('')
            server.config.logger.info(
              `  \x1b[32m➜\x1b[0m  \x1b[1mFict DevTools:\x1b[0m \x1b[36m${devtoolsUrl}\x1b[0m`,
            )
          }, 100)

          if (openInBrowser) {
            const openPackage = 'open'
            import(/* @vite-ignore */ openPackage)
              .then((mod: { default: (url: string) => Promise<unknown> }) => {
                mod.default(devtoolsUrl)
              })
              .catch(() => {})
          }
        })
      },

      resolveId(id): string | undefined {
        if (id === virtualModuleId) {
          return resolvedVirtualModuleId
        }
        return undefined
      },

      load(id): string | undefined {
        if (id === resolvedVirtualModuleId) {
          if (!resolvedEnabled) {
            // Return noop in production
            return `export function attachDevTools() {}`
          }

          return `
            import { attachDebugger } from '@fictjs/devtools/core'

            export function attachDevTools() {
              if (typeof window === 'undefined') return

              // Attach debugger hook
              attachDebugger()

              // Add DevTools button to page (optional)
              if (import.meta.hot) {
                import.meta.hot.on('fict-devtools:update', (data) => {
                  window.postMessage({
                    source: 'fict-devtools-vite',
                    type: 'update',
                    payload: data
                  }, '*')
                })
              }
            }

            // Auto-attach in development
            if (import.meta.env.DEV) {
              attachDevTools()
            }
          `
        }
        return undefined
      },

      // Track which files have been injected to avoid duplicate imports
      transform(code, id) {
        if (!resolvedEnabled) return undefined

        // Skip node_modules and non-project files
        if (id.includes('node_modules')) return undefined
        if (id.includes('/packages/')) return undefined // Skip workspace packages
        if (!/\.[jt]sx?$/.test(id)) return undefined

        // Skip test files to avoid false positives
        if (
          id.includes('.test.') ||
          id.includes('.spec.') ||
          id.includes('__tests__') ||
          id.includes('__mocks__')
        ) {
          return undefined
        }

        // Only inject into entry files that don't already have devtools
        if (code.includes('virtual:fict-devtools') || code.includes('@fictjs/devtools')) {
          return undefined
        }

        // ========================================================================
        // BEST-EFFORT ENTRY FILE DETECTION
        // ========================================================================
        // This is a heuristic-based detection that works for common patterns but
        // may miss edge cases like:
        //   - Aliased render calls: const mount = render; mount(App, root)
        //   - DOM elements imported from other modules
        //   - Dynamic render calls via variables
        //
        // If auto-injection doesn't work for your setup, add this import manually
        // to your entry file:
        //   import 'virtual:fict-devtools'
        // ========================================================================

        // Step 1: Must import from 'fict' or '@fictjs/runtime'
        const hasFictImport = /import\s+.*\s+from\s+['"](?:fict|@fictjs\/runtime)['"]/.test(code)
        if (!hasFictImport) return undefined

        // Step 2: Check for direct render/createRoot/hydrate calls
        const hasDirectRenderCall = /\b(render|createRoot|hydrate)\s*\(/.test(code)

        // Step 3: Check for DOM element references
        const hasDomReference =
          /document\s*\./.test(code) ||
          /getElementById|querySelector|querySelectorAll/.test(code) ||
          // Common variable names for DOM elements
          /\b(root|app|container|mount|el|element|target|wrapper)\s*[=!]/.test(code)

        // Step 4: Check if render/createRoot/hydrate is imported (might be aliased later)
        const importsRenderFunctions =
          /import\s+\{[^}]*(render|createRoot|hydrate)[^}]*\}\s+from\s+['"]fict['"]/.test(code)

        // Determine injection eligibility
        const shouldInject = hasDirectRenderCall && hasDomReference

        if (shouldInject) {
          server?.config.logger.info(
            `  \x1b[32m✓\x1b[0m  [fict-devtools] Auto-injecting into: ${id}`,
          )

          // Inject devtools import at the very beginning
          const injectedCode = `import 'virtual:fict-devtools'\n${code}`
          return {
            code: injectedCode,
            map: null,
          }
        }

        // Provide helpful warnings for files that might be entry files but weren't injected
        if (importsRenderFunctions || hasDirectRenderCall) {
          const reasons: string[] = []
          if (!hasDirectRenderCall) {
            reasons.push('no direct render/createRoot/hydrate() call detected (aliased?)')
          }
          if (!hasDomReference) {
            reasons.push('no DOM element reference detected (imported from another module?)')
          }

          const reasonStr = reasons.length > 0 ? ` Reason: ${reasons.join('; ')}.` : ''

          server?.config.logger.info(
            `  \x1b[33m⚠\x1b[0m  [fict-devtools] "${id}" imports render functions but wasn't auto-injected.${reasonStr}\n` +
              `     If this is your entry file, add: \x1b[36mimport 'virtual:fict-devtools'\x1b[0m`,
          )
        }
        return undefined
      },
    },

    // Build plugin for production
    {
      name: 'fict-devtools:build',
      apply: 'build',

      resolveId(id): string | undefined {
        if (id === virtualModuleId) {
          return resolvedVirtualModuleId
        }
        return undefined
      },

      load(id): string | undefined {
        if (id === resolvedVirtualModuleId) {
          // Noop in production build
          return `export function attachDevTools() {}`
        }
        return undefined
      },
    },
  ]
}

/**
 * Generate DevTools HTML page
 */
function getDevToolsHtml(base: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fict DevTools</title>
  <link rel="stylesheet" href="${base}__fict-devtools__/styles.css">
  <style>
    body {
      margin: 0;
      padding: 0;
      overflow: hidden;
    }
  </style>
</head>
<body>
  <div id="app"></div>
  <script type="module">
    // Connect to parent window if opened as popup
    const opener = window.opener
    if (opener) {
      window.addEventListener('message', (event) => {
        if (event.data?.source === 'fict-devtools-hook') {
          // Forward to DevTools
          document.dispatchEvent(new CustomEvent('fict-devtools-message', {
            detail: event.data
          }))
        }
      })

      // Request initial state
      opener.postMessage({
        source: 'fict-devtools-panel',
        type: 'connect'
      }, '*')
    }

    // Import panel code
    import '${base}__fict-devtools__/index.js'
  </script>
</body>
</html>`
}

/**
 * Get content type for file extension
 */
function getContentType(ext: string): string {
  const types: Record<string, string> = {
    html: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    json: 'application/json',
    png: 'image/png',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
  }
  return types[ext] || 'application/octet-stream'
}

/**
 * Open file in editor
 */
async function openInEditor(file: string, editor: string): Promise<void> {
  const [filePath, line, column] = file.split(':')
  const resolvedPath = resolve(filePath!)

  let command: string
  let args: string[]

  switch (editor) {
    case 'code':
    case 'code-insiders':
      command = editor
      args = ['--goto', `${resolvedPath}:${line || 1}:${column || 1}`]
      break
    case 'webstorm':
      command = 'webstorm'
      args = ['--line', line || '1', '--column', column || '1', resolvedPath]
      break
    case 'atom':
      command = 'atom'
      args = [`${resolvedPath}:${line || 1}:${column || 1}`]
      break
    default:
      // Custom editor command
      command = editor
      args = [resolvedPath]
  }

  const { spawn } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', reject)
    child.unref()
    resolve()
  })
}

export { fictDevTools }
