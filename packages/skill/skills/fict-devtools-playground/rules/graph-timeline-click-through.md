---
title: Enable Click-to-Jump from Timeline Nodes
impact: HIGH
impactDescription: enables time-to-cause correlation during reactive debugging
tags: devtools, timeline, navigation, events
---

## Enable Click-to-Jump from Timeline Nodes

Timeline entries should support direct navigation to related signal/computed/
effect/component entities.

**Incorrect (timeline entries are non-interactive):**

```tsx
<li>{event.label}</li>
```

**Correct (timeline entries jump to target context):**

```tsx
<li>
  <button onClick={() => jumpToTimelineTarget(event.target)}>{event.label}</button>
</li>
```

Reference: [examples/counter-basic](https://github.com/fictjs/fict/blob/main/examples/counter-basic/)
