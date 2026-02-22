import { Buffer } from 'node:buffer'

import { transformAsync } from '@babel/core'
import syntaxJsx from '@babel/plugin-syntax-jsx'
import presetTypeScript from '@babel/preset-typescript'
import { createFictPlugin, type CompilerWarning, type FictCompilerOptions } from '@fictjs/compiler'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

type AutofixerProfile = 'app-default' | 'ci-hard-gate' | 'migration'
type IssueSeverity = 'error' | 'warning' | 'info' | 'hint'

interface Issue {
  source: 'compiler'
  code: string
  severity: IssueSeverity
  message: string
  file: string
  range?: {
    start: {
      line: number
      col: number
    }
    end?: {
      line: number
      col: number
    }
  }
  doc_refs?: string[]
}

const DEFAULT_PROFILE: AutofixerProfile = 'app-default'

const DEFAULT_ERROR_WARNING_CODES = new Set(['FICT-R004'])
const STRICT_REACTIVITY_WARNING_CODES = new Set(['FICT-R003', 'FICT-R006'])
const STRICT_GUARANTEE_WARNING_CODES = new Set([
  'FICT-P001',
  'FICT-P002',
  'FICT-P003',
  'FICT-P004',
  'FICT-P005',
  'FICT-J003',
  'FICT-S002',
  'FICT-R001',
  'FICT-R002',
  'FICT-R003',
  'FICT-R006',
])

function profileFlags(profile: AutofixerProfile): {
  strictGuarantee: boolean
  strictReactivity: boolean
} {
  if (profile === 'ci-hard-gate') {
    return {
      strictGuarantee: true,
      strictReactivity: true,
    }
  }
  if (profile === 'migration') {
    return {
      strictGuarantee: false,
      strictReactivity: false,
    }
  }
  return {
    strictGuarantee: true,
    strictReactivity: false,
  }
}

function warningSeverity(code: string, profile: AutofixerProfile): IssueSeverity {
  const flags = profileFlags(profile)

  if (flags.strictGuarantee && STRICT_GUARANTEE_WARNING_CODES.has(code)) {
    return 'error'
  }
  if (flags.strictReactivity && STRICT_REACTIVITY_WARNING_CODES.has(code)) {
    return 'error'
  }
  if (DEFAULT_ERROR_WARNING_CODES.has(code)) {
    return flags.strictGuarantee ? 'error' : 'warning'
  }
  return 'warning'
}

function totalBytes(files: Record<string, string>): number {
  let total = 0
  for (const content of Object.values(files)) {
    total += Buffer.byteLength(content, 'utf8')
  }
  return total
}

function summarizeIssues(issues: Issue[]): {
  errors: number
  warnings: number
  infos: number
  hints: number
} {
  return {
    errors: issues.filter(issue => issue.severity === 'error').length,
    warnings: issues.filter(issue => issue.severity === 'warning').length,
    infos: issues.filter(issue => issue.severity === 'info').length,
    hints: issues.filter(issue => issue.severity === 'hint').length,
  }
}

export function registerFictAutofixerTool(server: McpServer): void {
  server.registerTool(
    'fict-autofixer',
    {
      title: 'Fict Autofixer',
      description:
        'Run static analysis for Fict code using compiler diagnostics and return structured issues.',
      inputSchema: {
        files: z
          .record(z.string(), z.string())
          .describe('Map of file paths to source code. Example: {"src/App.tsx":"..."}'),
        entry: z.string().optional().describe('Optional entry file path for context only.'),
        profile: z
          .enum(['app-default', 'ci-hard-gate', 'migration'])
          .optional()
          .describe('Strictness profile. Default: app-default.'),
      },
      outputSchema: {
        ok: z.boolean(),
        issues: z.array(
          z.object({
            source: z.enum(['compiler']),
            code: z.string(),
            severity: z.enum(['error', 'warning', 'info', 'hint']),
            message: z.string(),
            file: z.string(),
            range: z
              .object({
                start: z.object({
                  line: z.number(),
                  col: z.number(),
                }),
                end: z
                  .object({
                    line: z.number(),
                    col: z.number(),
                  })
                  .optional(),
              })
              .optional(),
            doc_refs: z.array(z.string()).optional(),
          }),
        ),
        summary: z.object({
          errors: z.number(),
          warnings: z.number(),
          infos: z.number(),
          hints: z.number(),
        }),
      },
    },
    async ({ files, profile }) => {
      const selectedProfile: AutofixerProfile = profile ?? DEFAULT_PROFILE
      const issues: Issue[] = []
      const totalInputBytes = totalBytes(files)

      if (totalInputBytes > 512 * 1024) {
        issues.push({
          source: 'compiler',
          code: 'FICT-MCP-SIZE',
          severity: 'error',
          message: `Input too large (${totalInputBytes} bytes). Max allowed: 524288 bytes.`,
          file: '(input)',
        })
      } else if (Object.keys(files).length === 0) {
        issues.push({
          source: 'compiler',
          code: 'FICT-MCP-NOFILES',
          severity: 'error',
          message: 'No source files were provided.',
          file: '(input)',
        })
      } else {
        for (const [filePath, sourceCode] of Object.entries(files)) {
          const warnings: CompilerWarning[] = []

          const pluginOptions: FictCompilerOptions = {
            filename: filePath,
            dev: true,
            strictGuarantee: false,
            strictReactivity: false,
            warningsAsErrors: false,
            warningLevels: {
              'FICT-R004': 'warn',
            },
            onWarn(warning) {
              warnings.push(warning)
            },
          }

          try {
            await transformAsync(sourceCode, {
              filename: filePath,
              babelrc: false,
              configFile: false,
              sourceMaps: false,
              ast: false,
              code: false,
              parserOpts: {
                sourceType: 'module',
                plugins: ['typescript', 'jsx'],
              },
              presets: [
                [
                  presetTypeScript,
                  {
                    isTSX: /\.(tsx|jsx)$/i.test(filePath),
                    allExtensions: true,
                  },
                ],
              ],
              plugins: [syntaxJsx, [createFictPlugin, pluginOptions]],
            })
          } catch (error) {
            issues.push({
              source: 'compiler',
              code: 'FICT-COMPILER-CRASH',
              severity: 'error',
              message: error instanceof Error ? error.message : String(error),
              file: filePath,
            })
            continue
          }

          for (const warning of warnings) {
            const issue: Issue = {
              source: 'compiler',
              code: warning.code,
              severity: warningSeverity(warning.code, selectedProfile),
              message: warning.message,
              file: warning.fileName || filePath,
              doc_refs: ['diagnostic-codes'],
            }

            if (warning.line > 0) {
              issue.range = {
                start: {
                  line: warning.line,
                  col: warning.column,
                },
              }
            }

            issues.push(issue)
          }
        }
      }

      const summary = summarizeIssues(issues)
      const output = {
        ok: summary.errors === 0,
        issues,
        summary,
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
        isError: !output.ok,
      }
    },
  )
}
