import { afterEach, describe, expect, it } from 'vitest'

import { runCli } from '../src/cli'

const ORIGINAL_TRANSPORT = process.env.FICT_MCP_TRANSPORT
const ORIGINAL_ENABLE_SSE = process.env.FICT_MCP_ENABLE_SSE

function restoreEnv(): void {
  if (ORIGINAL_TRANSPORT === undefined) {
    delete process.env.FICT_MCP_TRANSPORT
  } else {
    process.env.FICT_MCP_TRANSPORT = ORIGINAL_TRANSPORT
  }

  if (ORIGINAL_ENABLE_SSE === undefined) {
    delete process.env.FICT_MCP_ENABLE_SSE
  } else {
    process.env.FICT_MCP_ENABLE_SSE = ORIGINAL_ENABLE_SSE
  }
}

afterEach(() => {
  restoreEnv()
})

describe('cli transport guards', () => {
  it('rejects --sse when deprecated transport is not explicitly enabled', async () => {
    delete process.env.FICT_MCP_TRANSPORT
    delete process.env.FICT_MCP_ENABLE_SSE

    await expect(runCli(['--sse'])).rejects.toThrow(/FICT_MCP_ENABLE_SSE=1/)
  })

  it('rejects FICT_MCP_TRANSPORT=sse when deprecated transport is not explicitly enabled', async () => {
    process.env.FICT_MCP_TRANSPORT = 'sse'
    delete process.env.FICT_MCP_ENABLE_SSE

    await expect(runCli([])).rejects.toThrow(/FICT_MCP_ENABLE_SSE=1/)
  })
})
