#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, expect } from '@playwright/test'

import { sha256 } from './lib/strict-application-corpus.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = path.join(root, 'test-results/strict-application-corpus')
await mkdir(output, { recursive: true })
const builds = JSON.parse(
  await readFile(path.join(root, 'test-results/strict-application-corpus.json'), 'utf8'),
)
assert.ok(
  ['built; browser not run', 'passed'].includes(builds.status),
  'A captured strict build is required',
)
const servers = []
const origins = new Map()
const served = new Map()
const report = { startedAt: new Date().toISOString(), status: 'running', cases: [] }
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

for (const id of ['counter-basic', 'counter-webpack', 'todos', 'forms', 'async-data']) {
  const assets = builds.applications
    .find(app => app.id === id)
    ?.builds.flatMap(build => build.assets)
  assert.ok(assets?.length, `Missing captured artifacts for ${id}`)
  const allowed = new Map(assets.map(asset => [path.join(root, asset.file), asset]))
  const directory = path.join(root, 'examples', id, 'dist')
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      if (pathname === '/favicon.ico') {
        response.writeHead(204).end()
        return
      }
      const filename = path.join(directory, pathname === '/' ? 'index.html' : pathname)
      const identity = allowed.get(filename)
      if (!identity) {
        response.writeHead(404).end('Not in the captured build')
        return
      }
      const bytes = await readFile(filename)
      assert.equal(sha256(bytes), identity.sha256, `Served artifact changed: ${identity.file}`)
      served.set(identity.file, identity)
      response.writeHead(200, {
        'Content-Type': mime[path.extname(filename)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      })
      response.end(bytes)
    } catch (error) {
      response.writeHead(500).end(String(error))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  servers.push(server)
  origins.set(id, `http://127.0.0.1:${server.address().port}`)
}

let browser
try {
  browser = await chromium.launch({ headless: true })
  report.browser = browser.version()
  async function scenario(id, name, run) {
    process.stdout.write(`[strict-application-browser] ${name}\n`)
    const context = await browser.newContext()
    context.setDefaultTimeout(5000)
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text())
    })
    const result = { application: id, name, passed: false, errors }
    report.cases.push(result)
    try {
      await page.goto(origins.get(id), { waitUntil: 'networkidle' })
      await run(page)
      assert.deepEqual(errors, [], `${id} produced browser errors`)
      result.passed = true
    } catch (error) {
      result.failure = error.message
      await writeFile(path.join(output, `${id}-failure.html`), await page.content())
      await page.screenshot({ path: path.join(output, `${id}-failure.png`), fullPage: true })
      throw error
    } finally {
      await context.close()
    }
  }

  await scenario('counter-basic', 'derived prop and event updates', async page => {
    const counter = page.getByRole('button', { name: '0', exact: true })
    await expect(counter).toBeVisible()
    await counter.click()
    await expect(page.getByRole('button', { name: '2', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '2', exact: true }).click()
    await expect(page.getByRole('button', { name: '4', exact: true })).toBeVisible()
  })

  await scenario(
    'todos',
    'add, immutable row replacement, filtering, event snapshots and deletion',
    async page => {
      const input = page.getByPlaceholder('What needs to be done?')
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await expect(page.getByText('No todos yet. Add one above!')).toBeVisible()
      await input.fill('  First task  ')
      await input.press('Enter')
      await expect(input).toHaveValue('')
      await input.fill('Second task')
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await expect(page.locator('li')).toHaveCount(2)
      await page.locator('li').filter({ hasText: 'First task' }).getByRole('checkbox').check()
      await expect(page.getByRole('button', { name: 'Completed (1)', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Active (1)', exact: true }).click()
      await expect(page.locator('li > span')).toHaveText(['Second task'])
      await page.getByRole('button', { name: 'Completed (1)', exact: true }).click()
      await expect(page.locator('li > span')).toHaveText(['First task'])
      // This event removes the row from the completed filter immediately.
      await page.locator('li').getByRole('checkbox').click()
      await expect(page.locator('li')).toHaveCount(0)
      await page.getByRole('button', { name: 'All (2)', exact: true }).click()
      await page.locator('li').filter({ hasText: 'Second task' }).getByRole('button').click()
      await expect(page.locator('li')).toHaveCount(1)
      await expect(page.locator('li')).toContainText('First task')
      await page.locator('li').getByRole('checkbox').check()
      await page.getByRole('button', { name: 'Clear completed', exact: true }).click()
      await expect(page.getByText('No todos yet. Add one above!')).toBeVisible()
      await expect(page.getByRole('button', { name: 'All (0)', exact: true })).toBeVisible()
    },
  )

  await scenario('forms', 'deep store writes, live validation, submit and reset', async page => {
    await page.getByRole('button', { name: 'Register', exact: true }).click()
    for (const text of [
      'Username is required',
      'Email is required',
      'Password is required',
      'Please select a gender',
      'Please select a country',
      'You must accept the terms',
    ]) {
      await expect(page.getByText(text, { exact: true })).toBeVisible()
    }
    await page.getByPlaceholder('Enter username').fill('ab')
    await expect(page.getByText('Username must be at least 3 characters')).toBeVisible()
    await page.getByPlaceholder('Enter username').fill('corpus-user')
    await expect(page.getByText('Username must be at least 3 characters')).toHaveCount(0)
    await page.getByPlaceholder('Enter email').fill('invalid')
    await expect(page.getByText('Please enter a valid email')).toBeVisible()
    await page.getByPlaceholder('Enter email').fill('corpus@example.com')
    await page.getByPlaceholder('Enter password').fill('strong-password')
    await page.getByRole('radio', { name: 'Female', exact: true }).check()
    await page.locator('select').selectOption('cn')
    await page.getByRole('checkbox', { name: 'Subscribe to newsletter' }).check()
    await page.getByRole('checkbox', { name: 'I accept the terms and conditions' }).check()
    await expect(page.locator('pre')).toContainText('corpus-user')
    await expect(page.locator('pre')).toContainText('"newsletter": true')
    await page.getByRole('button', { name: 'Register', exact: true }).click()
    await expect(page.getByText('✅ Registration Successful!')).toBeVisible()
    await expect(page.getByText('corpus@example.com', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Register Another', exact: true }).click()
    for (const placeholder of ['Enter username', 'Enter email', 'Enter password']) {
      await expect(page.getByPlaceholder(placeholder)).toHaveValue('')
    }
    await expect(page.locator('select')).toHaveValue('')
    await expect(page.getByRole('radio', { name: 'Female', exact: true })).not.toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'Subscribe to newsletter' })).not.toBeChecked()
    await expect(
      page.getByRole('checkbox', { name: 'I accept the terms and conditions' }),
    ).not.toBeChecked()
    await expect(page.getByText('Username is required', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Register', exact: true }).click()
    await expect(page.getByText('Username is required', { exact: true })).toBeVisible()
  })

  for (const id of ['async-data', 'counter-webpack']) {
    await scenario(id, 'Resource key changes, refresh and superseded UI results', async page => {
      await expect(page.getByText('Select a user to view their posts')).toBeVisible()
      for (const user of ['Alice Johnson', 'Bob Smith', 'Carol Williams', 'David Brown']) {
        await expect(page.getByText(user, { exact: true })).toBeVisible()
      }
      await page.getByText('Alice Johnson', { exact: true }).click()
      await expect(page.locator('h4')).toHaveText([
        'Getting Started with Fict',
        'Advanced Reactivity Patterns',
      ])
      await page.getByText('Bob Smith', { exact: true }).click()
      await expect(page.locator('h4')).toHaveText(['Building Scalable Apps'])
      await page.getByText('Carol Williams', { exact: true }).click()
      await page.waitForTimeout(100)
      await page.getByText('David Brown', { exact: true }).click()
      await page.waitForTimeout(100)
      await page.getByText('Bob Smith', { exact: true }).click()
      await expect(page.locator('h4')).toHaveText(['Building Scalable Apps'])
      // Wait beyond the fake fetchers' 800 ms delay so stale completions really run.
      await page.waitForTimeout(1000)
      await expect(page.locator('h4')).toHaveText(['Building Scalable Apps'])
      await page.getByRole('button', { name: '🔄 Refresh Users', exact: true }).click()
      await expect(
        page.getByRole('button', { name: '⏳ Refreshing...', exact: true }),
      ).toBeDisabled()
      await expect(
        page.getByRole('button', { name: '🔄 Refresh Users', exact: true }),
      ).toBeEnabled()
      await expect(page.getByText('Alice Johnson', { exact: true })).toBeVisible()
      await expect(page.locator('h4')).toHaveText(['Building Scalable Apps'])
      if (id === 'async-data') {
        await expect(page.locator('#graph-value')).toHaveText('Current result: Result 1')
        const note = page.locator('#graph-note')
        await note.fill('Keep this note')
        const initialNote = await note.elementHandle()
        await page.locator('#graph-next').click()
        await expect(page.locator('#graph-transition')).toHaveText('Updating result…')
        await expect(page.locator('#graph-loading')).toBeVisible()
        await expect(page.locator('#graph-value')).toHaveText('Current result: Result 2')
        await expect(note).toHaveValue('Keep this note')
        assert.equal(
          await initialNote.evaluate(node => node === document.querySelector('#graph-note')),
          true,
        )
        await expect(page.locator('#graph-transition')).toHaveText('Transition idle')

        await page.locator('#graph-next').click()
        await page.waitForTimeout(50)
        await page.locator('#graph-next').click()
        await expect(page.locator('#graph-value')).toHaveText('Current result: Result 4')
        await expect(note).toHaveValue('Keep this note')
        await page.locator('#graph-fail').click()
        await expect(page.locator('#graph-error')).toContainText('The example request failed')
        await expect(page.locator('#graph-transition')).toHaveText('Transition idle')
        await page.locator('#graph-recover').click()
        await expect(page.locator('#graph-error')).toHaveCount(0)
        await expect(page.locator('#graph-value')).toHaveText('Current result: Result 4')

        await page.locator('#graph-next').click()
        await expect(page.locator('#graph-loading')).toBeVisible()
        await page.locator('#graph-toggle').click()
        await expect(page.locator('#graph-content')).toHaveCount(0)
        await page.waitForTimeout(800)
        await expect(page.locator('#graph-content')).toHaveCount(0)
        await page.locator('#graph-toggle').click()
        await expect(page.locator('#graph-value')).toHaveText('Current result: Result 1')
        await expect(page.locator('#graph-note')).toHaveValue('')
        await expect(page.locator('h4')).toHaveText(['Building Scalable Apps'])
      }
    })
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error.message
  throw error
} finally {
  await browser?.close()
  await Promise.all(
    servers.map(
      server =>
        new Promise((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve())),
        ),
    ),
  )
  report.servedAssets = [...served.values()]
  report.finishedAt = new Date().toISOString()
  await writeFile(
    path.join(output, 'application-browser.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
}
