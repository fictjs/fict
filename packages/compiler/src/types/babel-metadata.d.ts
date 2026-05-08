import type { CompilerExplainArtifact } from '../index'

declare module '@babel/core' {
  interface BabelFileMetadata {
    fictExplain?: CompilerExplainArtifact
  }
}
