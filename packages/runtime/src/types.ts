export type DOMElement = Node

export type Cleanup = () => void

export interface FictVNode {
  type: string | symbol | ((props: Record<string, unknown>) => FictNode)
  props: Record<string, unknown> | null
  key?: string | undefined
}

export type FictNode = FictVNode | FictNode[] | Node | string | number | boolean | null | undefined
