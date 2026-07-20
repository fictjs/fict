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

use crate::commonjs::lower_standard_esm_to_commonjs;
use crate::typescript::{
    configure_transform, passthrough_blockers, plan_typescript_program,
    rewrite_import_equals_extensions,
};
use crate::typescript_namespace::lower_namespace_compatibility;

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
    /// TypeScript compatibility controls.
    pub typescript: crate::OxcTypeScriptOptions,
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
    /// Standalone Preview handler modules emitted from the same in-memory OXC program.
    pub handler_artifacts: Vec<OxcHandlerArtifact>,
    /// Runtime helper keys whose imports remain in the emitted module.
    pub runtime_helpers: Vec<String>,
    /// Owned structured diagnostics.
    pub diagnostics: Vec<Diagnostic>,
}

/// Arena-independent handler module returned by OXC code generation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OxcHandlerArtifact {
    pub id: String,
    pub code: String,
    pub source_map_json: Option<String>,
    pub source_export_name: String,
    pub artifact_export_name: String,
    pub module_specifier: String,
    pub source_span: SourceSpan,
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
    compile_syntax(source, filename, options, false)
}

/// Parse, strip ordinary TypeScript, and preserve authored JSX when Fict compilation is disabled.
#[must_use]
pub fn compile_disabled(
    source: &str,
    filename: &str,
    options: OxcCompileOptions,
) -> OxcCompileOutput {
    compile_syntax(source, filename, options, true)
}

fn compile_syntax(
    source: &str,
    filename: &str,
    options: OxcCompileOptions,
    preserve_jsx: bool,
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

    if source_type.is_jsx() && !preserve_jsx {
        let mut diagnostics = semantic_diagnostics;
        diagnostics.push(
            Diagnostic::new(
                static_code("FICT-NATIVE-JSX"),
                DiagnosticSeverity::Error,
                "the syntax-only OXC pass-through entrypoint does not lower JSX",
            )
            .with_help("route JSX through the complete Fict EmitIR pipeline")
            .with_guarantee_class(GuaranteeClass::Unsupported),
        );
        return failed_output(diagnostics);
    }

    let typescript_plan = source_type.is_typescript().then(|| {
        plan_typescript_program(
            &program,
            semantic.semantic.scoping(),
            options.module_kind,
            &options.typescript,
        )
    });
    if let Some(plan) = &typescript_plan {
        let blockers = passthrough_blockers(plan);
        if !blockers.is_empty() {
            let mut diagnostics = semantic_diagnostics;
            diagnostics.extend(blockers);
            return failed_output(diagnostics);
        }
    }
    let mut diagnostics = semantic_diagnostics;
    let mut scoping = semantic.semantic.into_scoping();
    if let Some(plan) = &typescript_plan {
        let compatibility = lower_namespace_compatibility(&allocator, &mut program, &scoping, plan);
        let compatibility_failed = !compatibility.diagnostics.is_empty();
        diagnostics.extend(compatibility.diagnostics);
        if compatibility_failed {
            return failed_output(diagnostics);
        }
        if compatibility.changed {
            let rebuilt = SemanticBuilder::new()
                .with_check_syntax_error(true)
                .with_enum_eval(true)
                .build(&program);
            let rebuild_failed = rebuilt.diagnostics.has_errors();
            diagnostics.extend(convert_diagnostics(
                rebuilt.diagnostics,
                "FICT-SEMANTIC-POST-COMPAT",
            ));
            if rebuild_failed {
                return failed_output(diagnostics);
            }
            scoping = rebuilt.semantic.into_scoping();
        }
    }

    let path = Path::new(filename);
    let mut transform_options = TransformOptions {
        jsx: JsxOptions::disable(),
        ..TransformOptions::default()
    };
    if options.module_kind == OxcModuleKind::CommonJs {
        transform_options.env.module = Module::CommonJS;
    }
    if let Some(plan) = &typescript_plan {
        configure_transform(plan, &options.typescript, &mut transform_options);
    }
    if options.typescript.rewrite_import_extensions {
        rewrite_import_equals_extensions(&allocator, &mut program);
    }
    let transformed = Transformer::new(&allocator, path, &transform_options)
        .build_with_scoping(scoping, &mut program);
    let transform_has_errors = transformed.diagnostics.has_errors();
    let transformed_scoping = transformed.scoping;
    diagnostics.extend(convert_diagnostics(
        transformed.diagnostics,
        "FICT-TRANSFORM",
    ));
    if transform_has_errors {
        return failed_output(diagnostics);
    }
    if options.module_kind == OxcModuleKind::CommonJs
        && let Err(diagnostic) =
            lower_standard_esm_to_commonjs(&allocator, &mut program, transformed_scoping)
    {
        diagnostics.push(*diagnostic);
        return failed_output(diagnostics);
    }

    let rebuilt = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .with_enum_eval(true)
        .build(&program);
    let rebuilt_has_errors = rebuilt.diagnostics.has_errors();
    diagnostics.extend(convert_diagnostics(
        rebuilt.diagnostics,
        "FICT-SEMANTIC-POST-TS",
    ));
    if rebuilt_has_errors {
        return failed_output(diagnostics);
    }

    let generated = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: options.sourcemap.then(|| PathBuf::from(filename)),
            ..CodegenOptions::default()
        })
        .with_source_text(source)
        .with_source_type(source_type)
        .with_scoping(Some(rebuilt.semantic.into_scoping()))
        .build(&program);

    OxcCompileOutput {
        code: generated.code,
        source_map_json: generated.map.map(|map| map.to_json_string()),
        handler_artifacts: Vec::new(),
        runtime_helpers: Vec::new(),
        diagnostics: sorted(diagnostics),
    }
}

pub(crate) fn source_type(options: OxcCompileOptions) -> SourceType {
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

pub(crate) fn failed_output(diagnostics: Vec<Diagnostic>) -> OxcCompileOutput {
    OxcCompileOutput {
        code: String::new(),
        source_map_json: None,
        handler_artifacts: Vec::new(),
        runtime_helpers: Vec::new(),
        diagnostics: sorted(diagnostics),
    }
}

pub(crate) fn sorted(diagnostics: Vec<Diagnostic>) -> Vec<Diagnostic> {
    DiagnosticBundle::new(diagnostics).into_sorted()
}

pub(crate) fn convert_diagnostics(
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
            typescript: crate::OxcTypeScriptOptions::default(),
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

    #[test]
    fn lowers_esm_syntax_to_commonjs_output() {
        let mut commonjs = options(OxcSourceLanguage::TypeScript);
        commonjs.module_kind = OxcModuleKind::CommonJs;
        let output = compile_passthrough(
            "import { value } from './value'; export const doubled: number = value * 2;",
            "entry.cts",
            commonjs,
        );

        assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
        assert!(
            output.code.contains("__fict_cjs_load(require(\"./value\")"),
            "{}",
            output.code
        );
        assert!(
            output
                .code
                .contains("Object.defineProperty(__fict_cjs_exports, \"doubled\"")
                || output
                    .code
                    .contains("Object.defineProperty(__fict_cjs_exports, 'doubled'"),
            "{}",
            output.code
        );
        assert!(!output.code.contains("import {"), "{}", output.code);
        assert!(!output.code.contains("export const"), "{}", output.code);
    }

    #[test]
    fn preserves_reexports_and_avoids_commonjs_helper_collisions() {
        let mut commonjs = options(OxcSourceLanguage::TypeScript);
        commonjs.module_kind = OxcModuleKind::CommonJs;
        let output = compile_passthrough(
            concat!(
                "import primary, { value as imported } from './dependency';\n",
                "const __fict_cjs_require = 'user';\n",
                "function probe() { const __fict_cjs_import = 'nested'; return imported + __fict_cjs_import; }\n",
                "export { imported as live, probe };\n",
                "export * from './other';\n",
                "export default primary;",
            ),
            "entry.cts",
            commonjs,
        );

        assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
        assert!(
            output
                .code
                .contains("__fict_cjs_load(require(\"./dependency\")"),
            "{}",
            output.code
        );
        assert!(
            output.code.contains("new WeakMap()")
                && output.code.contains("Object.create(null)")
                && output
                    .code
                    .contains("Object.getOwnPropertyDescriptor(value, key)"),
            "{}",
            output.code
        );
        assert!(
            output
                .code
                .contains("for (const key of Object.keys(source))"),
            "{}",
            output.code
        );
        assert!(
            output.code.contains("const __fict_cjs_require = \"user\"")
                && output.code.contains("const __fict_cjs_import = \"nested\""),
            "{}",
            output.code
        );
        assert!(
            output.code.contains("const __fict_cjs_import_1 =")
                && output.code.contains("__fict_cjs_export_all"),
            "{}",
            output.code
        );
        assert!(
            output.code.contains("\"live\"")
                && output.code.contains("\"probe\"")
                && output.code.contains("\"default\""),
            "{}",
            output.code
        );
        assert!(!output.code.contains("export "), "{}", output.code);
        assert!(!output.code.contains(" from './"), "{}", output.code);
    }

    #[test]
    fn renames_top_level_commonjs_host_bindings() {
        let mut commonjs = options(OxcSourceLanguage::TypeScript);
        commonjs.module_kind = OxcModuleKind::CommonJs;
        let output = compile_passthrough(
            concat!(
                "const require = 'user-require';\n",
                "const exports = 'user-exports';\n",
                "const module = 'user-module';\n",
                "const __filename = 'user-filename';\n",
                "const __dirname = 'user-dirname';\n",
                "const arguments = 'user-arguments';\n",
                "const Object = 'user-object';\n",
                "const WeakMap = 'user-weak-map';\n",
                "import dependency from './dependency.cjs';\n",
                "export const values = [require, exports, module, __filename, __dirname, arguments, Object, WeakMap, dependency.value];",
            ),
            "entry.cts",
            commonjs,
        );

        assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
        for name in [
            "require",
            "exports",
            "module",
            "filename",
            "dirname",
            "arguments",
            "Object",
            "WeakMap",
        ] {
            assert!(
                output.code.contains(&format!("__fict_cjs_user_{name}")),
                "missing renamed {name}: {}",
                output.code
            );
        }
        assert!(
            output
                .code
                .contains("__fict_cjs_load(require(\"./dependency.cjs\")"),
            "{}",
            output.code
        );
    }
}
