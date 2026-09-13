// Observe real bundler requests without changing native identity, policy or results.
const assert = require('node:assert/strict')
const { appendFileSync } = require('node:fs')
const path = require('node:path')
const { threadId } = require('node:worker_threads')

assert.ok(process.env.FICT_CORPUS_NATIVE, 'Missing underlying native addon')
assert.ok(process.env.FICT_CORPUS_JOURNAL, 'Missing compiler journal directory')
const binding = require(process.env.FICT_CORPUS_NATIVE)
const filename = path.join(process.env.FICT_CORPUS_JOURNAL, `${process.pid}-${threadId}.jsonl`)
let sequence = 0

module.exports = { ...binding }
for (const method of ['transform', 'transformSync', 'analyze', 'analyzeSync', 'scan', 'scanSync']) {
  module.exports[method] = function (request) {
    const id = ++sequence
    // Serialize before invocation: a host cannot rewrite the recorded request afterwards.
    const requestJson = JSON.stringify(request)
    const record = (result, error) => {
      appendFileSync(
        filename,
        JSON.stringify({
          phase: process.env.FICT_CORPUS_PHASE,
          pid: process.pid,
          threadId,
          id,
          method,
          request: JSON.parse(requestJson),
          result,
          error: error ? { name: error.name, message: error.message } : undefined,
        }) + '\n',
      )
    }
    let result
    try {
      result = binding[method](request)
    } catch (error) {
      record(undefined, error)
      throw error
    }
    if (method.endsWith('Sync')) {
      record(result)
      return result
    }
    return result.then(
      value => {
        record(value)
        return value
      },
      error => {
        record(undefined, error)
        throw error
      },
    )
  }
}
