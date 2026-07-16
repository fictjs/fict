/**
 * Node/bundler-owned module-graph services for the native compiler.
 *
 * This entrypoint deliberately contains no Babel compiler imports. Integrations use it for
 * versioned package-boundary metadata resolution without loading the native addon.
 */
export * from './module-metadata'
