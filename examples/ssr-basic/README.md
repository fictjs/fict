# Fict Resumable Release Console

Production-shaped release operations application with regional capacity controls,
a change-request form, and a filtered deployment queue. The server renders the
application with serialized state snapshots, while `installResumableLoader`
provides Preview lazy event handling without eagerly re-running the component tree.

The real-application Playwright suite verifies both the server HTML and resumed
browser interactions from production output.

## Run

```bash
pnpm -C examples/ssr-basic dev
pnpm -C examples/ssr-basic build
pnpm -C examples/ssr-basic preview
```
