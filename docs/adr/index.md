# Architecture Decision Records

- [ADR-0001 — Adopt an OXC-native Rust compiler](0001-adopt-oxc-rust-compiler.md) -
  Replace the Babel compiler with typed Rust passes while keeping authoritative
  bundler state in JavaScript hosts.
- [ADR-0002 — Require the complete native compiler support matrix](0002-native-compiler-support-matrix.md) -
  Make eight OS/architecture/libc packages and Node 22/24 runtime evidence an
  atomic stable-release gate.
- [ADR-0003 — Retire the Babel preset after a bounded compatibility window](0003-retire-babel-preset.md) -
  Keep the preset on the tested legacy backend through one post-switch stable
  minor, then remove it as a coordinated breaking Core change.
