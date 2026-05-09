import { Buffer } from 'node:buffer'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { encodeSessionSnapshot } from '../playground/share'
import { listPlaygroundTemplates } from '../playground/templates'
import type {
  PlaygroundConfig,
  PlaygroundConfigPatch,
  PlaygroundProfile,
  PlaygroundSessionSnapshot,
} from '../playground/types'

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

function applyConfigPatch(
  base: PlaygroundConfig,
  patch: PlaygroundConfigPatch | undefined,
): PlaygroundConfig {
  if (!patch) return base

  const next: PlaygroundConfig = {
    ...base,
  }

  if (typeof patch.strictGuarantee === 'boolean') {
    next.strictGuarantee = patch.strictGuarantee
  }
  if (typeof patch.strictReactivity === 'boolean') {
    next.strictReactivity = patch.strictReactivity
  }
  if (typeof patch.lazyConditional === 'boolean') {
    next.lazyConditional = patch.lazyConditional
  }
  if (typeof patch.resumable === 'boolean') {
    next.resumable = patch.resumable
  }
  if (typeof patch.functionSplitting === 'boolean') {
    next.functionSplitting = patch.functionSplitting
  }
  if (typeof patch.devtools === 'boolean') {
    next.devtools = patch.devtools
  }

  return next
}

export function registerPlaygroundLinkTool(
  server: McpServer,
  options: RegisterPlaygroundLinkToolOptions = {},
): void {
  server.registerTool(
    'list-playground-templates',
    {
      title: 'List Fict Playground templates',
      description: 'List available playground templates that can be used by playground-link.',
      outputSchema: {
        templates: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            description: z.string(),
            entryFile: z.string(),
          }),
        ),
      },
    },
    async () => {
      const templates = listPlaygroundTemplates().map(template => ({
        id: template.id,
        name: template.name,
        description: template.description,
        entryFile: template.entryFile,
      }))

      const output = {
        templates,
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      }
    },
  )

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
        url: z.string().optional(),
        token: z.string().optional(),
        size: z
          .object({
            rawBytes: z.number(),
            tokenChars: z.number(),
          })
          .optional(),
        error: z.string().optional(),
        available: z
          .array(
            z.object({
              id: z.string(),
              name: z.string(),
            }),
          )
          .optional(),
      },
    },
    async ({ templateId, entryFile, profile, files, config }) => {
      const templates = listPlaygroundTemplates()
      const selectedTemplate = templates.find(template => template.id === (templateId ?? 'counter'))

      if (!selectedTemplate) {
        const output = {
          error: `Unknown templateId: ${templateId ?? 'counter'}`,
          available: templates.map(template => ({
            id: template.id,
            name: template.name,
          })),
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
          isError: true,
        }
      }

      const selectedProfile: PlaygroundProfile = profile ?? 'app-default'
      const baseConfig: PlaygroundConfig = {
        ...profileDefaults[selectedProfile],
        profile: selectedProfile,
      }
      const templateConfigPatched = applyConfigPatch(baseConfig, selectedTemplate.recommendedConfig)
      const mergedConfig = applyConfigPatch(templateConfigPatched, config)

      const mergedFiles: Record<string, string> = {
        ...selectedTemplate.files,
        ...(files ?? {}),
      }

      const resolvedEntryFile = entryFile ?? selectedTemplate.entryFile ?? 'src/App.tsx'
      if (!(resolvedEntryFile in mergedFiles)) {
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
