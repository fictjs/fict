use super::{
    devtools_source_label, effective_module_kind, emit_program, encode_javascript_string_for_oxc,
};
use crate::{OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, OxcTypeScriptOptions};
use fict_emit::{
    CleanupOwner, EmitContext, EmitFunction, EmitModulePlan, EmitOperation, EmitProgram,
    EmitSlotId, EmitValueRef, ReactiveSlot, ReactiveSlotKind, ReactiveSlotStorage, RuntimeFamily,
    RuntimeHelper, RuntimeImportIntent,
};
use fict_hir::{
    CompoundAssignmentOperator, FunctionId, FunctionKind, JavaScriptString, LiteralValue, Origin,
    Projection, SourceSpan, UpdateOperator, ValueId,
};
use fict_reactivity::{StructurizeAnalysis, StructurizeStats};
use oxc::span::SourceType;
fn options(language: OxcSourceLanguage, sourcemap: bool) -> OxcCompileOptions {
    OxcCompileOptions {
        language,
        module_kind: OxcModuleKind::Module,
        typescript: OxcTypeScriptOptions::default(),
        sourcemap,
    }
}
#[test]
fn preserves_explicit_module_kind_and_resolves_unambiguous_source_type() {
    assert_eq!(
        effective_module_kind(OxcModuleKind::CommonJs, SourceType::mjs()),
        OxcModuleKind::CommonJs
    );
    assert_eq!(
        effective_module_kind(OxcModuleKind::Module, SourceType::cjs()),
        OxcModuleKind::Module
    );
    assert_eq!(
        effective_module_kind(OxcModuleKind::Unambiguous, SourceType::mjs()),
        OxcModuleKind::Module
    );
    assert_eq!(
        effective_module_kind(OxcModuleKind::Unambiguous, SourceType::script()),
        OxcModuleKind::Script
    );
}
#[test]
fn encodes_exact_utf16_strings_for_oxc_without_replacement_loss() {
    let well_formed = JavaScriptString::from("value � 😀");
    assert_eq!(
        encode_javascript_string_for_oxc(&well_formed),
        ("value � 😀".to_owned(), false)
    );
    let exact = JavaScriptString::from_code_units(vec![
        u16::from(b'a'),
        0xd800,
        0xfffd,
        0xd83d,
        0xde00,
        0xdc00,
    ]);
    assert_eq!(
        encode_javascript_string_for_oxc(&exact),
        ("a\u{fffd}d800\u{fffd}fffd😀\u{fffd}dc00".to_owned(), true,)
    );
}
#[test]
fn devtools_source_labels_use_ecmascript_lines_and_utf16_columns() {
    let source = "first\rsecond\u{2028}third\u{2029}😀value";
    let offset = u32::try_from(source.find("value").expect("value")).expect("offset");
    assert_eq!(
        devtools_source_label(source, "mixed.ts", offset),
        "mixed.ts:4:2"
    );
}
fn effect_program(source: &str) -> EmitProgram {
    let call = "$effect(() => 1)";
    let start = u32::try_from(source.find(call).expect("effect call")).expect("span");
    let end = start + u32::try_from(call.len()).expect("span");
    let origin = Origin::source(SourceSpan::new(start, end).expect("ordered span"));
    EmitProgram {
        runtime_family: RuntimeFamily::Runtime,
        dev: false,
        getter_cache: true,
        full_optimization: false,
        optimize: true,
        inline_derived_memos: true,
        preview: false,
        preview_plan: None,
        strict_rejected: false,
        local_hook_returns: Default::default(),
        module: EmitModulePlan {
            source_fragment: None,
            reserved_names: vec!["createEffect_1".into()],
        },
        imports: vec![RuntimeImportIntent {
            helper: RuntimeHelper::Effect,
            module_request: "@fictjs/runtime/internal".into(),
            imported: "createEffect".into(),
            local: "createEffect_1".into(),
        }],
        functions: vec![EmitFunction {
            source: FunctionId::new(0),
            kind: FunctionKind::Module,
            pure: false,
            origin,
            context: None,
            props: None,
            slots: vec![ReactiveSlot {
                id: EmitSlotId::new(0),
                kind: ReactiveSlotKind::Effect,
                storage: ReactiveSlotStorage::Owned,
                binding: None,
                control_path: Vec::new(),
                origin,
            }],
            temporaries: Vec::new(),
            regions: Vec::new(),
            control_flow: StructurizeAnalysis {
                block_order: Vec::new(),
                constructs: Vec::new(),
                top_level_constructs: Vec::new(),
                fallback: None,
                stats: StructurizeStats::default(),
            },
            operations: vec![EmitOperation::RegisterEffect {
                slot: EmitSlotId::new(0),
                source_result: Some(ValueId::new(0)),
                callback: EmitValueRef::Literal(LiteralValue::Undefined),
                helper: RuntimeHelper::Effect,
                cleanup: CleanupOwner::Function,
                origin,
            }],
        }],
    }
}
#[test]
fn rewrites_calls_in_oxc_ast_injects_imports_and_emits_maps() {
    let source = "import { $effect } from 'fict';\nconst value: number = 1;\n$effect(() => 1);\nexport { value };";
    let output = emit_program(
        source,
        "effect.ts",
        options(OxcSourceLanguage::TypeScript, true),
        &effect_program(source),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    assert!(output.code.contains("@fictjs/runtime/internal"));
    assert!(output.code.contains("createEffect as createEffect_1"));
    assert!(output.code.contains("createEffect_1(() => 1)"));
    assert!(!output.code.contains("$effect"));
    assert!(!output.code.contains(": number"));
    assert!(output.code.contains("export { value }"));
    let map = output.source_map_json.expect("source map");
    assert!(map.contains("effect.ts"));
    assert!(map.contains("mappings"));
}
#[test]
fn erases_only_exact_compiler_macro_import_specifiers() {
    let source = "import { $effect, batch } from 'fict';\n$effect(() => 1);\nexport { batch };";
    let emit = effect_program(source);
    let output = emit_program(
        source,
        "mixed-import.js",
        options(OxcSourceLanguage::JavaScript, false),
        &emit,
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    assert!(!output.code.contains("$effect"));
    assert!(output.code.contains("import { batch } from \"fict\""));
    assert!(output.code.contains("export { batch }"));
}
#[test]
fn consumes_only_fict_optimization_directives_in_every_scope() {
    let source = r#"
        "use strict";
        "use client";
        "use no memo";
        "use fict-compiler-disable";
        "custom program";
        import { $effect } from 'fict';
        function outer() {
            "use pure";
            "custom function";
            const nested = () => {
                "use no memo";
                "nested custom";
                return 1;
            };
            return nested();
        }
        $effect(() => 1);
        export { outer };
    "#;
    let output = emit_program(
        source,
        "directives.js",
        options(OxcSourceLanguage::JavaScript, false),
        &effect_program(source),
    );

    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    assert!(!output.code.contains("use no memo"), "{}", output.code);
    assert!(!output.code.contains("use pure"), "{}", output.code);
    for preserved in [
        "use strict",
        "use client",
        "use fict-compiler-disable",
        "custom program",
        "custom function",
        "nested custom",
    ] {
        assert!(output.code.contains(preserved), "{}", output.code);
    }
}
#[test]
fn fails_closed_for_bad_origins() {
    let source = "import { $effect } from 'fict'; $effect(() => 1);";
    let mut bad_origin = effect_program(source);
    let EmitOperation::RegisterEffect { origin, .. } = &mut bad_origin.functions[0].operations[0]
    else {
        unreachable!()
    };
    *origin = Origin::source(SourceSpan::new(0, 1).expect("span"));
    let output = emit_program(
        source,
        "bad-origin.js",
        options(OxcSourceLanguage::JavaScript, false),
        &bad_origin,
    );
    assert!(output.code.is_empty());
    assert!(
        output
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-OXC-EMIT-ORIGIN")
    );
}
#[test]
fn materializes_unprojected_reactive_reads_as_accessor_calls() {
    let source = "const memo = () => 1; export const value = memo + memo;";
    let mut emit = effect_program("$effect(() => 1)");
    emit.imports.clear();
    emit.functions[0].slots.clear();
    emit.functions[0].operations.clear();
    for (index, (start, _)) in source.match_indices("memo").skip(1).enumerate() {
        let start = u32::try_from(start).expect("span");
        emit.functions[0]
            .operations
            .push(EmitOperation::ReadReactive {
                slot: EmitSlotId::new(0),
                source_result: ValueId::new(u32::try_from(index).expect("value")),
                projections: Vec::new(),
                accessor_depth: 0,
                call_value: false,
                target: fict_emit::EmitTemporaryId::new(u32::try_from(index).expect("temporary")),
                helper: None,
                origin: Origin::source(SourceSpan::new(start, start + 4).expect("ordered span")),
            });
    }
    let output = emit_program(
        source,
        "read.js",
        options(OxcSourceLanguage::JavaScript, false),
        &emit,
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    assert!(output.code.contains("value = memo() + memo()"));
}
#[test]
fn materializes_projected_reactive_reads_at_the_root_only() {
    let source =
        "const state = () => ({}); export const values = [state.user.name, state?.items?.[key()]];";
    let mut emit = effect_program("$effect(() => 1)");
    emit.imports.clear();
    emit.functions[0].slots.clear();
    emit.functions[0].operations.clear();
    for (index, authored) in ["state.user.name", "state?.items?.[key()]"]
        .into_iter()
        .enumerate()
    {
        let start =
            u32::try_from(source.find(authored).expect("projected read span")).expect("span");
        emit.functions[0]
            .operations
            .push(EmitOperation::ReadReactive {
                slot: EmitSlotId::new(0),
                source_result: ValueId::new(u32::try_from(index).expect("value")),
                projections: vec![Projection::StaticProperty {
                    name: "placeholder".into(),
                    optional: false,
                }],
                accessor_depth: 0,
                call_value: false,
                target: fict_emit::EmitTemporaryId::new(u32::try_from(index).expect("temporary")),
                helper: None,
                origin: Origin::source(
                    SourceSpan::new(start, start + u32::try_from(authored.len()).expect("span"))
                        .expect("ordered span"),
                ),
            });
    }
    let output = emit_program(
        source,
        "projected-read.js",
        options(OxcSourceLanguage::JavaScript, false),
        &emit,
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    assert!(output.code.contains("state().user.name"), "{}", output.code);
    assert!(
        output.code.contains("state()?.items?.[key()]"),
        "{}",
        output.code
    );
    assert!(!output.code.contains("state()()"), "{}", output.code);
}
#[test]
fn materializes_value_preserving_reactive_writes_and_updates() {
    let source = "let count = () => 0; export const values = [count = rhs(), count += 2, count++, --count, count &&= rhs(), count ||= rhs(), count ??= rhs()];";
    let mut emit = effect_program("$effect(() => 1)");
    emit.imports.clear();
    emit.functions[0].slots.clear();
    emit.functions[0].operations.clear();
    let operations = [
        ("count = rhs()", 0_u8),
        ("count += 2", 1_u8),
        ("count++", 2_u8),
        ("--count", 3_u8),
        ("count &&= rhs()", 4_u8),
        ("count ||= rhs()", 5_u8),
        ("count ??= rhs()", 6_u8),
    ];
    for (authored, kind) in operations {
        let start = u32::try_from(source.find(authored).expect("mutation span")).expect("span");
        let origin = Origin::source(
            SourceSpan::new(start, start + u32::try_from(authored.len()).expect("span"))
                .expect("ordered span"),
        );
        let operation = match kind {
            0 => EmitOperation::WriteReactive {
                slot: EmitSlotId::new(0),
                source_result: None,
                projections: Vec::new(),
                value: EmitValueRef::Literal(LiteralValue::Undefined),
                target: None,
                origin,
            },
            1 => EmitOperation::UpdateReactive {
                slot: EmitSlotId::new(0),
                source_result: Some(ValueId::new(0)),
                projections: Vec::new(),
                compound: Some(CompoundAssignmentOperator::Add),
                value: Some(EmitValueRef::Literal(LiteralValue::Undefined)),
                update: None,
                prefix: false,
                target: None,
                origin,
            },
            2 => EmitOperation::UpdateReactive {
                slot: EmitSlotId::new(0),
                source_result: Some(ValueId::new(1)),
                projections: Vec::new(),
                compound: None,
                value: None,
                update: Some(UpdateOperator::Increment),
                prefix: false,
                target: None,
                origin,
            },
            3 => EmitOperation::UpdateReactive {
                slot: EmitSlotId::new(0),
                source_result: Some(ValueId::new(2)),
                projections: Vec::new(),
                compound: None,
                value: None,
                update: Some(UpdateOperator::Decrement),
                prefix: true,
                target: None,
                origin,
            },
            4..=6 => EmitOperation::UpdateReactive {
                slot: EmitSlotId::new(0),
                source_result: Some(ValueId::new(u32::from(kind))),
                projections: Vec::new(),
                compound: Some(match kind {
                    4 => CompoundAssignmentOperator::LogicalAnd,
                    5 => CompoundAssignmentOperator::LogicalOr,
                    6 => CompoundAssignmentOperator::NullishCoalescing,
                    _ => unreachable!(),
                }),
                value: Some(EmitValueRef::Literal(LiteralValue::Undefined)),
                update: None,
                prefix: false,
                target: None,
                origin,
            },
            _ => unreachable!(),
        };
        emit.functions[0].operations.push(operation);
    }
    let output = emit_program(
        source,
        "writes.js",
        options(OxcSourceLanguage::JavaScript, false),
        &emit,
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    assert!(output.code.contains("count(__fict_value)"));
    assert!(output.code.contains("count() + 2"));
    assert!(output.code.contains("count(__fict_previous + 1)"));
    assert!(output.code.contains("count() - 1"));
    assert!(output.code.contains("__fict_previous &&"));
    assert!(output.code.contains("__fict_previous ||"));
    assert!(output.code.contains("__fict_previous ??"));
}
#[test]
fn fails_closed_for_scoped_helpers_without_context_materialization() {
    let source = "import { $effect } from 'fict'; $effect(() => 1);";
    let mut scoped = effect_program(source);
    let EmitOperation::RegisterEffect { helper, .. } = &mut scoped.functions[0].operations[0]
    else {
        unreachable!()
    };
    *helper = RuntimeHelper::UseEffect;
    scoped.imports[0].helper = RuntimeHelper::UseEffect;
    scoped.imports[0].imported = "__fictUseEffect".into();
    scoped.imports[0].local = "__fictUseEffect".into();
    let output = emit_program(
        source,
        "scoped.js",
        options(OxcSourceLanguage::JavaScript, false),
        &scoped,
    );
    assert!(output.code.is_empty());
    assert_eq!(output.diagnostics[0].code.as_str(), "FICT-OXC-EMIT-CONTEXT");
}
#[test]
fn injects_scoped_contexts_and_prepends_helper_arguments() {
    let source = "function App() { $effect(() => 1); }";
    let mut scoped = effect_program(source);
    let function_origin = Origin::source(
        SourceSpan::new(0, u32::try_from(source.len()).expect("span")).expect("ordered span"),
    );
    let EmitOperation::RegisterEffect { helper, .. } = &mut scoped.functions[0].operations[0]
    else {
        unreachable!()
    };
    *helper = RuntimeHelper::UseEffect;
    scoped.functions[0].context = Some(EmitContext {
        local: "__fictCtx".into(),
        helper: RuntimeHelper::UseContext,
        origin: function_origin,
    });
    scoped.imports = vec![
        RuntimeImportIntent {
            helper: RuntimeHelper::UseContext,
            module_request: "@fictjs/runtime/internal".into(),
            imported: "__fictUseContext".into(),
            local: "__fictUseContext".into(),
        },
        RuntimeImportIntent {
            helper: RuntimeHelper::UseEffect,
            module_request: "@fictjs/runtime/internal".into(),
            imported: "__fictUseEffect".into(),
            local: "__fictUseEffect".into(),
        },
    ];
    let output = emit_program(
        source,
        "scoped-valid.js",
        options(OxcSourceLanguage::JavaScript, false),
        &scoped,
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    assert!(output.code.contains("const __fictCtx = __fictUseContext()"));
    assert!(output.code.contains("__fictUseEffect(__fictCtx, () => 1)"));
}
