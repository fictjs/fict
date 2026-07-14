import type { CompilerExplainArtifact } from '../legacy-compiler'

declare module '@babel/core' {
  interface BabelFileMetadata {
    fictExplain?: CompilerExplainArtifact
  }
}
