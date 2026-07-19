import assert from 'node:assert/strict'

function oracleNames(id) {
  const suffix = id.replace(/[^A-Za-z0-9_$]/g, '_')
  return {
    mount: `__fictDomOracleMount_${suffix}`,
    observe: `__fictDomOracleObserve_${suffix}`,
    render: `__fictDomOracleRender_${suffix}`,
    root: `__fictDomOracleRoot_${suffix}`,
    snapshotNode: `__fictDomOracleSnapshotNode_${suffix}`,
  }
}

export function materializeDomSemanticFixture(fixture, corpus) {
  assert.equal(typeof fixture?.id, 'string')
  if (fixture.request !== undefined) return fixture

  assert.equal(typeof fixture.corpusFixtureId, 'string', `${fixture.id}: corpus fixture`)
  assert.equal(typeof fixture.componentName, 'string', `${fixture.id}: component name`)
  assert.equal(typeof fixture.propsSource, 'string', `${fixture.id}: props source`)
  assert.ok(corpus, `${fixture.id}: missing compiler corpus`)

  const corpusFixture = corpus.fixtures.find(candidate => candidate.id === fixture.corpusFixtureId)
  assert.ok(corpusFixture, `${fixture.id}: missing corpus row ${fixture.corpusFixtureId}`)
  assert.equal(
    corpusFixture.origin.requestVariant,
    'audit-baseline',
    `${fixture.id}: baseline corpus row`,
  )

  const names = oracleNames(fixture.id)
  const code = `${corpusFixture.source}

import { render as ${names.render} } from 'fict'

let ${names.root}

function ${names.snapshotNode}(node) {
  if (node.nodeType === 3) return { type: 'text', value: node.data }
  if (node.nodeType !== 1) return null
  return {
    type: 'element',
    attributes: Array.from(node.attributes, attribute => [attribute.name, attribute.value]),
    localName: node.localName,
    namespaceURI: node.namespaceURI,
    children: Array.from(node.childNodes, ${names.snapshotNode}).filter(Boolean),
  }
}

export function ${names.mount}(root) {
  ${names.root} = root
  return ${names.render}(
    () => ({ type: ${fixture.componentName}, props: ${fixture.propsSource} }),
    root,
  )
}

export function ${names.observe}() {
  return {
    text: ${names.root}.textContent,
    tree: Array.from(${names.root}.childNodes, ${names.snapshotNode}).filter(Boolean),
    elements: Array.from(${names.root}.querySelectorAll('*'), element => ({
      attributes: Array.from(element.attributes, attribute => [attribute.name, attribute.value]),
      localName: element.localName,
      namespaceURI: element.namespaceURI,
    })),
  }
}
`

  return {
    id: fixture.id,
    request: {
      code,
      filename: `/oracle/${fixture.id}.tsx`,
      language: 'tsx',
      moduleKind: 'commonjs',
      options: corpusFixture.options,
    },
    scenario: {
      mountExport: names.mount,
      observeExport: names.observe,
      steps: [{ kind: 'record', label: 'mounted-with-props' }],
    },
    rustDiagnostics: corpusFixture.expected.diagnostics,
    rustDeviation: fixture.rustDeviation,
  }
}
