/**
 * Node/bundler-owned module-graph services for the native compiler.
 *
 * This entrypoint deliberately contains no Babel compiler imports. Integrations use it for
 * metadata persistence and package-boundary resolution without loading the legacy compiler.
 */
export * from './module-metadata'
