use std::collections::BTreeMap;

use fict_diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use fict_metadata::ModuleReactiveMetadata;
use serde::{Deserialize, Serialize};

use crate::{COMPILER_BUILD_ID, COMPILER_PROTOCOL_VERSION, CompileRequestError, RawSourceMap};

const REQUEST_HELP: &str = "fix the request shape before invoking the native compiler";
pub(crate) const INTERNAL_RECOVERY_HELP: &str = "report the minimized fixture with compilerBuildId, protocolVersion, nativeTarget, and source language; recover only by restoring the complete verified 0.30.1 application unit without mixing compiler/runtime versions";

/// Kind of additional module emitted by the compiler.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompilerArtifactKind {
    /// Lazily loaded event-handler module.
    HandlerModule,
    /// Other compiler-owned auxiliary JavaScript module.
    AuxiliaryModule,
}

/// Structured extra module returned to a graph host; the core never writes it to disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompilerArtifact {
    /// Stable artifact identity within this compilation.
    pub id: String,
    /// Artifact purpose.
    pub kind: CompilerArtifactKind,
    /// Generated JavaScript.
    pub code: String,
    /// Optional map back to the original source.
    pub map: Option<RawSourceMap>,
    /// Handler-only routing metadata. Auxiliary modules leave this absent.
    pub handler: Option<HandlerArtifactMetadata>,
}

/// Structured routing data for a lazily loaded Preview handler module.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandlerArtifactMetadata {
    /// Request-local source export retained for QRL and diagnostic identity.
    pub source_export_name: String,
    /// Export loaded from the standalone artifact module, normally `default`.
    pub artifact_export_name: String,
    /// Compiler-owned placeholder embedded in the main output for host replacement.
    pub module_specifier: String,
    /// Authored handler expression span used by artifact source-map probes.
    pub source_span: SourceSpan,
}

/// Native explanation event category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CompilerExplainEventKind {
    /// Source signal decision.
    SourceSignal,
    /// Source effect decision.
    SourceEffect,
    /// Source memo decision.
    SourceMemo,
    /// JSX lowering decision.
    SourceJsx,
    /// Control-flow decision.
    SourceControlFlow,
    /// Runtime helper requirement.
    RuntimeHelper,
    /// Diagnostic policy event.
    Diagnostic,
}

/// One structured native explanation event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompilerExplainEvent {
    /// Event category.
    pub kind: CompilerExplainEventKind,
    /// Human-readable explanation.
    pub message: String,
    /// Optional binding/helper name.
    pub name: Option<String>,
    /// Optional diagnostic code.
    pub code: Option<String>,
    /// Optional source range.
    pub span: Option<SourceSpan>,
}

/// Structured explanation artifact returned only when requested.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompilerExplainArtifact {
    /// Artifact schema version.
    pub version: u32,
    /// Request filename.
    pub file_name: String,
    /// Sorted runtime helper names.
    pub helpers: Vec<String>,
    /// Diagnostics relevant to the explanation.
    pub diagnostics: Vec<Diagnostic>,
    /// Ordered compiler decisions.
    pub events: Vec<CompilerExplainEvent>,
}

/// Local-only performance and size counters; keys are stable and deterministically ordered.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompilerStats {
    /// Per-stage duration in nanoseconds.
    pub stage_durations_ns: BTreeMap<String, u64>,
    /// Node/block/region/template/helper/allocation counters.
    pub counters: BTreeMap<String, u64>,
}

/// Complete native compile result; no graph or filesystem side effects are hidden.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    /// Result protocol version.
    pub protocol_version: u32,
    /// Generated JavaScript, empty when an error prevents emission.
    pub code: String,
    /// Generated source map.
    pub map: Option<RawSourceMap>,
    /// Deterministically sorted structured diagnostics.
    pub diagnostics: Vec<Diagnostic>,
    /// This module's reactive metadata.
    pub module_metadata: ModuleReactiveMetadata,
    /// Resolved metadata identities actually consumed by compilation.
    pub metadata_dependencies: Vec<String>,
    /// Snapshot requests that were not complete enough for final output.
    pub unresolved_metadata_requests: Vec<String>,
    /// Whether metadata graph convergence is incomplete.
    pub metadata_incomplete: bool,
    /// Optional explanation artifact.
    pub explain: Option<CompilerExplainArtifact>,
    /// Additional modules for graph-host emission.
    pub artifacts: Vec<CompilerArtifact>,
    /// Optional local statistics.
    pub stats: Option<CompilerStats>,
    /// Immutable compiler/OXC/schema identity used by caches and rollback checks.
    pub compiler_build_id: String,
}

pub(crate) fn request_error_result(error: CompileRequestError) -> CompileResult {
    let code = error.diagnostic_code();
    failed_result(
        code,
        error.to_string(),
        GuaranteeClass::Unsupported,
        Some(REQUEST_HELP),
    )
}

/// Construct a structured result for malformed public input.
#[must_use]
pub fn invalid_request_result(message: impl Into<String>) -> CompileResult {
    failed_result(
        "FICT-REQUEST",
        message,
        GuaranteeClass::Unsupported,
        Some(REQUEST_HELP),
    )
}

pub(crate) fn failed_result(
    code: &'static str,
    message: impl Into<String>,
    guarantee_class: GuaranteeClass,
    help: Option<&'static str>,
) -> CompileResult {
    let mut result = CompileResult::empty();
    let mut finding = Diagnostic::new(
        DiagnosticCode::new(code).expect("compiler diagnostic literals must be valid"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(guarantee_class);
    if let Some(help) = help {
        finding = finding.with_help(help);
    }
    result.diagnostics.push(finding);
    result
}

impl CompileResult {
    /// Construct a result with canonical empty metadata and no side artifacts.
    #[must_use]
    pub fn empty() -> Self {
        Self {
            protocol_version: COMPILER_PROTOCOL_VERSION,
            code: String::new(),
            map: None,
            diagnostics: Vec::new(),
            module_metadata: ModuleReactiveMetadata::new(),
            metadata_dependencies: Vec::new(),
            unresolved_metadata_requests: Vec::new(),
            metadata_incomplete: false,
            explain: None,
            artifacts: Vec::new(),
            stats: None,
            compiler_build_id: COMPILER_BUILD_ID.to_owned(),
        }
    }

    /// Return whether emission must be considered failed.
    #[must_use]
    pub fn has_errors(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
    }
}

#[cfg(test)]
mod tests {
    use fict_diagnostics::SourceSpan;
    use serde_json::json;

    use super::{CompileResult, CompilerArtifact, CompilerArtifactKind, HandlerArtifactMetadata};
    use crate::COMPILER_PROTOCOL_VERSION;

    #[test]
    fn serializes_the_stable_empty_result_shape() {
        let result = CompileResult::empty();
        assert!(!result.has_errors());
        assert_eq!(
            serde_json::to_value(result).expect("serialize result"),
            json!({
                "protocolVersion": COMPILER_PROTOCOL_VERSION,
                "code": "",
                "map": null,
                "diagnostics": [],
                "moduleMetadata": { "version": 1, "exports": {} },
                "metadataDependencies": [],
                "unresolvedMetadataRequests": [],
                "metadataIncomplete": false,
                "explain": null,
                "artifacts": [],
                "stats": null,
                "compilerBuildId": crate::COMPILER_BUILD_ID
            })
        );
    }

    #[test]
    fn serializes_structured_handler_routing_without_host_specific_state() {
        let artifact = CompilerArtifact {
            id: "handler-0".into(),
            kind: CompilerArtifactKind::HandlerModule,
            code: "export default () => 1;\n".into(),
            map: None,
            handler: Some(HandlerArtifactMetadata {
                source_export_name: "__fict_e0".into(),
                artifact_export_name: "default".into(),
                module_specifier: "fict:compiler-artifact:handler-0".into(),
                source_span: SourceSpan::new(10, 17).expect("ordered test span"),
            }),
        };
        assert_eq!(
            serde_json::to_value(artifact).expect("serialize handler artifact"),
            json!({
                "id": "handler-0",
                "kind": "handlerModule",
                "code": "export default () => 1;\n",
                "map": null,
                "handler": {
                    "sourceExportName": "__fict_e0",
                    "artifactExportName": "default",
                    "moduleSpecifier": "fict:compiler-artifact:handler-0",
                    "sourceSpan": { "start": 10, "end": 17 }
                }
            })
        );
    }
}
