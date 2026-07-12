import { describe, expect, it } from 'vitest'

import { runLegacyTransform } from '../test-utils'
import fixtures from './frontend-parity-fixtures.json'

describe('shared Rust frontend parity corpus: legacy backend', () => {
  for (const fixture of fixtures) {
    it(`${fixture.accepted ? 'accepts' : 'rejects'} ${fixture.name}`, () => {
      const compile = () =>
        runLegacyTransform(
          fixture.source,
          fixture.reactiveScopes ? { reactiveScopes: fixture.reactiveScopes } : {},
          `/frontend-parity/${fixture.name}.${fixture.language}`,
        )

      if (fixture.accepted) {
        expect(compile).not.toThrow()
        expect(compile()?.code).toBeTypeOf('string')
      } else {
        expect(fixture.failureClass).toBeTypeOf('string')
        expect(fixture.legacyMessage).toBeTypeOf('string')
        expect(compile).toThrow(fixture.legacyMessage)
      }
    })
  }
})
