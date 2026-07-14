import type { FictCompilerOptions } from '../../src/index'
import { runLegacyTransform } from '../test-utils'

import type { CompilerBackend, CompilerBackendResult, FixtureDiagnostic } from './backend-harness'

export type LegacyFixtureOptions = Omit<FictCompilerOptions, 'onWarn'>

function toFixtureDiagnostic(
  warning: Parameters<NonNullable<FictCompilerOptions['onWarn']>>[0],
): FixtureDiagnostic {
  return {
    code: warning.code,
    message: warning.message,
    severity: 'warning',
    fileName: warning.fileName,
    line: warning.line,
    column: warning.column,
  }
}

/** Adapts the current Babel compiler to the backend-neutral differential protocol. */
export function createLegacyCompilerBackend(
  defaultOptions: LegacyFixtureOptions = {},
): CompilerBackend<LegacyFixtureOptions> {
  return {
    name: 'legacy',
    compile(fixture): CompilerBackendResult {
      const diagnostics: FixtureDiagnostic[] = []
      const result = runLegacyTransform(
        fixture.source,
        {
          ...defaultOptions,
          ...fixture.options,
          onWarn: warning => diagnostics.push(toFixtureDiagnostic(warning)),
        },
        fixture.filename,
      )

      if (!result) {
        throw new Error('Legacy Babel backend returned no transform result')
      }

      return {
        code: result.code ?? '',
        diagnostics,
        ...(result.map === null || result.map === undefined ? {} : { sourceMap: result.map }),
        ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
      }
    },
  }
}
