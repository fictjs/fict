// ============================================================================
// Runtime Constants
// ============================================================================

export const RUNTIME_MODULE = '@fictjs/runtime'

export const RUNTIME_HELPERS = {
  signal: 'createSignal',
  memo: 'createMemo',
  effect: 'createEffect',
  createElement: 'createElement',
  conditional: 'createConditional',
  list: 'createList',
  keyedList: 'createKeyedList',
  insert: 'insert',
  onDestroy: 'onDestroy',
  bindText: 'bindText',
  bindAttribute: 'bindAttribute',
  bindProperty: 'bindProperty',
  bindClass: 'bindClass',
  bindStyle: 'bindStyle',
  bindEvent: 'bindEvent',
  toNodeArray: 'toNodeArray',
} as const

export const RUNTIME_ALIASES = {
  signal: '__fictSignal',
  memo: '__fictMemo',
  effect: '__fictEffect',
  createElement: '__fictCreateElement',
  conditional: '__fictConditional',
  list: '__fictList',
  keyedList: '__fictKeyedList',
  insert: '__fictInsert',
  onDestroy: '__fictOnDestroy',
  bindText: '__fictBindText',
  bindAttribute: '__fictBindAttribute',
  bindProperty: '__fictBindProperty',
  bindClass: '__fictBindClass',
  bindStyle: '__fictBindStyle',
  bindEvent: '__fictBindEvent',
  toNodeArray: '__fictToNodeArray',
} as const

// Attributes that should NOT be wrapped in reactive functions
export const NON_REACTIVE_ATTRS = new Set(['key', 'ref'])

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
