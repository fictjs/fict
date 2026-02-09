import { promises as fs } from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { collectSessionDiagnostics } from './diagnostics'
import { createTemplateFiles, getPlaygroundTemplate, listPlaygroundTemplates } from './templates'
import type {
  CreateSessionInput,
  PlaygroundConfig,
  PlaygroundDiagnosticsResult,
  PlaygroundSessionSnapshot,
  PlaygroundSessionState,
  PlaygroundSessionSummary,
  PlaygroundTemplate,
} from './types'
import {
  createSessionId,
  ensureDir,
  findWorkspaceRoot,
  normalizeRelativeFilePath,
  readProjectFiles,
  resolveSessionFilePath,
  toPosixPath,
  writeProjectFiles,
} from './utils'

interface SessionRecord {
  summary: PlaygroundSessionSummary
  viteServer: ViteDevServerLike
}

interface SessionManagerOptions {
  workspaceRoot?: string
  sessionsRoot?: string
  previewHost?: string
  idleTimeoutMs?: number
  maxSessions?: number
}

const DEFAULT_IDLE_TIMEOUT_MS = 1000 * 60 * 30
const DEFAULT_MAX_SESSIONS = 8

const profileDefaults: Record<PlaygroundConfig['profile'], PlaygroundConfig> = {
  'app-default': {
    profile: 'app-default',
    strictGuarantee: true,
    strictReactivity: false,
    lazyConditional: true,
    resumable: false,
    functionSplitting: false,
    devtools: false,
  },
  'ci-hard-gate': {
    profile: 'ci-hard-gate',
    strictGuarantee: true,
    strictReactivity: true,
    lazyConditional: true,
    resumable: false,
    functionSplitting: true,
    devtools: false,
  },
  migration: {
    profile: 'migration',
    strictGuarantee: false,
    strictReactivity: false,
    lazyConditional: true,
    resumable: false,
    functionSplitting: false,
    devtools: false,
  },
}

export class PlaygroundSessionManager {
  private readonly workspaceRoot: string
  private readonly sessionsRoot: string
  private readonly previewHost: string
  private readonly idleTimeoutMs: number
  private readonly maxSessions: number
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly cleanupTimer: NodeJS.Timeout

  constructor(options: SessionManagerOptions = {}) {
    this.workspaceRoot = options.workspaceRoot
      ? path.resolve(options.workspaceRoot)
      : findWorkspaceRoot(process.cwd())
    this.sessionsRoot = options.sessionsRoot
      ? path.resolve(options.sessionsRoot)
      : path.join(this.workspaceRoot, '.fict-playground', 'sessions')
    this.previewHost = options.previewHost ?? '127.0.0.1'
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS

    this.cleanupTimer = setInterval(() => {
      void this.collectStaleSessions()
    }, 60_000)
    this.cleanupTimer.unref()
  }

  get templates(): PlaygroundTemplate[] {
    return listPlaygroundTemplates()
  }

  async createSession(input: Partial<CreateSessionInput> = {}): Promise<PlaygroundSessionState> {
    const templateId = input.templateId ?? this.templates[0]?.id
    if (!templateId) {
      throw new Error('No playground templates are available')
    }

    await ensureDir(this.sessionsRoot)
    await this.enforceSessionCapacity()

    const template = getPlaygroundTemplate(templateId)
    const sessionId = createSessionId()
    const sessionRoot = path.join(this.sessionsRoot, sessionId)

    await fs.rm(sessionRoot, { recursive: true, force: true })
    await ensureDir(sessionRoot)

    const config = resolveConfig(template, input.config)
    const initialFiles = {
      ...createTemplateFiles(template.id),
      ...(input.files ?? {}),
    }

    await writeProjectFiles(sessionRoot, initialFiles)

    const preview = await this.startPreviewServer(sessionRoot, config)
    const now = Date.now()

    const summary: PlaygroundSessionSummary = {
      id: sessionId,
      templateId: template.id,
      rootDir: sessionRoot,
      previewUrl: preview.previewUrl,
      config,
      entryFile: template.entryFile,
      createdAt: now,
      updatedAt: now,
    }

    this.sessions.set(sessionId, {
      summary,
      viteServer: preview.server,
    })

    return this.getSessionState(sessionId)
  }

  async importSnapshot(snapshot: PlaygroundSessionSnapshot): Promise<PlaygroundSessionState> {
    return this.createSession({
      templateId: snapshot.templateId,
      config: snapshot.config,
      files: snapshot.files,
    })
  }

  async getSessionState(sessionId: string): Promise<PlaygroundSessionState> {
    const session = this.requireSession(sessionId)
    const files = await readProjectFiles(session.summary.rootDir)
    return {
      ...session.summary,
      files,
    }
  }

  async updateSessionConfig(
    sessionId: string,
    patch: Partial<PlaygroundConfig>,
  ): Promise<PlaygroundSessionSummary> {
    const session = this.requireSession(sessionId)
    const mergedConfig = resolveConfig(undefined, {
      ...session.summary.config,
      ...patch,
    })

    if (areConfigsEqual(session.summary.config, mergedConfig)) {
      return session.summary
    }

    const nextPreview = await this.startPreviewServer(session.summary.rootDir, mergedConfig)

    await session.viteServer.close()
    session.viteServer = nextPreview.server
    session.summary = {
      ...session.summary,
      config: mergedConfig,
      previewUrl: nextPreview.previewUrl,
      updatedAt: Date.now(),
    }

    return session.summary
  }

  async updateFile(
    sessionId: string,
    filePath: string,
    content: string,
  ): Promise<PlaygroundSessionState> {
    const session = this.requireSession(sessionId)
    const normalizedPath = normalizeRelativeFilePath(filePath)
    const absolutePath = resolveSessionFilePath(session.summary.rootDir, normalizedPath)

    await ensureDir(path.dirname(absolutePath))
    await fs.writeFile(absolutePath, content, 'utf8')

    session.summary.updatedAt = Date.now()
    return this.getSessionState(sessionId)
  }

  async deleteFile(sessionId: string, filePath: string): Promise<PlaygroundSessionState> {
    const session = this.requireSession(sessionId)
    const normalizedPath = normalizeRelativeFilePath(filePath)
    const absolutePath = resolveSessionFilePath(session.summary.rootDir, normalizedPath)

    await fs.rm(absolutePath, { force: true })

    session.summary.updatedAt = Date.now()
    return this.getSessionState(sessionId)
  }

  async runDiagnostics(sessionId: string): Promise<PlaygroundDiagnosticsResult> {
    const session = this.requireSession(sessionId)
    const diagnostics = await collectSessionDiagnostics({
      rootDir: session.summary.rootDir,
      config: session.summary.config,
    })
    session.summary.updatedAt = Date.now()
    return diagnostics
  }

  async snapshot(sessionId: string): Promise<PlaygroundSessionSnapshot> {
    const state = await this.getSessionState(sessionId)
    return {
      version: 1,
      templateId: state.templateId,
      entryFile: state.entryFile,
      config: state.config,
      files: state.files,
    }
  }

  async disposeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    this.sessions.delete(sessionId)
    await session.viteServer.close()
    await fs.rm(session.summary.rootDir, { recursive: true, force: true })
  }

  async disposeAll(): Promise<void> {
    clearInterval(this.cleanupTimer)
    const sessionIds = Array.from(this.sessions.keys())
    for (const sessionId of sessionIds) {
      await this.disposeSession(sessionId)
    }
  }

  private requireSession(sessionId: string): SessionRecord {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Unknown playground session: ${sessionId}`)
    }
    return session
  }

  private async enforceSessionCapacity(): Promise<void> {
    if (this.sessions.size < this.maxSessions) return
    const oldest = Array.from(this.sessions.values()).sort(
      (a, b) => a.summary.updatedAt - b.summary.updatedAt,
    )[0]
    if (!oldest) return
    await this.disposeSession(oldest.summary.id)
  }

  private async collectStaleSessions(): Promise<void> {
    const now = Date.now()
    const stale = Array.from(this.sessions.values()).filter(
      session => now - session.summary.updatedAt > this.idleTimeoutMs,
    )
    for (const session of stale) {
      await this.disposeSession(session.summary.id)
    }
  }

  private async startPreviewServer(
    rootDir: string,
    config: PlaygroundConfig,
  ): Promise<{ server: ViteDevServerLike; previewUrl: string }> {
    const { default: fict } = (await import('@fictjs/vite-plugin')) as {
      default: (options?: Record<string, unknown>) => unknown
    }
    const { default: fictDevTools } = (await import('@fictjs/devtools/vite')) as {
      default: (options?: Record<string, unknown>) => unknown[]
    }
    const { createServer: createViteServer } = (await import('vite')) as {
      createServer: (options: unknown) => Promise<ViteDevServerLike>
    }

    const plugins = [
      fict({
        strictGuarantee: config.strictGuarantee,
        strictReactivity: config.strictReactivity,
        lazyConditional: config.lazyConditional,
        resumable: config.resumable,
        functionSplitting: config.functionSplitting,
      }),
    ]

    if (config.devtools) {
      plugins.push(...fictDevTools({ enabled: true }))
    }

    const server = await createViteServer({
      configFile: false,
      root: rootDir,
      clearScreen: false,
      appType: 'spa',
      server: {
        host: this.previewHost,
        port: 0,
        strictPort: false,
      },
      resolve: {
        alias: this.createWorkspaceAliases(),
      },
      optimizeDeps: {
        exclude: ['fict', '@fictjs/runtime', '@fictjs/ssr', '@fictjs/devtools'],
      },
      plugins,
    })

    await server.listen()

    const previewUrl =
      server.resolvedUrls?.local?.[0] ??
      server.resolvedUrls?.network?.[0] ??
      (() => {
        const address = server.httpServer?.address()
        if (!address || typeof address === 'string') {
          throw new Error('Failed to resolve Vite preview server URL')
        }
        return `http://${this.previewHost}:${address.port}/`
      })()

    return {
      server,
      previewUrl,
    }
  }

  private createWorkspaceAliases(): AliasOptions {
    const runtimeSrc = toPosixPath(path.join(this.workspaceRoot, 'packages/runtime/src'))
    const fictSrc = toPosixPath(path.join(this.workspaceRoot, 'packages/fict/src'))
    const ssrSrc = toPosixPath(path.join(this.workspaceRoot, 'packages/ssr/src'))
    const devtoolsSrc = toPosixPath(path.join(this.workspaceRoot, 'packages/devtools/src'))

    return [
      { find: /^fict$/, replacement: `${fictSrc}/index.ts` },
      { find: /^fict\/(.+)$/, replacement: `${fictSrc}/$1.ts` },
      { find: /^@fictjs\/runtime$/, replacement: `${runtimeSrc}/index.ts` },
      { find: /^@fictjs\/runtime\/internal\/list$/, replacement: `${runtimeSrc}/internal/list.ts` },
      { find: /^@fictjs\/runtime\/internal$/, replacement: `${runtimeSrc}/internal.ts` },
      { find: /^@fictjs\/runtime\/(.+)$/, replacement: `${runtimeSrc}/$1.ts` },
      { find: /^@fictjs\/ssr$/, replacement: `${ssrSrc}/index.ts` },
      { find: /^@fictjs\/ssr\/(.+)$/, replacement: `${ssrSrc}/$1.ts` },
      { find: /^@fictjs\/devtools$/, replacement: `${devtoolsSrc}/index.ts` },
      { find: /^@fictjs\/devtools\/core$/, replacement: `${devtoolsSrc}/core/index.ts` },
      { find: /^@fictjs\/devtools\/vite$/, replacement: `${devtoolsSrc}/vite/index.ts` },
    ]
  }
}

interface AliasEntry {
  find: string | RegExp
  replacement: string
}

type AliasOptions = AliasEntry[]

interface ViteDevServerLike {
  listen: () => Promise<void>
  close: () => Promise<void>
  resolvedUrls?: {
    local?: string[]
    network?: string[]
  }
  httpServer?: {
    address: () => AddressInfo | string | null
  }
}

function resolveConfig(
  template: PlaygroundTemplate | undefined,
  patch: Partial<PlaygroundConfig> | undefined,
): PlaygroundConfig {
  const profile = patch?.profile ?? template?.recommendedConfig?.profile ?? 'app-default'
  const base = profileDefaults[profile]

  return {
    ...base,
    ...template?.recommendedConfig,
    ...patch,
    profile,
  }
}

function areConfigsEqual(left: PlaygroundConfig, right: PlaygroundConfig): boolean {
  return (
    left.profile === right.profile &&
    left.strictGuarantee === right.strictGuarantee &&
    left.strictReactivity === right.strictReactivity &&
    left.lazyConditional === right.lazyConditional &&
    left.resumable === right.resumable &&
    left.functionSplitting === right.functionSplitting &&
    left.devtools === right.devtools
  )
}
