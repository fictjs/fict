#![forbid(unsafe_code)]

//! Pure orchestration boundary for the native Fict compiler.
//!
//! The crate coordinates Fict-owned passes and the OXC adapter without owning
//! filesystem, network, Node, N-API, or bundler state.

mod analysis;
#[cfg(test)]
mod build_id_input;
mod capabilities;
mod control_flow_diagnostics;
mod diagnostic_policy;
mod effect_diagnostics;
mod metadata_analysis;
mod pass_manager;
mod pipeline;
mod reactive_write_validation;
mod request;
mod result;
mod scan;
mod source_map;

pub use analysis::{
    AnalyzeDiagnostic, AnalyzeDiagnosticSeverity, AnalyzeResult, ComponentAnalysis, LineTrace,
    RegionInfo, TraceMarker, TraceMarkerKind, analyze, internal_analyze_error_result,
    invalid_analyze_request_result,
};
pub use capabilities::{
    COMPILER_CAPABILITY_MANIFEST_DIGEST, COMPILER_CAPABILITY_MANIFEST_SCOPE,
    COMPILER_CAPABILITY_MANIFEST_VERSION, COMPILER_CAPABILITY_PACKAGE_VERSION,
};
pub use fict_compiler_oxc::{OXC_VERSION, ParseProbe};
pub use fict_metadata::MODULE_REACTIVE_METADATA_VERSION;
pub use pass_manager::{
    CompilerPass, CorePassBudgets, CorePassOptions, CorePassOutput, CorePassStats,
    FunctionPassAnalysis, PassContext, run_core_passes,
};
pub use pipeline::{compile, internal_error_result};
pub use request::{
    AnalyzeOptions, AnalyzeRequest, AnalyzeVerbosity, CompileRequest, CompileRequestError,
    CompilerOptions, CompilerPreviewOptions, CompilerTypeScriptOptions, ModuleKind,
    NormalizedAnalyzeRequest, NormalizedCompileRequest, NormalizedScanRequest, OptimizeLevel,
    ScanRequest, SourceLanguage, WarningLevel, WarningsAsErrors,
};
pub use result::{
    CompileResult, CompilerArtifact, CompilerArtifactKind, CompilerExplainArtifact,
    CompilerExplainEvent, CompilerExplainEventKind, CompilerStats, HandlerArtifactMetadata,
    MAX_SAFE_JAVASCRIPT_INTEGER, invalid_request_result,
};
pub use scan::{
    ScanModuleRequest, ScanModuleRequestKind, ScanResult, internal_scan_error_result,
    invalid_scan_request_result, scan,
};
pub use source_map::{RawSourceMap, SourceMapValidationError};

/// Current native request/result protocol version.
pub const COMPILER_PROTOCOL_VERSION: u32 = 1;

/// SHA-256 of native source, manifests, lockfile, toolchain, feature mode, and build revision.
pub const COMPILER_SOURCE_HASH: &str = env!("FICT_COMPILER_SOURCE_HASH");

/// Exact source revision embedded by controlled CI/release builds, when available.
pub const COMPILER_BUILD_REVISION: Option<&str> = option_env!("FICT_COMPILER_BUILD_REVISION");

/// Stable cross-platform identity used by caches, shadow comparisons, and rollback checks.
pub const COMPILER_BUILD_ID: &str = concat!(
    "fict-rust-p1-oxc0.139.0-m1-",
    env!("FICT_COMPILER_SOURCE_HASH")
);

/// Return this native artifact's immutable compiler build identity.
#[must_use]
pub const fn compiler_build_id() -> &'static str {
    COMPILER_BUILD_ID
}

/// Return the source revision embedded in this native artifact.
#[must_use]
pub const fn compiler_build_revision() -> Option<&'static str> {
    COMPILER_BUILD_REVISION
}

/// Parse-only compatibility probe retained while the complete compile pipeline
/// is assembled behind this orchestration boundary.
#[must_use]
pub fn parse_tsx_probe(source: &str) -> ParseProbe {
    fict_compiler_oxc::parse_tsx_probe(source)
}

#[cfg(test)]
mod build_id_tests {
    use super::{
        COMPILER_BUILD_ID, COMPILER_BUILD_REVISION, COMPILER_PROTOCOL_VERSION,
        COMPILER_SOURCE_HASH, MODULE_REACTIVE_METADATA_VERSION, OXC_VERSION, compiler_build_id,
        compiler_build_revision,
    };

    #[test]
    fn build_id_contains_protocol_dependency_and_sha256_identity() {
        assert_eq!(compiler_build_id(), COMPILER_BUILD_ID);
        assert_eq!(compiler_build_revision(), COMPILER_BUILD_REVISION);
        if let Some(revision) = COMPILER_BUILD_REVISION {
            assert_eq!(revision.len(), 40);
            assert!(
                revision
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            );
        }
        assert_eq!(COMPILER_SOURCE_HASH.len(), 64);
        assert!(
            COMPILER_SOURCE_HASH
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        );
        assert!(COMPILER_BUILD_ID.contains(&format!("-p{COMPILER_PROTOCOL_VERSION}-")));
        assert!(COMPILER_BUILD_ID.contains(&format!("oxc{OXC_VERSION}")));
        assert!(COMPILER_BUILD_ID.contains(&format!("-m{MODULE_REACTIVE_METADATA_VERSION}-")));
        assert!(COMPILER_BUILD_ID.ends_with(COMPILER_SOURCE_HASH));
    }
}
