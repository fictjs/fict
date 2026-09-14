import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { extractHostRecipe } from './lib/compiler-host-contract.mjs'

const document = readFileSync(
  new URL('../docs/custom-compiler-host.md', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n')

for (const [name, newline] of [
  ['LF', '\n'],
  ['CRLF', '\r\n'],
]) {
  test(`extracts the executable custom host recipe from ${name} documentation`, () => {
    const recipe = extractHostRecipe(document.replace(/\n/g, newline))
    assert.equal(recipe, extractHostRecipe(document))
    for (const entry of ['prepareRequest', 'compileModule', 'analyzeModule']) {
      assert.ok(recipe.includes(`export async function ${entry}(`), entry)
    }
    assert.doesNotMatch(recipe, /```|executable-host-example/)
  })
}

test('requires a complete marked JavaScript recipe', () => {
  for (const invalid of [
    document.replace('<!-- executable-host-example:start -->', ''),
    document.replace('<!-- executable-host-example:end -->', ''),
    document.replace(/(<!-- executable-host-example:start -->\s*)```js/, '$1```ts'),
  ]) {
    assert.throws(() => extractHostRecipe(invalid), /Missing executable custom host example/)
  }
})
