/**
 * @fileoverview Compiler Constants for Runtime Integration
 *
 * IMPORTANT: These constants define the contract between the compiler
 * and runtime. Any changes here must be synchronized with @fictjs/runtime.
 *
 * API Stability: Tier 2 (Internal Stable)
 * - RUNTIME_HELPERS names/signatures must remain stable for v1.x
 * - Compiled code depends on these helper names
 * - Changes require runtime version bump and migration guide
 *
 * @see docs/api-freeze-v1.md for full API stability policy
 */

const DelegatedEventNames = [
  'beforeinput',
  'click',
  'dblclick',
  'contextmenu',
  'focusin',
  'focusout',
  'input',
  'keydown',
  'keyup',
  'mousedown',
  'mousemove',
  'mouseout',
  'mouseover',
  'mouseup',
  'pointerdown',
  'pointermove',
  'pointerout',
  'pointerover',
  'pointerup',
  'touchend',
  'touchmove',
  'touchstart',
] as const

// ============================================================================
// Runtime Constants
// ============================================================================

/**
 * The runtime module path for compiler-generated imports.
 * Uses the internal subpath to access compiler-dependent APIs.
 */
export const RUNTIME_MODULE = '@fictjs/runtime/internal'

/**
 * Runtime helper function names used by compiler-generated code.
 * @internal These names are part of the compiler-runtime ABI contract.
 */
export const RUNTIME_HELPERS = {
  signal: 'createSignal',
  createSelector: 'createSelector',
  memo: 'createMemo',
  effect: 'createEffect',
  useContext: '__fictUseContext',
  pushContext: '__fictPushContext',
  popContext: '__fictPopContext',
  useSignal: '__fictUseSignal',
  useMemo: '__fictUseMemo',
  useEffect: '__fictUseEffect',
  render: '__fictRender',
  fragment: 'Fragment',
  propGetter: '__fictProp',
  propsRest: '__fictPropsRest',
  mergeProps: 'mergeProps',
  prop: 'prop',
  runInScope: 'runInScope',
  createElement: 'createElement',
  conditional: 'createConditional',
  keyedList: 'createKeyedList',
  insert: 'insert',
  onDestroy: 'onDestroy',
  bindText: 'bindText',
  bindAttribute: 'bindAttribute',
  bindProperty: 'bindProperty',
  bindClass: 'bindClass',
  bindStyle: 'bindStyle',
  bindEvent: 'bindEvent',
  callEventHandler: 'callEventHandler',
  bindRef: 'bindRef',
  toNodeArray: 'toNodeArray',
  template: 'template',
  delegateEvents: 'delegateEvents',
} as const

export const RUNTIME_ALIASES = {
  signal: 'createSignal',
  createSelector: 'createSelector',
  memo: 'createMemo',
  effect: 'createEffect',
  useContext: '__fictUseContext',
  pushContext: '__fictPushContext',
  popContext: '__fictPopContext',
  useSignal: '__fictUseSignal',
  useMemo: '__fictUseMemo',
  useEffect: '__fictUseEffect',
  render: '__fictRender',
  fragment: 'Fragment',
  propGetter: '__fictProp',
  propsRest: '__fictPropsRest',
  prop: 'prop',
  mergeProps: 'mergeProps',
  runInScope: 'runInScope',
  createElement: 'createElement',
  conditional: 'createConditional',
  keyedList: 'createKeyedList',
  insert: 'insert',
  onDestroy: 'onDestroy',
  bindText: 'bindText',
  bindAttribute: 'bindAttribute',
  bindProperty: 'bindProperty',
  bindClass: 'bindClass',
  bindStyle: 'bindStyle',
  bindEvent: 'bindEvent',
  callEventHandler: 'callEventHandler',
  bindRef: 'bindRef',
  toNodeArray: 'toNodeArray',
  template: 'template',
  delegateEvents: 'delegateEvents',
} as const

// Attributes that should NOT be wrapped in reactive functions
export const NON_REACTIVE_ATTRS = new Set(['key', 'ref'])

/**
 * Events that should use event delegation for performance.
 * These events bubble and are commonly used across many elements.
 * Must match the runtime's DelegatedEvents set.
 */
export const DelegatedEvents = new Set<string>([...DelegatedEventNames])

// Functions that are known to be safe (read-only, won't mutate passed objects)
export const SAFE_FUNCTIONS = new Set([
  // Console methods
  'console.log',
  'console.info',
  'console.warn',
  'console.error',
  'console.debug',
  'console.trace',
  'console.dir',
  'console.table',
  // JSON methods
  'JSON.stringify',
  'JSON.parse',
  // Object methods (read-only)
  'Object.keys',
  'Object.values',
  'Object.entries',
  'Object.freeze',
  'Object.isFrozen',
  'Object.isSealed',
  'Object.isExtensible',
  'Object.getOwnPropertyNames',
  'Object.getOwnPropertyDescriptor',
  'Object.getPrototypeOf',
  // Array methods (read-only)
  'Array.isArray',
  'Array.from',
  'Array.of',
  // Math methods
  'Math.abs',
  'Math.ceil',
  'Math.floor',
  'Math.round',
  'Math.max',
  'Math.min',
  'Math.pow',
  'Math.sqrt',
  'Math.random',
  'Math.sin',
  'Math.cos',
  'Math.tan',
  'Math.log',
  'Math.exp',
  'Math.sign',
  'Math.trunc',
  // Type conversion/checking
  'String',
  'Number',
  'Boolean',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'typeof',
  // Date methods (read-only)
  'Date.now',
  'Date.parse',
])
