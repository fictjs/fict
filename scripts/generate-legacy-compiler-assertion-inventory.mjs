#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { format, resolveConfig } from 'prettier'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const defaultOutput = path.join(
  repositoryRoot,
  'scripts/fixtures/legacy_0_28_compiler_assertion_inventory.json',
)
const expectedAuditSha256 = '676b022516c01b525d7e2a316e5b072eae2ee1532b2bb103573543900f13b67f'
const legacyRevision = 'b99ff5b185e3eed701e2d4f3521832dac67c979f'

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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sourceTreeSha256(root, files) {
  const hash = createHash('sha256')
  for (const file of [...files].sort()) {
    hash.update(file)
    hash.update('\0')
    hash.update(readFileSync(path.join(root, file)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function unwrapExpression(node) {
  let current = node
  while (
    current &&
    [
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TypeCastExpression',
      'TSNonNullExpression',
    ].includes(current.type)
  ) {
    current = current.expression
  }
  return current
}

function staticMemberName(node) {
  if (!node || !['MemberExpression', 'OptionalMemberExpression'].includes(node.type)) return null
  if (!node.computed && node.property.type === 'Identifier') return node.property.name
  if (node.computed && node.property.type === 'StringLiteral') return node.property.value
  return null
}

function callName(node) {
  const callee = unwrapExpression(node.callee)
  if (callee?.type === 'Identifier') return callee.name
  return staticMemberName(callee)
}

function bindingIdentity(callPath, name) {
  const callee = unwrapExpression(callPath.node.callee)
  if (callee?.type === 'Identifier') {
    const binding = callPath.scope.getBinding(callee.name)
    if (!binding) return `unbound:${callee.name}`
    return `${binding.identifier.name}:${binding.identifier.start}:${binding.identifier.end}`
  }
  if (callee && ['MemberExpression', 'OptionalMemberExpression'].includes(callee.type)) {
    const object = unwrapExpression(callee.object)
    if (object?.type !== 'Identifier') return null
    const binding = callPath.scope.getBinding(object.name)
    const owner = binding
      ? `${binding.identifier.name}:${binding.identifier.start}:${binding.identifier.end}`
      : `unbound:${object.name}`
    return `${owner}.${name}`
  }
  return null
}

function testRegistration(callPath) {
  const callee = unwrapExpression(callPath.node.callee)
  if (callee?.type === 'Identifier' && ['it', 'test'].includes(callee.name)) {
    return { api: callee.name, modifier: null, parameterSource: null }
  }
  if (callee && ['MemberExpression', 'OptionalMemberExpression'].includes(callee.type)) {
    const object = unwrapExpression(callee.object)
    const modifier = staticMemberName(callee)
    if (
      object?.type === 'Identifier' &&
      ['it', 'test'].includes(object.name) &&
      modifier !== 'each'
    ) {
      return { api: object.name, modifier, parameterSource: null }
    }
  }
  if (callee?.type !== 'CallExpression' && callee?.type !== 'TaggedTemplateExpression') return null
  const eachCallee = unwrapExpression(callee.callee ?? callee.tag)
  if (!eachCallee || !['MemberExpression', 'OptionalMemberExpression'].includes(eachCallee.type)) {
    return null
  }
  const object = unwrapExpression(eachCallee.object)
  if (
    object?.type !== 'Identifier' ||
    !['it', 'test'].includes(object.name) ||
    staticMemberName(eachCallee) !== 'each'
  ) {
    return null
  }
  return {
    api: object.name,
    modifier: 'each',
    parameterSource: callee.type === 'CallExpression' ? callee.arguments[0] : callee.quasi,
  }
}

function functionNodeFromArgument(argumentPath) {
  const argument = unwrapExpression(argumentPath?.node)
  if (!argument) return null
  if (['ArrowFunctionExpression', 'FunctionExpression'].includes(argument.type)) return argument
  if (argument.type !== 'Identifier') return null
  const binding = argumentPath.scope.getBinding(argument.name)
  if (!binding) return null
  if (binding.path.isFunctionDeclaration()) return binding.path.node
  if (binding.path.isVariableDeclarator()) {
    const initializer = unwrapExpression(binding.path.node.init)
    if (
      initializer &&
      ['ArrowFunctionExpression', 'FunctionExpression'].includes(initializer.type)
    ) {
      return initializer
    }
  }
  return null
}

function arrayCaseCount(node) {
  const value = unwrapExpression(node)
  if (value?.type !== 'ArrayExpression') return null
  return value.elements.length
}

function parameterization(callPath, registration) {
  if (registration.modifier === 'each') {
    return {
      kind: 'each',
      staticCaseCount: arrayCaseCount(registration.parameterSource),
    }
  }
  const loop = callPath.findParent(
    candidate =>
      candidate.isForStatement() ||
      candidate.isForInStatement() ||
      candidate.isForOfStatement() ||
      candidate.isWhileStatement() ||
      candidate.isDoWhileStatement(),
  )
  if (!loop) return { kind: 'none', staticCaseCount: 1 }
  return {
    kind: 'lexical-loop',
    staticCaseCount: loop.isForOfStatement() ? arrayCaseCount(loop.node.right) : null,
  }
}

function invocationParameterization(callPath) {
  const loop = callPath.findParent(
    candidate =>
      candidate.isForStatement() ||
      candidate.isForInStatement() ||
      candidate.isForOfStatement() ||
      candidate.isWhileStatement() ||
      candidate.isDoWhileStatement(),
  )
  if (!loop) return { kind: 'none', staticCaseCount: 1 }
  let staticCaseCount = null
  if (loop.isForOfStatement()) {
    const right = loop.get('right')
    staticCaseCount = arrayCaseCount(right.node)
    if (staticCaseCount === null) {
      const evaluated = right.evaluate()
      if (evaluated.confident && Array.isArray(evaluated.value)) {
        staticCaseCount = evaluated.value.length
      }
    }
  }
  return { kind: 'lexical-loop', staticCaseCount }
}

function callsiteParameterization(callPath, owner) {
  const invocation = invocationParameterization(callPath)
  if (invocation.kind !== 'none' || !owner || owner.parameterization.kind === 'none') {
    return invocation
  }
  return owner.parameterization
}

function titleRecord(source, node) {
  if (!node) return { kind: 'missing', text: '' }
  if (node.type === 'StringLiteral') return { kind: 'literal', text: node.value }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return { kind: 'literal', text: node.quasis[0]?.value.cooked ?? '' }
  }
  return {
    kind: node.type === 'TemplateLiteral' ? 'template' : 'expression',
    text: source.slice(node.start, node.end).replaceAll(/\s+/g, ' ').trim().slice(0, 240),
  }
}

function assertionKind(callPath) {
  const callee = unwrapExpression(callPath.node.callee)
  if (callee?.type === 'Identifier' && callee.name === 'expect') return 'expect'
  if (!callee || !['MemberExpression', 'OptionalMemberExpression'].includes(callee.type)) {
    return null
  }
  const object = unwrapExpression(callee.object)
  if (object?.type !== 'Identifier' || object.name !== 'expect') return null
  const member = staticMemberName(callee)
  if (!member) return null
  return ['assertions', 'hasAssertions'].includes(member) ? 'expect-control' : `expect.${member}`
}

function sourceLocationId(relativeFile, node, suffix) {
  return `${relativeFile}:${node.loc.start.line}:${node.loc.start.column + 1}:${suffix}`
}

function containingTest(tests, node) {
  return tests
    .filter(test => test.callbackStart <= node.start && node.end <= test.callbackEnd)
    .sort(
      (left, right) =>
        left.callbackEnd - left.callbackStart - (right.callbackEnd - right.callbackStart),
    )[0]
}

function contextKind(corpusBaseIds, unrepresentedCompilerCallsites) {
  if (corpusBaseIds.length > 0 && unrepresentedCompilerCallsites.length > 0) {
    return 'partial-corpus-context'
  }
  if (corpusBaseIds.length > 0) return 'corpus-context-no-known-gap'
  if (unrepresentedCompilerCallsites.length > 0) return 'unrepresented-compiler-context'
  return 'no-direct-compiler-context'
}

const options = parseArguments(process.argv.slice(2))
const inputText = readFileSync(options.input, 'utf8')
assert.equal(sha256(inputText), expectedAuditSha256, 'unexpected batch differential input')
const audit = JSON.parse(inputText)
assert.equal(audit.summary.unique, 1_892)
assert.equal(audit.results.length, 1_892)

const legacyRequire = createRequire(path.join(options.legacyRoot, 'packages/compiler/package.json'))
const babel = legacyRequire('@babel/core')
const traverse = legacyRequire('@babel/traverse').default
const testRoot = path.join(options.legacyRoot, 'packages/compiler/test')
const testFiles = readdirSync(testRoot)
  .filter(file => file.endsWith('.test.ts'))
  .map(file => `packages/compiler/test/${file}`)
  .sort()
assert.equal(testFiles.length, 107)

const domainLedger = JSON.parse(
  readFileSync(
    path.join(repositoryRoot, 'scripts/fixtures/legacy_0_28_test_domain_coverage.json'),
    'utf8',
  ),
)
const domainByFile = new Map(domainLedger.domains.map(domain => [domain.legacyFile, domain.name]))
const auditRowsByFile = new Map()
for (const row of audit.results) {
  const rows = auditRowsByFile.get(row.fixture.file) ?? []
  rows.push(row)
  auditRowsByFile.set(row.fixture.file, rows)
}

const files = []
const assertions = []
const corpusCallsites = []
const unrepresentedCompilerCallsites = []
const unownedCorpusBaseIds = []
for (const relativeFile of testFiles) {
  const absoluteFile = path.join(options.legacyRoot, relativeFile)
  const source = readFileSync(absoluteFile, 'utf8')
  const ast = babel.parseSync(source, {
    filename: absoluteFile,
    configFile: false,
    babelrc: false,
    sourceType: 'module',
    parserOpts: { plugins: ['typescript', 'jsx', 'decorators'] },
  })
  const callPaths = []
  traverse(ast, {
    CallExpression(callPath) {
      callPaths.push(callPath)
    },
  })

  const rows = auditRowsByFile.get(relativeFile) ?? []
  const representedCalls = new Map()
  const compilerBindingIdentities = new Set()
  for (const row of rows) {
    const { callee, line } = row.fixture
    const matches = callPaths.filter(
      callPath => callPath.node.loc?.start.line === line && callName(callPath.node) === callee,
    )
    assert.equal(matches.length, 1, `${relativeFile}:${line}:${callee} source call match`)
    const baseId = `${relativeFile}:${line}:${callee}`
    representedCalls.set(matches[0].node, baseId)
    const identity = bindingIdentity(matches[0], callee)
    if (identity) compilerBindingIdentities.add(identity)
  }

  const tests = []
  for (const callPath of callPaths) {
    const registration = testRegistration(callPath)
    if (!registration) continue
    const callback = functionNodeFromArgument(callPath.get('arguments.1'))
    const modifier = registration.modifier ? `.${registration.modifier}` : ''
    const id = sourceLocationId(relativeFile, callPath.node, `${registration.api}${modifier}`)
    tests.push({
      id,
      line: callPath.node.loc.start.line,
      column: callPath.node.loc.start.column + 1,
      api: registration.api,
      modifier: registration.modifier,
      title: titleRecord(source, callPath.node.arguments[0]),
      parameterization: parameterization(callPath, registration),
      callbackStart: callback?.start ?? callPath.node.start,
      callbackEnd: callback?.end ?? callPath.node.end,
      corpusBaseIds: [],
      unrepresentedCompilerCallsites: [],
      assertionIds: [],
    })
  }

  const missedCalls = []
  for (const callPath of callPaths) {
    const name = callName(callPath.node)
    if (!name || representedCalls.has(callPath.node)) continue
    const identity = bindingIdentity(callPath, name)
    if (!identity || !compilerBindingIdentities.has(identity)) continue
    const id = sourceLocationId(relativeFile, callPath.node, name)
    const callsite = {
      id,
      file: relativeFile,
      line: callPath.node.loc.start.line,
      column: callPath.node.loc.start.column + 1,
      callee: name,
      testId: null,
    }
    missedCalls.push({ callPath, callsite })
  }

  for (const [node, baseId] of representedCalls) {
    const owner = containingTest(tests, node)
    if (owner) owner.corpusBaseIds.push(baseId)
    else unownedCorpusBaseIds.push(baseId)
    const callPath = callPaths.find(candidate => candidate.node === node)
    corpusCallsites.push({
      id: baseId,
      file: relativeFile,
      line: node.loc.start.line,
      column: node.loc.start.column + 1,
      callee: callName(node),
      testId: owner?.id ?? null,
      invocationParameterization: callsiteParameterization(callPath, owner),
    })
  }
  for (const { callPath, callsite } of missedCalls) {
    const owner = containingTest(tests, callPath.node)
    if (owner) {
      callsite.testId = owner.id
      owner.unrepresentedCompilerCallsites.push(callsite.id)
    }
    callsite.invocationParameterization = callsiteParameterization(callPath, owner)
    unrepresentedCompilerCallsites.push(callsite)
  }

  const fileAssertions = []
  for (const callPath of callPaths) {
    const kind = assertionKind(callPath)
    if (!kind) continue
    const owner = containingTest(tests, callPath.node)
    const assertion = {
      id: sourceLocationId(relativeFile, callPath.node, kind),
      file: relativeFile,
      line: callPath.node.loc.start.line,
      column: callPath.node.loc.start.column + 1,
      kind,
      testId: owner?.id ?? null,
      context: 'outside-test-declaration',
    }
    if (owner) owner.assertionIds.push(assertion.id)
    fileAssertions.push(assertion)
    assertions.push(assertion)
  }

  for (const test of tests) {
    test.corpusBaseIds.sort()
    test.unrepresentedCompilerCallsites.sort()
    test.assertionIds.sort()
    test.context = contextKind(test.corpusBaseIds, test.unrepresentedCompilerCallsites)
    delete test.callbackStart
    delete test.callbackEnd
  }
  const testContextById = new Map(tests.map(test => [test.id, test.context]))
  for (const assertion of fileAssertions) {
    if (assertion.testId) assertion.context = testContextById.get(assertion.testId)
  }

  const corpusBaseFixtureCount = rows.length
  const domainLedgerName = domainByFile.get(relativeFile) ?? null
  if (corpusBaseFixtureCount === 0) {
    assert.ok(domainLedgerName, `${relativeFile}: missing unrepresented-file domain ledger`)
  } else {
    assert.equal(domainLedgerName, null, `${relativeFile}: represented file also has domain ledger`)
  }
  files.push({
    file: relativeFile,
    domainLedgerName,
    corpusBaseFixtureCount,
    testDeclarationSiteCount: tests.length,
    staticAssertionCallsiteCount: fileAssertions.length,
    tests,
  })
}

assert.equal(unownedCorpusBaseIds.length, 0, 'every corpus base call belongs to a test declaration')
const allTests = files.flatMap(file => file.tests)
const testContextCounts = Object.fromEntries(
  [
    'corpus-context-no-known-gap',
    'partial-corpus-context',
    'unrepresented-compiler-context',
    'no-direct-compiler-context',
  ].map(context => [context, allTests.filter(test => test.context === context).length]),
)
const assertionContextCounts = Object.fromEntries(
  [
    'corpus-context-no-known-gap',
    'partial-corpus-context',
    'unrepresented-compiler-context',
    'no-direct-compiler-context',
    'outside-test-declaration',
  ].map(context => [context, assertions.filter(assertion => assertion.context === context).length]),
)
const parameterizationCounts = Object.fromEntries(
  ['none', 'each', 'lexical-loop'].map(kind => [
    kind,
    allTests.filter(test => test.parameterization.kind === kind).length,
  ]),
)
const corpusBaseIds = audit.results
  .map(row => `${row.fixture.file}:${row.fixture.line}:${row.fixture.callee}`)
  .sort()
assert.equal(new Set(corpusBaseIds).size, corpusBaseIds.length, 'duplicate corpus base identity')
const inventory = {
  schemaVersion: 1,
  baseline: {
    package: '@fictjs/compiler',
    release: '0.28.0',
    revision: legacyRevision,
    sourceAuditSha256: expectedAuditSha256,
    legacyTestSourceSha256: sourceTreeSha256(options.legacyRoot, testFiles),
    corpusBaseIdsSha256: sha256(corpusBaseIds.join('\n')),
  },
  claimBoundary: {
    inventoryUnit: 'static-test-and-expect-callsite',
    parameterizedRuntimeInstancesExpanded: false,
    corpusContextMeans:
      'The static test callback contains a frozen corpus request; it does not replay the legacy assertion.',
    unrepresentedCompilerCallsiteMeans:
      'The call uses the same lexical binding as a represented corpus callee but has no frozen audit row.',
    semanticAssertionParityProven: false,
  },
  summary: {
    legacyTestFiles: files.length,
    filesWithCorpusCalls: files.filter(file => file.corpusBaseFixtureCount > 0).length,
    filesWithoutCorpusCalls: files.filter(file => file.corpusBaseFixtureCount === 0).length,
    corpusBaseFixtures: corpusBaseIds.length,
    testDeclarationSites: allTests.length,
    staticAssertionCallsites: assertions.length,
    unrepresentedCompilerCallsites: unrepresentedCompilerCallsites.length,
    parameterizedCompilerCallsites: [...corpusCallsites, ...unrepresentedCompilerCallsites].filter(
      callsite => callsite.invocationParameterization.kind !== 'none',
    ).length,
    testContextCounts,
    assertionContextCounts,
    parameterizationCounts,
  },
  files,
  outsideTestAssertionIds: assertions
    .filter(assertion => assertion.testId === null)
    .map(assertion => assertion.id),
  parameterizedCorpusCallsites: corpusCallsites.filter(
    callsite => callsite.invocationParameterization.kind !== 'none',
  ),
  unrepresentedCompilerCallsites,
}

writeFileSync(
  options.output,
  await format(JSON.stringify(inventory, null, 2), {
    ...(await resolveConfig(defaultOutput)),
    filepath: defaultOutput,
    parser: 'json',
  }),
)
process.stdout.write(`${JSON.stringify({ output: options.output, ...inventory.summary })}\n`)
