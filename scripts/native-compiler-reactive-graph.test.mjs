import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const native = require(
  process.env.FICT_COMPILER_NATIVE_PATH ??
    path.join(root, 'target/release/fict_compiler_napi.node'),
)
const ts = require('typescript')
const abi = JSON.parse(readFileSync(path.join(root, 'packages/runtime/runtime-abi.json'), 'utf8'))
const exportsToKeys = new Map(abi.helpers.map(helper => [helper.export, helper.key]))
const source = `import { $state } from 'fict';
export function App() { let count=$state(1); const doubled=count*2;
return <div><button onClick={()=>count++}>更新</button><span>{doubled}</span></div> }`
const profiles = [
  { optimize: false, optimizeLevel: 'safe' },
  { optimize: true, optimizeLevel: 'safe' },
  { optimize: true, optimizeLevel: 'full' },
].flatMap(profile =>
  [true, false].flatMap(fineGrainedDom =>
    ['module', 'commonjs'].map(moduleKind => ({ ...profile, fineGrainedDom, moduleKind })),
  ),
)

function compile(code = source, profile = {}, explain = true) {
  const { moduleKind = 'module', ...options } = profile
  return native.transformSync({
    code,
    filename: '/graph.tsx',
    moduleKind,
    options: { dev: false, strictGuarantee: true, sourcemap: true, ...options, explain },
  })
}

function success(result) {
  assert.ok(result.code, JSON.stringify(result.diagnostics))
  assert.ok(
    !result.diagnostics.some(diagnostic => diagnostic.severity === 'error'),
    JSON.stringify(result.diagnostics),
  )
  const graph = result.explain?.reactiveGraph
  assert.ok(graph, 'successful explain output must contain a graph')
  assert.equal(graph.version, 1)
  assert.equal(graph.scope, 'main-module')
  assert.equal(graph.sourceAnchorsVerified, true)
  return graph
}

function decision(graph, name) {
  const binding = graph.bindings.find(binding => binding.name === name)
  assert.ok(binding, `missing source binding ${name}`)
  return graph.decisions.find(decision => decision.binding === binding.id)
}

// Independent TypeScript parse and lexical binding resolution of the final JavaScript.
// This oracle never uses the native trace to locate or classify a call.
function census(code) {
  const file = ts.createSourceFile(
    '/output.js',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  )
  const host = {
    ...ts.createCompilerHost({ allowJs: true, noLib: true }),
    getSourceFile: name => (name === '/output.js' ? file : undefined),
    writeFile() {},
  }
  const program = ts.createProgram(['/output.js'], { allowJs: true, noLib: true }, host)
  const checker = program.getTypeChecker()
  const direct = new Map(),
    namespaces = new Map()
  const unparen = node => (ts.isParenthesizedExpression(node) ? unparen(node.expression) : node)
  const requiredModule = node => {
    if (!node) return null
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      ts.isStringLiteral(node.arguments[0])
    )
      return node.arguments[0].text
    let found = null
    ts.forEachChild(node, child => {
      found ??= requiredModule(child)
    })
    return found
  }
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      /^(fict|@fictjs\/runtime)\/internal(?:\/list)?$/.test(statement.moduleSpecifier.text)
    ) {
      const bindings = statement.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings))
        for (const binding of bindings.elements) {
          const helper = exportsToKeys.get((binding.propertyName ?? binding.name).text)
          if (helper) direct.set(checker.getSymbolAtLocation(binding.name), helper)
        }
    }
    if (ts.isVariableStatement(statement))
      for (const variable of statement.declarationList.declarations) {
        const module = requiredModule(variable.initializer)
        if (
          ts.isIdentifier(variable.name) &&
          /^__fict_cjs_import(?:_\d+)?$/.test(variable.name.text) &&
          module &&
          /^(fict|@fictjs\/runtime)\/internal(?:\/list)?$/.test(module)
        )
          namespaces.set(checker.getSymbolAtLocation(variable.name), module)
      }
  }
  function helperFor(node) {
    node = unparen(node)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken)
      return helperFor(node.right)
    if (ts.isIdentifier(node)) return direct.get(checker.getSymbolAtLocation(node))
    if (
      ts.isPropertyAccessExpression(node) &&
      namespaces.has(checker.getSymbolAtLocation(node.expression))
    )
      return exportsToKeys.get(node.name.text)
    return undefined
  }
  const bytes = offset => Buffer.byteLength(code.slice(0, offset))
  const calls = [],
    owners = []
  function functionStart(node) {
    // TS includes export modifiers and method keys in function-like nodes; OXC's
    // Function node begins at the function syntax or a method's parameter list.
    if (
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessor(node) ||
      ts.isSetAccessor(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      return node
        .getChildren(file)
        .find(child => child.kind === ts.SyntaxKind.OpenParenToken)
        .getStart(file)
    }
    if (ts.isFunctionDeclaration(node)) {
      const scanner = ts.createScanner(
        ts.ScriptTarget.Latest,
        true,
        ts.LanguageVariant.Standard,
        code,
      )
      scanner.setTextPos(node.getStart(file))
      let token = scanner.scan()
      while (token === ts.SyntaxKind.ExportKeyword || token === ts.SyntaxKind.DefaultKeyword)
        token = scanner.scan()
      return scanner.getTokenPos()
    }
    return node.getStart(file)
  }
  function visit(node, owner = null) {
    if (ts.isFunctionLike(node)) {
      const id = owners.length
      owners.push({ id, parent: owner, start: bytes(functionStart(node)), end: bytes(node.end) })
      owner = id
    }
    if (ts.isCallExpression(node)) {
      const helper = helperFor(node.expression)
      if (helper)
        calls.push({ helper, start: bytes(node.getStart(file)), end: bytes(node.end), owner })
    }
    ts.forEachChild(node, child => visit(child, owner))
  }
  visit(file)
  return { calls, owners }
}

for (const profile of profiles)
  test(`final-output graph is observational and exact: ${JSON.stringify(profile)}`, () => {
    const result = compile(source, profile)
    const graph = success(result)
    const plain = compile(source, profile, false)
    assert.equal(plain.explain, null)
    for (const key of ['code', 'map', 'diagnostics', 'moduleMetadata', 'artifacts'])
      assert.deepEqual(result[key], plain[key], key)
    assert.deepEqual(graph, success(compile(source, profile)), 'deterministic graph')
    const expected = census(result.code)
    assert.deepEqual(
      graph.calls.map(call => ({
        helper: call.helper,
        start: call.span.start,
        end: call.span.end,
        owner: call.owner,
      })),
      expected.calls,
    )
    assert.deepEqual(
      graph.owners.map(owner => ({
        id: owner.id,
        parent: owner.parent,
        start: owner.span.start,
        end: owner.span.end,
      })),
      expected.owners,
    )
    assert.equal(graph.counters['output.function-sites'], expected.owners.length)
    for (const helper of exportsToKeys.values())
      assert.equal(
        graph.counters[`output.helper.${helper}`] ?? 0,
        expected.calls.filter(call => call.helper === helper).length,
        helper,
      )
    const doubled = graph.bindings.find(binding => binding.name === 'doubled')
    assert.equal(doubled.references.length, 1, 'authored references do not count namespace copies')
    const slice = span => Buffer.from(source).subarray(span.start, span.end).toString()
    assert.equal(slice(doubled.references[0].span), 'doubled')
    assert.equal(slice(doubled.declaration), 'doubled')
    const selected = decision(graph, 'doubled')
    assert.equal(selected.action, profile.optimize ? 'inline' : 'retain')
    assert.equal(
      selected.reason,
      profile.optimize ? 'single-scalar-jsx-consumer' : 'optimizer-disabled',
    )
    assert.equal(graph.counters['emit.operation.create-derived'], 1)
    assert.equal(graph.counters['output.helper.useMemo'] ?? 0, profile.optimize ? 0 : 1)
    assert.ok(
      graph.calls.some(call =>
        call.operations.some(id => graph.operations[id].kind === 'create-reactive'),
      ),
      'signal call links to its EmitIR operation',
    )
    assert.ok(
      graph.owners.some(owner => owner.function !== null),
      'authored functions link to output owners',
    )
    const count = graph.bindings.find(binding => binding.name === 'count')
    assert.ok(count.references.some(reference => reference.write))
    assert.equal(graph.fusion, 'not-attempted:no-general-fusion-pass')
  })

test('retention decisions distinguish policy, shared consumers, unused work and uncertain movement', () => {
  const policy = success(compile(source, { inlineDerivedMemos: false }))
  assert.equal(decision(policy, 'doubled').reason, 'name-inline-policy-disabled')
  const shared = success(
    compile(source.replace('<span>{doubled}</span>', '<span>{doubled}{doubled}</span>')),
  )
  assert.equal(decision(shared, 'doubled').reason, 'multiple-authored-references')
  const unused = success(compile(source.replace('<span>{doubled}</span>', '<span>unused</span>')))
  assert.equal(decision(unused, 'doubled').reason, 'unused-memo-elimination-not-implemented')
  const uncertain = success(
    compile(
      `import {$state} from 'fict'; function Child(props){return <i>{props.value}</i>} export function App(){let count=$state(1);const value=count*2; return <Child value={value}/>}`,
    ),
  )
  assert.equal(decision(uncertain, 'value').reason, 'movement-or-lifetime-proof-not-established')
  const uncached = success(
    compile(source.replace('function App() {', 'function App() { "use no memo";')),
  )
  assert.equal(decision(uncached, 'doubled').action, 'accessor')
  assert.equal(uncached.counters['output.helper.useMemo'] ?? 0, 0)
})

test('explicit memo and async state plans are preserved and observable', () => {
  const result = compile(
    `import {$state,$memo,$async} from 'fict'; export function App(){let count=$state(1);const explicit=$memo(()=>count*2); const future=$async(()=>Promise.resolve(count));return <span>{explicit}{future}</span>}`,
  )
  const graph = success(result)
  assert.equal(decision(graph, 'explicit').reason, 'authored-reactive-creation')
  assert.equal(decision(graph, 'explicit').action, 'preserve')
  assert.ok(graph.functions.flatMap(fn => fn.slots).some(slot => slot.kind === 'Async'))
  assert.ok(graph.calls.some(call => call.helper.toLowerCase().includes('async')))
})

test('binding identities exclude authored helper-name collisions and shadowed callees', () => {
  for (const moduleKind of ['module', 'commonjs']) {
    const code = source
      .replace(
        'export function App()',
        `const __fictUseMemo=()=>99;
      function fake(__fictUseSignal){return __fictUseSignal()}
      export function App()`,
      )
      .replace('const doubled=count*2;', 'const doubled=count*2; const snapshot=__fictUseMemo();')
    const result = compile(code, { moduleKind })
    const graph = success(result)
    assert.equal(graph.counters['output.helper.useMemo'] ?? 0, 0)
    assert.equal(graph.counters['output.helper.useSignal'], 1)
    assert.deepEqual(
      graph.calls.map(call => ({
        helper: call.helper,
        start: call.span.start,
        end: call.span.end,
        owner: call.owner,
      })),
      census(result.code).calls,
    )
  }
})

test('errors omit a successful-emission graph and preserve diagnostics', () => {
  const code = `import {$state} from 'fict'; import {opaque} from 'external'; export function App(){let count=$state(1); const result=opaque(count);return <span>{result}</span>}`
  const explained = compile(code),
    plain = compile(code, {}, false)
  assert.equal(explained.code, '')
  assert.equal(explained.explain?.reactiveGraph, undefined)
  assert.deepEqual(explained.diagnostics, plain.diagnostics)
})

test('worker-pool compilation returns the same deterministic graph', async () => {
  const request = {
    code: source,
    filename: '/graph.tsx',
    options: { dev: false, strictGuarantee: true, explain: true },
  }
  assert.deepEqual(success(await native.transform(request)), success(native.transformSync(request)))
})

test('the explanation graph obeys the existing bounded result-payload contract', () => {
  const request = {
    code: source,
    filename: '/graph.tsx',
    limits: { maxOutputBytes: 4096 },
    options: { dev: false, strictGuarantee: true },
  }
  const plain = native.transformSync(request)
  assert.ok(plain.code, JSON.stringify(plain.diagnostics))
  const traced = native.transformSync({
    ...request,
    options: { ...request.options, explain: true },
  })
  assert.equal(traced.code, '')
  assert.equal(traced.explain?.reactiveGraph, undefined)
  assert.equal(traced.diagnostics[0]?.code, 'FICT-REQUEST')
  assert.match(traced.diagnostics[0]?.message, /maxOutputBytes/)
})

test('the documented public API works through distributed ESM and CommonJS entries', async () => {
  const guide = readFileSync(path.join(root, 'docs/reactive-graph-trace.md'), 'utf8')
  const example = guide.match(/```ts\n([\s\S]*?)\n```/)?.[1]
  assert.ok(example)
  const executable = ts.transpileModule(example, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText
  for (const compiler of [
    require(path.join(root, 'packages/compiler/dist/index.cjs')),
    await import(pathToFileURL(path.join(root, 'packages/compiler/dist/index.js')).href),
  ]) {
    let graph
    new Function('require', 'exports', 'console', executable)(
      name => {
        assert.equal(name, '@fictjs/compiler')
        return compiler
      },
      {},
      {
        log(value) {
          graph = value
        },
      },
    )
    assert.equal(decision(graph, 'doubled').action, 'inline')
    assert.equal(graph.counters['output.helper.useMemo'] ?? 0, 0)
  }
})

test('captured slots retain a machine-readable source owner', () => {
  const graph = success(
    compile(`import {$state} from 'fict';
    export function App(){let count=$state(1); function Child(){return <b>{count}</b>}
      return <section><Child/></section>}`),
  )
  const captured = graph.functions
    .flatMap(fn => fn.slots)
    .filter(slot => slot.storage === 'captured')
  assert.ok(captured.length)
  for (const slot of captured) {
    const owner = graph.functions.find(fn => fn.id === slot.owner)
    assert.ok(
      owner?.slots.some(
        candidate => candidate.binding === slot.binding && candidate.storage === 'owned',
      ),
    )
  }
})

test('effect and event plans explain their retained work and actual cleanup scope', () => {
  const graph = success(
    compile(
      source
        .replace('{ $state }', '{ $state, $effect }')
        .replace('const doubled=count*2;', 'const doubled=count*2; $effect(()=>count);'),
    ),
  )
  const effect = graph.operations.find(operation => operation.kind === 'register-effect')
  assert.equal(effect.purpose, 'explicit-effect-order-and-cleanup')
  assert.ok(effect.cleanup)
  const event = graph.operations.find(operation => operation.kind === 'bind-event')
  assert.equal(event.purpose, 'event-handler-lifetime')
  assert.ok(event.cleanup)
  for (const operation of [effect, event]) {
    const fn = graph.functions.find(fn => fn.id === operation.function)
    if (operation.cleanup.kind === 'function') assert.equal(operation.cleanup.id, fn.id)
    else if (operation.cleanup.kind === 'slot')
      assert.ok(fn.slots.some(slot => slot.id === operation.cleanup.id))
    else assert.ok(fn.regions.includes(operation.cleanup.id))
  }
})

test('tracing preserves every frozen request and reconciles accepted source anchors', context => {
  let visited = 0,
    traced = 0
  for (const file of [
    'rust_frozen_codegen_corpus.json',
    'legacy_unrepresented_callsite_replay.json',
  ]) {
    const corpus = JSON.parse(
      readFileSync(path.join(root, 'crates/fict-compiler/tests', file), 'utf8'),
    )
    for (const fixture of corpus.fixtures) {
      const request = fixture.request ?? {
        code: fixture.source,
        filename: '/fixtures/legacy-0.28-corpus.tsx',
        options: fixture.options,
      }
      const plain = native.transformSync({
        ...request,
        options: { ...request.options, explain: false },
      })
      const result = native.transformSync({
        ...request,
        options: { ...request.options, explain: true },
      })
      for (const key of [
        'code',
        'map',
        'diagnostics',
        'moduleMetadata',
        'metadataDependencies',
        'unresolvedMetadataRequests',
        'metadataIncomplete',
        'artifacts',
      ]) {
        assert.deepEqual(result[key], plain[key], `${fixture.id}: ${key}`)
      }
      if (result.explain?.reactiveGraph) {
        const graph = result.explain.reactiveGraph
        assert.equal(graph.sourceAnchorsVerified, true, fixture.id)
        for (const call of graph.calls) {
          assert.ok(
            call.span.start < call.span.end && call.span.end <= Buffer.byteLength(result.code),
            fixture.id,
          )
          if (call.owner !== null) {
            const owner = graph.owners[call.owner]
            assert.ok(
              owner.span.start <= call.span.start && owner.span.end >= call.span.end,
              fixture.id,
            )
          }
          for (const id of call.operations)
            assert.equal(graph.operations[id].helper, call.helper, fixture.id)
        }
        traced++
      }
      visited++
    }
  }
  assert.equal(visited, 3172)
  assert.ok(traced > 1000, `only ${traced} requests produced graph traces`)
  context.diagnostic(JSON.stringify({ requests: visited, traces: traced }))
})
