import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export function extractHostRecipe(document) {
  const example = document
    .replace(/\r\n/g, '\n')
    .match(
      /<!-- executable-host-example:start -->\s*```js\n([\s\S]*?)\n```\s*<!-- executable-host-example:end -->/,
    )
  assert.ok(example, 'Missing executable custom host example')
  return example[1]
}

const boundarySource = `import { $state } from 'fict'
  import { external } from 'external'
  export function App() {
    let count = $state(0)
    const doubled = count * 2
    const result = external(doubled)
    return <p>{result}</p>
  }`

function expectBoundary(result, strict) {
  assert.ok(
    result.diagnostics.some(d => d.code === 'FICT-R002'),
    JSON.stringify(result),
  )
  assert.equal(
    result.diagnostics.find(d => d.code === 'FICT-R002').severity,
    strict ? 'error' : 'warning',
  )
  if ('code' in result) assert.equal(result.code.length === 0, strict)
}

export async function assertHostEnvironmentContract(compiler, native, nativeOptions) {
  const keys = ['NODE_ENV', 'FICT_STRICT_GUARANTEE']
  const previous = keys.map(key => process.env[key])
  const facade = native.createNativeCompilerFacade(nativeOptions)
  const raw = native.loadNativeCompilerBinding(nativeOptions)
  const request = {
    code: boundarySource,
    filename: '/host-policy.tsx',
    options: { strictGuarantee: false },
  }
  const analyzeRequest = {
    code: request.code,
    filename: request.filename,
    options: { compilerOptions: request.options },
  }
  let checked = 0
  try {
    // Reuse these same facades while the environment changes: policy is not a load-time cache.
    for (const [nodeEnv, strictEnv, expected] of [
      ['development', undefined, false],
      ['production', 'false', true],
      ['test', '1', true],
      ['test', 'off', false],
    ]) {
      process.env.NODE_ENV = nodeEnv
      if (strictEnv === undefined) delete process.env.FICT_STRICT_GUARANTEE
      else process.env.FICT_STRICT_GUARANTEE = strictEnv
      for (const host of [compiler, facade]) {
        expectBoundary(host.transformSync(request), expected)
        expectBoundary(await host.transform(request), expected)
        expectBoundary(host.analyzeSync(analyzeRequest), expected)
        expectBoundary(await host.analyze(analyzeRequest), expected)
        expectBoundary(host.transformSync({ ...request, options: {} }), true)
        checked += 5
      }
      // The raw protocol only sees serialized request options, even in production.
      expectBoundary(raw.transformSync(request), false)
      expectBoundary(raw.analyzeSync(analyzeRequest), false)
      const effective = compiler.applyCompileRequestEnvironmentPolicy(request)
      const effectiveAnalysis = compiler.applyAnalyzeRequestEnvironmentPolicy(analyzeRequest)
      expectBoundary(raw.transformSync(effective), expected)
      expectBoundary(await raw.transform(effective), expected)
      expectBoundary(raw.analyzeSync(effectiveAnalysis), expected)
      expectBoundary(await raw.analyze(effectiveAnalysis), expected)
      checked += 6
      assert.equal(request.options.strictGuarantee, false)
      assert.equal(analyzeRequest.options.compilerOptions.strictGuarantee, false)
    }
    const buildEnvironment = { nodeEnv: 'production', strictGuaranteeEnv: 'off' }
    expectBoundary(
      raw.transformSync(compiler.applyCompileRequestEnvironmentPolicy(request, buildEnvironment)),
      true,
    )
    expectBoundary(
      raw.analyzeSync(
        compiler.applyAnalyzeRequestEnvironmentPolicy(analyzeRequest, buildEnvironment),
      ),
      true,
    )
    return {
      policyChecks: checked + 2,
      compilerBuildId: facade.nativeCompilerInfo().compilerBuildId,
    }
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    })
  }
}

export const counterLibrarySource = `import { $state } from 'fict'
  export function useCounter() {
    let count = $state(0)
    const increment = () => count++
    return { count, increment }
  }`

export async function assertHostMetadataContract(compiler, graphHost, recipe) {
  const directory = mkdtempSync(path.join(tmpdir(), 'fict-custom-host-'))
  try {
    const packageRoot = path.join(directory, 'node_modules', 'counter-library')
    const manifestPath = path.join(packageRoot, 'package.json')
    const metadataPath = path.join(packageRoot, 'index.fict.meta.json')
    const modulePath = path.join(packageRoot, 'index.js')
    const filename = path.join(directory, 'App.tsx')
    mkdirSync(packageRoot, { recursive: true })
    const producer = compiler.transformSync({
      code: counterLibrarySource,
      filename: '/counter.ts',
      options: { strictGuarantee: true },
    })
    assert.deepEqual(producer.diagnostics, [])
    assert.equal(producer.moduleMetadata.hooks.useCounter.objectProps.count, 'signal')
    writeFileSync(
      manifestPath,
      JSON.stringify({
        name: 'counter-library',
        type: 'module',
        exports: './index.js',
        fict: { metadata: './index.fict.meta.json' },
      }),
    )
    writeFileSync(modulePath, producer.code)
    writeFileSync(metadataPath, JSON.stringify(producer.moduleMetadata))
    const input = {
      code: `import type { OnlyType } from 'type-only'
        import { useCounter } from 'counter-library'
        import type { Counter } from 'counter-library'
        export function App() { const model = useCounter(); return <button onClick={model.increment}>{model.count}</button> }`,
      filename,
      moduleId: `${filename}?client`,
      options: { strictGuarantee: false, dev: false },
    }
    const environment = { nodeEnv: 'production' }
    const dependencies = new Set()
    const resolutions = []
    let variant = '?client'
    const resolve = (source, identity) => {
      resolutions.push({ source, identity })
      assert.equal(source, 'counter-library', 'Type-only imports must not request runtime metadata')
      const state = graphHost.resolvePackageModuleMetadataState(source, identity.filename, {
        onDependency: dependency => dependencies.add(dependency),
      })
      // This host knows the package is a Fict library. A missing declaration is not plain JS.
      return state.kind === 'resolved'
        ? { status: 'resolved', resolvedId: modulePath + variant, metadata: state.metadata }
        : { status: 'missing', resolvedId: null, metadata: null }
    }
    const first = await recipe.prepareRequest(input, resolve, environment)
    assert.equal(first.options.strictGuarantee, true)
    assert.equal(input.options.strictGuarantee, false)
    assert.equal(first.metadata.length, 1)
    assert.deepEqual(resolutions, [
      { source: 'counter-library', identity: { filename, moduleId: input.moduleId } },
    ])
    assert.ok(dependencies.has(manifestPath))
    assert.ok(dependencies.has(metadataPath))
    const compiled = await recipe.compileModule(input, resolve, environment)
    assert.deepEqual(compiled.diagnostics, [])
    assert.match(compiled.code, /model\.count\(\)/)
    const analysis = await recipe.analyzeModule(input, resolve, environment)
    assert.deepEqual(analysis.diagnostics, [])

    variant = '?server'
    assert.notEqual(
      (await recipe.prepareRequest(input, resolve, environment)).metadata[0].fingerprint,
      first.metadata[0].fingerprint,
    )
    variant = '?client'
    const ordinary = compiler.transformSync({
      code: 'export function useCounter() { return { count: 7, increment() {} } }',
      filename: '/counter.ts',
    })
    assert.deepEqual(ordinary.diagnostics, [])
    writeFileSync(modulePath, ordinary.code)
    writeFileSync(metadataPath, JSON.stringify(ordinary.moduleMetadata))
    assert.notEqual(
      (await recipe.prepareRequest(input, resolve, environment)).metadata[0].fingerprint,
      first.metadata[0].fingerprint,
    )
    const changed = await recipe.compileModule(input, resolve, environment)
    assert.doesNotMatch(changed.code, /model\.count\(\)/)

    for (const invalid of [
      { version: 2, exports: {} },
      { version: 1, exports: {}, unknown: true },
    ]) {
      writeFileSync(metadataPath, JSON.stringify(invalid))
      await assert.rejects(recipe.compileModule(input, resolve, environment), /FICT-H003/)
      const failure = await recipe.analyzeModule(input, resolve, environment)
      assert.ok(failure.diagnostics.some(d => d.code === 'FICT-H003' && d.severity === 'error'))
      await assert.rejects(
        recipe.prepareRequest(
          input,
          () => ({ status: 'resolved', resolvedId: modulePath, metadata: invalid }),
          environment,
        ),
        /Invalid metadata/,
      )
      assert.deepEqual(
        graphHost.resolvePackageModuleMetadataState('counter-library', 'virtual:App', {
          resolvePackage: () => ({ kind: 'resolved', metadata: invalid }),
        }),
        { kind: 'invalid' },
      )
    }
    unlinkSync(metadataPath)
    await assert.rejects(recipe.compileModule(input, resolve, environment), /FICT-H003/)
    assert.ok(dependencies.has(metadataPath))
    writeFileSync(metadataPath, JSON.stringify(producer.moduleMetadata))
    assert.match((await recipe.compileModule(input, resolve, environment)).code, /model\.count\(\)/)

    const incomplete = () => ({
      status: 'incompleteCycle',
      resolvedId: modulePath,
      metadata: producer.moduleMetadata,
    })
    const provisional = compiler.transformSync(
      await recipe.prepareRequest(input, incomplete, environment),
    )
    assert.ok(provisional.code)
    assert.equal(provisional.metadataIncomplete, true)
    await assert.rejects(
      recipe.compileModule(input, incomplete, environment),
      /complete metadata graph/,
    )

    writeFileSync(
      manifestPath,
      JSON.stringify({ name: 'counter-library', type: 'module', exports: './index.js' }),
    )
    assert.deepEqual(graphHost.resolvePackageModuleMetadataState('counter-library', filename), {
      kind: 'plain',
    })
    await assert.rejects(recipe.compileModule(input, resolve, environment), /FICT-H003/)
    // Deliberately marking this library opaque loses its shape. Strict mode cannot repair a lie.
    const opaque = await recipe.compileModule(
      input,
      () => ({ status: 'opaque', resolvedId: modulePath, metadata: null }),
      environment,
    )
    assert.deepEqual(opaque.diagnostics, [])
    assert.doesNotMatch(opaque.code, /model\.count\(\)/)
    return {
      metadataChangesObserved: true,
      missingAndMalformedRejected: true,
      incompleteEmissionRejected: true,
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
