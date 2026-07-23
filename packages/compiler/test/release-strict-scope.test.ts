import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const projectRoot = new URL('../../../', import.meta.url)

function readProjectFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, projectRoot), 'utf8')
}

function readPackage(relativePath: string): { scripts: Record<string, string> } {
  return JSON.parse(readProjectFile(relativePath)) as { scripts: Record<string, string> }
}

function workflowJob(source: string, name: string): string {
  const marker = `\n  ${name}:\n`
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`Missing workflow job: ${name}`)
  const body = source.slice(start + marker.length)
  const nextJob = body.search(/\n  [a-z0-9][a-z0-9-]*:\n/)
  return nextJob < 0 ? body : body.slice(0, nextJob)
}

describe('release strict guarantee scope', () => {
  const rootPackage = readPackage('package.json')
  const scripts = rootPackage.scripts

  it('owns strict compiler gates in explicit root scripts', () => {
    expect(scripts['test:strict-guarantee']).toBe('cargo test -p fict-compiler --lib')
    expect(scripts['build:strict-guarantee']).toBe('FICT_STRICT_GUARANTEE=1 pnpm build')
    expect(scripts['test:bundlers:strict-guarantee']).toBe(
      'FICT_STRICT_GUARANTEE=1 pnpm test:bundlers',
    )
  })

  it('keeps behavior-first test entrypoints outside strict mode', () => {
    for (const name of ['test', 'test:coverage']) {
      expect(scripts[name]).toMatch(
        /^pnpm build:compiler:native-host && env -u FICT_STRICT_GUARANTEE /,
      )
    }
    expect(scripts['test:ssr-matrix']).toMatch(/^env -u FICT_STRICT_GUARANTEE /)

    const fictPackage = readPackage('packages/fict/package.json')
    expect(fictPackage.scripts['test:e2e']).toMatch(/^env -u FICT_STRICT_GUARANTEE /)
  })

  it('composes release verification from scoped strict gates', () => {
    const releaseVerify = scripts['release:verify']
    if (!releaseVerify) throw new Error('Missing release:verify script')
    expect(releaseVerify).not.toContain('FICT_STRICT_GUARANTEE')
    expect(releaseVerify.split(' && ')).toEqual(
      expect.arrayContaining([
        'pnpm test:release-publish-plan',
        'pnpm test:release-verification',
        'pnpm test:strict-guarantee',
        'pnpm build:strict-guarantee',
        'pnpm test:package-tarballs',
        'pnpm test:bundlers:strict-guarantee',
        'pnpm test',
        'pnpm test:ssr-matrix',
        'pnpm test:e2e',
      ]),
    )
  })

  it('keeps workflow-level release and CI scope aligned with root scripts', () => {
    const releaseWorkflow = readProjectFile('.github/workflows/release.yml')
    expect(releaseWorkflow).toContain('pnpm release:verify:clean')
    expect(releaseWorkflow).toContain('NPM_VERSION: 11.18.0')
    expect(releaseWorkflow.match(/pnpm release:plan/g)).toHaveLength(2)
    expect(releaseWorkflow).toContain('--require-existing-packages')
    expect(releaseWorkflow).not.toContain('FICT_STRICT_GUARANTEE')

    const ciWorkflow = readProjectFile('.github/workflows/ci.yml')
    expect(ciWorkflow).toContain('pnpm test:release-publish-plan')
    const strictJob = workflowJob(ciWorkflow, 'strict-guarantee')
    expect(strictJob).toContain('pnpm test:strict-guarantee')
    expect(strictJob).toContain('pnpm build:strict-guarantee')
    expect(strictJob).toContain('pnpm test:bundlers:strict-guarantee')
    expect(strictJob).not.toContain('FICT_STRICT_GUARANTEE')
  })

  it('runs native host and package smoke on every audited CI architecture', () => {
    const ciWorkflow = readProjectFile('.github/workflows/ci.yml')
    const platformJob = workflowJob(ciWorkflow, 'native-platform')
    for (const [target, runner] of [
      ['win32-x64-msvc', 'windows-2025'],
      ['darwin-x64', 'macos-15-intel'],
      ['darwin-arm64', 'macos-15'],
      ['linux-arm64-gnu', 'ubuntu-24.04-arm'],
    ]) {
      expect(platformJob).toContain(`target: ${target}`)
      expect(platformJob).toContain(`runner: ${runner}`)
    }
    expect(platformJob).toContain('node-version: 24')
    expect(platformJob).toContain('pnpm test:compiler:native-host')
    expect(platformJob).toContain('node scripts/native-compiler-package-smoke.mjs')
  })

  it('keeps a pinned scheduled compiler fuzz campaign with crash artifacts', () => {
    const ciWorkflow = readProjectFile('.github/workflows/ci.yml')
    expect(ciWorkflow).toContain("cron: '17 8 * * *'")
    const fuzzJob = workflowJob(ciWorkflow, 'rust-fuzz')
    expect(fuzzJob).toContain(
      "if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
    )
    expect(fuzzJob).toContain('timeout-minutes: 55')
    expect(fuzzJob).toContain('nightly-2026-04-28')
    expect(fuzzJob).toContain('node --test scripts/run-locked-fuzz.test.mjs')
    expect(fuzzJob).toContain('node scripts/run-locked-fuzz.mjs --verify-lock')
    for (const target of ['compiler_pipeline', 'compiler_request_pipeline', 'state_provenance']) {
      expect(fuzzJob).toContain(`node scripts/run-locked-fuzz.mjs build ${target}`)
      expect(fuzzJob).toContain(`node scripts/run-locked-fuzz.mjs run ${target}`)
    }
    expect(fuzzJob.match(/-max_total_time=600/g)).toHaveLength(3)
    expect(fuzzJob).toContain('path: fuzz/artifacts')
  })
})
