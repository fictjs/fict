# Fict Resumable Release Console

Production-shaped release operations application with regional capacity controls,
a change-request form, and a filtered deployment queue. The server renders the
application with explicitly enabled serialized state snapshots, while
`installResumableLoader` from `fict/experimental/loader` provides Preview lazy
event handling without eagerly re-running the component tree. This example is a
Preview compatibility fixture, not evidence that resumability is part of the
Core 1.0 promise.

The real-application Playwright suite verifies both the server HTML and resumed
browser interactions from production output.

## Run

```bash
pnpm -C examples/ssr-basic dev
pnpm -C examples/ssr-basic build
pnpm -C examples/ssr-basic preview
```
