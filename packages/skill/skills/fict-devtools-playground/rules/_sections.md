# Sections

This file defines section ordering and filename prefixes for
fict-devtools-playground.

## 1. Bridge and Transport Correctness (bridge)

**Impact:** CRITICAL
**Description:** Transport handshake and message contracts must be deterministic
across standalone and extension environments.

## 2. Inspector Data Semantics (inspector)

**Impact:** HIGH
**Description:** Inspector data should map to meaningful runtime entities with
stable labels and reliable ownership navigation.

## 3. Graph and Timeline UX (graph)

**Impact:** HIGH
**Description:** Graph and timeline views should expose complete dependency
relationships and provide actionable navigation flows.

## 4. Playground Preview Runtime (preview)

**Impact:** HIGH
**Description:** Preview updates must be faithful to source edits while keeping
playground execution isolated from production runtime paths.

## 5. Verification and Shipping Gates (quality)

**Impact:** CRITICAL
**Description:** Devtools/playground changes require behavior verification in
real examples and parity checks across deployment modes.
