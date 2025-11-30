export type DOMElement = HTMLElement | Text

export interface FictVNode {
  type: unknown
  props: Record<string, unknown> | null
  key?: string | undefined
}

export type FictNode = FictVNode | string | number | boolean | null | undefined
