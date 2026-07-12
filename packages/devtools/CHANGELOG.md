# @fictjs/devtools

## 0.0.4 (browser extension)

> This is the internal browser-extension distribution version. The npm package
> remains Changesets-ignored at 0.3.0.

### Patch Changes

- Authenticate `postMessage` peers before accepting extension traffic, contain
  RPC handler failures, and stop reconnecting transports after destruction.
- Contain static-asset requests and keep browser auto-opening optional for the
  Vite integration.
- Isolate the optional Vite entrypoint's types so consumers of the core package
  do not require Vite declarations.
- Upgrade the Vite development dependency to a patched release.
