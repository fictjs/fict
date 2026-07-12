import { describe, expect, it } from 'vitest'

import { createSSRDocument } from '../src/index'
import { acquireSharedGlobalTarget, installGlobals } from '../src/globals'

describe('SSR compatibility DOM globals', () => {
  it('installs without invoking accessors and restores the exact descriptor', () => {
    const dom = createSSRDocument()
    const target = {}
    let getterCalls = 0
    let setterCalls = 0
    const getter = () => {
      getterCalls++
      return 'previous-window'
    }
    const setter = () => {
      setterCalls++
    }
    Object.defineProperty(target, 'window', {
      configurable: true,
      enumerable: false,
      get: getter,
      set: setter,
    })
    const before = Object.getOwnPropertyDescriptor(target, 'window')

    const restore = installGlobals(dom.window, dom.document, target)
    const installed = Object.getOwnPropertyDescriptor(target, 'window')

    expect(installed).toEqual({
      configurable: true,
      enumerable: false,
      value: dom.window,
      writable: true,
    })
    expect(getterCalls).toBe(0)
    expect(setterCalls).toBe(0)

    restore()
    restore()

    expect(Object.getOwnPropertyDescriptor(target, 'window')).toEqual(before)
    expect(getterCalls).toBe(0)
    expect(setterCalls).toBe(0)
  })

  it('rolls back earlier globals when a later descriptor cannot be replaced', () => {
    const dom = createSSRDocument()
    const target = {}
    const previousWindow = { previous: true }
    Object.defineProperty(target, 'window', {
      configurable: true,
      enumerable: false,
      value: previousWindow,
      writable: false,
    })
    Object.defineProperty(target, 'document', {
      configurable: false,
      enumerable: true,
      value: 'locked-document',
      writable: false,
    })
    const beforeWindow = Object.getOwnPropertyDescriptor(target, 'window')
    const beforeDocument = Object.getOwnPropertyDescriptor(target, 'document')

    expect(() => installGlobals(dom.window, dom.document, target)).toThrowError(
      /Failed to install DOM global `document`/,
    )

    expect(Object.getOwnPropertyDescriptor(target, 'window')).toEqual(beforeWindow)
    expect(Object.getOwnPropertyDescriptor(target, 'document')).toEqual(beforeDocument)

    // A failed transaction releases its overlap guard instead of poisoning the target.
    expect(() => installGlobals(dom.window, dom.document, target)).toThrowError(
      /Failed to install DOM global `document`/,
    )
  })

  it('rejects overlapping installations and releases the guard on cleanup', () => {
    const dom = createSSRDocument()
    const target = {}
    const restore = installGlobals(dom.window, dom.document, target)

    expect(() => installGlobals(dom.window, dom.document, target)).toThrowError(
      /cannot be used by overlapping or nested renders/,
    )

    restore()
    const restoreAgain = installGlobals(dom.window, dom.document, target)
    restoreAgain()
  })

  it('shares ordinary render leases and blocks global exposure until the last cleanup', () => {
    const dom = createSSRDocument()
    const target = {}
    const releaseFirst = acquireSharedGlobalTarget(target)
    const releaseSecond = acquireSharedGlobalTarget(target)

    expect(() => installGlobals(dom.window, dom.document, target)).toThrowError(
      /including renders that do not expose globals/,
    )
    releaseFirst()
    expect(() => installGlobals(dom.window, dom.document, target)).toThrowError(
      /including renders that do not expose globals/,
    )

    releaseSecond()
    const restore = installGlobals(dom.window, dom.document, target)
    restore()
  })

  it('allows ordinary renders on a non-extensible target without mutating it', () => {
    const dom = createSSRDocument()
    const target = Object.preventExtensions({})

    const releaseFirst = acquireSharedGlobalTarget(target)
    const releaseSecond = acquireSharedGlobalTarget(target)

    expect(Reflect.ownKeys(target)).toEqual([])
    expect(() => installGlobals(dom.window, dom.document, target)).toThrowError(
      /Failed to acquire the process DOM-global compatibility lease/,
    )
    expect(releaseFirst).not.toThrow()
    expect(releaseSecond).not.toThrow()
  })

  it('honors the process-wide lease marker from another module instance', () => {
    const dom = createSSRDocument()
    const target = {}
    Object.defineProperty(target, Symbol.for('@fictjs/ssr.exposeGlobalsLease'), {
      configurable: true,
      value: { foreignModuleLease: true },
    })

    expect(() => installGlobals(dom.window, dom.document, target)).toThrowError(
      /cannot be used by overlapping or nested renders/,
    )
    expect(() => acquireSharedGlobalTarget(target)).toThrowError(
      /cannot be used by overlapping or nested renders/,
    )
    expect(Object.getOwnPropertyNames(target)).toEqual([])
  })

  it('joins an ordinary-render reservation created by another module instance', () => {
    const dom = createSSRDocument()
    const target = {}
    const leaseKey = Symbol.for('@fictjs/ssr.exposeGlobalsLease')
    const sharedKey = Symbol.for('@fictjs/ssr.sharedRenderLease')
    const foreignState = {}
    Object.defineProperties(foreignState, {
      [sharedKey]: { value: true },
      count: { value: 1, writable: true },
    })
    Object.defineProperty(target, leaseKey, {
      configurable: true,
      value: foreignState,
    })

    const release = acquireSharedGlobalTarget(target)
    expect(Object.getOwnPropertyDescriptor(foreignState, 'count')?.value).toBe(2)
    expect(() => installGlobals(dom.window, dom.document, target)).toThrowError(
      /including renders that do not expose globals/,
    )

    release()
    expect(Object.getOwnPropertyDescriptor(foreignState, 'count')?.value).toBe(1)
    expect(Reflect.deleteProperty(target, leaseKey)).toBe(true)

    const restore = installGlobals(dom.window, dom.document, target)
    restore()
  })

  it('keeps an ordinary-render target locked when its shared marker changes', () => {
    const target = {}
    const release = acquireSharedGlobalTarget(target)
    Object.defineProperty(target, Symbol.for('@fictjs/ssr.exposeGlobalsLease'), {
      configurable: true,
      value: { replaced: true },
    })

    expect(release).toThrowError(/shared SSR render lease changed before cleanup/)
    expect(() => acquireSharedGlobalTarget(target)).toThrowError(
      /shared SSR render lease changed before cleanup/,
    )
  })

  it('keeps a poisoned Proxy target locked when transactional rollback is trapped', () => {
    const dom = createSSRDocument()
    let installationFailed = false
    const target = new Proxy(
      {},
      {
        defineProperty(inner, key, descriptor) {
          if (key === 'document') {
            installationFailed = true
            return false
          }
          return Reflect.defineProperty(inner, key, descriptor)
        },
        deleteProperty(inner, key) {
          if (installationFailed && key === 'window') return false
          return Reflect.deleteProperty(inner, key)
        },
      },
    )

    expect(() => installGlobals(dom.window, dom.document, target)).toThrowError(
      /and roll back the partial installation/,
    )
    expect(() => installGlobals(dom.window, dom.document, target)).toThrowError(
      /cannot be used by overlapping or nested renders/,
    )
  })
})
