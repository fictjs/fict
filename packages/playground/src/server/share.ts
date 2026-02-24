import { deflateRawSync, inflateRawSync } from 'node:zlib'

import type { PlaygroundSessionSnapshot } from './types'

const SHARE_VERSION = 1
const MAX_SNAPSHOT_BYTES = 512 * 1024
const MAX_COMPRESSED_BYTES = 256 * 1024

interface ShareEnvelope {
  version: number
  snapshot: PlaygroundSessionSnapshot
}

export function encodeSessionSnapshot(snapshot: PlaygroundSessionSnapshot): string {
  if (!isValidSnapshot(snapshot)) {
    throw new Error('Invalid snapshot payload')
  }

  const payload: ShareEnvelope = {
    version: SHARE_VERSION,
    snapshot,
  }

  const json = JSON.stringify(payload)
  if (Buffer.byteLength(json, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new Error('Share payload exceeds safe size limits')
  }

  const compressed = deflateRawSync(Buffer.from(json, 'utf8'))
  if (compressed.length > MAX_COMPRESSED_BYTES) {
    throw new Error('Share payload exceeds safe size limits')
  }

  return compressed.toString('base64url')
}

export function decodeSessionSnapshot(token: string): PlaygroundSessionSnapshot {
  if (!token.trim()) {
    throw new Error('Invalid snapshot payload')
  }

  const compressed = Buffer.from(token, 'base64url')
  if (compressed.length === 0) {
    throw new Error('Invalid snapshot payload')
  }
  if (compressed.length > MAX_COMPRESSED_BYTES) {
    throw new Error('Share payload exceeds safe size limits')
  }

  const json = safeInflateToUtf8(compressed)

  if (Buffer.byteLength(json, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new Error('Share payload exceeds safe size limits')
  }

  let parsed: ShareEnvelope
  try {
    parsed = JSON.parse(json) as ShareEnvelope
  } catch {
    throw new Error('Invalid snapshot payload')
  }

  if (!parsed || parsed.version !== SHARE_VERSION || !parsed.snapshot) {
    throw new Error('Unsupported share payload version')
  }

  const snapshot = parsed.snapshot
  if (snapshot.version !== SHARE_VERSION) {
    throw new Error('Unsupported snapshot schema version')
  }

  if (!isValidSnapshot(snapshot)) {
    throw new Error('Invalid snapshot payload')
  }

  return snapshot
}

function safeInflateToUtf8(compressed: Buffer): string {
  try {
    return inflateRawSync(compressed, { maxOutputLength: MAX_SNAPSHOT_BYTES }).toString('utf8')
  } catch (error) {
    if (isBufferTooLargeError(error)) {
      throw Object.assign(new Error('Share payload exceeds safe size limits'), { cause: error })
    }
    throw Object.assign(new Error('Invalid snapshot payload'), { cause: error })
  }
}

function isBufferTooLargeError(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE'
}

function isValidSnapshot(snapshot: unknown): snapshot is PlaygroundSessionSnapshot {
  if (!snapshot || typeof snapshot !== 'object') return false

  const view = snapshot as PlaygroundSessionSnapshot
  if (view.version !== SHARE_VERSION) return false
  if (typeof view.templateId !== 'string' || !view.templateId) return false
  if (typeof view.entryFile !== 'string' || !view.entryFile) return false
  if (!isValidConfig(view.config)) return false
  if (!isStringMap(view.files)) return false

  return true
}

function isValidConfig(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false
  const view = config as Record<string, unknown>

  if (
    view.profile !== 'app-default' &&
    view.profile !== 'ci-hard-gate' &&
    view.profile !== 'migration'
  ) {
    return false
  }

  return (
    typeof view.strictGuarantee === 'boolean' &&
    typeof view.strictReactivity === 'boolean' &&
    typeof view.lazyConditional === 'boolean' &&
    typeof view.resumable === 'boolean' &&
    typeof view.functionSplitting === 'boolean' &&
    typeof view.devtools === 'boolean'
  )
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  return Object.values(value).every(item => typeof item === 'string')
}
