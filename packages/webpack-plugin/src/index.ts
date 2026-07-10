import type { Compilation, Compiler, NormalModule } from 'webpack'

import {
  attachLoaderBinding,
  createCompilationState,
  createLocalResolutionKey,
  registerFictModule,
  restoreFictModuleMetadata,
  storeFictModuleMetadata,
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
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return 'null'
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  return `{${Object.keys(value)
    .filter(key => (value as Record<string, unknown>)[key] !== undefined)
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
  if (compilation.rebuildQueue.isDone(module)) {
    compilation.rebuildQueue.invalidate(module)
  }
  return new Promise((resolve, reject) => {
    compilation.rebuildModule(module, error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function hydrateCachedModuleMetadata(
  compilation: Compilation,
  state: FictWebpackCompilationState,
): void {
  for (const module of compilation.modules) {
    const restored = restoreFictModuleMetadata(module as NormalModule)
    if (!restored) continue
    const filename = registerFictModule(state, restored.filename, module as NormalModule)
    state.moduleMetadata.set(filename, restored.metadata)
    state.compiledDependencyFingerprints.set(filename, restored.dependencyFingerprint)
  }
}

function dependencyFingerprint(
  node: MetadataGraphNode,
  state: FictWebpackCompilationState,
): string {
  const dependencies = [...node.dependencies].sort().map(filename => {
    const metadata = state.moduleMetadata.get(filename)
    if (!metadata) {
      throw new Error(`[fict] Missing Webpack module metadata for ${filename}.`)
    }
    return [filename, metadata]
  })
  return stableStringify(dependencies)
}

async function rebuildModuleWithFingerprint(
  compilation: Compilation,
  state: FictWebpackCompilationState,
  node: MetadataGraphNode,
): Promise<void> {
  const fingerprint = dependencyFingerprint(node, state)
  state.pendingDependencyFingerprints.set(node.filename, fingerprint)
  try {
    await rebuildModule(compilation, node.module)
  } finally {
    state.pendingDependencyFingerprints.delete(node.filename)
  }
  const persistedFingerprint = state.compiledDependencyFingerprints.get(node.filename)
  if (persistedFingerprint !== fingerprint) {
    throw new Error(
      `[fict] Webpack did not persist the metadata fingerprint for ${node.filename} ` +
        `(expected ${fingerprint}, received ${String(persistedFingerprint)}).`,
    )
  }
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
      const fingerprint = dependencyFingerprint(node, state)
      if (state.compiledDependencyFingerprints.get(filename) !== fingerprint) {
        if (node.dependencies.size === 0) {
          const metadata = state.moduleMetadata.get(filename)
          if (!metadata) {
            throw new Error(`[fict] Missing Webpack module metadata for ${filename}.`)
          }
          storeFictModuleMetadata(state, node.module, filename, metadata, fingerprint)
        } else {
          await rebuildModuleWithFingerprint(compilation, state, node)
        }
      }
      continue
    }

    const passLimit = maxMetadataPasses ?? Math.max(8, sortedComponent.length * 4)
    const fingerprintsAreCurrent = (): boolean =>
      sortedComponent.every(filename => {
        const node = graph.get(filename)!
        return (
          state.compiledDependencyFingerprints.get(filename) === dependencyFingerprint(node, state)
        )
      })
    if (fingerprintsAreCurrent()) continue

    let converged = false
    for (let pass = 0; pass < passLimit; pass++) {
      const before = componentMetadataSnapshot(sortedComponent, state)
      for (const filename of sortedComponent) {
        await rebuildModuleWithFingerprint(compilation, state, graph.get(filename)!)
      }
      const after = componentMetadataSnapshot(sortedComponent, state)
      if (after === before && fingerprintsAreCurrent()) {
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
        if (!state) return
        hydrateCachedModuleMetadata(compilation, state)
        if (state.modulesByFilename.size === 0) return
        await convergeMetadataGraph(compilation, state, this.#options.maxMetadataPasses)
      },
    )
  }
}

export default FictWebpackPlugin
