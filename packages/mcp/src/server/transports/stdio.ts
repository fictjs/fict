import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { createFictMcpServer } from '../createServer'

export interface StartStdioServerOptions {
  docsRoot?: string | undefined
  docsManifestPath?: string | undefined
  playgroundOrigin?: string | undefined
}

export async function startStdioServer(overrides: StartStdioServerOptions = {}): Promise<void> {
  const options: {
    docsRoot?: string
    docsManifestPath?: string
    playgroundOrigin?: string
  } = {}

  if (overrides.docsRoot) {
    options.docsRoot = overrides.docsRoot
  } else if (process.env.FICT_MCP_DOCS_ROOT) {
    options.docsRoot = process.env.FICT_MCP_DOCS_ROOT
  }

  if (overrides.playgroundOrigin) {
    options.playgroundOrigin = overrides.playgroundOrigin
  } else if (process.env.FICT_PLAYGROUND_ORIGIN) {
    options.playgroundOrigin = process.env.FICT_PLAYGROUND_ORIGIN
  }

  if (overrides.docsManifestPath) {
    options.docsManifestPath = overrides.docsManifestPath
  } else if (process.env.FICT_MCP_DOCS_MANIFEST) {
    options.docsManifestPath = process.env.FICT_MCP_DOCS_MANIFEST
  }

  const { server } = createFictMcpServer(options)

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
