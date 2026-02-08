/**
 * Lightweight internal list helpers for compiler-generated keyed list paths.
 *
 * This subpath avoids pulling the broad `@fictjs/runtime/internal` barrel when
 * code only needs list primitives.
 */
export { createKeyedList, toNodeArray, type KeyedListBinding } from '../list-helpers'
