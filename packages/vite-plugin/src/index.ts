import { transformAsync } from '@babel/core'
import { createFictPlugin, type FictCompilerOptions } from '@fictjs/compiler'
import type { Plugin, TransformResult, ResolvedConfig } from 'vite'

export interface FictPluginOptions extends FictCompilerOptions {
  /**
   * File patterns to include for transformation.
   * @default ['**\/*.tsx', '**\/*.jsx']
   */
  include?: string[]
  /**
   * File patterns to exclude from transformation.
   * @default ['**\/node_modules\/**']
   */
  exclude?: string[]
}

/**
 * Vite plugin for Fict reactive UI library.
 *
 * Transforms $state and $effect calls into reactive signals using the Fict compiler.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from 'vite'
 * import fict from '@fictjs/vite-plugin'
 *
 * export default defineConfig({
 *   plugins: [fict()],
 * })
 * ```
 */
export default function fict(options: FictPluginOptions = {}): Plugin {
  const {
    include = ['**/*.tsx', '**/*.jsx'],
    exclude = ['**/node_modules/**'],
    ...compilerOptions
  } = options

  let config: ResolvedConfig
  let isDev = false

  return {
    name: 'vite-plugin-fict',

    enforce: 'pre',

    configResolved(resolvedConfig) {
      config = resolvedConfig
      isDev = config.command === 'serve' || config.mode === 'development'
    },

    config() {
      return {
        esbuild: {
          // Disable esbuild JSX handling for .tsx/.jsx files
          // Our plugin will handle the full transformation
          include: /\.(ts|js|mts|mjs|cjs)$/,
        },
        optimizeDeps: {
          // Ensure @fictjs/runtime is pre-bundled
          include: ['@fictjs/runtime'],
        },
      }
    },

    async transform(code: string, id: string): Promise<TransformResult | null> {
      const filename = stripQuery(id)

      // Skip non-matching files
      if (!shouldTransform(filename, include, exclude)) {
        return null
      }

      try {
        // Pass dev mode to compiler for debug instrumentation
        const fictOptions: FictCompilerOptions = {
          ...compilerOptions,
          dev: compilerOptions.dev ?? isDev,
          sourcemap: compilerOptions.sourcemap ?? true,
        }

        const isTypeScript = filename.endsWith('.tsx') || filename.endsWith('.ts')

        const result = await transformAsync(code, {
          filename,
          sourceMaps: fictOptions.sourcemap,
          sourceFileName: filename,
          presets: isTypeScript
            ? [['@babel/preset-typescript', { isTSX: true, allExtensions: true }]]
            : [],
          plugins: [
            ['@babel/plugin-syntax-jsx', {}],
            [createFictPlugin, fictOptions],
          ],
        })

        if (!result || !result.code) {
          return null
        }

        return {
          code: result.code,
          map: result.map as TransformResult['map'],
        }
      } catch (error) {
        // Better error handling
        const message =
          error instanceof Error ? error.message : 'Unknown error during Fict transformation'

        this.error({
          message: `[fict] Transform failed for ${id}: ${message}`,
          id,
        })

        return null
      }
    },

    handleHotUpdate({ file, server }) {
      // Force full reload for .tsx/.jsx files to ensure reactive graph is rebuilt
      if (shouldTransform(file, include, exclude)) {
        server.ws.send({
          type: 'full-reload',
          path: '*',
        })
      }
    },
  }
}

/**
 * Check if a file should be transformed based on include/exclude patterns
 */
function shouldTransform(id: string, include: string[], exclude: string[]): boolean {
  // Normalize path separators
  const normalizedId = stripQuery(id).replace(/\\/g, '/')

  // Check exclude patterns first
  for (const pattern of exclude) {
    if (matchPattern(normalizedId, pattern)) {
      return false
    }
  }

  // Check include patterns
  for (const pattern of include) {
    if (matchPattern(normalizedId, pattern)) {
      return true
    }
  }

  return false
}

/**
 * Simple glob pattern matching
 * Supports: **\/*.ext, *.ext, exact matches
 */
function matchPattern(id: string, pattern: string): boolean {
  // Exact match
  if (id === pattern) return true

  // Simple check: if pattern ends with extension like *.tsx, just check if file ends with it
  if (pattern.startsWith('**/') || pattern.startsWith('*')) {
    const ext = pattern.replace(/^\*\*?\//, '')
    if (ext.startsWith('*')) {
      // **/*.tsx -> check if ends with .tsx
      const ending = ext.replace(/^\*/, '')
      return id.endsWith(ending)
    }
  }

  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/\./g, '\\.') // Escape dots
    .replace(/\*\*/g, '.*') // ** matches any path
    .replace(/\*/g, '[^/]*') // * matches any non-slash

  const regex = new RegExp(`^${regexPattern}$`)
  return regex.test(id)
}

/**
 * Remove Vite query parameters (e.g. ?import, ?v=123) from an id
 */
function stripQuery(id: string): string {
  const queryStart = id.indexOf('?')
  return queryStart === -1 ? id : id.slice(0, queryStart)
}
