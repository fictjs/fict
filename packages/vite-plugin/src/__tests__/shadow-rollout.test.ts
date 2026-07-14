import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  CompilerShadowRecorder,
  validateCompilerShadowAllowlist,
  type CompilerShadowBackendSnapshot,
} from '../shadow-rollout'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true })),
  )
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fict-shadow-'))
  temporaryDirectories.push(directory)
  return directory
}

function snapshot(
  overrides: Partial<CompilerShadowBackendSnapshot> = {},
): CompilerShadowBackendSnapshot {
  return {
    status: 'success',
    code: 'export const value = 1\n',
    diagnostics: [],
    metadata: { version: 1, exports: {} },
    semanticEvents: [{ kind: 'source-signal', name: '$state' }],
    helpers: ['__fictUseSignal'],
    sourceMap: {
      version: 3,
      sources: ['module.tsx'],
      sourcesContent: ['export const value = 1'],
      names: [],
      mappings: 'AAAA',
    },
    artifacts: [],
    ...overrides,
  }
}

describe('compiler shadow rollout artifacts', () => {
  it('contains only privacy-safe identities and digests', async () => {
    const root = await temporaryDirectory()
    const reportPath = path.join(root, 'artifacts', 'shadow.json')
    const source = `export const privateCustomerName = 'secret'`
    const filename = path.join(root, 'customers', 'private-project', 'module.tsx')
    const recorder = new CompilerShadowRecorder({
      root,
      compilerBuildId: 'fict-rust-test',
      compilerBuildRevision: null,
      reportPath,
    })

    recorder.record(filename, source, snapshot(), snapshot({ code: 'export const value = 2\n' }))
    const artifact = await recorder.write()
    const serialized = await readFile(reportPath, 'utf8')

    expect(artifact.summary.unexplainedDifferences).toBe(1)
    expect(artifact.schemaVersion).toBe(2)
    expect(artifact.compilerBuildRevision).toBeNull()
    expect(serialized).not.toContain(source)
    expect(serialized).not.toContain('privateCustomerName')
    expect(serialized).not.toContain(root)
    expect(serialized).not.toContain('private-project')
    expect(artifact.modules[0]?.moduleHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(artifact.modules[0]?.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('accepts reviewed structural differences but keeps semantic wildcards invalid', async () => {
    const root = await temporaryDirectory()
    const allowlistPath = path.join(root, 'allowlist.json')
    await writeFile(
      allowlistPath,
      JSON.stringify({
        version: 1,
        rules: [
          {
            id: 'native-printer-v1',
            category: 'output',
            moduleHash: '*',
            legacyDigest: '*',
            rustDigest: '*',
            reason: 'The native printer intentionally has a distinct stable output format.',
          },
        ],
      }),
    )
    const recorder = new CompilerShadowRecorder({
      root,
      compilerBuildId: 'fict-rust-test',
      compilerBuildRevision: null,
      reportPath: 'shadow.json',
      allowlistPath,
    })

    const result = recorder.record(
      path.join(root, 'module.tsx'),
      'export const value = 1',
      snapshot(),
      snapshot({ code: 'export const value = 2\n' }),
    )
    expect(result.differences).toEqual([
      expect.objectContaining({
        category: 'output',
        disposition: 'expected',
        allowlistRuleId: 'native-printer-v1',
      }),
    ])

    expect(() =>
      validateCompilerShadowAllowlist({
        version: 1,
        rules: [
          {
            id: 'unsafe-semantic-wildcard',
            category: 'metadata',
            moduleHash: '*',
            reason: 'This reason is long enough but the semantic wildcard remains unsafe.',
          },
        ],
      }),
    ).toThrow('cannot wildcard semantic category metadata')

    expect(() =>
      validateCompilerShadowAllowlist({
        version: 1,
        rules: [
          {
            id: 'unsafe-implicit-semantic-wildcard',
            category: 'diagnostics',
            reason: 'Omitting selectors would silently match every diagnostics difference.',
          },
        ],
      }),
    ).toThrow('must pin moduleHash, legacyDigest, and rustDigest')
  })
})
