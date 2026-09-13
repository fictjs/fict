import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { chromium } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const nativePath = path.join(root, 'target/release/fict_compiler_napi.node')
const native = require(nativePath)
const { build } = createRequire(require.resolve('@size-limit/esbuild'))('esbuild')
const hash = value => createHash('sha256').update(value).digest('hex')
const profiles = [
  { optimize: false, optimizeLevel: 'safe' },
  { optimize: true, optimizeLevel: 'safe' },
  { optimize: true, optimizeLevel: 'full' },
].flatMap(profile => [true, false].map(fineGrainedDom => ({ ...profile, fineGrainedDom })))

test(
  'production browsers preserve single-consumer values, identity and ownership',
  { timeout: 90_000 },
  async () => {
    const filename = path.join(root, 'scripts/fixtures/jsx-memo-inline/App.tsx')
    const source = await readFile(filename, 'utf8')
    const bundles = new Map()
    const builds = []
    for (const profile of profiles)
      for (const equal of [false, true]) {
        const code = equal
          ? source.replace('count * 2', 'count % 2').replace('count++', 'count += 2')
          : source
        const options = { dev: false, strictGuarantee: true, ...profile }
        const result = native.transformSync({ code, filename, options })
        assert.deepEqual(result.diagnostics, [])
        assert.equal(
          /const value = .*__fictUseMemo/.test(result.code),
          !profile.optimize,
          result.code,
        )
        const entry = `${result.code}\nwindow.stop = mount(document.getElementById('app'), null, {svg: location.search.includes('svg=1')}); window.inspect = observe;`
        const output = await build({
          stdin: {
            contents: entry,
            resolveDir: path.join(root, 'packages/fict'),
            sourcefile: 'jsx-inline.mjs',
          },
          bundle: true,
          write: false,
          format: 'esm',
          platform: 'browser',
          minify: true,
          target: 'es2022',
          tsconfigRaw: { compilerOptions: {} },
          metafile: true,
          define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' },
        })
        const inputs = Object.keys(output.metafile.inputs)
        assert.ok(inputs.some(input => input.includes('packages/runtime/dist/')))
        assert.ok(!inputs.some(input => /packages\/(?:runtime|fict)\/src\//.test(input)))
        const id = String(builds.length)
        const bundle = output.outputFiles[0].text
        bundles.set(`/bundle/${id}.js`, bundle)
        builds.push({
          id,
          equal,
          options,
          sourceSha256: hash(code),
          codeSha256: hash(result.code),
          bundleSha256: hash(bundle),
          inputs,
        })
      }
    let server, browser
    const errors = []
    const cases = []
    try {
      server = createServer((request, response) => {
        const url = new URL(request.url, 'http://localhost')
        const bundle = bundles.get(url.pathname)
        if (bundle) {
          response.writeHead(200, { 'Content-Type': 'text/javascript' })
          response.end(bundle)
        } else if (/^\/page\/\d+$/.test(url.pathname)) {
          const id = url.pathname.split('/').at(-1)
          response.writeHead(200, { 'Content-Type': 'text/html' })
          response.end(
            `<!doctype html><div id="app"></div><script type="module" src="/bundle/${id}.js"></script>`,
          )
        } else {
          response.writeHead(404)
          response.end()
        }
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const origin = `http://127.0.0.1:${server.address().port}`
      browser = await chromium.launch({ headless: true })
      for (const build of builds)
        for (const svg of [false, true]) {
          const page = await browser.newPage()
          page.on('pageerror', error => errors.push(String(error)))
          try {
            await page.goto(`${origin}/page/${build.id}?svg=${Number(svg)}`)
            await page.locator('#value').waitFor({ state: 'attached' })
            assert.equal(await page.locator('#value').textContent(), build.equal ? '1' : '2')
            await page.evaluate(() => {
              window.initialNode = document.querySelector('#value')
              window.initialNode.dataset.retained = 'yes'
            })
            await page.locator('#inc').dispatchEvent('click')
            assert.equal(await page.locator('#value').textContent(), build.equal ? '1' : '4')
            assert.equal(
              await page.evaluate(() => window.initialNode === document.querySelector('#value')),
              true,
            )
            assert.equal(await page.locator('#value').getAttribute('data-retained'), 'yes')
            assert.equal(await page.evaluate(() => window.inspect().cleaned), 0)
            await page.locator('#toggle').dispatchEvent('click')
            assert.equal(await page.locator('#value').count(), 0)
            await page.locator('#inc').dispatchEvent('click')
            await page.locator('#toggle').dispatchEvent('click')
            assert.equal(await page.locator('#value').textContent(), build.equal ? '1' : '6')
            assert.equal(
              await page.evaluate(() => window.initialNode === document.querySelector('#value')),
              false,
            )
            const namespace = svg ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml'
            assert.equal(await page.evaluate(() => window.inspect().namespace), namespace)
            await page.evaluate(() => window.stop())
            assert.deepEqual(await page.evaluate(() => window.inspect()), {
              text: null,
              namespace: null,
              cleaned: 1,
            })
            cases.push({ build: build.id, svg, status: 'passed' })
          } finally {
            await page.close()
          }
        }
      assert.deepEqual(errors, [])
      const report = {
        status: 'passed',
        compiler: native.nativeCompilerInfo(),
        nativeSha256: hash(await readFile(nativePath)),
        browser: browser.version(),
        sourceSha256: hash(source),
        builds,
        cases,
        errors,
      }
      await mkdir(path.join(root, 'test-results'), { recursive: true })
      await writeFile(
        path.join(root, 'test-results/jsx-memo-inline-browser.json'),
        JSON.stringify(report, null, 2) + '\n',
      )
    } finally {
      await browser?.close()
      if (server) await new Promise(resolve => server.close(resolve))
    }
  },
)
