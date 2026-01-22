#!/usr/bin/env node

/**
 * HIR Guardrails: compile fixed samples and report helper/region counts and size.
 * Useful for catching perf regressions or helper bloat before releases.
 */
import { transformSync } from '@babel/core'
import { createRequire } from 'module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'zlib'

const require = createRequire(import.meta.url)
const { default: createFictPlugin } = require('../packages/compiler/dist/index.cjs')

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const baselinePath = path.join(__dirname, 'hir-guardrails.baseline.json')
const updateBaseline = process.argv.includes('--update')

const samples = [
  {
    name: 'counter-basic',
    description: 'Simple counter with derived memo and JSX',
    source: `
      import { $state } from 'fict'
      function Counter() {
        let count = $state(0)
        const doubled = count * 2
        return <button onClick={() => count++}>{count} / {doubled}</button>
      }
      export default Counter
    `,
  },
  {
    name: 'optional-chain',
    description: 'Optional-chain read with property subscription',
    source: `
      function View(props) {
        const title = props.user?.profile?.title ?? 'N/A'
        return <div>{title}</div>
      }
      export default View
    `,
  },
  {
    name: 'no-jsx',
    description: 'No JSX / pure derived accessors',
    source: `
      import { $state } from 'fict'
      export function useCounter() {
        const count = $state(0)
        const doubled = count * 2
        return { count, doubled }
      }
    `,
  },
]

function runSample(sample) {
  const result = transformSync(sample.source, {
    filename: `${sample.name}.tsx`,
    plugins: [[createFictPlugin, { dev: false, sourcemap: false }]],
    presets: [['@babel/preset-typescript', { isTSX: true, allExtensions: true }]],
    configFile: false,
    babelrc: false,
  })

  if (!result?.code) {
    throw new Error(`No output for sample ${sample.name}`)
  }

  const { code } = result
  const helperMatches = code.match(/__fict[A-Za-z0-9_]*/g) ?? []
  const helpers = new Set(helperMatches)
  const regionMatches = code.match(/__region_\d+/g) ?? []
  const regions = new Set(regionMatches)

  const sizeBytes = Buffer.byteLength(code, 'utf8')
  const gzipBytes = gzipSync(code).byteLength

  return {
    name: sample.name,
    description: sample.description,
    helpers: helpers.size,
    regions: regions.size,
    sizeBytes,
    gzipBytes,
  }
}

function main() {
  const rows = samples.map(runSample)
  const baseline = fs.existsSync(baselinePath)
    ? JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
    : null

  if (updateBaseline) {
    const payload = {
      samples: Object.fromEntries(
        rows.map(row => [
          row.name,
          {
            helpers: row.helpers,
            regions: row.regions,
            sizeBytes: row.sizeBytes,
            gzipBytes: row.gzipBytes,
          },
        ]),
      ),
    }
    fs.writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    console.log(`HIR guardrail baseline updated at ${baselinePath}`)
  } else if (!baseline) {
    throw new Error(`Missing baseline at ${baselinePath}. Run with --update to generate.`)
  } else {
    const mismatches = []
    const expectedSamples = new Set(Object.keys(baseline.samples ?? {}))
    const actualSamples = new Set(rows.map(row => row.name))

    for (const name of expectedSamples) {
      if (!actualSamples.has(name)) {
        mismatches.push({ name, reason: 'missing sample' })
      }
    }
    for (const row of rows) {
      const expected = baseline.samples?.[row.name]
      if (!expected) {
        mismatches.push({ name: row.name, reason: 'unexpected sample' })
        continue
      }
      const fields = ['helpers', 'regions', 'sizeBytes', 'gzipBytes']
      for (const field of fields) {
        if (row[field] !== expected[field]) {
          mismatches.push({
            name: row.name,
            reason: `${field} ${expected[field]} -> ${row[field]}`,
          })
        }
      }
    }

    if (mismatches.length > 0) {
      console.error('HIR guardrail mismatches detected:')
      console.table(mismatches)
      process.exitCode = 1
    }
  }

  const reportRows = rows.map(row => ({
    name: row.name,
    description: row.description,
    helpers: row.helpers,
    regions: row.regions,
    size: `${row.sizeBytes} B`,
    gzip: `${row.gzipBytes} B`,
  }))
  console.log('HIR guardrail report:')
  console.table(reportRows)
}

try {
  main()
} catch (err) {
  console.error('[guardrails] Failed:', err)
  process.exitCode = 1
}
