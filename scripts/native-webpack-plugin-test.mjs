import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const result = spawnSync(
  executable,
  ['--dir', 'packages/webpack-plugin', 'exec', 'vitest', 'run'],
  {
    cwd: root,
    env: {
      ...process.env,
      FICT_COMPILER_NATIVE_PATH: path.join(root, 'target', 'release', 'fict_compiler_napi.node'),
    },
    stdio: 'inherit',
  },
)

if (result.error) throw result.error
process.exitCode = result.status ?? 1
