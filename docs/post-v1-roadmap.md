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

## DevTools Signal And Branch Graph

Goal: let developers inspect how signals, memos, effects, components, and conditional/list branches relate at runtime.

Acceptance criteria:

- Extend the DevTools protocol with branch nodes, owner/root IDs, dependency edges, and lifecycle state without breaking the current protocol version negotiation.
- Show signal-to-consumer edges and branch ownership in the panel graph view with filtering for component, signal, memo, effect, branch, and root nodes.
- Link graph nodes to timeline events so a signal update can be traced to affected branches and DOM work.
- Add runtime/devtools tests for missing-node tolerance, protocol compatibility, branch disposal, and graph updates after conditional flips.
- Keep graph collection dev-only and prove production bundles do not include the collector.

Risk notes:

- The protocol should remain append-only within a minor line; incompatible graph payloads require a protocol version bump.
- Large apps need graph virtualization or filtering before enabling all edges by default.

## Compiler Explain Visualization

Goal: turn compiler explain output into an inspectable visual artifact for reactive regions, dependencies, generated handlers, and diagnostics.

Acceptance criteria:

- Emit a stable JSON explain schema that includes source spans, region IDs, dependency keys, generated handler IDs, warnings, and optimization decisions.
- Add a renderer for the schema in the playground or docs site that overlays source code with region/dependency highlights.
- Support a CLI path that writes the explain JSON and an HTML artifact for offline debugging.
- Add snapshot tests for the JSON schema and browser smoke tests for the visual artifact.
- Document how to attach explain artifacts to compiler bug reports.

Risk notes:

- The schema should be versioned separately from human-readable debug text.
- Visualization must not become part of the production transform path or affect sourcemaps.
