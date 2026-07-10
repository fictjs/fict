import type { Compilation, Compiler, NormalModule } from 'webpack'

import {
  attachLoaderBinding,
  createCompilationState,
  createLocalResolutionKey,
  type FictWebpackCompilationState,
} from './shared'

const PLUGIN_NAME = 'FictWebpackPlugin'

interface MetadataGraphNode {
  filename: string
  module: NormalModule
  dependencies: Set<string>
}

export interface FictWebpackPluginOptions {
  /** Maximum fixed-point passes for a circular local metadata component. */
  maxMetadataPasses?: number
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined'
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`
}

function buildMetadataGraph(
  compilation: Compilation,
  state: FictWebpackCompilationState,
): Map<string, MetadataGraphNode> {
  const graph = new Map<string, MetadataGraphNode>()
  state.resolvedLocalModules.clear()

  for (const [filename, module] of state.modulesByFilename) {
    graph.set(filename, { filename, module, dependencies: new Set() })
  }

  for (const node of graph.values()) {
    for (const connection of compilation.moduleGraph.getOutgoingConnections(node.module)) {
      const dependencyModule = connection.module
      if (!dependencyModule) continue
      const dependencyFilename = state.filenamesByModule.get(dependencyModule as NormalModule)
      if (!dependencyFilename || !graph.has(dependencyFilename)) continue

      const request = (connection.dependency as { request?: unknown } | null)?.request
      if (typeof request === 'string') {
        const key = createLocalResolutionKey(node.filename, request)
        const previous = state.resolvedLocalModules.get(key)
        if (previous && previous !== dependencyFilename) {
          throw new Error(
            `[fict] Webpack resolved "${request}" from "${node.filename}" to multiple Fict modules.`,
          )
        }
        state.resolvedLocalModules.set(key, dependencyFilename)
      }
      node.dependencies.add(dependencyFilename)
    }
  }

  return graph
}

function getStronglyConnectedComponents(graph: Map<string, MetadataGraphNode>): string[][] {
  let nextIndex = 0
  const indices = new Map<string, number>()
  const lowLinks = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const components: string[][] = []

  const visit = (filename: string): void => {
    const index = nextIndex++
    indices.set(filename, index)
    lowLinks.set(filename, index)
    stack.push(filename)
    onStack.add(filename)

    for (const dependency of [...(graph.get(filename)?.dependencies ?? [])].sort()) {
      if (!graph.has(dependency)) continue
      if (!indices.has(dependency)) {
        visit(dependency)
        lowLinks.set(filename, Math.min(lowLinks.get(filename)!, lowLinks.get(dependency)!))
      } else if (onStack.has(dependency)) {
        lowLinks.set(filename, Math.min(lowLinks.get(filename)!, indices.get(dependency)!))
      }
    }

    if (lowLinks.get(filename) !== indices.get(filename)) return
    const component: string[] = []
    while (stack.length > 0) {
      const member = stack.pop()!
      onStack.delete(member)
      component.push(member)
      if (member === filename) break
    }
    components.push(component)
  }

  for (const filename of [...graph.keys()].sort()) {
    if (!indices.has(filename)) visit(filename)
  }
  return components
}

function rebuildModule(compilation: Compilation, module: NormalModule): Promise<void> {
  return new Promise((resolve, reject) => {
    compilation.rebuildModule(module, error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function componentMetadataSnapshot(
  component: readonly string[],
  state: FictWebpackCompilationState,
): string {
  return stableStringify(component.map(filename => [filename, state.moduleMetadata.get(filename)]))
}

async function convergeMetadataGraph(
  compilation: Compilation,
  state: FictWebpackCompilationState,
  maxMetadataPasses: number | undefined,
): Promise<void> {
  const graph = buildMetadataGraph(compilation, state)

  for (const component of getStronglyConnectedComponents(graph)) {
    const sortedComponent = [...component].sort()
    const hasCycle =
      sortedComponent.length > 1 ||
      graph.get(sortedComponent[0]!)?.dependencies.has(sortedComponent[0]!) === true

    if (!hasCycle) {
      const filename = sortedComponent[0]!
      const node = graph.get(filename)!
      if (node.dependencies.size > 0) {
        await rebuildModule(compilation, node.module)
      }
      continue
    }

    const passLimit = maxMetadataPasses ?? Math.max(8, sortedComponent.length * 4)
    let converged = false
    for (let pass = 0; pass < passLimit; pass++) {
      const before = componentMetadataSnapshot(sortedComponent, state)
      for (const filename of sortedComponent) {
        await rebuildModule(compilation, graph.get(filename)!.module)
      }
      const after = componentMetadataSnapshot(sortedComponent, state)
      if (after === before) {
        converged = true
        break
      }
    }
    if (!converged) {
      throw new Error(
        `[fict] Webpack module metadata did not converge for circular dependency: ${sortedComponent.join(', ')}`,
      )
    }
  }
}

export class FictWebpackPlugin {
  readonly #options: FictWebpackPluginOptions
  readonly #states = new WeakMap<Compilation, FictWebpackCompilationState>()

  constructor(options: FictWebpackPluginOptions = {}) {
    if (
      options.maxMetadataPasses !== undefined &&
      (!Number.isInteger(options.maxMetadataPasses) || options.maxMetadataPasses <= 0)
    ) {
      throw new Error('[fict] maxMetadataPasses must be a positive integer.')
    }
    this.#options = options
  }

  apply(compiler: Compiler): void {
    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, compilation => {
      const state = createCompilationState()
      this.#states.set(compilation, state)
      compiler.webpack.NormalModule.getCompilationHooks(compilation).loader.tap(
        PLUGIN_NAME,
        (loaderContext, module) => {
          attachLoaderBinding(loaderContext, { module, state })
        },
      )
    })

    compiler.hooks.finishMake.tapPromise(
      { name: PLUGIN_NAME, stage: Number.MAX_SAFE_INTEGER },
      async compilation => {
        const state = this.#states.get(compilation)
        if (!state || state.modulesByFilename.size === 0) return
        await convergeMetadataGraph(compilation, state, this.#options.maxMetadataPasses)
      },
    )
  }
}

export default FictWebpackPlugin
