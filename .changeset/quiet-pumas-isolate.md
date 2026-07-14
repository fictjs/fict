---
'@fictjs/vite-plugin': patch
---

Avoid evaluating Babel and the legacy compiler when Vite runs the Rust backend,
including cached TSX and structured Preview handler paths.
