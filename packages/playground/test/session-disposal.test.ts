import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PlaygroundSessionManager } from '../src/server/session-manager'
import type {
  PlaygroundAuthContext,
  PlaygroundBuildVerification,
  PlaygroundConfig,
} from '../src/server/types'

vi.mock('../src/server/diagnostics', () => ({
  collectSessionDiagnostics: vi.fn(async () => ({
    diagnostics: [],
    artifacts: [],
    summary: { errorCount: 0, warningCount: 0, infoCount: 0 },
  })),
}))

interface PreviewServer {
  listen: () => Promise<void>
  close: () => Promise<void>
}

interface PreviewResult {
  server: PreviewServer
  previewUrl: string
}

interface SessionManagerHarness {
  startPreviewServer: (rootDir: string, config: PlaygroundConfig) => Promise<PreviewResult>
  runBuildVerification: (
    sessionId: string,
    rootDir: string,
    config: PlaygroundConfig,
  ) => Promise<PlaygroundBuildVerification>
  sessions: Map<string, unknown>
  sessionQueueTails: Map<string, Promise<void>>
}

describe('playground session disposal queue', () => {
  let manager: PlaygroundSessionManager
  let harness: SessionManagerHarness
  let tempRoot: string
  let releaseGates: (() => void)[]

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fict-playground-disposal-'))
    manager = new PlaygroundSessionManager({
      workspaceRoot: tempRoot,
      sessionsRoot: path.join(tempRoot, 'sessions'),
      verifyTimeoutMs: 10,
    })
    harness = manager as unknown as SessionManagerHarness
    releaseGates = []
  })

  afterEach(async () => {
    for (const release of releaseGates) release()
    await manager.disposeAll()
    await fs.rm(tempRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('waits for an in-flight config swap and closes the replacement preview', async () => {
    const owner: PlaygroundAuthContext = {
      tenantId: 'tenant-a',
      userId: 'owner',
      role: 'developer',
    }
    const otherTenant: PlaygroundAuthContext = {
      tenantId: 'tenant-b',
      userId: 'outsider',
      role: 'developer',
    }
    const initialPreview = createPreviewResult('initial')
    const replacementPreview = createPreviewResult('replacement')
    const previewGate = createDeferred<PreviewResult>()
    releaseGates.push(() => previewGate.resolve(replacementPreview))
    const startPreview = vi
      .spyOn(harness, 'startPreviewServer')
      .mockResolvedValueOnce(initialPreview)
      .mockReturnValueOnce(previewGate.promise)
    const session = await manager.createSession({ templateId: 'counter' }, owner)

    const update = manager.updateSessionConfig(session.id, { profile: 'ci-hard-gate' }, owner)
    await vi.waitFor(() => expect(startPreview).toHaveBeenCalledTimes(2))

    let disposalSettled = false
    const disposal = manager.disposeSession(session.id, owner).then(() => {
      disposalSettled = true
    })
    const repeatedDisposal = manager.disposeSession(session.id, owner)

    await expect(
      manager.updateFile(session.id, 'src/rejected.ts', 'export const rejected = true\n', owner),
    ).rejects.toThrow(`Playground session is being disposed: ${session.id}`)
    await expect(manager.disposeSession(session.id, otherTenant)).rejects.toThrow(
      'Session access denied for tenant: tenant-b',
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(disposalSettled).toBe(false)
    await expect(fs.access(session.rootDir)).resolves.toBeUndefined()

    previewGate.resolve(replacementPreview)
    await update
    await Promise.all([disposal, repeatedDisposal])

    expect(initialPreview.server.close).toHaveBeenCalledOnce()
    expect(replacementPreview.server.close).toHaveBeenCalledOnce()
    await expectDisposed(harness, manager, session.id, session.rootDir)
  })

  it('waits for timed-out verification work before removing the session', async () => {
    const preview = createPreviewResult('verification')
    vi.spyOn(harness, 'startPreviewServer').mockResolvedValue(preview)
    const buildGate = createDeferred<PlaygroundBuildVerification>()
    const completedBuild: PlaygroundBuildVerification = {
      success: true,
      durationMs: 50,
      outputFiles: [],
      warnings: [],
      errors: [],
    }
    releaseGates.push(() => buildGate.resolve(completedBuild))
    vi.spyOn(harness, 'runBuildVerification').mockReturnValue(buildGate.promise)
    const session = await manager.createSession({ templateId: 'counter' })

    await expect(manager.runVerification(session.id)).rejects.toThrow(
      'Verification timed out after 10ms',
    )

    let disposalSettled = false
    const disposal = manager.disposeSession(session.id).then(() => {
      disposalSettled = true
    })
    await expect(manager.runDiagnostics(session.id)).rejects.toThrow(
      `Playground session is being disposed: ${session.id}`,
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(disposalSettled).toBe(false)
    await expect(fs.access(session.rootDir)).resolves.toBeUndefined()

    buildGate.resolve(completedBuild)
    await disposal

    expect(preview.server.close).toHaveBeenCalledOnce()
    await expectDisposed(harness, manager, session.id, session.rootDir)
  })

  it('makes disposeAll wait for an accepted file write and rejects later tasks', async () => {
    const preview = createPreviewResult('file-write')
    vi.spyOn(harness, 'startPreviewServer').mockResolvedValue(preview)
    const session = await manager.createSession({ templateId: 'counter' })
    const writeGate = createDeferred<void>()
    releaseGates.push(() => writeGate.resolve())
    const originalWriteFile = fs.writeFile.bind(fs)
    const writeFile = vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
      await writeGate.promise
      return originalWriteFile(...args)
    })

    const update = manager.updateFile(
      session.id,
      'src/accepted.ts',
      'export const accepted = true\n',
    )
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledOnce())

    let disposeAllSettled = false
    const disposal = manager.disposeAll().then(() => {
      disposeAllSettled = true
    })
    await expect(manager.snapshot(session.id)).rejects.toThrow(
      `Playground session is being disposed: ${session.id}`,
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(disposeAllSettled).toBe(false)

    writeGate.resolve()
    await update
    await disposal

    expect(preview.server.close).toHaveBeenCalledOnce()
    await expectDisposed(harness, manager, session.id, session.rootDir)
  })
})

function createPreviewResult(label: string): PreviewResult {
  return {
    server: {
      listen: async () => {},
      close: vi.fn(async () => {}),
    },
    previewUrl: `http://127.0.0.1/${label}/`,
  }
}

async function expectDisposed(
  harness: SessionManagerHarness,
  manager: PlaygroundSessionManager,
  sessionId: string,
  rootDir: string,
): Promise<void> {
  expect(harness.sessions.has(sessionId)).toBe(false)
  expect(harness.sessionQueueTails.has(sessionId)).toBe(false)
  await expect(fs.access(rootDir)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(manager.getSessionState(sessionId)).rejects.toThrow(
    `Unknown playground session: ${sessionId}`,
  )
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
