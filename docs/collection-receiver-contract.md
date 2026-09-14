# Collection receiver proof contract

These normative examples specify the caller-owned TypeScript receiver contract
in [compiler spec §15.5](./compiler-spec.md#155-ambiguity-resolution) and the
[guarantee matrix](./reactivity-guarantee-matrix.md). The native compiler test
reads these exact snippets under disabled, safe and full optimization with both
DOM and VNode output. `guaranteed` means no diagnostics; the other labels name a
required strict build error and compilation must emit no code.

A direct `T[]`, tuple, or unshadowed built-in family annotation proves that
binding's receiver family. It does not add runtime validation, prove arbitrary
nested properties, permit deep mutation, or establish purity for custom methods.
Immutable aliases retain the established family. The `any` inputs below represent
external values whose family the caller must validate or otherwise ensure.

## Type argument

<!-- receiver-proof: type-argument guaranteed -->

```tsx
import { $state } from 'fict'

declare const value: any
export function Example() {
  let rows = $state<number[]>(value)
  return <p>{rows.map(x => x + 1).join(',')}</p>
}
```

## Binding annotation

<!-- receiver-proof: binding-annotation guaranteed -->

```tsx
import { $state } from 'fict'

declare const value: any
export function Example() {
  let rows: number[] = $state(value)
  return <p>{rows.map(x => x + 1).join(',')}</p>
}
```

## Parameter annotation

<!-- receiver-proof: parameter-annotation guaranteed -->

```tsx
import { $state } from 'fict'

export function Example(rows: number[]) {
  let count = $state(0)
  return <p>{rows.map(x => x + count).join(',')}</p>
}
```

## Rhs assertion

<!-- receiver-proof: rhs-assertion FICT-M -->

```tsx
import { $state } from 'fict'

declare const value: any
export function Example() {
  let rows = $state(value as number[])
  return <p>{rows.map(x => x + 1).join(',')}</p>
}
```

## Type alias

<!-- receiver-proof: type-alias FICT-M -->

```tsx
import { $state } from 'fict'

declare const value: any
type Rows = number[]
export function Example() {
  let rows = $state<Rows>(value)
  return <p>{rows.map(x => x + 1).join(',')}</p>
}
```

## Shadowed builtin

<!-- receiver-proof: shadowed-builtin FICT-M -->

```tsx
import { $state } from 'fict'

declare const value: any
type Array<T> = { map: (fn: (x: T) => T) => T[] }
export function Example() {
  let rows = $state<Array<number>>(value)
  return <p>{rows.map(x => x + 1).join(',')}</p>
}
```

## Parameter through state

The parameter proof applies to `seed` itself. Add a direct `$state<number[]>`
or binding annotation to establish the new state receiver contract.

<!-- receiver-proof: parameter-through-state FICT-M -->

```tsx
import { $state } from 'fict'

export function Example(seed: number[]) {
  let rows = $state(seed)
  return <p>{rows.map(x => x + 1).join(',')}</p>
}
```

## Unknown parameter

An unknown `.map` method cannot certify that a callback capturing state runs
synchronously; `FICT-R005` may accompany `FICT-R002`.

<!-- receiver-proof: unknown-parameter FICT-R002 -->

```tsx
import { $state } from 'fict'

export function Example(rows: any) {
  let count = $state(0)
  return <p>{rows.map(x => x + count).join(',')}</p>
}
```
