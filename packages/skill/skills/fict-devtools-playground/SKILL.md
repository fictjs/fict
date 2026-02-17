---
name: fict-devtools-playground
description: Fict DevTools and Playground engineering guide. Use when implementing, debugging, or reviewing Fict devtools panel/extension behavior, signal/computed/effect inspection UX, graph/timeline interactions, or playground preview refresh and isolation from production runtime.
---

# Fict DevTools and Playground Engineering

Guidance for shipping robust devtools and playground features without regressing
Fict runtime correctness or production performance.

## Rule Categories by Priority

| Priority | Category                         | Impact   | Prefix       |
| -------- | -------------------------------- | -------- | ------------ |
| 1        | Bridge and Transport Correctness | CRITICAL | `bridge-`    |
| 2        | Inspector Data Semantics         | HIGH     | `inspector-` |
| 3        | Graph and Timeline UX            | HIGH     | `graph-`     |
| 4        | Playground Preview Runtime       | HIGH     | `preview-`   |
| 5        | Verification and Shipping Gates  | CRITICAL | `quality-`   |

## Quick Reference

### 1. Bridge and Transport Correctness (CRITICAL)

- `bridge-standalone-handshake` - Keep standalone and extension handshake contract aligned
- `bridge-dev-only-gating` - Ensure debug bridge is development-only

### 2. Inspector Data Semantics (HIGH)

- `inspector-stable-owner-labeling` - Prefer semantic names over generated ids when possible
- `inspector-owner-navigation` - Owner links should navigate and expand ancestor chain

### 3. Graph and Timeline UX (HIGH)

- `graph-coverage-all-node-types` - Render graph for signals, computed, and effects
- `graph-owner-click-through` - Make graph owner/sidebar references navigable
- `graph-timeline-click-through` - Timeline nodes should support context jump

### 4. Playground Preview Runtime (HIGH)

- `preview-refresh-fidelity` - Preserve HMR and full refresh behavior for changed source
- `preview-runtime-isolation` - Keep playground internals out of runtime production path

### 5. Verification and Shipping Gates (CRITICAL)

- `quality-counter-basic-e2e` - Validate on `examples/counter-basic` for real interaction paths
- `quality-standalone-extension-parity` - Keep standalone and extension behavior parity

## How to Use

Read rules in `rules/` for implementation and debugging details.
Use `AGENTS.md` for a compiled one-file reference.

## Full Compiled Document

`AGENTS.md`
