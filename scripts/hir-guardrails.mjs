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
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const compilerDistPath = path.join(__dirname, '../packages/compiler/dist/index.cjs')
const baselinePath = path.join(__dirname, 'hir-guardrails.baseline.json')
const updateBaseline = process.argv.includes('--update')

const DEFAULT_BUDGETS = {
  sizeRegressionRatio: 0.02,
  sizeRegressionMinBytes: 16,
  gzipRegressionRatio: 0.05,
  gzipRegressionMinBytes: 32,
}

if (!fs.existsSync(compilerDistPath)) {
  console.error(`[guardrails] Missing compiler build artifact: ${compilerDistPath}`)
  console.error(
    '[guardrails] Run `pnpm --filter @fictjs/compiler build` before `pnpm guardrails:hir`.',
  )
  process.exit(1)
}

const { default: createFictPlugin } = require(compilerDistPath)

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
  {
    name: 'keyed-list-dom',
    description: 'Keyed list with dynamic class, style, and event bindings',
    source: `
      import { $state } from 'fict'
      export function Menu() {
        let selected = $state(1)
        const items = [1, 2, 3]
        return (
          <ul>
            {items.map(item => (
              <li
                key={item}
                class={{ active: item === selected }}
                style={{ order: item }}
                onClick={() => selected = item}
              >
                {item === selected ? <span>{selected}</span> : item}
              </li>
            ))}
          </ul>
        )
      }
    `,
  },
  {
    name: 'props-destructure-rest',
    description: 'Nested props destructuring with defaults and rest access',
    source: `
      export function Profile(props) {
        const {
          user: { name = 'Ada' } = {},
          title = 'Engineer',
          ...rest
        } = props
        return <section data-role={rest.role}>{title}: {name}</section>
      }
    `,
  },
  {
    name: 'cross-module-hook-metadata',
    description: 'Bare hook accessor metadata consumed across a module boundary',
    options: {
      resolveModuleMetadata: source =>
        source === 'counter-lib'
          ? {
              version: 1,
              exports: {},
              hooks: {
                useCounter: { directAccessor: 'signal' },
              },
            }
          : undefined,
    },
    source: `
      import { useCounter } from 'counter-lib'
      export function App() {
        const count = useCounter()
        return <div>{count}</div>
      }
    `,
  },
  {
    name: 'resumable-handler',
    description: 'Resumable event handler extraction with reactive state',
    options: { resumable: true },
    source: `
      import { $state } from 'fict'
      export function App() {
        let count = $state(0)
        return <button onClick$={() => count++}>{count}</button>
      }
    `,
  },
]

function runSample(sample) {
  const result = transformSync(sample.source, {
    filename: `${sample.name}.tsx`,
    plugins: [[createFictPlugin, { dev: false, sourcemap: false, ...(sample.options ?? {}) }]],
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
      budgets: baseline?.budgets ?? DEFAULT_BUDGETS,
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
    const budgets = { ...DEFAULT_BUDGETS, ...(baseline.budgets ?? {}) }
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
      const fields = ['helpers', 'regions']
      for (const field of fields) {
        if (row[field] !== expected[field]) {
          mismatches.push({
            name: row.name,
            reason: `${field} ${expected[field]} -> ${row[field]}`,
          })
        }
      }

      const sizeLimit = Math.max(
        expected.sizeBytes * (1 + budgets.sizeRegressionRatio),
        expected.sizeBytes + budgets.sizeRegressionMinBytes,
      )
      if (row.sizeBytes > sizeLimit) {
        mismatches.push({
          name: row.name,
          reason: `sizeBytes ${expected.sizeBytes} -> ${row.sizeBytes} exceeds budget ${Math.round(sizeLimit)}`,
        })
      }

      const gzipLimit = Math.max(
        expected.gzipBytes * (1 + budgets.gzipRegressionRatio),
        expected.gzipBytes + budgets.gzipRegressionMinBytes,
      )
      if (row.gzipBytes > gzipLimit) {
        mismatches.push({
          name: row.name,
          reason: `gzipBytes ${expected.gzipBytes} -> ${row.gzipBytes} exceeds budget ${Math.round(gzipLimit)}`,
        })
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
