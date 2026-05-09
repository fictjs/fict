# Store API

Fict has one user-facing deep store API: `$store` from `fict`.

`createStore` exists in `@fictjs/runtime/internal` for compiler output,
resumable state restoration, and first-party runtime internals. Application
and library code should not import it.

## Public Model: `$store`

Use `$store` when state is a nested object or array and direct deep mutation is
the intended update style.

```tsx
import { $store } from 'fict'

const session = $store({
  user: { name: 'Ada' },
  flags: { compact: false },
})

session.user.name = 'Grace'
session.flags.compact = true
```

Reads are tracked at the path/property level. Components that read
`session.user.name` do not need to re-run when `session.flags.compact` changes.

## `$state` vs `$store`

| Use case                 | API                     | Update style                   |
| ------------------------ | ----------------------- | ------------------------------ |
| Local primitive state    | `$state`                | `count++`, `count = next`      |
| Local shallow objects    | `$state`                | immutable reassignment         |
| Shared nested objects    | `$store`                | direct property/array mutation |
| Dynamic key maps         | `$store`                | runtime path tracking          |
| Library-level primitives | advanced `createSignal` | explicit getter/setter         |

Do not switch one object back and forth between `$state` immutable updates and
`$store` deep mutation. Pick one ownership model for that object.

## Internal Model: `createStore`

`createStore` returns `[store, setStore]` and includes reconciliation helpers
needed by runtime internals such as resume snapshot restoration. It is exported
only through internal subpaths so generated code can resolve a stable compiler
ABI.

The internal helper is not a second application store API:

- it may change implementation details in minor or patch releases;
- documentation and examples should not teach it to users;
- user code should import `$store` from `fict` instead.

If a library needs a deep reactive object as part of its public API, expose a
`$store` value or accept a user-provided `$store` object instead of re-exporting
`createStore`.
