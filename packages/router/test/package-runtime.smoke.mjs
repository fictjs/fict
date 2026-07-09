import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const routerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDir = path.resolve(routerDir, '../runtime')
const routerPackage = JSON.parse(readFileSync(path.join(routerDir, 'package.json'), 'utf8'))
const tempDir = mkdtempSync(path.join(tmpdir(), 'fict-router-package-'))

try {
  assert.equal(routerPackage.peerDependenciesMeta?.fict?.optional, true)

  for (const target of [routerPackage.exports['.'].import, routerPackage.exports['.'].require]) {
    const source = readFileSync(path.join(routerDir, target), 'utf8')
    assert.doesNotMatch(
      source,
      /(?:from\s*|require\()\s*["']fict(?:\/|["'])/,
      `${target} must not load the optional fict peer at runtime`,
    )
  }

  const nodeModules = path.join(tempDir, 'node_modules')
  const scopeDir = path.join(nodeModules, '@fictjs')
  const installedRouter = path.join(scopeDir, 'router')
  mkdirSync(installedRouter, { recursive: true })
  cpSync(path.join(routerDir, 'dist'), path.join(installedRouter, 'dist'), { recursive: true })
  cpSync(path.join(routerDir, 'package.json'), path.join(installedRouter, 'package.json'))
  symlinkSync(runtimeDir, path.join(scopeDir, 'runtime'), 'junction')

  // Deliberately do not install the optional `fict` peer. The package entry
  // must remain usable with its declared runtime dependency alone.
  const fixtureRequire = createRequire(path.join(tempDir, 'consumer.cjs'))
  const router = fixtureRequire('@fictjs/router')
  assert.equal(typeof router.createMemoryHistory, 'function')
  assert.equal(typeof router.Router, 'function')
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}
