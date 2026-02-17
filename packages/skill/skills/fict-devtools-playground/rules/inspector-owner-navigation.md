---
title: Make Owner Navigation Expand and Focus the Component Tree
impact: HIGH
impactDescription: avoids dead-end navigation in deep component hierarchies
tags: devtools, inspector, navigation, tree
---

## Make Owner Navigation Expand and Focus the Component Tree

Clicking owner/component references from signals/effects/computed views should
navigate to the component page, expand all ancestor nodes, and focus the target.

**Incorrect (navigates but does not expand ancestors):**

```ts
router.push(`/components/${ownerId}`)
```

**Correct (expand path and focus target):**

```ts
router.push(`/components/${ownerId}`)
expandAncestorChain(ownerId)
focusComponentNode(ownerId)
```

Reference: [examples/counter-basic](https://github.com/fictjs/fict/blob/main/examples/counter-basic/)
