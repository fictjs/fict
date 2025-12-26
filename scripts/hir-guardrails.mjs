#!/usr/bin/env node

/**
 * HIR Guardrails: compile fixed samples and report helper/region counts and size.
 * Useful for catching perf regressions or helper bloat before releases.
 */
import { transformSync } from '@babel/core'
import { createRequire } from 'module'
import { gzipSync } from 'zlib'

const require = createRequire(import.meta.url)
const { default: createFictPlugin } = require('../packages/compiler/dist/index.cjs')

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
    size: `${sizeBytes} B`,
    gzip: `${gzipBytes} B`,
  }
}

function main() {
  const rows = samples.map(runSample)
  console.log('HIR guardrail report:')
  console.table(rows)
}

try {
  main()
} catch (err) {
  console.error('[guardrails] Failed:', err)
  process.exitCode = 1
}
