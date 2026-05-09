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

export interface PlaygroundConfigPatch {
  profile?: PlaygroundProfile | undefined
  strictGuarantee?: boolean | undefined
  strictReactivity?: boolean | undefined
  lazyConditional?: boolean | undefined
  resumable?: boolean | undefined
  functionSplitting?: boolean | undefined
  devtools?: boolean | undefined
}

export interface PlaygroundTemplate {
  id: string
  name: string
  description: string
  entryFile: string
  files: Record<string, string>
  recommendedConfig?: PlaygroundConfigPatch
}

export interface PlaygroundSessionSnapshot {
  version: 1
  templateId: string
  entryFile: string
  config: PlaygroundConfig
  files: Record<string, string>
}
