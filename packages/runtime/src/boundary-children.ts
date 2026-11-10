import { isReactive, reactive } from './binding'
import { Fragment } from './jsx'
import { unwrapProps } from './props'
import type { BaseProps, FictNode } from './types'

/** Keep a reactive children prop inside the boundary's owned child binding. */
export function readBoundaryChildren(props: BaseProps): FictNode {
  const raw = unwrapProps(props as Record<string, unknown>)
  const descriptor = Object.getOwnPropertyDescriptor(raw, 'children')
  if (!descriptor?.get && !isReactive(descriptor?.value)) return props.children ?? null

  return {
    type: Fragment,
    props: {
      children: reactive(() => {
        const value = props.children
        return isReactive(value) ? (value() as FictNode) : (value ?? null)
      }),
    },
  }
}
