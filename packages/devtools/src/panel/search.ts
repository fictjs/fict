/**
 * Fict DevTools Fuzzy Search
 *
 * A lightweight fuzzy search implementation without external dependencies.
 * Supports approximate string matching with scoring.
 */

export interface SearchableItem {
  id: number
  name?: string
  [key: string]: unknown
}

export interface SearchResult<T> {
  item: T
  score: number
  matches: SearchMatch[]
}

export interface SearchMatch {
  key: string
  indices: [number, number][]
}

export interface SearchOptions {
  /** Keys to search in (default: ['name']) */
  keys?: string[]
  /** Minimum score threshold 0-1 (default: 0.3) */
  threshold?: number
  /** Whether to ignore case (default: true) */
  ignoreCase?: boolean
  /** Maximum results to return (default: 100) */
  limit?: number
}

const DEFAULT_OPTIONS: Required<SearchOptions> = {
  keys: ['name'],
  threshold: 0.3,
  ignoreCase: true,
  limit: 100,
}

/**
 * Calculate fuzzy match score between query and text.
 * Returns a score between 0 (no match) and 1 (exact match).
 */
function fuzzyMatch(
  query: string,
  text: string,
  ignoreCase: boolean,
): { score: number; indices: [number, number][] } | null {
  if (!query || !text) return null

  const q = ignoreCase ? query.toLowerCase() : query
  const t = ignoreCase ? text.toLowerCase() : text

  // Exact match - highest score
  if (t === q) {
    return { score: 1, indices: [[0, text.length - 1]] }
  }

  // Contains match - high score
  const containsIndex = t.indexOf(q)
  if (containsIndex !== -1) {
    // Score based on position (earlier = better) and length ratio
    const positionScore = 1 - containsIndex / t.length
    const lengthScore = q.length / t.length
    const score = 0.7 + 0.2 * positionScore + 0.1 * lengthScore
    return {
      score,
      indices: [[containsIndex, containsIndex + q.length - 1]],
    }
  }

  // Fuzzy match - character-by-character matching
  let queryIndex = 0
  let textIndex = 0
  const indices: [number, number][] = []
  let currentMatchStart = -1

  let totalMatches = 0

  while (queryIndex < q.length && textIndex < t.length) {
    if (q[queryIndex] === t[textIndex]) {
      if (currentMatchStart === -1) {
        currentMatchStart = textIndex
      }
      totalMatches++
      queryIndex++
    } else {
      if (currentMatchStart !== -1) {
        indices.push([currentMatchStart, textIndex - 1])
        currentMatchStart = -1
      }
    }
    textIndex++
  }

  // Close last match range
  if (currentMatchStart !== -1) {
    indices.push([currentMatchStart, textIndex - 1])
  }

  // Check if all query characters were matched
  if (queryIndex < q.length) {
    return null // Not all characters matched
  }

  // Calculate score based on:
  // - Percentage of query matched
  // - Length of consecutive matches
  // - Position of matches (earlier = better)
  const matchRatio = totalMatches / q.length
  const lengthPenalty = 1 - (t.length - q.length) / t.length
  const gapPenalty = 1 - (indices.length - 1) * 0.1 // Penalize gaps

  const score = Math.max(0, Math.min(1, 0.3 * matchRatio + 0.3 * lengthPenalty + 0.4 * gapPenalty))

  return { score, indices }
}

/**
 * Get value at nested path in object
 */
function getValueAtPath(obj: Record<string, unknown>, path: string): string {
  const parts = path.split('.')
  let current: unknown = obj

  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      return ''
    }
    current = (current as Record<string, unknown>)[part]
  }

  if (current == null) return ''
  if (typeof current === 'string') return current
  if (typeof current === 'number') return String(current)
  return ''
}

/**
 * Perform fuzzy search on a list of items
 */
export function fuzzySearch<T extends SearchableItem>(
  items: T[],
  query: string,
  options: SearchOptions = {},
): SearchResult<T>[] {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  if (!query.trim()) {
    // Return all items with max score when no query
    return items.slice(0, opts.limit).map(item => ({
      item,
      score: 1,
      matches: [],
    }))
  }

  const results: SearchResult<T>[] = []

  for (const item of items) {
    let bestScore = 0
    const matches: SearchMatch[] = []

    // Check ID as string
    const idMatch = fuzzyMatch(query, String(item.id), opts.ignoreCase)
    if (idMatch && idMatch.score > bestScore) {
      bestScore = idMatch.score
      matches.push({ key: 'id', indices: idMatch.indices })
    }

    // Check configured keys
    for (const key of opts.keys) {
      const value = getValueAtPath(item as Record<string, unknown>, key)
      if (!value) continue

      const match = fuzzyMatch(query, value, opts.ignoreCase)
      if (match && match.score > bestScore) {
        bestScore = match.score
        matches.push({ key, indices: match.indices })
      }
    }

    if (bestScore >= opts.threshold) {
      results.push({ item, score: bestScore, matches })
    }
  }

  // Sort by score (descending) and limit
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, opts.limit)
}

/**
 * Simple filter function that wraps fuzzy search for easy use
 */
export function filterItems<T extends SearchableItem>(
  items: T[],
  query: string,
  options: SearchOptions = {},
): T[] {
  if (!query.trim()) return items

  const results = fuzzySearch(items, query, options)
  return results.map(r => r.item)
}

/**
 * Highlight matched portions of text for display
 */
export function highlightMatches(
  text: string,
  query: string,
  options: { ignoreCase?: boolean; highlightClass?: string } = {},
): string {
  const { ignoreCase = true, highlightClass = 'search-highlight' } = options

  if (!query.trim()) return escapeHtml(text)

  const match = fuzzyMatch(query, text, ignoreCase)
  if (!match || match.indices.length === 0) {
    return escapeHtml(text)
  }

  // Sort indices by start position
  const sortedIndices = [...match.indices].sort((a, b) => a[0] - b[0])

  // Build highlighted string
  let result = ''
  let lastIndex = 0

  for (const [start, end] of sortedIndices) {
    // Add non-matched portion
    result += escapeHtml(text.slice(lastIndex, start))
    // Add matched portion with highlight
    result += `<mark class="${highlightClass}">${escapeHtml(text.slice(start, end + 1))}</mark>`
    lastIndex = end + 1
  }

  // Add remaining text
  result += escapeHtml(text.slice(lastIndex))

  return result
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str: string | unknown): string {
  const s = typeof str === 'string' ? str : String(str ?? '')
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
