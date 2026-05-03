import { $state } from 'fict'

/**
 * @fictReturn { directAccessor: "signal" }
 */
export function useToggle(initial = false) {
  const enabled = $state(initial)
  return enabled
}
