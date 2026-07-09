#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [manifestText, bundle] = await Promise.all([
  readFile(resolve(packageRoot, 'package.json'), 'utf8'),
  readFile(resolve(packageRoot, 'dist/extension.cjs'), 'utf8'),
])
const manifest = JSON.parse(manifestText)
const bundledDependencies = Object.keys(manifest.dependencies ?? {})
const externalDependencies = new Set()
const requirePattern = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g

let match
while ((match = requirePattern.exec(bundle))) {
  const specifier = match[2]
  if (
    bundledDependencies.some(
      dependency => specifier === dependency || specifier.startsWith(`${dependency}/`),
    )
  ) {
    externalDependencies.add(specifier)
  }
}

if (externalDependencies.size > 0) {
  throw new Error(
    `VS Code extension bundle contains external package requires: ${[...externalDependencies]
      .sort()
      .join(', ')}`,
  )
}

console.log('VS Code extension dependencies are bundled.')
