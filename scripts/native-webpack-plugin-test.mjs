import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nativePath = path.join(root, 'target', 'release', 'fict_compiler_napi.node')
// A fresh native image may need OS signature validation. Load it before Vitest
// starts individual test timers; addon load failures still fail this entrypoint.
createRequire(import.meta.url)(nativePath)
const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const result = spawnSync(
  executable,
  ['--dir', 'packages/webpack-plugin', 'exec', 'vitest', 'run'],
  {
    cwd: root,
    env: {
      ...process.env,
      FICT_COMPILER_NATIVE_PATH: nativePath,
    },
    stdio: 'inherit',
  },
)

if (result.error) throw result.error
process.exitCode = result.status ?? 1
