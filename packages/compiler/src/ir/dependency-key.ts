import { getSSABaseName } from './hir'

export function normalizeDependencyKey(name: string): string {
  return name
    .split('.')
    .map(part => getSSABaseName(part))
    .join('.')
}
