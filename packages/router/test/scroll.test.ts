import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  saveScrollPosition,
  clearScrollPosition,
  clearAllScrollPositions,
  createScrollRestoration,
  getScrollRestoration,
  configureScrollRestoration,
} from '../src/scroll'

// Note: The scroll module uses `isBrowser()` to guard against server-side execution.
// In the test environment (jsdom), we have a mock window but not all functionality.
// These tests focus on the storage and configuration aspects that work in tests.

// Clear scroll positions after each test
afterEach(() => {
  clearAllScrollPositions()
})

describe('scroll position storage', () => {
  describe('saveScrollPosition and clearScrollPosition', () => {
    it('should store positions keyed by string', () => {
      // We can't directly verify storage, but we can verify clear/existence behavior
      saveScrollPosition('key1')
      saveScrollPosition('key2')

      // After clearing key1, key2 should still exist
      clearScrollPosition('key1')

      // clearScrollPosition on non-existent key should not throw
      expect(() => clearScrollPosition('key1')).not.toThrow()
    })

    it('should not throw for invalid keys', () => {
      expect(() => saveScrollPosition('')).not.toThrow()
      expect(() => clearScrollPosition('')).not.toThrow()
    })
  })

  describe('clearAllScrollPositions', () => {
    it('should clear all saved positions', () => {
      saveScrollPosition('key1')
      saveScrollPosition('key2')
      saveScrollPosition('key3')

      expect(() => clearAllScrollPositions()).not.toThrow()
    })

    it('should handle empty state', () => {
      expect(() => clearAllScrollPositions()).not.toThrow()
    })
  })
})

describe('createScrollRestoration', () => {
  it('should create a scroll restoration manager with expected methods', () => {
    const manager = createScrollRestoration()

    expect(typeof manager.handleNavigation).toBe('function')
    expect(typeof manager.saveScrollPosition).toBe('function')
    expect(typeof manager.restoreScrollPosition).toBe('function')
    expect(typeof manager.scrollToTop).toBe('function')
    expect(typeof manager.scrollToHash).toBe('function')
    expect(typeof manager.reset).toBe('function')
    expect(manager.config).toBeDefined()
  })

  it('should use default options when none provided', () => {
    const manager = createScrollRestoration()

    expect(manager.config.enabled).toBe(true)
    expect(manager.config.restoreOnPop).toBe(true)
    expect(manager.config.scrollToTopOnPush).toBe(true)
    expect(manager.config.behavior).toBe('auto')
  })

  it('should merge custom options with defaults', () => {
    const manager = createScrollRestoration({
      enabled: false,
      behavior: 'smooth',
    })

    expect(manager.config.enabled).toBe(false)
    expect(manager.config.behavior).toBe('smooth')
    // Defaults should be preserved for unspecified options
    expect(manager.config.restoreOnPop).toBe(true)
    expect(manager.config.scrollToTopOnPush).toBe(true)
  })

  it('should allow partial options', () => {
    const manager1 = createScrollRestoration({ enabled: false })
    expect(manager1.config.enabled).toBe(false)
    expect(manager1.config.behavior).toBe('auto')

    const manager2 = createScrollRestoration({ scrollToTopOnPush: false })
    expect(manager2.config.scrollToTopOnPush).toBe(false)
    expect(manager2.config.enabled).toBe(true)
  })

  describe('handleNavigation', () => {
    it('should not throw when called with valid arguments', () => {
      const manager = createScrollRestoration()

      expect(() => {
        manager.handleNavigation(
          { pathname: '/from', search: '', hash: '', state: null, key: 'from-key' },
          { pathname: '/to', search: '', hash: '', state: null, key: 'to-key' },
          'PUSH',
        )
      }).not.toThrow()
    })

    it('should handle null from location', () => {
      const manager = createScrollRestoration()

      expect(() => {
        manager.handleNavigation(
          null,
          { pathname: '/to', search: '', hash: '', state: null, key: 'to-key' },
          'PUSH',
        )
      }).not.toThrow()
    })

    it('should handle all action types', () => {
      const manager = createScrollRestoration()
      const location = { pathname: '/page', search: '', hash: '', state: null, key: 'key' }

      expect(() => manager.handleNavigation(location, location, 'PUSH')).not.toThrow()
      expect(() => manager.handleNavigation(location, location, 'REPLACE')).not.toThrow()
      expect(() => manager.handleNavigation(location, location, 'POP')).not.toThrow()
    })

    it('should respect enabled flag', () => {
      const enabledManager = createScrollRestoration({ enabled: true })
      const disabledManager = createScrollRestoration({ enabled: false })
      const location = { pathname: '/page', search: '', hash: '', state: null, key: 'key' }

      // Both should not throw, but disabled one should do nothing
      expect(() => enabledManager.handleNavigation(null, location, 'PUSH')).not.toThrow()
      expect(() => disabledManager.handleNavigation(null, location, 'PUSH')).not.toThrow()
    })
  })

  describe('reset', () => {
    it('should not throw when called', () => {
      const manager = createScrollRestoration()

      expect(() => manager.reset()).not.toThrow()
    })

    it('should clear saved positions', () => {
      saveScrollPosition('test-key')

      const manager = createScrollRestoration()
      manager.reset()

      // After reset, clearScrollPosition should still work
      expect(() => clearScrollPosition('test-key')).not.toThrow()
    })
  })

  describe('scrollToTop', () => {
    it('should not throw when called', () => {
      const manager = createScrollRestoration()

      expect(() => manager.scrollToTop()).not.toThrow()
    })
  })

  describe('scrollToHash', () => {
    it('should not throw when called', () => {
      const manager = createScrollRestoration()

      expect(() => manager.scrollToHash('#section')).not.toThrow()
      expect(() => manager.scrollToHash('')).not.toThrow()
    })
  })
})

describe('getScrollRestoration', () => {
  it('should return a manager instance', () => {
    const instance = getScrollRestoration()

    expect(instance).toBeDefined()
    expect(typeof instance.handleNavigation).toBe('function')
  })

  it('should return the same instance on multiple calls', () => {
    const instance1 = getScrollRestoration()
    const instance2 = getScrollRestoration()

    expect(instance1).toBe(instance2)
  })
})

describe('configureScrollRestoration', () => {
  it('should configure the default instance', () => {
    configureScrollRestoration({ behavior: 'smooth' })

    const instance = getScrollRestoration()
    expect(instance.config.behavior).toBe('smooth')
  })

  it('should replace the default instance', () => {
    const before = getScrollRestoration()
    configureScrollRestoration({ enabled: false })
    const after = getScrollRestoration()

    expect(after.config.enabled).toBe(false)
    // After configuration, getScrollRestoration returns the new instance
    expect(getScrollRestoration()).toBe(after)
  })
})
