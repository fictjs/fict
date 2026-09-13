# Implicit memo inlining

The compiler can remove an implicit memo when one intrinsic JSX text consumer
reads a total scalar expression over local component state:

```tsx
import { $state } from 'fict'

function Counter() {
  let count = $state(0)
  const doubled = count * 2
  return (
    <div>
      <button onClick={() => count++}>Increment</button>
      <span>{doubled}</span>
    </div>
  )
}
```

With optimization enabled, `doubled` needs no memo allocation: the text binding
reads `count` and computes `count * 2`. Direct DOM and VNode output apply the same
rule. Direct DOM's namespace fallback duplicates generated code, so the compiler
counts consumers in the authored source before generating those alternatives.
Binding identity and the original name distinguish an accessor from a runtime
helper that happens to reuse its source span.

The proof requires the state to initialize before the derived declaration in the
same component. Every state write must preserve number, boolean or nullish values.
Unsupported writes invalidate dependent proofs through a worklist. TypeScript
assertions do not provide a runtime value proof. An expression may produce a
bounded string, such as `` `Count: ${count}` ``, while mutable string state remains
conservative because repeated concatenation can grow until JavaScript throws.

| Case                                                            | Decision                                                                     |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `count * 2` read once as intrinsic JSX text                     | Inline when the state/write proof succeeds                                   |
| One read inside an intrinsic JSX conditional branch             | Inline under the same proof; preserve conditional DOM identity and ownership |
| Multiple authored reads                                         | Keep the memo                                                                |
| Component props, children or a captured callback                | Keep the materialization boundary                                            |
| Arbitrary calls, object/property reads, BigInt/Symbol coercions | Keep the materialization boundary                                            |
| Inputs from another owner, hooks, async nodes or unknown writes | Keep the materialization boundary                                            |
| Explicit `$memo`                                                | Keep the requested memo                                                      |

The existing straight-line inliner remains a separate, narrower placement rule.
`optimize: false` disables both optimizations. `inlineDerivedMemos: false` retains
user-named implicit memos; the existing `__*` temporary policy remains compatible.
Preview output does not use the JSX rule.

Removing a memo can change the number of dependency reads. The rule therefore
requires computations whose repetition cannot invoke user code, allocate an
observable object, or cross an unproved error/lifetime boundary. The consumer's
DOM identity and equality behavior still need execution checks. Fewer allocations
alone do not establish a CPU improvement in an application benchmark.

Validation commands:

```sh
pnpm test:compiler:native-runtime
pnpm test:compiler:jsx-memo:browser
```

The native suite exercises disabled/safe/full optimization with both DOM backends,
retained controls, object coercions, SSR errors and disposal. The browser gate
bundles distributed production modules and checks updates, equal values, DOM
identity, hide/remount, disposal and HTML/SVG namespace alternatives. The SVG
fallback checks DOM semantics rather than the visual layout of HTML-named tags in
an SVG namespace. Its source, output and bundle identities are written to
`test-results/jsx-memo-inline-browser.json`.
