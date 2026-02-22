import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { createFictMcpServer } from '../createServer'

export async function startStdioServer(): Promise<void> {
  const options: {
    docsRoot?: string
    docsManifestPath?: string
    playgroundOrigin?: string
  } = {}

  if (process.env.FICT_MCP_DOCS_ROOT) {
    options.docsRoot = process.env.FICT_MCP_DOCS_ROOT
  }

  if (process.env.FICT_PLAYGROUND_ORIGIN) {
    options.playgroundOrigin = process.env.FICT_PLAYGROUND_ORIGIN
  }

  if (process.env.FICT_MCP_DOCS_MANIFEST) {
    options.docsManifestPath = process.env.FICT_MCP_DOCS_MANIFEST
  }

  const { server } = createFictMcpServer(options)

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
