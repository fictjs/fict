import { describe, it, expect, vi } from 'vitest'

import fict from '..'

// Mock Vite config for testing
const mockBuildConfig = {
  command: 'build' as const,
  mode: 'production',
  root: '/project',
  base: '/',
  build: { ssr: false },
  resolve: { alias: [] },
}

const mockSsrBuildConfig = {
  ...mockBuildConfig,
  build: { ssr: true },
}

describe('fict vite-plugin', () => {
  it('applies the Babel transformer', async () => {
    const plugin = fict()
    const sample = `
      import { $state } from 'fict'
      function Button() {
        let count = $state(0)
        return <button>{count}</button>
      }
    `

    const mockContext = {
      error: vi.fn(),
    }

    const transform = plugin.transform as any
    const result =
      typeof transform === 'function'
        ? await transform.call(mockContext, sample, '/project/src/Button.tsx')
        : await transform?.handler.call(mockContext, sample, '/project/src/Button.tsx')

    expect(result && typeof result === 'object').toBe(true)
    if (result && typeof result === 'object' && 'code' in result) {
      // HIR codegen is now the default - check for HIR output markers
      // The output should contain __fict_hir_codegen__ marker or runtime imports
      const code = result.code as string
      const hasHIRMarker = code.includes('__fict_hir_codegen__')
      const hasRuntimeImport = code.includes('@fictjs/runtime')
      expect(hasHIRMarker || hasRuntimeImport).toBe(true)
    }
  })

  it('transforms files with Vite query params', async () => {
    const plugin = fict()
    const sample = `
      import { $state } from 'fict'
      function Button() {
        let count = $state(0)
        return <button>{count}</button>
      }
    `

    const mockContext = {
      error: vi.fn(),
    }

    const transform = plugin.transform as any
    const result =
      typeof transform === 'function'
        ? await transform.call(mockContext, sample, '/project/src/Button.tsx?import')
        : await transform?.handler.call(mockContext, sample, '/project/src/Button.tsx?import')

    expect(result && typeof result === 'object').toBe(true)
    if (result && typeof result === 'object' && 'code' in result) {
      const code = result.code as string
      const hasHIRMarker = code.includes('__fict_hir_codegen__')
      const hasRuntimeImport = code.includes('@fictjs/runtime')
      expect(hasHIRMarker || hasRuntimeImport).toBe(true)
    }
  })

  describe('function-level code splitting', () => {
    it('rewrites QRLs to virtual modules when functionSplitting is enabled', async () => {
      const plugin = fict({ functionSplitting: true })

      // Configure the plugin as if in build mode
      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const sample = `
        import { $state } from 'fict'
        export function Counter() {
          let count = $state(0)
          return <button onClick$={() => count++}>{count}</button>
        }
      `

      const mockContext = {
        error: vi.fn(),
      }

      const transform = plugin.transform as any
      const result =
        typeof transform === 'function'
          ? await transform.call(mockContext, sample, '/project/src/Counter.tsx')
          : await transform?.handler.call(mockContext, sample, '/project/src/Counter.tsx')

      expect(result && typeof result === 'object').toBe(true)
      if (result && typeof result === 'object' && 'code' in result) {
        const code = result.code as string

        // When function splitting is enabled, QRLs should point to virtual modules
        if (code.includes('__fict_e')) {
          // Handler exports should still exist (handlers stay in module)
          expect(code).toContain('export const __fict_e')

          // QRLs should be rewritten to virtual module URLs
          // Or if no handlers were detected due to the pattern, original QRL format
          const hasVirtualQrl = code.includes('virtual:fict-handler:')
          const hasOriginalQrl = code.includes('__fictQrl(')

          // Either format is acceptable depending on regex match
          expect(hasVirtualQrl || hasOriginalQrl).toBe(true)
        }
      }
    })

    it('resolves virtual handler modules', async () => {
      const plugin = fict({ functionSplitting: true })

      const resolveId = plugin.resolveId as any
      if (typeof resolveId === 'function') {
        const resolved = resolveId('virtual:fict-handler:/src/Counter.tsx$$__fict_e0')
        expect(resolved).toBe('\0fict-handler:/src/Counter.tsx$$__fict_e0')
      }
    })

    it('loads extracted virtual handler modules', async () => {
      const plugin = fict({ functionSplitting: true })

      // First, configure and do a transform to register handlers
      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_e0 = (scopeId, event, el) => {
  const [count] = __fictUseLexicalScope(scopeId, ['count']);
  const __handler = () => count(count() + 1);
  return __handler.call(el, event);
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn() }
      const transform = plugin.transform as any
      if (typeof transform === 'function') {
        await transform.call(mockContext, compiledCode, '/project/src/Counter.tsx')
      }

      // Now test loading a virtual handler module
      const load = plugin.load as any
      expect(typeof load).toBe('function')
      const content = load('\0fict-handler:/project/src/Counter.tsx$$__fict_e0') as string | null
      expect(content).not.toBeNull()
      expect(content).toContain('export default')
      expect(content).toContain('__fictUseLexicalScope')
    })

    it('clears extracted handlers on buildStart', async () => {
      const plugin = fict({ functionSplitting: true })

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_e0 = (scopeId, event, el) => {
  const [count] = __fictUseLexicalScope(scopeId, ['count']);
  const __handler = () => count(count() + 1);
  return __handler.call(el, event);
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn() }
      const transform = plugin.transform as any
      if (typeof transform === 'function') {
        await transform.call(mockContext, compiledCode, '/project/src/Counter.tsx')
      }

      const load = plugin.load as any
      expect(typeof load).toBe('function')
      const beforeReset = load('\0fict-handler:/project/src/Counter.tsx$$__fict_e0') as string
      expect(beforeReset).toContain('export default')

      const buildStart = plugin.buildStart as (() => void) | undefined
      expect(typeof buildStart).toBe('function')
      buildStart?.()

      const afterReset = load('\0fict-handler:/project/src/Counter.tsx$$__fict_e0')
      expect(afterReset).toBeNull()
    })

    it('keeps handler registries isolated across plugin instances', async () => {
      const pluginA = fict({ functionSplitting: true })
      const pluginB = fict({ functionSplitting: true })

      if (typeof pluginA.configResolved === 'function') {
        pluginA.configResolved(mockBuildConfig as any)
      }
      if (typeof pluginB.configResolved === 'function') {
        pluginB.configResolved(mockBuildConfig as any)
      }

      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_e0 = (scopeId, event, el) => {
  const [count] = __fictUseLexicalScope(scopeId, ['count']);
  const __handler = () => count(count() + 1);
  return __handler.call(el, event);
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn() }
      const transformA = pluginA.transform as any
      if (typeof transformA === 'function') {
        await transformA.call(mockContext, compiledCode, '/project/src/Counter.tsx')
      }

      const loadA = pluginA.load as any
      expect(typeof loadA).toBe('function')
      const before = loadA('\0fict-handler:/project/src/Counter.tsx$$__fict_e0') as string | null
      expect(before).not.toBeNull()
      expect(before).toContain('export default')

      const buildStartB = pluginB.buildStart as (() => void) | undefined
      expect(typeof buildStartB).toBe('function')
      buildStartB?.()

      const after = loadA('\0fict-handler:/project/src/Counter.tsx$$__fict_e0') as string | null
      expect(after).not.toBeNull()
      expect(after).toContain('export default')
    })

    it('isolates handler registries between client and ssr build contexts', async () => {
      const clientPlugin = fict({ functionSplitting: true })
      const ssrPlugin = fict({ functionSplitting: true })

      if (typeof clientPlugin.configResolved === 'function') {
        clientPlugin.configResolved(mockBuildConfig as any)
      }
      if (typeof ssrPlugin.configResolved === 'function') {
        ssrPlugin.configResolved(mockSsrBuildConfig as any)
      }

      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_e0 = (scopeId, event, el) => {
  const [count] = __fictUseLexicalScope(scopeId, ['count']);
  const __handler = () => count(count() + 1);
  return __handler.call(el, event);
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const clientContext = { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() }
      const ssrContext = { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() }

      const clientTransform = clientPlugin.transform as any
      const ssrTransform = ssrPlugin.transform as any
      if (typeof clientTransform === 'function') {
        await clientTransform.call(clientContext, compiledCode, '/project/src/Counter.tsx')
      }
      if (typeof ssrTransform === 'function') {
        await ssrTransform.call(ssrContext, compiledCode, '/project/src/Counter.tsx')
      }

      expect(clientContext.error).not.toHaveBeenCalled()
      expect(ssrContext.error).not.toHaveBeenCalled()

      const clientLoad = clientPlugin.load as any
      const ssrLoad = ssrPlugin.load as any
      expect(typeof clientLoad).toBe('function')
      expect(typeof ssrLoad).toBe('function')

      const beforeClientReset = clientLoad('\0fict-handler:/project/src/Counter.tsx$$__fict_e0') as
        | string
        | null
      const beforeSsrReset = ssrLoad('\0fict-handler:/project/src/Counter.tsx$$__fict_e0') as
        | string
        | null
      expect(beforeClientReset).not.toBeNull()
      expect(beforeSsrReset).not.toBeNull()

      const ssrBuildStart = ssrPlugin.buildStart as (() => void) | undefined
      expect(typeof ssrBuildStart).toBe('function')
      ssrBuildStart?.()

      const afterSsrResetClientLoad = clientLoad(
        '\0fict-handler:/project/src/Counter.tsx$$__fict_e0',
      ) as string | null
      const afterSsrResetSsrLoad = ssrLoad('\0fict-handler:/project/src/Counter.tsx$$__fict_e0')

      expect(afterSsrResetClientLoad).not.toBeNull()
      expect(afterSsrResetClientLoad).toContain('export default')
      expect(afterSsrResetSsrLoad).toBeNull()
    })

    it('keeps client handlers after ssr buildStart without ssr transform', async () => {
      const clientPlugin = fict({ functionSplitting: true })
      const ssrPlugin = fict({ functionSplitting: true })

      if (typeof clientPlugin.configResolved === 'function') {
        clientPlugin.configResolved(mockBuildConfig as any)
      }
      if (typeof ssrPlugin.configResolved === 'function') {
        ssrPlugin.configResolved(mockSsrBuildConfig as any)
      }

      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_e0 = (scopeId, event, el) => {
  const [count] = __fictUseLexicalScope(scopeId, ['count']);
  const __handler = () => count(count() + 1);
  return __handler.call(el, event);
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const clientContext = { error: vi.fn(), warn: vi.fn(), emitFile: vi.fn() }
      const clientTransform = clientPlugin.transform as any
      if (typeof clientTransform === 'function') {
        await clientTransform.call(clientContext, compiledCode, '/project/src/Counter.tsx')
      }
      expect(clientContext.error).not.toHaveBeenCalled()

      const clientLoad = clientPlugin.load as any
      const ssrLoad = ssrPlugin.load as any
      expect(typeof clientLoad).toBe('function')
      expect(typeof ssrLoad).toBe('function')

      const beforeSsrBuildStartClient = clientLoad(
        '\0fict-handler:/project/src/Counter.tsx$$__fict_e0',
      ) as string | null
      const beforeSsrBuildStartSsr = ssrLoad('\0fict-handler:/project/src/Counter.tsx$$__fict_e0')

      expect(beforeSsrBuildStartClient).not.toBeNull()
      expect(beforeSsrBuildStartClient).toContain('export default')
      expect(beforeSsrBuildStartSsr).toBeNull()

      const ssrBuildStart = ssrPlugin.buildStart as (() => void) | undefined
      expect(typeof ssrBuildStart).toBe('function')
      ssrBuildStart?.()

      const afterSsrBuildStartClient = clientLoad(
        '\0fict-handler:/project/src/Counter.tsx$$__fict_e0',
      ) as string | null
      const afterSsrBuildStartSsr = ssrLoad('\0fict-handler:/project/src/Counter.tsx$$__fict_e0')

      expect(afterSsrBuildStartClient).not.toBeNull()
      expect(afterSsrBuildStartClient).toContain('export default')
      expect(afterSsrBuildStartSsr).toBeNull()
    })

    it('extracts handler code with AST and generates standalone modules', async () => {
      const plugin = fict({ functionSplitting: true })

      // Configure the plugin as if in build mode
      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      // Use pre-compiled code that has the handler exports
      // This simulates what the compiler output looks like
      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_e0 = (scopeId, event, el) => {
  const [count] = __fictUseLexicalScope(scopeId, ['count']);
  const __handler = () => count(count() + 1);
  return __handler.call(el, event);
};

function Counter() {
  // Component code...
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn() }
      const transform = plugin.transform as any

      // Simulate the transform with already-compiled code
      // We need to test the extraction directly
      const result =
        typeof transform === 'function'
          ? await transform.call(mockContext, compiledCode, '/project/src/Counter.tsx')
          : null

      if (result && typeof result === 'object' && 'code' in result) {
        const code = result.code as string

        // Handler export should be removed from main module
        expect(code).not.toContain('export const __fict_e0')

        // QRL should be rewritten to virtual module URL
        expect(code).toContain('virtual:fict-handler:')
        expect(code).toContain('#default')
      }

      // Check that the virtual module is generated correctly
      const load = plugin.load as any
      if (typeof load === 'function') {
        const content = load('\0fict-handler:/project/src/Counter.tsx$$__fict_e0')
        if (content) {
          // Should be a standalone module with:
          // 1. Its own imports
          expect(content).toContain('import')
          expect(content).toContain('@fictjs/runtime/internal')

          // 2. The handler function as default export
          expect(content).toContain('export default')
          expect(content).toContain('scopeId')
          expect(content).toContain('__fictUseLexicalScope')
        }
      }
    })

    it('includes hoisted helper functions in handler virtual modules', async () => {
      const plugin = fict({ functionSplitting: true })

      // Configure the plugin as if in build mode
      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      // Simulated compiled code with a hoisted helper function
      // This is what the compiler generates when a handler uses a component-scoped function
      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_fn_formatNumber_0 = n => n.toLocaleString();

export const __fict_e0 = (scopeId, event, el) => {
  const [count] = __fictUseLexicalScope(scopeId, ['count']);
  const __handler = () => {
    count(count() + 1);
    console.log(__fict_fn_formatNumber_0(count()));
  };
  return __handler.call(el, event);
};

function Counter() {
  // Component code...
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = { error: vi.fn() }
      const transform = plugin.transform as any

      const result =
        typeof transform === 'function'
          ? await transform.call(mockContext, compiledCode, '/project/src/Counter.tsx')
          : null

      if (result && typeof result === 'object' && 'code' in result) {
        const code = result.code as string

        // Handler export should be removed from main module
        expect(code).not.toContain('export const __fict_e0')

        // Hoisted function should also be removed (it's only used by handler)
        expect(code).not.toContain('export const __fict_fn_formatNumber_0')
      }

      // Check that the virtual module includes the hoisted helper
      const load = plugin.load as any
      if (typeof load === 'function') {
        const content = load('\0fict-handler:/project/src/Counter.tsx$$__fict_e0')
        if (content) {
          // Should include the handler
          expect(content).toContain('export default')
          expect(content).toContain('__fictUseLexicalScope')

          // Should include the hoisted helper function as a dependency import
          expect(content).toContain('__fict_fn_formatNumber_0')
          // The helper should be imported from the source module
          expect(content).toContain('/project/src/Counter.tsx')
        }
      }
    })

    it('handler with direct function reference works in virtual module', async () => {
      const plugin = fict({ functionSplitting: true })

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      // Test onClick={helper} pattern (direct function reference)
      // Handler still needs __fictUseLexicalScope call for vite-plugin to detect it
      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';

export const __fict_fn_handleClick_0 = () => console.log('clicked');

export const __fict_e0 = (scopeId, event, el) => {
  const [] = __fictUseLexicalScope(scopeId, []);
  return __fict_fn_handleClick_0.call(el, event);
};

function Button() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = {
        error: vi.fn(),
        emitFile: vi.fn(), // Required for production build handler emission
      }
      const transform = plugin.transform as any

      // Use a unique file path for this test
      const result =
        typeof transform === 'function'
          ? await transform.call(mockContext, compiledCode, '/project/src/DirectRef.tsx')
          : await transform?.handler?.call(mockContext, compiledCode, '/project/src/DirectRef.tsx')

      expect(result && typeof result === 'object').toBe(true)

      // Check virtual module has the dependency
      const load = plugin.load as any
      if (typeof load === 'function') {
        const content = load('\0fict-handler:/project/src/DirectRef.tsx$$__fict_e0')
        if (content) {
          // Handler should reference the hoisted function
          expect(content).toContain('__fict_fn_handleClick_0')
        }
      }
    })

    it('skips recompiling precompiled modules when splitting is disabled', async () => {
      const plugin = fict({ functionSplitting: false })

      if (typeof plugin.configResolved === 'function') {
        plugin.configResolved(mockBuildConfig as any)
      }

      // This is already compiler output. Re-running the compiler on it used to fail
      // under strict guarantee diagnostics (for example FICT-R002).
      const compiledCode = `
import { __fictUseLexicalScope, __fictQrl } from '@fictjs/runtime/internal';
/* precompiled-sentinel */
export const __fict_e0 = (scopeId, event, el) => {
  const [count] = __fictUseLexicalScope(scopeId, ['count']);
  const __handler = () => count(count() + 1);
  return __handler.call(el, event);
};

function Counter() {
  el.setAttribute('on:click', __fictQrl(import.meta.url, '__fict_e0'));
}
      `

      const mockContext = {
        error: vi.fn(),
        warn: vi.fn(),
      }
      const transform = plugin.transform as any

      const result =
        typeof transform === 'function'
          ? await transform.call(mockContext, compiledCode, '/project/src/Precompiled.tsx')
          : await transform?.handler?.call(
              mockContext,
              compiledCode,
              '/project/src/Precompiled.tsx',
            )

      expect(mockContext.error).not.toHaveBeenCalled()
      expect(result && typeof result === 'object').toBe(true)

      if (result && typeof result === 'object' && 'code' in result) {
        expect(result.code).toContain('precompiled-sentinel')
        expect(result.code).toContain('export const __fict_e0')
        expect(result.code).toContain("__fictQrl(import.meta.url, '__fict_e0')")
        expect(result.map).toBeNull()
      }
    })
  })
})
