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
    div: HTMLAttributes<HTMLDivElement>
    span: HTMLAttributes<HTMLSpanElement>
    p: HTMLAttributes<HTMLParagraphElement>
    a: AnchorHTMLAttributes<HTMLAnchorElement>
    button: ButtonHTMLAttributes<HTMLButtonElement>
    input: InputHTMLAttributes<HTMLInputElement>
    form: FormHTMLAttributes<HTMLFormElement>
    img: ImgHTMLAttributes<HTMLImageElement>
    ul: HTMLAttributes<HTMLUListElement>
    ol: HTMLAttributes<HTMLOListElement>
    li: HTMLAttributes<HTMLLIElement>
    h1: HTMLAttributes<HTMLHeadingElement>
    h2: HTMLAttributes<HTMLHeadingElement>
    h3: HTMLAttributes<HTMLHeadingElement>
    h4: HTMLAttributes<HTMLHeadingElement>
    h5: HTMLAttributes<HTMLHeadingElement>
    h6: HTMLAttributes<HTMLHeadingElement>
  }

  export interface ElementChildrenAttribute {
    children: unknown
  }
}

interface HTMLAttributes<T> {
  children?: FictNode | FictNode[]
  class?: string
  id?: string
  style?: string | Record<string, string | number>
  onClick?: (e: MouseEvent) => void
  onInput?: (e: InputEvent) => void
  onChange?: (e: Event) => void
  onSubmit?: (e: SubmitEvent) => void
  onKeyDown?: (e: KeyboardEvent) => void
  onKeyUp?: (e: KeyboardEvent) => void
  onFocus?: (e: FocusEvent) => void
  onBlur?: (e: FocusEvent) => void
  ref?: (el: T) => void
}

interface AnchorHTMLAttributes<T> extends HTMLAttributes<T> {
  href?: string
  target?: string
  rel?: string
}

interface ButtonHTMLAttributes<T> extends HTMLAttributes<T> {
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
}

interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
  type?: string
  value?: string | number
  checked?: boolean
  disabled?: boolean
  placeholder?: string
  name?: string
}

interface FormHTMLAttributes<T> extends HTMLAttributes<T> {
  action?: string
  method?: string
}

interface ImgHTMLAttributes<T> extends HTMLAttributes<T> {
  src?: string
  alt?: string
  width?: number | string
  height?: number | string
}
