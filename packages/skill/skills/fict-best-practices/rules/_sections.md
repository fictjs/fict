# Sections

This file defines section ordering, impact level, and the filename prefix used
to map rules into sections.

## 1. Compiler Guarantees (compiler)

**Impact:** CRITICAL
**Description:** Keep Fict compiler behavior fail-closed and deterministic. Any
fallback diagnostic that weakens reactivity guarantees must be treated as a
blocking issue in CI and code review.

## 2. Reactivity Semantics (reactivity)

**Impact:** CRITICAL
**Description:** Preserve Fict's getter-based semantics so derived values,
closures, and props remain live without stale snapshots.

## 3. Runtime Safety and Performance (runtime)

**Impact:** HIGH
**Description:** Avoid lifecycle leaks and unnecessary work while preserving
fine-grained updates in runtime primitives.

## 4. SSR and Resume Stability (ssr)

**Impact:** HIGH
**Description:** Maintain SSR snapshot compatibility, resumable correctness, and
predictable Suspense/resource behavior across server/client boundaries.

## 5. Tooling and DX Boundaries (tooling)

**Impact:** MEDIUM
**Description:** Keep dev-only tooling useful without regressing production
runtime behavior or bundle characteristics.

## 6. Verification and Release Discipline (quality)

**Impact:** CRITICAL
**Description:** Every bug fix should be defended by regression tests and
release gates to avoid silent correctness regressions.
