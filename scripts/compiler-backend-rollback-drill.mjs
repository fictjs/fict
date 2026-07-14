#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requireFromVitePlugin = createRequire(
  path.join(root, 'packages', 'vite-plugin', 'package.json'),
)

function readArgument(name, fallback) {
  const prefix = `--${name}=`
  const inline = process.argv.find(argument => argument.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const output = []
  for (const entry of entries) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) output.push(...(await files(filename)))
    else output.push(filename)
  }
  return output
}

async function bundleCode(directory) {
  const chunks = (await files(directory)).filter(filename => filename.endsWith('.js')).sort()
  return (await Promise.all(chunks.map(filename => readFile(filename, 'utf8')))).join('\n')
}

const nativePath = path.resolve(
  readArgument('native-path', path.join(root, 'target', 'release', 'fict_compiler_napi.node')),
)
const outputPath = path.resolve(
  readArgument(
    'output',
    process.env.FICT_COMPILER_ROLLBACK_OUTPUT ??
      path.join(root, '.fict-cache', 'compiler-rollback-drill.json'),
  ),
)
if (!existsSync(nativePath)) throw new Error(`Native compiler does not exist: ${nativePath}`)

const viteEntry = requireFromVitePlugin.resolve('vite')
const { build } = await import(pathToFileURL(viteEntry).href)
const { default: fict } = await import(
  pathToFileURL(path.join(root, 'packages', 'vite-plugin', 'dist', 'index.js')).href
)
const binding = createRequire(import.meta.url)(nativePath)
const compilerBuildId = binding.nativeCompilerInfo().compilerBuildId
const project = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fict-rollback-')))
const compilerCache = path.join(project, '.fict-cache', 'compiler')
const metadataCache = path.join(project, '.fict-cache', 'metadata')
const viteCache = path.join(project, 'node_modules', '.vite')

try {
  await mkdir(path.join(project, 'src'), { recursive: true })
  await writeFile(
    path.join(project, 'package.json'),
    JSON.stringify({ name: 'fict-rollout-drill', private: true, type: 'module' }),
  )
  await writeFile(
    path.join(project, 'index.html'),
    '<!doctype html><div id="app"></div><script type="module" src="/src/main.tsx"></script>',
  )
  await writeFile(
    path.join(project, 'src', 'main.tsx'),
    `
      import { $state, render } from 'fict'
      function App() {
        let count = $state(0)
        return <button onClick={() => count++}>{count}</button>
      }
      render(() => <App />, document.querySelector('#app'))
    `,
  )

  const aliases = [
    {
      find: /^fict\/internal\/list$/,
      replacement: path.join(root, 'packages', 'fict', 'dist', 'internal-list.js'),
    },
    {
      find: /^fict\/internal$/,
      replacement: path.join(root, 'packages', 'fict', 'dist', 'internal.js'),
    },
    { find: /^fict$/, replacement: path.join(root, 'packages', 'fict', 'dist', 'index.js') },
    {
      find: /^@fictjs\/runtime\/internal\/list$/,
      replacement: path.join(root, 'packages', 'runtime', 'dist', 'internal-list.js'),
    },
    {
      find: /^@fictjs\/runtime\/internal$/,
      replacement: path.join(root, 'packages', 'runtime', 'dist', 'internal.js'),
    },
    {
      find: /^@fictjs\/runtime\/advanced$/,
      replacement: path.join(root, 'packages', 'runtime', 'dist', 'advanced.js'),
    },
    {
      find: /^@fictjs\/runtime$/,
      replacement: path.join(root, 'packages', 'runtime', 'dist', 'index.js'),
    },
  ]
  const runBuild = backend =>
    build({
      root: project,
      configFile: false,
      logLevel: 'silent',
      cacheDir: viteCache,
      plugins: [
        fict({
          backend,
          cache: { enabled: true, persistent: true, dir: compilerCache },
          functionSplitting: false,
          useTypeScriptProject: false,
          ...(backend === 'rust' ? { nativeCompilerPath: nativePath } : {}),
        }),
      ],
      resolve: { alias: aliases },
      build: { emptyOutDir: true, outDir: path.join(project, `dist-${backend}`) },
    })

  await runBuild('rust')
  const rustCode = await bundleCode(path.join(project, 'dist-rust'))
  await mkdir(metadataCache, { recursive: true })
  await writeFile(path.join(metadataCache, 'rust-sidecar-marker.json'), compilerBuildId)
  await writeFile(path.join(compilerCache, 'rust-cache-marker'), compilerBuildId)

  await Promise.all([
    rm(compilerCache, { recursive: true, force: true }),
    rm(metadataCache, { recursive: true, force: true }),
    rm(viteCache, { recursive: true, force: true }),
    rm(path.join(project, 'dist-rust'), { recursive: true, force: true }),
  ])
  if (existsSync(path.join(compilerCache, 'rust-cache-marker'))) {
    throw new Error('Compiler cache survived backend rollback purge')
  }
  if (existsSync(path.join(metadataCache, 'rust-sidecar-marker.json'))) {
    throw new Error('Metadata sidecar survived backend rollback purge')
  }

  await runBuild('legacy')
  const legacyCode = await bundleCode(path.join(project, 'dist-legacy'))
  if (rustCode === legacyCode) throw new Error('Rollback drill did not exercise distinct backends')
  if (legacyCode.includes(compilerBuildId)) {
    throw new Error('Legacy output retained the Rust compiler build identifier')
  }

  const artifact = {
    schemaVersion: 1,
    status: 'pass',
    rollbackUnit: 'whole-build',
    compilerBuildId,
    purged: {
      compilerCache: true,
      metadataCache: true,
      bundlerCache: true,
      generatedOutput: true,
    },
    rustOutputDigest: digest(rustCode),
    legacyOutputDigest: digest(legacyCode),
  }
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  process.stdout.write('[compiler-rollback-drill] Whole-build Rust to legacy rollback passed.\n')
} finally {
  await rm(project, { recursive: true, force: true })
}
