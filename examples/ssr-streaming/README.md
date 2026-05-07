# Fict SSR Streaming Example

Node SSR streaming example using `renderToPipeableStream` in shell mode. The server sends the
initial shell first, then patches deferred Suspense boundaries as their data resolves.

## Run

```bash
pnpm -C examples/ssr-streaming dev
pnpm -C examples/ssr-streaming build
pnpm -C examples/ssr-streaming preview
```
