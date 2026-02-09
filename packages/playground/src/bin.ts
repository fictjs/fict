import { runCli } from './cli'

runCli().catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Failed to start playground: ${message}\n`)
  process.exit(1)
})
