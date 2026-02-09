import { deflateRawSync, inflateRawSync } from 'node:zlib'

import type { PlaygroundSessionSnapshot } from './types'

const SHARE_VERSION = 1
const MAX_SNAPSHOT_BYTES = 512 * 1024

interface ShareEnvelope {
  version: number
  snapshot: PlaygroundSessionSnapshot
}

export function encodeSessionSnapshot(snapshot: PlaygroundSessionSnapshot): string {
  const payload: ShareEnvelope = {
    version: SHARE_VERSION,
    snapshot,
  }

  const json = JSON.stringify(payload)
  const compressed = deflateRawSync(Buffer.from(json, 'utf8'))
  return compressed.toString('base64url')
}

export function decodeSessionSnapshot(token: string): PlaygroundSessionSnapshot {
  const compressed = Buffer.from(token, 'base64url')
  const json = inflateRawSync(compressed).toString('utf8')

  if (json.length > MAX_SNAPSHOT_BYTES) {
    throw new Error('Share payload exceeds safe size limits')
  }

  const parsed = JSON.parse(json) as ShareEnvelope

  if (!parsed || parsed.version !== SHARE_VERSION || !parsed.snapshot) {
    throw new Error('Unsupported share payload version')
  }

  const snapshot = parsed.snapshot
  if (snapshot.version !== 1) {
    throw new Error('Unsupported snapshot schema version')
  }

  if (!snapshot.templateId || !snapshot.entryFile || !snapshot.config || !snapshot.files) {
    throw new Error('Invalid snapshot payload')
  }

  return snapshot
}
