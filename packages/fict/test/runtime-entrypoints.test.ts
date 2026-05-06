import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as runtimeLoader from '@fictjs/runtime/loader'
import * as runtimeAdvanced from '@fictjs/runtime/advanced'
import * as runtimeInternal from '@fictjs/runtime/internal'
import * as runtimeInternalList from '@fictjs/runtime/internal/list'

import * as advanced from '../src/advanced'
import * as main from '../src/index'
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

  it('re-exports DevTools protocol helpers through fict/advanced', () => {
    expect(advanced.FICT_DEVTOOLS_PROTOCOL_VERSION).toBe(
      runtimeAdvanced.FICT_DEVTOOLS_PROTOCOL_VERSION,
    )
    expect(advanced.FICT_DEVTOOLS_MIN_PROTOCOL_VERSION).toBe(
      runtimeAdvanced.FICT_DEVTOOLS_MIN_PROTOCOL_VERSION,
    )
    expect(advanced.isDevtoolsHookCompatible).toBe(runtimeAdvanced.isDevtoolsHookCompatible)
    expect(advanced.getDevtoolsHook).toBe(runtimeAdvanced.getDevtoolsHook)
  })

  it('keeps DevTools protocol helpers out of fict main', () => {
    const publicMain = main as Record<string, unknown>

    expect('FICT_DEVTOOLS_PROTOCOL_VERSION' in publicMain).toBe(false)
    expect('FICT_DEVTOOLS_MIN_PROTOCOL_VERSION' in publicMain).toBe(false)
    expect('isDevtoolsHookCompatible' in publicMain).toBe(false)
    expect('getDevtoolsHook' in publicMain).toBe(false)
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
