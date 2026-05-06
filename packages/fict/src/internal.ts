/**
 * @fileoverview Compiler ABI bridge for the main `fict` package.
 *
 * This subpath is exported so compiler-generated code can resolve helpers
 * through `fict` without forcing applications to install `@fictjs/runtime`
 * separately. It is not a public user API and should not be imported by
 * application or library source by hand.
 *
 * @internal
 * @packageDocumentation
 */

export * from '@fictjs/runtime/internal'
