use fict_diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use oxc::{
    allocator::Allocator,
    ast::ast::{ImportOrExportKind, Statement, TSModuleReference},
    parser::{ParseOptions, Parser},
    span::Span,
};

use crate::{OxcCompileOptions, OxcModuleKind};

use super::compile::{convert_diagnostics, sorted, source_type};

/// Static module-request syntax recognized by the graph-host scan API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ScanModuleRequestKind {
    /// ECMAScript import declaration, including a side-effect-only import.
    Import,
    /// Named, namespace, or star re-export with a module source.
    ReExport,
    /// TypeScript `import value = require("source")`.
    ImportEquals,
}

/// Arena-independent static module request in authored source order.
#[derive(Debug, Clone, PartialEq, Eq)]
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

/// Owned scan output safe to retain after the OXC arena is released.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OxcScanOutput {
    /// Static module requests in authored order. Duplicates are retained.
    pub module_requests: Vec<ScanModuleRequest>,
    /// Whether the parser observed ECMAScript module syntax.
    pub has_module_syntax: bool,
    /// Structured parser or resource-limit diagnostics.
    pub diagnostics: Vec<Diagnostic>,
}

/// Parse only enough syntax to discover graph-host-owned static module edges.
///
/// Dynamic imports are intentionally excluded. The result owns every string and span, so no OXC
/// arena data crosses the adapter boundary.
#[must_use]
pub fn scan_static_module_requests(source: &str, options: OxcCompileOptions) -> OxcScanOutput {
    if u32::try_from(source.len()).is_err() {
        return failed_scan(vec![
            Diagnostic::new(
                diagnostic_code("FICT-SOURCE-LIMIT"),
                DiagnosticSeverity::Error,
                "source exceeds the native compiler's 32-bit byte-offset limit",
            )
            .with_guarantee_class(GuaranteeClass::Unsupported),
        ]);
    }

    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type(options))
        .with_options(ParseOptions {
            allow_return_outside_function: options.module_kind == OxcModuleKind::CommonJs,
            ..ParseOptions::default()
        })
        .parse();
    if !parsed.diagnostics.is_empty() {
        return failed_scan(convert_diagnostics(parsed.diagnostics, "FICT-PARSE"));
    }

    let has_module_syntax = parsed.module_record.has_module_syntax;
    let mut module_requests = Vec::new();
    for statement in &parsed.program.body {
        match statement {
            Statement::ImportDeclaration(declaration) => {
                module_requests.push(ScanModuleRequest {
                    source: declaration.source.value.to_string(),
                    kind: ScanModuleRequestKind::Import,
                    type_only: declaration.import_kind == ImportOrExportKind::Type,
                    span: source_span(declaration.source.span),
                });
            }
            Statement::ExportNamedDeclaration(declaration) => {
                let Some(source) = &declaration.source else {
                    continue;
                };
                module_requests.push(ScanModuleRequest {
                    source: source.value.to_string(),
                    kind: ScanModuleRequestKind::ReExport,
                    type_only: declaration.export_kind == ImportOrExportKind::Type,
                    span: source_span(source.span),
                });
            }
            Statement::ExportAllDeclaration(declaration) => {
                module_requests.push(ScanModuleRequest {
                    source: declaration.source.value.to_string(),
                    kind: ScanModuleRequestKind::ReExport,
                    type_only: declaration.export_kind == ImportOrExportKind::Type,
                    span: source_span(declaration.source.span),
                });
            }
            Statement::TSImportEqualsDeclaration(declaration) => {
                let TSModuleReference::ExternalModuleReference(reference) =
                    &declaration.module_reference
                else {
                    continue;
                };
                module_requests.push(ScanModuleRequest {
                    source: reference.expression.value.to_string(),
                    kind: ScanModuleRequestKind::ImportEquals,
                    type_only: declaration.import_kind == ImportOrExportKind::Type,
                    span: source_span(reference.expression.span),
                });
            }
            _ => {}
        }
    }

    OxcScanOutput {
        module_requests,
        has_module_syntax,
        diagnostics: Vec::new(),
    }
}

fn failed_scan(diagnostics: Vec<Diagnostic>) -> OxcScanOutput {
    OxcScanOutput {
        module_requests: Vec::new(),
        has_module_syntax: false,
        diagnostics: sorted(diagnostics),
    }
}

fn source_span(span: Span) -> SourceSpan {
    SourceSpan::new(span.start, span.end).unwrap_or_else(|| SourceSpan::empty(span.start))
}

fn diagnostic_code(value: &'static str) -> DiagnosticCode {
    DiagnosticCode::new(value).expect("scan diagnostic literals must be valid")
}

#[cfg(test)]
mod tests {
    use super::{ScanModuleRequestKind, scan_static_module_requests};
    use crate::{OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, OxcTypeScriptOptions};

    fn options(language: OxcSourceLanguage, module_kind: OxcModuleKind) -> OxcCompileOptions {
        OxcCompileOptions {
            language,
            module_kind,
            typescript: OxcTypeScriptOptions::default(),
            sourcemap: false,
        }
    }

    #[test]
    fn scans_import_reexport_and_import_equals_in_source_order() {
        let output = scan_static_module_requests(
            r#"
                import "./setup";
                import type { Model } from "./model";
                import { value } from "./dep";
                export { value as renamed } from "./reexport";
                export type { Shape } from "./shape";
                export * from "./star";
                export type * from "./type-star";
                import legacy = require("./legacy");
                import type hidden = require("./hidden");
                import("./dynamic");
            "#,
            options(OxcSourceLanguage::TypeScript, OxcModuleKind::Module),
        );

        assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
        assert!(output.has_module_syntax);
        assert_eq!(
            output
                .module_requests
                .iter()
                .map(|request| (request.source.as_str(), request.kind, request.type_only))
                .collect::<Vec<_>>(),
            vec![
                ("./setup", ScanModuleRequestKind::Import, false),
                ("./model", ScanModuleRequestKind::Import, true),
                ("./dep", ScanModuleRequestKind::Import, false),
                ("./reexport", ScanModuleRequestKind::ReExport, false),
                ("./shape", ScanModuleRequestKind::ReExport, true),
                ("./star", ScanModuleRequestKind::ReExport, false),
                ("./type-star", ScanModuleRequestKind::ReExport, true),
                ("./legacy", ScanModuleRequestKind::ImportEquals, false),
                ("./hidden", ScanModuleRequestKind::ImportEquals, true),
            ]
        );
        assert!(
            output
                .module_requests
                .iter()
                .all(|request| request.span.start() < request.span.end())
        );
    }

    #[test]
    fn returns_structured_parser_errors_without_partial_edges() {
        let output = scan_static_module_requests(
            "import { from './broken'; import './unsafe-partial';",
            options(OxcSourceLanguage::JavaScript, OxcModuleKind::Module),
        );

        assert!(output.module_requests.is_empty());
        assert!(!output.has_module_syntax);
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == "FICT-PARSE")
        );
    }

    #[test]
    fn allows_commonjs_top_level_return_during_cts_scans() {
        let output = scan_static_module_requests(
            "import dep = require('./dep'); return dep;",
            options(OxcSourceLanguage::TypeScript, OxcModuleKind::CommonJs),
        );

        assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
        assert_eq!(output.module_requests.len(), 1);
        assert_eq!(
            output.module_requests[0].kind,
            ScanModuleRequestKind::ImportEquals
        );
    }
}
