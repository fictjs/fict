# Fict Resumable Page Example

SSR page with serialized state snapshots and lazy event handler loading through
`installResumableLoader`. The server renders HTML with resumability metadata, and the client installs
delegated event handling without re-running the full component tree.

## Run

```bash
pnpm -C examples/ssr-basic dev
pnpm -C examples/ssr-basic build
pnpm -C examples/ssr-basic preview
```
