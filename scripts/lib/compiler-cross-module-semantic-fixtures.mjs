import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const sha256 = value => createHash('sha256').update(value).digest('hex')

export function validateCrossModuleSemanticFixture(fixture) {
  assert.equal(typeof fixture?.id, 'string')
  assert.equal(typeof fixture?.entryId, 'string', `${fixture?.id}: entry id`)
  assert.equal(typeof fixture?.invocation?.exportName, 'string', `${fixture?.id}: export name`)
  assert.ok(Array.isArray(fixture?.invocation?.arguments), `${fixture?.id}: arguments`)
  assert.ok(Array.isArray(fixture?.modules), `${fixture?.id}: modules`)
  assert.ok(fixture.modules.length > 1, `${fixture.id}: multi-file graph`)

  const moduleIds = new Set()
  for (const module of fixture.modules) {
    assert.equal(typeof module?.id, 'string', `${fixture.id}: module id`)
    assert.equal(typeof module?.source, 'string', `${fixture.id}:${module?.id}: source`)
    assert.equal(typeof module?.dependencies, 'object', `${fixture.id}:${module?.id}: dependencies`)
    assert.equal(moduleIds.has(module.id), false, `${fixture.id}: duplicate ${module.id}`)
    for (const [request, dependencyId] of Object.entries(module.dependencies)) {
      assert.equal(typeof request, 'string', `${fixture.id}:${module.id}: dependency request`)
      assert.ok(request.length > 0, `${fixture.id}:${module.id}: empty dependency request`)
      assert.equal(
        typeof dependencyId,
        'string',
        `${fixture.id}:${module.id}:${request}: dependency id`,
      )
      assert.ok(
        moduleIds.has(dependencyId),
        `${fixture.id}:${module.id}:${request}: dependencies must precede consumers`,
      )
    }
    moduleIds.add(module.id)
  }
  assert.ok(moduleIds.has(fixture.entryId), `${fixture.id}: missing entry module`)
}

export function compileRustCrossModuleSemanticFixture(binding, fixture) {
  validateCrossModuleSemanticFixture(fixture)
  const results = new Map()
  const modules = []

  for (const module of fixture.modules) {
    const metadata = Object.entries(module.dependencies).map(([request, dependencyId]) => {
      const dependency = results.get(dependencyId)
      assert.ok(dependency, `${fixture.id}:${module.id}: missing ${dependencyId}`)
      return {
        request,
        resolvedId: dependencyId,
        status: 'resolved',
        metadata: dependency.moduleMetadata,
        fingerprint: `sha256:${sha256(JSON.stringify([dependencyId, dependency.moduleMetadata]))}`,
      }
    })
    const result = binding.transformSync({
      code: module.source,
      filename: module.id,
      moduleId: module.id,
      language: 'tsx',
      moduleKind: 'commonjs',
      metadata,
      options: {
        strictGuarantee: false,
        dev: false,
        ...fixture.options,
        ...module.options,
      },
    })
    results.set(module.id, result)
    modules.push({
      id: module.id,
      dependencies: module.dependencies,
      code: result.code,
      result,
    })
  }

  return { entryId: fixture.entryId, invocation: fixture.invocation, modules }
}
