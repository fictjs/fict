import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PlaygroundSessionManager } from '../src/server/session-manager'
import type { PlaygroundConfig } from '../src/server/types'

interface PreviewResult {
  server: { listen: () => Promise<void>; close: () => Promise<void> }
  previewUrl: string
}

interface SessionManagerHarness {
  startPreviewServer: (rootDir: string, config: PlaygroundConfig) => Promise<PreviewResult>
  sessions: Map<string, unknown>
}

describe('playground session creation cleanup', () => {
  let manager: PlaygroundSessionManager
  let harness: SessionManagerHarness
  let tempRoot: string
  let sessionsRoot: string

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fict-playground-create-'))
    sessionsRoot = path.join(tempRoot, 'sessions')
    manager = new PlaygroundSessionManager({ workspaceRoot: tempRoot, sessionsRoot })
    harness = manager as unknown as SessionManagerHarness
  })

  afterEach(async () => {
    await manager.disposeAll()
    await fs.rm(tempRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('removes every partially written directory after path validation fails', async () => {
    const startPreview = vi.spyOn(harness, 'startPreviewServer')

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        manager.createSession({
          templateId: 'counter',
          files: { '../escape.ts': `export const attempt = ${attempt}` },
        }),
      ).rejects.toThrow('Path traversal is not allowed')
    }

    expect(startPreview).not.toHaveBeenCalled()
    expect(harness.sessions.size).toBe(0)
    expect(manager.countSessionsForTenant('system')).toBe(0)
    expect(await fs.readdir(sessionsRoot)).toEqual([])
  })

  it('removes written files when preview startup fails', async () => {
    const error = new Error('preview failed')
    vi.spyOn(harness, 'startPreviewServer').mockRejectedValue(error)

    await expect(manager.createSession({ templateId: 'counter' })).rejects.toBe(error)

    expect(harness.sessions.size).toBe(0)
    expect(await fs.readdir(sessionsRoot)).toEqual([])
  })

  it('closes an acquired preview and unregisters a session after late initialization failure', async () => {
    const preview: PreviewResult = {
      server: { listen: async () => {}, close: vi.fn(async () => {}) },
      previewUrl: 'http://127.0.0.1/preview/',
    }
    vi.spyOn(harness, 'startPreviewServer').mockResolvedValue(preview)
    const error = new Error('initial state read failed')
    vi.spyOn(fs, 'readdir').mockRejectedValueOnce(error)

    await expect(manager.createSession({ templateId: 'counter' })).rejects.toBe(error)

    expect(preview.server.close).toHaveBeenCalledOnce()
    expect(harness.sessions.size).toBe(0)
    expect(await fs.readdir(sessionsRoot)).toEqual([])
  })
})
