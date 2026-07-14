import {
  minimizeSourceByLines,
  type CompilerExplainArtifact,
  type CompilerExplainEvent,
  type FictCompilerOptions,
  type SourceMinimizerOptions,
  type SourceMinimizerResult,
} from '../../src/legacy'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

type ExplainVersionIsStable = Expect<Equal<CompilerExplainArtifact['version'], 1>>
type ExplainEventKindIsString = Expect<
  Equal<CompilerExplainEvent['kind'], string> extends true ? false : true
>

const compilerOptions = {
  dev: true,
  explain(artifact) {
    const version: 1 = artifact.version
    const helpers: string[] = artifact.helpers
    const events: CompilerExplainEvent[] = artifact.events

    artifact.events.forEach(event => {
      const kind: CompilerExplainEvent['kind'] = event.kind
      const location: number | undefined = event.line
      void kind
      void location
    })

    void version
    void helpers
    void events
  },
} satisfies FictCompilerOptions

const minimizerOptions = {
  source: 'target()',
  preserve: [/target/],
  test(candidate) {
    return candidate.includes('target()')
  },
} satisfies SourceMinimizerOptions

async function runMinimizer(): Promise<SourceMinimizerResult> {
  const result = await minimizeSourceByLines(minimizerOptions)
  const predicateCalls: number = result.predicateCalls
  const chunkPasses: number = result.chunkPasses

  void predicateCalls
  void chunkPasses

  return result
}

void compilerOptions
void runMinimizer
void (null as unknown as ExplainVersionIsStable)
void (null as unknown as ExplainEventKindIsString)
