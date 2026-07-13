use fict_compiler_oxc::{
    FictDirectiveKind, FictReturnShape, FrontendBindingKind, OxcCompileOptions, OxcModuleKind,
    OxcSourceLanguage, PureCommentKind, PureTargetKind, ReactiveValueKind, SuppressionMode,
    analyze_frontend,
};
use fict_hir::{FictMacroKind, ImportedName, ModuleExport, ModuleLocalExport};

fn options(language: OxcSourceLanguage) -> OxcCompileOptions {
    OxcCompileOptions {
        language,
        module_kind: OxcModuleKind::Module,
        typescript: Default::default(),
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
fn owns_runtime_module_exports_without_type_or_arena_identity() {
    let frontend = summary(
        r#"
            import type { Shape } from './types';
            import { sourceValue as forwarded } from './dep';
            import * as localNamespace from './namespace';
            export const value: Shape | null = null;
            export { value as renamed, forwarded, localNamespace };
            export default value;
            export { default as dependencyDefault } from './dep';
            export * as dependencyNamespace from './dep';
            export * from './more';
            export type { Shape };
            export type { Remote } from './types';
            export type * from './type-star';
        "#,
        OxcSourceLanguage::TypeScript,
    );

    assert!(frontend.has_module_syntax);
    assert_eq!(frontend.module_exports.len(), 8);

    let value = frontend
        .bindings
        .iter()
        .find(|binding| binding.display_name == "value")
        .expect("value binding");
    let namespace = frontend
        .bindings
        .iter()
        .find(|binding| binding.display_name == "localNamespace")
        .expect("namespace binding");

    assert!(matches!(
        &frontend.module_exports[0],
        ModuleExport::Local {
            exported,
            target: ModuleLocalExport::Binding(binding),
            ..
        } if exported == "value" && *binding == value.id
    ));
    assert!(matches!(
        &frontend.module_exports[1],
        ModuleExport::Local {
            exported,
            target: ModuleLocalExport::Binding(binding),
            ..
        } if exported == "renamed" && *binding == value.id
    ));
    assert!(matches!(
        &frontend.module_exports[2],
        ModuleExport::ReExport {
            exported,
            source,
            imported: ImportedName::Named(imported),
            ..
        } if exported == "forwarded" && source == "./dep" && imported == "sourceValue"
    ));
    assert!(matches!(
        &frontend.module_exports[3],
        ModuleExport::Local {
            exported,
            target: ModuleLocalExport::Binding(binding),
            ..
        } if exported == "localNamespace" && *binding == namespace.id
    ));
    assert!(
        matches!(
            &frontend.module_exports[4],
            ModuleExport::Local {
                exported,
                target: ModuleLocalExport::Binding(binding),
                ..
            } if exported == "default" && *binding == value.id
        ),
        "{:?}",
        frontend.module_exports
    );
    assert!(matches!(
        &frontend.module_exports[5],
        ModuleExport::ReExport {
            exported,
            source,
            imported: ImportedName::Default,
            ..
        } if exported == "dependencyDefault" && source == "./dep"
    ));
    assert!(matches!(
        &frontend.module_exports[6],
        ModuleExport::ReExport {
            exported,
            source,
            imported: ImportedName::Namespace,
            ..
        } if exported == "dependencyNamespace" && source == "./dep"
    ));
    assert!(matches!(
        &frontend.module_exports[7],
        ModuleExport::Star { source, .. } if source == "./more"
    ));
    assert!(
        frontend.module_exports.iter().all(|export| !matches!(
            export,
            ModuleExport::Local { exported, .. } if exported == "Shape"
        )),
        "type-only exports must not enter the runtime module plan"
    );

    let anonymous = summary("export default 42;", OxcSourceLanguage::JavaScript);
    assert!(matches!(
        anonymous.module_exports.as_slice(),
        [ModuleExport::Local {
            exported,
            target: ModuleLocalExport::DefaultExpression,
            ..
        }] if exported == "default"
    ));
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
            typescript: Default::default(),
            sourcemap: false,
        },
    );

    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let source = output.summary.expect("summary").source;
    assert!(source.parsed_as_commonjs);
    assert!(!source.parsed_as_module);
}

#[test]
fn collects_program_and_function_directive_prologues_by_scope() {
    let frontend = summary(
        r#"
            "use fict-compiler";
            "custom-runtime-directive";
            function App() {
                "use no memo";
                "use pure";
                return 1;
            }
        "#,
        OxcSourceLanguage::JavaScript,
    );

    let directives = &frontend.source_facts.directives;
    let kinds: Vec<_> = directives.iter().map(|directive| directive.kind).collect();
    assert_eq!(
        kinds,
        vec![
            FictDirectiveKind::UseFictCompiler,
            FictDirectiveKind::Other,
            FictDirectiveKind::NoMemo,
            FictDirectiveKind::Pure,
        ]
    );
    assert_eq!(directives[0].scope.index(), 0);
    assert_eq!(directives[0].scope, directives[1].scope);
    assert_ne!(directives[1].scope, directives[2].scope);
    assert_eq!(directives[2].scope, directives[3].scope);
}

#[test]
fn parses_exact_same_line_and_next_line_suppressions() {
    let frontend = summary(
        "const a = 1; // fict-ignore FICT-M003, FICT-R006\r\n\
         /*\r\n\
          * fict-ignore-next-line FICT-M\r\n\
          */\r\n\
         const b = 2;\r\n\
         // documentation says fict-ignore-next-line FICT-X here\r\n\
         const c = 3;",
        OxcSourceLanguage::JavaScript,
    );

    let suppressions = &frontend.source_facts.suppressions;
    assert_eq!(suppressions.len(), 2);
    assert_eq!(suppressions[0].mode, SuppressionMode::SameLine);
    assert_eq!(suppressions[0].target_line, 1);
    assert_eq!(suppressions[0].codes, ["FICT-M003", "FICT-R006"]);
    assert_eq!(suppressions[1].mode, SuppressionMode::NextLine);
    assert_eq!(suppressions[1].target_line, 5);
    assert_eq!(suppressions[1].codes, ["FICT-M"]);
}

#[test]
fn retains_applied_and_unapplied_pure_comments() {
    let frontend = summary(
        r#"
            const first = /* @__PURE__ */ factory();
            const second = /* #__PURE__ */ new Thing();
            const notApplied = /* @__PURE__ */ value;
            /* #__NO_SIDE_EFFECTS__ */ function helper() { return 1; }
        "#,
        OxcSourceLanguage::JavaScript,
    );

    let targets: Vec<_> = frontend
        .source_facts
        .pure_annotations
        .iter()
        .map(|annotation| annotation.target_kind)
        .collect();
    assert_eq!(
        targets,
        vec![
            PureTargetKind::Call,
            PureTargetKind::New,
            PureTargetKind::Function
        ]
    );
    assert!(
        frontend
            .source_facts
            .pure_annotations
            .iter()
            .all(|annotation| annotation.comment_span.is_some())
    );
    assert!(
        frontend
            .source_facts
            .pure_comments
            .iter()
            .any(|comment| { comment.kind == PureCommentKind::PureNotApplied })
    );
}

#[test]
fn parses_supported_fict_return_shapes_and_retains_invalid_payloads() {
    let frontend = summary(
        r#"
            /** @fictReturn { count: 'signal', "double": memo } */
            function useObject() {}
            /** @fictReturn [0: signal, 2: 'store'] */
            function useArray() {}
            /** @fictReturn "memo" */
            function useDirect() {}
            /** @fictReturn { directAccessor: 'store' } */
            function useDirectObject() {}
            /** @fictReturn { count: 'signalized' } */
            function useInvalid() {}
        "#,
        OxcSourceLanguage::JavaScript,
    );

    let annotations = &frontend.source_facts.fict_returns;
    assert_eq!(annotations.len(), 5);
    assert_eq!(
        annotations[0].shape,
        Some(FictReturnShape::Object(vec![
            ("count".into(), ReactiveValueKind::Signal),
            ("double".into(), ReactiveValueKind::Memo),
        ]))
    );
    assert_eq!(
        annotations[1].shape,
        Some(FictReturnShape::Array(vec![
            (0, ReactiveValueKind::Signal),
            (2, ReactiveValueKind::Store),
        ]))
    );
    assert_eq!(
        annotations[2].shape,
        Some(FictReturnShape::Direct(ReactiveValueKind::Memo))
    );
    assert_eq!(
        annotations[3].shape,
        Some(FictReturnShape::Direct(ReactiveValueKind::Store))
    );
    assert!(annotations[4].shape.is_none());
}
