import { deflateRawSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { decodeSessionSnapshot, encodeSessionSnapshot } from '../src/server/share'
import type { PlaygroundSessionSnapshot } from '../src/server/types'

describe('playground share snapshot', () => {
  it('round-trips snapshot payloads', () => {
    const snapshot: PlaygroundSessionSnapshot = {
      version: 1,
      templateId: 'counter',
      entryFile: 'src/App.tsx',
      config: {
        profile: 'app-default',
        strictGuarantee: true,
        strictReactivity: false,
        lazyConditional: true,
        resumable: false,
        functionSplitting: false,
        devtools: false,
      },
      files: {
        'src/main.tsx': 'console.log(1)\n',
      },
    }

    const token = encodeSessionSnapshot(snapshot)
    expect(token.length).toBeGreaterThan(5)

    const decoded = decodeSessionSnapshot(token)
    expect(decoded).toEqual(snapshot)
  })

  it('throws on invalid payload', () => {
    expect(() => decodeSessionSnapshot('invalid-token')).toThrow()
  })

  it('rejects oversized snapshot payloads on encode', () => {
    const oversized = 'x'.repeat(600 * 1024)
    const snapshot: PlaygroundSessionSnapshot = {
      version: 1,
      templateId: 'counter',
      entryFile: 'src/App.tsx',
      config: {
        profile: 'app-default',
        strictGuarantee: true,
        strictReactivity: false,
        lazyConditional: true,
        resumable: false,
        functionSplitting: false,
        devtools: false,
      },
      files: {
        'src/main.tsx': oversized,
      },
    }

    expect(() => encodeSessionSnapshot(snapshot)).toThrow('Share payload exceeds safe size limits')
  })

  it('rejects oversized snapshot payloads on decode', () => {
    const oversized = 'x'.repeat(600 * 1024)
    const payload = {
      version: 1,
      snapshot: {
        version: 1,
        templateId: 'counter',
        entryFile: 'src/App.tsx',
        config: {
          profile: 'app-default',
          strictGuarantee: true,
          strictReactivity: false,
          lazyConditional: true,
          resumable: false,
          functionSplitting: false,
          devtools: false,
        },
        files: {
          'src/main.tsx': oversized,
        },
      },
    }

    const token = deflateRawSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64url')
    expect(() => decodeSessionSnapshot(token)).toThrow('Share payload exceeds safe size limits')
  })
})
