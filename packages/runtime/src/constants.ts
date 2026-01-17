/**
 * Fict DOM Constants
 *
 * Property constants and configurations for DOM attribute handling.
 * Borrowed from dom-expressions for comprehensive DOM support.
 */

import { DelegatedEventNames } from './delegated-events'

const isDev =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process === 'undefined' || process.env?.NODE_ENV !== 'production'

// ============================================================================
// Boolean Attributes
// ============================================================================

/**
 * Complete list of boolean attributes (lowercase)
 * These attributes are set as empty strings when true, removed when false
 */
const booleans = isDev
  ? [
      'allowfullscreen',
      'async',
      'alpha', // HTMLInputElement
      'autofocus', // HTMLElement prop
      'autoplay',
      'checked',
      'controls',
      'default',
      'disabled',
      'formnovalidate',
      'hidden', // HTMLElement prop
      'indeterminate',
      'inert', // HTMLElement prop
      'ismap',
      'loop',
      'multiple',
      'muted',
      'nomodule',
      'novalidate',
      'open',
      'playsinline',
      'readonly',
      'required',
      'reversed',
      'seamless', // HTMLIframeElement - non-standard
      'selected',
      // Experimental attributes
      'adauctionheaders',
      'browsingtopics',
      'credentialless',
      'defaultchecked',
      'defaultmuted',
      'defaultselected',
      'defer',
      'disablepictureinpicture',
      'disableremoteplayback',
      'preservespitch',
      'shadowrootclonable',
      'shadowrootcustomelementregistry',
      'shadowrootdelegatesfocus',
      'shadowrootserializable',
      'sharedstoragewritable',
    ]
  : []

export const BooleanAttributes = new Set<string>(booleans)

// ============================================================================
// Properties Set
// ============================================================================

/**
 * Properties that should be set via DOM property (not attribute)
 * Includes camelCase versions of boolean attributes
 */
const properties = isDev
  ? [
      // Core properties
      'className',
      'value',

      // CamelCase booleans
      'readOnly',
      'noValidate',
      'formNoValidate',
      'isMap',
      'noModule',
      'playsInline',

      // Experimental (camelCase)
      'adAuctionHeaders',
      'allowFullscreen',
      'browsingTopics',
      'defaultChecked',
      'defaultMuted',
      'defaultSelected',
      'disablePictureInPicture',
      'disableRemotePlayback',
      'preservesPitch',
      'shadowRootClonable',
      'shadowRootCustomElementRegistry',
      'shadowRootDelegatesFocus',
      'shadowRootSerializable',
      'sharedStorageWritable',

      // All lowercase booleans
      ...booleans,
    ]
  : []

export const Properties = new Set<string>(properties)

// ============================================================================
// Child Properties
// ============================================================================

/**
 * Properties that represent children/content
 */
export const ChildProperties = new Set<string>([
  'innerHTML',
  'textContent',
  'innerText',
  'children',
])

// ============================================================================
// Property Aliases
// ============================================================================

/**
 * React compatibility aliases (className -> class)
 */
export const Aliases: Record<string, string> = {
  className: 'class',
  htmlFor: 'for',
}

/**
 * Element-specific property aliases
 * Maps lowercase attribute names to their camelCase property equivalents
 * Only for specific elements that have these properties
 */
const PropAliases: Record<string, string | { $: string; [tagName: string]: string | number }> =
  isDev
    ? {
        // Direct mapping
        class: 'className',

        // Element-specific mappings
        novalidate: {
          $: 'noValidate',
          FORM: 1,
        },
        formnovalidate: {
          $: 'formNoValidate',
          BUTTON: 1,
          INPUT: 1,
        },
        ismap: {
          $: 'isMap',
          IMG: 1,
        },
        nomodule: {
          $: 'noModule',
          SCRIPT: 1,
        },
        playsinline: {
          $: 'playsInline',
          VIDEO: 1,
        },
        readonly: {
          $: 'readOnly',
          INPUT: 1,
          TEXTAREA: 1,
        },

        // Experimental element-specific
        adauctionheaders: {
          $: 'adAuctionHeaders',
          IFRAME: 1,
        },
        allowfullscreen: {
          $: 'allowFullscreen',
          IFRAME: 1,
        },
        browsingtopics: {
          $: 'browsingTopics',
          IMG: 1,
        },
        defaultchecked: {
          $: 'defaultChecked',
          INPUT: 1,
        },
        defaultmuted: {
          $: 'defaultMuted',
          AUDIO: 1,
          VIDEO: 1,
        },
        defaultselected: {
          $: 'defaultSelected',
          OPTION: 1,
        },
        disablepictureinpicture: {
          $: 'disablePictureInPicture',
          VIDEO: 1,
        },
        disableremoteplayback: {
          $: 'disableRemotePlayback',
          AUDIO: 1,
          VIDEO: 1,
        },
        preservespitch: {
          $: 'preservesPitch',
          AUDIO: 1,
          VIDEO: 1,
        },
        shadowrootclonable: {
          $: 'shadowRootClonable',
          TEMPLATE: 1,
        },
        shadowrootdelegatesfocus: {
          $: 'shadowRootDelegatesFocus',
          TEMPLATE: 1,
        },
        shadowrootserializable: {
          $: 'shadowRootSerializable',
          TEMPLATE: 1,
        },
        sharedstoragewritable: {
          $: 'sharedStorageWritable',
          IFRAME: 1,
          IMG: 1,
        },
      }
    : {}

/**
 * Get the property alias for a given attribute and tag name
 */
export function getPropAlias(prop: string, tagName: string): string | undefined {
  if (!isDev) return undefined
  const a = PropAliases[prop]
  if (typeof a === 'object') {
    return a[tagName] ? a['$'] : undefined
  }
  return a
}

// ============================================================================
// Event Delegation
// ============================================================================

/**
 * Symbol for storing delegated events on the document
 */
export const $$EVENTS = '_$FICT_DELEGATE'

/**
 * Events that should use event delegation for performance
 * These events bubble and are commonly used across many elements
 * Note: This must match the compiler's DelegatedEvents set
 */
export const DelegatedEvents = new Set<string>(DelegatedEventNames)

// ============================================================================
// SVG Support
// ============================================================================

/**
 * SVG element names (excluding common ones that overlap with HTML)
 */
const svgElements = isDev
  ? [
      'altGlyph',
      'altGlyphDef',
      'altGlyphItem',
      'animate',
      'animateColor',
      'animateMotion',
      'animateTransform',
      'circle',
      'clipPath',
      'color-profile',
      'cursor',
      'defs',
      'desc',
      'ellipse',
      'feBlend',
      'feColorMatrix',
      'feComponentTransfer',
      'feComposite',
      'feConvolveMatrix',
      'feDiffuseLighting',
      'feDisplacementMap',
      'feDistantLight',
      'feDropShadow',
      'feFlood',
      'feFuncA',
      'feFuncB',
      'feFuncG',
      'feFuncR',
      'feGaussianBlur',
      'feImage',
      'feMerge',
      'feMergeNode',
      'feMorphology',
      'feOffset',
      'fePointLight',
      'feSpecularLighting',
      'feSpotLight',
      'feTile',
      'feTurbulence',
      'filter',
      'font',
      'font-face',
      'font-face-format',
      'font-face-name',
      'font-face-src',
      'font-face-uri',
      'foreignObject',
      'g',
      'glyph',
      'glyphRef',
      'hkern',
      'image',
      'line',
      'linearGradient',
      'marker',
      'mask',
      'metadata',
      'missing-glyph',
      'mpath',
      'path',
      'pattern',
      'polygon',
      'polyline',
      'radialGradient',
      'rect',
      'set',
      'stop',
      'svg',
      'switch',
      'symbol',
      'text',
      'textPath',
      'tref',
      'tspan',
      'use',
      'view',
      'vkern',
    ]
  : []

export const SVGElements = new Set<string>(svgElements)

/**
 * SVG attribute namespaces
 */
export const SVGNamespace: Record<string, string> = {
  xlink: 'http://www.w3.org/1999/xlink',
  xml: 'http://www.w3.org/XML/1998/namespace',
}

// ============================================================================
// Unitless CSS Properties
// ============================================================================

/**
 * CSS properties that don't need a unit (like 'px')
 */
const unitlessList = isDev
  ? [
      'animationIterationCount',
      'animation-iteration-count',
      'borderImageOutset',
      'border-image-outset',
      'borderImageSlice',
      'border-image-slice',
      'borderImageWidth',
      'border-image-width',
      'boxFlex',
      'box-flex',
      'boxFlexGroup',
      'box-flex-group',
      'boxOrdinalGroup',
      'box-ordinal-group',
      'columnCount',
      'column-count',
      'columns',
      'flex',
      'flexGrow',
      'flex-grow',
      'flexPositive',
      'flex-positive',
      'flexShrink',
      'flex-shrink',
      'flexNegative',
      'flex-negative',
      'flexOrder',
      'flex-order',
      'gridRow',
      'grid-row',
      'gridRowEnd',
      'grid-row-end',
      'gridRowSpan',
      'grid-row-span',
      'gridRowStart',
      'grid-row-start',
      'gridColumn',
      'grid-column',
      'gridColumnEnd',
      'grid-column-end',
      'gridColumnSpan',
      'grid-column-span',
      'gridColumnStart',
      'grid-column-start',
      'fontWeight',
      'font-weight',
      'lineClamp',
      'line-clamp',
      'lineHeight',
      'line-height',
      'opacity',
      'order',
      'orphans',
      'tabSize',
      'tab-size',
      'widows',
      'zIndex',
      'z-index',
      'zoom',
      'fillOpacity',
      'fill-opacity',
      'floodOpacity',
      'flood-opacity',
      'stopOpacity',
      'stop-opacity',
      'strokeDasharray',
      'stroke-dasharray',
      'strokeDashoffset',
      'stroke-dashoffset',
      'strokeMiterlimit',
      'stroke-miterlimit',
      'strokeOpacity',
      'stroke-opacity',
      'strokeWidth',
      'stroke-width',
    ]
  : ['opacity', 'zIndex']

export const UnitlessStyles = new Set<string>(unitlessList)
