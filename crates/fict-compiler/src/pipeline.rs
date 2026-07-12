use std::mem;

use fict_compiler_oxc::{OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, compile_passthrough};
use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_metadata::MetadataResolutionStatus;

use crate::{
    CompileRequest, CompileResult, CompilerExplainArtifact, CompilerExplainEvent,
    CompilerExplainEventKind, ModuleKind, NormalizedCompileRequest, RawSourceMap, SourceLanguage,
};

/// Execute the currently connected native pipeline and return a complete result.
#[must_use]
pub fn compile(request: CompileRequest) -> CompileResult {
    match request.normalize() {
        Ok(request) => compile_normalized(request),
        Err(error) => invalid_request_result(error.to_string()),
    }
}

/// Construct a structured result for malformed public input.
#[must_use]
pub fn invalid_request_result(message: impl Into<String>) -> CompileResult {
    failed_result(
        "FICT-REQUEST",
        message,
        GuaranteeClass::Unsupported,
        Some("fix the request shape before invoking the native compiler"),
    )
}

/// Construct the generic result returned when the N-API panic boundary fires.
#[must_use]
pub fn internal_error_result() -> CompileResult {
    failed_result(
        "FICT-I001",
        "the native compiler encountered an internal error",
        GuaranteeClass::Internal,
        Some("retry with the legacy backend for the entire build and report the failing fixture"),
    )
}

fn compile_normalized(request: NormalizedCompileRequest) -> CompileResult {
    let mut result = CompileResult::empty();
    result.diagnostics = request.integration_diagnostics.clone();

    if request.input_source_map.is_some() {
        result.diagnostics.push(
            diagnostic(
                "FICT-SOURCEMAP-COMPOSE",
                DiagnosticSeverity::Error,
                "input source-map composition is not connected in the M1 pipeline",
                GuaranteeClass::Unsupported,
            )
            .with_help(
                "omit inputSourceMap or use the legacy backend until composition is enabled",
            ),
        );
    }

    for metadata in &request.metadata {
        if metadata.status == MetadataResolutionStatus::IncompleteCycle {
            result.metadata_incomplete = true;
            result
                .unresolved_metadata_requests
                .push(metadata.request.clone());
        }
    }
    result.unresolved_metadata_requests.sort();
    result.unresolved_metadata_requests.dedup();
    if result.metadata_incomplete {
        result.diagnostics.push(
            diagnostic(
                "FICT-METADATA-INCOMPLETE",
                DiagnosticSeverity::Error,
                "resolved metadata snapshot contains an incomplete module cycle",
                GuaranteeClass::Fallback,
            )
            .with_help("let the bundler graph converge before compiling this module"),
        );
    }

    finalize_diagnostics(&mut result);
    if result.has_errors() {
        attach_explain_if_requested(&mut result, &request);
        return result;
    }

    let output = compile_passthrough(
        &request.code,
        &request.filename,
        OxcCompileOptions {
            language: oxc_language(request.language),
            module_kind: oxc_module_kind(request.module_kind),
            sourcemap: request.options.sourcemap,
        },
    );
    result.diagnostics.extend(output.diagnostics);
    finalize_diagnostics(&mut result);

    if !result.has_errors() {
        result.code = output.code;
        if let Some(source_map_json) = output.source_map_json {
            match serde_json::from_str::<RawSourceMap>(&source_map_json)
                .map_err(|error| error.to_string())
                .and_then(|map| {
                    map.validate()
                        .map(|()| map)
                        .map_err(|error| error.to_string())
                }) {
                Ok(map) => result.map = Some(map),
                Err(error) => result.diagnostics.push(
                    diagnostic(
                        "FICT-I002",
                        DiagnosticSeverity::Error,
                        format!("OXC emitted an invalid source map: {error}"),
                        GuaranteeClass::Internal,
                    )
                    .with_help("report the source-map fixture; partial output was discarded"),
                ),
            }
        }
    }

    finalize_diagnostics(&mut result);
    if result.has_errors() {
        result.code.clear();
        result.map = None;
    }
    attach_explain_if_requested(&mut result, &request);
    result
}

fn oxc_language(language: SourceLanguage) -> OxcSourceLanguage {
    match language {
        SourceLanguage::JavaScript => OxcSourceLanguage::JavaScript,
        SourceLanguage::JavaScriptJsx => OxcSourceLanguage::JavaScriptJsx,
        SourceLanguage::TypeScript => OxcSourceLanguage::TypeScript,
        SourceLanguage::TypeScriptJsx => OxcSourceLanguage::TypeScriptJsx,
    }
}

fn oxc_module_kind(module_kind: ModuleKind) -> OxcModuleKind {
    match module_kind {
        ModuleKind::Module => OxcModuleKind::Module,
        ModuleKind::Script => OxcModuleKind::Script,
        ModuleKind::CommonJs => OxcModuleKind::CommonJs,
        ModuleKind::Unambiguous => OxcModuleKind::Unambiguous,
    }
}

fn failed_result(
    code: &'static str,
    message: impl Into<String>,
    guarantee_class: GuaranteeClass,
    help: Option<&'static str>,
) -> CompileResult {
    let mut result = CompileResult::empty();
    let mut finding = diagnostic(code, DiagnosticSeverity::Error, message, guarantee_class);
    if let Some(help) = help {
        finding = finding.with_help(help);
    }
    result.diagnostics.push(finding);
    result
}

fn diagnostic(
    code: &'static str,
    severity: DiagnosticSeverity,
    message: impl Into<String>,
    guarantee_class: GuaranteeClass,
) -> Diagnostic {
    Diagnostic::new(static_code(code), severity, message).with_guarantee_class(guarantee_class)
}

fn static_code(value: &'static str) -> DiagnosticCode {
    DiagnosticCode::new(value).expect("compiler diagnostic literals must be valid")
}

fn finalize_diagnostics(result: &mut CompileResult) {
    result.diagnostics = DiagnosticBundle::new(mem::take(&mut result.diagnostics)).into_sorted();
}

fn attach_explain_if_requested(result: &mut CompileResult, request: &NormalizedCompileRequest) {
    if !request.options.explain {
        return;
    }
    result.explain = Some(CompilerExplainArtifact {
        version: 1,
        file_name: request.filename.clone(),
        helpers: Vec::new(),
        diagnostics: result.diagnostics.clone(),
        events: result
            .diagnostics
            .iter()
            .map(|finding| CompilerExplainEvent {
                kind: CompilerExplainEventKind::Diagnostic,
                message: finding.message.clone(),
                name: None,
                code: Some(finding.code.to_string()),
                span: finding.primary_span,
            })
            .collect(),
    });
}

#[cfg(test)]
mod tests {
    use super::{compile, internal_error_result};
    use crate::{COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions};

    fn request(code: &str, filename: &str) -> CompileRequest {
        CompileRequest {
            protocol_version: COMPILER_PROTOCOL_VERSION,
            code: code.to_owned(),
            filename: filename.to_owned(),
            module_id: None,
            language: None,
            module_kind: None,
            input_source_map: None,
            options: CompilerOptions::default(),
            metadata: Vec::new(),
            integration_diagnostics: Vec::new(),
        }
    }

    #[test]
    fn compiles_empty_plain_javascript_and_plain_typescript() {
        let empty = compile(request("", "empty.js"));
        assert!(!empty.has_errors());
        assert!(empty.code.is_empty());

        let javascript = compile(request("export const value = 1", "value.js"));
        assert!(!javascript.has_errors());
        assert!(javascript.code.contains("export const value = 1"));

        let typescript = compile(request("export const value: number = 1", "value.ts"));
        assert!(!typescript.has_errors());
        assert!(typescript.code.contains("export const value = 1"));
        assert!(!typescript.code.contains(": number"));
    }

    #[test]
    fn returns_parser_errors_and_never_emits_partial_code() {
        let result = compile(request("export const =", "broken.ts"));
        assert!(result.has_errors());
        assert!(result.code.is_empty());
        assert_eq!(result.diagnostics[0].code.as_str(), "FICT-PARSE");
        assert!(result.diagnostics[0].primary_span.is_some());
    }

    #[test]
    fn emits_source_maps_and_explanations_only_when_requested() {
        let mut input = request("export const value: number = 1", "value.ts");
        input.options.sourcemap = true;
        input.options.explain = true;
        let result = compile(input);

        assert!(!result.has_errors());
        let map = result.map.expect("source map");
        assert_eq!(map.version, 3);
        assert_eq!(map.sources, ["value.ts"]);
        assert!(result.explain.is_some());
    }

    #[test]
    fn creates_stable_internal_error_results() {
        let result = internal_error_result();
        assert!(result.has_errors());
        assert_eq!(result.diagnostics[0].code.as_str(), "FICT-I001");
        assert!(result.code.is_empty());
    }
}
