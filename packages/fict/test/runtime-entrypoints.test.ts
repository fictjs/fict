import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as runtimeLoader from '@fictjs/runtime/loader'
import * as runtimeInternal from '@fictjs/runtime/internal'
import * as runtimeInternalList from '@fictjs/runtime/internal/list'

import * as loader from '../src/loader'
import * as internal from '../src/internal'
import * as internalList from '../src/internal-list'

describe('fict runtime bridge entrypoints', () => {
  it('re-exports internal compiler helpers through fict/internal', () => {
    expect(internal.template).toBe(runtimeInternal.template)
    expect(internal.__fictQrl).toBe(runtimeInternal.__fictQrl)
  })

  it('re-exports keyed list helpers through fict/internal/list', () => {
    expect(internalList.createKeyedList).toBe(runtimeInternalList.createKeyedList)
  })

  it('re-exports the resumable loader through fict/loader', () => {
    expect(loader.installResumableLoader).toBe(runtimeLoader.installResumableLoader)
  })

  it('declares internal and loader subpath exports in package.json', () => {
    const packageJsonPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../package.json',
    )
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      exports?: Record<string, unknown>
    }

    expect(pkg.exports?.['./internal']).toBeTruthy()
    expect(pkg.exports?.['./internal/list']).toBeTruthy()
    expect(pkg.exports?.['./loader']).toBeTruthy()
  })
})
