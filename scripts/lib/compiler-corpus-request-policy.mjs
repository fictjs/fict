import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

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

function propertyName(property) {
  if (property.type === 'Identifier') return property.name
  if (property.type === 'StringLiteral') return property.value
  return null
}

function strictGuaranteeValues(node, scope, seenBindings = new Set()) {
  if (!node) return []
  if (
    [
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TypeCastExpression',
      'TSNonNullExpression',
    ].includes(node.type)
  ) {
    return strictGuaranteeValues(node.expression, scope, seenBindings)
  }
  if (node.type === 'Identifier') {
    const binding = scope.getBinding(node.name)
    if (!binding || seenBindings.has(binding)) return []
    const nextSeen = new Set(seenBindings).add(binding)
    const initializer = binding.path.isVariableDeclarator() ? binding.path.node.init : null
    return strictGuaranteeValues(initializer, binding.path.scope, nextSeen)
  }
  if (node.type === 'ObjectExpression') {
    const values = []
    for (const property of node.properties) {
      if (property.type === 'SpreadElement') {
        values.push(...strictGuaranteeValues(property.argument, scope, new Set(seenBindings)))
      } else if (
        property.type === 'ObjectProperty' &&
        propertyName(property.key) === 'strictGuarantee' &&
        property.value.type === 'BooleanLiteral'
      ) {
        values.push(property.value.value)
      } else if (property.type === 'ObjectProperty') {
        values.push(...strictGuaranteeValues(property.value, scope, new Set(seenBindings)))
      }
    }
    return values
  }
  if (node.type === 'ArrayExpression') {
    return node.elements.flatMap(element =>
      strictGuaranteeValues(element, scope, new Set(seenBindings)),
    )
  }
  if (node.type === 'CallExpression' || node.type === 'NewExpression') {
    return node.arguments.flatMap(argument =>
      strictGuaranteeValues(
        argument.type === 'SpreadElement' ? argument.argument : argument,
        scope,
        new Set(seenBindings),
      ),
    )
  }
  if (node.type === 'ConditionalExpression') {
    return [
      ...strictGuaranteeValues(node.consequent, scope, new Set(seenBindings)),
      ...strictGuaranteeValues(node.alternate, scope, new Set(seenBindings)),
    ]
  }
  return []
}

function callName(node) {
  if (node.callee.type === 'Identifier') return node.callee.name
  if (
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.property.type === 'Identifier'
  ) {
    return node.callee.property.name
  }
  return null
}

export function buildCorpusRequestPolicy({ audit, legacyRoot, babel, traverse }) {
  const testRoot = path.join(legacyRoot, 'packages/compiler/test')
  const testFiles = readdirSync(testRoot)
    .filter(file => file.endsWith('.test.ts'))
    .map(file => `packages/compiler/test/${file}`)
  const rowsByFile = new Map()
  for (const row of audit.results) {
    const rows = rowsByFile.get(row.fixture.file) ?? []
    rows.push(row)
    rowsByFile.set(row.fixture.file, rows)
  }

  const variants = []
  let matchedFixtures = 0
  for (const [relativeFile, rows] of rowsByFile) {
    const absoluteFile = path.join(legacyRoot, relativeFile)
    const source = readFileSync(absoluteFile, 'utf8')
    const ast = babel.parseSync(source, {
      filename: absoluteFile,
      configFile: false,
      babelrc: false,
      sourceType: 'module',
      parserOpts: { plugins: ['typescript', 'jsx', 'decorators'] },
    })
    const calls = []
    traverse(ast, {
      CallExpression(callPath) {
        calls.push(callPath)
      },
    })
    for (const row of rows) {
      const { callee, line } = row.fixture
      const matches = calls.filter(
        callPath => callPath.node.loc?.start.line === line && callName(callPath.node) === callee,
      )
      if (matches.length !== 1) {
        throw new Error(
          `${relativeFile}:${line}:${callee} matched ${matches.length} legacy calls instead of one`,
        )
      }
      matchedFixtures++
      const callPath = matches[0]
      const values = callPath.node.arguments.flatMap(argument =>
        strictGuaranteeValues(
          argument.type === 'SpreadElement' ? argument.argument : argument,
          callPath.scope,
        ),
      )
      if (values.includes(true) && values.includes(false)) {
        throw new Error(`${relativeFile}:${line}:${callee} has conflicting strictGuarantee values`)
      }
      let sourceKind = null
      if (values.at(-1) === true) sourceKind = 'explicit-true'
      else if (values.length === 0 && callee === 'transformWithCompilerDefaults') {
        sourceKind = 'compiler-default-true'
      }
      if (sourceKind === null) continue
      const baseId = `${relativeFile}:${line}:${callee}`
      variants.push({
        id: `${baseId}:strictGuarantee=true`,
        baseId,
        source: sourceKind,
      })
    }
  }

  const sourceCounts = Object.fromEntries(
    ['explicit-true', 'compiler-default-true'].map(source => [
      source,
      variants.filter(variant => variant.source === source).length,
    ]),
  )
  return {
    schemaVersion: 1,
    sourceAuditSha256: '676b022516c01b525d7e2a316e5b072eae2ee1532b2bb103573543900f13b67f',
    legacyRelease: '0.28.0',
    legacyRevision: 'b99ff5b185e3eed701e2d4f3521832dac67c979f',
    legacyTestSourceSha256: sourceTreeSha256(legacyRoot, testFiles),
    scannedLegacyTestFiles: testFiles.length,
    matchedBaseFixtures: matchedFixtures,
    baselineStrictFalseFixtures: audit.results.length,
    strictTrueVariants: variants.length,
    strictTrueVariantSources: sourceCounts,
    variants,
  }
}
