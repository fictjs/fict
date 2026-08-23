use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsStr,
    fmt::Write as _,
};

use fict_compiler::{
    COMPILER_BUILD_ID, COMPILER_BUILD_REVISION, CompileRequest, CompileResult, compile,
};
use fict_diagnostics::{DiagnosticSeverity, GuaranteeClass};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

const EXPECTED_CALLSITES: usize = 214;
const EXPECTED_EXECUTED_CALLSITES: usize = 212;
const EXPECTED_ZERO_INVOCATION_CALLSITES: usize = 2;
const EXPECTED_MATCHED_CALLSITE_EXECUTIONS: usize = 1_444;
const EXPECTED_FIXTURES: usize = 1_222;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplayCorpus {
    schema_version: u32,
    claim_boundary: ClaimBoundary,
    provenance: Provenance,
    transition_counts: BTreeMap<String, usize>,
    selected_files: Vec<String>,
    callsites: Vec<Callsite>,
    fixtures: Vec<ReplayFixture>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaimBoundary {
    unit: String,
    legacy_assertions_executed: bool,
    legacy_generated_output_compared: bool,
    semantic_assertion_parity_proven: bool,
    host_callbacks_cross_native_boundary: bool,
    ephemeral_file_urls_normalized: bool,
    status_transitions_policy_reviewed: bool,
    description: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Provenance {
    source_suite_release: String,
    source_suite_revision: String,
    legacy_compiler_source_sha256: String,
    legacy_compiler_index_sha256: String,
    legacy_lockfile_sha256: String,
    legacy_test_source_sha256: String,
    assertion_inventory_sha256: String,
    rust_codegen_corpus_sha256: String,
    generator_sha256: String,
    capture_config_sha256: String,
    selected_test_files: usize,
    selected_tests: usize,
    captured_compiler_invocations: usize,
    static_callsites: usize,
    executed_callsites: usize,
    zero_invocation_callsites: usize,
    matched_callsite_executions: usize,
    replay_fixtures: usize,
    reviewed_revision: String,
    reviewed_compiler_build_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Callsite {
    id: String,
    file: String,
    line: u32,
    column: u32,
    callee: String,
    runtime_invocations: usize,
    zero_invocation_review: Option<ZeroInvocationReview>,
    variants: Vec<CallsiteVariant>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ZeroInvocationReview {
    disposition: String,
    evidence: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CallsiteVariant {
    fixture_id: String,
    executions: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplayFixture {
    id: String,
    origins: Vec<String>,
    request: CompileRequest,
    legacy: LegacyOutcome,
    expected: ExpectedOutcome,
    status_transition: Option<String>,
    transition_policy: Option<TransitionPolicy>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyOutcome {
    status: OutcomeStatus,
    warning_codes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum OutcomeStatus {
    Ok,
    Error,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedOutcome {
    status: OutcomeStatus,
    diagnostics: Vec<ExpectedDiagnostic>,
    code_sha256: String,
    deterministic_result_sha256: String,
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedDiagnostic {
    code: String,
    severity: DiagnosticSeverity,
    guarantee_class: GuaranteeClass,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransitionPolicy {
    policy: String,
    release_disposition: String,
    evidence: String,
    review_reference: String,
}

fn status(result: &CompileResult) -> OutcomeStatus {
    if result.has_errors() {
        OutcomeStatus::Error
    } else {
        OutcomeStatus::Ok
    }
}

fn diagnostics(result: &CompileResult) -> Vec<ExpectedDiagnostic> {
    result
        .diagnostics
        .iter()
        .map(|diagnostic| ExpectedDiagnostic {
            code: diagnostic.code.as_str().to_owned(),
            severity: diagnostic.severity,
            guarantee_class: diagnostic.guarantee_class,
        })
        .collect()
}

fn sha256(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut output, "{byte:02x}").expect("writing to a string cannot fail");
    }
    output
}

fn canonicalize(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize).collect()),
        Value::Object(values) => {
            let mut entries = values.into_iter().collect::<Vec<_>>();
            entries.sort_unstable_by(|(left, _), (right, _)| left.cmp(right));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, canonicalize(value)))
                    .collect(),
            )
        }
        value => value,
    }
}

fn deterministic_result(result: &CompileResult) -> Value {
    let mut value = serde_json::to_value(result).expect("serialize compile result");
    let object = value.as_object_mut().expect("compile result object");
    assert!(object.remove("stats").is_some());
    assert!(object.remove("compilerBuildId").is_some());
    canonicalize(value)
}

fn assert_sha256(value: &str, context: &str) {
    assert_eq!(value.len(), 64, "{context}");
    assert!(
        value.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "{context}"
    );
}

fn replay_bless_enabled(value: Option<&OsStr>) -> bool {
    value.is_some_and(|value| value == "1")
}

/// Rewrite every fixture's expected digests from the current compiler.
///
/// The corpus generator needs a legacy compiler checkout, which is not part of
/// this repository, so intentional codegen changes would otherwise be
/// unmaintainable. Run with `FICT_BLESS_REPLAY=1` and review the resulting
/// diff; the digests must only move for outputs the change is meant to affect.
///
/// Only digests are rewritten. A changed status or diagnostic set is a semantic
/// change that must be reviewed by hand, so those assertions still fail.
fn bless_replay_corpus(corpus_text: &str, corpus: &ReplayCorpus) {
    let mut text = corpus_text.to_owned();
    let mut updated = 0_usize;
    for fixture in &corpus.fixtures {
        let result = compile(fixture.request.clone());
        let code_sha256 = sha256(&result.code);
        let deterministic_sha256 = sha256(
            &serde_json::to_string(&deterministic_result(&result))
                .expect("serialize deterministic result"),
        );
        for (old, new) in [
            (&fixture.expected.code_sha256, &code_sha256),
            (
                &fixture.expected.deterministic_result_sha256,
                &deterministic_sha256,
            ),
        ] {
            if old == new {
                continue;
            }
            // Digests are unique per fixture, so a single textual replacement
            // keeps the surrounding formatting byte-for-byte intact.
            assert_eq!(
                text.matches(old.as_str()).count(),
                1,
                "{} digest is not unique",
                fixture.id
            );
            text = text.replace(old.as_str(), new.as_str());
            updated += 1;
        }
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/legacy_unrepresented_callsite_replay.json");
    std::fs::write(&path, text).expect("write replay corpus json");
    eprintln!("blessed {updated} replay digests");
}

#[test]
fn replays_every_legacy_unrepresented_compiler_callsite_variant() {
    let corpus_text = include_str!("legacy_unrepresented_callsite_replay.json");
    assert!(!corpus_text.contains("file:///private/var/folders/"));
    assert!(!corpus_text.contains("file:///var/folders/"));
    assert!(!corpus_text.contains("/fict-legacy-unrepresented-"));
    let corpus: ReplayCorpus = serde_json::from_str(corpus_text).expect("valid replay corpus");
    let bless = replay_bless_enabled(std::env::var_os("FICT_BLESS_REPLAY").as_deref());
    assert!(
        !bless || cfg!(feature = "preview"),
        "replay blessing requires the preview feature"
    );

    assert_eq!(corpus.schema_version, 1);
    assert_eq!(
        corpus.claim_boundary.unit,
        "runtime-compiler-invocation-associated-with-static-callsite"
    );
    assert!(corpus.claim_boundary.legacy_assertions_executed);
    assert!(!corpus.claim_boundary.legacy_generated_output_compared);
    assert!(!corpus.claim_boundary.semantic_assertion_parity_proven);
    assert!(!corpus.claim_boundary.host_callbacks_cross_native_boundary);
    assert!(corpus.claim_boundary.ephemeral_file_urls_normalized);
    assert!(corpus.claim_boundary.status_transitions_policy_reviewed);
    assert!(!corpus.claim_boundary.description.trim().is_empty());

    assert_eq!(corpus.provenance.source_suite_release, "0.28.0");
    assert_eq!(
        corpus.provenance.source_suite_revision,
        "b99ff5b185e3eed701e2d4f3521832dac67c979f"
    );
    for (value, context) in [
        (
            &corpus.provenance.legacy_compiler_source_sha256,
            "legacy compiler source digest",
        ),
        (
            &corpus.provenance.legacy_compiler_index_sha256,
            "legacy compiler index digest",
        ),
        (
            &corpus.provenance.legacy_lockfile_sha256,
            "legacy lockfile digest",
        ),
        (
            &corpus.provenance.legacy_test_source_sha256,
            "legacy test source digest",
        ),
        (
            &corpus.provenance.assertion_inventory_sha256,
            "assertion inventory digest",
        ),
        (
            &corpus.provenance.rust_codegen_corpus_sha256,
            "Rust codegen corpus digest",
        ),
        (&corpus.provenance.generator_sha256, "generator digest"),
        (
            &corpus.provenance.capture_config_sha256,
            "capture config digest",
        ),
    ] {
        assert_sha256(value, context);
    }
    assert_eq!(corpus.provenance.selected_test_files, 29);
    assert_eq!(corpus.selected_files.len(), 29);
    assert_eq!(corpus.provenance.selected_tests, 1_917);
    assert_eq!(corpus.provenance.captured_compiler_invocations, 2_327);
    assert_eq!(corpus.provenance.static_callsites, EXPECTED_CALLSITES);
    assert_eq!(
        corpus.provenance.executed_callsites,
        EXPECTED_EXECUTED_CALLSITES
    );
    assert_eq!(
        corpus.provenance.zero_invocation_callsites,
        EXPECTED_ZERO_INVOCATION_CALLSITES
    );
    assert_eq!(
        corpus.provenance.matched_callsite_executions,
        EXPECTED_MATCHED_CALLSITE_EXECUTIONS
    );
    assert_eq!(corpus.provenance.replay_fixtures, EXPECTED_FIXTURES);
    assert_eq!(corpus.provenance.reviewed_revision.len(), 40);
    assert!(
        corpus
            .provenance
            .reviewed_compiler_build_id
            .starts_with("fict-rust-p1-oxc0.139.0-m1-")
    );
    // The recorded build ID certifies the exact reviewed revision. Later revisions still replay
    // every expected result below, but their revision-bound build ID must differ by design.
    if cfg!(feature = "preview")
        && COMPILER_BUILD_REVISION == Some(corpus.provenance.reviewed_revision.as_str())
    {
        assert_eq!(
            corpus.provenance.reviewed_compiler_build_id,
            COMPILER_BUILD_ID
        );
    }
    assert!(
        corpus
            .selected_files
            .windows(2)
            .all(|files| files[0] < files[1])
    );
    assert_eq!(
        corpus.transition_counts,
        BTreeMap::from([("error-to-ok".into(), 2), ("ok-to-error".into(), 3)])
    );

    assert_eq!(corpus.callsites.len(), EXPECTED_CALLSITES);
    let mut callsite_ids = BTreeSet::new();
    let mut fixture_ids_referenced = BTreeSet::new();
    let mut callsite_variants = BTreeMap::new();
    let mut executed_callsites = 0;
    let mut zero_invocation_callsites = 0;
    let mut matched_callsite_executions = 0;
    for callsite in &corpus.callsites {
        assert!(callsite_ids.insert(callsite.id.clone()), "{}", callsite.id);
        assert!(callsite.id.starts_with(&format!("{}:", callsite.file)));
        assert!(callsite.line > 0 && callsite.column > 0);
        assert!(!callsite.callee.is_empty());
        let executions = callsite
            .variants
            .iter()
            .map(|variant| variant.executions)
            .sum::<usize>();
        assert_eq!(executions, callsite.runtime_invocations, "{}", callsite.id);
        matched_callsite_executions += executions;
        if callsite.runtime_invocations == 0 {
            zero_invocation_callsites += 1;
            let review = callsite
                .zero_invocation_review
                .as_ref()
                .expect("zero-invocation review");
            assert!(!review.disposition.is_empty());
            assert!(!review.evidence.is_empty());
            assert!(callsite.variants.is_empty());
        } else {
            executed_callsites += 1;
            assert!(callsite.zero_invocation_review.is_none());
        }
        let variants = callsite
            .variants
            .iter()
            .map(|variant| {
                assert!(variant.executions > 0, "{}", callsite.id);
                fixture_ids_referenced.insert(variant.fixture_id.clone());
                variant.fixture_id.clone()
            })
            .collect::<BTreeSet<_>>();
        assert_eq!(variants.len(), callsite.variants.len(), "{}", callsite.id);
        callsite_variants.insert(callsite.id.clone(), variants);
    }
    assert_eq!(executed_callsites, EXPECTED_EXECUTED_CALLSITES);
    assert_eq!(
        zero_invocation_callsites,
        EXPECTED_ZERO_INVOCATION_CALLSITES
    );
    assert_eq!(
        matched_callsite_executions,
        EXPECTED_MATCHED_CALLSITE_EXECUTIONS
    );

    assert_eq!(corpus.fixtures.len(), EXPECTED_FIXTURES);
    let mut fixture_ids = BTreeSet::new();
    let mut transition_counts = BTreeMap::new();
    let mut transition_policy_counts = BTreeMap::new();
    let mut preview_fixtures = 0;
    let mut replayed_fixtures = 0;
    for fixture in &corpus.fixtures {
        assert!(fixture_ids.insert(fixture.id.clone()), "{}", fixture.id);
        assert!(fixture.id.starts_with("legacy-unrepresented-"));
        assert!(!fixture.origins.is_empty(), "{}", fixture.id);
        assert!(
            fixture
                .origins
                .windows(2)
                .all(|origins| origins[0] < origins[1])
        );
        for origin in &fixture.origins {
            assert!(callsite_ids.contains(origin), "{}: {origin}", fixture.id);
            assert!(
                callsite_variants
                    .get(origin)
                    .is_some_and(|variants| variants.contains(&fixture.id)),
                "{}: {origin}",
                fixture.id
            );
        }
        assert!(
            fixture
                .legacy
                .warning_codes
                .iter()
                .all(|code| code.starts_with("FICT-")),
            "{}",
            fixture.id
        );
        assert!(
            fixture
                .request
                .filename
                .starts_with("/fixtures/legacy-unrepresented/"),
            "{}",
            fixture.id
        );
        let expected_transition = (fixture.legacy.status != fixture.expected.status).then(|| {
            format!(
                "{:?}-to-{:?}",
                fixture.legacy.status, fixture.expected.status
            )
            .to_lowercase()
        });
        assert_eq!(
            fixture.status_transition, expected_transition,
            "{} transition",
            fixture.id
        );
        if let Some(transition) = fixture.status_transition.as_ref() {
            *transition_counts.entry(transition.clone()).or_default() += 1;
            let policy = fixture
                .transition_policy
                .as_ref()
                .expect("status transition policy");
            assert_eq!(policy.release_disposition, "allow", "{}", fixture.id);
            assert!(!policy.evidence.is_empty(), "{}", fixture.id);
            assert!(!policy.review_reference.is_empty(), "{}", fixture.id);
            *transition_policy_counts
                .entry(policy.policy.clone())
                .or_default() += 1;
        } else {
            assert!(fixture.transition_policy.is_none(), "{}", fixture.id);
        }
        assert_sha256(
            &fixture.expected.code_sha256,
            &format!("{} code digest", fixture.id),
        );
        assert_sha256(
            &fixture.expected.deterministic_result_sha256,
            &format!("{} result digest", fixture.id),
        );
        if fixture.request.options.preview.is_some() {
            preview_fixtures += 1;
            if !cfg!(feature = "preview") {
                continue;
            }
        }

        replayed_fixtures += 1;
        let first = compile(fixture.request.clone());
        let second = compile(fixture.request.clone());
        let first_deterministic = deterministic_result(&first);
        assert_eq!(
            deterministic_result(&second),
            first_deterministic,
            "{} deterministic result",
            fixture.id
        );
        assert_eq!(
            status(&first),
            fixture.expected.status,
            "{} status",
            fixture.id
        );
        assert_eq!(
            diagnostics(&first),
            fixture.expected.diagnostics,
            "{} diagnostics",
            fixture.id
        );
        if !bless {
            assert_eq!(
                sha256(&first.code),
                fixture.expected.code_sha256,
                "{} code",
                fixture.id
            );
        }
        let deterministic_json =
            serde_json::to_string(&first_deterministic).expect("serialize deterministic result");
        if !bless {
            assert_eq!(
                sha256(&deterministic_json),
                fixture.expected.deterministic_result_sha256,
                "{} deterministic result digest",
                fixture.id
            );
        }
    }

    assert_eq!(fixture_ids, fixture_ids_referenced);
    assert_eq!(preview_fixtures, 1);
    assert_eq!(
        replayed_fixtures,
        if cfg!(feature = "preview") {
            EXPECTED_FIXTURES
        } else {
            EXPECTED_FIXTURES - preview_fixtures
        }
    );
    assert_eq!(transition_counts, corpus.transition_counts);
    assert_eq!(
        transition_policy_counts,
        BTreeMap::from([
            ("genuine-capability-expansion".into(), 1),
            ("intentional-runtime-error".into(), 1),
            ("strict-reactivity-fail-closed".into(), 2),
            ("structured-hook-return".into(), 1),
        ])
    );
    if bless {
        bless_replay_corpus(corpus_text, &corpus);
    }
}

#[test]
fn requires_exact_replay_bless_opt_in() {
    assert!(!replay_bless_enabled(None));
    assert!(!replay_bless_enabled(Some(OsStr::new(""))));
    assert!(!replay_bless_enabled(Some(OsStr::new("0"))));
    assert!(!replay_bless_enabled(Some(OsStr::new("true"))));
    assert!(replay_bless_enabled(Some(OsStr::new("1"))));
}
