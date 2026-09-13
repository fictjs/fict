---
'@fictjs/compiler': patch
---

Keep calls in JSX attributes, children and conditional branches reactive across
direct DOM and VNode output. Component props receive values through lazy prop
getters, preserving callback identity and one-time key evaluation. Authored await
expressions remain in their asynchronous scope.
