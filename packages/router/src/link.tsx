/**
 * @fileoverview Link components for @fictjs/router
 *
 * This module provides Link and NavLink components for declarative navigation.
 * Integrates with Fict's reactive system for active state tracking.
 */

import {
  createEffect,
  hasContext,
  untrack,
  type FictNode,
  type JSX,
  type StyleProp,
} from '@fictjs/runtime'
import { createSignal, reactive } from '@fictjs/runtime/advanced'
import { __fictPropsRest, spread } from '@fictjs/runtime/internal'

import {
  useRouter,
  useRoute,
  useIsActive,
  useHref,
  usePendingLocation,
  readAccessor,
  RouteContext,
  type MaybeAccessor,
} from './context'
import type { To, NavigateOptions } from './types'
import { parseURL, prependBasePath, stripBasePath } from './utils'

// CSS Properties type for styles
type CSSProperties = NonNullable<StyleProp>

const joinClassNames = (
  base: string | undefined,
  active: string | undefined,
  pending: string | undefined,
): string | undefined => {
  const className = [base, active, pending].filter(Boolean).join(' ')
  return className || undefined
}

const mergeStyles = (
  base: CSSProperties | undefined,
  active: CSSProperties | undefined,
  pending: CSSProperties | undefined,
): CSSProperties | undefined => {
  const isStyleObject = (
    style: CSSProperties | undefined,
  ): style is Exclude<CSSProperties, string> => style !== undefined && typeof style === 'object'

  if (!isStyleObject(base) && !isStyleObject(active) && !isStyleObject(pending)) {
    return pending ?? active ?? base ?? undefined
  }

  const style = {
    ...(isStyleObject(base) ? base : {}),
    ...(isStyleObject(active) ? active : {}),
    ...(isStyleObject(pending) ? pending : {}),
  }
  return Object.keys(style).length > 0 ? style : undefined
}

const ABSOLUTE_URL_PATTERN = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i

function getExternalHref(to: To): string | null {
  const pathname = typeof to === 'string' ? to : to.pathname || ''
  if (!ABSOLUTE_URL_PATTERN.test(pathname)) return null
  if (typeof to === 'string') return to
  return `${pathname}${to.search || ''}${to.hash || ''}`
}

function getResolvedNavigationTarget(to: To, href: string): To {
  if (typeof to === 'string') return href
  const resolved = parseURL(href)
  return {
    ...to,
    pathname: resolved.pathname,
    search: resolved.search,
    hash: resolved.hash,
  }
}

interface LinkBehaviorSnapshot {
  to: To
  replace: boolean | undefined
  state: unknown
  scroll: boolean | undefined
  relative: 'route' | 'path' | undefined
  reloadDocument: boolean | undefined
  prefetch: 'none' | 'intent' | 'render' | undefined
  disabled: boolean | undefined
  externalHref: string | null
}

type LinkBehaviorProps = Pick<
  LinkProps,
  | 'to'
  | 'replace'
  | 'state'
  | 'scroll'
  | 'relative'
  | 'reloadDocument'
  | 'prefetch'
  | 'disabled'
  | 'onClick'
  | 'onMouseEnter'
  | 'onFocus'
>

function readLinkBehavior(props: LinkBehaviorProps): LinkBehaviorSnapshot {
  const to = props.to
  return {
    to,
    replace: props.replace,
    state: props.state,
    scroll: props.scroll,
    relative: props.relative,
    reloadDocument: props.reloadDocument,
    prefetch: props.prefetch,
    disabled: props.disabled,
    externalHref: getExternalHref(to),
  }
}

function readLinkClick(
  props: LinkBehaviorProps,
  event: MouseEvent,
): LinkBehaviorSnapshot | undefined {
  untrack(() => props.onClick?.(event))
  if (event.defaultPrevented) return undefined

  const anchor = event.currentTarget as HTMLAnchorElement
  if (anchor.hasAttribute('download')) return undefined
  if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return undefined
  if (event.button !== 0) return undefined

  const snapshot = untrack(() => readLinkBehavior(props))
  if (snapshot.reloadDocument || snapshot.disabled || snapshot.externalHref) return undefined

  const target = anchor.target
  if (target && target !== '_self') return undefined
  return snapshot
}

function createPreloadBehavior(props: LinkBehaviorProps, getHrefValue: () => string) {
  let lastPreloadedHref: string | undefined

  const trigger = (snapshot: LinkBehaviorSnapshot) => {
    if (snapshot.disabled || snapshot.externalHref || snapshot.prefetch === 'none') return
    const href = getHrefValue()
    if (lastPreloadedHref === href) return
    lastPreloadedHref = href

    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(
        new CustomEvent('fict-router:preload', {
          detail: { href, to: snapshot.to },
        }),
      )
    }
  }

  createEffect(() => {
    const snapshot = readLinkBehavior(props)
    if (snapshot.prefetch === 'render') trigger(snapshot)
  })

  return {
    handleMouseEnter(event: MouseEvent) {
      untrack(() => {
        const snapshot = readLinkBehavior(props)
        if (snapshot.prefetch === 'intent' || snapshot.prefetch === undefined) trigger(snapshot)
        props.onMouseEnter?.(event)
      })
    },
    handleFocus(event: FocusEvent) {
      untrack(() => {
        const snapshot = readLinkBehavior(props)
        if (snapshot.prefetch === 'intent' || snapshot.prefetch === undefined) trigger(snapshot)
        props.onFocus?.(event)
      })
    },
  }
}

const LINK_DOM_PROP_EXCLUSIONS = [
  'to',
  'replace',
  'state',
  'scroll',
  'relative',
  'reloadDocument',
  'prefetch',
  'disabled',
  'onClick',
  'onMouseEnter',
  'onFocus',
  'children',
]

const createSpreadRef = <T extends Element>(
  props: Record<string, unknown> | (() => Record<string, unknown>),
) => {
  let current: T | null = null
  return (el: T | null) => {
    if (!el) {
      current = null
      return
    }
    if (el === current) return
    current = el
    spread(el, props, false, true)
  }
}

// ============================================================================
// Link Component
// ============================================================================

export interface LinkProps extends Omit<JSX.IntrinsicElements['a'], 'href'> {
  /** Navigation target */
  to: To
  /** Replace history entry instead of pushing */
  replace?: boolean
  /** State to pass with navigation */
  state?: unknown
  /** Scroll to top after navigation */
  scroll?: boolean
  /** Relative path resolution mode */
  relative?: 'route' | 'path'
  /** Force full page reload */
  reloadDocument?: boolean
  /** Preload behavior */
  prefetch?: 'none' | 'intent' | 'render'
  /** Prevent navigation (render as text) */
  disabled?: boolean
  /** Custom click handler (called before navigation) */
  onClick?: (event: MouseEvent) => void
  children?: FictNode
}

/**
 * Link component for navigation
 *
 * @example
 * ```tsx
 * <Link to="/about">About</Link>
 * <Link to="/users/123" replace>View User</Link>
 * <Link to={{ pathname: "/search", search: "?q=test" }}>Search</Link>
 * ```
 */
export function Link(props: LinkProps): FictNode {
  const router = useRouter()
  const href = useHref(() => props.to, props)
  const getHrefValue = () => {
    const externalHref = getExternalHref(props.to)
    return externalHref ?? readAccessor(readAccessor(href as MaybeAccessor<MaybeAccessor<string>>))
  }
  const { handleMouseEnter, handleFocus } = createPreloadBehavior(props, getHrefValue)

  const handleClick = (event: MouseEvent) => {
    const snapshot = readLinkClick(props, event)
    if (!snapshot) return
    event.preventDefault()
    const options: NavigateOptions = {
      replace: snapshot.replace,
      state: snapshot.state,
      scroll: snapshot.scroll,
    }
    const target = getResolvedNavigationTarget(snapshot.to, getHrefValue())
    untrack(() => router.navigate(target, options))
  }

  const domProps = __fictPropsRest(
    props as unknown as Record<string, unknown>,
    LINK_DOM_PROP_EXCLUSIONS,
  )
  const anchorRef = createSpreadRef<HTMLAnchorElement>(() => ({
    ...domProps,
    href: getHrefValue(),
    onClick: handleClick,
    onMouseEnter: handleMouseEnter,
    onFocus: handleFocus,
  }))
  const spanRef = createSpreadRef<HTMLSpanElement>(domProps)
  const reactiveChildren = reactive(() => props.children)
  const renderLink = reactive(() =>
    props.disabled ? (
      <span ref={spanRef}>{reactiveChildren as unknown as FictNode}</span>
    ) : (
      <a ref={anchorRef}>{reactiveChildren as unknown as FictNode}</a>
    ),
  )

  // A reactive component root needs a child binding host so disabled can swap
  // the semantic element without remounting the surrounding component.
  return [renderLink as unknown as FictNode]
}

// ============================================================================
// NavLink Component
// ============================================================================

export interface NavLinkRenderProps {
  /** Whether the link is active */
  isActive: boolean
  /** Whether a navigation to this link is pending */
  isPending: boolean
  /** Whether a view transition is in progress */
  isTransitioning: boolean
}

export interface NavLinkProps extends Omit<LinkProps, 'className' | 'style' | 'children'> {
  /** Class name - can be a function that receives render props */
  className?: string | ((props: NavLinkRenderProps) => string | undefined)
  /** Style - can be a function that receives render props */
  style?: CSSProperties | ((props: NavLinkRenderProps) => CSSProperties | undefined)
  /** Children - can be a function that receives render props */
  children?: FictNode | ((props: NavLinkRenderProps) => FictNode)
  /** Only match if path is exactly equal (not a prefix) */
  end?: boolean
  /** Case-sensitive matching */
  caseSensitive?: boolean
  /** Custom active class name */
  activeClassName?: string
  /** Custom pending class name */
  pendingClassName?: string
  /** Custom active style */
  activeStyle?: CSSProperties
  /** Custom pending style */
  pendingStyle?: CSSProperties
  /** aria-current value when active */
  'aria-current'?: 'page' | 'step' | 'location' | 'date' | 'time' | 'true' | 'false'
}

const NAV_LINK_DOM_PROP_EXCLUSIONS = [
  ...LINK_DOM_PROP_EXCLUSIONS,
  'className',
  'style',
  'end',
  'caseSensitive',
  'activeClassName',
  'pendingClassName',
  'activeStyle',
  'pendingStyle',
  'aria-current',
]

/**
 * NavLink component for navigation with active state
 *
 * @example
 * ```tsx
 * <NavLink to="/about" activeClassName="active">About</NavLink>
 *
 * <NavLink to="/users" end>
 *   {({ isActive }) => (
 *     <span className={isActive ? 'active' : ''}>Users</span>
 *   )}
 * </NavLink>
 *
 * <NavLink
 *   to="/dashboard"
 *   className={({ isActive }) => isActive ? 'nav-active' : 'nav-link'}
 * >
 *   Dashboard
 * </NavLink>
 * ```
 */
export function NavLink(props: NavLinkProps): FictNode {
  const router = useRouter()
  const internalIsActive = useIsActive(() => props.to, props)
  const isActive = () =>
    getExternalHref(props.to)
      ? false
      : readAccessor(readAccessor(internalIsActive as MaybeAccessor<MaybeAccessor<boolean>>))
  const href = useHref(() => props.to, props)
  const getHrefValue = () => {
    const externalHref = getExternalHref(props.to)
    return externalHref ?? readAccessor(readAccessor(href as MaybeAccessor<MaybeAccessor<string>>))
  }
  const { handleMouseEnter, handleFocus } = createPreloadBehavior(props, getHrefValue)
  const pendingLocation = usePendingLocation()

  // Compute isPending by comparing pending location with this link's target
  const computeIsPending = (): boolean => {
    const pending = pendingLocation()
    if (!pending) return false

    // Get the resolved path for this link
    const resolvedHref = getHrefValue()
    const base = readAccessor(router.base)
    const baseToStrip = base === '/' ? '' : base

    // Strip base from pending location to compare
    let pendingPathWithoutBase = stripBasePath(pending.pathname, baseToStrip)

    // Parse the resolved href to get pathname
    const parsed = parseURL(resolvedHref)
    let targetPathWithoutBase = stripBasePath(parsed.pathname, baseToStrip)
    if (!props.caseSensitive) {
      pendingPathWithoutBase = pendingPathWithoutBase.toLowerCase()
      targetPathWithoutBase = targetPathWithoutBase.toLowerCase()
    }

    // Check if the pending navigation is to this link's destination
    if (props.end) {
      return pendingPathWithoutBase === targetPathWithoutBase
    }

    return (
      pendingPathWithoutBase === targetPathWithoutBase ||
      pendingPathWithoutBase.startsWith(targetPathWithoutBase + '/')
    )
  }

  const renderProps: NavLinkRenderProps = {
    isActive: false,
    isPending: false,
    isTransitioning: false,
  }

  const computedClassName = createSignal<string | undefined>(undefined)
  const computedStyle = createSignal<CSSProperties | undefined>(undefined)
  const computedChildren = createSignal<FictNode>(undefined)
  const ariaCurrent = createSignal<NavLinkProps['aria-current'] | undefined>(undefined)

  createEffect(() => {
    renderProps.isActive = isActive()
    renderProps.isPending = computeIsPending()
    renderProps.isTransitioning = readAccessor(router.isRouting)

    const classNameProp = props.className
    const styleProp = props.style
    const childrenProp = props.children
    const baseClassName =
      typeof classNameProp === 'function' ? classNameProp(renderProps) : classNameProp
    const activeClassName = renderProps.isActive ? props.activeClassName : undefined
    const pendingClassName = renderProps.isPending ? props.pendingClassName : undefined

    const baseStyle = typeof styleProp === 'function' ? styleProp(renderProps) : styleProp
    const activeStyle = renderProps.isActive ? props.activeStyle : undefined
    const pendingStyle = renderProps.isPending ? props.pendingStyle : undefined

    computedClassName(joinClassNames(baseClassName, activeClassName, pendingClassName))
    computedStyle(mergeStyles(baseStyle, activeStyle, pendingStyle))
    computedChildren(typeof childrenProp === 'function' ? childrenProp(renderProps) : childrenProp)
    ariaCurrent(renderProps.isActive ? (props['aria-current'] ?? 'page') : undefined)
  })

  const handleClick = (event: MouseEvent) => {
    const snapshot = readLinkClick(props, event)
    if (!snapshot) return
    event.preventDefault()
    const target = getResolvedNavigationTarget(snapshot.to, getHrefValue())
    untrack(() =>
      router.navigate(target, {
        replace: snapshot.replace,
        state: snapshot.state,
        scroll: snapshot.scroll,
      }),
    )
  }

  const domProps = __fictPropsRest(
    props as unknown as Record<string, unknown>,
    NAV_LINK_DOM_PROP_EXCLUSIONS,
  )
  const anchorRef = createSpreadRef<HTMLAnchorElement>(() => ({
    ...domProps,
    href: getHrefValue(),
    class: computedClassName(),
    style: computedStyle(),
    'aria-current': ariaCurrent(),
    onClick: handleClick,
    onMouseEnter: handleMouseEnter,
    onFocus: handleFocus,
  }))
  const spanRef = createSpreadRef<HTMLSpanElement>(() => ({
    ...domProps,
    class: computedClassName(),
    style: computedStyle(),
  }))
  const renderNavLink = reactive(() =>
    props.disabled ? (
      <span ref={spanRef}>{computedChildren as unknown as FictNode}</span>
    ) : (
      <a ref={anchorRef}>{computedChildren as unknown as FictNode}</a>
    ),
  )

  return [renderNavLink as unknown as FictNode]
}

// ============================================================================
// Form Component (for actions)
// ============================================================================

export interface FormProps extends Omit<JSX.IntrinsicElements['form'], 'action' | 'method'> {
  /** Form action URL */
  action?: string
  /** HTTP method */
  method?: 'get' | 'post' | 'put' | 'patch' | 'delete'
  /** Replace history entry */
  replace?: boolean
  /** Relative path resolution */
  relative?: 'route' | 'path'
  /** Keep the current scroll position after navigation */
  preventScrollReset?: boolean
  /** Navigate on submit */
  navigate?: boolean
  /** Fetch mode */
  fetcherKey?: string
  children?: FictNode
  onSubmit?: (event: SubmitEvent) => void
}

const FORM_DOM_PROP_EXCLUSIONS = [
  'action',
  'method',
  'replace',
  'relative',
  'preventScrollReset',
  'navigate',
  'fetcherKey',
  'children',
  'onSubmit',
]

interface ResolvedFormAction {
  pathname: string
  search: string
  hash: string
  href: string
  isExternal: boolean
}

type FormSubmitter = HTMLButtonElement | HTMLInputElement
type HandledFormMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const HANDLED_FORM_METHODS = new Set<HandledFormMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

function getAssociatedFormSubmitter(
  candidate: HTMLElement | null | undefined,
  form: HTMLFormElement,
): FormSubmitter | null {
  if (!candidate) return null

  if (candidate.tagName === 'BUTTON') {
    const button = candidate as HTMLButtonElement
    return button.form === form && button.type === 'submit' ? button : null
  }

  if (candidate.tagName === 'INPUT') {
    const input = candidate as HTMLInputElement
    return input.form === form && (input.type === 'submit' || input.type === 'image') ? input : null
  }

  return null
}

function getSubmitterOverride(
  submitter: FormSubmitter | null,
  attribute: 'formaction' | 'formmethod' | 'formtarget',
): string | undefined {
  if (!submitter?.hasAttribute(attribute)) return undefined
  return submitter.getAttribute(attribute) ?? ''
}

function getHandledFormMethod(method: string | undefined): HandledFormMethod | null {
  const normalized = (method ?? 'get').toUpperCase()
  return HANDLED_FORM_METHODS.has(normalized as HandledFormMethod)
    ? (normalized as HandledFormMethod)
    : null
}

function createFormData(form: HTMLFormElement, submitter: FormSubmitter | null): FormData {
  if (!submitter) return new FormData(form)

  try {
    return new FormData(form, submitter)
  } catch {
    // Older FormData implementations do not accept the submitter argument.
    const formData = new FormData(form)
    if (submitter.disabled) return formData

    if (submitter.tagName === 'INPUT' && submitter.type === 'image') {
      const prefix = submitter.name ? `${submitter.name}.` : ''
      formData.append(`${prefix}x`, '0')
      formData.append(`${prefix}y`, '0')
    } else if (submitter.name) {
      formData.append(submitter.name, submitter.value)
    }
    return formData
  }
}

function splitFormAction(action: string): Omit<ResolvedFormAction, 'href' | 'isExternal'> {
  let pathname = action
  let hash = ''
  let search = ''

  const hashIndex = pathname.indexOf('#')
  if (hashIndex >= 0) {
    hash = pathname.slice(hashIndex)
    pathname = pathname.slice(0, hashIndex)
  }

  const searchIndex = pathname.indexOf('?')
  if (searchIndex >= 0) {
    search = pathname.slice(searchIndex)
    pathname = pathname.slice(0, searchIndex)
  }

  return { pathname, search, hash }
}

/**
 * Form component for action submissions
 *
 * @example
 * ```tsx
 * <Form action="/api/submit" method="post">
 *   <input name="email" type="email" />
 *   <button type="submit">Submit</button>
 * </Form>
 * ```
 */
export function Form(props: FormProps): FictNode {
  const router = useRouter()
  const route = useRoute()
  const hasRouteContext = hasContext(RouteContext)

  const resolveAction = (actionOverride?: string): ResolvedFormAction => {
    const rawAction = actionOverride ?? props.action ?? '.'
    const externalHref = getExternalHref(rawAction)
    const action = splitFormAction(rawAction)

    if (externalHref !== null) {
      return { ...action, href: externalHref, isExternal: true }
    }

    const resolver =
      (props.relative ?? 'route') === 'path' || !hasRouteContext
        ? readAccessor(router.resolvePath as MaybeAccessor<(to: To) => string>)
        : readAccessor(route.resolvePath as MaybeAccessor<(to: To) => string>)
    const pathname = resolver(action.pathname || '.')
    const base = readAccessor(router.base)

    return {
      pathname,
      search: action.search,
      hash: action.hash,
      href: prependBasePath(pathname, base) + action.search + action.hash,
      isExternal: false,
    }
  }

  const handleSubmit = (event: SubmitEvent) => {
    untrack(() => props.onSubmit?.(event))

    // Don't handle if prevented
    if (event.defaultPrevented) return

    const form = event.currentTarget as HTMLFormElement
    const submitter = getAssociatedFormSubmitter(event.submitter, form)
    const submitterTarget = getSubmitterOverride(submitter, 'formtarget')
    const target = submitterTarget ?? form.target

    // Don't handle if form has a target that opens in a new window/frame
    if (target && target.toLowerCase() !== '_self') return

    const snapshot = untrack(() => {
      const method = getHandledFormMethod(
        getSubmitterOverride(submitter, 'formmethod') ?? props.method,
      )
      if (!method) return null

      return {
        action: resolveAction(getSubmitterOverride(submitter, 'formaction')),
        method,
        navigate: props.navigate,
        replace: props.replace,
        scroll: props.preventScrollReset === true ? false : undefined,
      }
    })

    // Unsupported methods (including dialog and explicit empty values) stay native.
    if (!snapshot) return

    // Let the browser preserve native external GET form semantics.
    if (snapshot.method === 'GET' && snapshot.action.isExternal) return

    // Prevent default form submission for router navigation and fetch submissions.
    event.preventDefault()

    const formData = createFormData(form, submitter)

    if (snapshot.method === 'GET') {
      // For GET, navigate with search params
      const searchParams = new URLSearchParams()
      formData.forEach((value, key) => {
        if (typeof value === 'string') {
          searchParams.append(key, value)
        }
      })

      untrack(() =>
        router.navigate(
          {
            pathname: snapshot.action.pathname,
            search: '?' + searchParams.toString(),
            hash: snapshot.action.hash,
          },
          { replace: snapshot.replace, scroll: snapshot.scroll },
        ),
      )
    } else {
      // For POST/PUT/PATCH/DELETE, submit via fetch
      void submitFormAction(form, snapshot.action.href, snapshot.method, formData, {
        navigate: snapshot.navigate !== false,
        replace: snapshot.replace ?? false,
        scroll: snapshot.scroll,
        router,
      }).catch(() => {
        // submitFormAction already reports the failure through `formerror`
        // and console.error. Event listeners cannot observe its returned
        // promise, so consume the rejection here to avoid an unhandled one.
      })
    }
  }

  /**
   * Submit form data via fetch for non-GET methods
   */
  async function submitFormAction(
    formElement: HTMLFormElement,
    url: string,
    method: string,
    formData: FormData,
    options: {
      navigate: boolean
      replace: boolean
      scroll: boolean | undefined
      router: typeof router
    },
  ) {
    try {
      const response = await fetch(url, {
        method,
        body: formData,
        headers: {
          // Let the browser set Content-Type for FormData (includes boundary)
          Accept: 'application/json',
        },
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      // Try to parse JSON response
      const contentType = response.headers.get('Content-Type')
      let data: unknown = null
      if (contentType?.includes('application/json')) {
        data = await response.json()
      }

      // If navigate is enabled and response includes a redirect location
      const redirectUrl = response.headers.get('X-Redirect') || response.headers.get('Location')
      if (options.navigate && redirectUrl) {
        options.router.navigate(redirectUrl, {
          replace: options.replace,
          scroll: options.scroll,
        })
      }

      // Emit a custom event for the form submission result on the actual form element
      formElement.dispatchEvent(
        new CustomEvent('formsubmit', {
          bubbles: true,
          detail: { data, response },
        }),
      )

      return { data, response }
    } catch (error) {
      // Emit error event on the actual form element
      formElement.dispatchEvent(
        new CustomEvent('formerror', {
          bubbles: true,
          detail: { error },
        }),
      )

      console.error('[fict-router] Form submission failed:', error)
      throw error
    }
  }

  const formProps = __fictPropsRest(
    props as unknown as Record<string, unknown>,
    FORM_DOM_PROP_EXCLUSIONS,
  )

  // Only use standard form methods (get, post) for the HTML attribute
  // Other methods (put, patch, delete) are handled via fetch in handleSubmit
  const htmlMethod = reactive(() => {
    const method = props.method
    return method && ['get', 'post'].includes(method) ? (method as 'get' | 'post') : undefined
  })
  const children = reactive(() => props.children)
  const formRef = createSpreadRef<HTMLFormElement>(() => ({
    ...formProps,
    action: resolveAction().href,
    method: htmlMethod(),
    onSubmit: handleSubmit,
  }))

  return <form ref={formRef}>{children as unknown as FictNode}</form>
}
