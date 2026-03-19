/**
 * @fileoverview Internal compiler/runtime bridge for the main `fict` package.
 *
 * This subpath is intentionally not documented as a public user API. It exists
 * so compiler-generated code can resolve helpers through `fict` without forcing
 * applications to install `@fictjs/runtime` separately.
 */

export * from '@fictjs/runtime/internal'
