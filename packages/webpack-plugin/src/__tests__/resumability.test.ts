import { rm } from 'node:fs/promises'

import type { FictWebpackLoaderOptions } from '../loader'

import { createFixture, createWebpackConfiguration, runApp, runCompiler } from './fixture'

const supportedDisabledOptions = { resumable: false } satisfies FictWebpackLoaderOptions
const supportedUndefinedOptions = {
  resumable: undefined,
} satisfies FictWebpackLoaderOptions
// @ts-expect-error Webpack does not provide the chunks or manifest required by resumability.
const unsupportedResumableOptions = { resumable: true } satisfies FictWebpackLoaderOptions
const unsupportedPublicIdOptions = {
  // @ts-expect-error Public resumable identities are owned by a supporting build integration.
  publicModuleId: 'fict:module:user-supplied',
} satisfies FictWebpackLoaderOptions
void [
  supportedDisabledOptions,
  supportedUndefinedOptions,
  unsupportedResumableOptions,
  unsupportedPublicIdOptions,
]

const entrySource = `
  import { $state } from 'fict'

  export function App() {
    const count = $state(1)
    return count * 2
  }
`

describe('@fictjs/webpack-plugin resumability boundary', () => {
  it('rejects resumable output before compiling a Webpack module', async () => {
    const root = await createFixture({ 'entry.ts': entrySource })

    try {
      await expect(
        runCompiler(
          createWebpackConfiguration(root, {
            loaderOptions: { resumable: true },
          }),
        ),
      ).rejects.toThrow(
        /does not support `resumable: true`.*split handler chunks.*public resumable module identities.*resumability manifest.*@fictjs\/vite-plugin/s,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a user-provided public module identity', async () => {
    const root = await createFixture({ 'entry.ts': entrySource })

    try {
      await expect(
        runCompiler(
          createWebpackConfiguration(root, {
            loaderOptions: { publicModuleId: 'fict:module:user-supplied' },
          }),
        ),
      ).rejects.toThrow(
        /`publicModuleId` is integration-owned.*split handler chunks.*public resumable module identities.*resumability manifest.*@fictjs\/vite-plugin/s,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps ordinary non-resumable Webpack compilation working', async () => {
    const root = await createFixture({ 'entry.ts': entrySource })

    try {
      await runCompiler(
        createWebpackConfiguration(root, {
          loaderOptions: { resumable: false },
        }),
      )
      expect(runApp(root)).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
