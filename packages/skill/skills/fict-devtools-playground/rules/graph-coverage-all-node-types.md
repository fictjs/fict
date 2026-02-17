---
title: Render Dependency Graphs for Signal, Computed, and Effect Nodes
impact: HIGH
impactDescription: prevents partial observability and false-negative diagnosis
tags: devtools, graph, signals, computed, effects
---

## Render Dependency Graphs for Signal, Computed, and Effect Nodes

Graph rendering must work for all inspectable node types, not just signals.
Missing computed/effect graph support hides critical dependency chains.

**Incorrect (graph only handles signal nodes):**

```ts
if (node.kind === 'signal') {
  renderSignalGraph(node)
}
```

**Correct (type-normalized graph query):**

```ts
switch (node.kind) {
  case 'signal':
  case 'computed':
  case 'effect':
    renderDependencyGraph(node.id)
    break
}
```

Reference: [Fict architecture](https://github.com/fictjs/fict/blob/main/docs/architecture.md)
