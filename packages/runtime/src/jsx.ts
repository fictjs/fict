import type { FictNode } from './types'

export const Fragment = Symbol('Fragment')

export function jsx(
  type: string | typeof Fragment | ((props: Record<string, unknown>) => FictNode),
  props: Record<string, unknown>,
  key?: string,
): FictNode {
  return { type, props, key }
}

export const jsxs = jsx
export const jsxDEV = jsx

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace JSX {
  export type Element = FictNode

  export interface IntrinsicElements {
    // Document structure
    html: HTMLAttributes<HTMLHtmlElement>
    head: HTMLAttributes<HTMLHeadElement>
    body: HTMLAttributes<HTMLBodyElement>
    title: HTMLAttributes<HTMLTitleElement>
    meta: MetaHTMLAttributes<HTMLMetaElement>
    link: LinkHTMLAttributes<HTMLLinkElement>
    style: StyleHTMLAttributes<HTMLStyleElement>
    script: ScriptHTMLAttributes<HTMLScriptElement>
    noscript: HTMLAttributes<HTMLElement>

    // Layout & Semantic
    div: HTMLAttributes<HTMLDivElement>
    span: HTMLAttributes<HTMLSpanElement>
    main: HTMLAttributes<HTMLElement>
    header: HTMLAttributes<HTMLElement>
    footer: HTMLAttributes<HTMLElement>
    section: HTMLAttributes<HTMLElement>
    article: HTMLAttributes<HTMLElement>
    aside: HTMLAttributes<HTMLElement>
    nav: HTMLAttributes<HTMLElement>
    address: HTMLAttributes<HTMLElement>

    // Headings
    h1: HTMLAttributes<HTMLHeadingElement>
    h2: HTMLAttributes<HTMLHeadingElement>
    h3: HTMLAttributes<HTMLHeadingElement>
    h4: HTMLAttributes<HTMLHeadingElement>
    h5: HTMLAttributes<HTMLHeadingElement>
    h6: HTMLAttributes<HTMLHeadingElement>
    hgroup: HTMLAttributes<HTMLElement>

    // Text content
    p: HTMLAttributes<HTMLParagraphElement>
    blockquote: BlockquoteHTMLAttributes<HTMLQuoteElement>
    pre: HTMLAttributes<HTMLPreElement>
    figure: HTMLAttributes<HTMLElement>
    figcaption: HTMLAttributes<HTMLElement>
    hr: HTMLAttributes<HTMLHRElement>
    br: HTMLAttributes<HTMLBRElement>
    wbr: HTMLAttributes<HTMLElement>

    // Inline text semantics
    a: AnchorHTMLAttributes<HTMLAnchorElement>
    abbr: HTMLAttributes<HTMLElement>
    b: HTMLAttributes<HTMLElement>
    bdi: HTMLAttributes<HTMLElement>
    bdo: HTMLAttributes<HTMLElement>
    cite: HTMLAttributes<HTMLElement>
    code: HTMLAttributes<HTMLElement>
    data: DataHTMLAttributes<HTMLDataElement>
    dfn: HTMLAttributes<HTMLElement>
    em: HTMLAttributes<HTMLElement>
    i: HTMLAttributes<HTMLElement>
    kbd: HTMLAttributes<HTMLElement>
    mark: HTMLAttributes<HTMLElement>
    q: QuoteHTMLAttributes<HTMLQuoteElement>
    rp: HTMLAttributes<HTMLElement>
    rt: HTMLAttributes<HTMLElement>
    ruby: HTMLAttributes<HTMLElement>
    s: HTMLAttributes<HTMLElement>
    samp: HTMLAttributes<HTMLElement>
    small: HTMLAttributes<HTMLElement>
    strong: HTMLAttributes<HTMLElement>
    sub: HTMLAttributes<HTMLElement>
    sup: HTMLAttributes<HTMLElement>
    time: TimeHTMLAttributes<HTMLTimeElement>
    u: HTMLAttributes<HTMLElement>
    var: HTMLAttributes<HTMLElement>

    // Lists
    ul: HTMLAttributes<HTMLUListElement>
    ol: OlHTMLAttributes<HTMLOListElement>
    li: LiHTMLAttributes<HTMLLIElement>
    dl: HTMLAttributes<HTMLDListElement>
    dt: HTMLAttributes<HTMLElement>
    dd: HTMLAttributes<HTMLElement>
    menu: HTMLAttributes<HTMLMenuElement>

    // Tables
    table: TableHTMLAttributes<HTMLTableElement>
    caption: HTMLAttributes<HTMLTableCaptionElement>
    colgroup: ColgroupHTMLAttributes<HTMLTableColElement>
    col: ColHTMLAttributes<HTMLTableColElement>
    thead: HTMLAttributes<HTMLTableSectionElement>
    tbody: HTMLAttributes<HTMLTableSectionElement>
    tfoot: HTMLAttributes<HTMLTableSectionElement>
    tr: HTMLAttributes<HTMLTableRowElement>
    th: ThHTMLAttributes<HTMLTableCellElement>
    td: TdHTMLAttributes<HTMLTableCellElement>

    // Forms
    form: FormHTMLAttributes<HTMLFormElement>
    fieldset: FieldsetHTMLAttributes<HTMLFieldSetElement>
    legend: HTMLAttributes<HTMLLegendElement>
    label: LabelHTMLAttributes<HTMLLabelElement>
    input: InputHTMLAttributes<HTMLInputElement>
    button: ButtonHTMLAttributes<HTMLButtonElement>
    select: SelectHTMLAttributes<HTMLSelectElement>
    datalist: HTMLAttributes<HTMLDataListElement>
    optgroup: OptgroupHTMLAttributes<HTMLOptGroupElement>
    option: OptionHTMLAttributes<HTMLOptionElement>
    textarea: TextareaHTMLAttributes<HTMLTextAreaElement>
    output: OutputHTMLAttributes<HTMLOutputElement>
    progress: ProgressHTMLAttributes<HTMLProgressElement>
    meter: MeterHTMLAttributes<HTMLMeterElement>

    // Interactive
    details: DetailsHTMLAttributes<HTMLDetailsElement>
    summary: HTMLAttributes<HTMLElement>
    dialog: DialogHTMLAttributes<HTMLDialogElement>

    // Media
    img: ImgHTMLAttributes<HTMLImageElement>
    picture: HTMLAttributes<HTMLPictureElement>
    source: SourceHTMLAttributes<HTMLSourceElement>
    audio: AudioVideoHTMLAttributes<HTMLAudioElement>
    video: AudioVideoHTMLAttributes<HTMLVideoElement>
    track: TrackHTMLAttributes<HTMLTrackElement>
    map: MapHTMLAttributes<HTMLMapElement>
    area: AreaHTMLAttributes<HTMLAreaElement>

    // Embedded content
    iframe: IframeHTMLAttributes<HTMLIFrameElement>
    embed: EmbedHTMLAttributes<HTMLEmbedElement>
    object: ObjectHTMLAttributes<HTMLObjectElement>
    param: ParamHTMLAttributes<HTMLParamElement>
    canvas: CanvasHTMLAttributes<HTMLCanvasElement>

    // SVG (basic support)
    svg: SVGAttributes<SVGSVGElement>
    path: SVGAttributes<SVGPathElement>
    circle: SVGAttributes<SVGCircleElement>
    rect: SVGAttributes<SVGRectElement>
    line: SVGAttributes<SVGLineElement>
    polyline: SVGAttributes<SVGPolylineElement>
    polygon: SVGAttributes<SVGPolygonElement>
    ellipse: SVGAttributes<SVGEllipseElement>
    g: SVGAttributes<SVGGElement>
    defs: SVGAttributes<SVGDefsElement>
    use: SVGAttributes<SVGUseElement>
    text: SVGAttributes<SVGTextElement>
    tspan: SVGAttributes<SVGTSpanElement>

    // Web components / other
    template: HTMLAttributes<HTMLTemplateElement>
    slot: SlotHTMLAttributes<HTMLSlotElement>
    portal: HTMLAttributes<HTMLElement>
  }

  export interface ElementChildrenAttribute {
    children: unknown
  }
}

// ============================================================================
// Base HTML Attributes
// ============================================================================

interface HTMLAttributes<T> {
  // Children
  children?: FictNode | FictNode[]

  // JSX special attributes
  key?: string | number

  // Core attributes
  id?: string
  class?: string
  style?: string | Record<string, string | number>
  title?: string
  lang?: string
  dir?: 'ltr' | 'rtl' | 'auto'
  hidden?: boolean | 'hidden' | 'until-found'
  tabIndex?: number
  draggable?: boolean | 'true' | 'false'
  contentEditable?: boolean | 'true' | 'false' | 'inherit'
  spellCheck?: boolean | 'true' | 'false'
  translate?: 'yes' | 'no'
  inert?: boolean
  popover?: 'auto' | 'manual'

  // Experimental / newer
  autofocus?: boolean
  slot?: string
  accessKey?: string

  // Event handlers
  onClick?: (e: MouseEvent) => void
  onDblClick?: (e: MouseEvent) => void
  onMouseDown?: (e: MouseEvent) => void
  onMouseUp?: (e: MouseEvent) => void
  onMouseMove?: (e: MouseEvent) => void
  onMouseEnter?: (e: MouseEvent) => void
  onMouseLeave?: (e: MouseEvent) => void
  onMouseOver?: (e: MouseEvent) => void
  onMouseOut?: (e: MouseEvent) => void
  onContextMenu?: (e: MouseEvent) => void
  onInput?: (e: InputEvent) => void
  onChange?: (e: Event) => void
  onSubmit?: (e: SubmitEvent) => void
  onReset?: (e: Event) => void
  onKeyDown?: (e: KeyboardEvent) => void
  onKeyUp?: (e: KeyboardEvent) => void
  onKeyPress?: (e: KeyboardEvent) => void
  onFocus?: (e: FocusEvent) => void
  onBlur?: (e: FocusEvent) => void
  onScroll?: (e: Event) => void
  onWheel?: (e: WheelEvent) => void
  onLoad?: (e: Event) => void
  onError?: (e: Event) => void

  // Drag events
  onDrag?: (e: DragEvent) => void
  onDragStart?: (e: DragEvent) => void
  onDragEnd?: (e: DragEvent) => void
  onDragEnter?: (e: DragEvent) => void
  onDragLeave?: (e: DragEvent) => void
  onDragOver?: (e: DragEvent) => void
  onDrop?: (e: DragEvent) => void

  // Touch events
  onTouchStart?: (e: TouchEvent) => void
  onTouchMove?: (e: TouchEvent) => void
  onTouchEnd?: (e: TouchEvent) => void
  onTouchCancel?: (e: TouchEvent) => void

  // Animation events
  onAnimationStart?: (e: AnimationEvent) => void
  onAnimationEnd?: (e: AnimationEvent) => void
  onAnimationIteration?: (e: AnimationEvent) => void
  onTransitionEnd?: (e: TransitionEvent) => void

  // Pointer events
  onPointerDown?: (e: PointerEvent) => void
  onPointerUp?: (e: PointerEvent) => void
  onPointerMove?: (e: PointerEvent) => void
  onPointerEnter?: (e: PointerEvent) => void
  onPointerLeave?: (e: PointerEvent) => void
  onPointerOver?: (e: PointerEvent) => void
  onPointerOut?: (e: PointerEvent) => void
  onPointerCancel?: (e: PointerEvent) => void

  // Ref
  ref?: ((el: T | null) => void) | { current: T | null }

  // ARIA attributes (common ones)
  role?: string
  'aria-hidden'?: boolean | 'true' | 'false'
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
  'aria-live'?: 'off' | 'polite' | 'assertive'
  'aria-atomic'?: boolean | 'true' | 'false'
  'aria-busy'?: boolean | 'true' | 'false'
  'aria-current'?: boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time'
  'aria-disabled'?: boolean | 'true' | 'false'
  'aria-expanded'?: boolean | 'true' | 'false'
  'aria-haspopup'?: boolean | 'true' | 'false' | 'menu' | 'listbox' | 'tree' | 'grid' | 'dialog'
  'aria-pressed'?: boolean | 'true' | 'false' | 'mixed'
  'aria-selected'?: boolean | 'true' | 'false'
  'aria-checked'?: boolean | 'true' | 'false' | 'mixed'
  'aria-controls'?: string
  'aria-owns'?: string
  'aria-activedescendant'?: string
  'aria-valuemin'?: number
  'aria-valuemax'?: number
  'aria-valuenow'?: number
  'aria-valuetext'?: string
  'aria-orientation'?: 'horizontal' | 'vertical'
  'aria-readonly'?: boolean | 'true' | 'false'
  'aria-required'?: boolean | 'true' | 'false'
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling'
  'aria-errormessage'?: string
  'aria-modal'?: boolean | 'true' | 'false'
  'aria-placeholder'?: string
  'aria-sort'?: 'none' | 'ascending' | 'descending' | 'other'
  'aria-colcount'?: number
  'aria-colindex'?: number
  'aria-colspan'?: number
  'aria-rowcount'?: number
  'aria-rowindex'?: number
  'aria-rowspan'?: number
  'aria-setsize'?: number
  'aria-posinset'?: number
  'aria-level'?: number
  'aria-multiselectable'?: boolean | 'true' | 'false'
  'aria-autocomplete'?: 'none' | 'inline' | 'list' | 'both'
  'aria-details'?: string
  'aria-keyshortcuts'?: string
  'aria-roledescription'?: string

  // Data attributes via index signature
  [key: `data-${string}`]: string | number | boolean | undefined
}

// ============================================================================
// Specialized Attribute Interfaces
// ============================================================================

interface AnchorHTMLAttributes<T> extends HTMLAttributes<T> {
  href?: string
  target?: '_self' | '_blank' | '_parent' | '_top' | string
  rel?: string
  download?: boolean | string
  hreflang?: string
  type?: string
  referrerPolicy?: ReferrerPolicy
  ping?: string
}

interface ButtonHTMLAttributes<T> extends HTMLAttributes<T> {
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
  name?: string
  value?: string
  form?: string
  formAction?: string
  formEncType?: string
  formMethod?: string
  formNoValidate?: boolean
  formTarget?: string
  popovertarget?: string
  popovertargetaction?: 'show' | 'hide' | 'toggle'
}

interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
  type?: string
  value?: string | number | readonly string[]
  defaultValue?: string | number | readonly string[]
  checked?: boolean
  defaultChecked?: boolean
  disabled?: boolean
  placeholder?: string
  name?: string
  form?: string
  required?: boolean
  readonly?: boolean
  multiple?: boolean
  min?: number | string
  max?: number | string
  minLength?: number
  maxLength?: number
  step?: number | string
  pattern?: string
  size?: number
  accept?: string
  capture?: boolean | 'user' | 'environment'
  list?: string
  autoComplete?: string
  autoCapitalize?: string
  inputMode?: 'none' | 'text' | 'decimal' | 'numeric' | 'tel' | 'search' | 'email' | 'url'
  enterKeyHint?: 'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send'
  height?: number | string
  width?: number | string
  alt?: string
  src?: string
  formAction?: string
  formEncType?: string
  formMethod?: string
  formNoValidate?: boolean
  formTarget?: string
}

interface FormHTMLAttributes<T> extends HTMLAttributes<T> {
  action?: string
  method?: 'get' | 'post' | 'dialog'
  encType?: string
  target?: string
  name?: string
  noValidate?: boolean
  autoComplete?: 'on' | 'off'
  acceptCharset?: string
}

interface ImgHTMLAttributes<T> extends HTMLAttributes<T> {
  src?: string
  alt?: string
  width?: number | string
  height?: number | string
  srcSet?: string
  sizes?: string
  loading?: 'eager' | 'lazy'
  decoding?: 'async' | 'auto' | 'sync'
  crossOrigin?: 'anonymous' | 'use-credentials'
  referrerPolicy?: ReferrerPolicy
  useMap?: string
  isMap?: boolean
  fetchPriority?: 'auto' | 'high' | 'low'
}

interface TextareaHTMLAttributes<T> extends HTMLAttributes<T> {
  value?: string | number
  defaultValue?: string
  disabled?: boolean
  placeholder?: string
  name?: string
  form?: string
  required?: boolean
  readonly?: boolean
  rows?: number
  cols?: number
  minLength?: number
  maxLength?: number
  wrap?: 'hard' | 'soft' | 'off'
  autoComplete?: string
}

interface SelectHTMLAttributes<T> extends HTMLAttributes<T> {
  value?: string | number | readonly string[]
  defaultValue?: string | number | readonly string[]
  disabled?: boolean
  name?: string
  form?: string
  required?: boolean
  multiple?: boolean
  size?: number
  autoComplete?: string
}

interface OptionHTMLAttributes<T> extends HTMLAttributes<T> {
  value?: string | number
  disabled?: boolean
  selected?: boolean
  label?: string
}

interface OptgroupHTMLAttributes<T> extends HTMLAttributes<T> {
  disabled?: boolean
  label?: string
}

interface LabelHTMLAttributes<T> extends HTMLAttributes<T> {
  for?: string
  htmlFor?: string
  form?: string
}

interface FieldsetHTMLAttributes<T> extends HTMLAttributes<T> {
  disabled?: boolean
  name?: string
  form?: string
}

interface OutputHTMLAttributes<T> extends HTMLAttributes<T> {
  for?: string
  htmlFor?: string
  form?: string
  name?: string
}

interface ProgressHTMLAttributes<T> extends HTMLAttributes<T> {
  value?: number | string
  max?: number | string
}

interface MeterHTMLAttributes<T> extends HTMLAttributes<T> {
  value?: number | string
  min?: number | string
  max?: number | string
  low?: number | string
  high?: number | string
  optimum?: number | string
}

// Table elements
interface TableHTMLAttributes<T> extends HTMLAttributes<T> {
  cellPadding?: number | string
  cellSpacing?: number | string
  border?: number | string
}

interface ThHTMLAttributes<T> extends HTMLAttributes<T> {
  colSpan?: number
  rowSpan?: number
  scope?: 'row' | 'col' | 'rowgroup' | 'colgroup'
  abbr?: string
  headers?: string
}

interface TdHTMLAttributes<T> extends HTMLAttributes<T> {
  colSpan?: number
  rowSpan?: number
  headers?: string
}

interface ColHTMLAttributes<T> extends HTMLAttributes<T> {
  span?: number
}

interface ColgroupHTMLAttributes<T> extends HTMLAttributes<T> {
  span?: number
}

// List elements
interface OlHTMLAttributes<T> extends HTMLAttributes<T> {
  start?: number
  reversed?: boolean
  type?: '1' | 'a' | 'A' | 'i' | 'I'
}

interface LiHTMLAttributes<T> extends HTMLAttributes<T> {
  value?: number
}

// Media elements
interface AudioVideoHTMLAttributes<T> extends HTMLAttributes<T> {
  src?: string
  controls?: boolean
  autoPlay?: boolean
  loop?: boolean
  muted?: boolean
  preload?: 'none' | 'metadata' | 'auto'
  crossOrigin?: 'anonymous' | 'use-credentials'
  poster?: string // video only
  width?: number | string // video only
  height?: number | string // video only
  playsInline?: boolean
  disableRemotePlayback?: boolean
  onPlay?: (e: Event) => void
  onPause?: (e: Event) => void
  onEnded?: (e: Event) => void
  onTimeUpdate?: (e: Event) => void
  onVolumeChange?: (e: Event) => void
  onSeeking?: (e: Event) => void
  onSeeked?: (e: Event) => void
  onLoadedData?: (e: Event) => void
  onLoadedMetadata?: (e: Event) => void
  onCanPlay?: (e: Event) => void
  onCanPlayThrough?: (e: Event) => void
  onWaiting?: (e: Event) => void
  onPlaying?: (e: Event) => void
  onProgress?: (e: Event) => void
  onDurationChange?: (e: Event) => void
  onRateChange?: (e: Event) => void
  onStalled?: (e: Event) => void
  onSuspend?: (e: Event) => void
  onEmptied?: (e: Event) => void
}

interface SourceHTMLAttributes<T> extends HTMLAttributes<T> {
  src?: string
  srcSet?: string
  sizes?: string
  type?: string
  media?: string
  width?: number | string
  height?: number | string
}

interface TrackHTMLAttributes<T> extends HTMLAttributes<T> {
  src?: string
  srcLang?: string
  label?: string
  kind?: 'subtitles' | 'captions' | 'descriptions' | 'chapters' | 'metadata'
  default?: boolean
}

// Embedded content
interface IframeHTMLAttributes<T> extends HTMLAttributes<T> {
  src?: string
  srcDoc?: string
  name?: string
  width?: number | string
  height?: number | string
  allow?: string
  allowFullScreen?: boolean
  sandbox?: string
  loading?: 'eager' | 'lazy'
  referrerPolicy?: ReferrerPolicy
}

interface EmbedHTMLAttributes<T> extends HTMLAttributes<T> {
  src?: string
  type?: string
  width?: number | string
  height?: number | string
}

interface ObjectHTMLAttributes<T> extends HTMLAttributes<T> {
  data?: string
  type?: string
  name?: string
  width?: number | string
  height?: number | string
  form?: string
  useMap?: string
}

interface ParamHTMLAttributes<T> extends HTMLAttributes<T> {
  name?: string
  value?: string
}

interface CanvasHTMLAttributes<T> extends HTMLAttributes<T> {
  width?: number | string
  height?: number | string
}

interface MapHTMLAttributes<T> extends HTMLAttributes<T> {
  name?: string
}

interface AreaHTMLAttributes<T> extends HTMLAttributes<T> {
  alt?: string
  coords?: string
  href?: string
  hreflang?: string
  download?: boolean | string
  rel?: string
  shape?: 'rect' | 'circle' | 'poly' | 'default'
  target?: string
  referrerPolicy?: ReferrerPolicy
  ping?: string
}

// Interactive elements
interface DetailsHTMLAttributes<T> extends HTMLAttributes<T> {
  open?: boolean
  onToggle?: (e: Event) => void
}

interface DialogHTMLAttributes<T> extends HTMLAttributes<T> {
  open?: boolean
  onClose?: (e: Event) => void
  onCancel?: (e: Event) => void
}

// Other elements
interface BlockquoteHTMLAttributes<T> extends HTMLAttributes<T> {
  cite?: string
}

interface QuoteHTMLAttributes<T> extends HTMLAttributes<T> {
  cite?: string
}

interface TimeHTMLAttributes<T> extends HTMLAttributes<T> {
  dateTime?: string
}

interface DataHTMLAttributes<T> extends HTMLAttributes<T> {
  value?: string
}

interface MetaHTMLAttributes<T> extends HTMLAttributes<T> {
  name?: string
  content?: string
  httpEquiv?: string
  charSet?: string
  property?: string
}

interface LinkHTMLAttributes<T> extends HTMLAttributes<T> {
  href?: string
  rel?: string
  type?: string
  media?: string
  as?: string
  crossOrigin?: 'anonymous' | 'use-credentials'
  referrerPolicy?: ReferrerPolicy
  sizes?: string
  hreflang?: string
  integrity?: string
  fetchPriority?: 'auto' | 'high' | 'low'
  disabled?: boolean
}

interface StyleHTMLAttributes<T> extends HTMLAttributes<T> {
  media?: string
  nonce?: string
  blocking?: string
}

interface ScriptHTMLAttributes<T> extends HTMLAttributes<T> {
  src?: string
  type?: string
  async?: boolean
  defer?: boolean
  crossOrigin?: 'anonymous' | 'use-credentials'
  integrity?: string
  noModule?: boolean
  nonce?: string
  referrerPolicy?: ReferrerPolicy
  fetchPriority?: 'auto' | 'high' | 'low'
  blocking?: string
}

interface SlotHTMLAttributes<T> extends HTMLAttributes<T> {
  name?: string
  onSlotchange?: (e: Event) => void
}

// SVG Attributes (basic support)
interface SVGAttributes<T> extends HTMLAttributes<T> {
  // Core SVG attributes
  viewBox?: string
  xmlns?: string
  xmlnsXlink?: string
  fill?: string
  stroke?: string
  strokeWidth?: string | number
  strokeLinecap?: 'butt' | 'round' | 'square'
  strokeLinejoin?: 'miter' | 'round' | 'bevel'
  strokeDasharray?: string
  strokeDashoffset?: string | number
  strokeOpacity?: string | number
  fillOpacity?: string | number
  opacity?: string | number
  transform?: string
  transformOrigin?: string
  clipPath?: string
  mask?: string
  filter?: string

  // Shape attributes
  d?: string
  cx?: string | number
  cy?: string | number
  r?: string | number
  rx?: string | number
  ry?: string | number
  x?: string | number
  y?: string | number
  x1?: string | number
  y1?: string | number
  x2?: string | number
  y2?: string | number
  width?: string | number
  height?: string | number
  points?: string
  pathLength?: string | number

  // Text attributes
  textAnchor?: 'start' | 'middle' | 'end'
  dominantBaseline?: string
  dx?: string | number
  dy?: string | number
  fontSize?: string | number
  fontFamily?: string
  fontWeight?: string | number

  // Use element
  href?: string
  xlinkHref?: string

  // Gradient/pattern
  gradientUnits?: 'userSpaceOnUse' | 'objectBoundingBox'
  gradientTransform?: string
  spreadMethod?: 'pad' | 'reflect' | 'repeat'
  offset?: string | number
  stopColor?: string
  stopOpacity?: string | number

  // Clip/mask
  clipPathUnits?: 'userSpaceOnUse' | 'objectBoundingBox'
  maskUnits?: 'userSpaceOnUse' | 'objectBoundingBox'
  maskContentUnits?: 'userSpaceOnUse' | 'objectBoundingBox'

  // Other
  preserveAspectRatio?: string
  markerStart?: string
  markerMid?: string
  markerEnd?: string
  vectorEffect?: string
}
