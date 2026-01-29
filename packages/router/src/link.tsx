/**
 * @fileoverview Link components for @fictjs/router
 *
 * This module provides Link and NavLink components for declarative navigation.
 * Integrates with Fict's reactive system for active state tracking.
 */

import { createMemo, type FictNode, type JSX, type StyleProp } from '@fictjs/runtime'

import { useRouter, useIsActive, useHref } from './context'
import type { To, NavigateOptions } from './types'

// CSS Properties type for styles
type CSSProperties = StyleProp

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
  const href = useHref(() => props.to)

  const handleClick = (event: MouseEvent) => {
    // Call custom onClick handler first
    if (props.onClick) {
      props.onClick(event)
    }

    // Don't handle if default was prevented
    if (event.defaultPrevented) return

    // Don't handle modifier keys (open in new tab, etc.)
    if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return

    // Don't handle right-clicks
    if (event.button !== 0) return

    // Don't handle if reloadDocument is set
    if (props.reloadDocument) return

    // Don't handle if disabled
    if (props.disabled) return

    // Don't handle external links
    const target = (event.currentTarget as HTMLAnchorElement).target
    if (target && target !== '_self') return

    // Prevent default browser navigation
    event.preventDefault()

    // Navigate using the router
    const options: NavigateOptions = {
      replace: props.replace,
      state: props.state,
      scroll: props.scroll,
      relative: props.relative,
    }

    router.navigate(props.to, options)
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
    disabled,
    onClick: _onClick,
    children,
    ...anchorProps
  } = props

  if (disabled) {
    // Render as span when disabled
    return <span {...(anchorProps as any)}>{children}</span>
  }

  return (
    <a {...anchorProps} href={href()} onClick={handleClick}>
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
  const isActive = useIsActive(() => props.to, { end: props.end })
  const href = useHref(() => props.to)

  // Compute render props
  const getRenderProps = (): NavLinkRenderProps => ({
    isActive: isActive(),
    isPending: false, // TODO: Implement pending state tracking
    isTransitioning: router.isRouting(),
  })

  // Compute className
  const computedClassName = createMemo(() => {
    const renderProps = getRenderProps()
    const classes: string[] = []

    // Base className
    if (typeof props.className === 'function') {
      const result = props.className(renderProps)
      if (result) classes.push(result)
    } else if (props.className) {
      classes.push(props.className)
    }

    // Active className
    if (renderProps.isActive && props.activeClassName) {
      classes.push(props.activeClassName)
    }

    // Pending className
    if (renderProps.isPending && props.pendingClassName) {
      classes.push(props.pendingClassName)
    }

    return classes.join(' ') || undefined
  })

  // Compute style
  const computedStyle = createMemo(() => {
    const renderProps = getRenderProps()
    const style: CSSProperties = {}

    // Base style
    if (typeof props.style === 'function') {
      const result = props.style(renderProps)
      if (result) Object.assign(style, result)
    } else if (props.style) {
      Object.assign(style, props.style)
    }

    // Active style
    if (renderProps.isActive && props.activeStyle) {
      Object.assign(style, props.activeStyle)
    }

    // Pending style
    if (renderProps.isPending && props.pendingStyle) {
      Object.assign(style, props.pendingStyle)
    }

    return Object.keys(style).length > 0 ? style : undefined
  })

  // Compute children
  const computedChildren = createMemo(() => {
    const renderProps = getRenderProps()

    if (typeof props.children === 'function') {
      return props.children(renderProps)
    }

    return props.children
  })

  // Compute aria-current
  const ariaCurrent = createMemo(() => {
    const renderProps = getRenderProps()
    if (!renderProps.isActive) return undefined
    return props['aria-current'] || 'page'
  })

  const handleClick = (event: MouseEvent) => {
    // Call custom onClick handler first
    if (props.onClick) {
      props.onClick(event)
    }

    // Don't handle if default was prevented
    if (event.defaultPrevented) return

    // Don't handle modifier keys
    if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return

    // Don't handle right-clicks
    if (event.button !== 0) return

    // Don't handle if reloadDocument is set
    if (props.reloadDocument) return

    // Don't handle if disabled
    if (props.disabled) return

    // Don't handle external links
    const target = (event.currentTarget as HTMLAnchorElement).target
    if (target && target !== '_self') return

    // Prevent default browser navigation
    event.preventDefault()

    // Navigate using the router
    router.navigate(props.to, {
      replace: props.replace,
      state: props.state,
      scroll: props.scroll,
      relative: props.relative,
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
    disabled,
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

  if (disabled) {
    return (
      <span {...(anchorProps as any)} className={computedClassName()} style={computedStyle()}>
        {computedChildren()}
      </span>
    )
  }

  const finalClassName = computedClassName()
  const finalStyle = computedStyle()
  const finalAriaCurrent = ariaCurrent()

  return (
    <a
      {...anchorProps}
      href={href()}
      {...(finalClassName !== undefined ? { className: finalClassName } : {})}
      {...(finalStyle !== undefined ? { style: finalStyle } : {})}
      {...(finalAriaCurrent !== undefined ? { 'aria-current': finalAriaCurrent } : {})}
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

  const handleSubmit = (event: SubmitEvent) => {
    // Call custom onSubmit
    if (props.onSubmit) {
      props.onSubmit(event)
    }

    // Don't handle if prevented
    if (event.defaultPrevented) return

    // Prevent default form submission
    event.preventDefault()

    const form = event.currentTarget as HTMLFormElement
    const formData = new FormData(form)
    const method = props.method?.toUpperCase() || 'GET'

    if (method === 'GET') {
      // For GET, navigate with search params
      const searchParams = new URLSearchParams()
      formData.forEach((value, key) => {
        if (typeof value === 'string') {
          searchParams.append(key, value)
        }
      })

      const action = props.action || router.location().pathname
      router.navigate(
        {
          pathname: action,
          search: '?' + searchParams.toString(),
        },
        { replace: props.replace },
      )
    } else {
      // For other methods, submit via fetch (action handling)
      // TODO: Implement action submission system
      console.warn('[fict-router] Form action submission not yet implemented')
    }
  }

  const {
    action,
    method,
    replace: _replace,
    relative: _relative,
    preventScrollReset: _preventScrollReset,
    navigate: _navigate,
    fetcherKey: _fetcherKey,
    children,
    onSubmit: _onSubmit,
    ...formProps
  } = props

  // Only use standard form methods (get, post) for the HTML attribute
  // Other methods (put, patch, delete) are handled via fetch in handleSubmit
  const htmlMethod =
    method && ['get', 'post'].includes(method) ? (method as 'get' | 'post') : undefined

  return (
    <form
      {...formProps}
      {...(action !== undefined ? { action } : {})}
      {...(htmlMethod !== undefined ? { method: htmlMethod } : {})}
      onSubmit={handleSubmit}
    >
      {children}
    </form>
  )
}
