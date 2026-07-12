import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'

const docsRoot = new URL('../docs/', import.meta.url)

async function collectMarkdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(entry => {
      const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
      return entry.isDirectory()
        ? collectMarkdownFiles(url)
        : entry.name.endsWith('.md')
          ? [url]
          : []
    }),
  )
  return nested.flat()
}

test('published pages contain no placeholder copy', async () => {
  const files = await collectMarkdownFiles(docsRoot)

  for (const file of files) {
    const contents = await readFile(file, 'utf8')
    assert.doesNotMatch(
      contents,
      /coming soon|content for this section will be added/i,
      file.pathname,
    )
  }
})

test('concept pages carry required OKF ownership metadata', async () => {
  for (const section of ['api/', 'guide/']) {
    const files = await collectMarkdownFiles(new URL(section, docsRoot))

    for (const file of files.filter(file => !file.pathname.endsWith('/index.md'))) {
      const contents = await readFile(file, 'utf8')
      const frontmatter = contents.match(/^---\n([\s\S]*?)\n---\n/)
      assert.ok(frontmatter, file.pathname)
      for (const field of ['type', 'title', 'description', 'owner', 'status']) {
        assert.match(
          frontmatter[1],
          new RegExp(`^${field}:\\s*\\S`, 'm'),
          `${file.pathname}: ${field}`,
        )
      }
    }
  }
})

test('every configured guide and API sidebar route resolves to a document', async () => {
  const config = await readFile(new URL('.vitepress/config.ts', docsRoot), 'utf8')
  const routes = [...config.matchAll(/link: '(\/(?:guide|api)\/?[^']*)'/g)].map(match => match[1])

  assert.ok(routes.length > 0)
  for (const route of routes) {
    const relative = route.replace(/^\//, '').replace(/\/$/, '/index') + '.md'
    const document = new URL(relative, docsRoot)
    await assert.doesNotReject(readFile(document, 'utf8'), route)
  }
})

test('createSignal guidance uses real derivation APIs and a safe wrapper overload', async () => {
  const contents = await readFile(new URL('api/signal.md', docsRoot), 'utf8')

  assert.doesNotMatch(contents, /\|\s*Derived values\s*\|[^|\n]*\$derived/)
  assert.doesNotMatch(contents, /arguments\.length/)
  assert.match(contents, /\.\.\.args: \[\] \| \[T\]/)
  assert.match(contents, /Plain JavaScript expression; `\$memo`/)
})
