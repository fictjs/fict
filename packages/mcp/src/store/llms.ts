import { splitFrontmatter } from './frontmatter'

export function toLlmsMarkdown(markdown: string): string {
  let text = splitFrontmatter(markdown).body

  text = text.replace(/<!--([\s\S]*?)-->/g, '')
  text = text.replace(/^!\[[^\]]*\]\([^)]*\)\s*$/gm, '')
  text = text.replace(/\n{3,}/g, '\n\n')

  return `${text.trim()}\n`
}
