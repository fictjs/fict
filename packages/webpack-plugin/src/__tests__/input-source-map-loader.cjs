/* eslint-disable no-undef */

module.exports = function inputSourceMapLoader(source) {
  const original = String(source)
  const lines = original.split('\n')
  const mappings = ['', ...lines.map((_, index) => (index === 0 ? 'AAAA' : 'AACA'))].join(';')
  this.callback(null, `const __fictUpstreamMarker = true;\n${original}`, {
    version: 3,
    file: this.resourcePath,
    sources: [this.resourcePath],
    sourcesContent: [original],
    names: [],
    mappings,
  })
}
