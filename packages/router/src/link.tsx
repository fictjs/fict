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
import { getRegisteredAction, submitActionFromForm } from './data'
import { stripBaseIfPresent } from './router-internals'
import type { Action, Params, RouterContextValue, To, NavigateOptions } from './types'
import { getExternalHref, parseURL, prependBasePath, stripBasePath } from './utils'

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
  if (target && target.toLowerCase() !== '_self') return undefined
  return snapshot
}

function createPreloadBehavior(
  router: RouterContextValue,
  props: LinkBehaviorProps,
  getHrefValue: () => string,
) {
  let lastPreload: { href: string; state: unknown } | undefined

  const trigger = (snapshot: LinkBehaviorSnapshot) => {
    if (typeof window === 'undefined') return
    if (
      snapshot.disabled ||
      snapshot.reloadDocument ||
      snapshot.externalHref ||
      snapshot.prefetch === 'none' ||
      snapshot.prefetch === undefined
    ) {
      return
    }
    const href = getHrefValue()
    const state =
      snapshot.state !== undefined
        ? snapshot.state
        : typeof snapshot.to === 'object'
          ? snapshot.to.state
          : undefined
    if (lastPreload?.href === href && Object.is(lastPreload.state, state)) return
    const currentPreload = { href, state }
    lastPreload = currentPreload
    void router.preload(href, state).catch(() => {
      if (lastPreload === currentPreload) lastPreload = undefined
    })
  }

  createEffect(() => {
    const snapshot = readLinkBehavior(props)
    if (snapshot.prefetch === 'render') trigger(snapshot)
  })

  return {
    handleMouseEnter(event: MouseEvent) {
      untrack(() => {
        const snapshot = readLinkBehavior(props)
        if (snapshot.prefetch === 'intent') trigger(snapshot)
        props.onMouseEnter?.(event)
      })
    },
    handleFocus(event: FocusEvent) {
      untrack(() => {
        const snapshot = readLinkBehavior(props)
        if (snapshot.prefetch === 'intent') trigger(snapshot)
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
  const { handleMouseEnter, handleFocus } = createPreloadBehavior(router, props, getHrefValue)

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
  const { handleMouseEnter, handleFocus } = createPreloadBehavior(router, props, getHrefValue)
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
  /** Form action URL or registered action */
  action?: string | Action<unknown>
  /** HTTP method */
  method?: 'get' | 'post' | 'put' | 'patch' | 'delete'
  /** Replace history entry */
  replace?: boolean
  /** Relative path resolution */
  relative?: 'route' | 'path'
  /** Keep the current scroll position after navigation */
  preventScrollReset?: boolean
  /** Navigate for GET; for other methods, follow response redirects */
  navigate?: boolean
  /** Stable key for tracked submissions (including GET when navigate is false) */
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
  registeredAction: Action<unknown> | undefined
}

type FormSubmitter = HTMLButtonElement | HTMLInputElement
type HandledFormMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const HANDLED_FORM_METHODS = new Set<HandledFormMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const latestFetcherSubmissions = new WeakMap<RouterContextValue, Map<string, symbol>>()

function createSubmissionLease(router: RouterContextValue, key: string | undefined) {
  if (key === undefined) {
    return { isCurrent: () => true, release: () => {} }
  }

  let routerSubmissions = latestFetcherSubmissions.get(router)
  if (!routerSubmissions) {
    routerSubmissions = new Map()
    latestFetcherSubmissions.set(router, routerSubmissions)
  }
  const token = Symbol(key)
  routerSubmissions.set(key, token)
  return {
    isCurrent: () => routerSubmissions.get(key) === token,
    release: () => {
      if (routerSubmissions.get(key) === token) {
        routerSubmissions.delete(key)
        if (routerSubmissions.size === 0) latestFetcherSubmissions.delete(router)
      }
    },
  }
}

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
    // The submit event captures the submitter before user handlers run, but the
    // entry list is built afterwards. A handler may remove or reassociate the
    // submitter while its submission overrides still remain authoritative.
    if (getAssociatedFormSubmitter(submitter, form) !== submitter || submitter.disabled) {
      return formData
    }

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

function splitFormAction(action: string): Pick<ResolvedFormAction, 'pathname' | 'search' | 'hash'> {
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

function removeNakedIndexParam(search: string): string {
  const params = new URLSearchParams(search)
  const indexValues = params.getAll('index')
  if (!indexValues.some(value => value === '')) return search

  params.delete('index')
  for (const value of indexValues) {
    if (value !== '') params.append('index', value)
  }

  const normalized = params.toString()
  return normalized ? `?${normalized}` : ''
}

function prependNakedIndexParam(search: string): string {
  return search ? `?index&${search.replace(/^\?/, '')}` : '?index'
}

function normalizeFormUrlEncodedLineBreaks(value: string): string {
  return value.replace(/\r\n|\r|\n/g, '\r\n')
}

function serializeGetFormData(formData: FormData): string {
  const searchParams = new URLSearchParams()
  formData.forEach((value, key) => {
    // Converting a form entry list to application/x-www-form-urlencoded
    // canonicalizes line breaks in names, string values, and filenames.
    searchParams.append(
      normalizeFormUrlEncodedLineBreaks(key),
      normalizeFormUrlEncodedLineBreaks(typeof value === 'string' ? value : value.name),
    )
  })
  const search = searchParams.toString()
  return search ? `?${search}` : ''
}

interface FormRedirectDestination {
  href: string
  external: boolean
}

function getFormRedirectDestination(response: Response): FormRedirectDestination | undefined {
  const headerRedirect = response.headers.get('X-Redirect') || response.headers.get('Location')
  const followedRedirect = !headerRedirect && response.redirected ? response.url : ''
  const redirect = headerRedirect || followedRedirect
  if (!redirect) return undefined

  if (typeof window === 'undefined') {
    return { href: redirect, external: false }
  }

  try {
    const target = new URL(redirect, window.location.href)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return undefined
    if (target.origin !== window.location.origin) {
      return { href: target.href, external: true }
    }

    // A followed redirect exposes an absolute final response URL. Feed only
    // its route portion to the SPA router; absolute header redirects are
    // normalized for the same reason. Preserve relative custom headers.
    const isAbsolute = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(redirect) || redirect.startsWith('//')
    return {
      href:
        followedRedirect || isAbsolute ? target.pathname + target.search + target.hash : redirect,
      external: false,
    }
  } catch {
    return { href: redirect, external: false }
  }
}

function followFormRedirect(
  response: Response,
  router: RouterContextValue,
  options: { replace: boolean; scroll: boolean | undefined },
): void {
  const destination = getFormRedirectDestination(response)
  if (!destination) return

  if (destination.external && typeof window !== 'undefined') {
    window.location.assign(destination.href)
    return
  }

  router.navigate(destination.href, options)
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
    const configuredAction = props.action
    const isActionOmitted = actionOverride === undefined && configuredAction === undefined
    const actionValue = actionOverride ?? configuredAction ?? '.'
    const directAction =
      actionOverride === undefined && typeof actionValue !== 'string' ? actionValue : undefined
    const rawAction = typeof actionValue === 'string' ? actionValue : actionValue.url
    const externalHref = getExternalHref(rawAction)
    const action = splitFormAction(rawAction)

    if (externalHref !== null) {
      return {
        ...action,
        href: externalHref,
        isExternal: true,
        registeredAction: directAction,
      }
    }

    const usesRouteResolver = (props.relative ?? 'route') !== 'path' && hasRouteContext
    const resolver = usesRouteResolver
      ? readAccessor(route.resolvePath as MaybeAccessor<(to: To) => string>)
      : readAccessor(router.resolvePath as MaybeAccessor<(to: To) => string>)
    const base = readAccessor(router.base)
    const actionPathname = action.pathname || '.'
    const sourceRegisteredAction = directAction ?? getRegisteredAction(action.pathname)
    const pathname = resolver(
      usesRouteResolver && sourceRegisteredAction === undefined && action.pathname.startsWith('/')
        ? stripBaseIfPresent(action.pathname, base)
        : actionPathname,
    )
    let search = isActionOmitted
      ? removeNakedIndexParam(readAccessor(router.location).search)
      : action.search
    const match = hasRouteContext ? readAccessor(route.match) : undefined
    if (
      typeof actionValue === 'string' &&
      (actionValue === '' || actionValue === '.') &&
      match?.route.index
    ) {
      search = prependNakedIndexParam(search)
    }
    const registeredAction = sourceRegisteredAction ?? getRegisteredAction(pathname)

    return {
      pathname,
      search,
      hash: action.hash,
      href: prependBasePath(pathname, base) + search + action.hash,
      isExternal: false,
      registeredAction,
    }
  }

  const handleSubmit = (event: SubmitEvent) => {
    const form = event.currentTarget as HTMLFormElement
    // Native submission captures the submitter before dispatching `submit`.
    // Keep that identity even if the user handler removes or reassociates it;
    // its current overrides are read after the handler returns.
    const submitter = getAssociatedFormSubmitter(event.submitter, form)
    untrack(() => props.onSubmit?.(event))

    // Don't handle if prevented
    if (event.defaultPrevented) return

    const submitterTarget = getSubmitterOverride(submitter, 'formtarget')
    const target = submitterTarget ?? form.target

    // Don't handle if form has a target that opens in a new window/frame
    if (target && target.toLowerCase() !== '_self') return

    const snapshot = untrack(() => {
      const action = resolveAction(getSubmitterOverride(submitter, 'formaction'))
      const method = getHandledFormMethod(
        getSubmitterOverride(submitter, 'formmethod') ??
          props.method ??
          (action.registeredAction ? 'post' : undefined),
      )
      if (!method) return null

      return {
        action,
        method,
        navigate: props.navigate,
        replace: props.replace,
        scroll: props.preventScrollReset === true ? false : undefined,
        params: { ...readAccessor(router.params) },
        fetcherKey: props.fetcherKey,
      }
    })

    // Unsupported methods (including dialog and explicit empty values) stay native.
    if (!snapshot) return

    // Navigating external GET forms stay native. A navigate=false GET is an
    // explicit fetch submission and is handled below without changing history.
    if (snapshot.method === 'GET' && snapshot.action.isExternal && snapshot.navigate !== false) {
      return
    }

    // Prevent default form submission for router navigation and fetch submissions.
    event.preventDefault()

    const formData = createFormData(form, submitter)

    if (snapshot.method === 'GET') {
      const search = serializeGetFormData(formData)
      if (snapshot.navigate !== false) {
        untrack(() =>
          router.navigate(
            {
              pathname: snapshot.action.pathname,
              search,
              hash: snapshot.action.hash,
            },
            { replace: snapshot.replace, scroll: snapshot.scroll },
          ),
        )
        return
      }

      // Native GET submission replaces the action's query with the successful
      // controls and does not send the fragment to the server. Keep the
      // original action href as the submission identity for useSubmission().
      const requestUrl = splitFormAction(snapshot.action.href).pathname + search
      submitTrackedForm(
        form,
        snapshot.action,
        snapshot.method,
        formData,
        snapshot.params,
        snapshot.fetcherKey,
        false,
        snapshot.replace ?? false,
        snapshot.scroll,
        requestUrl,
        snapshot.action.href,
      )
      return
    }

    submitTrackedForm(
      form,
      snapshot.action,
      snapshot.method,
      formData,
      snapshot.params,
      snapshot.fetcherKey,
      snapshot.navigate !== false,
      snapshot.replace ?? false,
      snapshot.scroll,
      snapshot.action.href,
      snapshot.action.href,
    )
  }

  function submitTrackedForm(
    formElement: HTMLFormElement,
    action: ResolvedFormAction,
    method: string,
    formData: FormData,
    params: Params,
    submissionKey: string | undefined,
    navigate: boolean,
    replace: boolean,
    scroll: boolean | undefined,
    requestUrl: string,
    submissionUrl: string,
  ) {
    const submissionLease = createSubmissionLease(router, submissionKey)
    const options = { navigate, replace, scroll, router, submissionLease }
    const submission = action.registeredAction
      ? submitRegisteredFormAction(
          formElement,
          action.registeredAction,
          requestUrl,
          method,
          formData,
          params,
          submissionKey,
          options,
        )
      : submitFormAction(
          formElement,
          requestUrl,
          method,
          formData,
          params,
          submissionKey,
          options,
          submissionUrl,
        )

    void submission.catch(() => {
      // The submission helpers already report failures through `formerror`
      // and console.error. Event listeners cannot observe their returned
      // promises, so consume the rejection here to avoid an unhandled one.
    })
  }

  /** Submit a registered client action through the shared submission tracker. */
  async function submitRegisteredFormAction(
    formElement: HTMLFormElement,
    registeredAction: Action<unknown>,
    url: string,
    method: string,
    formData: FormData,
    params: Params,
    submissionKey: string | undefined,
    options: {
      navigate: boolean
      replace: boolean
      scroll: boolean | undefined
      router: typeof router
      submissionLease: ReturnType<typeof createSubmissionLease>
    },
  ) {
    try {
      const data = await submitActionFromForm(
        registeredAction,
        formData,
        params,
        { url, method },
        submissionKey,
      )
      if (!options.submissionLease.isCurrent()) return { data, response: null }
      const response = data instanceof Response ? data : null
      if (options.navigate && response) {
        followFormRedirect(response, options.router, {
          replace: options.replace,
          scroll: options.scroll,
        })
      }

      formElement.dispatchEvent(
        new CustomEvent('formsubmit', {
          bubbles: true,
          detail: { data, response },
        }),
      )

      return { data, response }
    } catch (error) {
      if (options.submissionLease.isCurrent()) {
        formElement.dispatchEvent(
          new CustomEvent('formerror', {
            bubbles: true,
            detail: { error },
          }),
        )

        console.error('[fict-router] Form submission failed:', error)
      }
      throw error
    } finally {
      options.submissionLease.release()
    }
  }

  /** Submit form data via fetch through the shared submission tracker. */
  async function submitFormAction(
    formElement: HTMLFormElement,
    url: string,
    method: string,
    formData: FormData,
    params: Params,
    submissionKey: string | undefined,
    options: {
      navigate: boolean
      replace: boolean
      scroll: boolean | undefined
      router: typeof router
      submissionLease: ReturnType<typeof createSubmissionLease>
    },
    submissionUrl = url,
  ) {
    let response: Response | null = null
    const requestAction: Action<unknown> = {
      url: submissionUrl,
      submit: async submittedFormData => {
        const requestInit: RequestInit = {
          method,
          headers: {
            Accept: 'application/json',
          },
        }
        if (method !== 'GET') {
          // Let the browser set Content-Type for FormData (includes boundary).
          requestInit.body = submittedFormData
        }
        response = await fetch(url, requestInit)

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        const contentType = response.headers.get('Content-Type')
        return contentType?.includes('application/json') ? response.json() : null
      },
    }

    try {
      const data = await submitActionFromForm(
        requestAction,
        formData,
        params,
        { url, method },
        submissionKey,
      )
      const completedResponse = response as Response | null
      if (!completedResponse) {
        throw new Error('[fict-router] Form request completed without a response')
      }
      if (!options.submissionLease.isCurrent()) {
        return { data, response: completedResponse }
      }

      // Fetch follows HTTP redirects by default. Handle either an explicit
      // redirect header or the final URL exposed by a followed 302/303.
      if (options.navigate) {
        followFormRedirect(completedResponse, options.router, {
          replace: options.replace,
          scroll: options.scroll,
        })
      }

      // Emit a custom event for the form submission result on the actual form element
      formElement.dispatchEvent(
        new CustomEvent('formsubmit', {
          bubbles: true,
          detail: { data, response: completedResponse },
        }),
      )

      return { data, response: completedResponse }
    } catch (error) {
      if (options.submissionLease.isCurrent()) {
        // Emit error event on the actual form element
        formElement.dispatchEvent(
          new CustomEvent('formerror', {
            bubbles: true,
            detail: { error },
          }),
        )

        console.error('[fict-router] Form submission failed:', error)
      }
      throw error
    } finally {
      options.submissionLease.release()
    }
  }

  const formProps = __fictPropsRest(
    props as unknown as Record<string, unknown>,
    FORM_DOM_PROP_EXCLUSIONS,
  )

  // Only use standard form methods (get, post) for the HTML attribute
  // Other methods (put, patch, delete) are handled via fetch in handleSubmit
  const htmlMethod = reactive(() => {
    const method = props.method ?? (resolveAction().registeredAction ? 'post' : undefined)
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
