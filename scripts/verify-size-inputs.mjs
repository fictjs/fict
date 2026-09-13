import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import checks from '../.size-limit.mjs'

const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('@size-limit/esbuild'))('esbuild')
const repositoryRoot = path.resolve(import.meta.dirname, '..')

export async function verifySizeInputs(check, { root = repositoryRoot } = {}) {
  const paths = Array.isArray(check.path) ? check.path : [check.path]
  let config = {
    absWorkingDir: root,
    entryPoints: paths.map(filename => path.resolve(root, filename)),
    bundle: true,
    minify: true,
    treeShaking: true,
    write: false,
    metafile: true,
    logLevel: 'silent',
  }
  if (check.modifyEsbuildConfig) config = check.modifyEsbuildConfig(config)
  // Inspect the complete entrypoint graph, also for selective-import budgets.
  // This checks a superset of the dependencies a partial import can retain.
  const result = await build(config)
  const inputs = Object.keys(result.metafile.inputs).map(filename =>
    path.relative(root, path.resolve(root, filename)).split(path.sep).join('/'),
  )
  const sourceInputs = inputs.filter(filename => /^packages\/[^/]+\/src\//.test(filename))
  if (sourceInputs.length) {
    throw new Error(
      `${check.name} loads workspace source instead of distributed modules: ${sourceInputs.join(', ')}`,
    )
  }
  return inputs
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const check of checks) {
    const inputs = await verifySizeInputs(check)
    console.log(
      `${check.name}: ${inputs.length} module inputs checked; no workspace source aliases`,
    )
  }
}
