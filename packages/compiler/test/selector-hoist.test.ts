import { describe, it, expect } from 'vitest'
import { transform } from './test-utils'

describe('P1: Selector Hoist Optimization', () => {
  it('should hoist selector for class binding with __key === selected() pattern', () => {
    const source = `
      import { $state, render } from "fict";

      function App() {
        let data = $state([]);
        let selected = $state(null);

        return (
          <table>
            <tbody>
              {data.map((row) => (
                <tr key={row.id} class={row.id === selected ? "danger" : ""}>
                  <td>{row.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      }
    `
    const output = transform(source)

    // Should have createSelector hoisted
    expect(output).toContain('createSelector')

    // The selector should be created with the signal accessor
    expect(output).toMatch(/const __sel_\d+ = createSelector\(\(\) => selected\(\)\)/)

    // bindClass should use the selector instead of direct comparison
    expect(output).toMatch(/bindClass\([^,]+,\s*\(\)\s*=>\s*__sel_\d+\(__key\)/)

    // Should NOT have the original pattern
    expect(output).not.toMatch(/bindClass\([^,]+,\s*\(\)\s*=>\s*__key\s*===\s*selected\(\)/)
  })

  it('should hoist selector for selected() === __key pattern (reversed)', () => {
    const source = `
      import { $state, render } from "fict";

      function App() {
        let data = $state([]);
        let selected = $state(null);

        return (
          <ul>
            {data.map((item) => (
              <li key={item.id} class={selected === item.id ? "active" : ""}>
                {item.name}
              </li>
            ))}
          </ul>
        );
      }
    `
    const output = transform(source)

    // Should have createSelector
    expect(output).toContain('createSelector')

    // bindClass should use the selector
    expect(output).toMatch(/bindClass\([^,]+,\s*\(\)\s*=>\s*__sel_\d+\(__key\)/)
  })

  it('should not hoist selector for non-keyed list', () => {
    const source = `
      import { $state, render } from "fict";

      function App() {
        let data = $state([]);
        let selected = $state(null);

        return (
          <ul>
            {data.map((item) => (
              <li class={item.id === selected ? "active" : ""}>
                {item.name}
              </li>
            ))}
          </ul>
        );
      }
    `
    const output = transform(source)

    // Non-keyed list should NOT use createSelector optimization
    // (selector hoist is specifically for keyed lists)
    expect(output).not.toContain('createSelector')
  })

  it('should handle multiple selectors for different signals in same class', () => {
    const source = `
      import { $state, render } from "fict";

      function App() {
        let data = $state([]);
        let selected = $state(null);
        let hovered = $state(null);

        return (
          <ul>
            {data.map((item) => (
              <li 
                key={item.id} 
                class={(item.id === selected ? "selected " : "") + (item.id === hovered ? "hovered" : "")}
              >
                {item.name}
              </li>
            ))}
          </ul>
        );
      }
    `
    const output = transform(source)

    // Should have createSelector for at least one signal
    expect(output).toContain('createSelector')

    // Check that selector pattern is used
    expect(output).toMatch(/__sel_\d+/)
  })

  it('should hoist selector for benchmark-like pattern', () => {
    const source = `
      import { $state, render } from "fict";

      function BenchmarkTable() {
        let data = $state([]);
        let selected = $state(0);

        return (
          <table class="table table-hover table-striped test-data">
            <tbody>
              {data.map((row) => (
                <tr key={row.id} class={row.id === selected ? "danger" : ""}>
                  <td class="col-md-1">{row.id}</td>
                  <td class="col-md-4">
                    <a onClick={() => selected = row.id}>{row.label}</a>
                  </td>
                  <td class="col-md-1">
                    <a onClick={() => remove(row.id)}>
                      <span class="glyphicon glyphicon-remove" aria-hidden="true"></span>
                    </a>
                  </td>
                  <td class="col-md-6"></td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      }
    `
    const output = transform(source)

    // Should have createSelector for the selection pattern
    expect(output).toContain('createSelector')

    // bindClass should use the selector
    expect(output).toMatch(/bindClass\([^,]+,\s*\(\)\s*=>\s*__sel_\d+\(__key\)/)
  })
})
