import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

const root = new URL('..', import.meta.url).pathname

test('every manifest helper is exported by its runtime ABI subpath', async () => {
  const manifest = JSON.parse(
    await readFile(join(root, 'packages/runtime/runtime-abi.json'), 'utf8'),
  )
  const sources = {
    internal: await readFile(join(root, 'packages/runtime/src/internal.ts'), 'utf8'),
    list: await readFile(join(root, 'packages/runtime/src/internal/list.ts'), 'utf8'),
  }

  for (const helper of manifest.helpers) {
    assert.match(
      sources[helper.module],
      new RegExp(`\\b${escapeRegExp(helper.export)}\\b`),
      `${helper.key} (${helper.export}) is absent from ${helper.module}`,
    )
  }
})

test('manifest keys and exports are unique', async () => {
  const manifest = JSON.parse(
    await readFile(join(root, 'packages/runtime/runtime-abi.json'), 'utf8'),
  )
  assert.equal(new Set(manifest.helpers.map(helper => helper.key)).size, manifest.helpers.length)
  const exported = manifest.helpers.map(helper => `${helper.module}:${helper.export}`)
  assert.equal(new Set(exported).size, exported.length)
})

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
