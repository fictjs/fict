import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PlaygroundSessionManager } from '../src/server/session-manager'
import type { PlaygroundConfig, PlaygroundSessionSnapshot } from '../src/server/types'

interface PreviewServerHarness {
  startPreviewServer: (
    rootDir: string,
    config: PlaygroundConfig,
  ) => Promise<{
    server: {
      listen: () => Promise<void>
      close: () => Promise<void>
    }
    previewUrl: string
  }>
}

type PreviewResult = Awaited<ReturnType<PreviewServerHarness['startPreviewServer']>>

describe('playground session config profiles', () => {
  let manager: PlaygroundSessionManager
  let tempRoot: string

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fict-playground-config-'))
    manager = new PlaygroundSessionManager({
      workspaceRoot: tempRoot,
      sessionsRoot: path.join(tempRoot, 'sessions'),
    })

    let previewId = 0
    vi.spyOn(manager as unknown as PreviewServerHarness, 'startPreviewServer').mockImplementation(
      async () => ({
        server: {
          listen: async () => {},
          close: async () => {},
        },
        previewUrl: `http://127.0.0.1:${++previewId}/`,
      }),
    )
  })

  afterEach(async () => {
    await manager.disposeAll()
    await fs.rm(tempRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('re-resolves defaults from the selected profile and switches back cleanly', async () => {
    const created = await manager.createSession({ templateId: 'counter' })
    expect(created.config).toMatchObject({
      profile: 'app-default',
      strictGuarantee: true,
      strictReactivity: false,
      functionSplitting: false,
    })

    const ci = await manager.updateSessionConfig(created.id, { profile: 'ci-hard-gate' })
    expect(ci.config).toMatchObject({
      profile: 'ci-hard-gate',
      strictGuarantee: true,
      strictReactivity: true,
      functionSplitting: true,
    })

    const migration = await manager.updateSessionConfig(created.id, { profile: 'migration' })
    expect(migration.config).toMatchObject({
      profile: 'migration',
      strictGuarantee: false,
      strictReactivity: false,
      functionSplitting: false,
    })

    const restored = await manager.updateSessionConfig(created.id, { profile: 'app-default' })
    expect(restored.config).toEqual(created.config)
  })

  it('keeps explicit overrides, including values equal to the current profile default', async () => {
    const created = await manager.createSession({
      templateId: 'counter',
      config: { strictGuarantee: false },
    })

    await manager.updateSessionConfig(created.id, { strictReactivity: false })
    const ci = await manager.updateSessionConfig(created.id, { profile: 'ci-hard-gate' })
    expect(ci.config).toMatchObject({
      strictGuarantee: false,
      strictReactivity: false,
      functionSplitting: true,
    })

    await manager.updateSessionConfig(created.id, { functionSplitting: true })
    const migration = await manager.updateSessionConfig(created.id, { profile: 'migration' })
    expect(migration.config).toMatchObject({
      strictGuarantee: false,
      strictReactivity: false,
      functionSplitting: true,
    })

    const restored = await manager.updateSessionConfig(created.id, { profile: 'app-default' })
    expect(restored.config).toMatchObject({
      strictGuarantee: false,
      strictReactivity: false,
      functionSplitting: true,
    })
  })

  it('retains template recommendations without carrying profile-derived values forward', async () => {
    const created = await manager.createSession({ templateId: 'resumable-lab' })
    const migration = await manager.updateSessionConfig(created.id, { profile: 'migration' })

    expect(migration.config).toMatchObject({
      profile: 'migration',
      strictGuarantee: false,
      strictReactivity: false,
      resumable: true,
      functionSplitting: true,
    })
  })

  it('ignores undefined fields without mutating caller-owned patches', async () => {
    const initialConfig = {
      profile: 'app-default' as const,
      strictReactivity: undefined,
    }
    const created = await manager.createSession({
      templateId: 'counter',
      config: initialConfig as unknown as Partial<PlaygroundConfig>,
    })
    expect(created.config.strictReactivity).toBe(false)
    expect(initialConfig).toEqual({
      profile: 'app-default',
      strictReactivity: undefined,
    })

    const patch = {
      profile: 'ci-hard-gate' as const,
      functionSplitting: undefined,
    }
    const updated = await manager.updateSessionConfig(
      created.id,
      patch as unknown as Partial<PlaygroundConfig>,
    )

    expect(updated.config.strictReactivity).toBe(true)
    expect(updated.config.functionSplitting).toBe(true)
    expect(patch).toEqual({
      profile: 'ci-hard-gate',
      functionSplitting: undefined,
    })
  })

  it('does not expose the internal effective config to caller mutation', async () => {
    const created = await manager.createSession({ templateId: 'counter' })
    created.config.strictGuarantee = false

    const unchanged = await manager.getSessionState(created.id)
    expect(unchanged.config.strictGuarantee).toBe(true)

    const updated = await manager.updateSessionConfig(created.id, {
      profile: 'ci-hard-gate',
    })
    updated.config.functionSplitting = false

    const persisted = await manager.getSessionState(created.id)
    expect(persisted.config.functionSplitting).toBe(true)
  })

  it('closes a replacement preview when the previous server fails to close', async () => {
    const closeError = new Error('previous preview close failed')
    const previousClose = vi.fn().mockRejectedValueOnce(closeError).mockResolvedValue(undefined)
    const replacementClose = vi.fn(async () => {})
    const previewHarness = manager as unknown as PreviewServerHarness
    vi.mocked(previewHarness.startPreviewServer)
      .mockReset()
      .mockResolvedValueOnce({
        server: { listen: async () => {}, close: previousClose },
        previewUrl: 'http://127.0.0.1/initial/',
      })
      .mockResolvedValueOnce({
        server: { listen: async () => {}, close: replacementClose },
        previewUrl: 'http://127.0.0.1/replacement/',
      })

    const created = await manager.createSession({ templateId: 'counter' })
    await expect(manager.updateSessionConfig(created.id, { profile: 'ci-hard-gate' })).rejects.toBe(
      closeError,
    )

    expect(previousClose).toHaveBeenCalledTimes(1)
    expect(replacementClose).toHaveBeenCalledTimes(1)
    const unchanged = await manager.getSessionState(created.id)
    expect(unchanged.previewUrl).toBe('http://127.0.0.1/initial/')
    expect(unchanged.config.profile).toBe('app-default')
  })

  it('preserves override provenance across snapshot import', async () => {
    const created = await manager.createSession({ templateId: 'counter' })
    await manager.updateSessionConfig(created.id, { strictReactivity: false })

    const snapshot = await manager.snapshot(created.id)
    expect(snapshot.configOverrides).toEqual({ strictReactivity: false })

    const imported = await manager.importSnapshot(snapshot)
    const switched = await manager.updateSessionConfig(imported.id, {
      profile: 'ci-hard-gate',
    })
    expect(switched.config).toMatchObject({
      profile: 'ci-hard-gate',
      strictReactivity: false,
      functionSplitting: true,
    })
  })

  it('serializes snapshots after an in-flight config update', async () => {
    const created = await manager.createSession({ templateId: 'counter' })
    const previewGate = createDeferred<PreviewResult>()
    const previewHarness = manager as unknown as PreviewServerHarness
    vi.mocked(previewHarness.startPreviewServer).mockImplementationOnce(() => previewGate.promise)

    const updatePromise = manager.updateSessionConfig(created.id, {
      profile: 'ci-hard-gate',
    })
    await vi.waitFor(() => {
      expect(previewHarness.startPreviewServer).toHaveBeenCalledTimes(2)
    })

    let snapshotSettled = false
    const snapshotPromise = manager.snapshot(created.id).then(snapshot => {
      snapshotSettled = true
      return snapshot
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(snapshotSettled).toBe(false)

    previewGate.resolve(createPreviewResult('updated'))
    await updatePromise
    const snapshot = await snapshotPromise
    expect(snapshot.config).toMatchObject({
      profile: 'ci-hard-gate',
      strictReactivity: true,
      functionSplitting: true,
    })
    expect(snapshot.configOverrides).toEqual({ profile: 'ci-hard-gate' })
  })

  it('infers overrides for legacy snapshots without carrying old profile defaults', async () => {
    const imported = await manager.importSnapshot({
      version: 1,
      templateId: 'counter',
      entryFile: 'src/App.tsx',
      config: {
        profile: 'app-default',
        strictGuarantee: false,
        strictReactivity: false,
        lazyConditional: true,
        resumable: false,
        functionSplitting: false,
        devtools: false,
      },
      files: {},
    })

    const switched = await manager.updateSessionConfig(imported.id, {
      profile: 'ci-hard-gate',
    })
    expect(switched.config).toMatchObject({
      profile: 'ci-hard-gate',
      strictGuarantee: false,
      strictReactivity: true,
      functionSplitting: true,
    })
  })

  it('fails safe when direct imports contain malformed override metadata', async () => {
    const malformedSnapshot = {
      version: 1,
      templateId: 'counter',
      entryFile: 'src/App.tsx',
      config: {
        profile: 'app-default',
        strictGuarantee: true,
        strictReactivity: false,
        lazyConditional: true,
        resumable: false,
        functionSplitting: false,
        devtools: false,
      },
      configOverrides: {
        profile: 'migration',
        strictReactivity: 'invalid',
        unknownOption: true,
      },
      files: {},
    } as unknown as PlaygroundSessionSnapshot

    const imported = await manager.importSnapshot(malformedSnapshot)
    expect(imported.config).toEqual(malformedSnapshot.config)

    const normalized = await manager.snapshot(imported.id)
    expect(normalized.configOverrides).toEqual({ profile: 'app-default' })

    const switched = await manager.updateSessionConfig(imported.id, {
      profile: 'ci-hard-gate',
    })
    expect(switched.config).toMatchObject({
      profile: 'ci-hard-gate',
      strictGuarantee: true,
      strictReactivity: true,
      functionSplitting: true,
    })
  })
})

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createPreviewResult(id: string): PreviewResult {
  return {
    server: {
      listen: async () => {},
      close: async () => {},
    },
    previewUrl: `http://127.0.0.1/${id}/`,
  }
}
