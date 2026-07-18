import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { parseModuleReactiveMetadata, resolvePackageModuleMetadata } from '../src/graph-host'

const tempRoots: string[] = []
const metadata = (kind: 'signal' | 'memo' | 'store' = 'signal') => ({
  version: 1,
  exports: { value: kind },
})

interface PackageFixture {
  importer: string
  packageRoot: string
  root: string
}

async function packageFixture(packageName = 'fict-metadata-lib'): Promise<PackageFixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'fict-metadata-safety-'))
  tempRoots.push(root)
  const importer = path.join(root, 'src', 'consumer.ts')
  const packageRoot = path.join(root, 'node_modules', ...packageName.split('/'))
  await mkdir(path.dirname(importer), { recursive: true })
  await mkdir(packageRoot, { recursive: true })
  await writeFile(importer, 'export {}')
  return { importer, packageRoot, root }
}

async function writeManifest(
  fixture: PackageFixture,
  fict: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    path.join(fixture.packageRoot, 'package.json'),
    JSON.stringify({ name: path.basename(fixture.packageRoot), fict }),
  )
}

async function writeMetadata(
  fixture: PackageFixture,
  relativePath: string,
  value: unknown,
): Promise<string> {
  const filename = path.join(fixture.packageRoot, relativePath)
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, JSON.stringify(value))
  return filename
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('native module metadata safety', () => {
  it('fails closed for malformed, non-canonical, unknown, and over-deep schemas', () => {
    const invalid = [
      '{',
      'null',
      '[]',
      JSON.stringify({ exports: {} }),
      JSON.stringify({ version: 2, exports: {} }),
      JSON.stringify({ version: 1, exports: {}, legacy: true }),
      JSON.stringify({ version: 1, exports: null }),
      JSON.stringify({ version: 1, exports: { value: 'effect' } }),
      JSON.stringify({ version: 1, exports: {}, hooks: null }),
      JSON.stringify({ version: 1, exports: {}, hooks: { useValue: null } }),
      JSON.stringify({
        version: 1,
        exports: {},
        hooks: { useValue: { directAccessor: 'signal', unknown: true } },
      }),
      ...['01', '00', '-1', '1.5', '9007199254740992'].map(index =>
        JSON.stringify({
          version: 1,
          exports: {},
          hooks: { usePair: { arrayProps: { [index]: 'signal' } } },
        }),
      ),
      JSON.stringify({
        version: 1,
        exports: {},
        namespaces: { nested: { version: 2, exports: {} } },
      }),
    ]

    let overDeep: Record<string, unknown> = { version: 1, exports: {} }
    for (let depth = 0; depth < 34; depth += 1) {
      overDeep = { version: 1, exports: {}, namespaces: { nested: overDeep } }
    }
    invalid.push(JSON.stringify(overDeep))

    for (const raw of invalid) expect(parseModuleReactiveMetadata(raw), raw).toBeNull()
    expect(
      parseModuleReactiveMetadata(
        JSON.stringify({
          version: 1,
          exports: {},
          hooks: { usePair: { arrayProps: { '0': 'signal', '1': 'memo' } } },
        }),
      ),
    ).not.toBeNull()
  })

  it('preserves reserved names as own data without prototype pollution', () => {
    const parsed = parseModuleReactiveMetadata(
      '{"version":1,"exports":{"__proto__":"signal","constructor":"memo","toString":"store"},"namespaces":{"__proto__":{"version":1,"exports":{}}}}',
    )

    expect(parsed).not.toBeNull()
    for (const key of ['__proto__', 'constructor', 'toString']) {
      expect(Object.prototype.hasOwnProperty.call(parsed?.exports, key)).toBe(true)
    }
    expect(Object.prototype.hasOwnProperty.call(parsed?.namespaces, '__proto__')).toBe(true)
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('rejects relative escapes, absolute paths, file URLs, /@fs paths, and NULs', async () => {
    const fixture = await packageFixture()
    const external = await writeMetadata(
      { ...fixture, packageRoot: fixture.root },
      'outside.fict.meta.json',
      metadata(),
    )
    const declarations = [
      '../../outside.fict.meta.json',
      external,
      pathToFileURL(external).href,
      `/@fs${external}`,
      ['./dist/invalid', 'name.fict.meta.json'].join(String.fromCharCode(0)),
    ]

    for (const declaration of declarations) {
      await writeManifest(fixture, { metadata: declaration })
      expect(resolvePackageModuleMetadata('fict-metadata-lib', fixture.importer)).toBeUndefined()
    }
  })

  it('rejects metadata symlinks that leave the declared package root', async () => {
    const fixture = await packageFixture()
    const externalRoot = path.join(fixture.root, 'external')
    const linkedRoot = path.join(fixture.packageRoot, 'dist', 'linked')
    await mkdir(externalRoot, { recursive: true })
    await writeFile(path.join(externalRoot, 'index.fict.meta.json'), JSON.stringify(metadata()))
    await mkdir(path.dirname(linkedRoot), { recursive: true })
    await symlink(externalRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
    await writeManifest(fixture, { metadata: './dist/linked/index.fict.meta.json' })

    expect(resolvePackageModuleMetadata('fict-metadata-lib', fixture.importer)).toBeUndefined()
  })

  it('ignores invalid package payloads and observes a valid replacement immediately', async () => {
    const fixture = await packageFixture()
    const metadataPath = 'dist/index.fict.meta.json'
    await writeManifest(fixture, { metadata: `./${metadataPath}` })

    for (const payload of [
      { version: 1, exports: null },
      { version: 2, exports: {} },
      { version: 1, exports: { value: 'effect' } },
      {
        version: 1,
        exports: {},
        hooks: { usePair: { arrayProps: { '01': 'signal' } } },
      },
    ]) {
      await writeMetadata(fixture, metadataPath, payload)
      expect(resolvePackageModuleMetadata('fict-metadata-lib', fixture.importer)).toBeUndefined()
    }

    await writeMetadata(fixture, metadataPath, metadata('memo'))
    expect(resolvePackageModuleMetadata('fict-metadata-lib', fixture.importer)).toEqual(
      metadata('memo'),
    )
  })

  it('normalizes package suffixes but gives exact suffix declarations precedence', async () => {
    const fixture = await packageFixture('@scope/fict-metadata-lib')
    await writeManifest(fixture, {
      metadata: './dist/root.fict.meta.json',
      exports: {
        './hooks': './dist/hooks.fict.meta.json',
        './hooks?raw': './dist/raw-hooks.fict.meta.json',
      },
    })
    await writeMetadata(fixture, 'dist/root.fict.meta.json', metadata('signal'))
    await writeMetadata(fixture, 'dist/hooks.fict.meta.json', metadata('memo'))
    await writeMetadata(fixture, 'dist/raw-hooks.fict.meta.json', metadata('store'))

    const resolve = (source: string) => resolvePackageModuleMetadata(source, fixture.importer)
    expect(resolve('@scope/fict-metadata-lib?raw')).toEqual(metadata('signal'))
    expect(resolve('@scope/fict-metadata-lib/hooks#fragment')).toEqual(metadata('memo'))
    expect(resolve('@scope/fict-metadata-lib/hooks?raw')).toEqual(metadata('store'))
    expect(resolve('@scope/fict-metadata-lib/hooks?other#fragment')).toEqual(metadata('memo'))
  })

  it('does not cache package misses or stale metadata assets', async () => {
    const fixture = await packageFixture()
    expect(resolvePackageModuleMetadata('fict-metadata-lib', fixture.importer)).toBeUndefined()

    await writeManifest(fixture, { metadata: './dist/index.fict.meta.json' })
    expect(resolvePackageModuleMetadata('fict-metadata-lib', fixture.importer)).toBeUndefined()

    await writeMetadata(fixture, 'dist/index.fict.meta.json', metadata('signal'))
    expect(resolvePackageModuleMetadata('fict-metadata-lib', fixture.importer)).toEqual(
      metadata('signal'),
    )

    await writeMetadata(fixture, 'dist/index.fict.meta.json', metadata('store'))
    expect(resolvePackageModuleMetadata('fict-metadata-lib', fixture.importer)).toEqual(
      metadata('store'),
    )
  })

  it('never probes source-adjacent or cwd metadata for undeclared imports', async () => {
    const fixture = await packageFixture()
    await writeFile(
      path.join(fixture.packageRoot, 'package.json'),
      JSON.stringify({ name: 'fict-metadata-lib' }),
    )
    await writeMetadata(fixture, 'index.fict.meta.json', metadata())
    await writeFile(path.join(fixture.root, 'fict-metadata-lib.fict.meta.json'), '{}')

    expect(resolvePackageModuleMetadata('fict-metadata-lib', fixture.importer)).toBeUndefined()
    expect(resolvePackageModuleMetadata('./fict-metadata-lib', fixture.importer)).toBeUndefined()
  })
})
