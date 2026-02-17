---
title: Key Async Resources and Place Suspense at Ownership Boundaries
impact: HIGH
impactDescription: avoids duplicate fetches and unstable suspend behavior
tags: ssr, suspense, resource, async
---

## Key Async Resources and Place Suspense at Ownership Boundaries

When using `resource` with route or prop parameters, provide a stable `key` and
wrap the owning UI region in `Suspense`. This keeps caching/retry behavior
predictable across SSR and client resume.

**Incorrect (unkeyed resource with unstable ownership):**

```tsx
import { resource } from 'fict/plus'

function UserCard({ userId }: { userId: string }) {
  const user = resource({
    suspense: true,
    fetch: async () => fetch(`/api/users/${userId}`).then(r => r.json()),
  })

  return <div>{user.read().name}</div>
}
```

**Correct (explicit key and boundary):**

```tsx
import { Suspense } from 'fict'
import { resource } from 'fict/plus'

function UserCard({ userId }: { userId: string }) {
  const user = resource({
    key: [userId],
    suspense: true,
    fetch: async ({ signal }) => fetch(`/api/users/${userId}`, { signal }).then(r => r.json()),
  })

  return (
    <Suspense fallback={<div>Loading user...</div>}>
      <div>{user.read().name}</div>
    </Suspense>
  )
}
```

Reference: [Architecture - Suspense and Async Boundaries](https://github.com/fictjs/fict/blob/main/docs/architecture.md)
