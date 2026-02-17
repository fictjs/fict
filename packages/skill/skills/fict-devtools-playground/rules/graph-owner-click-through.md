---
title: Keep Graph Owner Links Clickable and Navigable
impact: HIGH
impactDescription: improves root-cause tracing from graph context
tags: devtools, graph, owner, navigation
---

## Keep Graph Owner Links Clickable and Navigable

Owner references in graph details should be interactive and route to the owning
component context.

**Incorrect (owner rendered as plain text):**

```tsx
<div>Owner: {ownerName}</div>
```

**Correct (owner rendered as action link):**

```tsx
<button onClick={() => jumpToOwner(ownerId)}>Owner: {ownerName}</button>
```

Reference: [examples/counter-basic](https://github.com/fictjs/fict/blob/main/examples/counter-basic/)
