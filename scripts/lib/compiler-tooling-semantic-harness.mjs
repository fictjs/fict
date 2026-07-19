const helperCapabilities = new Map(
  Object.entries({
    __fictElementNamespaceMatches: 'element-namespace-match',
    elementNamespaceMatches: 'element-namespace-match',
    __fictReactive: 'reactive-read',
    reactiveGetter: 'reactive-read',
    __fictUseContext: 'context',
    useContext: 'context',
    __fictUseEffect: 'effect',
    useEffect: 'effect',
    __fictUseMemo: 'memo',
    useMemo: 'memo',
    __fictUseSignal: 'signal',
    useSignal: 'signal',
    createElementInNamespace: 'element-create',
    createElement: 'element-create',
    getSlotEnd: 'slot-boundary',
    insertBetween: 'range-insert',
    insert: 'range-insert',
    resolvePath: 'path-resolution',
    template: 'template',
    createConditional: 'conditional',
    onDestroy: 'cleanup',
    prop: 'property-binding',
    bindAttribute: 'attribute-binding',
  }),
)

const sourceRoles = new Map([
  ['source-signal', 'signal'],
  ['source-effect', 'effect'],
  ['source-memo', 'memo'],
  ['source-jsx', 'jsx'],
])

const sortedUnique = values => [...new Set(values)].sort()

export function sourceLocation(code, byteOffset) {
  const source = Buffer.from(code)
  if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset > source.length) {
    throw new RangeError(`invalid UTF-8 byte offset ${byteOffset}`)
  }
  const prefix = source.subarray(0, byteOffset).toString('utf8')
  if (Buffer.byteLength(prefix) !== byteOffset) {
    throw new RangeError(`byte offset ${byteOffset} splits a UTF-8 code point`)
  }
  const lines = prefix.split(/\r\n|[\n\r\u2028\u2029]/u)
  return { line: lines.length, column: lines.at(-1).length + 1 }
}

function eventLocation(event, code) {
  if (event.span !== undefined && event.span !== null) {
    return sourceLocation(code, event.span.start)
  }
  if (event.primarySpan !== undefined && event.primarySpan !== null) {
    return sourceLocation(code, event.primarySpan.start)
  }
  if (Number.isInteger(event.line) && Number.isInteger(event.column)) {
    return { line: event.line, column: event.column }
  }
  return null
}

function sourceEventRole(event) {
  if (event.kind === 'source-control-flow') {
    if (typeof event.name !== 'string') throw new TypeError('control-flow event has no name')
    return event.name
  }
  const role = sourceRoles.get(event.kind)
  if (role === undefined) throw new TypeError(`unknown source event kind ${event.kind}`)
  return role
}

function normalizeSourceEvents(artifact, code) {
  return artifact.events
    .filter(event => event.kind.startsWith('source-'))
    .map(event => {
      const location = eventLocation(event, code)
      if (location === null) throw new TypeError(`${event.kind} event has no source location`)
      return {
        kind: event.kind,
        role: sourceEventRole(event),
        ...location,
      }
    })
    .sort(
      (left, right) =>
        left.line - right.line ||
        left.column - right.column ||
        left.kind.localeCompare(right.kind) ||
        left.role.localeCompare(right.role),
    )
}

function normalizeHelpers(artifact) {
  const helpers = sortedUnique(artifact.helpers)
  const capabilities = helpers.map(helper => {
    const capability = helperCapabilities.get(helper)
    if (capability === undefined) throw new TypeError(`unreviewed runtime helper ${helper}`)
    return capability
  })
  return { helpers, capabilities: sortedUnique(capabilities) }
}

function normalizeExplainDiagnostics(artifact, code) {
  return artifact.diagnostics
    .map(diagnostic => {
      const location = eventLocation(diagnostic, code)
      if (location === null) throw new TypeError(`${diagnostic.code} diagnostic has no location`)
      return { code: diagnostic.code, ...location }
    })
    .sort(
      (left, right) =>
        left.line - right.line || left.column - right.column || left.code.localeCompare(right.code),
    )
}

function normalizeDiagnosticEvents(artifact, code) {
  return artifact.events
    .filter(event => event.kind === 'diagnostic')
    .map(event => {
      const location = eventLocation(event, code)
      if (location === null) throw new TypeError(`${event.code} event has no location`)
      return { code: event.code, ...location }
    })
    .sort(
      (left, right) =>
        left.line - right.line || left.column - right.column || left.code.localeCompare(right.code),
    )
}

export function normalizeExplain(artifact, code) {
  if (artifact === null || typeof artifact !== 'object') {
    throw new TypeError('missing compiler explain artifact')
  }
  const helpers = normalizeHelpers(artifact)
  const diagnostics = normalizeExplainDiagnostics(artifact, code)
  const diagnosticEvents = normalizeDiagnosticEvents(artifact, code)
  const runtimeHelperEvents = artifact.events
    .filter(event => event.kind === 'runtime-helper')
    .map(event => event.name)
    .sort()
  return {
    version: artifact.version,
    fileName: artifact.fileName,
    sourceEvents: normalizeSourceEvents(artifact, code),
    helpers: helpers.helpers,
    helperCapabilities: helpers.capabilities,
    diagnostics,
    diagnosticEvents,
    runtimeHelperEvents,
  }
}

function traceKeys(trace) {
  return sortedUnique(
    trace.flatMap(line => line.markers.map(marker => `${line.line}:${marker.kind}`)),
  )
}

function flattenRegions(regions) {
  return (regions ?? []).flatMap(region => [region, ...flattenRegions(region.children)])
}

function regionSemantics(regions) {
  const flattened = flattenRegions(regions)
  return {
    declarations: sortedUnique(flattened.flatMap(region => region.declarations)),
    dependencies: sortedUnique(flattened.flatMap(region => region.dependencies)),
    hasControlFlow: flattened.some(region => region.hasControlFlow),
    hasReactiveWrites: flattened.some(region => region.hasReactiveWrites),
  }
}

function normalizeComponent(component) {
  return {
    name: component.name,
    startLine: component.startLine,
    endLine: component.endLine,
    traceKeys: traceKeys(component.trace),
    regionSemantics: regionSemantics(component.regions),
  }
}

export function normalizeAnalysis(analysis) {
  const components = analysis.components.map(normalizeComponent)
  return {
    fileName: analysis.fileName,
    namedComponents: components.filter(component => component.name !== '<anonymous>'),
    anonymousComponents: components.filter(component => component.name === '<anonymous>'),
    diagnostics: analysis.diagnostics
      .map(({ code, severity, line, column }) => ({ code, severity, line, column }))
      .sort(
        (left, right) =>
          left.line - right.line ||
          left.column - right.column ||
          left.code.localeCompare(right.code) ||
          left.severity.localeCompare(right.severity),
      ),
  }
}
