use fict_compiler_oxc::{
    FrontendBindingKind, OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, analyze_frontend,
};
use fict_hir::FictMacroKind;

fn options(language: OxcSourceLanguage) -> OxcCompileOptions {
    OxcCompileOptions {
        language,
        module_kind: OxcModuleKind::Module,
        sourcemap: false,
    }
}

fn summary(source: &str, language: OxcSourceLanguage) -> fict_compiler_oxc::FrontendSummary {
    let output = analyze_frontend(source, options(language));
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    output.summary.expect("frontend summary")
}

#[test]
fn recognizes_aliased_macro_calls_by_import_binding_identity() {
    let frontend = summary(
        r#"
            import { $state as state } from 'fict';
            const first = state(1);
            function inner(state: (value: number) => number) {
                return state(2);
            }
        "#,
        OxcSourceLanguage::TypeScript,
    );

    assert_eq!(frontend.macro_imports.len(), 1);
    assert_eq!(frontend.macro_calls.len(), 1);
    assert_eq!(frontend.macro_calls[0].kind, FictMacroKind::State);
    assert_eq!(
        frontend.macro_calls[0].binding,
        frontend.macro_imports[0].binding
    );

    let shadowed: Vec<_> = frontend
        .bindings
        .iter()
        .filter(|binding| binding.display_name == "state")
        .collect();
    assert_eq!(shadowed.len(), 2);
    assert_ne!(shadowed[0].id, shadowed[1].id);
}

#[test]
fn never_grants_macro_semantics_to_unbound_or_wrong_module_names() {
    let unbound = summary(
        "$state(1); $effect(() => {});",
        OxcSourceLanguage::JavaScript,
    );
    assert!(unbound.macro_imports.is_empty());
    assert!(unbound.macro_calls.is_empty());

    let wrong_module = summary(
        "import { $state } from 'not-fict'; $state(1);",
        OxcSourceLanguage::JavaScript,
    );
    assert!(wrong_module.macro_imports.is_empty());
    assert!(wrong_module.macro_calls.is_empty());
}

#[test]
fn recognizes_supported_effect_and_memo_sources() {
    let frontend = summary(
        r#"
            import { $effect as effect, $memo as memo } from 'fict/slim';
            import { createMemo as runtimeMemo } from '@fictjs/runtime';
            effect(() => {});
            memo(() => 1);
            runtimeMemo(() => 2);
        "#,
        OxcSourceLanguage::JavaScript,
    );

    let kinds: Vec<_> = frontend.macro_calls.iter().map(|call| call.kind).collect();
    assert_eq!(
        kinds,
        vec![
            FictMacroKind::Effect,
            FictMacroKind::Memo,
            FictMacroKind::Memo
        ]
    );
}

#[test]
fn records_optional_value_and_namespace_uses_for_later_policy() {
    let direct = summary(
        r#"
            import { $state as state } from 'fict';
            state?.(1);
            const escaped = state;
        "#,
        OxcSourceLanguage::JavaScript,
    );
    assert!(direct.macro_calls[0].optional);
    assert_eq!(direct.macro_value_uses.len(), 1);
    assert_eq!(
        direct.macro_value_uses[0].binding,
        direct.macro_imports[0].binding
    );

    let namespace = summary(
        r#"
            import * as Fict from 'fict';
            Fict.$state(1);
            Fict.$effect?.(() => {});
        "#,
        OxcSourceLanguage::JavaScript,
    );
    assert!(namespace.macro_calls.is_empty());
    assert_eq!(namespace.namespace_macro_calls.len(), 2);
    assert_eq!(
        namespace.namespace_macro_calls[0].kind,
        FictMacroKind::State
    );
    assert!(namespace.namespace_macro_calls[1].optional);
}

#[test]
fn preserves_type_only_bindings_but_marks_them_non_runtime() {
    let frontend = summary(
        r#"
            import type { Shape } from './shape';
            export const value: Shape | null = null;
        "#,
        OxcSourceLanguage::TypeScript,
    );

    let shape = frontend
        .bindings
        .iter()
        .find(|binding| binding.display_name == "Shape")
        .expect("type binding");
    assert_eq!(shape.kind, FrontendBindingKind::TypeOnly);
    assert!(!shape.is_runtime);
    assert_eq!(
        shape.import.as_ref().expect("import identity").source,
        "./shape"
    );
}

#[test]
fn parser_and_semantic_errors_never_publish_partial_summaries() {
    let parser_error = analyze_frontend("export const = ;", options(OxcSourceLanguage::TypeScript));
    assert!(parser_error.summary.is_none());
    assert_eq!(parser_error.diagnostics[0].code.as_str(), "FICT-PARSE");

    let semantic_error = analyze_frontend(
        "const value = 1; const value = 2;",
        options(OxcSourceLanguage::JavaScript),
    );
    assert!(semantic_error.summary.is_none());
    assert_eq!(semantic_error.diagnostics[0].code.as_str(), "FICT-SEMANTIC");
}

#[test]
fn commonjs_frontend_accepts_top_level_return() {
    let output = analyze_frontend(
        "if (ready) return; module.exports = value;",
        OxcCompileOptions {
            language: OxcSourceLanguage::TypeScript,
            module_kind: OxcModuleKind::CommonJs,
            sourcemap: false,
        },
    );

    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let source = output.summary.expect("summary").source;
    assert!(source.parsed_as_commonjs);
    assert!(!source.parsed_as_module);
}
