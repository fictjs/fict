export function toLlmsMarkdown(markdown: string): string {
  let text = markdown

  if (text.startsWith('---')) {
    const frontmatterEndIndex = text.indexOf('\n---', 3)
    if (frontmatterEndIndex !== -1) {
      text = text.slice(frontmatterEndIndex + '\n---'.length)
    }
  }

  text = text.replace(/<!--([\s\S]*?)-->/g, '')
  text = text.replace(/^!\[[^\]]*\]\([^\)]*\)\s*$/gm, '')
  text = text.replace(/\n{3,}/g, '\n\n')

  return `${text.trim()}\n`
}
