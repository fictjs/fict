declare module '@babel/generator' {
  import type { GeneratorOptions, GeneratorResult } from '@babel/core'
  import type { Node } from '@babel/types'

  export default function generate(
    ast: Node,
    opts?: GeneratorOptions,
    code?: string | Record<string, string>,
  ): GeneratorResult
}
