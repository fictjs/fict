---
'@fictjs/runtime': minor
'fict': minor
'@fictjs/compiler': patch
---

Add public eager `hydrate` support for async graph SSR, preserving owned server
DOM through Suspense, ErrorBoundary, refresh and independently minified clients.
Claim and repair server ranges, keep fragment nodes connected, isolate hydration
options by root, and reject strict mismatches and unsupported Preview async slots.

Defer transparent component-prop reads in VNode output and template namespace
fallbacks using the compiler's binding identities. This preserves pending async
consumers and future updates across component boundaries. Applications must finish
stream patches before hydration and pass explicit, matching initial data.
