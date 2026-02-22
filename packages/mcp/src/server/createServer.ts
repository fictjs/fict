import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { createDocsStore } from '../store/docsStore'
import { registerDocsResources } from '../tools/registerDocsResources'
import { registerDocsTools } from '../tools/registerDocsTools'
import { registerFictAutofixerTool } from '../tools/registerFictAutofixerTool'
import { buildFictTaskPrompt } from '../tools/registerFictPrompts'
import { registerPlaygroundLinkTool } from '../tools/registerPlaygroundLinkTool'

export interface CreateFictMcpServerOptions {
  docsRoot?: string
  docsManifestPath?: string
  playgroundOrigin?: string
  serverName?: string
  serverVersion?: string
}

function findDocsRoot(startDir: string): string {
  let current = path.resolve(startDir)

  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = path.join(current, 'docs')
    if (fs.existsSync(candidate)) {
      return candidate
    }

    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  return path.resolve(startDir, 'docs')
}

function findDefaultDocsManifestPath(): string | undefined {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(moduleDir, '../assets/docs-manifest.json'),
    path.resolve(moduleDir, '../../assets/docs-manifest.json'),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return undefined
}

export function createFictMcpServer(options: CreateFictMcpServerOptions = {}): {
  server: McpServer
  docsRoot: string
} {
  const docsRootProvided = Boolean(options.docsRoot)
  const docsRoot = docsRootProvided ? path.resolve(options.docsRoot!) : findDocsRoot(process.cwd())
  const docsManifestPath = options.docsManifestPath
    ? path.resolve(options.docsManifestPath)
    : docsRootProvided
      ? undefined
      : findDefaultDocsManifestPath()
  const docsStore = docsManifestPath
    ? createDocsStore({
        docsRoot,
        manifestPath: docsManifestPath,
      })
    : createDocsStore({
        docsRoot,
      })

  const server = new McpServer({
    name: options.serverName ?? 'fict-mcp',
    version: options.serverVersion ?? '0.12.0',
  })

  registerDocsTools(server, docsStore)
  registerDocsResources(server, docsStore)
  registerFictAutofixerTool(server)
  registerPlaygroundLinkTool(
    server,
    options.playgroundOrigin
      ? {
          origin: options.playgroundOrigin,
        }
      : {},
  )

  server.registerPrompt(
    'fict-task',
    {
      title: 'Fict Task',
      description: 'Prompt template for docs-first Fict generation.',
      argsSchema: {
        task: z.string().describe('User request / task description'),
      },
    },
    ({ task }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: buildFictTaskPrompt(task),
          },
        },
      ],
    }),
  )

  return { server, docsRoot }
}
