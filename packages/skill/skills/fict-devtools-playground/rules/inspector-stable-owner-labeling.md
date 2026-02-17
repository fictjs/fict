---
title: Prefer Semantic Names for Computed and Effects
impact: HIGH
impactDescription: improves debugging speed and signal traceability
tags: devtools, inspector, computed, effects
---

## Prefer Semantic Names for Computed and Effects

When compiler/runtime metadata can infer source variable or owner names, expose
those names in devtools instead of only generated ids like `Computed #2`.

**Incorrect (id-only labels):**

```text
Computed #2
Effect #5
```

**Correct (semantic + id labels):**

```text
doubled:Computed #2
Counter:Effect #5
```

Reference: [Fict reactivity semantics](https://github.com/fictjs/fict/blob/main/docs/reactivity-semantics.md)
