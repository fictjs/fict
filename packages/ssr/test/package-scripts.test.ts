import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

describe('@fictjs/ssr package scripts', () => {
  it('regenerates the external stream runtime asset in build and watch modes', () => {
    const packageJsonPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../package.json',
    )
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>
    }
    const scripts = pkg.scripts ?? {}

    expect(scripts['build:stream-runtime']).toBe('node scripts/write-stream-runtime-asset.mjs')
    expect(scripts.build).toContain('pnpm run build:stream-runtime')
    expect(scripts.dev).toContain('--on-success')
    expect(scripts.dev).toContain('pnpm run build:stream-runtime')
    expect(scripts['test:matrix']).toContain('pnpm run test:node')
    expect(scripts['test:matrix']).toContain('pnpm run test:cjs')
  })
})
