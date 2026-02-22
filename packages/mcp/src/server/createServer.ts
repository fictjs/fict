import fs from 'node:fs'
import path from 'node:path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { registerDocsResources } from '../tools/registerDocsResources'
import { buildFictTaskPrompt } from '../tools/registerFictPrompts'
import { registerFictAutofixerTool } from '../tools/registerFictAutofixerTool'
import { registerDocsTools } from '../tools/registerDocsTools'
import { createDocsStore } from '../store/docsStore'

export interface CreateFictMcpServerOptions {
  docsRoot?: string
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

export function createFictMcpServer(options: CreateFictMcpServerOptions = {}): {
  server: McpServer
  docsRoot: string
} {
  const docsRoot = options.docsRoot ? path.resolve(options.docsRoot) : findDocsRoot(process.cwd())
  const docsStore = createDocsStore({ docsRoot })

  const server = new McpServer({
    name: options.serverName ?? 'fict-mcp',
    version: options.serverVersion ?? '0.12.0',
  })

  registerDocsTools(server, docsStore)
  registerDocsResources(server, docsStore)
  registerFictAutofixerTool(server)

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
