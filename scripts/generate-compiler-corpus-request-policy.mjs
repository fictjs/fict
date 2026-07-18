#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { format, resolveConfig } from 'prettier'

import { buildCorpusRequestPolicy } from './lib/compiler-corpus-request-policy.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const defaultOutput = path.join(
  repositoryRoot,
  'scripts/fixtures/compiler_corpus_request_policy.json',
)

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Expected --name value arguments, received ${argv.slice(index).join(' ')}`)
    }
    options[name.slice(2)] = value
  }
  const unknown = Object.keys(options).filter(
    name => !['input', 'legacy-root', 'output'].includes(name),
  )
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(', ')}`)
  if (!options.input) throw new Error('--input is required')
  if (!options['legacy-root']) throw new Error('--legacy-root is required')
  return {
    input: path.resolve(options.input),
    legacyRoot: path.resolve(options['legacy-root']),
    output: path.resolve(options.output ?? defaultOutput),
  }
}

const options = parseArguments(process.argv.slice(2))
const inputText = readFileSync(options.input, 'utf8')
const inputSha256 = createHash('sha256').update(inputText).digest('hex')
if (inputSha256 !== '676b022516c01b525d7e2a316e5b072eae2ee1532b2bb103573543900f13b67f') {
  throw new Error(`unexpected batch differential input ${inputSha256}`)
}
const legacyRequire = createRequire(path.join(options.legacyRoot, 'packages/compiler/package.json'))
const review = buildCorpusRequestPolicy({
  audit: JSON.parse(inputText),
  legacyRoot: options.legacyRoot,
  babel: legacyRequire('@babel/core'),
  traverse: legacyRequire('@babel/traverse').default,
})
writeFileSync(
  options.output,
  await format(JSON.stringify(review, null, 2), {
    ...(await resolveConfig(defaultOutput)),
    filepath: defaultOutput,
    parser: 'json',
  }),
)
process.stdout.write(
  `${JSON.stringify({ output: options.output, strictTrueVariants: review.strictTrueVariants, strictTrueVariantSources: review.strictTrueVariantSources })}\n`,
)
