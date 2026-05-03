import { $memo, $state } from 'fict'

/**
 * @fictReturn { count: 'signal', doubled: 'memo' }
 */
export function useCounter() {
  const count = $state(0)
  const doubled = $memo(() => count * 2)
  return { count, doubled }
}
