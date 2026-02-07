import type { RegionMetadata } from '../fine-grained-dom'

import type { CodegenContext, RegionInfo } from './codegen'
import { normalizeDependencyKey } from './codegen-overrides'

export function regionInfoToMetadata(region: RegionInfo): RegionMetadata {
  return {
    id: region.id,
    dependencies: new Set(region.dependencies),
    declarations: new Set(region.declarations),
    hasControlFlow: region.hasControlFlow,
    hasReactiveWrites: region.hasReactiveWrites ?? region.declarations.size > 0,
  }
}

/**
 * Find the region that contains all dependencies of an expression.
 * Returns the region if all deps are covered by a single region, null otherwise.
 */
export function findContainingRegion(deps: Set<string>, ctx: CodegenContext): RegionInfo | null {
  if (!ctx.regions || ctx.regions.length === 0 || deps.size === 0) return null

  const depList = Array.from(deps).map(d => normalizeDependencyKey(d))

  for (const region of ctx.regions) {
    let allCovered = true
    for (const dep of depList) {
      const coveredByRegion =
        dependencyCoveredByRegion(dep, region) ||
        dependencyCoveredByDeclarations(dep, region) ||
        ctx.trackedVars.has(dep)
      if (!coveredByRegion) {
        allCovered = false
        break
      }
    }
    if (allCovered) return region
  }
  return null
}

function dependencyCoveredByRegion(dep: string, region: RegionInfo): boolean {
  for (const rDep of region.dependencies) {
    const normalized = normalizeDependencyKey(rDep)
    if (dep === normalized) return true
    if (dep.startsWith(`${normalized}.`)) return true
    if (normalized.startsWith(`${dep}.`)) return true
  }
  return false
}

function dependencyCoveredByDeclarations(dep: string, region: RegionInfo): boolean {
  for (const decl of region.declarations) {
    const normalized = normalizeDependencyKey(decl)
    if (dep === normalized) return true
    if (dep.startsWith(`${normalized}.`)) return true
    if (normalized.startsWith(`${dep}.`)) return true
  }
  return false
}
