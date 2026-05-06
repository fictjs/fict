import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createStreamRuntimeCode } from '../dist/stream-runtime.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = resolve(packageRoot, 'dist')

await mkdir(distDir, { recursive: true })
await writeFile(
  resolve(distDir, 'fict-stream-runtime.js'),
  `${createStreamRuntimeCode({ observerMode: true })}\n`,
)
