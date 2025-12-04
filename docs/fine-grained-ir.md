# Fine-Grained Template IR

**Status:** Draft IR for compiler codegen overhaul  
**Last updated:** 2025-12-04T19:35:00Z

## 1. IR overview

The compiler will translate JSX templates into a deterministic Intermediate Representation composed of three node types:

| IR node           | Purpose                                        | Key fields                                                    |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| `ElementNode`     | Represents intrinsic DOM elements.             | `tag`, `staticAttrs`, `dynamicAttrs[]`, `children[]`, `refId` |
| `FragmentNode`    | Represents flattened fragments/array literals. | `children[]`, `markerId`                                      |
| `ControlFlowNode` | Encodes conditionals/lists.                    | `kind: 'conditional'                                          | 'list'`, `predicate`, `truthy`, `falsy`, `keyExpr` |

Each node carries a deterministic `id` used to derive variable names (`el0`, `txt2`, `marker1`). Dynamic bindings are recorded as patch instructions attached to the node.

### 1.1 Attribute patch records

```
interface TextPatch { kind: 'text'; targetRef: string; expr: Expression }
interface AttributePatch { kind: 'attr'; targetRef: string; name: string; expr: Expression }
interface StylePatch { kind: 'style'; targetRef: string; expr: Expression }
interface ClassPatch { kind: 'class'; targetRef: string; expr: Expression }
interface PropertyPatch { kind: 'prop'; targetRef: string; name: string; expr: Expression }
```

### 1.2 Child insertion records

```
interface ChildInsertion {
  anchorRef: string // comment marker
  expr: Expression // dynamic child slot
}
```

## 2. Anchor allocation strategy

1. Traverse the JSX tree depth-first.
2. Assign numeric IDs per node type (element/text/marker).
3. For every dynamic child array (e.g., slot), emit `markerStart`/`markerEnd` comments and register them in the IR so codegen can call `insert` with the proper anchors.
4. For keyed lists, IR stores `keyExpr` and the block template (an array of patch records) so the code generator can produce the specialized updater.

## 3. Codegen pipeline changes

1. **Parse to IR** – existing compiler outputs intermediate structures; replace with the new IR builder.
2. **Emit static DOM** – iterate IR nodes emitting `const el0 = document.createElement('tag')` statements following depth-first order.
3. **Emit bindings** – for each patch record, emit the corresponding helper call (e.g., `bindText(txt1, () => expr)`).
4. **Emit control flow wrappers** –
   - Conditionals: generate closures `function branchTrue() { ... }` referencing pre-built DOM nodes.
   - Lists: generate `function mountBlock(ctx)` and `function updateList(nextItems)` using `moveMarkerBlock`, `destroyMarkerBlock`, `createVersionedSignal`.
5. **Finalize component render** – return the root node reference (single node or a fragment DocumentFragment).

## 4. Next steps

- Implement IR builder in `compiler-ts` (Phase 2 first bullet).
- Add unit tests to compiler verifying IR output for the codegen examples defined earlier.
- Hook runtime helpers once codegen path is ready.
