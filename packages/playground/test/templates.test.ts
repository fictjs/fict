import { describe, expect, it } from 'vitest'

import { getPlaygroundTemplate, listPlaygroundTemplates } from '../src/server/templates'

describe('playground templates', () => {
  it('returns stable template catalog', () => {
    const templates = listPlaygroundTemplates()
    const ids = templates.map(template => template.id)

    expect(ids).toContain('counter')
    expect(ids).toContain('todos')
    expect(ids).toContain('async-resource')
    expect(ids).toContain('resumable-lab')
  })

  it('returns file content for a template', () => {
    const template = getPlaygroundTemplate('counter')
    expect(template.files['src/main.tsx']).toContain('render(() => <App />')
    expect(template.files['src/App.tsx']).toContain('$state')
  })

  it('does not expose mutable template recommendations', () => {
    const first = getPlaygroundTemplate('resumable-lab')
    expect(first.recommendedConfig).toBeDefined()
    first.recommendedConfig!.resumable = false

    const second = getPlaygroundTemplate('resumable-lab')
    expect(second.recommendedConfig?.resumable).toBe(true)

    const catalogEntry = listPlaygroundTemplates().find(template => template.id === 'resumable-lab')
    catalogEntry!.recommendedConfig!.functionSplitting = false

    expect(getPlaygroundTemplate('resumable-lab').recommendedConfig?.functionSplitting).toBe(true)
  })

  it('throws for unknown template id', () => {
    expect(() => getPlaygroundTemplate('unknown-template')).toThrow(
      'Unknown playground template: unknown-template',
    )
  })
})
