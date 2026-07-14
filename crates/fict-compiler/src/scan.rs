use fict_compiler_oxc::{
    OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, OxcTypeScriptOptions,
    ScanModuleRequest as OxcScanModuleRequest, ScanModuleRequestKind as OxcScanModuleRequestKind,
    scan_static_module_requests,
};
use fict_diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use serde::{Deserialize, Serialize};

use crate::{
    COMPILER_BUILD_ID, COMPILER_PROTOCOL_VERSION, ModuleKind, NormalizedScanRequest, ScanRequest,
    SourceLanguage,
};

/// Static module-request category returned to bundler graph hosts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanModuleRequestKind {
    /// ECMAScript import declaration, including side-effect imports.
    Import,
    /// Re-export with a module source.
    ReExport,
    /// TypeScript external import-equals declaration.
    ImportEquals,
}

/// One static module request in authored order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanModuleRequest {
    /// Exact unescaped module specifier.
    pub source: String,
    /// Syntactic request category.
    pub kind: ScanModuleRequestKind,
    /// Whether the whole declaration is explicitly type-only.
    pub type_only: bool,
    /// String-literal source span as a half-open UTF-8 byte range.
    pub span: SourceSpan,
}

/// Complete parse-only result returned by sync and async native scan entrypoints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    /// Result protocol version.
    pub protocol_version: u32,
    /// Static requests in source order. Duplicate specifiers are retained.
    pub module_requests: Vec<ScanModuleRequest>,
    /// Whether ECMAScript module syntax was observed.
    pub has_module_syntax: bool,
    /// Structured parser/request diagnostics.
    pub diagnostics: Vec<Diagnostic>,
    /// Immutable compiler/OXC/schema identity used by caches and rollback checks.
    pub compiler_build_id: String,
}

impl ScanResult {
    /// Construct a canonical empty successful result.
    #[must_use]
    pub fn empty() -> Self {
        Self {
            protocol_version: COMPILER_PROTOCOL_VERSION,
            module_requests: Vec::new(),
            has_module_syntax: false,
            diagnostics: Vec::new(),
            compiler_build_id: COMPILER_BUILD_ID.to_owned(),
        }
    }

    /// Return whether scan failed and its partial graph data must not be consumed.
    #[must_use]
    pub fn has_errors(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
    }
}

/// Scan static import, re-export, and import-equals requests without running compiler passes.
#[must_use]
pub fn scan(request: ScanRequest) -> ScanResult {
    match request.normalize() {
        Ok(request) => scan_normalized(request),
        Err(error) => invalid_scan_request_result(error.to_string()),
    }
}

/// Construct the structured result returned for malformed scan input.
#[must_use]
pub fn invalid_scan_request_result(message: impl Into<String>) -> ScanResult {
    failed_scan_result(
        "FICT-REQUEST",
        message,
        GuaranteeClass::Unsupported,
        Some("fix the request shape before invoking the native scanner"),
    )
}

/// Construct the generic result returned when the N-API scan panic boundary fires.
#[must_use]
pub fn internal_scan_error_result() -> ScanResult {
    failed_scan_result(
        "FICT-I001",
        "the native compiler scanner encountered an internal error",
        GuaranteeClass::Internal,
        Some("retry the build with the legacy module scanner and report the failing fixture"),
    )
}

fn scan_normalized(request: NormalizedScanRequest) -> ScanResult {
    let output = scan_static_module_requests(
        &request.code,
        OxcCompileOptions {
            language: oxc_language(request.language),
            module_kind: oxc_module_kind(request.module_kind),
            typescript: OxcTypeScriptOptions::default(),
            sourcemap: false,
        },
    );

    ScanResult {
        protocol_version: request.protocol_version,
        module_requests: output
            .module_requests
            .into_iter()
            .map(convert_module_request)
            .collect(),
        has_module_syntax: output.has_module_syntax,
        diagnostics: output.diagnostics,
        compiler_build_id: COMPILER_BUILD_ID.to_owned(),
    }
}

fn convert_module_request(request: OxcScanModuleRequest) -> ScanModuleRequest {
    ScanModuleRequest {
        source: request.source,
        kind: match request.kind {
            OxcScanModuleRequestKind::Import => ScanModuleRequestKind::Import,
            OxcScanModuleRequestKind::ReExport => ScanModuleRequestKind::ReExport,
            OxcScanModuleRequestKind::ImportEquals => ScanModuleRequestKind::ImportEquals,
        },
        type_only: request.type_only,
        span: request.span,
    }
}

const fn oxc_language(language: SourceLanguage) -> OxcSourceLanguage {
    match language {
        SourceLanguage::JavaScript => OxcSourceLanguage::JavaScript,
        SourceLanguage::JavaScriptJsx => OxcSourceLanguage::JavaScriptJsx,
        SourceLanguage::TypeScript => OxcSourceLanguage::TypeScript,
        SourceLanguage::TypeScriptJsx => OxcSourceLanguage::TypeScriptJsx,
    }
}

const fn oxc_module_kind(module_kind: ModuleKind) -> OxcModuleKind {
    match module_kind {
        ModuleKind::Module => OxcModuleKind::Module,
        ModuleKind::Script => OxcModuleKind::Script,
        ModuleKind::CommonJs => OxcModuleKind::CommonJs,
        ModuleKind::Unambiguous => OxcModuleKind::Unambiguous,
    }
}

fn failed_scan_result(
    code: &'static str,
    message: impl Into<String>,
    guarantee_class: GuaranteeClass,
    help: Option<&'static str>,
) -> ScanResult {
    let mut result = ScanResult::empty();
    let mut diagnostic = Diagnostic::new(
        DiagnosticCode::new(code).expect("scan diagnostic literals must be valid"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(guarantee_class);
    if let Some(help) = help {
        diagnostic = diagnostic.with_help(help);
    }
    result.diagnostics.push(diagnostic);
    result
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{ScanModuleRequestKind, ScanResult, scan};
    use crate::{COMPILER_BUILD_ID, COMPILER_PROTOCOL_VERSION, ScanRequest};

    fn request(code: &str, filename: &str) -> ScanRequest {
        ScanRequest {
            protocol_version: COMPILER_PROTOCOL_VERSION,
            code: code.to_owned(),
            filename: filename.to_owned(),
            module_id: None,
            language: None,
            module_kind: None,
        }
    }

    #[test]
    fn scans_owned_static_module_requests_and_preserves_identity_normalization() {
        let mut input = request(
            "import './setup'; export * from './dep'; import legacy = require('./legacy');",
            "/src/module.ts?worker#client",
        );
        input.module_id = Some("/@id/module.ts?worker#client".into());
        let result = scan(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.has_module_syntax);
        assert_eq!(result.compiler_build_id, COMPILER_BUILD_ID);
        assert_eq!(
            result
                .module_requests
                .iter()
                .map(|request| (request.source.as_str(), request.kind))
                .collect::<Vec<_>>(),
            vec![
                ("./setup", ScanModuleRequestKind::Import),
                ("./dep", ScanModuleRequestKind::ReExport),
                ("./legacy", ScanModuleRequestKind::ImportEquals),
            ]
        );
    }

    #[test]
    fn returns_stable_request_and_parser_diagnostics() {
        let malformed = scan(request("import {", "module.ts"));
        assert!(malformed.has_errors());
        assert_eq!(malformed.diagnostics[0].code.as_str(), "FICT-PARSE");
        assert!(malformed.module_requests.is_empty());

        let mut unsupported = request("", "module.ts");
        unsupported.protocol_version += 1;
        let unsupported = scan(unsupported);
        assert!(unsupported.has_errors());
        assert_eq!(unsupported.diagnostics[0].code.as_str(), "FICT-REQUEST");
    }

    #[test]
    fn serializes_the_stable_empty_scan_shape() {
        assert_eq!(
            serde_json::to_value(ScanResult::empty()).expect("serialize result"),
            json!({
                "protocolVersion": COMPILER_PROTOCOL_VERSION,
                "moduleRequests": [],
                "hasModuleSyntax": false,
                "diagnostics": [],
                "compilerBuildId": COMPILER_BUILD_ID,
            })
        );
    }
}
