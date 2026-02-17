---
title: Align Standalone and Extension Handshake Contracts
impact: CRITICAL
impactDescription: prevents dead panels and missing runtime data
tags: devtools, bridge, handshake, transport
---

## Align Standalone and Extension Handshake Contracts

The devtools panel should use the same message contract in standalone and
extension modes. A contract mismatch causes silent "connected but no data"
states.

**Incorrect (mode-specific payload mismatch):**

```ts
// standalone panel
postMessage({ type: 'connect', payload: { tab: tabId } })

// extension bridge expects
// { type: 'connect', payload: { targetId } }
```

**Correct (single shared message schema):**

```ts
export interface DevtoolsConnectPayload {
  targetId?: number
  standalone: boolean
}

postMessage({
  type: 'connect',
  payload: {
    targetId: tabId,
    standalone: true,
  } satisfies DevtoolsConnectPayload,
})
```

Reference: [@fictjs/devtools README](https://github.com/fictjs/fict/blob/main/packages/devtools/README.md)
