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

const EXPECTED_BASE_FIXTURES: usize = 1_892;
const EXPECTED_STRICT_FIXTURES: usize = 58;
const EXPECTED_FIXTURES: usize = EXPECTED_BASE_FIXTURES + EXPECTED_STRICT_FIXTURES;
const EXPECTED_FILES_WITH_AUDIT_ROWS: usize = 73;
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
    source_suite_release: String,
    source_suite_revision: String,
    babel_audit_release: String,
    babel_audit_revision: String,
    babel_compiler_source_sha256: String,
    babel_compiler_artifact_sha256: String,
    babel_lockfile_sha256: String,
    babel_audit_filename: String,
    babel_package_manager: String,
    babel_dependencies: BTreeMap<String, String>,
    rust_audit_release: String,
    rust_audit_revision: String,
    audit_input_sha256: String,
    request_policy_sha256: String,
    legacy_test_source_sha256: String,
    extracted_calls: usize,
    unique_fixtures: usize,
    strict_guarantee_true_variants: usize,
    corpus_fixtures: usize,
    scanned_legacy_test_files: usize,
    legacy_test_files_with_audit_rows: usize,
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
    babel_audit: BabelAuditOutcome,
    expected: ExpectedOutcome,
    deviation_policy: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixtureOrigin {
    file: String,
    line: u32,
    callee: String,
    request_variant: RequestVariant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum RequestVariant {
    AuditBaseline,
    StrictGuarantee,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum OutcomeStatus {
    Ok,
    Error,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BabelAuditOutcome {
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
    let compiler_package: serde_json::Value =
        serde_json::from_str(include_str!("../../../packages/compiler/package.json"))
            .expect("valid compiler package metadata");

    assert_eq!(corpus.schema_version, 5);
    assert_eq!(corpus.provenance.source_suite_release, "0.28.0");
    assert_eq!(
        corpus.provenance.source_suite_revision,
        "b99ff5b185e3eed701e2d4f3521832dac67c979f"
    );
    assert_eq!(corpus.provenance.babel_audit_release, "0.28.0");
    assert_eq!(
        corpus.provenance.babel_audit_revision,
        corpus.provenance.source_suite_revision
    );
    assert_eq!(
        corpus.provenance.babel_compiler_source_sha256,
        "cbbaf8e6c3697e62bb5889cfebd472bada4063749140445c5098605866fd463a"
    );
    assert_eq!(
        corpus.provenance.babel_compiler_artifact_sha256,
        "07c4f89c35419434b1a6762e05b08340a0c080f8ff7dd09005cb782ed9621789"
    );
    assert_eq!(
        corpus.provenance.babel_lockfile_sha256,
        "2b385eb419b90cf4f512a80ae925c2e2899bdb0e8d8c202cba8e09a9343b5af6"
    );
    assert_eq!(
        corpus.provenance.babel_audit_filename,
        "/mnt/data/fict_audit/legacy/fict-0.28.0/fixture.tsx"
    );
    assert_eq!(corpus.provenance.babel_package_manager, "pnpm@9.1.1");
    assert_eq!(
        corpus.provenance.babel_dependencies,
        BTreeMap::from([
            ("@babel/core".into(), "7.29.7".into()),
            ("@babel/plugin-transform-typescript".into(), "7.28.5".into()),
        ])
    );
    assert_eq!(
        corpus.provenance.rust_audit_release,
        compiler_package["version"]
            .as_str()
            .expect("compiler package version")
    );
    assert_eq!(
        corpus.provenance.rust_audit_revision,
        corpus.provenance.reviewed_revision
    );
    assert_eq!(corpus.provenance.audit_input_sha256, EXPECTED_AUDIT_SHA256);
    assert_eq!(
        corpus.provenance.request_policy_sha256,
        "6b459d227b9b70c163861d31104547f8e1569526ae5fb78c36cb7a11f313bec8"
    );
    assert_eq!(
        corpus.provenance.legacy_test_source_sha256,
        "65e6c3961af46d92d88d40d4ee0bb50901538ea15b4468dc8c79c73eef9da8bb"
    );
    assert_eq!(corpus.provenance.extracted_calls, 1_974);
    assert_eq!(corpus.provenance.unique_fixtures, EXPECTED_BASE_FIXTURES);
    assert_eq!(
        corpus.provenance.strict_guarantee_true_variants,
        EXPECTED_STRICT_FIXTURES
    );
    assert_eq!(corpus.provenance.corpus_fixtures, EXPECTED_FIXTURES);
    assert_eq!(corpus.provenance.scanned_legacy_test_files, 107);
    assert_eq!(
        corpus.provenance.legacy_test_files_with_audit_rows,
        EXPECTED_FILES_WITH_AUDIT_ROWS
    );
    assert_sha256(EXPECTED_AUDIT_SHA256, "audit input digest");
    assert_sha256(
        &corpus.provenance.request_policy_sha256,
        "request policy digest",
    );
    assert_sha256(
        &corpus.provenance.legacy_test_source_sha256,
        "legacy test source digest",
    );
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
    let mut files_with_audit_rows = BTreeSet::new();
    let mut request_variant_counts: BTreeMap<RequestVariant, usize> = BTreeMap::new();
    let mut observed_policy_counts: BTreeMap<String, usize> = corpus
        .deviation_policies
        .keys()
        .map(|policy| (policy.clone(), 0))
        .collect();
    for fixture in corpus.fixtures {
        let base_id = format!(
            "{}:{}:{}",
            fixture.origin.file, fixture.origin.line, fixture.origin.callee
        );
        let expected_id = match fixture.origin.request_variant {
            RequestVariant::AuditBaseline => base_id,
            RequestVariant::StrictGuarantee => format!("{base_id}:strictGuarantee=true"),
        };
        assert_eq!(fixture.id, expected_id);
        *request_variant_counts
            .entry(fixture.origin.request_variant)
            .or_default() += 1;
        assert_eq!(
            fixture.options.strict_guarantee,
            fixture.origin.request_variant == RequestVariant::StrictGuarantee,
            "{} request policy",
            fixture.id
        );
        assert!(
            ids.insert(fixture.id.clone()),
            "duplicate fixture {}",
            fixture.id
        );
        files_with_audit_rows.insert(fixture.origin.file.clone());
        assert!(
            !fixture.source.trim().is_empty(),
            "{} has empty source",
            fixture.id
        );
        assert!(
            fixture
                .babel_audit
                .diagnostic_codes
                .iter()
                .all(|code| code.starts_with("FICT-")),
            "{} has a malformed Babel audit diagnostic",
            fixture.id
        );
        if let Some(hash) = fixture.babel_audit.code_sha256.as_deref() {
            assert_sha256(hash, &format!("{} Babel audit code hash", fixture.id));
        }
        let status_changed = fixture.babel_audit.status != fixture.expected.status;
        if fixture.origin.request_variant == RequestVariant::StrictGuarantee && status_changed {
            assert_eq!(
                fixture.deviation_policy.as_deref(),
                Some("strict-reactivity-fail-closed"),
                "{} strict status deviation",
                fixture.id
            );
        }
        assert_eq!(
            fixture.deviation_policy.is_some(),
            status_changed,
            "{} must explicitly classify every Babel audit status deviation",
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

    assert_eq!(files_with_audit_rows.len(), EXPECTED_FILES_WITH_AUDIT_ROWS);
    assert_eq!(
        request_variant_counts,
        BTreeMap::from([
            (RequestVariant::AuditBaseline, EXPECTED_BASE_FIXTURES),
            (RequestVariant::StrictGuarantee, EXPECTED_STRICT_FIXTURES),
        ])
    );
    assert_eq!(observed_policy_counts, corpus.deviation_policy_counts);
}
