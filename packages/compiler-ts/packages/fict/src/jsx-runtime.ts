/**
 * JSX runtime for Fict
 *
 * This module is used by the JSX transform to create elements.
 * Configure your tsconfig.json:
 *
 * ```json
 * {
 *   "compilerOptions": {
 *     "jsx": "react-jsx",
 *     "jsxImportSource": "fict"
 *   }
 * }
 * ```
 */

export { jsx, jsxs, jsxDEV, Fragment, type JSX } from 'fict-runtime/jsx-runtime'
