import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { createFictMcpServer } from '../createServer'

export async function startStdioServer(): Promise<void> {
  const { server } = createFictMcpServer(
    process.env.FICT_MCP_DOCS_ROOT
      ? {
          docsRoot: process.env.FICT_MCP_DOCS_ROOT,
        }
      : {},
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
