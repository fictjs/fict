// Unified runtime entry for dev/test aliasing.
// Re-export internal compiler APIs plus public runtime exports so all code
// shares a single reactive instance.
export * from './internal'
export {
  batch,
  createContext,
  createRef,
  createRoot,
  ErrorBoundary,
  hasContext,
  onCleanup,
  onMount,
  render,
  startTransition,
  Suspense,
  createSuspenseToken,
  untrack,
  useContext,
  useDeferredValue,
  useTransition,
} from './index'
