#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(scriptPath), '..')
const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

const compilerCapabilityManifestVersion = readJson(
  path.join(repoRoot, 'packages/compiler/compiler-capabilities.json'),
).schemaVersion

function run(command, args, options = {}) {
  console.log(`[package-tarball-smoke] $ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: options.capture ? 'utf8' : undefined,
    env: { ...process.env, ...options.env },
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    const output = options.capture
      ? [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
      : ''
    throw new Error(`${command} exited with status ${result.status}${output ? `:\n${output}` : ''}`)
  }
  return options.capture ? result.stdout : ''
}

function workspaceManifests(rootDir) {
  const manifests = [path.join(rootDir, 'package.json')]
  for (const workspaceRoot of ['packages', 'examples']) {
    const absoluteRoot = path.join(rootDir, workspaceRoot)
    if (!existsSync(absoluteRoot)) continue
    for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
      const manifestPath = path.join(absoluteRoot, entry.name, 'package.json')
      if (entry.isDirectory() && existsSync(manifestPath)) manifests.push(manifestPath)
    }
  }
  return manifests
}

function packageByName(rootDir) {
  const packages = new Map()
  for (const manifestPath of workspaceManifests(rootDir)) {
    const manifest = readJson(manifestPath)
    if (manifest.name) packages.set(manifest.name, { manifest, manifestPath })
  }
  return packages
}

function declaredDependencyVersions(rootDir) {
  const versions = new Map()
  for (const manifestPath of workspaceManifests(rootDir)) {
    const manifest = readJson(manifestPath)
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        if (!versions.has(name) && !String(version).startsWith('workspace:')) {
          versions.set(name, { ownerDir: path.dirname(manifestPath), version })
        }
      }
    }
  }
  return versions
}

function resolvedWorkspaceDependencies(rootDir) {
  const output = run(
    packageManager,
    ['--dir', rootDir, 'list', '--recursive', '--depth', '0', '--json'],
    { capture: true },
  )
  const resolutions = new Map()
  for (const workspace of JSON.parse(output)) {
    const dependencies = new Map()
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, value] of Object.entries(workspace[field] ?? {})) {
        if (value?.version) dependencies.set(name, value.version)
      }
    }
    resolutions.set(path.resolve(workspace.path), dependencies)
  }
  return resolutions
}

export function findWorkspaceProtocols(manifest) {
  const violations = []
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, value] of Object.entries(manifest[field] ?? {})) {
      if (String(value).startsWith('workspace:')) violations.push(`${field}.${name}`)
    }
  }
  return violations
}

export function findNativeCompilerVersionMismatches(manifest) {
  if (manifest.name !== '@fictjs/compiler') return []
  const nativeDependencies = Object.entries(manifest.optionalDependencies ?? {}).filter(([name]) =>
    name.startsWith('@fictjs/compiler-'),
  )
  const failures = nativeDependencies
    .filter(([, version]) => version !== manifest.version)
    .map(([name, version]) => `${name}@${version}`)
  if (nativeDependencies.length !== 8)
    failures.push(`native-package-count:${nativeDependencies.length}`)
  return failures
}

export function collectExportTargets(exportsField) {
  const targets = []
  function visit(value) {
    if (typeof value === 'string') {
      if (value.startsWith('./') && !value.includes('*')) targets.push(value.slice(2))
      return
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    for (const child of Object.values(value)) visit(child)
  }
  visit(exportsField)
  return [...new Set(targets)].sort()
}

function hasExplicitCondition(definition, condition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return false
  if (condition in definition) return true
  return hasExplicitCondition(definition.node, condition)
}

function hasTypeCondition(definition, preferredRuntimeCondition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return false
  const preferred = definition[preferredRuntimeCondition]
  if (preferred && typeof preferred === 'object' && 'types' in preferred) return true
  if ('types' in definition) return true
  return hasTypeCondition(definition.node, preferredRuntimeCondition)
}

function packageSpecifier(packageName, subpath) {
  return subpath === '.' ? packageName : `${packageName}/${subpath.replace(/^\.\//, '')}`
}

export function buildConsumerEntries(manifests) {
  const entries = { esm: [], cjs: [], esmTypes: [], cjsTypes: [] }

  for (const manifest of manifests) {
    const exportEntries = Object.entries(manifest.exports ?? { '.': {} })
    for (const [subpath, definition] of exportEntries) {
      const specifier = packageSpecifier(manifest.name, subpath)
      if (hasExplicitCondition(definition, 'import')) entries.esm.push(specifier)
      if (hasExplicitCondition(definition, 'require')) entries.cjs.push(specifier)
      if (hasTypeCondition(definition, 'import')) entries.esmTypes.push(specifier)
      if (hasExplicitCondition(definition, 'require') && hasTypeCondition(definition, 'require')) {
        entries.cjsTypes.push(specifier)
      }
    }
  }

  for (const values of Object.values(entries)) values.sort()
  return entries
}

export function findConsumerCoverageGaps(manifests, entries) {
  const gaps = []
  for (const manifest of manifests) {
    for (const [mode, specifiers] of Object.entries(entries)) {
      const covered = specifiers.some(
        specifier => specifier === manifest.name || specifier.startsWith(`${manifest.name}/`),
      )
      if (!covered) gaps.push(`${manifest.name}:${mode}`)
    }
  }
  return gaps
}

function runtimeTarget(value) {
  if (typeof value === 'string') {
    return value.startsWith('./') && !value.includes('*') ? value.slice(2) : null
  }
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = runtimeTarget(candidate)
      if (target) return target
    }
    return null
  }
  if (!value || typeof value !== 'object' || !('default' in value)) return null
  return runtimeTarget(value.default)
}

export function collectNonNodeImportTargets(manifests) {
  const entries = []
  for (const manifest of manifests) {
    for (const [subpath, definition] of Object.entries(manifest.exports ?? {})) {
      if (!definition || typeof definition !== 'object' || Array.isArray(definition)) continue
      const genericTarget = runtimeTarget(definition.import)
      const nodeTarget = runtimeTarget(
        definition.node && typeof definition.node === 'object'
          ? definition.node.import
          : definition.node,
      )
      if (!genericTarget || !nodeTarget || genericTarget === nodeTarget) continue
      entries.push({ packageName: manifest.name, subpath, target: genericTarget })
    }
  }
  return entries.sort((left, right) =>
    `${left.packageName}:${left.subpath}`.localeCompare(`${right.packageName}:${right.subpath}`),
  )
}

function archiveManifest(tarballPath) {
  const source = run('tar', ['-xOf', tarballPath, 'package/package.json'], { capture: true })
  return JSON.parse(source)
}

function archiveEntries(tarballPath) {
  return new Set(
    run('tar', ['-tzf', tarballPath], { capture: true })
      .split(/\r?\n/)
      .filter(Boolean)
      .map(entry => entry.replace(/^package\//, '').replace(/\/$/, '')),
  )
}

function validateArchive(expected, packed, entries, tarballPath) {
  if (packed.name !== expected.name || packed.version !== expected.version) {
    throw new Error(
      `${path.basename(tarballPath)} identifies ${packed.name}@${packed.version}; expected ${expected.name}@${expected.version}`,
    )
  }

  const workspaceProtocols = findWorkspaceProtocols(packed)
  if (workspaceProtocols.length > 0) {
    throw new Error(
      `${packed.name} tarball retained workspace protocols: ${workspaceProtocols.join(', ')}`,
    )
  }

  const nativeVersionMismatches = findNativeCompilerVersionMismatches(packed)
  if (nativeVersionMismatches.length > 0) {
    throw new Error(
      `${packed.name} tarball native versions do not match ${packed.version}: ` +
        nativeVersionMismatches.join(', '),
    )
  }

  const missingTargets = collectExportTargets(packed.exports).filter(target => !entries.has(target))
  if (missingTargets.length > 0) {
    throw new Error(
      `${packed.name} tarball is missing export targets: ${missingTargets.join(', ')}`,
    )
  }
}

function packPackage(packageInfo, packsDir) {
  const before = new Set(readdirSync(packsDir))
  run(packageManager, [
    '--dir',
    path.dirname(packageInfo.manifestPath),
    'pack',
    '--pack-destination',
    packsDir,
  ])
  const created = readdirSync(packsDir).filter(file => file.endsWith('.tgz') && !before.has(file))
  if (created.length !== 1) {
    throw new Error(`${packageInfo.manifest.name} pack created ${created.length} tarballs`)
  }

  const tarballPath = path.join(packsDir, created[0])
  const packed = archiveManifest(tarballPath)
  validateArchive(packageInfo.manifest, packed, archiveEntries(tarballPath), tarballPath)
  return { manifest: packed, tarballPath }
}

function writeRuntimeConsumer(filePath, mode, specifiers) {
  const body =
    mode === 'esm'
      ? `const specifiers = ${JSON.stringify(specifiers, null, 2)}\nfor (const specifier of specifiers) {\n  const value = await import(specifier)\n  if (!value || Object.keys(value).length === 0) throw new Error(\`Empty ESM namespace: \${specifier}\`)\n}\n`
      : `'use strict'\nconst specifiers = ${JSON.stringify(specifiers, null, 2)}\nfor (const specifier of specifiers) {\n  const value = require(specifier)\n  if (!value || (typeof value === 'object' && Object.keys(value).length === 0)) {\n    throw new Error(\`Empty CJS export: \${specifier}\`)\n  }\n}\n`
  writeFileSync(filePath, body)
}

function writeTypeConsumer(filePath, mode, specifiers) {
  const imports = specifiers.map((specifier, index) =>
    mode === 'esm'
      ? `import * as value${index} from ${JSON.stringify(specifier)}`
      : `import value${index} = require(${JSON.stringify(specifier)})`,
  )
  const values = specifiers.map((_, index) => `value${index}`).join(', ')
  writeFileSync(filePath, `${imports.join('\n')}\nvoid [${values}]\n`)
}

export function writeViteRustIsolationConsumer(filePath) {
  writeFileSync(
    filePath,
    `'use strict'
const Module = require('node:module')
const forbidden = new Set([
  '@babel/core',
  '@babel/generator',
  '@babel/helper-plugin-utils',
  '@babel/parser',
  '@babel/plugin-syntax-jsx',
  '@babel/plugin-transform-typescript',
  '@babel/traverse',
  '@babel/types',
])
const compilerBuildId = 'fict-rust-p1-oxc0.139.0-m1-' + '7'.repeat(64)
const scanResult = {
  protocolVersion: 1,
  moduleRequests: [],
  hasModuleSyntax: true,
  diagnostics: [],
  compilerBuildId,
}
const nativeFacade = {
  loadNativeCompilerBinding: () => ({
    nativeCompilerInfo: () => ({
      backend: 'rust',
      nativeTarget: 'tarball-test',
      oxcVersion: '0.139.0',
      nodeApiVersion: 10,
      compilerBuildId,
      compilerBuildRevision: null,
      compilerProtocolVersion: 1,
      metadataSchemaVersion: 1,
      compilerCapabilityManifestVersion: ${compilerCapabilityManifestVersion},
      compilerCapabilityManifestDigest: 'sha256:' + '0'.repeat(64),
      compilerCapabilityPackageVersion: 'test-capability-package',
    }),
    scan: async () => scanResult,
    scanSync: () => scanResult,
    transform: async () => ({
      protocolVersion: 1,
      code: 'export const compiledFromTarball = true;\\n',
      map: null,
      diagnostics: [],
      moduleMetadata: { version: 1, exports: {} },
      metadataDependencies: [],
      unresolvedMetadataRequests: [],
      metadataIncomplete: false,
      explain: null,
      artifacts: [],
      stats: null,
      compilerBuildId,
    }),
  }),
}
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === '@fictjs/compiler/native') return nativeFacade
  if (forbidden.has(request)) throw new Error('Rust tarball path loaded ' + request)
  return originalLoad.call(this, request, parent, isMain)
}

;(async () => {
  const viteModule = require('@fictjs/vite-plugin')
  const fict = viteModule.default ?? viteModule
  const plugin = fict({
    functionSplitting: false,
    useTypeScriptProject: false,
    publicIdentityNamespace: 'tarball-test@1',
  })
  plugin.configResolved({
    command: 'build',
    mode: 'production',
    root: '/project',
    base: '/',
    build: { ssr: true },
    resolve: { alias: [], preserveSymlinks: false },
  })
  const result = await plugin.transform.call(
    {
      emitFile() {},
      warn() {},
      error(error) {
        if (error instanceof Error) throw error
        const message =
          error && typeof error === 'object' && typeof error.message === 'string'
            ? error.message
            : String(error)
        throw new Error(message, { cause: error })
      },
    },
    'export function App() { return <main /> }',
    '/project/src/App.tsx',
  )
  if (!result.code.includes('compiledFromTarball')) {
    throw new Error('Vite Rust tarball transform did not use the native facade')
  }
})().finally(() => {
  Module._load = originalLoad
}).catch(error => {
  console.error(error)
  process.exitCode = 1
})
`,
  )
}

function installedTargetUrl(consumerDir, entry) {
  const packageDir = path.resolve(consumerDir, 'node_modules', ...entry.packageName.split('/'))
  const targetPath = path.resolve(packageDir, entry.target)
  const relativeTarget = path.relative(packageDir, targetPath)
  if (
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  ) {
    throw new Error(
      `${entry.packageName}${entry.subpath === '.' ? '' : entry.subpath.slice(1)} resolves outside its installed package: ${entry.target}`,
    )
  }
  return pathToFileURL(targetPath).href
}

function consumerDependencies(
  rootDir,
  sourcePackages,
  packedPackages,
  tarballPaths,
  resolutions,
  excludedDependencyNames = new Set(),
) {
  const declaredVersions = declaredDependencyVersions(rootDir)
  const internalNames = new Set(packedPackages.map(manifest => manifest.name))
  const dependencies = {}

  for (let index = 0; index < packedPackages.length; index += 1) {
    const relativeTarball = path.relative(
      path.join(path.dirname(tarballPaths[0]), '..', 'consumer'),
      tarballPaths[index],
    )
    dependencies[packedPackages[index].name] = `file:${relativeTarball.split(path.sep).join('/')}`
  }

  for (let index = 0; index < packedPackages.length; index += 1) {
    const manifest = packedPackages[index]
    const sourceDir = path.dirname(sourcePackages[index].manifestPath)
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (internalNames.has(name) || dependencies[name] || excludedDependencyNames.has(name)) {
          continue
        }
        const declared = declaredVersions.get(name)
        const version =
          resolutions.get(sourceDir)?.get(name) ??
          (declared ? resolutions.get(declared.ownerDir)?.get(name) : null)
        if (!version) {
          throw new Error(
            `${manifest.name} ${field}.${name}@${range} has no lockfile-resolved consumer version`,
          )
        }
        dependencies[name] = version
      }
    }
  }

  return dependencies
}

export function verifyReleaseContract(rootPackage, releaseWorkflow) {
  const releaseVerify = rootPackage.scripts?.['release:verify'] ?? ''
  const requiredGates = [
    'pnpm test:compiler:native-packages',
    'pnpm test:review-regressions',
    'pnpm test:package-tarballs',
    'pnpm test:ssr-matrix',
    'pnpm test:e2e',
  ]
  const missing = requiredGates.filter(gate => !releaseVerify.split(' && ').includes(gate))
  if (rootPackage.scripts?.['release:verify:clean'] !== 'node scripts/release-verify-clean.mjs') {
    missing.push('release:verify:clean script')
  }
  if (!releaseWorkflow.includes('pnpm release:verify:clean')) {
    missing.push('release workflow clean-checkout invocation')
  }
  if (!releaseWorkflow.includes('name: Build native compiler packages')) {
    missing.push('release workflow native build matrix')
  }
  if (!releaseWorkflow.includes('name: Certify native compiler packages')) {
    missing.push('release workflow native runtime matrix')
  }
  if (!releaseWorkflow.includes('node scripts/publish-release-packages.mjs')) {
    missing.push('dependency-ordered atomic package publisher')
  }
  return missing
}

export function buildConsumerPnpmConfig(
  rootConfig,
  packages,
  dependencies,
  excludedDependencies = new Set(),
) {
  const tarballOverrides = {}
  for (const manifest of packages) {
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        const dependency = dependencies[name]
        if (!dependency?.startsWith('file:')) continue
        tarballOverrides[`${manifest.name}>${name}`] = dependency
      }
    }
  }
  for (const dependencyName of excludedDependencies) {
    tarballOverrides[`@fictjs/compiler>${dependencyName}`] = '-'
  }
  return {
    ...rootConfig,
    overrides: {
      ...(rootConfig?.overrides ?? {}),
      ...tarballOverrides,
    },
  }
}

async function main() {
  const config = readJson(path.join(repoRoot, '.github/npm-publish-packages.json'))
  const packages = packageByName(repoRoot)
  const configured = config.packages.map(name => {
    const packageInfo = packages.get(name)
    if (!packageInfo) throw new Error(`Publish allowlist references missing package ${name}`)
    return packageInfo
  })
  const nativePackageNames = new Set(
    configured
      .filter(packageInfo => packageInfo.manifest.fictNative)
      .map(packageInfo => packageInfo.manifest.name),
  )
  const selected = configured.filter(packageInfo => !packageInfo.manifest.fictNative)

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'fict-package-tarballs-'))
  const packsDir = path.join(tempRoot, 'packs')
  const consumerDir = path.join(tempRoot, 'consumer')
  mkdirSync(packsDir)
  mkdirSync(consumerDir)

  try {
    const archives = selected.map(packageInfo => packPackage(packageInfo, packsDir))
    const packedPackages = archives.map(archive => archive.manifest)
    const tarballPaths = archives.map(archive => archive.tarballPath)
    const rootManifest = readJson(path.join(repoRoot, 'package.json'))
    const resolutions = resolvedWorkspaceDependencies(repoRoot)
    const dependencies = consumerDependencies(
      repoRoot,
      selected,
      packedPackages,
      tarballPaths,
      resolutions,
      nativePackageNames,
    )
    const rootResolutions = resolutions.get(repoRoot)
    const devDependencies = {
      '@types/node': rootResolutions?.get('@types/node'),
      typescript: rootResolutions?.get('typescript'),
    }
    if (!devDependencies['@types/node'] || !devDependencies.typescript) {
      throw new Error('Root TypeScript consumer dependencies are missing from the frozen install')
    }
    const pnpmConfig = buildConsumerPnpmConfig(
      rootManifest.pnpm,
      packedPackages,
      dependencies,
      nativePackageNames,
    )

    writeFileSync(
      path.join(consumerDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'fict-release-tarball-consumer',
          private: true,
          type: 'module',
          packageManager: rootManifest.packageManager,
          dependencies,
          devDependencies,
          pnpm: pnpmConfig,
        },
        null,
        2,
      )}\n`,
    )

    run(
      packageManager,
      [
        '--dir',
        consumerDir,
        'install',
        '--ignore-scripts',
        '--no-frozen-lockfile',
        '--prefer-offline',
        '--strict-peer-dependencies',
        '--store-dir',
        process.env.FICT_PNPM_STORE_DIR ?? path.join(repoRoot, '.pnpm-store'),
      ],
      { env: { CI: 'true', HUSKY: '0' } },
    )

    const entries = buildConsumerEntries(packedPackages)
    const coverageGaps = findConsumerCoverageGaps(packedPackages, entries)
    if (coverageGaps.length > 0) {
      throw new Error(
        `Publish allowlist packages lack required consumer coverage: ${coverageGaps.join(', ')}`,
      )
    }

    const esmPath = path.join(consumerDir, 'consumer.mjs')
    const cjsPath = path.join(consumerDir, 'consumer.cjs')
    const esmTypesPath = path.join(consumerDir, 'consumer.mts')
    const cjsTypesPath = path.join(consumerDir, 'consumer.cts')
    const nonNodeEsmPath = path.join(consumerDir, 'consumer-non-node.mjs')
    const viteRustIsolationPath = path.join(consumerDir, 'vite-rust-isolation.cjs')
    const nonNodeImports = collectNonNodeImportTargets(packedPackages)
    writeRuntimeConsumer(esmPath, 'esm', entries.esm)
    writeRuntimeConsumer(cjsPath, 'cjs', entries.cjs)
    writeRuntimeConsumer(
      nonNodeEsmPath,
      'esm',
      nonNodeImports.map(entry => installedTargetUrl(consumerDir, entry)),
    )
    writeTypeConsumer(esmTypesPath, 'esm', entries.esmTypes)
    writeTypeConsumer(cjsTypesPath, 'cjs', entries.cjsTypes)
    writeViteRustIsolationConsumer(viteRustIsolationPath)

    run(process.execPath, [esmPath], { cwd: consumerDir })
    run(process.execPath, [cjsPath], { cwd: consumerDir })
    run(process.execPath, [viteRustIsolationPath], { cwd: consumerDir })
    if (nonNodeImports.length > 0) run(process.execPath, [nonNodeEsmPath], { cwd: consumerDir })
    const typeScriptBin = path.join(
      consumerDir,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
    )
    run(
      typeScriptBin,
      [
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        'false',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        esmTypesPath,
        cjsTypesPath,
      ],
      { cwd: consumerDir },
    )

    console.log(
      `[package-tarball-smoke] Verified ${packedPackages.length} package tarballs across Node ESM, ${nonNodeImports.length} generic ESM targets shadowed by node conditions, CJS, and TypeScript consumers.`,
    )
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch(error => {
    console.error(`[package-tarball-smoke] ${error.stack ?? error.message ?? error}`)
    process.exitCode = 1
  })
}
