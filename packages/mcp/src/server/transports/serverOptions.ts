import type { CreateFictMcpServerOptions } from '../createServer'

export function buildCreateFictMcpServerOptions(
  options: Partial<CreateFictMcpServerOptions>,
): CreateFictMcpServerOptions | undefined {
  const base: CreateFictMcpServerOptions = {}

  if (options.docsRoot) base.docsRoot = options.docsRoot
  if (options.docsManifestPath) base.docsManifestPath = options.docsManifestPath
  if (options.playgroundOrigin) base.playgroundOrigin = options.playgroundOrigin
  if (options.serverName) base.serverName = options.serverName
  if (options.serverVersion) base.serverVersion = options.serverVersion

  return Object.keys(base).length > 0 ? base : undefined
}
