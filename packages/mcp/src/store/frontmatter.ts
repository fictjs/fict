export interface DocFrontmatterMetadata {
  title?: string
  tags?: string[]
  use_cases?: string[]
}

function stripWrappedQuotes(text: string): string {
  const trimmed = text.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function parseInlineList(rawValue: string): string[] {
  const trimmed = rawValue.trim()
  if (!trimmed) return []

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1)
    return inner
      .split(',')
      .map(item => stripWrappedQuotes(item))
      .filter(Boolean)
  }

  if (trimmed.includes(',')) {
    return trimmed
      .split(',')
      .map(item => stripWrappedQuotes(item))
      .filter(Boolean)
  }

  return [stripWrappedQuotes(trimmed)]
}

function parseFrontmatterMetadata(frontmatter: string): DocFrontmatterMetadata {
  const metadata: DocFrontmatterMetadata = {}
  const lines = frontmatter.split(/\r?\n/)
  let activeListKey: 'tags' | 'use_cases' | null = null

  for (const line of lines) {
    const listItemMatch = line.match(/^\s*-\s+(.+)$/)
    if (listItemMatch && activeListKey) {
      const listItemValue = listItemMatch[1]
      if (!listItemValue) continue
      const value = stripWrappedQuotes(listItemValue)
      if (!value) continue
      const nextList = metadata[activeListKey] ?? []
      nextList.push(value)
      metadata[activeListKey] = nextList
      continue
    }

    const keyValueMatch = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!keyValueMatch) {
      activeListKey = null
      continue
    }

    const key = keyValueMatch[1]
    const keyValueRaw = keyValueMatch[2]
    if (keyValueRaw === undefined) continue
    const rawValue = keyValueRaw.trim()

    if (key === 'title') {
      if (rawValue) {
        metadata.title = stripWrappedQuotes(rawValue)
      }
      activeListKey = null
      continue
    }

    if (key === 'tags' || key === 'use_cases') {
      if (!rawValue) {
        metadata[key] = metadata[key] ?? []
        activeListKey = key
      } else {
        const values = parseInlineList(rawValue)
        if (values.length > 0) {
          metadata[key] = values
        }
        activeListKey = null
      }
      continue
    }

    activeListKey = null
  }

  return metadata
}

export function splitFrontmatter(markdown: string): {
  body: string
  metadata: DocFrontmatterMetadata
} {
  if (!markdown.startsWith('---')) {
    return {
      body: markdown,
      metadata: {},
    }
  }

  const lines = markdown.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    return {
      body: markdown,
      metadata: {},
    }
  }

  let endIndex = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === '---') {
      endIndex = i
      break
    }
  }

  if (endIndex === -1) {
    return {
      body: markdown,
      metadata: {},
    }
  }

  const frontmatter = lines.slice(1, endIndex).join('\n')
  const body = lines.slice(endIndex + 1).join('\n')

  return {
    body,
    metadata: parseFrontmatterMetadata(frontmatter),
  }
}
