use std::collections::BTreeMap;

use fict_diagnostics::{Diagnostic, DiagnosticSeverity, SourceSpan};
use fict_metadata::ModuleReactiveMetadata;
use serde::{Deserialize, Serialize};

use crate::{COMPILER_PROTOCOL_VERSION, RawSourceMap};

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

impl CompileResult {
    /// Construct a result with canonical empty metadata and no side artifacts.
    #[must_use]
    pub fn empty(compiler_build_id: impl Into<String>) -> Self {
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
            compiler_build_id: compiler_build_id.into(),
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
    use serde_json::json;

    use super::CompileResult;
    use crate::COMPILER_PROTOCOL_VERSION;

    #[test]
    fn serializes_the_stable_empty_result_shape() {
        let result = CompileResult::empty("fict:test-build");
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
                "compilerBuildId": "fict:test-build"
            })
        );
    }
}
