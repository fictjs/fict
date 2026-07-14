---
type: adr
title: ADR-0002 — Require the complete native compiler support matrix
description: Release-blocking OS, architecture, libc, Node, installation, and runtime requirements for Fict native compiler packages.
owner: unadlib
status: accepted
risk_level: critical
tags: [compiler, rust, napi, release, platform]
---

# ADR-0002 — Require the complete native compiler support matrix

## Context

The Rust compiler is distributed as a JavaScript facade plus prebuilt N-API
packages. A source-correct compiler is not usable when the package selected for
a consumer's operating system, architecture, or libc is absent, cannot be
installed without Rust, or fails to load on a supported Node version.

Fict currently requires Node `>=22.18.0`. The M0 N-API spike pins Node-API 10
and proves host loading on Node 22 and Node 24, but a host-only probe does not
define the product support matrix. The migration needs a release contract
before native package names, CI jobs, and atomic publish checks become harder
to change.

## Decision

Every stable release that makes the Rust backend available MUST build,
package, install, and execute all of the following targets:

| Native target      | npm platform | Architecture | C runtime | Release blocking |
| ------------------ | ------------ | ------------ | --------- | ---------------- |
| `darwin-x64`       | macOS        | x64          | system    | yes              |
| `darwin-arm64`     | macOS        | arm64        | system    | yes              |
| `linux-x64-gnu`    | Linux        | x64          | glibc     | yes              |
| `linux-arm64-gnu`  | Linux        | arm64        | glibc     | yes              |
| `linux-x64-musl`   | Linux        | x64          | musl      | yes              |
| `linux-arm64-musl` | Linux        | arm64        | musl      | yes              |
| `win32-x64-msvc`   | Windows      | x64          | MSVC      | yes              |
| `win32-arm64-msvc` | Windows      | arm64        | MSVC      | yes              |

Windows ARM64 is intentionally blocking rather than best-effort. Removing it
from a release requires a superseding support-policy decision; a temporarily
unavailable hosted runner is a release-infrastructure problem, not permission
to publish a partial matrix.

Each target MUST pass both Node 22 and Node 24 runtime lanes. Node 22 testing
MUST include the declared floor, `22.18.0`, or the earliest still obtainable
22.x patch no earlier than that floor. The native boundary remains Node-API 10
until a separate compatibility change is accepted; the public request protocol
MUST NOT expose the Node-API version.

For every target and Node lane, CI MUST prove all of the following:

1. the platform tarball contains the expected `.node` binary and package
   metadata;
2. a clean temporary project can install the facade and the selected optional
   package with no Rust toolchain;
3. ESM and CommonJS loaders select the same package and reject incompatible
   binding metadata;
4. the binding loads and executes compiler-info, synchronous compile, and
   asynchronous compile smoke calls;
5. missing, corrupt, wrong-target, or partial packages fail with a structured
   platform error and never select the legacy backend;
6. the release plan contains the facade and all eight platform packages before
   any publish operation begins.

Runtime certification MUST execute on the target architecture and runtime.
Cross-compilation is allowed for producing binaries but is not runtime
evidence. A musl container on a native Linux host is valid libc evidence;
emulation-only smoke tests are supplementary and cannot be the sole release
gate.

Platforms outside this table are unsupported. The loader MUST reject them
before attempting an arbitrary package name and report `platform`, `arch`, and,
when relevant, `libc`. Fict does not compile from source during package
installation as an implicit fallback.

## Options considered

### Ship only the current CI host

Rejected. An Ubuntu x64 package would make the facade appear portable while
failing at installation or first use for macOS, Windows, ARM64, and Alpine
users.

### Make Windows ARM64 non-blocking

Rejected. The loader and package naming model already have an unambiguous
target, and a non-blocking label would permit stable releases that advertise a
package Fict has not executed. It is cheaper to make the support promise
explicit before the Rust backend becomes default.

### Build all packages but smoke only representative targets

Rejected. Linker, deployment-target, libc, package metadata, and Node loader
failures are target-specific. Successful cross-compilation does not prove that
Node can load or call the artifact.

### Fall back to the Babel compiler when a binary is unavailable

Rejected. Per-install or per-file fallback changes compiler semantics, build
identifiers, metadata, cache ownership, and strict-guarantee behavior. A
missing supported binary is a failed release.

## Consequences

Positive:

- the facade's support claim matches packages that CI actually installs and
  executes;
- native package publication becomes an atomic, auditable release unit;
- publication is blocked unless one release job aggregates the exact 16
  target/Node certifications from one source revision and compiler build;
- ARM64, Alpine/musl, and Windows behavior cannot silently lag the common
  Linux x64 path;
- loader failures remain deterministic and never alter compiler semantics.

Costs and constraints:

- native release CI requires macOS, Windows, Linux ARM64, and musl capacity;
- the release waits for the slowest blocking target;
- Node 22/24 doubles runtime smoke lanes, though binaries remain Node-API
  compatible rather than Node-version-specific;
- a target outage may delay a release even when compiler semantics are green.

Development and pull-request CI MAY use a smaller fast matrix, but stable
release workflows and release candidates intended as support evidence MUST run
the complete blocking matrix. No platform package may be marked optional in
the release plan in the sense of being safe to omit; npm `optionalDependencies`
is only the platform-selection mechanism.

## Risks

- Hosted runner availability can become a release bottleneck.
- A green load smoke can still miss target-specific compiler behavior.
- npm publication could partially succeed after verification.
- Toolchain or OXC upgrades can raise a target's system-library baseline.

The matrix controls the first two through native runtime and compiler smoke
tests. Release tooling MUST preflight every package, publish platform packages
before the facade, retain an auditable plan, and provide a documented recovery
procedure for registry-side partial publication. Deployment baselines inherited
from Node, Rust, or NAPI-RS MUST be recorded with M6 release artifacts and may
not be raised silently.

## Human review requirements

Maintainers MUST review any change to target membership, Node floor, Node-API
level, libc detection, deployment baseline, package naming, runtime evidence,
or atomic publish ordering. Removing or downgrading a blocking row requires a
superseding ADR and a migration note.

## Verification

M0 evidence:

```bash
cargo test --workspace
pnpm -C packages/compiler test -- native-loader.test.ts
```

M6 release evidence:

```bash
pnpm test:compiler:native-packages
pnpm test:package-tarballs
pnpm test:release-publish-plan
pnpm release:verify
```

The native-package gate MUST emit a machine-readable result for every table row
and Node lane. A skipped or missing row is a failure, not an inconclusive pass.
The tag-triggered Release workflow builds eight checksummed tarballs and runs
the resulting 16 target/Node certifications before the publish job becomes
eligible. A manual workflow dispatch builds and certifies the same artifacts
without publishing, which is the supported bootstrap path for new npm package
names.

The publish job MUST download and validate all 16 runtime evidence documents as
one set. The set must contain each target/Node pair exactly once, report the
actual Node version for its declared lane, use one package version, compiler
build ID, size budget, and embedded Git revision, and bind that revision to the
release workflow SHA. Both Node lanes for a target must certify identical
binary and tarball hashes and byte measurements. Missing, duplicate,
wrong-target, mixed-revision, mixed-build, or mixed-bundle evidence blocks
publication even when every matrix job individually reported success.
The evidence hashes, byte measurements, package version, and size result must
also match the eight downloaded bundle artifacts that the same release job will
preflight and publish; agreement only among the 16 evidence documents is not
sufficient.

## Related decisions

- [ADR-0001 — Adopt an OXC-native Rust compiler](0001-adopt-oxc-rust-compiler.md)
- [Fict Rust Compiler Architecture](../architecture/rust-compiler.md)
