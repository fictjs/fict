# Post-v1 Roadmap

This file tracks the P2 items that are intentionally out of scope for the v1.0 RC hardening gate. Each item needs its own implementation plan, tests, and release note before it can move into a stable release milestone.

## State-Preserving HMR

Goal: update Fict-transformed modules during development without forcing a full reload when the compiler can prove the reactive graph shape is compatible.

Acceptance criteria:

- Preserve component-local `$state` values across edits that only change render text, attributes, styles, or event handler bodies.
- Force a full reload when scope slot order, branch topology, component boundaries, or serialized resume metadata changes.
- Add compiler metadata that fingerprints the state slot layout and branch graph for HMR compatibility checks.
- Add Vite plugin tests for compatible edits, incompatible edits, and cache invalidation after `tsconfig` or compiler option changes.
- Add a browser-level dev fixture proving state survives a compatible edit and resets on an incompatible edit.

Risk notes:

- Incorrect compatibility detection is worse than a full reload because it can bind old state slots to new meanings.
- The first implementation should prefer explicit fallback-to-reload paths over partial patching when metadata is missing.
