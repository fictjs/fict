---
'@fictjs/router': patch
---

Fix router matching, navigation, data loading, and teardown behavior without
changing the public API.

Nested route branches now select the correct match, regular-expression filters
remain stable across calls, and malformed encoded parameters fail safely.
Programmatic navigation preserves route options, route actions receive params,
case-sensitive NavLink matching is respected, and external links remain under
browser control.

Query caches are isolated per SSR request, cache `undefined` results correctly,
deduplicate refreshes, contain synchronous failures, and avoid browser cleanup
timers during SSR. History pop transitions, form submission failures,
before-leave handlers, and owned history listeners now settle and dispose
reliably. Published router output also no longer relies on an undeclared
optional `fict` runtime import.
