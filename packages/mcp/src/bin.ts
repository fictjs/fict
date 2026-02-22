import { startStdioServer } from './server/transports/stdio'

startStdioServer().catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Failed to start Fict MCP server: ${message}\n`)
  process.exit(1)
})
