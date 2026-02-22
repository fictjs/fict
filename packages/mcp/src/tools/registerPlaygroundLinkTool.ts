import { Buffer } from 'node:buffer'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  encodeSessionSnapshot,
  listPlaygroundTemplates,
  type PlaygroundConfig,
  type PlaygroundProfile,
  type PlaygroundSessionSnapshot,
} from '@fictjs/playground'
import { z } from 'zod'

const DEFAULT_PLAYGROUND_ORIGIN = 'http://localhost:4173'

const profileDefaults: Record<PlaygroundProfile, PlaygroundConfig> = {
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

export interface RegisterPlaygroundLinkToolOptions {
  origin?: string
}

export function registerPlaygroundLinkTool(
  server: McpServer,
  options: RegisterPlaygroundLinkToolOptions = {},
): void {
  server.registerTool(
    'playground-link',
    {
      title: 'Fict Playground Link',
      description:
        'Create a shareable Fict Playground URL from template + file overrides. Snapshot is encoded in the URL.',
      inputSchema: {
        templateId: z.string().optional().describe('Playground template id. Default: counter'),
        entryFile: z.string().optional().describe('Entry file path override.'),
        profile: z.enum(['app-default', 'ci-hard-gate', 'migration']).optional(),
        files: z
          .record(z.string(), z.string())
          .optional()
          .describe('File map overlay applied on top of the template files.'),
        config: z
          .object({
            strictGuarantee: z.boolean().optional(),
            strictReactivity: z.boolean().optional(),
            lazyConditional: z.boolean().optional(),
            resumable: z.boolean().optional(),
            functionSplitting: z.boolean().optional(),
            devtools: z.boolean().optional(),
          })
          .optional()
          .describe('Optional config overrides.'),
      },
      outputSchema: {
        url: z.string(),
        token: z.string(),
        size: z.object({
          rawBytes: z.number(),
          tokenChars: z.number(),
        }),
      },
    },
    async ({ templateId, entryFile, profile, files, config }) => {
      const templates = listPlaygroundTemplates()
      const selectedTemplate = templates.find(template => template.id === (templateId ?? 'counter'))

      if (!selectedTemplate) {
        throw new Error(`Unknown templateId: ${templateId ?? 'counter'}`)
      }

      const selectedProfile: PlaygroundProfile = profile ?? 'app-default'
      const mergedConfig: PlaygroundConfig = {
        ...profileDefaults[selectedProfile],
        ...(selectedTemplate.recommendedConfig ?? {}),
        ...(config ?? {}),
        profile: selectedProfile,
      }

      const mergedFiles: Record<string, string> = {
        ...selectedTemplate.files,
        ...(files ?? {}),
      }

      const resolvedEntryFile = entryFile ?? selectedTemplate.entryFile ?? 'src/App.tsx'
      if (!mergedFiles[resolvedEntryFile]) {
        mergedFiles[resolvedEntryFile] = mergedFiles[selectedTemplate.entryFile] ?? ''
      }

      const snapshot: PlaygroundSessionSnapshot = {
        version: 1,
        templateId: selectedTemplate.id,
        entryFile: resolvedEntryFile,
        config: mergedConfig,
        files: mergedFiles,
      }

      const token = encodeSessionSnapshot(snapshot)
      const origin =
        options.origin ?? process.env.FICT_PLAYGROUND_ORIGIN ?? DEFAULT_PLAYGROUND_ORIGIN
      const url = `${origin}/?share=${encodeURIComponent(token)}`
      const rawBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8')

      const output = {
        url,
        token,
        size: {
          rawBytes,
          tokenChars: token.length,
        },
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      }
    },
  )
}
