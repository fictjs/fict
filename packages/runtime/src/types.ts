// ============================================================================
// DOM Types
// ============================================================================

/** Any DOM node that can be rendered */
export type DOMElement = Node

/** Cleanup function type */
export type Cleanup = () => void

// ============================================================================
// Virtual Node Types
// ============================================================================

/** Fict Virtual Node - represents a component or element in the virtual tree */
export interface FictVNode {
  /** Element type: tag name, Fragment symbol, or component function */
  type: string | symbol | ((props: Record<string, unknown>) => FictNode)
  /** Props passed to the element/component */
  props: Record<string, unknown> | null
  /** Optional key for list rendering optimization */
  key?: string | undefined
}

/**
 * Fict Node - represents any renderable value
 * This type covers all possible values that can appear in JSX
 */
export type FictNode = FictVNode | FictNode[] | Node | string | number | boolean | null | undefined

// ============================================================================
// Reactive Types
// ============================================================================

/** A value that may be either static or reactive (wrapped in a getter function) */
export type MaybeReactive<T> = T | (() => T)

/** A reactive getter function */
export type Reactive<T> = () => T

// ============================================================================
// Component Types
// ============================================================================

/** Props that all components receive */
export interface BaseProps {
  /** Optional key for list rendering */
  key?: string | number
  /** Optional children */
  children?: FictNode | FictNode[]
}

/** A Fict component function */
export type Component<P extends Record<string, unknown> = Record<string, unknown>> = (
  props: P & BaseProps,
) => FictNode

/** Props with children */
export type PropsWithChildren<P = unknown> = P & {
  children?: FictNode | FictNode[]
}

// ============================================================================
// Error Handling Types
// ============================================================================

export interface ErrorInfo {
  source: 'render' | 'effect' | 'event' | 'renderChild' | 'cleanup'
  componentName?: string
  eventName?: string
}

// ============================================================================
// Event Handler Types
// ============================================================================

/** Event handler type for type-safe event handling */
export type EventHandler<E extends Event = Event> = (event: E) => void

/** Common event handlers */
export interface DOMEventHandlers {
  onClick?: EventHandler<MouseEvent>
  onDblClick?: EventHandler<MouseEvent>
  onMouseDown?: EventHandler<MouseEvent>
  onMouseUp?: EventHandler<MouseEvent>
  onMouseMove?: EventHandler<MouseEvent>
  onMouseEnter?: EventHandler<MouseEvent>
  onMouseLeave?: EventHandler<MouseEvent>
  onMouseOver?: EventHandler<MouseEvent>
  onMouseOut?: EventHandler<MouseEvent>

  onKeyDown?: EventHandler<KeyboardEvent>
  onKeyUp?: EventHandler<KeyboardEvent>
  onKeyPress?: EventHandler<KeyboardEvent>

  onFocus?: EventHandler<FocusEvent>
  onBlur?: EventHandler<FocusEvent>

  onInput?: EventHandler<InputEvent>
  onChange?: EventHandler<Event>
  onSubmit?: EventHandler<SubmitEvent>

  onScroll?: EventHandler<Event>
  onWheel?: EventHandler<WheelEvent>

  onDragStart?: EventHandler<DragEvent>
  onDrag?: EventHandler<DragEvent>
  onDragEnd?: EventHandler<DragEvent>
  onDragEnter?: EventHandler<DragEvent>
  onDragLeave?: EventHandler<DragEvent>
  onDragOver?: EventHandler<DragEvent>
  onDrop?: EventHandler<DragEvent>

  onTouchStart?: EventHandler<TouchEvent>
  onTouchMove?: EventHandler<TouchEvent>
  onTouchEnd?: EventHandler<TouchEvent>
  onTouchCancel?: EventHandler<TouchEvent>

  onAnimationStart?: EventHandler<AnimationEvent>
  onAnimationEnd?: EventHandler<AnimationEvent>
  onAnimationIteration?: EventHandler<AnimationEvent>

  onTransitionEnd?: EventHandler<TransitionEvent>
}

// ============================================================================
// Ref Types
// ============================================================================

/** Ref callback type */
export type RefCallback<T extends Element = HTMLElement> = (element: T) => void

/** Ref object type (for future use with createRef) */
export interface RefObject<T extends Element = HTMLElement> {
  current: T | null
}

/** Ref type that can be either callback or object */
export type Ref<T extends Element = HTMLElement> = RefCallback<T> | RefObject<T>

// ============================================================================
// Style Types
// ============================================================================

/** CSS style value - can be string or number (number becomes px) */
export type StyleValue = string | number

/** CSS style object */
export type CSSStyleObject = {
  [K in keyof CSSStyleDeclaration]?: StyleValue
} & Record<string, StyleValue>

/** Style prop type - can be string or object */
export type StyleProp = string | CSSStyleObject | null | undefined

// ============================================================================
// Class Types
// ============================================================================

/** Class object for conditional classes */
export type ClassObject = Record<string, boolean | undefined | null>

/** Class prop type - can be string or object */
export type ClassProp = string | ClassObject | null | undefined

// ============================================================================
// Suspense Types
// ============================================================================

export interface SuspenseToken {
  then: Promise<unknown>['then']
}
