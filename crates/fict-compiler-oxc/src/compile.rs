use std::path::{Path, PathBuf};

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use oxc::{
    allocator::Allocator,
    codegen::{Codegen, CodegenOptions},
    diagnostics::{OxcDiagnostic, Severity},
    parser::{ParseOptions, Parser},
    semantic::SemanticBuilder,
    span::SourceType,
    transformer::{JsxOptions, Module, TransformOptions, Transformer},
};

/// Source grammar supplied by the Fict orchestration layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OxcSourceLanguage {
    /// JavaScript without JSX.
    JavaScript,
    /// JavaScript with JSX.
    JavaScriptJsx,
    /// TypeScript without JSX.
    TypeScript,
    /// TypeScript with JSX.
    TypeScriptJsx,
}

/// Module grammar supplied by the Fict orchestration layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OxcModuleKind {
    /// ECMAScript module.
    Module,
    /// Classic script.
    Script,
    /// CommonJS/CTS.
    CommonJs,
    /// OXC syntax-based module/script inference.
    Unambiguous,
}

/// M1 OXC frontend/codegen options for syntax-only pass-through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OxcCompileOptions {
    /// Source grammar.
    pub language: OxcSourceLanguage,
    /// Module grammar.
    pub module_kind: OxcModuleKind,
    /// Emit a Source Map v3 JSON payload.
    pub sourcemap: bool,
}

/// Arena-independent output returned to the compiler orchestrator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OxcCompileOutput {
    /// Generated JavaScript, empty when diagnostics prevent emission.
    pub code: String,
    /// Source Map v3 JSON, when requested and emission succeeds.
    pub source_map_json: Option<String>,
    /// Owned structured diagnostics.
    pub diagnostics: Vec<Diagnostic>,
}

/// Parse, run semantic checks, strip ordinary TypeScript, and generate code.
///
/// JSX is parsed for accurate diagnostics but deliberately rejected until the
/// Fict-owned JSX lowering pipeline is connected. No OXC React transform runs.
#[must_use]
pub fn compile_passthrough(
    source: &str,
    filename: &str,
    options: OxcCompileOptions,
) -> OxcCompileOutput {
    let allocator = Allocator::default();
    let source_type = source_type(options);
    let parsed = Parser::new(&allocator, source, source_type)
        .with_options(ParseOptions {
            allow_return_outside_function: options.module_kind == OxcModuleKind::CommonJs,
            ..ParseOptions::default()
        })
        .parse();

    if !parsed.diagnostics.is_empty() {
        return failed_output(convert_diagnostics(parsed.diagnostics, "FICT-PARSE"));
    }

    let mut program = parsed.program;
    let semantic = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .with_enum_eval(true)
        .build(&program);
    let semantic_has_errors = semantic.diagnostics.has_errors();
    let semantic_diagnostics = convert_diagnostics(semantic.diagnostics, "FICT-SEMANTIC");
    if semantic_has_errors {
        return failed_output(semantic_diagnostics);
    }

    if source_type.is_jsx() {
        let mut diagnostics = semantic_diagnostics;
        diagnostics.push(
            Diagnostic::new(
                static_code("FICT-NATIVE-JSX"),
                DiagnosticSeverity::Error,
                "native JSX lowering is not connected in the M1 pass-through pipeline",
            )
            .with_help("use the legacy backend until the Fict EmitIR JSX pipeline is enabled")
            .with_guarantee_class(GuaranteeClass::Unsupported),
        );
        return failed_output(diagnostics);
    }

    let path = Path::new(filename);
    let mut transform_options = TransformOptions {
        jsx: JsxOptions::disable(),
        ..TransformOptions::default()
    };
    if options.module_kind == OxcModuleKind::CommonJs {
        transform_options.env.module = Module::CommonJS;
    }
    let transformed = Transformer::new(&allocator, path, &transform_options)
        .build_with_scoping(semantic.semantic.into_scoping(), &mut program);
    let transform_has_errors = transformed.diagnostics.has_errors();
    let mut diagnostics = semantic_diagnostics;
    diagnostics.extend(convert_diagnostics(
        transformed.diagnostics,
        "FICT-TRANSFORM",
    ));
    if transform_has_errors {
        return failed_output(diagnostics);
    }

    let generated = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: options.sourcemap.then(|| PathBuf::from(filename)),
            ..CodegenOptions::default()
        })
        .with_source_text(source)
        .with_source_type(source_type)
        .with_scoping(Some(transformed.scoping))
        .build(&program);

    OxcCompileOutput {
        code: generated.code,
        source_map_json: generated.map.map(|map| map.to_json_string()),
        diagnostics: sorted(diagnostics),
    }
}

fn source_type(options: OxcCompileOptions) -> SourceType {
    let language = match options.language {
        OxcSourceLanguage::JavaScript => SourceType::mjs(),
        OxcSourceLanguage::JavaScriptJsx => SourceType::jsx(),
        OxcSourceLanguage::TypeScript => SourceType::ts(),
        OxcSourceLanguage::TypeScriptJsx => SourceType::tsx(),
    };

    match options.module_kind {
        OxcModuleKind::Module => language.with_module(true),
        OxcModuleKind::Script => language.with_script(true),
        OxcModuleKind::CommonJs => language.with_commonjs(true),
        OxcModuleKind::Unambiguous => language.with_unambiguous(true),
    }
}

fn failed_output(diagnostics: Vec<Diagnostic>) -> OxcCompileOutput {
    OxcCompileOutput {
        code: String::new(),
        source_map_json: None,
        diagnostics: sorted(diagnostics),
    }
}

fn sorted(diagnostics: Vec<Diagnostic>) -> Vec<Diagnostic> {
    DiagnosticBundle::new(diagnostics).into_sorted()
}

fn convert_diagnostics(
    diagnostics: impl IntoIterator<Item = OxcDiagnostic>,
    code: &'static str,
) -> Vec<Diagnostic> {
    diagnostics
        .into_iter()
        .map(|diagnostic| convert_diagnostic(diagnostic, code))
        .collect()
}

fn convert_diagnostic(diagnostic: OxcDiagnostic, code: &'static str) -> Diagnostic {
    let severity = match diagnostic.severity {
        Severity::Error => DiagnosticSeverity::Error,
        Severity::Warning => DiagnosticSeverity::Warning,
        Severity::Advice => DiagnosticSeverity::Info,
    };
    let labels: Vec<_> = diagnostic.labels.iter().collect();
    let primary_index = labels.iter().position(|label| label.primary()).unwrap_or(0);
    let mut converted =
        Diagnostic::new(static_code(code), severity, diagnostic.message.to_string())
            .with_guarantee_class(GuaranteeClass::Unsupported);

    if let Some(primary) = labels.get(primary_index)
        && let Some(span) = convert_span(primary.offset(), primary.len())
    {
        converted = converted.with_primary_span(span);
        if let Some(label) = primary.label() {
            converted = converted.with_note(label);
        }
    }
    for (index, label) in labels.into_iter().enumerate() {
        if index == primary_index {
            continue;
        }
        if let Some(span) = convert_span(label.offset(), label.len()) {
            converted = converted.with_secondary_label(span, label.label().unwrap_or("related"));
        }
    }
    if let Some(help) = diagnostic.help.as_deref() {
        converted = converted.with_help(help);
    }
    if let Some(note) = diagnostic.note.as_deref() {
        converted = converted.with_note(note);
    }
    if diagnostic.code.is_some() {
        converted = converted.with_note(format!("OXC diagnostic: {}", diagnostic.code));
    }
    converted
}

fn convert_span(start: u32, length: u32) -> Option<SourceSpan> {
    let end = start.checked_add(length)?;
    SourceSpan::new(start, end)
}

fn static_code(value: &'static str) -> DiagnosticCode {
    DiagnosticCode::new(value).expect("compiler diagnostic literals must be valid")
}

#[cfg(test)]
mod tests {
    use super::{OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, compile_passthrough};

    fn options(language: OxcSourceLanguage) -> OxcCompileOptions {
        OxcCompileOptions {
            language,
            module_kind: OxcModuleKind::Module,
            sourcemap: false,
        }
    }

    #[test]
    fn strips_plain_typescript_and_preserves_plain_javascript() {
        let typescript = compile_passthrough(
            "export const value: number = 1;",
            "value.ts",
            options(OxcSourceLanguage::TypeScript),
        );
        assert!(typescript.diagnostics.is_empty());
        assert!(typescript.code.contains("export const value = 1"));
        assert!(!typescript.code.contains(": number"));

        let javascript = compile_passthrough(
            "export const value = 1;",
            "value.js",
            options(OxcSourceLanguage::JavaScript),
        );
        assert!(javascript.diagnostics.is_empty());
        assert!(javascript.code.contains("export const value = 1"));
    }

    #[test]
    fn returns_structured_parser_errors_without_output() {
        let output = compile_passthrough(
            "export const = ;",
            "broken.ts",
            options(OxcSourceLanguage::TypeScript),
        );
        assert!(output.code.is_empty());
        assert_eq!(output.diagnostics[0].code.as_str(), "FICT-PARSE");
        assert!(output.diagnostics[0].primary_span.is_some());
    }

    #[test]
    fn parses_but_refuses_to_emit_jsx_before_fict_lowering() {
        let output = compile_passthrough(
            "export const view = <div />;",
            "view.tsx",
            options(OxcSourceLanguage::TypeScriptJsx),
        );
        assert!(output.code.is_empty());
        assert_eq!(output.diagnostics[0].code.as_str(), "FICT-NATIVE-JSX");
    }
}
