/**
 * @fileoverview Link components for @fictjs/router
 *
 * This module provides Link and NavLink components for declarative navigation.
 * Integrates with Fict's reactive system for active state tracking.
 */

import { createEffect, untrack, type FictNode, type JSX, type StyleProp } from '@fictjs/runtime'
import { createSignal } from '@fictjs/runtime/advanced'
import { spread } from '@fictjs/runtime/internal'

import {
  useRouter,
  useIsActive,
  useHref,
  usePendingLocation,
  readAccessor,
  type MaybeAccessor,
} from './context'
import type { To, NavigateOptions } from './types'
import { parseURL, stripBasePath } from './utils'

// CSS Properties type for styles
type CSSProperties = NonNullable<StyleProp>

const joinClassNames = (
  base: string | undefined,
  active: string | undefined,
  pending: string | undefined,
): string | undefined => {
  const className = `${base ?? ''} ${active ?? ''} ${pending ?? ''}`.trim()
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

const createSpreadRef = <T extends Element>(props: Record<string, unknown>) => {
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
  const to = untrack(() => props.to)
  const replace = untrack(() => props.replace)
  const state = untrack(() => props.state)
  const scroll = untrack(() => props.scroll)
  const relative = untrack(() => props.relative)
  const reloadDocument = untrack(() => props.reloadDocument)
  const prefetchMode = untrack(() => props.prefetch)
  const isDisabled = untrack(() => props.disabled)
  const onClick = untrack(() => props.onClick)
  const externalHref = getExternalHref(to)
  const href = useHref(() => to)
  const getHrefValue = () =>
    externalHref ?? readAccessor(readAccessor(href as MaybeAccessor<MaybeAccessor<string>>))
  let preloadTriggered = false

  const handleClick = (event: MouseEvent) => {
    // Call custom onClick handler first
    if (onClick) {
      onClick(event)
    }

    // Don't handle if default was prevented
    if (event.defaultPrevented) return

    // Don't handle modifier keys (open in new tab, etc.)
    if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return

    // Don't handle right-clicks
    if (event.button !== 0) return

    // Don't handle if reloadDocument is set
    if (reloadDocument) return

    // Don't handle if disabled
    if (isDisabled) return

    // Let the browser handle absolute and protocol-relative URLs.
    if (externalHref) return

    // Don't handle external links
    const target = (event.currentTarget as HTMLAnchorElement).target
    if (target && target !== '_self') return

    // Prevent default browser navigation
    event.preventDefault()

    // Navigate using the router
    const options: NavigateOptions = {
      replace,
      state,
      scroll,
      relative,
    }

    router.navigate(to, options)
  }

  // Preload handler for hover/focus
  const triggerPreload = () => {
    if (preloadTriggered || isDisabled || externalHref || prefetchMode === 'none') return
    preloadTriggered = true

    // Emit a preload event that can be handled by route preloaders
    const hrefValue = getHrefValue()
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(
        new CustomEvent('fict-router:preload', {
          detail: { href: hrefValue, to },
        }),
      )
    }
  }

  const handleMouseEnter = (event: MouseEvent) => {
    if (prefetchMode === 'intent' || prefetchMode === undefined) {
      triggerPreload()
    }
    // Call original handler if provided
    const propsRecord = props as unknown as Record<string, unknown>
    const onMouseEnter = propsRecord.onMouseEnter as ((event: MouseEvent) => void) | undefined
    if (onMouseEnter) onMouseEnter(event)
  }

  const handleFocus = (event: FocusEvent) => {
    if (prefetchMode === 'intent' || prefetchMode === undefined) {
      triggerPreload()
    }
    // Call original handler if provided
    const propsRecord = props as unknown as Record<string, unknown>
    const onFocus = propsRecord.onFocus as ((event: FocusEvent) => void) | undefined
    if (onFocus) onFocus(event)
  }

  // Extract link-specific props, pass rest to anchor
  const {
    to: _to,
    replace: _replace,
    state: _state,
    scroll: _scroll,
    relative: _relative,
    reloadDocument: _reloadDocument,
    prefetch: _prefetch,
    disabled: _disabled,
    onClick: _onClick,
    onMouseEnter: _onMouseEnter,
    onFocus: _onFocus,
    children,
    ...anchorProps
  } = props
  const anchorRef = createSpreadRef<HTMLAnchorElement>(anchorProps as Record<string, unknown>)
  const spanRef = createSpreadRef<HTMLSpanElement>(anchorProps as Record<string, unknown>)

  if (isDisabled) {
    // Render as span when disabled
    return <span ref={spanRef}>{children}</span>
  }

  // Trigger preload immediately if prefetch='render'
  if (prefetchMode === 'render') {
    triggerPreload()
  }

  return (
    <a
      ref={anchorRef}
      href={getHrefValue()}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onFocus={handleFocus}
    >
      {children}
    </a>
  )
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
  const to = untrack(() => props.to)
  const end = untrack(() => props.end)
  const caseSensitive = untrack(() => props.caseSensitive)
  const replace = untrack(() => props.replace)
  const state = untrack(() => props.state)
  const scroll = untrack(() => props.scroll)
  const relative = untrack(() => props.relative)
  const reloadDocument = untrack(() => props.reloadDocument)
  const isDisabled = untrack(() => props.disabled)
  const onClick = untrack(() => props.onClick)
  const classNameProp = untrack(() => props.className)
  const styleProp = untrack(() => props.style)
  const childrenProp = untrack(() => props.children)
  const activeClassNameProp = untrack(() => props.activeClassName)
  const pendingClassNameProp = untrack(() => props.pendingClassName)
  const activeStyleProp = untrack(() => props.activeStyle)
  const pendingStyleProp = untrack(() => props.pendingStyle)
  const ariaCurrentProp = untrack(() => props['aria-current'])
  const externalHref = getExternalHref(to)
  const internalIsActive = useIsActive(() => to, { end, caseSensitive })
  const isActive = externalHref ? () => false : internalIsActive
  const href = useHref(() => to)
  const getHrefValue = () =>
    externalHref ?? readAccessor(readAccessor(href as MaybeAccessor<MaybeAccessor<string>>))
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
    if (!caseSensitive) {
      pendingPathWithoutBase = pendingPathWithoutBase.toLowerCase()
      targetPathWithoutBase = targetPathWithoutBase.toLowerCase()
    }

    // Check if the pending navigation is to this link's destination
    if (end) {
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

    const baseClassName =
      typeof classNameProp === 'function' ? classNameProp(renderProps) : classNameProp
    const activeClassName = renderProps.isActive ? activeClassNameProp : undefined
    const pendingClassName = renderProps.isPending ? pendingClassNameProp : undefined

    const baseStyle = typeof styleProp === 'function' ? styleProp(renderProps) : styleProp
    const activeStyle = renderProps.isActive ? activeStyleProp : undefined
    const pendingStyle = renderProps.isPending ? pendingStyleProp : undefined

    computedClassName(joinClassNames(baseClassName, activeClassName, pendingClassName))
    computedStyle(mergeStyles(baseStyle, activeStyle, pendingStyle))
    computedChildren(typeof childrenProp === 'function' ? childrenProp(renderProps) : childrenProp)
    ariaCurrent(renderProps.isActive ? (ariaCurrentProp ?? 'page') : undefined)
  })

  const handleClick = (event: MouseEvent) => {
    // Call custom onClick handler first
    if (onClick) {
      onClick(event)
    }

    // Don't handle if default was prevented
    if (event.defaultPrevented) return

    // Don't handle modifier keys
    if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return

    // Don't handle right-clicks
    if (event.button !== 0) return

    // Don't handle if reloadDocument is set
    if (reloadDocument) return

    // Don't handle if disabled
    if (isDisabled) return

    if (externalHref) return

    // Don't handle external links
    const target = (event.currentTarget as HTMLAnchorElement).target
    if (target && target !== '_self') return

    // Prevent default browser navigation
    event.preventDefault()

    // Navigate using the router
    router.navigate(to, {
      replace,
      state,
      scroll,
      relative,
    })
  }

  // Extract NavLink-specific props
  const {
    to: _to,
    replace: _replace,
    state: _state,
    scroll: _scroll,
    relative: _relative,
    reloadDocument: _reloadDocument,
    prefetch: _prefetch,
    disabled: _disabled,
    onClick: _onClick,
    children: _children,
    className: _className,
    style: _style,
    end: _end,
    caseSensitive: _caseSensitive,
    activeClassName: _activeClassName,
    pendingClassName: _pendingClassName,
    activeStyle: _activeStyle,
    pendingStyle: _pendingStyle,
    'aria-current': _ariaCurrent,
    ...anchorProps
  } = props
  const anchorRef = createSpreadRef<HTMLAnchorElement>(anchorProps as Record<string, unknown>)
  const spanRef = createSpreadRef<HTMLSpanElement>(anchorProps as Record<string, unknown>)

  if (isDisabled) {
    const disabledClassName = computedClassName()
    const disabledStyle = computedStyle()
    return (
      <span
        ref={spanRef}
        class={disabledClassName as string}
        style={disabledStyle as NonNullable<JSX.IntrinsicElements['span']['style']>}
      >
        {computedChildren()}
      </span>
    )
  }

  return (
    <a
      ref={anchorRef}
      href={getHrefValue()}
      class={computedClassName() as string}
      style={computedStyle() as NonNullable<JSX.IntrinsicElements['a']['style']>}
      aria-current={ariaCurrent() as NonNullable<JSX.IntrinsicElements['a']['aria-current']>}
      onClick={handleClick}
    >
      {computedChildren()}
    </a>
  )
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
  /** Prevent navigation */
  preventScrollReset?: boolean
  /** Navigate on submit */
  navigate?: boolean
  /** Fetch mode */
  fetcherKey?: string
  children?: FictNode
  onSubmit?: (event: SubmitEvent) => void
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
  const actionProp = untrack(() => props.action)
  const methodProp = untrack(() => props.method)
  const replace = untrack(() => props.replace)
  const shouldNavigate = untrack(() => props.navigate)
  const onSubmit = untrack(() => props.onSubmit)

  const handleSubmit = (event: SubmitEvent) => {
    // Call custom onSubmit
    if (onSubmit) {
      onSubmit(event)
    }

    // Don't handle if prevented
    if (event.defaultPrevented) return

    const form = event.currentTarget as HTMLFormElement

    // Don't handle if form has a target that opens in a new window/frame
    const target = form.target
    if (target && target !== '_self') return

    // Prevent default form submission
    event.preventDefault()

    const formData = new FormData(form)
    const method = methodProp?.toUpperCase() || 'GET'

    const actionUrl = actionProp || readAccessor(router.location).pathname

    if (method === 'GET') {
      // For GET, navigate with search params
      const searchParams = new URLSearchParams()
      formData.forEach((value, key) => {
        if (typeof value === 'string') {
          searchParams.append(key, value)
        }
      })

      router.navigate(
        {
          pathname: actionUrl,
          search: '?' + searchParams.toString(),
        },
        { replace },
      )
    } else {
      // For POST/PUT/PATCH/DELETE, submit via fetch
      void submitFormAction(form, actionUrl, method, formData, {
        navigate: shouldNavigate !== false,
        replace: replace ?? false,
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
        options.router.navigate(redirectUrl, { replace: options.replace })
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

  const {
    action: _action,
    method: _method,
    replace: _replace,
    relative: _relative,
    preventScrollReset: _preventScrollReset,
    navigate: _navigate,
    fetcherKey: _fetcherKey,
    children,
    onSubmit: _onSubmit,
    ...formProps
  } = props
  const formRef = createSpreadRef<HTMLFormElement>(formProps as Record<string, unknown>)

  // Only use standard form methods (get, post) for the HTML attribute
  // Other methods (put, patch, delete) are handled via fetch in handleSubmit
  const htmlMethod =
    methodProp && ['get', 'post'].includes(methodProp) ? (methodProp as 'get' | 'post') : undefined

  return (
    <form
      ref={formRef}
      action={actionProp as string}
      method={htmlMethod as 'get' | 'post'}
      onSubmit={handleSubmit}
    >
      {children}
    </form>
  )
}
