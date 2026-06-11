---
'@fictjs/compiler': minor
'@fictjs/runtime': minor
'fict': minor
---

Harden compiler and runtime semantics after the release verification gate.

- Compiler cache fingerprints now reflect the current compiler source artifacts
  more reliably, including source-mode and unreadable-artifact cases.
- Control-flow story blocks keep supported `try`/`catch` regions reactive, and
  loop bodies that fall back to static lowering now produce diagnostics instead
  of silently losing reactivity.
- Runtime scheduling now keeps pending flush queues intact when effects or
  cleanup callbacks throw, rethrows cached memo errors instead of serving stale
  values, and re-runs effects that write their own dependencies.
- Stores now support Map/Set-like collections and internal-slot objects with
  coarse-grained notifications, while keyed-list duplicate cleanup and
  array-shaped `resetKeys` comparison preserve observable behavior more
  predictably.
- `resource` now uses structural cache keys, bounds its default cache with
  `maxEntries: 256`, and reuses in-flight fetches for equivalent keys.
