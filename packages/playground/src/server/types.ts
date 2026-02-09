export type PlaygroundProfile = 'app-default' | 'ci-hard-gate' | 'migration'

export interface PlaygroundConfig {
  profile: PlaygroundProfile
  strictGuarantee: boolean
  strictReactivity: boolean
  lazyConditional: boolean
  resumable: boolean
  functionSplitting: boolean
  devtools: boolean
}

export interface PlaygroundTemplate {
  id: string
  name: string
  description: string
  entryFile: string
  files: Record<string, string>
  recommendedConfig?: Partial<Omit<PlaygroundConfig, 'profile'>> & {
    profile?: PlaygroundProfile
  }
}

export type PlaygroundDiagnosticSource = 'compiler' | 'typescript'
export type PlaygroundDiagnosticSeverity = 'error' | 'warning' | 'info'

export interface PlaygroundDiagnostic {
  source: PlaygroundDiagnosticSource
  severity: PlaygroundDiagnosticSeverity
  code: string
  message: string
  filePath?: string
  line?: number
  column?: number
}

export interface PlaygroundArtifact {
  filePath: string
  code: string
}

export interface PlaygroundDiagnosticsResult {
  diagnostics: PlaygroundDiagnostic[]
  artifacts: PlaygroundArtifact[]
  summary: {
    errorCount: number
    warningCount: number
    infoCount: number
  }
}

export interface PlaygroundBuildVerification {
  success: boolean
  durationMs: number
  outputFiles: string[]
  warnings: string[]
  errors: string[]
}

export interface PlaygroundVerificationResult {
  diagnostics: PlaygroundDiagnosticsResult
  build: PlaygroundBuildVerification
  summary: {
    passed: boolean
    durationMs: number
    diagnosticsErrorCount: number
    diagnosticsWarningCount: number
    buildErrorCount: number
    buildWarningCount: number
    totalErrorCount: number
    totalWarningCount: number
  }
}

export interface PlaygroundSessionSummary {
  id: string
  templateId: string
  rootDir: string
  previewUrl: string
  config: PlaygroundConfig
  entryFile: string
  createdAt: number
  updatedAt: number
}

export interface PlaygroundSessionSnapshot {
  version: 1
  templateId: string
  entryFile: string
  config: PlaygroundConfig
  files: Record<string, string>
}

export interface PlaygroundSessionState extends PlaygroundSessionSummary {
  files: Record<string, string>
}

export interface CreateSessionInput {
  templateId: string
  config?: Partial<PlaygroundConfig>
  files?: Record<string, string>
}

export interface PlaygroundServerOptions {
  host?: string
  port?: number
  workspaceRoot?: string
  open?: boolean
  idleTimeoutMs?: number
  maxSessions?: number
}

export interface StartedPlaygroundServer {
  host: string
  port: number
  url: string
  stop: () => Promise<void>
}
