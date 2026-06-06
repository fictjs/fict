export function parseCanonicalArrayPropIndex(key: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(key)) return null
  const index = Number(key)
  return Number.isSafeInteger(index) ? index : null
}

export function isCanonicalArrayPropIndex(key: string): boolean {
  return parseCanonicalArrayPropIndex(key) !== null
}
