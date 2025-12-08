# Framework-Level Cycle Protection Plan

This document describes how to add a framework-level cycle protection layer on top of the existing signal runtime (which already uses `Recursed` / `RecursedCheck` flags to prevent re-entrancy within a node).

## Goals

- Stop infinite self-activation across effects/computed/roots and across microtasks.
- Keep legitimate heavy updates working without false positives.
- Make issues observable (errors/warnings + devtools hook).
- Require no user configuration, but allow overrides.

## Guardrails and Defaults

| Guard                                    | Default                                                                            | Behavior                                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Flush budget per microtask               | `MAX_FLUSH_CYCLES_PER_MICROTASK = 10_000`                                          | Currently warn-only (no stop) unless devMode is enabled.                                                                     |
| Effect runs per flush                    | `MAX_EFFECT_RUNS_PER_FLUSH = 20_000`                                               | Currently warn-only (no stop) unless devMode is enabled.                                                                     |
| Cross-microtask early warning (optional) | Window `WINDOW = 5`, high usage `HIGH_USAGE_RATIO = 0.8`                           | If 5 consecutive microtasks each consume ≥80% of the flush budget, emit a warning (no stop). Can be disabled for minimalism. |
| Root re-entrant depth (sync stack)       | `MAX_ROOT_REENTRANT_DEPTH = 10`                                                    | Dev: warn/throw and short-circuit; Prod: log once and short-circuit that invocation. Helps catch sync render self-calls.     |
| Dev vs Prod                              | Dev: hard stop on budget breach; Prod: stop the offending flush but only log once. |

Rationale: Defaults are warn-only to avoid behavior changes; enable devMode or tighten budgets via `setCycleProtectionOptions` when debugging cycles. Higher defaults avoid false positives in heavy but valid bursts. A 5-microtask window catches oscillations without impacting bursts. Depth 10 is well above normal usage.

## Integration Points

1. **Cycle guard module** (`packages/runtime/src/cycle-guard.ts` or similar)
   - Expose `beginFlush()`, `recordEffectRun()`, `endFlush(effectRunCount)`, `recordFlushWindowUsage(usedBudget, maxBudget)`, and state for window counts.
   - Handle thresholds, logging/throwing, and devtools event emission (`cycleDetected`).

2. **Signal flush hookup** (`packages/runtime/src/signal.ts`)
   - Wrap the existing `flush()` with calls to cycle-guard:
     - `beginFlush()` before processing queue.
     - Increment effect-run counter per effect execution.
     - On exit, call `endFlush(runCount)`; if it signals “stop,” abort further processing.
   - When scheduling microtask (`scheduleFlush`), register to the window tracker.

3. **Root re-entry guard** (`createRoot` / `render`)
   - Track `rootRunDepth` per root (sync call stack). If depth > `MAX_ROOT_REENTRANT_DEPTH`, warn/throw (Dev) or log (Prod) and short-circuit.

4. **Devtools hook** (`devtools.ts`)
   - Add optional `cycleDetected(info)` hook. Include effect/computed identity if available, flush counts, and root id if applicable.

## Developer/Prod UX

- Dev default: throw on budget breach to surface bugs; warning for window saturation and root depth, with context in the message.
- Prod default: single log + stop the runaway flush; no repeated spam.
- Allow overrides (env or `setCycleProtection({ ... })`), but sensible defaults must work out of the box.

## Tests to Add

- **Infinite self-activation** (RecursedCheck manually cleared): should hit flush budget and stop with error (Dev).
- **Oscillating microtasks** (alternate writes across microtasks): should raise window warning (if enabled).
- **Root re-entry**: sync self-call beyond depth triggers warning/stop.
- **Normal heavy updates**: large list updates stay below thresholds and do not warn.
