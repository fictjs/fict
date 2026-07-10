import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PlaygroundSessionManager } from '../src/server/session-manager'
import type { PlaygroundBuildVerification, PlaygroundConfig } from '../src/server/types'

vi.mock('../src/server/diagnostics', () => ({
  collectSessionDiagnostics: vi.fn(async () => ({
    diagnostics: [],
    artifacts: [],
    summary: { errorCount: 0, warningCount: 0, infoCount: 0 },
  })),
}))

interface SessionManagerHarness {
  startPreviewServer: (
    rootDir: string,
    config: PlaygroundConfig,
  ) => Promise<{
    server: { listen: () => Promise<void>; close: () => Promise<void> }
    previewUrl: string
  }>
  runBuildVerification: (
    sessionId: string,
    rootDir: string,
    config: PlaygroundConfig,
  ) => Promise<PlaygroundBuildVerification>
}

describe('playground session verification queue', () => {
  let manager: PlaygroundSessionManager
  let tempRoot: string

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fict-playground-verification-'))
    manager = new PlaygroundSessionManager({
      workspaceRoot: tempRoot,
      sessionsRoot: path.join(tempRoot, 'sessions'),
      verifyTimeoutMs: 10,
    })
    const harness = manager as unknown as SessionManagerHarness
    vi.spyOn(harness, 'startPreviewServer').mockResolvedValue({
      server: { listen: async () => {}, close: async () => {} },
      previewUrl: 'http://127.0.0.1/preview/',
    })
  })

  afterEach(async () => {
    await manager.disposeAll()
    await fs.rm(tempRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('keeps later session mutations queued until timed-out work really finishes', async () => {
    const harness = manager as unknown as SessionManagerHarness
    const build = createDeferred<PlaygroundBuildVerification>()
    vi.spyOn(harness, 'runBuildVerification').mockReturnValue(build.promise)
    const session = await manager.createSession({ templateId: 'counter' })

    const verification = expect(manager.runVerification(session.id)).rejects.toThrow(
      'Verification timed out after 10ms',
    )
    await vi.waitFor(() => {
      expect(harness.runBuildVerification).toHaveBeenCalledOnce()
    })
    await verification

    let updateSettled = false
    const update = manager.updateFile(session.id, 'src/pending.ts', 'export const ready = true\n')
    void update.then(() => {
      updateSettled = true
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(updateSettled).toBe(false)

    build.resolve({
      success: true,
      durationMs: 50,
      outputFiles: [],
      warnings: [],
      errors: [],
    })
    await update

    expect((await manager.getSessionState(session.id)).files['src/pending.ts']).toContain('ready')
  })
})

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
