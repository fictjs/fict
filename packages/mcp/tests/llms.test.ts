import { describe, expect, it } from 'vitest'

import { toLlmsMarkdown } from '../src/store/llms'

describe('toLlmsMarkdown', () => {
  it('strips yaml frontmatter with CRLF line endings', () => {
    const markdown = [
      '---',
      'title: "Custom"',
      'tags: [mcp, docs]',
      '---',
      '# Hello',
      '',
      'Details',
      '',
    ].join('\r\n')

    expect(toLlmsMarkdown(markdown)).toBe('# Hello\n\nDetails\n')
  })

  it('keeps content unchanged when opening frontmatter has no closing delimiter', () => {
    const markdown = ['---', 'title: Missing close', '# Heading'].join('\n')

    expect(toLlmsMarkdown(markdown)).toBe('---\ntitle: Missing close\n# Heading\n')
  })
})
