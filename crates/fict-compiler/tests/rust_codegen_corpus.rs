use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write as _,
};

use fict_compiler::{
    COMPILER_PROTOCOL_VERSION, CompileRequest, CompileResult, CompilerOptions, compile,
};
use fict_diagnostics::{DiagnosticSeverity, GuaranteeClass};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const EXPECTED_FIXTURES: usize = 1_892;
const EXPECTED_REPRESENTED_FILES: usize = 73;
const EXPECTED_AUDIT_SHA256: &str =
    "676b022516c01b525d7e2a316e5b072eae2ee1532b2bb103573543900f13b67f";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompatibilityCorpus {
    schema_version: u32,
    provenance: CorpusProvenance,
    deviation_policies: BTreeMap<String, String>,
    deviation_policy_counts: BTreeMap<String, usize>,
    fixtures: Vec<CompatibilityFixture>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CorpusProvenance {
    legacy_release: String,
    legacy_revision: String,
    rust_audit_release: String,
    rust_audit_revision: String,
    audit_input_sha256: String,
    extracted_calls: usize,
    unique_fixtures: usize,
    scanned_legacy_test_files: usize,
    represented_legacy_test_files: usize,
    reviewed_revision: String,
    reviewed_compiler_build_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompatibilityFixture {
    id: String,
    origin: FixtureOrigin,
    source: String,
    options: CompilerOptions,
    legacy: LegacyOutcome,
    expected: ExpectedOutcome,
    deviation_policy: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixtureOrigin {
    file: String,
    line: u32,
    callee: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum OutcomeStatus {
    Ok,
    Error,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyOutcome {
    status: OutcomeStatus,
    diagnostic_codes: Vec<String>,
    code_sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedOutcome {
    status: OutcomeStatus,
    diagnostics: Vec<ExpectedDiagnostic>,
    code_sha256: String,
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedDiagnostic {
    code: String,
    severity: DiagnosticSeverity,
    guarantee_class: GuaranteeClass,
}

fn request(fixture: &CompatibilityFixture) -> CompileRequest {
    CompileRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: fixture.source.clone(),
        filename: "/fixtures/legacy-0.28-corpus.tsx".into(),
        module_id: None,
        public_module_id: None,
        language: None,
        module_kind: None,
        input_source_map: None,
        options: fixture.options.clone(),
        metadata: Vec::new(),
        integration_diagnostics: Vec::new(),
    }
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

fn without_timings(mut result: CompileResult) -> CompileResult {
    if let Some(stats) = result.stats.as_mut() {
        stats.stage_durations_ns.clear();
    }
    result
}

fn assert_sha256(value: &str, context: &str) {
    assert_eq!(value.len(), 64, "{context}");
    assert!(
        value.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "{context}"
    );
}

#[test]
fn replays_the_frozen_rust_codegen_corpus() {
    let corpus: CompatibilityCorpus =
        serde_json::from_str(include_str!("rust_frozen_codegen_corpus.json"))
            .expect("valid frozen Rust codegen corpus");

    assert_eq!(corpus.schema_version, 1);
    assert_eq!(corpus.provenance.legacy_release, "0.28.0");
    assert_eq!(corpus.provenance.legacy_revision.len(), 40);
    assert_eq!(corpus.provenance.rust_audit_release, "0.30.1");
    assert_eq!(corpus.provenance.rust_audit_revision.len(), 40);
    assert_eq!(corpus.provenance.audit_input_sha256, EXPECTED_AUDIT_SHA256);
    assert_eq!(corpus.provenance.extracted_calls, 1_974);
    assert_eq!(corpus.provenance.unique_fixtures, EXPECTED_FIXTURES);
    assert_eq!(corpus.provenance.scanned_legacy_test_files, 107);
    assert_eq!(
        corpus.provenance.represented_legacy_test_files,
        EXPECTED_REPRESENTED_FILES
    );
    assert_sha256(EXPECTED_AUDIT_SHA256, "audit input digest");
    assert_eq!(corpus.provenance.reviewed_revision.len(), 40);
    assert!(
        corpus
            .provenance
            .reviewed_compiler_build_id
            .starts_with("fict-rust-p1-oxc0.139.0-m1-")
    );
    assert_eq!(corpus.fixtures.len(), EXPECTED_FIXTURES);
    assert_eq!(
        corpus.deviation_policies.keys().collect::<Vec<_>>(),
        corpus.deviation_policy_counts.keys().collect::<Vec<_>>()
    );

    let mut ids = BTreeSet::new();
    let mut represented_files = BTreeSet::new();
    let mut observed_policy_counts: BTreeMap<String, usize> = BTreeMap::new();
    for fixture in corpus.fixtures {
        let expected_id = format!(
            "{}:{}:{}",
            fixture.origin.file, fixture.origin.line, fixture.origin.callee
        );
        assert_eq!(fixture.id, expected_id);
        assert!(
            ids.insert(fixture.id.clone()),
            "duplicate fixture {}",
            fixture.id
        );
        represented_files.insert(fixture.origin.file.clone());
        assert!(
            !fixture.source.trim().is_empty(),
            "{} has empty source",
            fixture.id
        );
        assert!(
            fixture
                .legacy
                .diagnostic_codes
                .iter()
                .all(|code| code.starts_with("FICT-")),
            "{} has a malformed legacy diagnostic",
            fixture.id
        );
        if let Some(hash) = fixture.legacy.code_sha256.as_deref() {
            assert_sha256(hash, &format!("{} legacy code hash", fixture.id));
        }
        let status_changed = fixture.legacy.status != fixture.expected.status;
        assert_eq!(
            fixture.deviation_policy.is_some(),
            status_changed,
            "{} must explicitly classify every legacy status deviation",
            fixture.id
        );
        if let Some(policy) = fixture.deviation_policy.as_deref() {
            assert!(
                corpus.deviation_policies.contains_key(policy),
                "{}: {policy}",
                fixture.id
            );
            *observed_policy_counts.entry(policy.to_owned()).or_default() += 1;
        }

        let first = compile(request(&fixture));
        let second = compile(request(&fixture));
        assert_eq!(
            without_timings(second),
            without_timings(first.clone()),
            "{} is nondeterministic",
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
        assert_eq!(
            sha256(&first.code),
            fixture.expected.code_sha256,
            "{} output hash",
            fixture.id
        );
        assert_eq!(
            first.code.is_empty(),
            first.has_errors(),
            "{} output/error",
            fixture.id
        );
    }

    assert_eq!(represented_files.len(), EXPECTED_REPRESENTED_FILES);
    assert_eq!(observed_policy_counts, corpus.deviation_policy_counts);
}
