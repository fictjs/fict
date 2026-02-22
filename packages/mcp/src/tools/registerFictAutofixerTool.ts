import { Buffer } from 'node:buffer'

import { transformAsync } from '@babel/core'
import { createFictPlugin, type CompilerWarning, type FictCompilerOptions } from '@fictjs/compiler'
import fictEslintPlugin from '@fictjs/eslint-plugin'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ESLint, type Linter } from 'eslint'
import ts from 'typescript'
import { z } from 'zod'

type AutofixerProfile = 'app-default' | 'ci-hard-gate' | 'migration'
type IssueSeverity = 'error' | 'warning' | 'info' | 'hint'

interface Issue {
  source: 'compiler' | 'eslint' | 'typescript'
  code: string
  severity: IssueSeverity
  message: string
  file: string
  suggestion?: string
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
const MAX_INPUT_BYTES = 512 * 1024

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

const COMPILER_SUGGESTIONS: Record<string, string> = {
  'FICT-J002': 'Add a stable key to elements returned from map(), for example key={item.id}.',
  'FICT-C003': 'Move nested component definitions to module scope to preserve stable identity.',
  'FICT-C004': 'Ensure the component returns JSX (or null) on all code paths.',
  'FICT-E001':
    'Add reactive reads inside $effect or move mount-only logic outside reactive effect.',
  'FICT-M003': 'Keep $memo functions pure; move side effects into $effect.',
  'FICT-R003':
    'Avoid control-flow-dependent reactive declarations; hoist reactive values and branch on plain values.',
  'FICT-R004':
    'Do not create reactive primitives inside loops/conditionals; declare them at component top scope.',
}

const ESLINT_SUGGESTIONS: Record<string, string> = {
  'fict/require-list-key': 'Add key={...} for each mapped JSX element using a stable id.',
  'fict/no-nested-components':
    'Define child components at module scope instead of inside another component.',
  'fict/no-state-in-loop': 'Move $state initialization out of loops and conditionals.',
  'fict/no-state-outside-component':
    'Use $state inside a component or dedicated reactive module context.',
  'fict/no-empty-effect': 'Make $effect observe reactive values or remove it.',
  'fict/no-inline-functions':
    'Extract inline callbacks into stable functions when used in hot render paths.',
  'fict/no-direct-mutation':
    'Prefer immutable updates or explicit setter patterns instead of deep direct mutation.',
}

const TYPESCRIPT_SUGGESTIONS: Record<string, string> = {
  TS1005:
    'Fix the syntax near the reported token (missing punctuation like ",", ":", ";", or brackets).',
  TS1109: 'Provide a valid expression at the highlighted position.',
  TS1128: 'Remove unexpected declarations/statements and restore valid top-level syntax.',
  TS1136: 'Fix malformed object literal/property syntax.',
}

function suggestionForIssue(
  source: Issue['source'],
  code: string,
  message: string,
): string | undefined {
  if (source === 'compiler') {
    return (
      COMPILER_SUGGESTIONS[code] ??
      'Follow the related diagnostic-codes documentation and apply the recommended rewrite.'
    )
  }

  if (source === 'eslint') {
    return (
      ESLINT_SUGGESTIONS[code] ??
      'Apply the eslint rule guidance and refactor to satisfy the flagged pattern.'
    )
  }

  const fromCode = TYPESCRIPT_SUGGESTIONS[code]
  if (fromCode) return fromCode

  if (message.includes('Cannot find module')) {
    return 'Check import path spelling and project/module resolution configuration.'
  }
  if (message.includes('is not assignable to type')) {
    return 'Align the value type with the target type or add explicit type narrowing/conversion.'
  }

  return 'Fix the TypeScript diagnostic at the reported location, then rerun fict-autofixer.'
}

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

const ESLINT_RULE_LEVELS: Linter.RulesRecord = {
  'fict/no-state-in-loop': 'error',
  'fict/no-direct-mutation': 'warn',
  'fict/no-empty-effect': 'warn',
  'fict/no-computed-props-key': 'warn',
  'fict/no-inline-functions': 'warn',
  'fict/no-state-destructure-write': 'error',
  'fict/no-state-outside-component': 'error',
  'fict/no-nested-components': 'error',
  'fict/no-third-party-props-spread': 'warn',
  'fict/no-unsafe-props-spread': 'warn',
  'fict/no-unsupported-props-destructure': 'warn',
  'fict/require-list-key': 'error',
  'fict/no-memo-side-effects': 'warn',
  'fict/require-component-return': 'warn',
}

function createFictEslint(): ESLint {
  return new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}'],
        languageOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          parserOptions: {
            ecmaFeatures: {
              jsx: true,
            },
          },
        },
        plugins: {
          fict: fictEslintPlugin,
        },
        rules: ESLINT_RULE_LEVELS,
      },
    ],
  })
}

function mapEslintSeverity(severity: number): IssueSeverity {
  if (severity >= 2) return 'error'
  if (severity === 1) return 'warning'
  return 'info'
}

function mapTypeScriptSeverity(category: ts.DiagnosticCategory): IssueSeverity {
  if (category === ts.DiagnosticCategory.Error) return 'error'
  if (category === ts.DiagnosticCategory.Warning) return 'warning'
  return 'info'
}

function isTypeScriptFile(filePath: string): boolean {
  return /\.(tsx?|mts|cts)$/i.test(filePath)
}

async function toLintableCode(filePath: string, sourceCode: string): Promise<string> {
  if (!isTypeScriptFile(filePath)) {
    return sourceCode
  }

  const result = await transformAsync(sourceCode, {
    filename: filePath,
    babelrc: false,
    configFile: false,
    sourceMaps: false,
    ast: false,
    code: true,
    parserOpts: {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    },
    presets: [
      [
        '@babel/preset-typescript',
        {
          isTSX: /\.tsx$/i.test(filePath),
          allExtensions: true,
        },
      ],
    ],
    plugins: [['@babel/plugin-syntax-jsx', {}]],
  })

  return result?.code ?? sourceCode
}

async function collectCompilerIssues(
  files: Record<string, string>,
  profile: AutofixerProfile,
): Promise<Issue[]> {
  const issues: Issue[] = []

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
            '@babel/preset-typescript',
            {
              isTSX: /\.(tsx|jsx)$/i.test(filePath),
              allExtensions: true,
            },
          ],
        ],
        plugins: [
          ['@babel/plugin-syntax-jsx', {}],
          [createFictPlugin, pluginOptions],
        ],
      })
    } catch (error) {
      issues.push({
        source: 'compiler',
        code: 'FICT-COMPILER-CRASH',
        severity: 'error',
        message: error instanceof Error ? error.message : String(error),
        file: filePath,
        suggestion:
          'Check syntax/imports first, then rerun. If it persists, isolate a minimal repro for compiler bug reporting.',
      })
      continue
    }

    for (const warning of warnings) {
      const issue: Issue = {
        source: 'compiler',
        code: warning.code,
        severity: warningSeverity(warning.code, profile),
        message: warning.message,
        file: warning.fileName || filePath,
        doc_refs: ['diagnostic-codes'],
        suggestion: suggestionForIssue('compiler', warning.code, warning.message),
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

  return issues
}

async function collectEslintIssues(files: Record<string, string>): Promise<Issue[]> {
  const issues: Issue[] = []
  const eslint = createFictEslint()

  for (const [filePath, sourceCode] of Object.entries(files)) {
    let lintableCode = sourceCode
    try {
      lintableCode = await toLintableCode(filePath, sourceCode)
    } catch (error) {
      issues.push({
        source: 'eslint',
        code: 'FICT-ESLINT-TRANSPILE',
        severity: 'error',
        message: error instanceof Error ? error.message : String(error),
        file: filePath,
        suggestion:
          'Simplify or fix TypeScript syntax in this file first so ESLint can parse transformed code.',
      })
      continue
    }

    let results
    try {
      results = await eslint.lintText(lintableCode, {
        filePath,
      })
    } catch (error) {
      issues.push({
        source: 'eslint',
        code: 'FICT-ESLINT-RUN',
        severity: 'error',
        message: error instanceof Error ? error.message : String(error),
        file: filePath,
        suggestion: 'Check ESLint plugin/config compatibility and retry.',
      })
      continue
    }

    const firstResult = results[0]
    if (!firstResult) continue

    for (const message of firstResult.messages) {
      const issue: Issue = {
        source: 'eslint',
        code: message.ruleId ?? 'ESLINT',
        severity: mapEslintSeverity(message.severity),
        message: message.message,
        file: filePath,
        doc_refs: ['eslint-rules'],
        suggestion: suggestionForIssue('eslint', message.ruleId ?? 'ESLINT', message.message),
      }

      if (message.line > 0 && message.column > 0) {
        issue.range = {
          start: {
            line: message.line,
            col: message.column,
          },
        }

        if (typeof message.endLine === 'number' && typeof message.endColumn === 'number') {
          issue.range.end = {
            line: message.endLine,
            col: message.endColumn,
          }
        }
      }

      issues.push(issue)
    }
  }

  return issues
}

function diagnosticMessage(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
}

function diagnosticRange(diagnostic: ts.Diagnostic): Issue['range'] {
  if (!diagnostic.file || typeof diagnostic.start !== 'number') {
    return undefined
  }

  const start = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
  const range: NonNullable<Issue['range']> = {
    start: {
      line: start.line + 1,
      col: start.character + 1,
    },
  }

  if (typeof diagnostic.length === 'number') {
    const end = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start + diagnostic.length)
    range.end = {
      line: end.line + 1,
      col: end.character + 1,
    }
  }

  return range
}

async function collectTypeScriptIssues(files: Record<string, string>): Promise<Issue[]> {
  const issues: Issue[] = []

  for (const [filePath, sourceCode] of Object.entries(files)) {
    const result = ts.transpileModule(sourceCode, {
      fileName: filePath,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.Preserve,
        strict: true,
      },
      transformers: undefined,
      jsDocParsingMode: ts.JSDocParsingMode.ParseForTypeErrors,
    })

    for (const diagnostic of result.diagnostics ?? []) {
      const issue: Issue = {
        source: 'typescript',
        code: `TS${diagnostic.code}`,
        severity: mapTypeScriptSeverity(diagnostic.category),
        message: diagnosticMessage(diagnostic),
        file: diagnostic.file?.fileName ?? filePath,
        suggestion: suggestionForIssue(
          'typescript',
          `TS${diagnostic.code}`,
          diagnosticMessage(diagnostic),
        ),
      }

      const range = diagnosticRange(diagnostic)
      if (range) {
        issue.range = range
      }

      issues.push(issue)
    }
  }

  return issues
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

function normalizePathForLookup(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

function hasFilePath(files: Record<string, string>, targetPath: string): boolean {
  if (targetPath in files) return true
  const normalizedTarget = normalizePathForLookup(targetPath)
  return Object.keys(files).some(filePath => normalizePathForLookup(filePath) === normalizedTarget)
}

const ISSUE_SEVERITY_RANK: Record<IssueSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
}

function issueSortTuple(issue: Issue): [number, string, number, number, string, string, string] {
  return [
    ISSUE_SEVERITY_RANK[issue.severity],
    issue.file,
    issue.range?.start.line ?? Number.POSITIVE_INFINITY,
    issue.range?.start.col ?? Number.POSITIVE_INFINITY,
    issue.source,
    issue.code,
    issue.message,
  ]
}

function compareIssues(left: Issue, right: Issue): number {
  const leftTuple = issueSortTuple(left)
  const rightTuple = issueSortTuple(right)
  for (let i = 0; i < leftTuple.length; i += 1) {
    const leftValue = leftTuple[i]!
    const rightValue = rightTuple[i]!
    if (leftValue < rightValue) return -1
    if (leftValue > rightValue) return 1
  }
  return 0
}

function issueDedupeKey(issue: Issue): string {
  const startLine = issue.range?.start.line ?? 0
  const startCol = issue.range?.start.col ?? 0
  const endLine = issue.range?.end?.line ?? 0
  const endCol = issue.range?.end?.col ?? 0
  return [
    issue.source,
    issue.code,
    issue.severity,
    issue.file,
    startLine,
    startCol,
    endLine,
    endCol,
    issue.message,
  ].join('|')
}

function dedupeAndSortIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>()
  const deduped: Issue[] = []
  for (const issue of issues) {
    const key = issueDedupeKey(issue)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(issue)
  }

  return deduped.sort(compareIssues)
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
        includeEslint: z
          .boolean()
          .optional()
          .describe('Whether to include ESLint diagnostics (default: true).'),
        includeTypescript: z
          .boolean()
          .optional()
          .describe('Whether to include TypeScript diagnostics (default: true).'),
      },
      outputSchema: {
        ok: z.boolean(),
        issues: z.array(
          z.object({
            source: z.enum(['compiler', 'eslint', 'typescript']),
            code: z.string(),
            severity: z.enum(['error', 'warning', 'info', 'hint']),
            message: z.string(),
            file: z.string(),
            suggestion: z.string().optional(),
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
    async ({ files, entry, profile, includeEslint, includeTypescript }) => {
      const selectedProfile: AutofixerProfile = profile ?? DEFAULT_PROFILE
      const shouldRunEslint = includeEslint ?? true
      const shouldRunTypeScript = includeTypescript ?? true
      const issues: Issue[] = []
      const totalInputBytes = totalBytes(files)

      if (totalInputBytes > MAX_INPUT_BYTES) {
        issues.push({
          source: 'compiler',
          code: 'FICT-MCP-SIZE',
          severity: 'error',
          message: `Input too large (${totalInputBytes} bytes). Max allowed: ${MAX_INPUT_BYTES} bytes.`,
          file: '(input)',
          suggestion:
            'Reduce the number of files or trim unrelated code before running fict-autofixer.',
        })
      } else if (Object.keys(files).length === 0) {
        issues.push({
          source: 'compiler',
          code: 'FICT-MCP-NOFILES',
          severity: 'error',
          message: 'No source files were provided.',
          file: '(input)',
          suggestion: 'Provide at least one source file, e.g. {"src/App.tsx":"..."}',
        })
      } else if (entry && !hasFilePath(files, entry)) {
        issues.push({
          source: 'compiler',
          code: 'FICT-MCP-ENTRY',
          severity: 'error',
          message: `entry file "${entry}" was not found in files input.`,
          file: '(input)',
          suggestion:
            'Pass an entry path that exists in files, or omit entry to analyze the provided map directly.',
        })
      } else {
        const compilerIssues = await collectCompilerIssues(files, selectedProfile)
        issues.push(...compilerIssues)

        if (shouldRunTypeScript) {
          try {
            const typeScriptIssues = await collectTypeScriptIssues(files)
            issues.push(...typeScriptIssues)
          } catch (error) {
            issues.push({
              source: 'typescript',
              code: 'FICT-TS-SETUP',
              severity: 'error',
              message: error instanceof Error ? error.message : String(error),
              file: '(input)',
              suggestion:
                'Verify TypeScript dependency/config setup, or rerun with includeTypescript=false.',
            })
          }
        }

        if (shouldRunEslint) {
          try {
            const eslintIssues = await collectEslintIssues(files)
            issues.push(...eslintIssues)
          } catch (error) {
            issues.push({
              source: 'eslint',
              code: 'FICT-ESLINT-SETUP',
              severity: 'error',
              message: error instanceof Error ? error.message : String(error),
              file: '(input)',
              suggestion:
                'Verify ESLint dependency/config setup, or rerun with includeEslint=false.',
            })
          }
        }
      }

      const normalizedIssues = dedupeAndSortIssues(issues)
      const summary = summarizeIssues(normalizedIssues)
      const output = {
        ok: summary.errors === 0,
        issues: normalizedIssues,
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
