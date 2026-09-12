#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { parseArgs } from 'node:util'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  options: {
    'benchmark-root': {
      type: 'string',
      default: path.join(repositoryRoot, 'js-framework-benchmark'),
    },
    name: { type: 'string', default: 'fict-local' },
    url: { type: 'string', default: 'http://localhost:8080' },
    'chrome-binary': { type: 'string' },
  },
})
assert.match(values.name, /^fict-[a-z0-9-]+$/)
const require = createRequire(path.resolve(values['benchmark-root'], 'webdriver-ts/package.json'))
const { chromium } = require('playwright')
const inventory = await fetch(`${values.url}/ls`).then(response => {
  assert.equal(response.status, 200)
  return response.json()
})
assert.ok(
  inventory.some(entry => entry.type === 'keyed' && entry.directory === values.name),
  `The benchmark server did not discover keyed/${values.name}`,
)
const browser = await chromium.launch({
  headless: true,
  ...(values['chrome-binary']
    ? { executablePath: values['chrome-binary'] }
    : { channel: 'chrome' }),
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', error => errors.push(String(error)))
let model = []
let selected = null
let checks = 0

try {
  await page.goto(`${values.url}/frameworks/keyed/${values.name}/index.html`)
  await page.locator('#run').waitFor()
  await page.evaluate(() => {
    window.__benchmarkNodes = new Map()
  })

  const snapshot = () =>
    page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tbody > tr')).map(row => ({
        id: Number(row.children[0].textContent),
        label: row.children[1].textContent,
        selected: row.classList.contains('danger'),
        node: row,
      }))
      const present = new Set(rows.map(row => row.id))
      let stableIdentity = true
      for (const row of rows) {
        const known = window.__benchmarkNodes.get(row.id)
        if (known && known !== row.node) stableIdentity = false
        window.__benchmarkNodes.set(row.id, row.node)
      }
      for (const [id, node] of window.__benchmarkNodes) {
        if (!present.has(id) && node.isConnected) stableIdentity = false
      }
      return {
        rows: rows.map(({ node, ...row }) => row),
        stableIdentity,
      }
    })
  const settle = () =>
    page.evaluate(
      () =>
        new Promise(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        }),
    )
  const check = async label => {
    await settle()
    const actual = await snapshot()
    assert.equal(actual.stableIdentity, true, `${label}: keyed DOM identity`)
    assert.deepEqual(
      actual.rows,
      model.map(row => ({ ...row, selected: row.id === selected })),
      label,
    )
    assert.equal(
      new Set(actual.rows.map(row => row.id)).size,
      actual.rows.length,
      `${label}: unique IDs`,
    )
    assert.deepEqual(errors, [], `${label}: browser errors`)
    checks++
  }
  const create = async count => {
    const previousIds = new Set(model.map(row => row.id))
    await page.locator(count === 1000 ? '#run' : '#runlots').click()
    await settle()
    const actual = await snapshot()
    assert.equal(actual.rows.length, count)
    model = actual.rows.map(({ id, label }) => {
      assert.ok(Number.isSafeInteger(id) && id > 0 && !previousIds.has(id))
      assert.match(label, /^\S+ \S+ \S+$/)
      return { id, label }
    })
    selected = null
    await check(`create ${count}`)
  }
  const update = async () => {
    model = model.map((row, index) =>
      index % 10 === 0 ? { ...row, label: `${row.label} !!!` } : row,
    )
    await page.locator('#update').click()
    await check('update every tenth row')
  }
  const swap = async () => {
    ;[model[1], model[998]] = [model[998], model[1]]
    await page.locator('#swaprows').click()
    await check('swap rows')
  }
  const append = async () => {
    await page.locator('#add').click()
    await settle()
    const actual = await snapshot()
    assert.equal(actual.rows.length, model.length + 1000)
    model.push(...actual.rows.slice(model.length).map(({ id, label }) => ({ id, label })))
    await check('append 1000 rows')
  }
  const clear = async () => {
    model = []
    selected = null
    await page.locator('#clear').click()
    await check('clear')
  }

  await check('initial')
  await create(1000)
  await update()
  await update()
  selected = model[1].id
  await page.locator('tbody > tr').nth(1).locator('a').first().click()
  await check('select row')
  await swap()
  model.splice(998, 1)
  selected = null
  await page.locator('tbody > tr').nth(998).locator('a').nth(1).click()
  await check('remove selected row')
  await append()
  await create(1000)
  await clear()
  await create(10000)
  await update()
  await swap()
  await append()
  await clear()
  console.log(
    JSON.stringify(
      { framework: values.name, browser: browser.version(), checks, maxRows: 11000 },
      null,
      2,
    ),
  )
} finally {
  await browser.close()
}
