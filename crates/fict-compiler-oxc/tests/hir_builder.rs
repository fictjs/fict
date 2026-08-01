use fict_compiler_oxc::{
    HirBuildOptions, OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, build_hir,
};
use fict_hir::{
    ArrayElement, BinaryOperator, CallHost, CompoundAssignmentOperator, ContextValueKind,
    DeclarationKind, DeleteTarget, EvaluationMode, FictMacroKind, FunctionKind, GeneratedOrigin,
    HirInstructionKind, ImportPhase, ImportedHookReturn, ImportedReactiveKind,
    ImportedReactiveProperty, IterationKind, JavaScriptString, LiteralValue, ModuleExport,
    ModuleLocalExport, MutationEffect, ObjectEntry, ObjectPropertyKind, OriginKind, PlaceBase,
    Projection, PropertyKey, Purity, ReactiveCallKind, ReactiveScopeKind, StructuredSourceKind,
    SyntaxFragmentKind, TerminatorKind, UnaryOperator, UpdateOperator, ValueKind,
    verify_module_plan,
};
use fict_metadata::{
    MetadataResolutionStatus, ModuleReactiveMetadata, ReactiveExportKind, ResolvedMetadataInput,
};
use fict_reactivity::{
    ReactiveBindingKind, SsaDefinitionKind, analyze_aliases, analyze_dependencies,
    analyze_reactive_scopes, analyze_shapes, analyze_ssa,
};
fn options(language: OxcSourceLanguage) -> OxcCompileOptions {
    OxcCompileOptions {
        language,
        module_kind: OxcModuleKind::Module,
        typescript: Default::default(),
        sourcemap: false,
    }
}

#[test]
fn lowers_internal_import_equals_as_a_local_alias_initialization() {
    let output = build_hir(
        "const Child = class {}\nimport Alias = Child\nexport const instance = new Alias()\n",
        options(OxcSourceLanguage::TypeScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:#?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let alias = hir
        .bindings
        .iter()
        .find(|binding| binding.display_name == "Alias")
        .expect("internal import-equals alias");
    assert_eq!(alias.kind, fict_hir::BindingKind::Var);
    assert!(alias.import.is_none());

    let module = &hir.functions[0];
    let alias_local = module
        .locals
        .iter()
        .find(|local| local.binding == Some(alias.id))
        .expect("alias local");
    assert!(
        module
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .any(|instruction| matches!(
                instruction.kind,
                HirInstructionKind::Write {
                    ref place,
                    ..
                } if place.base == fict_hir::PlaceBase::Local(alias_local.id)
                    && place.projections.is_empty()
            ))
    );
}

#[test]
fn annotates_direct_and_namespace_imports_from_exact_resolved_metadata() {
    let output = build_hir(
        r#"
            import primary, { count as localCount, doubled, state, plain, group as namedNamespace, useCount } from './dep?client';
            import { count as differentRequest } from './dep';
            import * as namespace from './dep?client';
            import { hidden } from './opaque';
            export function App(key) {
                return [
                    namespace.useCount(),
                    namespace.group.useGroup(),
                    namedNamespace.deep.usePair(),
                    namespace[key](),
                ];
            }
        "#,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions {
            resolved_metadata: vec![
                ResolvedMetadataInput {
                    request: "./dep?client".into(),
                    resolved_id: Some("/src/dep.ts?client".into()),
                    status: MetadataResolutionStatus::Resolved,
                    metadata: Some(ModuleReactiveMetadata {
                        exports: [
                            ("default".into(), ReactiveExportKind::Signal),
                            ("count".into(), ReactiveExportKind::Signal),
                            ("doubled".into(), ReactiveExportKind::Memo),
                            ("state".into(), ReactiveExportKind::Store),
                        ]
                        .into_iter()
                        .collect(),
                        namespaces: [(
                            "group".into(),
                            ModuleReactiveMetadata {
                                exports: [("inner".into(), ReactiveExportKind::Memo)]
                                    .into_iter()
                                    .collect(),
                                hooks: [(
                                    "useGroup".into(),
                                    fict_metadata::HookReturnInfo {
                                        object_props: [(
                                            "count".into(),
                                            ReactiveExportKind::Signal,
                                        )]
                                        .into_iter()
                                        .collect(),
                                        ..fict_metadata::HookReturnInfo::default()
                                    },
                                )]
                                .into_iter()
                                .collect(),
                                namespaces: [(
                                    "deep".into(),
                                    ModuleReactiveMetadata {
                                        exports: [("value".into(), ReactiveExportKind::Signal)]
                                            .into_iter()
                                            .collect(),
                                        hooks: [(
                                            "usePair".into(),
                                            fict_metadata::HookReturnInfo {
                                                array_props: [(
                                                    "0".into(),
                                                    ReactiveExportKind::Memo,
                                                )]
                                                .into_iter()
                                                .collect(),
                                                ..fict_metadata::HookReturnInfo::default()
                                            },
                                        )]
                                        .into_iter()
                                        .collect(),
                                        ..ModuleReactiveMetadata::new()
                                    },
                                )]
                                .into_iter()
                                .collect(),
                                ..ModuleReactiveMetadata::new()
                            },
                        )]
                        .into_iter()
                        .collect(),
                        hooks: [(
                            "useCount".into(),
                            fict_metadata::HookReturnInfo {
                                direct_accessor: Some(ReactiveExportKind::Signal),
                                object_props: [("value".into(), ReactiveExportKind::Memo)]
                                    .into_iter()
                                    .collect(),
                                array_props: [("0".into(), ReactiveExportKind::Store)]
                                    .into_iter()
                                    .collect(),
                            },
                        )]
                        .into_iter()
                        .collect(),
                        ..ModuleReactiveMetadata::new()
                    }),
                    fingerprint: "sha256:dep-client".into(),
                },
                ResolvedMetadataInput {
                    request: "./opaque".into(),
                    resolved_id: Some("/src/opaque.ts".into()),
                    status: MetadataResolutionStatus::Opaque,
                    metadata: None,
                    fingerprint: "sha256:opaque".into(),
                },
            ],
            ..HirBuildOptions::default()
        },
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let reactive = |name: &str| {
        hir.bindings
            .iter()
            .find(|binding| binding.display_name == name)
            .unwrap_or_else(|| panic!("missing import {name}"))
            .import
            .as_ref()
            .and_then(|import| import.reactive)
    };
    assert_eq!(reactive("primary"), Some(ImportedReactiveKind::Signal));
    assert_eq!(reactive("localCount"), Some(ImportedReactiveKind::Signal));
    assert_eq!(reactive("doubled"), Some(ImportedReactiveKind::Memo));
    assert_eq!(reactive("state"), Some(ImportedReactiveKind::Store));
    assert_eq!(reactive("plain"), None);
    assert_eq!(reactive("differentRequest"), None);
    assert_eq!(reactive("namespace"), None);
    assert_eq!(reactive("hidden"), None);
    assert_eq!(
        hir.bindings
            .iter()
            .find(|binding| binding.display_name == "useCount")
            .and_then(|binding| binding.import.as_ref())
            .and_then(|import| import.hook_return.as_ref()),
        Some(&ImportedHookReturn {
            direct_accessor: Some(ImportedReactiveKind::Signal),
            object_properties: vec![ImportedReactiveProperty {
                key: "value".into(),
                kind: ImportedReactiveKind::Memo,
            }],
            array_properties: vec![ImportedReactiveProperty {
                key: "0".into(),
                kind: ImportedReactiveKind::Store,
            }],
        })
    );
    let members = |name: &str| {
        hir.bindings
            .iter()
            .find(|binding| binding.display_name == name)
            .unwrap_or_else(|| panic!("missing import {name}"))
            .import
            .as_ref()
            .expect("import identity")
            .reactive_members
            .iter()
            .map(|member| (member.path.clone(), member.kind))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        members("namespace"),
        vec![
            (vec!["count".into()], ImportedReactiveKind::Signal),
            (vec!["default".into()], ImportedReactiveKind::Signal),
            (vec!["doubled".into()], ImportedReactiveKind::Memo),
            (
                vec!["group".into(), "deep".into(), "value".into()],
                ImportedReactiveKind::Signal,
            ),
            (
                vec!["group".into(), "inner".into()],
                ImportedReactiveKind::Memo,
            ),
            (vec!["state".into()], ImportedReactiveKind::Store),
        ]
    );
    assert_eq!(
        members("namedNamespace"),
        vec![
            (
                vec!["deep".into(), "value".into()],
                ImportedReactiveKind::Signal,
            ),
            (vec!["inner".into()], ImportedReactiveKind::Memo),
        ]
    );
    let import = |name: &str| {
        hir.bindings
            .iter()
            .find(|binding| binding.display_name == name)
            .and_then(|binding| binding.import.as_ref())
            .unwrap_or_else(|| panic!("missing import {name}"))
    };
    assert_eq!(
        import("namespace")
            .resolve_hook_member_path(&["useCount".into()])
            .and_then(|hook| hook.direct_accessor),
        Some(ImportedReactiveKind::Signal)
    );
    assert_eq!(
        import("namespace")
            .resolve_hook_member_path(&["group".into(), "useGroup".into()])
            .and_then(|hook| hook.object_properties.first())
            .map(|property| (property.key.as_str(), property.kind)),
        Some(("count", ImportedReactiveKind::Signal))
    );
    assert_eq!(
        import("namedNamespace")
            .resolve_hook_member_path(&["deep".into(), "usePair".into()])
            .and_then(|hook| hook.array_properties.first())
            .map(|property| (property.key.as_str(), property.kind)),
        Some(("0", ImportedReactiveKind::Memo))
    );
    let app = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "App")
        })
        .expect("App function");
    let calls: Vec<_> = app
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .filter_map(|instruction| match &instruction.kind {
            HirInstructionKind::Call(call) => Some(call),
            _ => None,
        })
        .collect();
    assert_eq!(calls.len(), 4);
    let namespace = hir
        .bindings
        .iter()
        .find(|binding| binding.display_name == "namespace")
        .expect("namespace import")
        .id;
    let named_namespace = hir
        .bindings
        .iter()
        .find(|binding| binding.display_name == "namedNamespace")
        .expect("named namespace import")
        .id;
    assert!(matches!(calls[0].host, CallHost::Binding(binding) if binding == namespace));
    assert!(matches!(calls[1].host, CallHost::Binding(binding) if binding == namespace));
    assert!(matches!(calls[2].host, CallHost::Binding(binding) if binding == named_namespace));
    assert_eq!(calls[3].host, CallHost::Unknown);
    let static_path = |call: &fict_hir::CallInstruction| {
        call.callee_reference
            .as_ref()
            .expect("namespace member reference")
            .projections
            .iter()
            .map(|projection| match projection {
                Projection::StaticProperty { name, .. } => name.clone(),
                Projection::Index { .. } | Projection::ComputedProperty { .. } => {
                    "<dynamic>".into()
                }
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(static_path(calls[0]), ["useCount"]);
    assert_eq!(static_path(calls[1]), ["group", "useGroup"]);
    assert_eq!(static_path(calls[2]), ["deep", "usePair"]);
    assert_eq!(static_path(calls[3]), ["<dynamic>"]);
}

#[test]
fn tracks_missing_import_metadata_through_static_hook_aliases() {
    let build = |source: &str| {
        build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions {
                resolved_metadata: vec![ResolvedMetadataInput {
                    request: "./barrel".into(),
                    resolved_id: None,
                    status: MetadataResolutionStatus::Missing,
                    metadata: None,
                    fingerprint: "missing:barrel".into(),
                }],
                ..HirBuildOptions::default()
            },
        )
    };
    let aliases = [
        "import { foo } from './barrel'; const useCount = foo; export function App() { return useCount() * 2; }",
        "import { foo } from './barrel'; const hooks = { useCount: foo }; export function App() { return hooks.useCount() * 2; }",
        "import * as api from './barrel'; const useCount = api.foo; export function App() { return useCount() * 2; }",
        "import { useCount } from './barrel'; const hooks = { useCount }; export function App() { return hooks.useCount() * 2; }",
        "import { foo } from './barrel'; const first = foo; const useCount = first; export function App() { return useCount() * 2; }",
    ];
    for source in aliases {
        let output = build(source);
        let findings = output
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code.as_str() == "FICT-H003")
            .collect::<Vec<_>>();
        assert_eq!(findings.len(), 1, "{source}: {:?}", output.diagnostics);
        assert_eq!(
            findings[0].severity,
            fict_diagnostics::DiagnosticSeverity::Warning
        );
    }

    let safe = [
        "import { foo } from './barrel'; const ordinary = foo; export function App() { return ordinary() * 2; }",
        "import { foo } from './barrel'; const local = () => 1; const hooks = { plain: foo, useCount: local }; export function App() { return hooks.useCount() * 2; }",
        "import { foo } from './barrel'; const local = () => 1; const hooks = { useCount: foo }; hooks.useCount = local; export function App() { return hooks.useCount() * 2; }",
        "import { foo } from './barrel'; let useCount = foo; useCount = () => 1; export function App() { return useCount() * 2; }",
    ];
    for source in safe {
        let output = build(source);
        assert!(
            output
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code.as_str() != "FICT-H003"),
            "{source}: {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn remaps_owned_module_exports_after_typescript_runtime_erasure() {
    let output = build_hir(
        r#"
            import type { Shape } from './types';
            const value: Shape | null = null;
            export { value as publicValue };
            export default value;
            export { sourceValue as forwarded } from './dep';
        "#,
        options(OxcSourceLanguage::TypeScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let module_plan = output.module_plan.expect("verified module plan");
    verify_module_plan(&hir, &module_plan).expect("module plan must own valid HIR identities");
    let value = hir
        .bindings
        .iter()
        .find(|binding| binding.display_name == "value")
        .expect("runtime value binding");
    assert_eq!(hir.bindings.len(), 1, "type-only binding must be erased");
    assert!(matches!(
        &module_plan.exports[0],
        ModuleExport::Local {
            exported,
            target: ModuleLocalExport::Binding(binding),
            ..
        } if exported == "publicValue" && *binding == value.id
    ));
    assert!(matches!(
        &module_plan.exports[1],
        ModuleExport::Local {
            exported,
            target: ModuleLocalExport::Binding(binding),
            ..
        } if exported == "default" && *binding == value.id
    ));
    assert!(matches!(
        &module_plan.exports[2],
        ModuleExport::ReExport { exported, source, .. }
            if exported == "forwarded" && source == "./dep"
    ));
}
#[test]
fn retains_simple_explicit_and_arrow_return_values_in_terminators() {
    let output = build_hir(
        r#"
            function useObject(value) { return { value }; }
            const read = (value) => value + 1;
            function empty() { return; }
        "#,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let named = |name: &str| {
        hir.functions
            .iter()
            .find(|function| {
                function
                    .binding
                    .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == name)
            })
            .unwrap_or_else(|| panic!("missing function {name}"))
    };
    for name in ["useObject", "read"] {
        let function = named(name);
        let TerminatorKind::Return { value: Some(value) } = function.blocks[0].terminator.kind
        else {
            panic!("{name} must retain its returned value")
        };
        assert!(
            function.blocks[0]
                .instructions
                .iter()
                .any(|instruction| instruction.result == Some(value))
        );
    }
    assert!(matches!(
        named("empty").blocks[0].terminator.kind,
        TerminatorKind::Return { value: None }
    ));
}

#[test]
fn distinguishes_formal_rest_parameters_from_nested_rest_patterns() {
    let output = build_hir(
        r#"
            function nested([first, ...tail]) { return [first, tail]; }
            function formal(...args) { return args; }
            function destructured(...[first, second]) { return [first, second]; }
        "#,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let named = |name: &str| {
        hir.functions
            .iter()
            .find(|function| {
                function
                    .binding
                    .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == name)
            })
            .unwrap_or_else(|| panic!("missing function {name}"))
    };

    assert!(!named("nested").parameters[0].is_rest);
    assert!(named("formal").parameters[0].is_rest);
    assert!(named("destructured").parameters[0].is_rest);
}

#[test]
fn distinguishes_source_bare_returns_from_implicit_control_flow_returns() {
    let output = build_hir(
        r#"
            function bare() { return; }
            function fallthrough() {}
            function partial(flag) { if (flag) return; }
        "#,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let named = |name: &str| {
        hir.functions
            .iter()
            .find(|function| {
                function
                    .binding
                    .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == name)
            })
            .unwrap_or_else(|| panic!("missing function {name}"))
    };

    assert_eq!(
        named("bare").blocks[0].terminator.origin.kind,
        OriginKind::Source
    );
    assert_eq!(
        named("fallthrough").blocks[0].terminator.origin.kind,
        OriginKind::Generated(GeneratedOrigin::ControlFlow)
    );

    let partial_return_origins: Vec<_> = named("partial")
        .blocks
        .iter()
        .filter(|block| {
            matches!(
                block.terminator.kind,
                TerminatorKind::Return { value: None }
            )
        })
        .map(|block| block.terminator.origin.kind)
        .collect();
    assert_eq!(
        partial_return_origins,
        [
            OriginKind::Source,
            OriginKind::Generated(GeneratedOrigin::ControlFlow),
        ]
    );
}
#[test]
fn lowers_if_returns_into_real_hir_blocks_with_control_dependencies() {
    let source = r#"
        import { $state } from 'fict';
        function App() {
            const count = $state(0);
            if (count > 10 && maybe()) return <Big />;
            return <Small />;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified structured HIR");
    let app = hir
        .functions
        .iter()
        .find(|function| function.kind == FunctionKind::Component)
        .expect("component function");
    assert_eq!(app.blocks.len(), 4);
    let source_hint = app.blocks[0]
        .source_hint
        .as_ref()
        .expect("conditional source hint");
    assert!(matches!(
        &source_hint.kind,
        StructuredSourceKind::Conditional
    ));
    assert_eq!(
        source_hint.origin.primary_span,
        app.blocks[0].terminator.origin.primary_span
    );
    let TerminatorKind::Branch {
        test,
        consequent,
        alternate,
    } = app.blocks[0].terminator.kind
    else {
        panic!("entry block must branch")
    };
    let (logical_left, logical_right) = app.blocks[0]
        .instructions
        .iter()
        .find_map(|instruction| {
            (instruction.result == Some(test))
                .then_some(&instruction.kind)
                .and_then(|kind| match kind {
                    HirInstructionKind::Binary {
                        operator: BinaryOperator::LogicalAnd,
                        left,
                        right,
                    } => Some((*left, *right)),
                    _ => None,
                })
        })
        .expect("typed logical branch test");
    let count = app
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("count"))
        .expect("state local");
    let reactive_read = app.blocks[0]
        .instructions
        .iter()
        .find_map(|instruction| match &instruction.kind {
            HirInstructionKind::Read { place }
                if place == &fict_hir::Place::local(count.id)
                    && instruction.origin.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "count"
                    }) =>
            {
                instruction.result
            }
            _ => None,
        })
        .expect("reactive condition read");
    let unknown_call = app.blocks[0]
        .instructions
        .iter()
        .find_map(|instruction| match &instruction.kind {
            HirInstructionKind::Call(call) if call.macro_kind.is_none() => instruction.result,
            _ => None,
        })
        .expect("condition call");
    assert_eq!(logical_right, unknown_call);
    assert!(app.blocks[0].instructions.iter().any(|instruction| {
        instruction.result == Some(logical_left)
            && matches!(
                instruction.kind,
                HirInstructionKind::Binary {
                    operator: BinaryOperator::GreaterThan,
                    left,
                    ..
                } if left == reactive_read
            )
    }));
    let consequent_block = &app.blocks[consequent.as_usize()];
    let TerminatorKind::Return {
        value: Some(big_value),
    } = consequent_block.terminator.kind
    else {
        panic!("truthy branch must return JSX")
    };
    assert!(consequent_block.instructions.iter().any(|instruction| {
        instruction.result == Some(big_value)
            && matches!(instruction.kind, HirInstructionKind::Jsx { .. })
    }));
    let TerminatorKind::Goto { target: join } = app.blocks[alternate.as_usize()].terminator.kind
    else {
        panic!("empty false branch must flow to the join")
    };
    let join_block = &app.blocks[join.as_usize()];
    let TerminatorKind::Return {
        value: Some(small_value),
    } = join_block.terminator.kind
    else {
        panic!("join block must return fallback JSX")
    };
    assert!(join_block.instructions.iter().any(|instruction| {
        instruction.result == Some(small_value)
            && matches!(instruction.kind, HirInstructionKind::Jsx { .. })
    }));
    assert!(
        app.blocks.iter().flat_map(|block| &block.instructions).all(
            |instruction| match instruction.kind {
                HirInstructionKind::SyntaxFragment { fragment, .. } => {
                    hir.syntax_fragments[fragment.as_usize()].kind != SyntaxFragmentKind::Statement
                }
                _ => true,
            }
        )
    );
}
#[test]
fn lowers_throw_values_into_their_conditional_block() {
    let source = r#"
        function classify(value) {
            if (value) throw makeError();
            return 1;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified throw CFG");
    let classify = hir
        .bindings
        .iter()
        .find(|binding| binding.display_name == "classify")
        .expect("classify binding")
        .id;
    let function = hir
        .functions
        .iter()
        .find(|function| function.binding == Some(classify));
    let function = function.expect("named function");
    let TerminatorKind::Branch { consequent, .. } = function.blocks[0].terminator.kind else {
        panic!("function entry must branch")
    };
    let throw_block = &function.blocks[consequent.as_usize()];
    let TerminatorKind::Throw { value } = throw_block.terminator.kind else {
        panic!("truthy branch must throw")
    };
    assert!(throw_block.instructions.iter().any(|instruction| {
        instruction.result == Some(value) && matches!(instruction.kind, HirInstructionKind::Call(_))
    }));
}
#[test]
fn lowers_switch_tests_fallthrough_and_breaks_in_exact_evaluation_order() {
    let source = r#"
        function work(select, mark) {
            let result = 0;
            outer: switch (select()) {
                case mark('a'):
                    result = 1;
                    break;
                case mark('b'):
                default:
                    result = 2;
                    break outer;
                case mark('c'):
                    result = 3;
            }
            return result;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified switch CFG");
    let work = hir
        .bindings
        .iter()
        .find(|binding| binding.display_name == "work")
        .expect("work binding")
        .id;
    let function = hir
        .functions
        .iter()
        .find(|function| function.binding == Some(work))
        .expect("work function");
    let header = function
        .blocks
        .iter()
        .find(|block| {
            block
                .source_hint
                .as_ref()
                .is_some_and(|hint| matches!(&hint.kind, StructuredSourceKind::Switch))
        })
        .expect("switch source header");
    let hint = header.source_hint.as_ref().expect("switch hint");
    assert_eq!(hint.switch_cases.len(), 4);
    assert_eq!(
        hint.switch_cases
            .iter()
            .filter(|case| case.test.is_none())
            .count(),
        1
    );
    assert!(hint.exit.is_some());
    let test_blocks: Vec<_> = hint
        .switch_cases
        .iter()
        .filter_map(|case| case.test)
        .collect();
    assert_eq!(test_blocks.len(), 3);
    assert!(matches!(
        header.terminator.kind,
        TerminatorKind::Goto { target } if target == test_blocks[0]
    ));
    let comparisons: Vec<_> = test_blocks
        .iter()
        .map(|block| {
            function.blocks[block.as_usize()]
                .instructions
                .iter()
                .find_map(|instruction| match instruction.kind {
                    HirInstructionKind::Binary {
                        operator: BinaryOperator::StrictEqual,
                        left,
                        right,
                    } => Some((left, right)),
                    _ => None,
                })
                .expect("strict switch comparison")
        })
        .collect();
    assert!(
        comparisons
            .iter()
            .all(|(left, _)| *left == comparisons[0].0)
    );
    let discriminant = comparisons[0].0;
    let discriminant_block = function
        .blocks
        .iter()
        .find(|block| {
            block
                .instructions
                .iter()
                .any(|instruction| instruction.result == Some(discriminant))
        })
        .expect("once-evaluated switch discriminant");
    assert_eq!(discriminant_block.id, header.id);
    for ((case_index, next_test), test_block) in [
        (0_usize, Some(test_blocks[1])),
        (1, Some(test_blocks[2])),
        (3, None),
    ]
    .into_iter()
    .zip(&test_blocks)
    {
        let TerminatorKind::Branch {
            consequent,
            alternate,
            ..
        } = function.blocks[test_block.as_usize()].terminator.kind
        else {
            panic!("switch test must branch")
        };
        assert_eq!(consequent, hint.switch_cases[case_index].body);
        assert_eq!(
            alternate,
            next_test.unwrap_or(hint.switch_cases[2].body),
            "default is selected only after every non-default test fails"
        );
        assert!(
            function.blocks[test_block.as_usize()]
                .instructions
                .iter()
                .any(|instruction| instruction.result
                    == Some(
                        comparisons[match case_index {
                            0 => 0,
                            1 => 1,
                            3 => 2,
                            _ => unreachable!(),
                        }]
                        .1
                    ))
        );
    }
    assert!(matches!(
        function.blocks[hint.switch_cases[1].body.as_usize()]
            .terminator
            .kind,
        TerminatorKind::Goto { target } if target == hint.switch_cases[2].body
    ));
    let exit = hint.exit.expect("switch exit");
    let break_targets = function
        .blocks
        .iter()
        .filter_map(|block| {
            let span = block.terminator.origin.primary_span?;
            let text = source.get(span.start() as usize..span.end() as usize)?;
            text.starts_with("break").then_some(&block.terminator.kind)
        })
        .collect::<Vec<_>>();
    assert_eq!(break_targets.len(), 2);
    assert!(break_targets.iter().all(
        |terminator| matches!(terminator, TerminatorKind::Goto { target } if *target == exit)
    ));
    assert!(
        function
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .all(|instruction| match instruction.kind {
                HirInstructionKind::SyntaxFragment { fragment, .. } => {
                    hir.syntax_fragments[fragment.as_usize()].kind != SyntaxFragmentKind::Statement
                }
                _ => true,
            })
    );
}
#[test]
fn lowers_try_catch_finally_and_catch_patterns_into_structured_cfg() {
    let source = r#"
        function work(action) {
            let result = 0;
            try {
                result = action();
            } catch ({ message = fallbackMessage() }) {
                result = message;
            } finally {
                cleanup();
            }
            return result;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified try CFG");
    let work = hir
        .bindings
        .iter()
        .find(|binding| binding.display_name == "work")
        .expect("work binding")
        .id;
    let function = hir
        .functions
        .iter()
        .find(|function| function.binding == Some(work))
        .expect("work function");
    let header = function
        .blocks
        .iter()
        .find(|block| {
            block
                .source_hint
                .as_ref()
                .is_some_and(|hint| matches!(hint.kind, StructuredSourceKind::Try))
        })
        .expect("try header");
    let TerminatorKind::Try {
        body,
        catch: Some(catch),
        finally: Some(finally),
        continuation,
    } = header.terminator.kind
    else {
        panic!("complete try terminator")
    };
    assert_eq!(
        header.source_hint.as_ref().and_then(|hint| hint.exit),
        Some(continuation)
    );
    assert!(matches!(
        function.blocks[body.as_usize()].terminator.kind,
        TerminatorKind::Goto { target } if target == finally
    ));
    assert!(matches!(
        function.blocks[catch.as_usize()].terminator.kind,
        TerminatorKind::Goto { target } if target == finally
    ));
    assert!(matches!(
        function.blocks[finally.as_usize()].terminator.kind,
        TerminatorKind::Goto { target } if target == continuation
    ));
    assert!(matches!(
        function.blocks[catch.as_usize()]
            .source_hint
            .as_ref()
            .map(|hint| &hint.kind),
        Some(StructuredSourceKind::Catch)
    ));
    assert!(matches!(
        function.blocks[finally.as_usize()]
            .source_hint
            .as_ref()
            .map(|hint| &hint.kind),
        Some(StructuredSourceKind::Finally)
    ));
    for (call, expected_block) in [
        ("action()", body),
        ("fallbackMessage()", catch),
        ("cleanup()", finally),
    ] {
        let block = function
            .blocks
            .iter()
            .find(|block| {
                block.instructions.iter().any(|instruction| {
                    matches!(instruction.kind, HirInstructionKind::Call(_))
                        && instruction.origin.primary_span.is_some_and(|span| {
                            source.get(span.start() as usize..span.end() as usize) == Some(call)
                        })
                })
            })
            .unwrap_or_else(|| panic!("missing {call}"));
        assert_eq!(block.id, expected_block, "{call}");
    }
    let catch_block = &function.blocks[catch.as_usize()];
    let fallback_value = catch_block
        .instructions
        .iter()
        .find_map(|instruction| {
            (matches!(instruction.kind, HirInstructionKind::Call(_))
                && instruction.origin.primary_span.is_some_and(|span| {
                    source.get(span.start() as usize..span.end() as usize)
                        == Some("fallbackMessage()")
                }))
            .then_some(instruction.result)
            .flatten()
        })
        .expect("fallback value");
    let (pattern, inputs) = catch_block
        .instructions
        .iter()
        .find_map(|instruction| match &instruction.kind {
            HirInstructionKind::SyntaxFragment { fragment, inputs }
                if hir.syntax_fragments[fragment.as_usize()].kind
                    == SyntaxFragmentKind::Pattern =>
            {
                Some((*fragment, inputs))
            }
            _ => None,
        })
        .expect("catch pattern fragment");
    let fallback_position = catch_block
        .instructions
        .iter()
        .position(|instruction| instruction.result == Some(fallback_value))
        .expect("fallback instruction position");
    let pattern_position = catch_block
        .instructions
        .iter()
        .position(|instruction| {
            matches!(
                instruction.kind,
                HirInstructionKind::SyntaxFragment { fragment, .. } if fragment == pattern
            )
        })
        .expect("pattern instruction position");
    assert!(fallback_position < pattern_position);
    let summary = hir.syntax_fragments[pattern.as_usize()]
        .summary
        .pattern
        .as_ref()
        .expect("pattern summary");
    assert_eq!(summary.declared_bindings.len(), 1);
    assert!(summary.has_defaults);
    assert!(inputs.contains(&fallback_value));
    let message = function
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("message"))
        .expect("catch local")
        .id;
    assert!(catch_block.instructions.iter().any(|instruction| {
        matches!(
            instruction.kind,
            HirInstructionKind::Declare { local, .. } if local == message
        )
    }));
    assert!(
        function
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .all(|instruction| match instruction.kind {
                HirInstructionKind::SyntaxFragment { fragment, .. } => {
                    hir.syntax_fragments[fragment.as_usize()].kind != SyntaxFragmentKind::Statement
                }
                _ => true,
            })
    );
}
#[test]
fn lowers_catch_only_and_finally_only_try_variants() {
    let source = r#"
        function catchOnly() {
            try { work(); } catch { recover(); }
        }
        function finallyOnly() {
            try { work(); } finally { cleanup(); }
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified try variants");
    for (name, has_catch, has_finally) in [("catchOnly", true, false), ("finallyOnly", false, true)]
    {
        let binding = hir
            .bindings
            .iter()
            .find(|binding| binding.display_name == name)
            .unwrap_or_else(|| panic!("missing {name} binding"))
            .id;
        let function = hir
            .functions
            .iter()
            .find(|function| function.binding == Some(binding))
            .unwrap_or_else(|| panic!("missing {name} function"));
        let terminator = function
            .blocks
            .iter()
            .find_map(|block| match block.terminator.kind {
                TerminatorKind::Try {
                    body,
                    catch,
                    finally,
                    continuation,
                } => Some((body, catch, finally, continuation)),
                _ => None,
            })
            .unwrap_or_else(|| panic!("missing {name} try"));
        assert_eq!(terminator.1.is_some(), has_catch, "{name}");
        assert_eq!(terminator.2.is_some(), has_finally, "{name}");
        let normal_target = terminator.2.unwrap_or(terminator.3);
        assert!(matches!(
            function.blocks[terminator.0.as_usize()].terminator.kind,
            TerminatorKind::Goto { target } if target == normal_target
        ));
        if let Some(catch) = terminator.1 {
            assert!(matches!(
                function.blocks[catch.as_usize()].terminator.kind,
                TerminatorKind::Goto { target } if target == terminator.3
            ));
            assert!(function.blocks[catch.as_usize()].instructions.iter().all(
                |instruction| !matches!(
                    instruction.kind,
                    HirInstructionKind::SyntaxFragment { fragment, .. }
                        if hir.syntax_fragments[fragment.as_usize()].kind
                            == SyntaxFragmentKind::Pattern
                )
            ));
        }
    }
}
#[test]
fn lowers_classic_loops_and_labeled_control_edges() {
    let source = r#"
        function loops(limit) {
            let value = 0;
            outer: for (let index = 0; index < limit; index++) {
                while (value < limit) {
                    value++;
                    if (value === 1) continue;
                    if (value === 2) continue outer;
                    break outer;
                }
            }
            do {
                value++;
                if (value > 10) break;
            } while (value < limit);
            return value;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified loop CFG");
    let loops = hir
        .bindings
        .iter()
        .find(|binding| binding.display_name == "loops")
        .expect("loops binding")
        .id;
    let function = hir
        .functions
        .iter()
        .find(|function| function.binding == Some(loops))
        .expect("loops function");
    let loop_headers: Vec<_> = function
        .blocks
        .iter()
        .filter_map(|block| block.source_hint.as_ref().map(|hint| (block.id, hint)))
        .collect();
    assert_eq!(
        loop_headers
            .iter()
            .filter(|(_, hint)| matches!(
                hint.kind,
                StructuredSourceKind::ForLoop
                    | StructuredSourceKind::WhileLoop
                    | StructuredSourceKind::DoWhileLoop
            ))
            .count(),
        3,
        "{loop_headers:#?}"
    );
    let for_loop = loop_headers
        .iter()
        .find(|(_, hint)| matches!(hint.kind, StructuredSourceKind::ForLoop))
        .expect("for loop");
    let while_loop = loop_headers
        .iter()
        .find(|(_, hint)| matches!(hint.kind, StructuredSourceKind::WhileLoop))
        .expect("while loop");
    let do_while_loop = loop_headers
        .iter()
        .find(|(_, hint)| matches!(hint.kind, StructuredSourceKind::DoWhileLoop))
        .expect("do-while loop");
    assert!(for_loop.1.exit.is_some());
    assert!(while_loop.1.exit.is_some());
    assert!(do_while_loop.1.exit.is_some());
    let for_update = function
        .blocks
        .iter()
        .find(|block| {
            block
                .origin
                .primary_span
                .and_then(|span| source.get(span.start() as usize..span.end() as usize))
                == Some("index++")
        })
        .expect("for update block")
        .id;
    let terminator_for = |text: &str| {
        function.blocks.iter().find_map(|block| {
            let span = block.terminator.origin.primary_span?;
            (source
                .get(span.start() as usize..span.end() as usize)
                .is_some_and(|candidate| candidate == text))
            .then_some(&block.terminator.kind)
        })
    };
    assert!(matches!(
        terminator_for("continue;"),
        Some(TerminatorKind::Goto { target }) if *target == while_loop.0
    ));
    assert!(matches!(
        terminator_for("break outer;"),
        Some(TerminatorKind::Goto { target }) if Some(*target) == for_loop.1.exit
    ));
    assert!(matches!(
        terminator_for("continue outer;"),
        Some(TerminatorKind::Goto { target }) if *target == for_update
    ));
    assert!(matches!(
        terminator_for("break;"),
        Some(TerminatorKind::Goto { target }) if Some(*target) == do_while_loop.1.exit
    ));
}

#[test]
fn preserves_nested_loop_cfg_inside_a_labeled_block() {
    let source = r#"
        function choose(items) {
            let selected = 'none';
            choice: {
                for (const item of items) {
                    if (item.active) {
                        selected = item.label;
                        break choice;
                    }
                }
                selected = 'fallback';
            }
            return selected;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified labeled-block CFG");
    let choose = hir
        .bindings
        .iter()
        .find(|binding| binding.display_name == "choose")
        .expect("choose binding")
        .id;
    let function = hir
        .functions
        .iter()
        .find(|function| function.binding == Some(choose))
        .expect("choose function");
    let loop_header = function
        .blocks
        .iter()
        .find(|block| {
            block
                .source_hint
                .as_ref()
                .is_some_and(|hint| matches!(hint.kind, StructuredSourceKind::ForOfLoop))
        })
        .expect("for-of header");
    let loop_exit = loop_header
        .source_hint
        .as_ref()
        .and_then(|hint| hint.exit)
        .expect("for-of exit");
    let labeled_break_target = function
        .blocks
        .iter()
        .find_map(|block| {
            let span = block.terminator.origin.primary_span?;
            (source
                .get(span.start() as usize..span.end() as usize)
                .is_some_and(|candidate| candidate == "break choice;"))
            .then_some(match block.terminator.kind {
                TerminatorKind::Goto { target } => Some(target),
                _ => None,
            })
            .flatten()
        })
        .expect("labeled break target");
    assert_ne!(labeled_break_target, loop_exit);
}

#[test]
fn lowers_for_in_of_and_await_of_with_once_evaluated_sources_and_iteration_targets() {
    let source = r#"
        async function iterate(items, object) {
            let current;
            let sum = 0;
            for (const item of items) {
                sum += item;
                if (item < 0) continue;
            }
            for (current in object) {
                if (current === 'stop') break;
            }
            outer: for await (const [value, ...rest] of items) {
                current = value;
                continue outer;
            }
            return sum;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified enumeration-loop HIR");
    let iterate = hir
        .bindings
        .iter()
        .find(|binding| binding.display_name == "iterate")
        .expect("iterate binding")
        .id;
    let function = hir
        .functions
        .iter()
        .find(|function| function.binding == Some(iterate))
        .expect("iterate function");
    let headers: Vec<_> = function
        .blocks
        .iter()
        .filter(|block| {
            block.source_hint.as_ref().is_some_and(|hint| {
                matches!(
                    hint.kind,
                    StructuredSourceKind::ForInLoop
                        | StructuredSourceKind::ForOfLoop
                        | StructuredSourceKind::ForAwaitOfLoop
                )
            })
        })
        .collect();
    assert_eq!(headers.len(), 3, "{headers:#?}");
    let binding = |name: &str| {
        hir.bindings
            .iter()
            .find(|binding| binding.display_name == name)
            .expect("loop binding")
            .id
    };
    let local = |name: &str| {
        function
            .locals
            .iter()
            .find(|local| local.binding == Some(binding(name)))
            .expect("loop local")
            .id
    };
    let current = local("current");
    let item = local("item");
    let value = local("value");
    let rest = local("rest");
    for header in &headers {
        let (kind, source_value, body, exit) = match header.terminator.kind {
            TerminatorKind::ForIn { object, body, exit } => (IterationKind::In, object, body, exit),
            TerminatorKind::ForOf {
                iterable,
                r#await,
                body,
                exit,
            } => (
                if r#await {
                    IterationKind::AwaitOf
                } else {
                    IterationKind::Of
                },
                iterable,
                body,
                exit,
            ),
            ref other => panic!("unexpected enumeration header: {other:?}"),
        };
        assert_eq!(
            header.source_hint.as_ref().and_then(|hint| hint.exit),
            Some(exit)
        );
        let source_block = function
            .blocks
            .iter()
            .find(|block| {
                block
                    .instructions
                    .iter()
                    .any(|instruction| instruction.result == Some(source_value))
            })
            .expect("once-evaluated enumeration source");
        assert_ne!(source_block.id, header.id);
        assert!(matches!(
            source_block.terminator.kind,
            TerminatorKind::Goto { target } if target == header.id
        ));
        let iteration = function.blocks[body.as_usize()]
            .instructions
            .iter()
            .find_map(|instruction| match &instruction.kind {
                HirInstructionKind::Iteration {
                    kind: candidate,
                    source,
                    pattern,
                    targets,
                } if *candidate == kind => Some((*source, *pattern, targets)),
                _ => None,
            })
            .expect("iteration target assignment");
        assert_eq!(iteration.0, source_value);
        let fragment = &hir.syntax_fragments[iteration.1.as_usize()];
        assert_eq!(fragment.kind, SyntaxFragmentKind::Pattern);
        let summary = fragment.summary.pattern.as_ref().expect("pattern summary");
        match kind {
            IterationKind::In => {
                assert_eq!(iteration.2.as_slice(), [current]);
                assert_eq!(summary.assigned_bindings.as_slice(), [binding("current")]);
            }
            IterationKind::Of => {
                assert_eq!(iteration.2.as_slice(), [item]);
                assert_eq!(summary.declared_bindings.as_slice(), [binding("item")]);
            }
            IterationKind::AwaitOf => {
                assert_eq!(iteration.2.as_slice(), [value, rest]);
                assert_eq!(
                    summary.declared_bindings.as_slice(),
                    [binding("value"), binding("rest")]
                );
                assert!(summary.has_rest);
                assert!(fragment.summary.contains_await);
            }
        }
    }
    let terminator_for = |text: &str| {
        function.blocks.iter().find_map(|block| {
            let span = block.terminator.origin.primary_span?;
            (source.get(span.start() as usize..span.end() as usize) == Some(text))
                .then_some(&block.terminator.kind)
        })
    };
    let for_in = headers
        .iter()
        .find(|header| matches!(header.terminator.kind, TerminatorKind::ForIn { .. }))
        .expect("for-in header");
    let await_of = headers
        .iter()
        .find(|header| {
            matches!(
                header.terminator.kind,
                TerminatorKind::ForOf { r#await: true, .. }
            )
        })
        .expect("for-await-of header");
    assert!(matches!(
        terminator_for("break;"),
        Some(TerminatorKind::Goto { target })
            if Some(*target) == for_in.source_hint.as_ref().and_then(|hint| hint.exit)
    ));
    assert!(matches!(
        terminator_for("continue outer;"),
        Some(TerminatorKind::Goto { target }) if *target == await_of.id
    ));
}
#[test]
fn builds_verified_binding_aware_hir_for_tsx_components_and_macros() {
    let source = r#"
        import { $state as state } from 'fict';
        export function App(props: { initial: number }) {
            const count = state(props.initial);
            return <button>{count}</button>;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::TypeScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let app = hir
        .functions
        .iter()
        .find(|function| function.kind == FunctionKind::Component)
        .expect("component function");
    assert_eq!(app.parameters.len(), 1);
    let (call_index, state_result, call) = app.blocks[0]
        .instructions
        .iter()
        .enumerate()
        .find_map(|(index, instruction)| match &instruction.kind {
            HirInstructionKind::Call(call) => Some((index, instruction.result, call)),
            _ => None,
        })
        .expect("state call");
    let state_result = state_result.expect("state result");
    assert_eq!(call.macro_kind, Some(FictMacroKind::State));
    let CallHost::Binding(callee) = call.host else {
        panic!("state call must carry its imported binding")
    };
    assert_eq!(
        callee,
        hir.bindings
            .iter()
            .find(|binding| binding.display_name == "state")
            .unwrap()
            .id
    );
    let count = app
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("count"))
        .expect("count local");
    let (declaration_index, initializer) = app.blocks[0]
        .instructions
        .iter()
        .enumerate()
        .find_map(|(index, instruction)| match instruction.kind {
            HirInstructionKind::Declare {
                local, initializer, ..
            } if local == count.id => Some((index, initializer)),
            _ => None,
        })
        .expect("count declaration");
    assert_eq!(initializer, Some(state_result));
    assert!(call_index < declaration_index);
    assert!(
        hir.bindings
            .iter()
            .all(|binding| binding.id.as_usize() < hir.bindings.len())
    );
    assert!(
        output
            .syntax_fragments
            .iter()
            .any(|fragment| fragment.source.contains("<button>"))
    );
    assert_eq!(hir.templates.len(), 1);
    assert_eq!(hir.templates[0].owner, app.id);
    assert!(
        app.blocks[0]
            .instructions
            .iter()
            .any(|instruction| matches!(instruction.kind, HirInstructionKind::Jsx { .. }))
    );
}
#[test]
fn alias_and_shadow_calls_keep_distinct_binding_identity() {
    let source = r#"
        import { $state as state } from 'fict';
        function App() {
            const outer = state(1);
            function inner(state) { return state(2); }
            return outer;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let calls: Vec<_> = hir
        .functions
        .iter()
        .flat_map(|function| &function.blocks[0].instructions)
        .filter_map(|instruction| match &instruction.kind {
            HirInstructionKind::Call(call) => Some(call),
            _ => None,
        })
        .collect();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].macro_kind, Some(FictMacroKind::State));
    assert_eq!(calls[1].macro_kind, None);
    let CallHost::Binding(imported) = calls[0].host else {
        panic!("import call")
    };
    let CallHost::Binding(shadow) = calls[1].host else {
        panic!("shadow call")
    };
    assert_ne!(imported, shadow);
}
#[test]
fn classifies_runtime_reactive_calls_by_import_identity() {
    let source = r#"
        import { $store as store } from 'fict';
        import { resource } from 'fict/plus';
        import { createSelector as selector } from '@fictjs/runtime/advanced';
        import { createEffect as effect, createMemo as memo } from '@fictjs/runtime';
        import * as F from 'fict';
        import { $store as fakeStore } from 'third-party';
        import { createMemo as fakeMemo } from 'third-party';
        const one = store({ value: 1 });
        const two = resource(() => 2);
        const three = selector(() => 3);
        const four = F.$store({ value: 4 });
        const five = F['resource'](() => 5);
        const six = F.createSelector(() => 6);
        const seven = memo?.(() => one.value);
        effect(() => one.value);
        const eight = F.createMemo(() => one.value);
        F.createEffect(() => one.value);
        const ignored = fakeStore({ value: 0 });
        const ignoredMemo = fakeMemo?.(() => 1);
        function shadow(store) { return store({ value: 0 }); }
        function shadowMemo(memo) { return memo?.(() => 1); }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified reactive-call HIR");
    let calls: Vec<_> = hir
        .functions
        .iter()
        .flat_map(|function| &function.blocks[0].instructions)
        .filter_map(|instruction| match &instruction.kind {
            HirInstructionKind::Call(call) => Some(call),
            _ => None,
        })
        .collect();
    let kinds: Vec<_> = calls.iter().filter_map(|call| call.reactive_kind).collect();
    assert_eq!(
        kinds,
        [
            ReactiveCallKind::Store,
            ReactiveCallKind::Resource,
            ReactiveCallKind::Selector,
            ReactiveCallKind::Store,
            ReactiveCallKind::Resource,
            ReactiveCallKind::Selector,
            ReactiveCallKind::Memo,
            ReactiveCallKind::Memo,
        ]
    );
    for call in calls.iter().filter(|call| {
        matches!(
            call.reactive_kind,
            Some(ReactiveCallKind::Store | ReactiveCallKind::Resource | ReactiveCallKind::Selector)
        )
    }) {
        assert!(matches!(call.host, CallHost::Binding(_)), "{call:?}");
        assert!(call.macro_kind.is_none());
    }
    let runtime_scopes: Vec<_> = calls
        .iter()
        .filter_map(|call| match call.host {
            CallHost::ReactiveScope(host) => Some((call.reactive_kind, host.kind, call.optional)),
            _ => None,
        })
        .collect();
    assert_eq!(
        runtime_scopes,
        [
            (
                Some(ReactiveCallKind::Memo),
                ReactiveScopeKind::MemoCallback,
                true
            ),
            (None, ReactiveScopeKind::EffectCallback, false),
            (
                Some(ReactiveCallKind::Memo),
                ReactiveScopeKind::MemoCallback,
                false
            ),
            (None, ReactiveScopeKind::EffectCallback, false),
        ]
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| {
                call.reactive_kind.is_none() && matches!(call.host, CallHost::Binding(_))
            })
            .count(),
        4,
        "wrong-module and shadowed calls remain ordinary bindings"
    );
}
#[test]
fn materializes_binding_resolved_macro_reads_in_hir() {
    let source = r#"
        import { $memo as memo } from 'fict';
        const doubled = memo(() => 2);
        export const result = doubled + doubled;
        function shadow(doubled) { return doubled; }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert_eq!(
        output
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<Vec<_>>(),
        ["FICT-M001"]
    );
    let hir = output.hir.expect("verified reactive-read HIR");
    let module = &hir.functions[hir.root_function.as_usize()];
    let doubled = module
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("doubled"))
        .expect("memo local");
    let reads: Vec<_> = module.blocks[0]
        .instructions
        .iter()
        .filter(|instruction| {
            matches!(
                &instruction.kind,
                HirInstructionKind::Read { place }
                    if place == &fict_hir::Place::local(doubled.id)
            )
        })
        .collect();
    assert_eq!(reads.len(), 2);
    for read in reads {
        let span = read.origin.primary_span.expect("read source span");
        assert_eq!(
            &source[span.start() as usize..span.end() as usize],
            "doubled"
        );
    }
    let shadow = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "shadow")
        })
        .expect("shadow function");
    let shadow_reads: Vec<_> = shadow.blocks[0]
        .instructions
        .iter()
        .filter(|instruction| matches!(instruction.kind, HirInstructionKind::Read { .. }))
        .collect();
    assert_eq!(shadow_reads.len(), 1, "plain local reads are explicit HIR");
    assert_eq!(
        shadow_reads[0]
            .origin
            .primary_span
            .map(|span| &source[span.start() as usize..span.end() as usize]),
        Some("doubled")
    );
}
#[test]
fn materializes_reactive_assignments_compounds_and_updates() {
    let source = r#"
        import { $state as state } from 'fict';
        function App() {
            let count = state(0);
            const assigned = (count = next());
            const compound = (count += delta());
            const postfix = count++;
            const prefix = --count;
            return [assigned, compound, postfix, prefix, count];
        }
        function shadow(count) { count += 1; return count++; }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified mutation HIR");
    let app = hir
        .functions
        .iter()
        .find(|function| function.kind == FunctionKind::Component)
        .expect("component");
    let count = app
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("count"))
        .expect("state local");
    let mutations: Vec<_> = app.blocks[0]
        .instructions
        .iter()
        .filter(|instruction| match &instruction.kind {
            HirInstructionKind::Write { place, .. }
            | HirInstructionKind::ReadWrite { place, .. } => {
                place == &fict_hir::Place::local(count.id)
            }
            _ => false,
        })
        .collect();
    assert_eq!(mutations.len(), 4);
    assert!(
        mutations
            .iter()
            .all(|instruction| instruction.result.is_some()),
        "authored mutation expressions must define their JavaScript result value"
    );
    assert!(mutations.iter().all(|instruction| {
        instruction.semantics.mutation == MutationEffect::Observable
            && instruction.semantics.purity == Purity::Unknown
    }));
    assert!(matches!(
        mutations[0].kind,
        HirInstructionKind::Write { .. }
    ));
    assert!(matches!(
        mutations[1].kind,
        HirInstructionKind::ReadWrite {
            compound: Some(CompoundAssignmentOperator::Add),
            update: None,
            ..
        }
    ));
    assert!(matches!(
        mutations[2].kind,
        HirInstructionKind::ReadWrite {
            update: Some(UpdateOperator::Increment),
            prefix: false,
            ..
        }
    ));
    assert!(matches!(
        mutations[3].kind,
        HirInstructionKind::ReadWrite {
            update: Some(UpdateOperator::Decrement),
            prefix: true,
            ..
        }
    ));
    let authored: Vec<_> = mutations
        .iter()
        .map(|instruction| {
            let span = instruction.origin.primary_span.expect("mutation origin");
            &source[span.start() as usize..span.end() as usize]
        })
        .collect();
    assert_eq!(
        authored,
        ["count = next()", "count += delta()", "count++", "--count"]
    );
    for (name, mutation) in [
        ("assigned", mutations[0]),
        ("compound", mutations[1]),
        ("postfix", mutations[2]),
        ("prefix", mutations[3]),
    ] {
        let local = app
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"));
        assert!(app.blocks[0].instructions.iter().any(|instruction| {
            matches!(
                instruction.kind,
                HirInstructionKind::Declare {
                    local: candidate,
                    initializer: Some(initializer),
                    ..
                } if candidate == local.id && Some(initializer) == mutation.result
            )
        }));
    }
    assert!(
        app.blocks[0].instructions.iter().all(|instruction| {
            !matches!(instruction.kind, HirInstructionKind::SyntaxFragment { .. })
                || !authored.contains(
                    &instruction
                        .origin
                        .primary_span
                        .map(|span| &source[span.start() as usize..span.end() as usize])
                        .unwrap_or_default(),
                )
        }),
        "ordinary assignment expressions must not fall back to syntax fragments"
    );
    let shadow = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "shadow")
        })
        .expect("shadow function");
    let plain_mutations: Vec<_> = shadow.blocks[0]
        .instructions
        .iter()
        .filter(|instruction| {
            matches!(
                instruction.kind,
                HirInstructionKind::Write { .. } | HirInstructionKind::ReadWrite { .. }
            )
        })
        .collect();
    assert_eq!(plain_mutations.len(), 2, "plain writes are explicit HIR");
    assert!(
        plain_mutations
            .iter()
            .all(|instruction| instruction.result.is_some())
    );
    assert_eq!(
        plain_mutations
            .iter()
            .map(|instruction| {
                let span = instruction
                    .origin
                    .primary_span
                    .expect("plain mutation span");
                &source[span.start() as usize..span.end() as usize]
            })
            .collect::<Vec<_>>(),
        ["count += 1", "count++"]
    );
}
#[test]
fn preserves_assignment_results_projected_order_and_logical_rhs_laziness() {
    let source = r#"
        function assign(value, object, key, make, invoke) {
            const simple = (value = make('simple'));
            const projected = (object[key()] = make('projected'));
            const andResult = (value &&= make('and'));
            const orResult = (value ||= make('or'));
            const nullishResult = (value ??= make('nullish'));
            const argument = invoke(value = make('argument'));
            return [simple, projected, andResult, orResult, nullishResult, argument, value];
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified assignment-result HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "assign")
        })
        .expect("assign function");
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let authored = |instruction: &fict_hir::HirInstruction| {
        let span = instruction
            .origin
            .primary_span
            .expect("authored assignment instruction");
        &source[span.start() as usize..span.end() as usize]
    };
    let instruction = |text: &str| {
        instructions
            .iter()
            .copied()
            .find(|instruction| authored(instruction) == text)
            .unwrap_or_else(|| panic!("instruction for {text}"))
    };
    let instruction_for_result = |value| function.instruction_for_result(value).unwrap();
    let initializer = |name: &str| {
        let local = function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"));
        instructions
            .iter()
            .find_map(|instruction| match instruction.kind {
                HirInstructionKind::Declare {
                    local: candidate,
                    initializer,
                    ..
                } if candidate == local.id => initializer,
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name} initializer"))
    };
    let assignment_roots: Vec<_> = [
        "simple",
        "projected",
        "andResult",
        "orResult",
        "nullishResult",
    ]
    .into_iter()
    .map(|name| instruction_for_result(initializer(name)))
    .collect();
    assert!(assignment_roots.iter().all(|instruction| matches!(
        instruction.kind,
        HirInstructionKind::Write { .. } | HirInstructionKind::ReadWrite { .. }
    )));
    assert!(
        assignment_roots
            .iter()
            .all(|instruction| instruction.result.is_some())
    );
    assert!(instructions.iter().all(|instruction| {
        !matches!(instruction.kind, HirInstructionKind::SyntaxFragment { .. })
            || ![
                "value = make('simple')",
                "object[key()] = make('projected')",
                "value &&= make('and')",
                "value ||= make('or')",
                "value ??= make('nullish')",
                "value = make('argument')",
            ]
            .contains(&authored(instruction))
    }));
    let simple = instruction_for_result(initializer("simple"));
    let HirInstructionKind::Write { value, .. } = simple.kind else {
        panic!("simple assignment must be a typed write")
    };
    assert_eq!(authored(instruction_for_result(value)), "make('simple')");
    let projected = instruction_for_result(initializer("projected"));
    let HirInstructionKind::Write { place, value } = &projected.kind else {
        panic!("projected assignment must be a typed write")
    };
    let [
        Projection::ComputedProperty {
            key,
            optional: false,
        },
    ] = place.projections.as_slice()
    else {
        panic!("projected assignment must retain its computed key")
    };
    assert_eq!(authored(instruction_for_result(*key)), "key()");
    assert_eq!(
        authored(instruction_for_result(*value)),
        "make('projected')"
    );
    assert_eq!(
        instructions
            .iter()
            .filter(|instruction| authored(instruction) == "key()")
            .count(),
        1,
        "computed assignment keys are evaluated once"
    );
    let position = |value| {
        instructions
            .iter()
            .position(|instruction| instruction.result == Some(value))
            .expect("result position")
    };
    assert!(position(*key) < position(*value));
    assert!(position(*value) < position(projected.result.expect("projected result")));
    for (name, operator, rhs) in [
        (
            "andResult",
            CompoundAssignmentOperator::LogicalAnd,
            "make('and')",
        ),
        (
            "orResult",
            CompoundAssignmentOperator::LogicalOr,
            "make('or')",
        ),
        (
            "nullishResult",
            CompoundAssignmentOperator::NullishCoalescing,
            "make('nullish')",
        ),
    ] {
        let root = instruction_for_result(initializer(name));
        let HirInstructionKind::ReadWrite {
            compound: Some(candidate),
            value: Some(value),
            update: None,
            ..
        } = root.kind
        else {
            panic!("{name} logical assignment")
        };
        assert_eq!(candidate, operator);
        assert_eq!(authored(instruction_for_result(value)), rhs);
        assert_eq!(root.semantics.evaluation, EvaluationMode::Eager);
        assert_eq!(
            instruction_for_result(value).semantics.evaluation,
            EvaluationMode::Deferred,
            "logical-assignment RHS must remain lazy: {name}"
        );
    }
    for text in ["'and'", "'or'", "'nullish'"] {
        assert_eq!(
            instruction(text).semantics.evaluation,
            EvaluationMode::Deferred,
            "every logical-assignment RHS descendant must remain lazy: {text}"
        );
    }
    for text in ["make('simple')", "make('projected')", "make('argument')"] {
        assert_eq!(
            instruction(text).semantics.evaluation,
            EvaluationMode::Eager,
            "plain assignment RHS must remain eager: {text}"
        );
    }
    let argument_assignment = instruction("value = make('argument')");
    let argument_result = argument_assignment
        .result
        .expect("argument assignment result");
    let invocation = instruction("invoke(value = make('argument'))");
    let HirInstructionKind::Call(call) = &invocation.kind else {
        panic!("outer invocation")
    };
    assert_eq!(call.arguments.len(), 1);
    assert_eq!(call.arguments[0].value, argument_result);
}
#[test]
fn materializes_destructuring_assignments_as_typed_result_bearing_hir() {
    let source = r#"
        function assign(source, key, fallback, invoke, object) {
            let a, b, rest;
            const result = ({ [key()]: a = fallback(), nested: [b], ...rest } = source());
            const argument = invoke([a, object.slot] = source());
            return [result, argument, a, b, rest];
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified destructuring-assignment HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "assign")
        })
        .expect("assign function");
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let authored = |origin: fict_hir::Origin| {
        let span = origin.primary_span.expect("authored origin");
        &source[span.start() as usize..span.end() as usize]
    };
    let local_name = |local: fict_hir::LocalId| {
        function.locals[local.as_usize()]
            .debug_name
            .as_deref()
            .expect("named local")
    };
    let instruction_for_result = |value| function.instruction_for_result(value).unwrap();
    let initializer = |name: &str| {
        let local = function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"));
        instructions
            .iter()
            .find_map(|instruction| match instruction.kind {
                HirInstructionKind::Declare {
                    local: candidate,
                    initializer,
                    ..
                } if candidate == local.id => initializer,
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name} initializer"))
    };
    let assignments: Vec<_> = instructions
        .iter()
        .copied()
        .filter(|instruction| {
            matches!(
                instruction.kind,
                HirInstructionKind::PatternAssignment { .. }
            )
        })
        .collect();
    assert_eq!(assignments.len(), 2);
    assert_eq!(
        assignments
            .iter()
            .map(|instruction| authored(instruction.origin))
            .collect::<Vec<_>>(),
        [
            "{ [key()]: a = fallback(), nested: [b], ...rest } = source()",
            "[a, object.slot] = source()",
        ]
    );
    assert!(
        assignments
            .iter()
            .all(|instruction| instruction.result.is_some())
    );
    let first = assignments[0];
    let HirInstructionKind::PatternAssignment {
        value: first_value,
        pattern: first_pattern,
        writes: ref first_writes,
    } = first.kind
    else {
        unreachable!()
    };
    assert_eq!(
        first_writes
            .iter()
            .map(|write| (local_name(write.local), authored(write.origin)))
            .collect::<Vec<_>>(),
        [("a", "a"), ("b", "b"), ("rest", "rest")]
    );
    assert_eq!(
        authored(instruction_for_result(first_value).origin),
        "source()"
    );
    assert_eq!(
        initializer("result"),
        first.result.expect("first assignment result")
    );
    let first_fragment = &hir.syntax_fragments[first_pattern.as_usize()];
    assert_eq!(
        output.syntax_fragments[first_pattern.as_usize()].source,
        "{ [key()]: a = fallback(), nested: [b], ...rest }"
    );
    let first_summary = first_fragment
        .summary
        .pattern
        .as_ref()
        .expect("assignment-pattern summary");
    assert!(first_summary.has_defaults);
    assert!(first_summary.has_rest);
    assert_eq!(
        first_summary
            .assigned_bindings
            .iter()
            .map(|binding| hir.bindings[binding.as_usize()].display_name.as_str())
            .collect::<Vec<_>>(),
        ["a", "b", "rest"]
    );
    assert_eq!(
        first_fragment
            .summary
            .referenced_bindings
            .iter()
            .map(|binding| hir.bindings[binding.as_usize()].display_name.as_str())
            .collect::<Vec<_>>(),
        ["key", "fallback"]
    );
    let second = assignments[1];
    let HirInstructionKind::PatternAssignment {
        value: second_value,
        pattern: second_pattern,
        writes: ref second_writes,
    } = second.kind
    else {
        unreachable!()
    };
    assert_eq!(
        second_writes
            .iter()
            .map(|write| (local_name(write.local), authored(write.origin)))
            .collect::<Vec<_>>(),
        [("a", "a")]
    );
    assert_eq!(
        authored(instruction_for_result(second_value).origin),
        "source()"
    );
    assert_eq!(
        output.syntax_fragments[second_pattern.as_usize()].source,
        "[a, object.slot]"
    );
    assert_eq!(
        hir.syntax_fragments[second_pattern.as_usize()]
            .summary
            .referenced_bindings
            .iter()
            .map(|binding| hir.bindings[binding.as_usize()].display_name.as_str())
            .collect::<Vec<_>>(),
        ["object"]
    );
    let invocation = instructions
        .iter()
        .copied()
        .find(|instruction| authored(instruction.origin) == "invoke([a, object.slot] = source())")
        .expect("outer invocation");
    let HirInstructionKind::Call(call) = &invocation.kind else {
        panic!("outer invocation must remain a typed call")
    };
    assert_eq!(
        call.arguments[0].value,
        second.result.expect("second assignment result")
    );
    assert_eq!(
        initializer("argument"),
        invocation.result.expect("call result")
    );
    for deferred in ["key()", "fallback()", "object.slot"] {
        assert!(
            instructions
                .iter()
                .all(|instruction| authored(instruction.origin) != deferred),
            "adapter-owned pattern child must not be evaluated independently: {deferred}"
        );
    }
    assert!(instructions.iter().all(|instruction| {
        !matches!(
            instruction.kind,
            HirInstructionKind::SyntaxFragment { fragment, .. }
                if hir.syntax_fragments[fragment.as_usize()].kind == SyntaxFragmentKind::Expression
                    && [
                        "{ [key()]: a = fallback(), nested: [b], ...rest } = source()",
                        "[a, object.slot] = source()",
                    ]
                    .contains(&authored(instruction.origin))
        )
    }));
    let ssa = analyze_ssa(function).expect("destructuring-assignment SSA");
    assert_eq!(
        ssa.definitions
            .iter()
            .filter(|definition| definition.kind == SsaDefinitionKind::PatternAssignment)
            .count(),
        4,
        "a is defined by both assignments while b and rest are each defined once"
    );
    analyze_dependencies(&hir, function.id, &ssa).expect("destructuring-assignment dependencies");
}
#[test]
fn plain_assignment_results_do_not_escape_reactive_pattern_targets() {
    let source = r#"
        import { $state } from 'fict';
        function App(consume) {
            let first = $state(0);
            let second = $state(0);
            const rhs = [1, undefined];
            return consume([first, second = first] = rhs);
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_some(), "{:?}", output.diagnostics);
    assert!(
        output
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code.as_str() != "FICT-R002"),
        "a plain assignment passes its RHS, not the reactive write targets: {:?}",
        output.diagnostics
    );
}

#[test]
fn identity_lookup_arguments_do_not_escape_proven_builtin_receivers() {
    let source = r#"
        import { $state } from 'fict';
        function App() {
            const rows = $state([{ done: false }]);
            const map = $state(new Map());
            const set = $state(new Set());
            const weakMap = $state(new WeakMap());
            const weakSet = $state(new WeakSet());
            const bytes = $state(new Uint8Array([1]));
            const plain = [];
            const rowAlias = rows;
            const mapAlias = map;
            const plainMap = new Map();
            const results = [
                rows.includes(rows[0]),
                rows["indexOf"](rows[0]),
                rows.lastIndexOf(rows[0]),
                map.get(rows[0]),
                map.has(rows[0]),
                set.has(rows[0]),
                weakMap.get(rows[0]),
                weakMap.has(rows[0]),
                weakSet.has(rows[0]),
                bytes.includes(rows[0]),
                bytes.indexOf(rows[0]),
                bytes.lastIndexOf(rows[0]),
                plain.includes(rows[0]),
                new Map().get(rows[0]),
                rowAlias.includes(rows[0]),
                mapAlias.has(rows[0]),
                plainMap.get(rows[0]),
                rows.includes(() => rows[0]),
            ];
            return results.length;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_some(), "{:?}", output.diagnostics);
    assert!(
        output
            .diagnostics
            .iter()
            .all(|diagnostic| { !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005") }),
        "identity comparisons and key lookups do not retain or execute their first argument: {:?}",
        output.diagnostics
    );
}

#[test]
fn identity_lookup_escape_exemptions_fail_closed() {
    let cases = [
        (
            "unknown receiver",
            r#"
                import { $state } from 'fict';
                function App(custom) {
                    const rows = $state([{ done: false }]);
                    return custom.includes(rows[0]);
                }
            "#,
            "rows[0]",
            "FICT-R002",
        ),
        (
            "string coercion",
            r#"
                import { $state } from 'fict';
                function App() {
                    const rows = $state([{ done: false }]);
                    const text = $state("ready");
                    return text.includes(rows[0]);
                }
            "#,
            "rows[0]",
            "FICT-R002",
        ),
        (
            "fromIndex coercion",
            r#"
                import { $state } from 'fict';
                function App() {
                    const rows = $state([{ done: false }]);
                    return rows.includes(null, rows[0]);
                }
            "#,
            "rows[0]",
            "FICT-R002",
        ),
        (
            "retaining array method",
            r#"
                import { $state } from 'fict';
                function App() {
                    const rows = $state([{ done: false }]);
                    return rows.concat(rows[0]);
                }
            "#,
            "rows[0]",
            "FICT-R002",
        ),
        (
            "spread argument",
            r#"
                import { $state } from 'fict';
                function App() {
                    const rows = $state([{ done: false }]);
                    return rows.includes(...[rows[0]]);
                }
            "#,
            "...[rows[0]]",
            "FICT-R002",
        ),
        (
            "direct state snapshot",
            r#"
                import { $state } from 'fict';
                function App() {
                    const rows = $state([{ done: false }]);
                    const map = $state(new Map());
                    return map.has(rows);
                }
            "#,
            "rows",
            "FICT-S002",
        ),
    ];
    for (name, source, expected_span, expected_code) in cases {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == expected_code
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == expected_span
                    })
            }),
            "{name}: expected {expected_code} on {expected_span:?}, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn builtin_escape_exemptions_reject_overridden_methods() {
    for (name, source, expected_span, expected_code) in [
        (
            "overridden array lookup",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const rows = $state([{ done: false }]);
                    const values = [];
                    values.includes = sink;
                    return values.includes(rows[0]);
                }
            "#,
            "rows[0]",
            "FICT-R002",
        ),
        (
            "overridden array callback host",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const count = $state(0);
                    const values = [];
                    values.forEach = sink;
                    values.forEach(() => count);
                    return count;
                }
            "#,
            "() => count",
            "FICT-R005",
        ),
        (
            "overridden array prototype",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const count = $state(0);
                    Array.prototype.forEach = sink;
                    const values = [];
                    values.forEach(() => count);
                    return count;
                }
            "#,
            "() => count",
            "FICT-R005",
        ),
        (
            "overridden method through alias",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const rows = $state([{ done: false }]);
                    const values = [];
                    const alias = values;
                    alias['includes'] = sink;
                    return values.includes(rows[0]);
                }
            "#,
            "rows[0]",
            "FICT-R002",
        ),
        (
            "overridden array returning chain",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const rows = $state([{ done: false }]);
                    const values = [];
                    values.filter = sink;
                    return values.filter(Boolean).includes(rows[0]);
                }
            "#,
            "rows[0]",
            "FICT-R002",
        ),
        (
            "overridden prototype through alias",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const count = $state(0);
                    const prototype = Array.prototype;
                    prototype.forEach = sink;
                    const values = [];
                    values.forEach(() => count);
                    return count;
                }
            "#,
            "() => count",
            "FICT-R005",
        ),
        (
            "defined array lookup property",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const rows = $state([{ done: false }]);
                    const values = [];
                    Object.defineProperty(values, 'includes', { value: sink });
                    return values.includes(rows[0]);
                }
            "#,
            "rows[0]",
            "FICT-R002",
        ),
        (
            "defined array prototype callback host",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const count = $state(0);
                    Reflect.defineProperty(Array.prototype, 'forEach', { value: sink });
                    const values = [];
                    values.forEach(() => count);
                    return count;
                }
            "#,
            "() => count",
            "FICT-R005",
        ),
        (
            "aliased reflective mutator",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const rows = $state([{ done: false }]);
                    const values = [];
                    const define = Object['defineProperty'];
                    define(values, 'includes', { value: sink });
                    return values.includes(rows[0]);
                }
            "#,
            "rows[0]",
            "FICT-R002",
        ),
    ] {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == expected_code
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == expected_span
                    })
            }),
            "{name}: expected {expected_code} on {expected_span:?}, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn prototype_indirection_invalidates_builtin_escape_exemptions() {
    for (name, mutation) in [
        (
            "prototype reassignment",
            "values.__proto__ = { forEach: sink };",
        ),
        (
            "prototype member mutation",
            "values.__proto__.forEach = sink;",
        ),
        (
            "computed prototype member mutation",
            "values['__proto__']['forEach'] = sink;",
        ),
        (
            "constructor prototype mutation",
            "values.constructor.prototype.forEach = sink;",
        ),
        (
            "reflective prototype reassignment",
            "Reflect.set(values, '__proto__', { forEach: sink });",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function useRun(sink) {{
                    const count = $state(0);
                    const values = [];
                    {mutation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn prototype_lookup_mutations_invalidate_builtin_escape_exemptions() {
    for (name, mutation) in [
        (
            "direct object lookup",
            "Object.getPrototypeOf(values).forEach = sink;",
        ),
        (
            "direct reflect lookup",
            "Reflect.getPrototypeOf(values).forEach = sink;",
        ),
        (
            "stored prototype",
            "const prototype = Object.getPrototypeOf(values); prototype.forEach = sink;",
        ),
        (
            "assigned prototype",
            "let prototype; prototype = Object.getPrototypeOf(values); prototype.forEach = sink;",
        ),
        (
            "nested prototype alias",
            "const holder = { prototype: Object.getPrototypeOf(values) }; holder.prototype.forEach = sink;",
        ),
        (
            "aliased lookup",
            "const getPrototype = Object.getPrototypeOf; const prototype = getPrototype(values); prototype.forEach = sink;",
        ),
        (
            "reflective prototype mutation",
            "Object.defineProperty(Object.getPrototypeOf(values), 'forEach', { value: sink });",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function useRun(sink) {{
                    const count = $state(0);
                    const values = [];
                    {mutation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn shared_prototype_mutations_invalidate_other_builtin_receivers() {
    for (name, mutation) in [
        ("prototype member", "first.__proto__.forEach = sink;"),
        (
            "constructor prototype member",
            "first.constructor.prototype.forEach = sink;",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function useRun(sink) {{
                    const count = $state(0);
                    const first = [];
                    const second = [];
                    {mutation}
                    second.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn shared_prototype_mutations_preserve_unrelated_builtin_methods() {
    let source = r#"
        import { $state } from 'fict';
        function App(sink) {
            const count = $state(0);
            const first = [];
            const second = [];
            first.__proto__.forEach = sink;
            second.map(() => count);
            return count;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_some(), "{:?}", output.diagnostics);
    assert!(
        output
            .diagnostics
            .iter()
            .all(|diagnostic| { !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005") }),
        "mutating forEach must not invalidate map: {:?}",
        output.diagnostics
    );
}

#[test]
fn own_constructor_property_does_not_invalidate_builtin_methods() {
    let source = r#"
        import { $state } from 'fict';
        function App(sink) {
            const count = $state(0);
            const values = [];
            values.constructor = { prototype: { forEach: sink } };
            values.forEach(() => count);
            return count;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_some(), "{:?}", output.diagnostics);
    assert!(
        output
            .diagnostics
            .iter()
            .all(|diagnostic| { !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005") }),
        "an own constructor property does not change the receiver prototype: {:?}",
        output.diagnostics
    );
}

#[test]
fn unknown_calls_invalidate_exposed_builtin_receivers() {
    for (name, prelude, parameters, exposure) in [
        ("parameter", "", "configure", "configure(values);"),
        ("parameter member", "", "api", "api.configure(values);"),
        (
            "aliased parameter",
            "",
            "configure",
            "const run = configure; run(values);",
        ),
        (
            "import",
            "import { configure } from 'external';",
            "",
            "configure(values);",
        ),
        ("unresolved global", "", "", "configure(values);"),
        ("object wrapper", "", "configure", "configure({ values });"),
        ("array wrapper", "", "configure", "configure([values]);"),
        (
            "stored nested wrapper",
            "",
            "configure",
            "const payload = { nested: [values] }; configure(payload);",
        ),
        (
            "literal spread arguments",
            "",
            "configure",
            "configure(...[values]);",
        ),
        (
            "stored spread arguments",
            "",
            "configure",
            "const args = [values]; configure(...args);",
        ),
        (
            "reassigned wrapper after exposure",
            "",
            "configure",
            "let payload = { values }; configure(payload, payload = {});",
        ),
        (
            "deferred reassigned wrapper",
            "",
            "configure",
            "let payload = { values: [] }; function expose() { configure(payload); } payload = { values }; expose();",
        ),
        (
            "conditional result",
            "",
            "configure, flag",
            "configure(flag ? values : []);",
        ),
        (
            "overridden safe global",
            "",
            "configure",
            "Object.keys = configure; Object.keys(values);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                {prelude}
                function App({parameters}) {{
                    const count = $state(0);
                    const values = [];
                    {exposure}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn external_calls_preserve_unexposed_builtin_receivers() {
    let source = r#"
        import { $state } from 'fict';
        function App(configure) {
            const count = $state(0);
            const values = [];
            configure(values.length);
            Object.keys(values);
            const keys = Object.keys;
            keys(values);
            configure(...values);
            values.forEach(() => count);
            return count;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_some(), "{:?}", output.diagnostics);
    assert!(
        output
            .diagnostics
            .iter()
            .all(|diagnostic| { !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005") }),
        "primitive projections and safe globals must preserve method integrity: {:?}",
        output.diagnostics
    );
}

#[test]
fn unknown_calls_invalidate_exposed_shared_prototypes() {
    for (name, exposure) in [
        ("prototype object", "configure(first.__proto__);"),
        ("constructor object", "configure(first.constructor);"),
        (
            "looked-up prototype object",
            "configure(Object.getPrototypeOf(first));",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App(configure) {{
                    const count = $state(0);
                    const first = [];
                    const second = [];
                    {exposure}
                    second.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn external_constructors_and_tags_invalidate_exposed_builtin_receivers() {
    for (name, parameters, exposure) in [
        ("constructor", "External", "new External(values);"),
        (
            "spread constructor arguments",
            "External",
            "new External(...[values]);",
        ),
        (
            "wrapped constructor argument",
            "External",
            "new External({ values });",
        ),
        ("tagged template", "tag", "tag`${values}`;"),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App({parameters}) {{
                    const count = $state(0);
                    const values = [];
                    {exposure}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn builtin_constructors_preserve_source_receiver_methods() {
    let source = r#"
        import { $state } from 'fict';
        function App() {
            const count = $state(0);
            const values = [];
            new Array(values);
            new Set(values);
            new Uint8Array(values);
            values.forEach(() => count);
            return count;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_some(), "{:?}", output.diagnostics);
    assert!(
        output
            .diagnostics
            .iter()
            .all(|diagnostic| { !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005") }),
        "intact builtin constructors do not expose their source receiver: {:?}",
        output.diagnostics
    );
}

#[test]
fn external_calls_invalidate_receivers_returned_by_factories() {
    for (name, exposure) in [
        ("concise arrow", "configure(() => values);"),
        ("block arrow", "configure(() => { return { values }; });"),
        (
            "function expression",
            "configure(function () { return values; });",
        ),
        (
            "function declaration",
            "function expose() { return values; } configure(expose);",
        ),
        (
            "hoisted function declaration",
            "configure(expose); function expose() { return values; }",
        ),
        (
            "async function declaration",
            "async function expose() { return values; } configure(expose);",
        ),
        (
            "generator declaration",
            "function* expose() { yield values; } configure(expose);",
        ),
        (
            "generator yield",
            "configure(function* () { yield values; });",
        ),
        (
            "delegated generator yield",
            "configure(function* () { yield* [values]; });",
        ),
        (
            "stored factory",
            "const expose = () => values; configure(expose);",
        ),
        (
            "assigned factory",
            "let expose; expose = () => values; configure(expose);",
        ),
        (
            "aliased factory",
            "const expose = () => values; const run = expose; configure(run);",
        ),
        (
            "factory property",
            "const holder = { expose: () => values }; configure(holder.expose);",
        ),
        (
            "factory container",
            "const holder = { expose: () => values }; configure(holder);",
        ),
        (
            "factory method container",
            "const holder = { expose() { return values; } }; configure(holder);",
        ),
        (
            "deferred reassigned factory",
            "let expose = () => []; function pass() { configure(expose); } expose = () => values; pass();",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App(configure) {{
                    const count = $state(0);
                    const values = [];
                    {exposure}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn external_calls_preserve_receivers_hidden_by_factories() {
    let source = r#"
        import { $state } from 'fict';
        function App(configure) {
            const count = $state(0);
            const values = [];
            configure(() => values.length);
            configure(() => { void values; return 1; });
            let expose = () => values;
            expose = () => [];
            configure(expose);
            values.forEach(() => count);
            return count;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_some(), "{:?}", output.diagnostics);
    assert!(
        output
            .diagnostics
            .iter()
            .all(|diagnostic| { !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005") }),
        "capturing without returning a receiver must preserve method integrity: {:?}",
        output.diagnostics
    );
}

#[test]
fn function_declaration_factories_preserve_hidden_receivers() {
    for (name, setup) in [
        (
            "captured but unreturned receiver",
            "function inspect() { void values; return 1; } configure(inspect);",
        ),
        (
            "unrelated returned receiver",
            "const other = []; function expose() { return other; } configure(expose);",
        ),
        (
            "reassigned declaration",
            "function expose() { return values; } expose = () => []; configure(expose);",
        ),
        (
            "nested declaration capture",
            "function inspect() { function nested() { return values; } return 1; } configure(inspect);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App(configure) {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn unreferenced_deferred_factory_replacements_preserve_receivers() {
    for (name, setup) in [
        (
            "ordinary callable",
            "let expose = () => []; function replace() { expose = () => values; } configure(expose);",
        ),
        (
            "bound callable",
            "const returnsValues = () => values; const hidden = () => []; let expose = hidden.bind(null); function replace() { expose = returnsValues.bind(null); } configure(expose);",
        ),
        (
            "arrow callable",
            "let expose = () => []; const replace = () => { expose = () => values; }; configure(expose);",
        ),
        (
            "function expression callable",
            "let expose = () => []; const replace = function () { expose = () => values; }; configure(expose);",
        ),
        (
            "assigned callable",
            "let expose = () => []; let replace; replace = () => { expose = () => values; }; configure(expose);",
        ),
        (
            "aliased replacement",
            "const returnsValues = () => values; let expose = () => []; function replace() { expose = returnsValues; } configure(expose);",
        ),
        (
            "unreferenced object method",
            "let expose = () => []; const helpers = { replace() { expose = () => values; } }; configure(expose);",
        ),
        (
            "unreferenced array function",
            "let expose = () => []; const helpers = [() => { expose = () => values; }]; configure(expose);",
        ),
        (
            "overwritten exposure history",
            "let expose = () => values; expose = () => []; function replace() { expose = () => values; } configure(expose);",
        ),
        (
            "overwritten alias history",
            "const returnsValues = () => values; const hidden = () => []; let expose = returnsValues; expose = hidden; function replace() { expose = returnsValues; } configure(expose);",
        ),
        (
            "conditional dead replacement",
            "let expose = () => []; function replace() { if (choose) expose = () => values; } configure(expose);",
        ),
        (
            "unreferenced deferred exposure",
            "const expose = () => values; function pass() { configure(expose); }",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App(configure, choose) {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn invoked_deferred_factory_replacements_invalidate_receivers() {
    for (name, setup) in [
        (
            "ordinary callable",
            "let expose = () => []; function replace() { expose = () => values; } replace(); configure(expose);",
        ),
        (
            "bound callable",
            "const returnsValues = () => values; const hidden = () => []; let expose = hidden.bind(null); function replace() { expose = returnsValues.bind(null); } replace(); configure(expose);",
        ),
        (
            "arrow callable",
            "let expose = () => []; const replace = () => { expose = () => values; }; replace(); configure(expose);",
        ),
        (
            "assigned callable",
            "let expose = () => []; let replace; replace = () => { expose = () => values; }; replace(); configure(expose);",
        ),
        (
            "aliased invocation",
            "let expose = () => []; function replace() { expose = () => values; } const run = replace; run(); configure(expose);",
        ),
        (
            "escaped replacement",
            "let expose = () => []; function replace() { expose = () => values; } schedule(replace); configure(expose);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App(configure, schedule) {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn local_calls_propagate_parameter_method_invalidations() {
    for (name, helper, call) in [
        (
            "function declaration",
            "function mutate(target) { target.forEach = sink; }",
            "mutate(values);",
        ),
        (
            "arrow binding",
            "const mutate = target => { target.forEach = sink; };",
            "mutate(values);",
        ),
        (
            "aliased helper",
            "function mutate(target) { target.forEach = sink; } const run = mutate;",
            "run(values);",
        ),
        (
            "aliased parameter",
            "function mutate(target) { const alias = target; alias.forEach = sink; }",
            "mutate(values);",
        ),
        (
            "delegated helper",
            "function inner(target) { target.forEach = sink; } function mutate(target) { inner(target); }",
            "mutate(values);",
        ),
        (
            "reflective helper",
            "function mutate(target) { Object.defineProperty(target, 'forEach', { value: null }); }",
            "mutate(values);",
        ),
        (
            "mutation before detachment",
            "function mutate(target) { target.forEach = sink; target = {}; }",
            "mutate(values);",
        ),
        (
            "conditional detachment",
            "function mutate(target, flag) { if (flag) target = {}; target.forEach = sink; }",
            "mutate(values, false);",
        ),
        (
            "logical detachment",
            "function mutate(target, flag) { flag && (target = {}); target.forEach = sink; }",
            "mutate(values, false);",
        ),
        (
            "catch detachment",
            "function mutate(target) { try {} catch { target = {}; } target.forEach = sink; }",
            "mutate(values);",
        ),
        (
            "default detachment",
            "function mutate(target, spare = (target = {})) { target.forEach = sink; }",
            "mutate(values, {});",
        ),
        (
            "hoisted declaration",
            "mutate(values); function mutate(target) { target.forEach = sink; }",
            "",
        ),
        (
            "deferred signature reassignment",
            "let mutate = target => { target.forEach = sink; }; function replace() { mutate = target => target.length; }",
            "mutate(values);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App(sink) {{
                    const count = $state(0);
                    const values = [];
                    {helper}
                    {call}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn pure_local_calls_preserve_receiver_methods() {
    for (name, helper, call) in [
        (
            "read-only helper",
            "function inspect(target) { return target.length; }",
            "inspect(values);",
        ),
        (
            "detached direct mutation",
            "function detach(target) { target = {}; target.forEach = sink; }",
            "detach(values);",
        ),
        (
            "detached delegated mutation",
            "function mutate(target) { target.forEach = sink; } function detach(target) { target = {}; mutate(target); }",
            "detach(values);",
        ),
        (
            "detached reflective mutation",
            "function detach(target) { target = {}; Object.defineProperty(target, 'forEach', { value: null }); }",
            "detach(values);",
        ),
        (
            "rebound parameter",
            "function mutate(target, other) { target = other; target.forEach = null; } const other = [];",
            "mutate(values, other);",
        ),
        (
            "deferred pure signature",
            "let inspect = target => target.length; function replace() { inspect = target => { target.forEach = null; }; }",
            "inspect(values);",
        ),
        (
            "unadvanced generator",
            "function* inspect(target) { target.forEach = null; }",
            "inspect(values);",
        ),
        (
            "unadvanced generator capture",
            "function* inspect() { values.forEach = null; }",
            "inspect();",
        ),
        (
            "unadvanced aliased generator capture",
            "function* inspect() { values.forEach = null; } const run = inspect;",
            "run();",
        ),
        (
            "unadvanced assigned generator capture",
            "function* inspect() { values.forEach = null; } let run; run = inspect;",
            "run();",
        ),
        (
            "unadvanced assigned generator expression capture",
            "let run; run = function* () { values.forEach = null; };",
            "run();",
        ),
        (
            "unadvanced assigned generator member capture",
            "function* inspect() { values.forEach = null; } const holder = {}; holder.run = inspect;",
            "holder.run();",
        ),
        (
            "unadvanced directly invoked generator assignment",
            "function* inspect() { values.forEach = null; } let run;",
            "(run = inspect)();",
        ),
        (
            "unadvanced conditional generator capture",
            "function* inspectA() { values.forEach = null; } function* inspectB() { values.forEach = null; } const run = choose ? inspectA : inspectB;",
            "run();",
        ),
        (
            "voided generator iterator",
            "function* inspect(target) { target.forEach = null; }",
            "void inspect(values);",
        ),
        (
            "sequenced generator iterator",
            "function* inspect(target) { target.forEach = null; }",
            "(inspect(values), 0);",
        ),
        (
            "unadvanced generator expression",
            "const inspect = function* (target) { target.forEach = null; };",
            "inspect(values);",
        ),
        (
            "unadvanced inline generator",
            "",
            "(function* (target) { target.forEach = null; })(values);",
        ),
        (
            "unadvanced inline generator capture",
            "",
            "(function* () { values.forEach = null; })();",
        ),
        (
            "unadvanced inline generator call",
            "",
            "(function* (target) { target.forEach = null; }).call(null, values);",
        ),
        (
            "unadvanced inline generator call capture",
            "",
            "(function* () { values.forEach = null; }).call(null);",
        ),
        (
            "unadvanced inline generator apply",
            "",
            "(function* (target) { target.forEach = null; }).apply(null, [values]);",
        ),
        (
            "unadvanced inline generator apply capture",
            "",
            "(function* () { values.forEach = null; }).apply(null, []);",
        ),
        (
            "unadvanced inline generator Reflect.apply capture",
            "",
            "Reflect.apply(function* () { values.forEach = null; }, null, []);",
        ),
        (
            "unadvanced inline bound generator",
            "const inspect = (function* (target) { target.forEach = null; }).bind(null);",
            "inspect(values);",
        ),
        (
            "unadvanced async generator",
            "async function* inspect(target) { target.forEach = null; }",
            "inspect(values);",
        ),
        (
            "unadvanced generator method",
            "const holder = { *inspect(target) { target.forEach = null; } };",
            "holder.inspect(values);",
        ),
        (
            "unadvanced bound generator",
            "function* inspect(target) { target.forEach = null; } const run = inspect.bind(null);",
            "run(values);",
        ),
        (
            "unadvanced bound generator capture",
            "function* inspect() { values.forEach = null; } const run = inspect.bind(null);",
            "run();",
        ),
        (
            "unadvanced computed bound generator capture",
            "function* inspect() { values.forEach = null; } const run = inspect['bind'](null);",
            "run();",
        ),
        (
            "unadvanced inline bound generator capture",
            "const run = (function* () { values.forEach = null; }).bind(null);",
            "run();",
        ),
        (
            "unadvanced generator call indirection",
            "function* inspect(target) { target.forEach = null; }",
            "inspect.call(null, values);",
        ),
        (
            "unadvanced generator call indirection capture",
            "function* inspect() { values.forEach = null; }",
            "inspect.call(null);",
        ),
        (
            "unadvanced generator apply indirection",
            "function* inspect(target) { target.forEach = null; }",
            "inspect.apply(null, [values]);",
        ),
        (
            "unadvanced generator apply indirection capture",
            "function* inspect() { values.forEach = null; }",
            "inspect.apply(null, []);",
        ),
        (
            "unadvanced generator Reflect.apply indirection",
            "function* inspect(target) { target.forEach = null; }",
            "Reflect.apply(inspect, null, [values]);",
        ),
        (
            "unadvanced generator Reflect.apply indirection capture",
            "function* inspect() { values.forEach = null; }",
            "Reflect.apply(inspect, null, []);",
        ),
        (
            "unread generator iterator",
            "function* inspect(target) { target.forEach = null; }",
            "const iterator = inspect(values);",
        ),
        (
            "unread captured generator iterator",
            "function* inspect() { values.forEach = null; }",
            "const iterator = inspect();",
        ),
        (
            "voided captured generator iterator",
            "function* inspect() { values.forEach = null; }",
            "const iterator = inspect(); void iterator;",
        ),
        (
            "observed generator iterator method",
            "function* inspect() { values.forEach = null; }",
            "const iterator = inspect(); void iterator.next;",
        ),
        (
            "voided inline captured generator iterator",
            "",
            "const iterator = (function* () { values.forEach = null; })(); void iterator;",
        ),
        (
            "voided bound captured generator iterator",
            "function* inspect() { values.forEach = null; } const run = inspect.bind(null);",
            "const iterator = run(); void iterator;",
        ),
        (
            "voided call captured generator iterator",
            "function* inspect() { values.forEach = null; }",
            "const iterator = inspect.call(null); void iterator;",
        ),
        (
            "voided Reflect.apply captured generator iterator",
            "function* inspect() { values.forEach = null; }",
            "const iterator = Reflect.apply(inspect, null, []); void iterator;",
        ),
        (
            "voided tagged captured generator iterator",
            "function* inspect() { values.forEach = null; }",
            "const iterator = inspect``; void iterator;",
        ),
        (
            "voided inline tagged captured generator iterator",
            "",
            "const iterator = (function* () { values.forEach = null; })``; void iterator;",
        ),
        (
            "voided bound tagged captured generator iterator",
            "function* inspect() { values.forEach = null; } const run = inspect.bind(null);",
            "const iterator = run``; void iterator;",
        ),
        (
            "generator used as constructor",
            "function* inspect(target) { target.forEach = null; }",
            "new inspect(values);",
        ),
        (
            "capturing generator used as constructor",
            "function* inspect() { values.forEach = null; }",
            "new inspect();",
        ),
        (
            "conditional unadvanced generators",
            "function* inspectA(target) { target.forEach = null; } function* inspectB(target) { target.forEach = null; } const inspect = choose ? inspectA : inspectB;",
            "inspect(values);",
        ),
        (
            "hoisted unadvanced generator",
            "inspect(values); function* inspect(target) { target.forEach = null; }",
            "",
        ),
        (
            "read-only class method receiver",
            "class Helper { inspect() { return this.length; } }",
            "Helper.prototype.inspect.call(values);",
        ),
        (
            "unadvanced class generator method receiver",
            "class Helper { *inspect() { this.forEach = null; } }",
            "Helper.prototype.inspect.call(values);",
        ),
        (
            "unadvanced class generator method capture",
            "class Helper { *inspect() { values.forEach = null; } }",
            "Helper.prototype.inspect();",
        ),
        (
            "unadvanced class expression generator capture",
            "const Helper = class { *inspect() { values.forEach = null; } };",
            "Helper.prototype.inspect();",
        ),
        (
            "unadvanced static generator method capture",
            "class Helper { static *inspect() { values.forEach = null; } }",
            "Helper.inspect();",
        ),
        (
            "unadvanced aliased class generator capture",
            "class Helper { *inspect() { values.forEach = null; } } const inspect = Helper.prototype.inspect;",
            "inspect();",
        ),
        (
            "unread class generator iterator capture",
            "class Helper { *inspect() { values.forEach = null; } }",
            "const iterator = Helper.prototype.inspect();",
        ),
        (
            "unadvanced static field generator capture",
            "class Helper { static inspect = function* () { values.forEach = null; }; }",
            "Helper.inspect();",
        ),
        (
            "static field overrides mutating method",
            "class Helper { static inspect(target) { target.forEach = null; } static inspect = target => target.length; }",
            "Helper.inspect(values);",
        ),
        (
            "read-only class instance method",
            "class Helper { inspect(target) { return target.length; } } const helper = new Helper();",
            "helper.inspect(values);",
        ),
        (
            "overridden class instance method",
            "class Helper { inspect(target) { target.forEach = null; } } const helper = new Helper(); helper.inspect = target => target.length;",
            "helper.inspect(values);",
        ),
        (
            "overridden class prototype method",
            "class Helper { inspect(target) { target.forEach = null; } } const helper = new Helper(); Helper.prototype.inspect = target => target.length;",
            "helper.inspect(values);",
        ),
        (
            "overridden inherited instance method",
            "class Parent { inspect(target) { target.forEach = null; } } class Helper extends Parent { inspect(target) { return target.length; } } const helper = new Helper();",
            "helper.inspect(values);",
        ),
        (
            "replacement constructor result",
            "class Helper { constructor() { return { inspect(target) { return target.length; } }; } inspect(target) { target.forEach = null; } } const helper = new Helper();",
            "helper.inspect(values);",
        ),
        (
            "replacement constructor callable alias",
            "function inspect(target) { return target.length; } class Helper { constructor() { return { inspect }; } inspect(target) { target.forEach = null; } } const helper = new Helper();",
            "helper.inspect(values);",
        ),
        (
            "replacement constructor bound callable",
            "function inspect(target) { return target.length; } class Helper { constructor() { return { inspect: inspect.bind(null) }; } } const helper = new Helper();",
            "helper.inspect(values);",
        ),
        (
            "replacement constructor inline bound callable",
            "class Helper { constructor() { return { inspect: (target => target.length).bind(null) }; } } const helper = new Helper();",
            "helper.inspect(values);",
        ),
        (
            "replacement constructor conditional callable",
            "function inspectA(target) { return target.length; } function inspectB(target) { return target.length + 1; } class Helper { constructor(choose) { return { inspect: choose ? inspectA : inspectB }; } } const helper = new Helper(true);",
            "helper.inspect(values);",
        ),
        (
            "replacement constructor conditional bound callable",
            "function inspectA(target) { return target.length; } function inspectB(target) { return target.length + 1; } class Helper { constructor(choose) { return { inspect: choose ? inspectA.bind(null) : inspectB.bind(null) }; } } const helper = new Helper(true);",
            "helper.inspect(values);",
        ),
        (
            "replacement constructor logical callable",
            "function inspectA(target) { return target.length; } function inspectB(target) { return target.length + 1; } class Helper { constructor() { return { inspect: inspectA || inspectB }; } } const helper = new Helper();",
            "helper.inspect(values);",
        ),
        (
            "replacement constructor shadows instance field",
            "class Helper { constructor() { return { inspect: target => target.length }; } inspect = target => { target.forEach = null; }; } const helper = new Helper();",
            "helper.inspect(values);",
        ),
        (
            "primitive constructor return preserves instance",
            "class Helper { constructor() { return 1; } inspect(target) { return target.length; } } const helper = new Helper();",
            "helper.inspect(values);",
        ),
        (
            "explicit this constructor return preserves instance",
            "class Helper { constructor() { return this; } inspect(target) { return target.length; } } const helper = new Helper();",
            "helper.inspect(values);",
        ),
        (
            "unadvanced replacement constructor generator capture",
            "class Helper { constructor() { return { inspect: function* () { values.forEach = null; } }; } } const helper = new Helper();",
            "helper.inspect();",
        ),
        (
            "unadvanced replacement constructor generator alias capture",
            "function* inspect() { values.forEach = null; } class Helper { constructor() { return { inspect }; } } const helper = new Helper();",
            "helper.inspect();",
        ),
        (
            "unadvanced replacement constructor chained generator alias capture",
            "function* inspect() { values.forEach = null; } const run = inspect; class Helper { constructor() { return { inspect: run }; } } const helper = new Helper();",
            "helper.inspect();",
        ),
        (
            "unadvanced replacement constructor bound generator capture",
            "function* inspect() { values.forEach = null; } class Helper { constructor() { return { inspect: inspect.bind(null) }; } } const helper = new Helper();",
            "helper.inspect();",
        ),
        (
            "unadvanced replacement constructor inline bound generator capture",
            "class Helper { constructor() { return { inspect: (function* () { values.forEach = null; }).bind(null) }; } } const helper = new Helper();",
            "helper.inspect();",
        ),
        (
            "unadvanced replacement constructor conditional generator capture",
            "function* inspectA() { values.forEach = null; } function* inspectB() { values.forEach = null; } class Helper { constructor(choose) { return { inspect: choose ? inspectA : inspectB }; } } const helper = new Helper(true);",
            "helper.inspect();",
        ),
        (
            "unadvanced replacement constructor conditional bound generator capture",
            "function* inspectA() { values.forEach = null; } function* inspectB() { values.forEach = null; } class Helper { constructor(choose) { return { inspect: choose ? inspectA.bind(null) : inspectB.bind(null) }; } } const helper = new Helper(true);",
            "helper.inspect();",
        ),
        (
            "unadvanced replacement constructor logical generator capture",
            "function* inspectA() { values.forEach = null; } function* inspectB() { values.forEach = null; } class Helper { constructor() { return { inspect: inspectA || inspectB }; } } const helper = new Helper();",
            "helper.inspect();",
        ),
        (
            "unadvanced hoisted replacement constructor generator capture",
            "class Helper { constructor() { return { inspect }; } } const helper = new Helper(); function* inspect() { values.forEach = null; }",
            "helper.inspect();",
        ),
        (
            "unadvanced hoisted replacement constructor bound generator capture",
            "class Helper { constructor() { return { inspect: inspect.bind(null) }; } } const helper = new Helper(); function* inspect() { values.forEach = null; }",
            "helper.inspect();",
        ),
        (
            "read-only class instance field",
            "class Helper { inspect = target => target.length; } const helper = new Helper();",
            "helper.inspect(values);",
        ),
        (
            "arrow instance field lexical receiver",
            "class Helper { inspect = () => { this.forEach = null; }; } const helper = new Helper();",
            "helper.inspect.call(values);",
        ),
        (
            "instance field shadows mutating method",
            "class Helper { inspect(target) { target.forEach = null; } inspect = target => target.length; } const helper = new Helper();",
            "helper.inspect(values);",
        ),
        (
            "inherited instance field shadows mutating method",
            "class Parent { inspect(target) { target.forEach = null; } } class Helper extends Parent { inspect = target => target.length; } const helper = new Helper();",
            "helper.inspect(values);",
        ),
        (
            "unadvanced generator instance field",
            "class Helper { inspect = function* (target) { target.forEach = null; }; } const helper = new Helper();",
            "helper.inspect(values);",
        ),
        (
            "unadvanced generator instance field capture",
            "class Helper { inspect = function* () { values.forEach = null; }; } const helper = new Helper();",
            "helper.inspect();",
        ),
        (
            "unadvanced generator instance method capture",
            "class Helper { *inspect() { values.forEach = null; } } const helper = new Helper();",
            "helper.inspect();",
        ),
        (
            "unadvanced inherited generator instance method capture",
            "class Parent { *inspect() { values.forEach = null; } } class Helper extends Parent {} const helper = new Helper();",
            "helper.inspect();",
        ),
        (
            "unadvanced inherited generator instance field capture",
            "class Parent { inspect = function* () { values.forEach = null; }; } class Helper extends Parent {} const helper = new Helper();",
            "helper.inspect();",
        ),
        (
            "unadvanced class expression generator instance method capture",
            "const Helper = class { *inspect() { values.forEach = null; } }; const helper = new Helper();",
            "helper.inspect();",
        ),
        (
            "unadvanced class expression generator instance field capture",
            "const Helper = class { inspect = function* () { values.forEach = null; }; }; const helper = new Helper();",
            "helper.inspect();",
        ),
        (
            "unadvanced direct class instance generator capture",
            "class Helper { *inspect() { values.forEach = null; } }",
            "new Helper().inspect();",
        ),
        (
            "unread generator instance field iterator capture",
            "class Helper { inspect = function* () { values.forEach = null; }; } const helper = new Helper();",
            "const iterator = helper.inspect();",
        ),
        (
            "unadvanced aliased generator instance capture",
            "class Helper { *inspect() { values.forEach = null; } } const helper = new Helper(); const alias = helper;",
            "alias.inspect();",
        ),
        (
            "unadvanced aliased generator instance field capture",
            "class Helper { inspect = function* () { values.forEach = null; }; } const helper = new Helper(); const alias = helper;",
            "alias.inspect();",
        ),
        (
            "unadvanced chained generator instance alias capture",
            "class Helper { *inspect() { values.forEach = null; } } const helper = new Helper(); const first = helper; const second = first;",
            "second.inspect();",
        ),
        (
            "unadvanced aliased class constructor generator capture",
            "class Helper { *inspect() { values.forEach = null; } } const Alias = Helper; const helper = new Alias();",
            "helper.inspect();",
        ),
        (
            "unadvanced aliased class constructor generator field capture",
            "class Helper { inspect = function* () { values.forEach = null; }; } const Alias = Helper; const helper = new Alias();",
            "helper.inspect();",
        ),
        (
            "unadvanced assigned generator instance alias capture",
            "class Helper { *inspect() { values.forEach = null; } } const helper = new Helper(); let alias; alias = helper;",
            "alias.inspect();",
        ),
        (
            "unadvanced assigned class constructor generator capture",
            "class Helper { *inspect() { values.forEach = null; } } let Alias; Alias = Helper; const helper = new Alias();",
            "helper.inspect();",
        ),
        (
            "unadvanced chained class constructor alias capture",
            "class Helper { *inspect() { values.forEach = null; } } const First = Helper; const Second = First;",
            "new Second().inspect();",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App(sink) {{
                    const count = $state(0);
                    const values = [];
                    {helper}
                    {call}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        let labels = output
            .diagnostics
            .iter()
            .filter_map(|diagnostic| diagnostic.primary_span)
            .map(|span| &source[span.start() as usize..span.end() as usize])
            .collect::<Vec<_>>();
        assert!(
            output.hir.is_some(),
            "{name}: labels={labels:?}, diagnostics={:?}",
            output.diagnostics
        );
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn observed_generator_iterators_propagate_local_effects() {
    for (name, setup, invocation) in [
        (
            "immediate iterator advance",
            "function* mutate(target) { target.forEach = null; }",
            "mutate(values).next();",
        ),
        (
            "stored iterator advance",
            "function* mutate(target) { target.forEach = null; }",
            "const iterator = mutate(values); iterator.next();",
        ),
        (
            "bound iterator advance",
            "function* mutate(target) { target.forEach = null; } const run = mutate.bind(null);",
            "const iterator = run(values); iterator.next();",
        ),
        (
            "bound capturing generator advance",
            "function* mutate() { values.forEach = null; } const run = mutate.bind(null);",
            "run().next();",
        ),
        (
            "overridden generator bind executes receiver",
            "function* mutate() { values.forEach = null; } mutate.bind = function () { this().next(); return () => {}; }; const run = mutate.bind(null);",
            "run();",
        ),
        (
            "aliased overridden generator bind executes receiver",
            "function* mutate() { values.forEach = null; } const alias = mutate; alias.bind = function () { this().next(); return () => {}; }; const run = mutate.bind(null);",
            "run();",
        ),
        (
            "overridden generator prototype bind executes receiver",
            "function* mutate() { values.forEach = null; } Function.prototype.bind = function () { this().next(); return () => {}; }; const run = mutate.bind(null);",
            "run();",
        ),
        (
            "call iterator advance",
            "function* mutate(target) { target.forEach = null; }",
            "const iterator = mutate.call(null, values); iterator.next();",
        ),
        (
            "call capturing generator advance",
            "function* mutate() { values.forEach = null; }",
            "mutate.call(null).next();",
        ),
        (
            "apply iterator advance",
            "function* mutate(target) { target.forEach = null; }",
            "const iterator = mutate.apply(null, [values]); iterator.next();",
        ),
        (
            "apply capturing generator advance",
            "function* mutate() { values.forEach = null; }",
            "mutate.apply(null, []).next();",
        ),
        (
            "Reflect.apply iterator advance",
            "function* mutate(target) { target.forEach = null; }",
            "const iterator = Reflect.apply(mutate, null, [values]); iterator.next();",
        ),
        (
            "Reflect.apply capturing generator advance",
            "function* mutate() { values.forEach = null; }",
            "Reflect.apply(mutate, null, []).next();",
        ),
        (
            "overridden generator prototype call executes receiver",
            "function* mutate() { values.forEach = null; } Function.prototype.call = function () { this().next(); return {}; };",
            "mutate.call(null);",
        ),
        (
            "replaced generator prototype call executes receiver",
            "function* mutate() { values.forEach = null; } const prototype = { call() { this().next(); return {}; } }; mutate.__proto__ = prototype;",
            "mutate.call(null);",
        ),
        (
            "overridden Reflect.apply executes generator",
            "function* mutate() { values.forEach = null; } Reflect.apply = function (target) { target().next(); return {}; };",
            "Reflect.apply(mutate, null, []);",
        ),
        (
            "generator dynamic receiver",
            "function* mutate() { this.forEach = null; }",
            "const iterator = mutate.call(values); iterator.next();",
        ),
        (
            "inline generator advance",
            "",
            "(function* (target) { target.forEach = null; })(values).next();",
        ),
        (
            "capturing generator advance",
            "function* mutate() { values.forEach = null; }",
            "mutate().next();",
        ),
        (
            "stored capturing generator advance",
            "function* mutate() { values.forEach = null; }",
            "const iterator = mutate(); iterator.next();",
        ),
        (
            "tagged capturing generator advance",
            "function* mutate() { values.forEach = null; }",
            "const iterator = mutate``; iterator.next();",
        ),
        (
            "assigned capturing generator advance",
            "function* mutate() { values.forEach = null; } let iterator;",
            "(iterator = mutate(), 0); iterator.next();",
        ),
        (
            "assigned generator alias advance",
            "function* mutate() { values.forEach = null; } let run; run = mutate;",
            "run().next();",
        ),
        (
            "directly invoked generator assignment advance",
            "function* mutate() { values.forEach = null; } let run;",
            "(run = mutate)().next();",
        ),
        (
            "assigned generator member advance",
            "function* mutate() { values.forEach = null; } const holder = {}; holder.run = mutate;",
            "holder.run().next();",
        ),
        (
            "generator parameter default",
            "function* mutate(unused = (values.forEach = null)) {}",
            "mutate();",
        ),
        (
            "class generator capture advance",
            "class Helper { *mutate() { values.forEach = null; } }",
            "Helper.prototype.mutate().next();",
        ),
        (
            "class generator parameter default",
            "class Helper { *mutate(unused = (values.forEach = null)) {} }",
            "Helper.prototype.mutate();",
        ),
        (
            "class instance generator method capture advance",
            "class Helper { *mutate() { values.forEach = null; } } const helper = new Helper();",
            "helper.mutate().next();",
        ),
        (
            "class instance generator field capture advance",
            "class Helper { mutate = function* () { values.forEach = null; }; } const helper = new Helper();",
            "helper.mutate().next();",
        ),
        (
            "inherited class instance generator capture advance",
            "class Parent { *mutate() { values.forEach = null; } } class Helper extends Parent {} const helper = new Helper();",
            "helper.mutate().next();",
        ),
        (
            "inherited class instance generator field capture advance",
            "class Parent { mutate = function* () { values.forEach = null; }; } class Helper extends Parent {} const helper = new Helper();",
            "helper.mutate().next();",
        ),
        (
            "direct class instance generator capture advance",
            "class Helper { *mutate() { values.forEach = null; } }",
            "new Helper().mutate().next();",
        ),
        (
            "mixed advanced and unadvanced class instances",
            "class Helper { *mutate() { values.forEach = null; } } const first = new Helper(); const second = new Helper(); first.mutate();",
            "second.mutate().next();",
        ),
        (
            "class instance generator field parameter default",
            "class Helper { mutate = function* (unused = (values.forEach = null)) {}; } const helper = new Helper();",
            "helper.mutate();",
        ),
        (
            "replacement constructor generator capture advance",
            "class Helper { constructor() { return { mutate: function* () { values.forEach = null; } }; } } const helper = new Helper();",
            "helper.mutate().next();",
        ),
        (
            "replacement constructor generator parameter default",
            "class Helper { constructor() { return { mutate: function* (unused = (values.forEach = null)) {} }; } } const helper = new Helper();",
            "helper.mutate();",
        ),
        (
            "mixed replacement constructor generator instances",
            "class Helper { constructor() { return { mutate: function* () { values.forEach = null; } }; } } const first = new Helper(); const second = new Helper(); first.mutate();",
            "second.mutate().next();",
        ),
        (
            "replacement constructor generator alias capture advance",
            "function* mutate() { values.forEach = null; } class Helper { constructor() { return { mutate }; } } const helper = new Helper();",
            "helper.mutate().next();",
        ),
        (
            "replacement constructor bound generator capture advance",
            "function* mutate() { values.forEach = null; } class Helper { constructor() { return { mutate: mutate.bind(null) }; } } const helper = new Helper();",
            "helper.mutate().next();",
        ),
        (
            "replacement constructor inline bound generator capture advance",
            "class Helper { constructor() { return { mutate: (function* () { values.forEach = null; }).bind(null) }; } } const helper = new Helper();",
            "helper.mutate().next();",
        ),
        (
            "replacement constructor conditional generator capture advance",
            "function* mutateA() { values.forEach = null; } function* mutateB() { values.forEach = null; } class Helper { constructor(choose) { return { mutate: choose ? mutateA : mutateB }; } } const helper = new Helper(true);",
            "helper.mutate().next();",
        ),
        (
            "hoisted replacement constructor generator capture advance",
            "class Helper { constructor() { return { mutate }; } } const helper = new Helper(); function* mutate() { values.forEach = null; }",
            "helper.mutate().next();",
        ),
        (
            "replacement constructor generator alias parameter default",
            "function* mutate(unused = (values.forEach = null)) {} class Helper { constructor() { return { mutate }; } } const helper = new Helper();",
            "helper.mutate();",
        ),
        (
            "aliased class instance generator capture advance",
            "class Helper { *mutate() { values.forEach = null; } } const helper = new Helper(); const alias = helper;",
            "alias.mutate().next();",
        ),
        (
            "aliased class instance generator field capture advance",
            "class Helper { mutate = function* () { values.forEach = null; }; } const helper = new Helper(); const alias = helper;",
            "alias.mutate().next();",
        ),
        (
            "aliased class constructor generator capture advance",
            "class Helper { *mutate() { values.forEach = null; } } const Alias = Helper; const helper = new Alias();",
            "helper.mutate().next();",
        ),
        (
            "aliased class constructor generator field capture advance",
            "class Helper { mutate = function* () { values.forEach = null; }; } const Alias = Helper;",
            "new Alias().mutate().next();",
        ),
        (
            "mixed original and aliased class constructors",
            "class Helper { *mutate() { values.forEach = null; } } const Alias = Helper; const first = new Helper(); const second = new Alias(); first.mutate();",
            "second.mutate().next();",
        ),
        (
            "assigned generator instance alias advance",
            "class Helper { *mutate() { values.forEach = null; } } const helper = new Helper(); let alias; alias = helper;",
            "alias.mutate().next();",
        ),
        (
            "assigned class constructor generator advance",
            "class Helper { *mutate() { values.forEach = null; } } let Alias; Alias = Helper; const helper = new Alias();",
            "helper.mutate().next();",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn mixed_generator_and_eager_callables_preserve_eager_effects() {
    let source = r#"
        import { $state } from 'fict';
        function App(choose) {
            const count = $state(0);
            const values = [];
            function* deferred(target) { target.forEach = null; }
            function eager(target) { target.forEach = null; }
            const mutate = choose ? deferred : eager;
            mutate(values);
            values.forEach(() => count);
            return count;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_none(), "expected a hard diagnostic");
    assert!(
        output.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R005"
                && diagnostic.primary_span.is_some_and(|span| {
                    &source[span.start() as usize..span.end() as usize] == "() => count"
                })
        }),
        "expected FICT-R005 on callback, got {:?}",
        output.diagnostics
    );
}

#[test]
fn class_method_invocations_propagate_local_effects() {
    for (name, helper, invocation) in [
        (
            "instance receiver",
            "class Helper { mutate() { this.forEach = null; } }",
            "Helper.prototype.mutate.call(values);",
        ),
        (
            "instance parameter",
            "class Helper { mutate(target) { target.forEach = null; } }",
            "Helper.prototype.mutate(values);",
        ),
        (
            "static receiver",
            "class Helper { static mutate() { this.forEach = null; } }",
            "Helper.mutate.call(values);",
        ),
        (
            "class expression receiver",
            "const Helper = class { mutate() { this.forEach = null; } };",
            "Helper.prototype.mutate.call(values);",
        ),
        (
            "aliased receiver",
            "class Helper { mutate() { this.forEach = null; } } const mutate = Helper.prototype.mutate;",
            "mutate.call(values);",
        ),
        (
            "bound receiver",
            "class Helper { mutate() { this.forEach = null; } } const mutate = Helper.prototype.mutate.bind(values);",
            "mutate();",
        ),
        (
            "computed method receiver",
            "class Helper { ['mutate']() { this.forEach = null; } }",
            "Helper.prototype.mutate.call(values);",
        ),
        (
            "generator method receiver",
            "class Helper { *mutate() { this.forEach = null; } }",
            "Helper.prototype.mutate.call(values).next();",
        ),
        (
            "static field parameter",
            "class Helper { static mutate = target => { target.forEach = null; }; }",
            "Helper.mutate(values);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(
            output.hir.is_none(),
            "{name}: diagnostics={:?}",
            output.diagnostics
        );
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn class_instance_method_invocations_propagate_local_effects() {
    for (name, helper, invocation) in [
        (
            "class declaration",
            "class Helper { mutate(target) { target.forEach = null; } } const helper = new Helper();",
            "helper.mutate(values);",
        ),
        (
            "class expression",
            "const Helper = class { mutate(target) { target.forEach = null; } }; const helper = new Helper();",
            "helper.mutate(values);",
        ),
        (
            "constructor alias",
            "class Helper { mutate(target) { target.forEach = null; } } const Alias = Helper; const helper = new Alias();",
            "helper.mutate(values);",
        ),
        (
            "instance alias",
            "class Helper { mutate(target) { target.forEach = null; } } const helper = new Helper(); const alias = helper;",
            "alias.mutate(values);",
        ),
        (
            "explicit constructor",
            "class Helper { constructor() {} mutate(target) { target.forEach = null; } } const helper = new Helper();",
            "helper.mutate(values);",
        ),
        (
            "bound instance method",
            "class Helper { mutate(target) { target.forEach = null; } } const helper = new Helper(); const mutate = helper.mutate.bind(helper);",
            "mutate(values);",
        ),
        (
            "computed instance method",
            "class Helper { ['mutate'](target) { target.forEach = null; } } const helper = new Helper();",
            "helper.mutate(values);",
        ),
        (
            "generator instance method",
            "class Helper { *mutate(target) { target.forEach = null; } } const helper = new Helper();",
            "helper.mutate(values).next();",
        ),
        (
            "inherited instance method",
            "class Parent { mutate(target) { target.forEach = null; } } class Helper extends Parent {} const helper = new Helper();",
            "helper.mutate(values);",
        ),
        (
            "overridden inherited method",
            "class Parent { inspect(target) { return target.length; } } class Helper extends Parent { mutate(target) { target.forEach = null; } } const helper = new Helper();",
            "helper.mutate(values);",
        ),
        (
            "replaced prototype method",
            "class Helper { mutate(target) { return target.length; } } const helper = new Helper(); Helper.prototype.mutate = function (target) { target.forEach = null; };",
            "helper.mutate(values);",
        ),
        (
            "replacement constructor result",
            "class Helper { constructor() { return { mutate(target) { target.forEach = null; } }; } mutate(target) { return target.length; } } const helper = new Helper();",
            "helper.mutate(values);",
        ),
        (
            "replacement constructor arrow",
            "class Helper { constructor() { return { mutate: target => { target.forEach = null; } }; } } const helper = new Helper();",
            "helper.mutate(values);",
        ),
        (
            "replacement constructor callable alias",
            "function mutate(target) { target.forEach = null; } class Helper { constructor() { return { mutate }; } } const helper = new Helper();",
            "helper.mutate(values);",
        ),
        (
            "replacement constructor bound callable",
            "function mutate(target) { target.forEach = null; } class Helper { constructor() { return { mutate: mutate.bind(null) }; } } const helper = new Helper();",
            "helper.mutate(values);",
        ),
        (
            "replacement constructor bound receiver",
            "function mutate() { this.forEach = null; } class Helper { constructor() { return { mutate: mutate.bind(values) }; } } const helper = new Helper();",
            "helper.mutate();",
        ),
        (
            "replacement constructor conditional callable",
            "function inspect(target) { return target.length; } function mutate(target) { target.forEach = null; } class Helper { constructor(choose) { return { mutate: choose ? inspect : mutate }; } } const helper = new Helper(false);",
            "helper.mutate(values);",
        ),
        (
            "replacement constructor conditional unknown callable",
            "function inspect(target) { return target.length; } class Helper { constructor(choose, factory) { return { mutate: choose ? inspect : factory() }; } } const helper = new Helper(false, () => null);",
            "helper.mutate(values);",
        ),
        (
            "replacement constructor unknown callable",
            "class Helper { constructor(factory) { return { mutate: factory() }; } } const helper = new Helper(() => null);",
            "helper.mutate(values);",
        ),
        (
            "dynamic class instance field",
            "const method = 'mutate'; class Helper { [method] = target => { target.forEach = null; }; } const helper = new Helper();",
            "helper.mutate(values);",
        ),
        (
            "dynamic class instance method",
            "const method = 'mutate'; class Helper { [method](target) { target.forEach = null; } } const helper = new Helper();",
            "helper.mutate(values);",
        ),
        (
            "conditional replacement constructor result",
            "class Helper { constructor(choose) { if (choose) return { mutate(target) { target.forEach = null; } }; return { mutate(target) { return target.length; } }; } } const helper = new Helper(true);",
            "helper.mutate(values);",
        ),
        (
            "unknown replacement constructor result",
            "class Helper { constructor(factory) { return factory(); } } const helper = new Helper(() => ({ mutate(target) { target.forEach = null; } }));",
            "helper.mutate(values);",
        ),
        (
            "spread replacement constructor result",
            "const methods = { mutate(target) { target.forEach = null; } }; class Helper { constructor() { return { ...methods }; } } const helper = new Helper();",
            "helper.mutate(values);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(
            output.hir.is_none(),
            "{name}: diagnostics={:?}",
            output.diagnostics
        );
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn class_instance_field_invocations_propagate_local_effects() {
    for (name, helper, invocation) in [
        (
            "arrow field parameter",
            "class Helper { mutate = target => { target.forEach = null; }; } const helper = new Helper();",
            "helper.mutate(values);",
        ),
        (
            "function field parameter",
            "class Helper { mutate = function (target) { target.forEach = null; }; } const helper = new Helper();",
            "helper.mutate(values);",
        ),
        (
            "function field receiver",
            "class Helper { mutate = function () { this.forEach = null; }; } const helper = new Helper();",
            "helper.mutate.call(values);",
        ),
        (
            "generator field parameter",
            "class Helper { mutate = function* (target) { target.forEach = null; }; } const helper = new Helper();",
            "helper.mutate(values).next();",
        ),
        (
            "inherited arrow field",
            "class Parent { mutate = target => { target.forEach = null; }; } class Helper extends Parent {} const helper = new Helper();",
            "helper.mutate(values);",
        ),
        (
            "field shadows pure prototype method",
            "class Helper { mutate(target) { return target.length; } mutate = target => { target.forEach = null; }; } const helper = new Helper();",
            "helper.mutate(values);",
        ),
        (
            "bound arrow field",
            "class Helper { mutate = target => { target.forEach = null; }; } const helper = new Helper(); const mutate = helper.mutate.bind(null);",
            "mutate(values);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(
            output.hir.is_none(),
            "{name}: diagnostics={:?}",
            output.diagnostics
        );
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn invoked_callable_replacements_propagate_local_effects() {
    for (name, helper, invocation) in [
        (
            "ordinary callable",
            "function inspect(target) { return target.length; } function mutate(target) { target.forEach = null; } let run = inspect; function replace() { run = mutate; } replace();",
            "run(values);",
        ),
        (
            "arrow replacement",
            "const inspect = target => target.length; const mutate = target => { target.forEach = null; }; let run = inspect; const replace = () => { run = mutate; }; replace();",
            "run(values);",
        ),
        (
            "aliased replacement invocation",
            "function inspect(target) { return target.length; } function mutate(target) { target.forEach = null; } let run = inspect; function replace() { run = mutate; } const configure = replace; configure();",
            "run(values);",
        ),
        (
            "call indirection",
            "function inspect(target) { return target.length; } function mutate(target) { target.forEach = null; } let run = inspect; function replace() { run = mutate; } replace();",
            "run.call(null, values);",
        ),
        (
            "apply indirection",
            "function inspect(target) { return target.length; } function mutate(target) { target.forEach = null; } let run = inspect; function replace() { run = mutate; } replace();",
            "run.apply(null, [values]);",
        ),
        (
            "Reflect.apply indirection",
            "function inspect(target) { return target.length; } function mutate(target) { target.forEach = null; } let run = inspect; function replace() { run = mutate; } replace();",
            "Reflect.apply(run, null, [values]);",
        ),
        (
            "bound callable",
            "function inspect(target) { return target.length; } function mutate(target) { target.forEach = null; } let run = inspect.bind(null); function replace() { run = mutate.bind(null); } replace();",
            "run(values);",
        ),
        (
            "dynamic receiver",
            "function inspect() { return this.length; } function mutate() { this.forEach = null; } let run = inspect; function replace() { run = mutate; } replace();",
            "run.call(values);",
        ),
        (
            "constructor",
            "function Inspect(target) { this.length = target.length; } function Mutate(target) { target.forEach = null; } let Make = Inspect; function replace() { Make = Mutate; } replace();",
            "new Make(values);",
        ),
        (
            "template tag",
            "function inspect(strings, target) { return target.length; } function mutate(strings, target) { target.forEach = null; } let run = inspect; function replace() { run = mutate; } replace();",
            "run`${values}`;",
        ),
        (
            "generator replaced by eager callable",
            "function* inspect(target) { target.forEach = null; } function mutate(target) { target.forEach = null; } let run = inspect; function replace() { run = mutate; } replace();",
            "run(values);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(
            output.hir.is_none(),
            "{name}: diagnostics={:?}",
            output.diagnostics
        );
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn alias_slot_replacements_preserve_previous_receiver_methods() {
    for (name, operation) in [
        ("direct assignment", "box.target = [];"),
        ("direct deletion", "delete box.target;"),
        (
            "local assignment",
            "function replace(wrapper) { wrapper.target = []; } replace(box);",
        ),
        (
            "local deletion",
            "function remove(wrapper) { delete wrapper.target; } remove(box);",
        ),
        (
            "reflective replacement",
            "function replace(wrapper) { Object.defineProperty(wrapper, 'target', { value: [] }); } replace(box);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    const box = {{ target: values }};
                    {operation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected the previous receiver to stay intact, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn alias_slot_nested_mutations_still_invalidate_receivers() {
    for (name, operation) in [
        ("direct nested assignment", "box.target.forEach = null;"),
        (
            "local nested assignment",
            "function mutate(wrapper) { wrapper.target.forEach = null; } mutate(box);",
        ),
        (
            "reflective nested replacement",
            "function mutate(wrapper) { Object.defineProperty(wrapper.target, 'forEach', { value: null }); } mutate(box);",
        ),
        (
            "root alias assignment",
            "const alias = values; alias.forEach = null;",
        ),
        (
            "nested external exposure",
            "function expose(wrapper) { external(wrapper.target); } expose(box);",
        ),
        (
            "nested reflective mutation",
            "function mutate(wrapper) { Object.assign(wrapper.target, { forEach: null }); } mutate(box);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    const box = {{ target: values }};
                    {operation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn inline_structured_invocations_propagate_nested_invalidations() {
    for (name, helper, invocation) in [
        (
            "object destructuring",
            "function mutate({ target }) { target.forEach = null; }",
            "mutate({ target: values });",
        ),
        (
            "array destructuring",
            "function mutate([target]) { target.forEach = null; }",
            "mutate([values]);",
        ),
        (
            "nested destructuring",
            "function mutate({ payload: [target] }) { target.forEach = null; }",
            "mutate({ payload: [values] });",
        ),
        (
            "direct wrapper access",
            "function mutate(wrapper) { wrapper.target.forEach = null; }",
            "mutate({ target: values });",
        ),
        (
            "nested external exposure",
            "function expose(wrapper) { external(wrapper.target); }",
            "expose({ target: values });",
        ),
        (
            "nested reflective mutation",
            "function mutate(wrapper) { Object.assign(wrapper.target, { forEach: null }); }",
            "mutate({ target: values });",
        ),
        (
            "conditional object",
            "function mutate({ target }) { target.forEach = null; }",
            "mutate(true ? { target: values } : { target: [] });",
        ),
        (
            "inline function",
            "",
            "(({ target }) => { target.forEach = null; })({ target: values });",
        ),
        (
            "constructor",
            "class Mutate { constructor({ target }) { target.forEach = null; } }",
            "new Mutate({ target: values });",
        ),
        (
            "Function.call",
            "function mutate({ target }) { target.forEach = null; }",
            "mutate.call(null, { target: values });",
        ),
        (
            "Function.apply",
            "function mutate({ target }) { target.forEach = null; }",
            "mutate.apply(null, [{ target: values }]);",
        ),
        (
            "template tag",
            "function mutate(_strings, { target }) { target.forEach = null; }",
            "mutate`${{ target: values }}`;",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn inline_structured_invocations_preserve_detached_and_sibling_values() {
    for (name, helper, invocation) in [
        (
            "property replacement",
            "function replace(wrapper) { wrapper.target = []; }",
            "replace({ target: values });",
        ),
        (
            "sibling mutation",
            "function mutate(wrapper) { wrapper.other.forEach = null; }",
            "mutate({ target: values, other: [] });",
        ),
        (
            "later duplicate property",
            "function mutate({ target }) { target.forEach = null; }",
            "mutate({ target: values, target: [] });",
        ),
        (
            "fresh array container",
            "function mutate(wrapper) { wrapper.forEach = null; }",
            "mutate([values]);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn computed_and_spread_object_arguments_propagate_nested_invalidations() {
    for (name, setup, helper, invocation) in [
        (
            "computed property after static property",
            "const key = 'other';",
            "function mutate({ target }) { target.forEach = null; }",
            "mutate({ target: values, [key]: [] });",
        ),
        (
            "computed property value",
            "const key = 'target';",
            "function mutate({ target }) { target.forEach = null; }",
            "mutate({ [key]: values });",
        ),
        (
            "object spread value",
            "const source = { target: values };",
            "function mutate({ target }) { target.forEach = null; }",
            "mutate({ ...source });",
        ),
        (
            "object spread preserves absent property",
            "const source = { other: [] };",
            "function mutate({ target }) { target.forEach = null; }",
            "mutate({ target: values, ...source });",
        ),
        (
            "nested object spread",
            "const source = { target: values };",
            "function mutate({ payload: { target } }) { target.forEach = null; }",
            "mutate({ payload: { ...source } });",
        ),
        (
            "nested computed property",
            "const key = 'target';",
            "function mutate({ payload: { target } }) { target.forEach = null; }",
            "mutate({ payload: { [key]: values } });",
        ),
        (
            "inline object spread",
            "",
            "function mutate({ target }) { target.forEach = null; }",
            "mutate({ ...{ target: values } });",
        ),
        (
            "conditional object spread",
            "const source = { target: values };",
            "function mutate({ target }) { target.forEach = null; }",
            "mutate({ ...(true ? source : {}) });",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn later_object_properties_and_fresh_spread_slots_preserve_values() {
    for (name, setup, helper, invocation) in [
        (
            "static property overrides computed property",
            "const key = 'target';",
            "function mutate({ target }) { target.forEach = null; }",
            "mutate({ [key]: values, target: [] });",
        ),
        (
            "static property overrides object spread",
            "const source = { target: values };",
            "function mutate({ target }) { target.forEach = null; }",
            "mutate({ ...source, target: [] });",
        ),
        (
            "nested static property overrides computed property",
            "const key = 'target';",
            "function mutate({ payload: { target } }) { target.forEach = null; }",
            "mutate({ payload: { [key]: values, target: [] } });",
        ),
        (
            "fresh spread slot replacement",
            "const source = { target: values };",
            "function replace(wrapper) { wrapper.target = []; }",
            "replace({ ...source });",
        ),
        (
            "spread sibling mutation",
            "const source = { target: values, other: [] };",
            "function mutate(wrapper) { wrapper.other.forEach = null; }",
            "mutate({ ...source });",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn spread_array_arguments_propagate_nested_invalidations() {
    for (name, setup, helper, invocation) in [
        (
            "inline array spread",
            "",
            "function mutate([target]) { target.forEach = null; }",
            "mutate([...[values]]);",
        ),
        (
            "inline spread after fixed element",
            "",
            "function mutate([_prefix, target]) { target.forEach = null; }",
            "mutate([0, ...[values]]);",
        ),
        (
            "inline spread before fixed element",
            "",
            "function mutate([_prefix, target]) { target.forEach = null; }",
            "mutate([...[0], values]);",
        ),
        (
            "stored array spread",
            "const source = [values];",
            "function mutate([target]) { target.forEach = null; }",
            "mutate([...source]);",
        ),
        (
            "nested array spread",
            "",
            "function mutate({ payload: [target] }) { target.forEach = null; }",
            "mutate({ payload: [...[values]] });",
        ),
        (
            "conditional array spread",
            "const source = [values];",
            "function mutate([target]) { target.forEach = null; }",
            "mutate([...(true ? source : [])]);",
        ),
        (
            "unknown length before fixed value",
            "const prefix = true ? [] : [0];",
            "function mutate([target]) { target.forEach = null; }",
            "mutate([...prefix, values]);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn spread_array_positions_and_fresh_slots_preserve_values() {
    for (name, setup, helper, invocation) in [
        (
            "fixed value before unknown spread",
            "const source = [];",
            "function mutate([_first, second]) { second.forEach = null; }",
            "mutate([values, ...source]);",
        ),
        (
            "known spread position",
            "",
            "function mutate([first]) { first.forEach = null; }",
            "mutate([...[[]], values]);",
        ),
        (
            "fresh spread slot replacement",
            "const source = [values];",
            "function replace(wrapper) { wrapper[0] = []; }",
            "replace([...source]);",
        ),
        (
            "fresh array container",
            "const source = [values];",
            "function mutate(wrapper) { wrapper.forEach = null; }",
            "mutate([...source]);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn local_wrapper_exposures_invalidate_nested_values() {
    for (name, setup, helper, invocation) in [
        (
            "stored object wrapper",
            "const wrapper = { target: values };",
            "function expose(value) { external(value); }",
            "expose(wrapper);",
        ),
        (
            "inline object wrapper",
            "",
            "function expose(value) { external(value); }",
            "expose({ target: values });",
        ),
        (
            "stored array wrapper",
            "const wrapper = [values];",
            "function expose(value) { external(value); }",
            "expose(wrapper);",
        ),
        (
            "inline array wrapper",
            "",
            "function expose(value) { external(value); }",
            "expose([values]);",
        ),
        (
            "object spread nested value",
            "const wrapper = { target: values };",
            "function expose(value) { external(value); }",
            "expose({ ...wrapper });",
        ),
        (
            "array spread nested value",
            "const wrapper = [values];",
            "function expose(value) { external(value); }",
            "expose([...wrapper]);",
        ),
        (
            "nested wrapper property",
            "",
            "function expose(value) { external(value.payload); }",
            "expose({ payload: { target: values } });",
        ),
        (
            "delegated wrapper exposure",
            "const wrapper = { target: values };",
            "function inner(value) { external(value); } function expose(value) { inner(value); }",
            "expose(wrapper);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn local_wrapper_mutations_preserve_unexposed_nested_values() {
    for (name, setup, helper, invocation) in [
        (
            "wrapper member assignment",
            "",
            "function mutate(value) { value.other = []; }",
            "mutate({ target: values });",
        ),
        (
            "wrapper Object.assign",
            "",
            "function mutate(value) { Object.assign(value, { other: [] }); }",
            "mutate({ target: values });",
        ),
        (
            "sibling property exposure",
            "",
            "function expose(value) { external(value.other); }",
            "expose({ target: values, other: [] });",
        ),
        (
            "object spread source",
            "",
            "function expose(value) { external(value); }",
            "expose({ ...values });",
        ),
        (
            "array spread source",
            "",
            "function expose(value) { external(value); }",
            "expose([...values]);",
        ),
        (
            "overwritten object spread property",
            "const source = { target: values };",
            "function expose(value) { external(value); }",
            "expose({ ...source, target: [] });",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn local_calls_propagate_destructured_parameter_invalidations() {
    for (name, setup, helper) in [
        (
            "object parameter",
            "const box = { target: values };",
            "function mutate({ target }) { target.forEach = null; }",
        ),
        (
            "array parameter",
            "const box = [values];",
            "function mutate([target]) { target.forEach = null; }",
        ),
        (
            "nested parameter",
            "const box = { payload: [values] };",
            "function mutate({ payload: [target] }) { target.forEach = null; }",
        ),
        (
            "defaulted binding",
            "const box = { target: values };",
            "function mutate({ target = [] }) { target.forEach = null; }",
        ),
        (
            "delegated binding",
            "const box = { target: values };",
            "function inner(target) { target.forEach = null; } function mutate({ target }) { inner(target); }",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {helper}
                    mutate(box);
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn detached_and_sibling_destructured_parameters_preserve_receiver_methods() {
    for (name, setup, helper) in [
        (
            "detached binding",
            "const box = { target: values };",
            "function mutate({ target }) { target = {}; target.forEach = null; }",
        ),
        (
            "sibling binding",
            "const other = []; const box = { target: other, safe: values };",
            "function mutate({ target }) { target.forEach = null; }",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {helper}
                    mutate(box);
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn local_calls_propagate_formal_rest_element_invalidations() {
    for (name, helper, call) in [
        (
            "direct rest binding",
            "function mutate(...targets) { targets[0].forEach = null; }",
            "mutate(values);",
        ),
        (
            "rest after positional parameter",
            "function mutate(prefix, ...targets) { targets[0].forEach = null; }",
            "mutate(null, values);",
        ),
        (
            "destructured rest binding",
            "function mutate(...[target]) { target.forEach = null; }",
            "mutate(values);",
        ),
        (
            "nested destructured rest binding",
            "const box = { target: values }; function mutate(...[{ target }]) { target.forEach = null; }",
            "mutate(box);",
        ),
        (
            "delegated rest element",
            "function inner(target) { target.forEach = null; } function mutate(...targets) { inner(targets[0]); }",
            "mutate(values);",
        ),
        (
            "reflective rest element",
            "function mutate(...targets) { Object.defineProperty(targets[0], 'forEach', { value: null }); }",
            "mutate(values);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {helper}
                    {call}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn formal_rest_container_mutations_preserve_arguments() {
    for (name, helper, call) in [
        (
            "rest container property",
            "function mutate(...targets) { targets.forEach = null; }",
            "mutate(values);",
        ),
        (
            "rest slot replacement",
            "function mutate(...targets) { targets[0] = []; }",
            "mutate(values);",
        ),
        (
            "detached destructured rest binding",
            "function mutate(...[target]) { target = {}; target.forEach = null; }",
            "mutate(values);",
        ),
        (
            "sibling rest element",
            "function mutate(...targets) { targets[1].forEach = null; }",
            "mutate(values, []);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {helper}
                    {call}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn local_calls_propagate_nested_rest_value_invalidations() {
    for (name, setup, helper) in [
        (
            "array pattern rest",
            "const box = [null, values];",
            "function mutate([head, ...tail]) { tail[0].forEach = null; }",
        ),
        (
            "nested array pattern rest",
            "const box = { items: [null, values] };",
            "function mutate({ items: [head, ...tail] }) { tail[0].forEach = null; }",
        ),
        (
            "object pattern rest",
            "const box = { skip: null, target: values };",
            "function mutate({ skip, ...rest }) { rest.target.forEach = null; }",
        ),
        (
            "delegated object rest value",
            "const box = { target: values };",
            "function inner(target) { target.forEach = null; } function mutate({ ...rest }) { inner(rest.target); }",
        ),
        (
            "reflective array rest value",
            "const box = [values];",
            "function mutate([...tail]) { Object.defineProperty(tail[0], 'forEach', { value: null }); }",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {helper}
                    mutate(box);
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn nested_rest_container_mutations_preserve_source_values() {
    for (name, setup, helper) in [
        (
            "array rest slot replacement",
            "const box = [values];",
            "function mutate([...tail]) { tail[0] = []; }",
        ),
        (
            "array rest container property",
            "const box = [values];",
            "function mutate([...tail]) { tail.forEach = null; }",
        ),
        (
            "object rest property replacement",
            "const box = { target: values };",
            "function mutate({ ...rest }) { rest.target = []; }",
        ),
        (
            "excluded object rest property",
            "const box = { target: values };",
            "function mutate({ target, ...rest }) { if (rest.target) rest.target.forEach = null; }",
        ),
        (
            "sibling object rest value",
            "const box = { other: [], safe: values };",
            "function mutate({ ...rest }) { rest.other.forEach = null; }",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {helper}
                    mutate(box);
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn immediately_invoked_functions_propagate_parameter_invalidations() {
    for (name, setup, call) in [
        (
            "arrow IIFE",
            "",
            "(target => { target.forEach = null; })(values);",
        ),
        (
            "function IIFE",
            "",
            "(function (target) { target.forEach = null; })(values);",
        ),
        (
            "sequence IIFE",
            "",
            "(0, target => { target.forEach = null; })(values);",
        ),
        (
            "destructured IIFE",
            "const box = { target: values };",
            "(({ target }) => { target.forEach = null; })(box);",
        ),
        (
            "rest IIFE",
            "",
            "((...targets) => { targets[0].forEach = null; })(values);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {call}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn pure_immediately_invoked_functions_preserve_receiver_methods() {
    for (name, call) in [
        ("read-only IIFE", "(target => target.length)(values);"),
        (
            "detached IIFE",
            "(target => { target = {}; target.forEach = null; })(values);",
        ),
        (
            "rest slot replacement",
            "((...targets) => { targets[0] = []; })(values);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {call}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn local_constructors_propagate_parameter_invalidations() {
    for (name, constructor, invocation) in [
        (
            "function declaration",
            "function Mutate(target) { target.forEach = null; }",
            "new Mutate(values);",
        ),
        (
            "function expression",
            "const Mutate = function (target) { target.forEach = null; };",
            "new Mutate(values);",
        ),
        (
            "class declaration",
            "class Mutate { constructor(target) { target.forEach = null; } }",
            "new Mutate(values);",
        ),
        (
            "class expression",
            "const Mutate = class { constructor(target) { target.forEach = null; } };",
            "new Mutate(values);",
        ),
        (
            "inline class",
            "",
            "new (class { constructor(target) { target.forEach = null; } })(values);",
        ),
        (
            "destructured constructor",
            "const box = { target: values }; class Mutate { constructor({ target }) { target.forEach = null; } }",
            "new Mutate(box);",
        ),
        (
            "delegated constructor",
            "function inner(target) { target.forEach = null; } class Mutate { constructor(target) { inner(target); } }",
            "new Mutate(values);",
        ),
        (
            "default derived constructor",
            "function Base(target) { target.forEach = null; } class Mutate extends Base {}",
            "new Mutate(values);",
        ),
        (
            "default derived class constructor",
            "class Base { constructor(target) { target.forEach = null; } } class Mutate extends Base {}",
            "new Mutate(values);",
        ),
        (
            "aliased default derived constructor",
            "function Base(target) { target.forEach = null; } const Alias = Base; class Mutate extends Alias {}",
            "new Mutate(values);",
        ),
        (
            "default derived class expression",
            "function Base(target) { target.forEach = null; } const Mutate = class extends Base {};",
            "new Mutate(values);",
        ),
        (
            "inline default derived base",
            "const Mutate = class extends (class { constructor(target) { target.forEach = null; } }) {};",
            "new Mutate(values);",
        ),
        (
            "nested inline default derived base",
            "function Base(target) { target.forEach = null; } const Mutate = class extends (class extends Base {}) {};",
            "new Mutate(values);",
        ),
        (
            "bound default derived base",
            "function Base(prefix, target) { target.forEach = null; } const Partial = Base.bind(null, 0); class Mutate extends Partial {}",
            "new Mutate(values);",
        ),
        (
            "inline bound default derived base",
            "function Base(prefix, target) { target.forEach = null; } class Mutate extends Base.bind(null, 0) {}",
            "new Mutate(values);",
        ),
        (
            "computed inline bound default derived base",
            "function Base(prefix, target) { target.forEach = null; } class Mutate extends Base['bind'](null, 0) {}",
            "new Mutate(values);",
        ),
        (
            "forward default derived base",
            "class Mutate extends Base {} function Base(target) { target.forEach = null; }",
            "new Mutate(values);",
        ),
        (
            "captured default derived base",
            "let Base = function (target) { target.forEach = null; }; class Mutate extends Base {} Base = function (target) { return target.length; };",
            "new Mutate(values);",
        ),
        (
            "rest default derived base",
            "function Base(...targets) { targets[0].forEach = null; } class Mutate extends Base {}",
            "new Mutate(...[values]);",
        ),
        (
            "conditional default derived base",
            "function MutateBase(target) { target.forEach = null; } function InspectBase(target) { return target.length; } const Base = choose ? MutateBase : InspectBase; class Mutate extends Base {}",
            "new Mutate(values);",
        ),
        (
            "inline conditional default derived base",
            "function MutateBase(target) { target.forEach = null; } function InspectBase(target) { return target.length; } class Mutate extends (choose ? MutateBase : InspectBase) {}",
            "new Mutate(values);",
        ),
        (
            "reflect construct default derived constructor",
            "function Base(target) { target.forEach = null; } class Mutate extends Base {}",
            "Reflect.construct(Mutate, [values]);",
        ),
        (
            "dynamic default derived base",
            "class Mutate extends getBase() {}",
            "new Mutate(values);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {constructor}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn pure_local_constructors_preserve_receiver_methods() {
    for (name, constructor) in [
        (
            "read-only function constructor",
            "function Inspect(target) { this.length = target.length; }",
        ),
        (
            "detached function constructor",
            "function Inspect(target) { target = {}; target.forEach = null; }",
        ),
        (
            "read-only class constructor",
            "class Inspect { constructor(target) { this.length = target.length; } }",
        ),
        (
            "detached class constructor",
            "class Inspect { constructor(target) { target = {}; target.forEach = null; } }",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {constructor}
                    new Inspect(values);
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn pure_default_derived_constructors_preserve_receiver_methods() {
    for (name, constructor) in [
        (
            "read-only base",
            "function Base(target) { return target.length; } class Inspect extends Base {}",
        ),
        (
            "forward read-only base",
            "class Inspect extends Base {} function Base(target) { return target.length; }",
        ),
        (
            "captured read-only base",
            "let Base = function (target) { return target.length; }; class Inspect extends Base {} Base = function (target) { target.forEach = null; };",
        ),
        (
            "base class without constructor",
            "class Base {} class Inspect extends Base {}",
        ),
        ("safe builtin base", "class Inspect extends Array {}"),
        (
            "explicit derived constructor",
            "function Base(target) { target.forEach = null; } class Inspect extends Base { constructor(target) { super([]); this.length = target.length; } }",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {constructor}
                    new Inspect(values);
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn external_default_derived_constructors_expose_forwarded_arguments() {
    let source = r#"
        import { $state } from 'fict';
        function App(External) {
            const count = $state(0);
            const values = [];
            class Mutate extends External {}
            new Mutate(values);
            values.forEach(() => count);
            return count;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_none(), "expected a hard diagnostic");
    assert!(
        output.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R005"
                && diagnostic.primary_span.is_some_and(|span| {
                    &source[span.start() as usize..span.end() as usize] == "() => count"
                })
        }),
        "expected FICT-R005 on callback, got {:?}",
        output.diagnostics
    );
}

#[test]
fn local_template_tags_propagate_substitution_invalidations() {
    for (name, tag, invocation) in [
        (
            "function tag",
            "function tag(strings, target) { target.forEach = null; }",
            "tag`${values}`;",
        ),
        (
            "arrow tag",
            "const tag = (strings, target) => { target.forEach = null; };",
            "tag`value:${values}`;",
        ),
        (
            "aliased tag",
            "function tag(strings, target) { target.forEach = null; } const run = tag;",
            "run`${values}`;",
        ),
        (
            "inline tag",
            "",
            "((strings, target) => { target.forEach = null; })`${values}`;",
        ),
        (
            "destructured substitution",
            "const box = { target: values }; function tag(strings, { target }) { target.forEach = null; }",
            "tag`${box}`;",
        ),
        (
            "rest tag",
            "function tag(...args) { args[1].forEach = null; }",
            "tag`${values}`;",
        ),
        (
            "dynamic tag receiver",
            "const holder = { target: values, tag: function () { this.target.forEach = null; } };",
            "holder.tag``;",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {tag}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn pure_local_template_tags_preserve_receiver_methods() {
    for (name, tag) in [
        (
            "template object mutation",
            "function tag(strings, target) { strings.forEach = null; return target.length; }",
        ),
        (
            "read-only substitution",
            "function tag(strings, target) { return target.length; }",
        ),
        (
            "detached substitution",
            "function tag(strings, target) { target = {}; target.forEach = null; }",
        ),
        (
            "unadvanced generator tag",
            "function* tag(strings, target) { target.forEach = null; }",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {tag}
                    tag`${{values}}`;
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn local_function_call_indirections_propagate_parameter_invalidations() {
    for (name, helper, invocation) in [
        (
            "direct call",
            "function mutate(target) { target.forEach = null; }",
            "mutate.call(null, values);",
        ),
        (
            "computed call",
            "function mutate(target) { target.forEach = null; }",
            "mutate['call'](null, values);",
        ),
        (
            "aliased helper call",
            "function mutate(target) { target.forEach = null; } const run = mutate;",
            "run.call(null, values);",
        ),
        (
            "destructured call",
            "const box = { target: values }; function mutate({ target }) { target.forEach = null; }",
            "mutate.call(null, box);",
        ),
        (
            "rest call",
            "function mutate(...targets) { targets[0].forEach = null; }",
            "mutate.call(null, values);",
        ),
        (
            "hoisted call",
            "mutate.call(null, values); function mutate(target) { target.forEach = null; }",
            "",
        ),
        (
            "inline call",
            "",
            "(function (target) { target.forEach = null; }).call(null, values);",
        ),
        (
            "dynamic receiver",
            "function mutate() { this.forEach = null; }",
            "mutate.call(values);",
        ),
        (
            "aliased dynamic receiver",
            "function mutate() { this.forEach = null; } const run = mutate;",
            "run['call'](values);",
        ),
        (
            "inline dynamic receiver",
            "",
            "(function () { this.forEach = null; }).call(values);",
        ),
        (
            "aliased this receiver",
            "function mutate() { const receiver = this; receiver.forEach = null; }",
            "mutate.call(values);",
        ),
        (
            "lexical arrow receiver",
            "function mutate() { (() => { this.forEach = null; })(); }",
            "mutate.call(values);",
        ),
        (
            "structured method receiver",
            "const holder = { target: values, mutate: function () { this.target.forEach = null; } };",
            "holder.mutate();",
        ),
        (
            "optional structured method receiver",
            "const holder = { target: values, mutate: function () { this.target.forEach = null; } };",
            "holder.mutate?.();",
        ),
        (
            "exposed dynamic receiver",
            "function mutate() { external(this); }",
            "mutate.call(values);",
        ),
        (
            "reflectively mutated dynamic receiver",
            "function mutate() { Object.defineProperty(this, 'forEach', { value: null }); }",
            "mutate.call(values);",
        ),
        (
            "assigned dynamic receiver",
            "function mutate() { Object.assign(this, { forEach: null }); }",
            "mutate.call(values);",
        ),
        (
            "computed class key receiver",
            "function mutate() { class Snapshot { [((this.forEach = null), 'value')]() {} } void Snapshot; }",
            "mutate.call(values);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn pure_and_overridden_function_call_indirections_preserve_receivers() {
    for (name, helper, invocation) in [
        (
            "read-only helper",
            "function inspect(target) { return target.length; }",
            "inspect.call(null, values);",
        ),
        (
            "detached helper",
            "function inspect(target) { target = {}; target.forEach = null; }",
            "inspect.call(null, values);",
        ),
        (
            "overridden call property",
            "function inspect(target) { target.forEach = null; } inspect.call = function (thisArg, target) { return target.length; };",
            "inspect.call(null, values);",
        ),
        (
            "read-only dynamic receiver",
            "function inspect() { return this.length; }",
            "inspect.call(values);",
        ),
        (
            "arrow lexical receiver",
            "const inspect = () => { this.forEach = null; };",
            "inspect.call(values);",
        ),
        (
            "detached dynamic receiver alias",
            "function inspect() { let receiver = this; receiver = {}; receiver.forEach = null; }",
            "inspect.call(values);",
        ),
        (
            "detached method reference",
            "const holder = { inspect: function () { this.forEach = null; } }; const inspect = holder.inspect;",
            "inspect();",
        ),
        (
            "instance field receiver",
            "function inspect() { class Snapshot { value = (this.forEach = null); } void Snapshot; }",
            "inspect.call(values);",
        ),
        (
            "static field receiver",
            "function inspect() { class Snapshot { static value = (this.forEach = null); } void Snapshot; }",
            "inspect.call(values);",
        ),
        (
            "static block receiver",
            "function inspect() { class Snapshot { static { this.forEach = null; } } void Snapshot; }",
            "inspect.call(values);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn local_function_apply_indirections_propagate_parameter_invalidations() {
    for (name, setup, helper, invocation) in [
        (
            "inline argument array",
            "",
            "function mutate(target) { target.forEach = null; }",
            "mutate.apply(null, [values]);",
        ),
        (
            "stored argument array",
            "const args = [values];",
            "function mutate(target) { target.forEach = null; }",
            "mutate.apply(null, args);",
        ),
        (
            "computed apply",
            "",
            "function mutate(target) { target.forEach = null; }",
            "mutate['apply'](null, [values]);",
        ),
        (
            "aliased helper apply",
            "",
            "function mutate(target) { target.forEach = null; } const run = mutate;",
            "run.apply(null, [values]);",
        ),
        (
            "destructured apply",
            "const box = { target: values };",
            "function mutate({ target }) { target.forEach = null; }",
            "mutate.apply(null, [box]);",
        ),
        (
            "rest apply",
            "",
            "function mutate(...targets) { targets[0].forEach = null; }",
            "mutate.apply(null, [values]);",
        ),
        (
            "inline function apply",
            "",
            "",
            "(function (target) { target.forEach = null; }).apply(null, [values]);",
        ),
        (
            "dynamic receiver",
            "",
            "function mutate() { this.forEach = null; }",
            "mutate.apply(values, []);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn pure_and_overridden_function_apply_indirections_preserve_receivers() {
    for (name, helper, invocation) in [
        (
            "read-only helper",
            "function inspect(target) { return target.length; }",
            "inspect.apply(null, [values]);",
        ),
        (
            "detached helper",
            "function inspect(target) { target = {}; target.forEach = null; }",
            "inspect.apply(null, [values]);",
        ),
        (
            "overridden apply property",
            "function inspect(target) { target.forEach = null; } inspect.apply = function (thisArg, args) { return args[0].length; };",
            "inspect.apply(null, [values]);",
        ),
        (
            "read-only dynamic receiver",
            "function inspect() { return this.length; }",
            "inspect.apply(values, []);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn local_reflect_apply_invocations_propagate_parameter_invalidations() {
    for (name, setup, helper, invocation) in [
        (
            "inline argument array",
            "",
            "function mutate(target) { target.forEach = null; }",
            "Reflect.apply(mutate, null, [values]);",
        ),
        (
            "stored argument array",
            "const args = [values];",
            "function mutate(target) { target.forEach = null; }",
            "Reflect.apply(mutate, null, args);",
        ),
        (
            "computed Reflect.apply",
            "",
            "function mutate(target) { target.forEach = null; }",
            "Reflect['apply'](mutate, null, [values]);",
        ),
        (
            "aliased Reflect.apply",
            "const apply = Reflect.apply;",
            "function mutate(target) { target.forEach = null; }",
            "apply(mutate, null, [values]);",
        ),
        (
            "destructured target",
            "const box = { target: values };",
            "function mutate({ target }) { target.forEach = null; }",
            "Reflect.apply(mutate, null, [box]);",
        ),
        (
            "rest target",
            "",
            "function mutate(...targets) { targets[0].forEach = null; }",
            "Reflect.apply(mutate, null, [values]);",
        ),
        (
            "conditional target",
            "",
            "const mutate = choose ? function mutateValue(target) { target.forEach = null; } : function inspect(target) { return target.length; };",
            "Reflect.apply(mutate, null, [values]);",
        ),
        (
            "inline target",
            "",
            "",
            "Reflect.apply(function (target) { target.forEach = null; }, null, [values]);",
        ),
        (
            "external target",
            "",
            "",
            "Reflect.apply(external, null, [values]);",
        ),
        (
            "dynamic receiver",
            "",
            "function mutate() { this.forEach = null; }",
            "Reflect.apply(mutate, values, []);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App(external, choose) {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn pure_reflect_apply_invocations_preserve_receivers() {
    for (name, setup, helper, invocation, callback_receiver) in [
        (
            "read-only target",
            "",
            "function inspect(target) { return target.length; }",
            "Reflect.apply(inspect, null, [values]);",
            "values",
        ),
        (
            "detached target",
            "",
            "function inspect(target) { target = {}; target.forEach = null; }",
            "Reflect.apply(inspect, null, [values]);",
            "values",
        ),
        (
            "stored argument container",
            "const args = [values];",
            "function inspect(target) { return target.length; }",
            "Reflect.apply(inspect, null, args);",
            "args",
        ),
        (
            "safe builtin target",
            "",
            "",
            "Reflect.apply(Array.isArray, null, [values]);",
            "values",
        ),
        (
            "aliased Reflect.apply",
            "const apply = Reflect.apply;",
            "function inspect(target) { return target.length; }",
            "apply(inspect, null, [values]);",
            "values",
        ),
        (
            "missing argument list",
            "",
            "function inspect() { return 0; }",
            "Reflect.apply(inspect, values);",
            "values",
        ),
        (
            "read-only dynamic receiver",
            "",
            "function inspect() { return this.length; }",
            "Reflect.apply(inspect, values, []);",
            "values",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {helper}
                    {invocation}
                    {callback_receiver}.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn local_reflect_construct_invocations_propagate_parameter_invalidations() {
    for (name, setup, constructor, invocation) in [
        (
            "function constructor",
            "",
            "function Mutate(target) { target.forEach = null; }",
            "Reflect.construct(Mutate, [values]);",
        ),
        (
            "class constructor",
            "",
            "class Mutate { constructor(target) { target.forEach = null; } }",
            "Reflect.construct(Mutate, [values]);",
        ),
        (
            "stored argument array",
            "const args = [values];",
            "class Mutate { constructor(target) { target.forEach = null; } }",
            "Reflect.construct(Mutate, args);",
        ),
        (
            "computed Reflect.construct",
            "",
            "class Mutate { constructor(target) { target.forEach = null; } }",
            "Reflect['construct'](Mutate, [values]);",
        ),
        (
            "aliased Reflect.construct",
            "const construct = Reflect.construct;",
            "class Mutate { constructor(target) { target.forEach = null; } }",
            "construct(Mutate, [values]);",
        ),
        (
            "conditional constructor",
            "",
            "const Mutate = choose ? class { constructor(target) { target.forEach = null; } } : class { constructor(target) { return target.length; } };",
            "Reflect.construct(Mutate, [values]);",
        ),
        (
            "inline constructor",
            "",
            "",
            "Reflect.construct(class { constructor(target) { target.forEach = null; } }, [values]);",
        ),
        (
            "external constructor",
            "",
            "",
            "Reflect.construct(External, [values]);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App(External, choose) {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {constructor}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn pure_reflect_construct_invocations_preserve_receivers() {
    for (name, setup, constructor, invocation, callback_receiver) in [
        (
            "read-only function constructor",
            "",
            "function Inspect(target) { this.length = target.length; }",
            "Reflect.construct(Inspect, [values]);",
            "values",
        ),
        (
            "read-only class constructor",
            "",
            "class Inspect { constructor(target) { this.length = target.length; } }",
            "Reflect.construct(Inspect, [values]);",
            "values",
        ),
        (
            "stored argument container",
            "const args = [values];",
            "class Inspect { constructor(target) { this.length = target.length; } }",
            "Reflect.construct(Inspect, args);",
            "args",
        ),
        (
            "safe builtin constructor",
            "",
            "",
            "Reflect.construct(Array, [values]);",
            "values",
        ),
        (
            "aliased Reflect.construct",
            "const construct = Reflect.construct;",
            "class Inspect { constructor(target) { this.length = target.length; } }",
            "construct(Inspect, [values]);",
            "values",
        ),
        (
            "missing argument list",
            "",
            "class Inspect {}",
            "Reflect.construct(Inspect);",
            "values",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {constructor}
                    {invocation}
                    {callback_receiver}.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn bound_local_invocations_propagate_parameter_invalidations() {
    for (name, setup, helper, invocation) in [
        (
            "unbound argument",
            "",
            "function mutate(target) { target.forEach = null; } const run = mutate.bind(null);",
            "run(values);",
        ),
        (
            "missing bound receiver",
            "",
            "function mutate(target) { target.forEach = null; } const run = mutate.bind();",
            "run(values);",
        ),
        (
            "prebound argument",
            "",
            "function mutate(target) { target.forEach = null; } const run = mutate.bind(null, values);",
            "run();",
        ),
        (
            "partially bound arguments",
            "",
            "function mutate(_prefix, target) { target.forEach = null; } const run = mutate.bind(null, 0);",
            "run(values);",
        ),
        (
            "spread bound arguments",
            "const prefix = [0];",
            "function mutate(_prefix, target) { target.forEach = null; } const run = mutate.bind(null, ...prefix);",
            "run(values);",
        ),
        (
            "bound Function.call",
            "",
            "function mutate(_prefix, target) { target.forEach = null; } const run = mutate.bind(null, 0);",
            "run.call(null, values);",
        ),
        (
            "bound Function.apply",
            "",
            "function mutate(_prefix, target) { target.forEach = null; } const run = mutate.bind(null, 0);",
            "run.apply(null, [values]);",
        ),
        (
            "bound Reflect.apply",
            "",
            "function mutate(_prefix, target) { target.forEach = null; } const run = mutate.bind(null, 0);",
            "Reflect.apply(run, null, [values]);",
        ),
        (
            "bound constructor",
            "",
            "class Mutate { constructor(_prefix, target) { target.forEach = null; } } const Bound = Mutate.bind(null, 0);",
            "new Bound(values);",
        ),
        (
            "inline bound function",
            "",
            "const run = (function (_prefix, target) { target.forEach = null; }).bind(null, 0);",
            "run(values);",
        ),
        (
            "inline bound class",
            "",
            "const Bound = (class { constructor(target) { target.forEach = null; } }).bind(null);",
            "new Bound(values);",
        ),
        (
            "inline bound class with prebound argument",
            "",
            "const Bound = (class { constructor(_prefix, target) { target.forEach = null; } }).bind(null, 0);",
            "new Bound(values);",
        ),
        (
            "computed inline class bind",
            "",
            "const Bound = (class { constructor(target) { target.forEach = null; } })['bind'](null);",
            "new Bound(values);",
        ),
        (
            "bound dynamic receiver",
            "",
            "function mutate() { this.forEach = null; } const run = mutate.bind(values);",
            "run();",
        ),
        (
            "bound dynamic receiver through call",
            "",
            "function mutate() { this.forEach = null; } const run = mutate.bind(values);",
            "run.call(null);",
        ),
        (
            "bound dynamic receiver through apply",
            "",
            "function mutate() { this.forEach = null; } const run = mutate.bind(values);",
            "run.apply(null, []);",
        ),
        (
            "bound dynamic receiver through Reflect.apply",
            "",
            "function mutate() { this.forEach = null; } const run = mutate.bind(values);",
            "Reflect.apply(run, null, []);",
        ),
        (
            "Reflect.construct inline bound class",
            "",
            "const Bound = (class { constructor(target) { target.forEach = null; } }).bind(null);",
            "Reflect.construct(Bound, [values]);",
        ),
        (
            "aliased target",
            "",
            "function mutate(target) { target.forEach = null; } const alias = mutate; const run = alias.bind(null);",
            "run(values);",
        ),
        (
            "chained bind",
            "",
            "function mutate(_first, _second, target) { target.forEach = null; } const partial = mutate.bind(null, 0); const run = partial.bind(null, 1);",
            "run(values);",
        ),
        (
            "conditional bound callable",
            "",
            "function mutate(target) { target.forEach = null; } function inspect(target) { return target.length; } const run = choose ? mutate.bind(null, values) : inspect.bind(null, values);",
            "run();",
        ),
        (
            "conditional bound assignment",
            "",
            "function mutate(target) { target.forEach = null; } function inspect(target) { return target.length; } let run; if (choose) { run = mutate.bind(null, values); } else { run = inspect.bind(null, values); }",
            "run();",
        ),
        (
            "external bound target",
            "",
            "const run = External.bind(null);",
            "run(values);",
        ),
        (
            "external bound Function.call",
            "",
            "const run = External.bind(null);",
            "run.call(null, values);",
        ),
        (
            "external bound Function.apply",
            "",
            "const run = External.bind(null);",
            "run.apply(null, [values]);",
        ),
        (
            "external bound Reflect.apply",
            "",
            "const run = External.bind(null);",
            "Reflect.apply(run, null, [values]);",
        ),
        (
            "external bound constructor argument",
            "",
            "const Bound = External.bind(null);",
            "new Bound(values);",
        ),
        (
            "external bound Reflect.construct argument",
            "",
            "const Bound = External.bind(null);",
            "Reflect.construct(Bound, [values]);",
        ),
        (
            "external missing bound receiver",
            "",
            "const run = External.bind();",
            "run(values);",
        ),
        (
            "external prebound argument",
            "",
            "const run = External.bind(null, values);",
            "run();",
        ),
        (
            "external bound receiver",
            "",
            "const run = External.bind(values);",
            "run();",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App(External, choose) {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn pure_bound_local_invocations_preserve_receivers() {
    for (name, setup, helper, invocation) in [
        (
            "read-only target",
            "",
            "function inspect(target) { return target.length; } const run = inspect.bind(null);",
            "run(values);",
        ),
        (
            "read-only inline class",
            "",
            "const Bound = (class { constructor(target) { this.length = target.length; } }).bind(null);",
            "new Bound(values);",
        ),
        (
            "detached target",
            "",
            "function inspect(target) { target = {}; target.forEach = null; } const run = inspect.bind(null);",
            "run(values);",
        ),
        (
            "uninvoked prebound argument",
            "",
            "function mutate(target) { target.forEach = null; } const run = mutate.bind(null, values);",
            "void run;",
        ),
        (
            "unrelated prebound argument",
            "const other = [];",
            "function mutate(target) { target.forEach = null; } const run = mutate.bind(null, other);",
            "run();",
        ),
        (
            "overridden bind property",
            "",
            "function mutate(target) { target.forEach = null; } mutate.bind = function (_this, target) { return () => target.length; }; const run = mutate.bind(null, values);",
            "run();",
        ),
        (
            "bound receiver ignores call receiver",
            "const other = [];",
            "function mutate() { this.forEach = null; } const run = mutate.bind(other);",
            "run.call(values);",
        ),
        (
            "constructed bound receiver",
            "",
            "function Mutate() { this.forEach = null; } const Bound = Mutate.bind(values);",
            "new Bound();",
        ),
        (
            "correlated conditional receivers",
            "const other = [];",
            "function mutate() { this.forEach = null; } function inspect() { return this.length; } const run = choose ? mutate.bind(other) : inspect.bind(values);",
            "run();",
        ),
        (
            "correlated conditional alternatives",
            "const other = [];",
            "function mutate(target) { target.forEach = null; } function inspect(target) { return target.length; } const run = choose ? mutate.bind(null, other) : inspect.bind(null, values);",
            "run();",
        ),
        (
            "uninvoked deferred replacement",
            "",
            "function inspect(target) { return target.length; } function mutate(target) { target.forEach = null; } let run = inspect.bind(null); function replace() { run = mutate.bind(null); }",
            "run(values);",
        ),
        (
            "safe builtin target",
            "",
            "const run = Array.isArray.bind(null);",
            "run(values);",
        ),
        (
            "uninvoked external prebound argument",
            "",
            "const run = External.bind(null, values);",
            "void run;",
        ),
        (
            "external bound receiver ignored by construction",
            "",
            "const Bound = External.bind(values);",
            "new Bound();",
        ),
        (
            "call receiver ignored by external bound target",
            "const other = [];",
            "const run = External.bind(other);",
            "run.call(values);",
        ),
        (
            "apply receiver ignored by external bound target",
            "const other = [];",
            "const run = External.bind(other);",
            "run.apply(values, []);",
        ),
        (
            "Reflect.apply receiver ignored by external bound target",
            "const other = [];",
            "const run = External.bind(other);",
            "Reflect.apply(run, values, []);",
        ),
        (
            "Reflect.construct ignores external bound receiver",
            "",
            "const Bound = External.bind(values);",
            "Reflect.construct(Bound, []);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App(External, choose) {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn bound_callable_exposures_invalidate_returned_values() {
    for (name, setup, exposure) in [
        (
            "direct bound callable",
            "const expose = () => values; const bound = expose.bind(null);",
            "configure(bound);",
        ),
        (
            "inline bound callable",
            "const bound = (() => values).bind(null);",
            "configure(bound);",
        ),
        (
            "inline bound generator",
            "const bound = (function* () { yield values; }).bind(null);",
            "configure(bound);",
        ),
        (
            "aliased bound target",
            "const expose = () => values; const alias = expose; const bound = alias.bind(null);",
            "configure(bound);",
        ),
        (
            "chained bound callable",
            "const expose = () => values; const partial = expose.bind(null); const bound = partial.bind(null);",
            "configure(bound);",
        ),
        (
            "conditional bound callable",
            "const expose = () => values; const hidden = () => []; const bound = choose ? expose.bind(null) : hidden.bind(null);",
            "configure(bound);",
        ),
        (
            "conditional bound target",
            "const expose = () => values; const hidden = () => []; const target = choose ? expose : hidden; const bound = target.bind(null);",
            "configure(bound);",
        ),
        (
            "bound callable object spread",
            "const expose = () => values; const source = { bound: expose.bind(null) }; const wrapper = { ...source };",
            "configure(wrapper.bound);",
        ),
        (
            "bound callable array spread",
            "const expose = () => values; const source = [expose.bind(null)]; const wrapper = [...source];",
            "configure(wrapper[0]);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App(configure, choose) {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {exposure}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn hidden_bound_callable_exposures_preserve_values() {
    for (name, setup, exposure) in [
        (
            "unexposed bound callable",
            "const expose = () => values; const bound = expose.bind(null);",
            "void bound;",
        ),
        (
            "unrelated returned value",
            "const other = []; const expose = () => other; const bound = expose.bind(null);",
            "configure(bound);",
        ),
        (
            "overridden bind property",
            "const expose = () => values; expose.bind = () => () => []; const bound = expose.bind(null);",
            "configure(bound);",
        ),
        (
            "later hidden bound callable",
            "const expose = () => values; const hidden = () => []; let bound = expose.bind(null); bound = hidden.bind(null);",
            "configure(bound);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App(configure) {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {exposure}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn local_spread_invocations_propagate_parameter_invalidations() {
    for (name, setup, helper, invocation) in [
        (
            "inline call spread",
            "",
            "function mutate(target) { target.forEach = null; }",
            "mutate(...[values]);",
        ),
        (
            "stored call spread",
            "const args = [values];",
            "function mutate(target) { target.forEach = null; }",
            "mutate(...args);",
        ),
        (
            "conditional call spread",
            "const enabled = true;",
            "function mutate(target) { target.forEach = null; }",
            "mutate(...(enabled ? [values] : []));",
        ),
        (
            "spread after fixed argument",
            "",
            "function mutate(_prefix, target) { target.forEach = null; }",
            "mutate(0, ...[values]);",
        ),
        (
            "spread before fixed argument",
            "",
            "function mutate(_prefix, target) { target.forEach = null; }",
            "mutate(...[0], values);",
        ),
        (
            "constructor spread",
            "",
            "class Mutator { constructor(target) { target.forEach = null; } }",
            "new Mutator(...[values]);",
        ),
        (
            "Function.call spread",
            "",
            "function mutate(target) { target.forEach = null; }",
            "mutate.call(...[null, values]);",
        ),
        (
            "Function.apply spread",
            "",
            "function mutate(target) { target.forEach = null; }",
            "mutate.apply(null, [...[values]]);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    const other = [];
                    {setup}
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count + other.length;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn local_spread_invocation_positions_preserve_unmodified_receivers() {
    for (name, setup, invocation) in [
        ("inline spread length", "", "mutate(...[values], other);"),
        (
            "stored spread minimum length",
            "const args = [values];",
            "mutate(...args, other);",
        ),
        (
            "Function.call inline spread offset",
            "",
            "mutate.call(...[null, values], other);",
        ),
        (
            "Function.call stored spread offset",
            "const args = [null, values];",
            "mutate.call(...args, other);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    const other = [];
                    {setup}
                    function mutate(_first, second) {{ second.forEach = null; }}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn local_spread_element_mutations_preserve_container_methods() {
    let source = r#"
        import { $state } from 'fict';
        function App() {
            const count = $state(0);
            const values = [];
            const args = [values];
            function mutate(target) { target.forEach = null; }
            mutate(...args);
            args.forEach(() => count);
            return count;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_some(), "{:?}", output.diagnostics);
    assert!(
        output
            .diagnostics
            .iter()
            .all(|diagnostic| !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")),
        "expected the spread container method to stay intact, got {:?}",
        output.diagnostics
    );
}

#[test]
fn nested_local_spread_invocations_propagate_element_invalidations() {
    for (name, setup, helpers, invocation) in [
        (
            "inline array",
            "",
            "function inner(target) { target.forEach = null; } function outer(args) { inner(...args); }",
            "outer([values]);",
        ),
        (
            "stored array",
            "const args = [values];",
            "function inner(target) { target.forEach = null; } function outer(args) { inner(...args); }",
            "outer(args);",
        ),
        (
            "nested array property",
            "",
            "function inner(target) { target.forEach = null; } function outer(wrapper) { inner(...wrapper.args); }",
            "outer({ args: [values] });",
        ),
        (
            "delegated spread",
            "",
            "function inner(target) { target.forEach = null; } function middle(args) { inner(...args); } function outer(args) { middle(args); }",
            "outer([values]);",
        ),
        (
            "spread exposure",
            "",
            "function inner(target) { external(target); } function outer(args) { inner(...args); }",
            "outer([values]);",
        ),
        (
            "spread after uncertain stored spread",
            "const args = [values];",
            "function inner(_prefix, target) { target.forEach = null; } function outer(prefix, args) { inner(...prefix, ...args); }",
            "outer([0], args);",
        ),
        (
            "aliased element after uncertain spread",
            "const alias = values; const args = [alias];",
            "function inner(_prefix, target) { target.forEach = null; } function outer(prefix, args) { inner(...prefix, ...args); }",
            "outer([0], args);",
        ),
        (
            "exposure after uncertain spread",
            "",
            "function inner(_prefix, target) { external(target); } function outer(prefix, args) { inner(...prefix, ...args); }",
            "outer([0], [values]);",
        ),
        (
            "formal rest exposure",
            "",
            "function inner(target) { external(target); } function outer(...args) { inner(...args); }",
            "outer(values);",
        ),
        (
            "formal rest root mutation",
            "",
            "function inner(target) { Object.assign(target, {}); } function outer(...args) { inner(...args); }",
            "outer(values);",
        ),
        (
            "array rest exposure",
            "",
            "function inner(target) { external(target); } function outer([_prefix, ...args]) { inner(...args); }",
            "outer([0, values]);",
        ),
        (
            "object rest exposure",
            "",
            "function inner(target) { external(target); } function outer({ _skip, ...rest }) { inner(rest.target); }",
            "outer({ target: values });",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {helpers}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn nested_local_spread_invocations_preserve_container_methods() {
    let source = r#"
        import { $state } from 'fict';
        function App() {
            const count = $state(0);
            const values = [];
            const args = [values];
            function inner(target) { target.forEach = null; }
            function outer(values) { inner(...values); }
            outer(args);
            args.forEach(() => count);
            return count;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_some(), "{:?}", output.diagnostics);
    assert!(
        output
            .diagnostics
            .iter()
            .all(|diagnostic| !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")),
        "expected the outer spread container method to stay intact, got {:?}",
        output.diagnostics
    );
}

#[test]
fn nested_local_spread_invocations_preserve_unselected_elements() {
    let source = r#"
        import { $state } from 'fict';
        function App() {
            const count = $state(0);
            const first = [];
            const values = [];
            function inner(target) { target.forEach = null; }
            function outer(args) { inner(...args); }
            outer([first, values]);
            values.forEach(() => count);
            return count;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_some(), "{:?}", output.diagnostics);
    assert!(
        output
            .diagnostics
            .iter()
            .all(|diagnostic| !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")),
        "expected the unselected spread element to stay intact, got {:?}",
        output.diagnostics
    );
}

#[test]
fn stored_ambiguous_structured_arguments_propagate_nested_invalidations() {
    for (name, setup, helper, invocation) in [
        (
            "conditional array",
            "const args = true ? [values] : [];",
            "function mutate(target) { target.forEach = null; }",
            "mutate(...args);",
        ),
        (
            "conditional object",
            "const wrapper = true ? { target: values } : {};",
            "function mutate({ target }) { target.forEach = null; }",
            "mutate(wrapper);",
        ),
        (
            "logical value",
            "const selected = true && values;",
            "function mutate(target) { target.forEach = null; }",
            "mutate(selected);",
        ),
        (
            "sequence array",
            "const args = (0, [values]);",
            "function mutate(target) { target.forEach = null; }",
            "mutate(...args);",
        ),
        (
            "assignment result array",
            "let args; const selected = (args = [values]);",
            "function mutate(target) { target.forEach = null; }",
            "mutate(...selected);",
        ),
        (
            "nested conditional object",
            "const wrapper = { payload: true ? { target: values } : {} };",
            "function mutate(wrapper) { wrapper.payload.target.forEach = null; }",
            "mutate(wrapper);",
        ),
        (
            "nested conditional array",
            "const wrapper = [true ? [values] : []];",
            "function mutate(wrapper) { wrapper[0][0].forEach = null; }",
            "mutate(wrapper);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn stored_ambiguous_structured_arguments_preserve_unmodified_values() {
    for (name, setup, helper, invocation) in [
        (
            "unselected conditional array element",
            "const args = true ? [[], values] : [];",
            "function mutate(target) { target.forEach = null; }",
            "mutate(...args);",
        ),
        (
            "conditional object sibling",
            "const wrapper = true ? { target: values, other: [] } : {};",
            "function mutate({ other }) { other.forEach = null; }",
            "mutate(wrapper);",
        ),
        (
            "conditional property replacement",
            "const wrapper = true ? { target: values } : {};",
            "function replace(wrapper) { wrapper.target = []; }",
            "replace(wrapper);",
        ),
        (
            "discarded sequence value",
            "const args = ([values], []);",
            "function mutate(target) { target.forEach = null; }",
            "mutate(...args);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn ambiguous_callable_initializers_preserve_all_parameter_effects() {
    for (name, setup, invocation) in [
        (
            "conditional binding",
            "const mutate = choose ? function mutateValue(target) { target.forEach = null; } : function inspect(target) { return target.length; };",
            "mutate(values);",
        ),
        (
            "conditional method container",
            "const handlers = choose ? { run(target) { target.forEach = null; } } : { run(target) { return target.length; } };",
            "handlers.run(values);",
        ),
        (
            "conditional assignment",
            "let mutate; if (choose) { mutate = function mutateValue(target) { target.forEach = null; }; } else { mutate = function inspect(target) { return target.length; }; }",
            "mutate(values);",
        ),
        (
            "optional loop assignment",
            "let mutate = function mutateValue(target) { target.forEach = null; }; while (choose) { mutate = function inspect(target) { return target.length; }; break; }",
            "mutate(values);",
        ),
        (
            "conditional Function.call target",
            "const mutate = choose ? function mutateValue(target) { target.forEach = null; } : function inspect(target) { return target.length; };",
            "mutate.call(null, values);",
        ),
        (
            "conditional Function.apply target",
            "const mutate = choose ? function mutateValue(target) { target.forEach = null; } : function inspect(target) { return target.length; };",
            "mutate.apply(null, [values]);",
        ),
        (
            "conditional constructor",
            "const Mutate = choose ? class { constructor(target) { target.forEach = null; } } : class { constructor(target) { return target.length; } };",
            "new Mutate(values);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App(choose) {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn ambiguous_callable_initializers_preserve_unmodified_arguments() {
    let source = r#"
        import { $state } from 'fict';
        function App(choose) {
            const count = $state(0);
            const values = [];
            const other = [];
            const mutate = choose
                ? function mutateOther(target) { target.forEach = null; }
                : function inspect(target) { return target.length; };
            mutate(other);
            values.forEach(() => count);
            return count;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_some(), "{:?}", output.diagnostics);
    assert!(
        output
            .diagnostics
            .iter()
            .all(|diagnostic| !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")),
        "expected unrelated receiver integrity to be preserved, got {:?}",
        output.diagnostics
    );
}

#[test]
fn stored_spread_initializers_propagate_nested_invalidations() {
    for (name, setup, helper, invocation) in [
        (
            "object spread",
            "const source = { target: values }; const wrapper = { ...source };",
            "function mutate({ target }) { target.forEach = null; }",
            "mutate(wrapper);",
        ),
        (
            "array spread",
            "const source = [values]; const wrapper = [...source];",
            "function mutate([target]) { target.forEach = null; }",
            "mutate(wrapper);",
        ),
        (
            "nested object spread",
            "const source = { target: values }; const wrapper = { payload: { ...source } };",
            "function mutate(wrapper) { wrapper.payload.target.forEach = null; }",
            "mutate(wrapper);",
        ),
        (
            "conditional object spread",
            "const source = { target: values }; const wrapper = { ...(true ? source : {}) };",
            "function mutate({ target }) { target.forEach = null; }",
            "mutate(wrapper);",
        ),
        (
            "prefixed array spread",
            "const source = [values]; const wrapper = [0, ...source];",
            "function mutate([_prefix, target]) { target.forEach = null; }",
            "mutate(wrapper);",
        ),
        (
            "nested array spread",
            "const source = [values]; const wrapper = [[...source]];",
            "function mutate(wrapper) { wrapper[0][0].forEach = null; }",
            "mutate(wrapper);",
        ),
        (
            "ambiguous array spread source",
            "const source = true ? [values] : []; const wrapper = [...source];",
            "function mutate([target]) { target.forEach = null; }",
            "mutate(wrapper);",
        ),
        (
            "runtime array spread offset",
            "const prefix = [0, 0]; const wrapper = [...prefix, values];",
            "function mutate([_first, _second, target]) { target.forEach = null; }",
            "mutate(wrapper);",
        ),
        (
            "aliased array spread length",
            "const prefix = [0, 0]; const alias = prefix; const wrapper = [...alias, values];",
            "function mutate([_first, _second, target]) { target.forEach = null; }",
            "mutate(wrapper);",
        ),
        (
            "inline nested array spread",
            "const wrapper = [...[values]];",
            "function mutate([target]) { target.forEach = null; }",
            "mutate(wrapper);",
        ),
        (
            "value after unknown spread length",
            "const prefix = true ? [] : [0]; const wrapper = [...prefix, values];",
            "function mutate([target]) { target.forEach = null; }",
            "mutate(wrapper);",
        ),
        (
            "chained unknown-length spread",
            "const prefix = getPrefix(); const first = [...prefix, values]; const wrapper = [...first];",
            "function mutate(target) { target.forEach = null; }",
            "mutate(...wrapper);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn stored_spread_initializers_preserve_unmodified_values() {
    for (name, setup, helper, invocation) in [
        (
            "later object property",
            "const source = { target: values }; const wrapper = { ...source, target: [] };",
            "function mutate({ target }) { target.forEach = null; }",
            "mutate(wrapper);",
        ),
        (
            "inline empty object spread",
            "const wrapper = { target: values, ...{} };",
            "function replace(wrapper) { wrapper.target = []; }",
            "replace(wrapper);",
        ),
        (
            "object spread source container",
            "const wrapper = { ...values };",
            "function mutate(wrapper) { wrapper.forEach = null; }",
            "mutate(wrapper);",
        ),
        (
            "array spread source container",
            "const wrapper = [...values];",
            "function mutate(wrapper) { wrapper.forEach = null; }",
            "mutate(wrapper);",
        ),
        (
            "stored source overwrites earlier property",
            "const source = { target: [] }; const wrapper = { target: values, ...source };",
            "function mutate({ target }) { target.forEach = null; }",
            "mutate(wrapper);",
        ),
        (
            "unselected value after finite spread lengths",
            "const prefix = true ? [] : [0]; const wrapper = [...prefix, [], values];",
            "function mutate([target]) { target.forEach = null; }",
            "mutate(wrapper);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {helper}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn stored_callable_spread_initializers_propagate_parameter_invalidations() {
    for (name, setup, invocation) in [
        (
            "object method spread",
            "const source = { run(target) { target.forEach = null; } }; const wrapper = { ...source };",
            "wrapper.run(values);",
        ),
        (
            "nested object method spread",
            "const source = { nested: { run(target) { target.forEach = null; } } }; const wrapper = { ...source };",
            "wrapper.nested.run(values);",
        ),
        (
            "aliased object method spread",
            "const source = { run(target) { target.forEach = null; } }; const alias = source; const wrapper = { ...alias };",
            "wrapper.run(values);",
        ),
        (
            "array function spread",
            "const source = [function run(target) { target.forEach = null; }]; const wrapper = [...source];",
            "wrapper[0](values);",
        ),
        (
            "prefixed array function spread",
            "const source = [function run(target) { target.forEach = null; }]; const wrapper = [0, ...source];",
            "wrapper[1](values);",
        ),
        (
            "conditional object method spread",
            "const mutators = { run(target) { target.forEach = null; } }; const inspectors = { run(target) { return target.length; } }; const source = choose ? mutators : inspectors; const wrapper = { ...source };",
            "wrapper.run(values);",
        ),
        (
            "conditional array function spread",
            "const mutators = [function run(target) { target.forEach = null; }]; const inspectors = [function inspect(target) { return target.length; }]; const source = choose ? mutators : inspectors; const wrapper = [...source];",
            "wrapper[0](values);",
        ),
        (
            "spread Function.call target",
            "const source = { run(target) { target.forEach = null; } }; const wrapper = { ...source };",
            "wrapper.run.call(null, values);",
        ),
        (
            "spread Function.apply target",
            "const source = { run(target) { target.forEach = null; } }; const wrapper = { ...source };",
            "wrapper.run.apply(null, [values]);",
        ),
        (
            "spread object dynamic receiver",
            "const source = { target: values, run() { this.target.forEach = null; } }; const wrapper = { ...source };",
            "wrapper.run();",
        ),
        (
            "spread array dynamic receiver",
            "const source = [function run() { this[1].forEach = null; }, values]; const wrapper = [...source];",
            "wrapper[0]();",
        ),
        (
            "spread constructor",
            "const source = [class { constructor(target) { target.forEach = null; } }]; const wrapper = [...source];",
            "new wrapper[0](values);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App(choose) {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn stored_callable_spread_initializers_preserve_unmodified_values() {
    for (name, setup, invocation) in [
        (
            "later object method",
            "const source = { run(target) { target.forEach = null; } }; const wrapper = { ...source, run(target) { return target.length; } };",
            "wrapper.run(values);",
        ),
        (
            "spread overwrites earlier method",
            "const source = { run(target) { return target.length; } }; const wrapper = { run(target) { target.forEach = null; }, ...source };",
            "wrapper.run(values);",
        ),
        (
            "unselected array function",
            "const source = [function inspect(target) { return target.length; }, function mutate(target) { target.forEach = null; }]; const wrapper = [...source];",
            "wrapper[0](values);",
        ),
        (
            "prefixed unselected array function",
            "const source = [function inspect(target) { return target.length; }, function mutate(target) { target.forEach = null; }]; const wrapper = [0, ...source];",
            "wrapper[1](values);",
        ),
        (
            "unrelated receiver",
            "const source = { run(target) { target.forEach = null; } }; const wrapper = { ...source }; const other = [];",
            "wrapper.run(other);",
        ),
        (
            "uninvoked deferred replacement",
            "const source = { run(target) { return target.length; } }; function replace() { source.run = function mutate(target) { target.forEach = null; }; } const wrapper = { ...source };",
            "wrapper.run(values);",
        ),
        (
            "overwritten dynamic receiver",
            "const source = { target: values, run() { this.target.forEach = null; } }; const wrapper = { ...source, run() { return this.target.length; } };",
            "wrapper.run();",
        ),
        (
            "unselected dynamic receiver",
            "const source = [function inspect() { return this.length; }, function mutate() { this.forEach = null; }]; const wrapper = [...source];",
            "wrapper[0]();",
        ),
        (
            "unadvanced spread generator",
            "const source = { *run(target) { target.forEach = null; } }; const wrapper = { ...source };",
            "wrapper.run(values);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App() {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {invocation}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn stored_callable_spread_initializers_propagate_returned_exposures() {
    for (name, setup, exposure) in [
        (
            "object factory property",
            "const source = { expose: () => values }; const wrapper = { ...source };",
            "configure(wrapper.expose);",
        ),
        (
            "object factory container",
            "const source = { expose: () => values }; const wrapper = { ...source };",
            "configure(wrapper);",
        ),
        (
            "nested object factory",
            "const source = { nested: { expose: () => values } }; const wrapper = { ...source };",
            "configure(wrapper.nested);",
        ),
        (
            "array factory element",
            "const source = [() => values]; const wrapper = [...source];",
            "configure(wrapper[0]);",
        ),
        (
            "array factory container",
            "const source = [() => values]; const wrapper = [...source];",
            "configure(wrapper);",
        ),
        (
            "prefixed array factory",
            "const source = [() => values]; const wrapper = [0, ...source];",
            "configure(wrapper[1]);",
        ),
        (
            "conditional object factory",
            "const exposures = { expose: () => values }; const hidden = { expose: () => [] }; const source = choose ? exposures : hidden; const wrapper = { ...source };",
            "configure(wrapper.expose);",
        ),
        (
            "generator method",
            "const source = { *expose() { yield values; } }; const wrapper = { ...source };",
            "configure(wrapper.expose);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App(configure, choose) {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {exposure}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn stored_callable_spread_initializers_preserve_hidden_exposures() {
    for (name, setup, exposure) in [
        (
            "later object factory",
            "const source = { expose: () => values }; const wrapper = { ...source, expose: () => [] };",
            "configure(wrapper.expose);",
        ),
        (
            "spread overwrites earlier factory",
            "const source = { expose: () => [] }; const wrapper = { expose: () => values, ...source };",
            "configure(wrapper.expose);",
        ),
        (
            "unselected array factory",
            "const source = [() => [], () => values]; const wrapper = [...source];",
            "configure(wrapper[0]);",
        ),
        (
            "unrelated returned receiver",
            "const other = []; const source = { expose: () => other }; const wrapper = { ...source };",
            "configure(wrapper.expose);",
        ),
        (
            "uninvoked deferred replacement",
            "const source = { expose: () => [] }; function replace() { source.expose = () => values; } const wrapper = { ...source };",
            "configure(wrapper.expose);",
        ),
    ] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict';
                function App(configure) {{
                    const count = $state(0);
                    const values = [];
                    {setup}
                    {exposure}
                    values.forEach(() => count);
                    return count;
                }}
            "#
        );
        let output = build_hir(
            &source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_some(), "{name}: {:?}", output.diagnostics);
        assert!(
            output.diagnostics.iter().all(|diagnostic| {
                !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected receiver integrity to be preserved, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn assigned_builtin_aliases_invalidate_escape_exemptions() {
    for (name, source) in [
        (
            "plain assignment alias",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const count = $state(0);
                    let prototype;
                    prototype = Array.prototype;
                    prototype.forEach = sink;
                    const values = [];
                    values.forEach(() => count);
                    return count;
                }
            "#,
        ),
        (
            "reassigned alias after mutation",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const count = $state(0);
                    let prototype = Array.prototype;
                    prototype.forEach = sink;
                    prototype = {};
                    const values = [];
                    values.forEach(() => count);
                    return count;
                }
            "#,
        ),
        (
            "object destructuring alias",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const count = $state(0);
                    const { prototype } = Array;
                    prototype.forEach = sink;
                    const values = [];
                    values.forEach(() => count);
                    return count;
                }
            "#,
        ),
        (
            "defaulted destructuring alias",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const count = $state(0);
                    const { prototype = {} } = Array;
                    prototype.forEach = sink;
                    const values = [];
                    values.forEach(() => count);
                    return count;
                }
            "#,
        ),
        (
            "destructuring assignment alias",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const count = $state(0);
                    let prototype;
                    ({ prototype } = Array);
                    prototype.forEach = sink;
                    const values = [];
                    values.forEach(() => count);
                    return count;
                }
            "#,
        ),
        (
            "assigned member alias",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const count = $state(0);
                    const holder = {};
                    holder.prototype = Array.prototype;
                    holder.prototype.forEach = sink;
                    const values = [];
                    values.forEach(() => count);
                    return count;
                }
            "#,
        ),
        (
            "assigned reflective mutator alias",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const count = $state(0);
                    let define;
                    define = Object.defineProperty;
                    define(Array.prototype, 'forEach', { value: sink });
                    define = sink;
                    const values = [];
                    values.forEach(() => count);
                    return count;
                }
            "#,
        ),
    ] {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn reassigned_builtin_aliases_do_not_invalidate_previous_targets() {
    let source = r#"
        import { $state } from 'fict';
        function App(sink) {
            const count = $state(0);
            let prototype = Array.prototype;
            prototype = {};
            prototype.forEach = sink;
            const values = [];
            values.forEach(() => count);
            return count;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_some(), "{:?}", output.diagnostics);
    assert!(
        output
            .diagnostics
            .iter()
            .all(|diagnostic| { !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005") }),
        "mutating a reassigned local alias must not invalidate its former target: {:?}",
        output.diagnostics
    );
}

#[test]
fn deferred_builtin_alias_mutations_invalidate_escape_exemptions() {
    for (name, source) in [
        (
            "deferred mutation called before reassignment",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const count = $state(0);
                    let prototype;
                    prototype = Array.prototype;
                    mutate();
                    prototype = {};
                    function mutate() {
                        prototype.forEach = sink;
                    }
                    const values = [];
                    values.forEach(() => count);
                    return count;
                }
            "#,
        ),
        (
            "nested reassignment must not erase outer alias",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const count = $state(0);
                    let prototype = Array.prototype;
                    function reset() {
                        prototype = {};
                    }
                    prototype.forEach = sink;
                    const values = [];
                    values.forEach(() => count);
                    return count;
                }
            "#,
        ),
        (
            "deferred reflective mutator alias",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const count = $state(0);
                    let define;
                    define = Object.defineProperty;
                    mutate();
                    define = sink;
                    function mutate() {
                        define(Array.prototype, 'forEach', { value: sink });
                    }
                    const values = [];
                    values.forEach(() => count);
                    return count;
                }
            "#,
        ),
    ] {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == "() => count"
                    })
            }),
            "{name}: expected FICT-R005 on callback, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn safe_global_escape_exemptions_reject_overridden_calls() {
    for (name, source, expected_span, expected_code) in [
        (
            "overridden global converter",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const count = $state(0);
                    String = sink;
                    return String(() => count);
                }
            "#,
            "() => count",
            "FICT-R005",
        ),
        (
            "overridden array factory",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const count = $state(0);
                    Array.from = sink;
                    return Array.from([1], () => count);
                }
            "#,
            "() => count",
            "FICT-R005",
        ),
        (
            "reflectively overridden serializer",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const rows = $state([{ done: false }]);
                    Reflect.set(JSON, 'stringify', sink);
                    return JSON.stringify(rows[0]);
                }
            "#,
            "rows[0]",
            "FICT-R002",
        ),
    ] {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == expected_code
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == expected_span
                    })
            }),
            "{name}: expected {expected_code} on {expected_span:?}, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn global_this_overrides_invalidate_safe_global_calls() {
    for (name, source, expected_span, expected_code) in [
        (
            "assigned converter",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const count = $state(0);
                    globalThis.String = sink;
                    return String(() => count);
                }
            "#,
            "() => count",
            "FICT-R005",
        ),
        (
            "computed array factory",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const count = $state(0);
                    globalThis['Array']['from'] = sink;
                    return Array.from([1], () => count);
                }
            "#,
            "() => count",
            "FICT-R005",
        ),
        (
            "reflectively defined serializer",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const rows = $state([{ done: false }]);
                    Object.defineProperty(globalThis, 'JSON', { value: { stringify: sink } });
                    return JSON.stringify(rows[0]);
                }
            "#,
            "rows[0]",
            "FICT-R002",
        ),
        (
            "aliased global object",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const count = $state(0);
                    const root = globalThis;
                    root.String = sink;
                    return String(() => count);
                }
            "#,
            "() => count",
            "FICT-R005",
        ),
        (
            "bulk global assignment",
            r#"
                import { $state } from 'fict';
                function useRun(sink) {
                    const count = $state(0);
                    Object.assign(globalThis, { String: sink });
                    return String(() => count);
                }
            "#,
            "() => count",
            "FICT-R005",
        ),
        (
            "dynamic global property",
            r#"
                import { $state } from 'fict';
                function useRun(sink, key) {
                    const count = $state(0);
                    globalThis[key] = sink;
                    return String(() => count);
                }
            "#,
            "() => count",
            "FICT-R005",
        ),
    ] {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == expected_code
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == expected_span
                    })
            }),
            "{name}: expected {expected_code} on {expected_span:?}, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn shadowed_global_this_does_not_invalidate_safe_global_calls() {
    let source = r#"
        import { $state } from 'fict';
        function App(sink) {
            const count = $state(0);
            const globalThis = { String: sink };
            globalThis.String = sink;
            return String(() => count);
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_some(), "{:?}", output.diagnostics);
    assert!(
        output
            .diagnostics
            .iter()
            .all(|diagnostic| { !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005") }),
        "a lexical globalThis binding must not invalidate real globals: {:?}",
        output.diagnostics
    );
}

#[test]
fn reassigned_global_this_binding_does_not_invalidate_other_globals() {
    let source = r#"
        import { $state } from 'fict';
        function App() {
            const count = $state(0);
            globalThis = {};
            return String(() => count);
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_some(), "{:?}", output.diagnostics);
    assert!(
        output
            .diagnostics
            .iter()
            .all(|diagnostic| { !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005") }),
        "reassigning the globalThis property does not replace sibling globals: {:?}",
        output.diagnostics
    );
}

#[test]
fn synchronous_safe_global_callbacks_do_not_escape_reactive_captures() {
    let source = r#"
        import { $state } from 'fict';
        function App() {
            const count = $state(0);
            const groups = $state([[{ done: false }]]);
            const rows = $state([{ done: false }]);
            const map = () => count;
            return [
                Array.from([1], () => count),
                Array.from([1], map),
                Array.from(groups[0]),
                Array.from(groups[0], undefined),
                Array.from([1], () => count, rows[0]),
                JSON.parse('{"value":1}', () => count),
                JSON.stringify({ value: 1 }, map),
                JSON.stringify(rows[0]),
            ].length;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_some(), "{:?}", output.diagnostics);
    assert!(
        output
            .diagnostics
            .iter()
            .all(|diagnostic| { !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005") }),
        "proven synchronous safe-global callbacks must not escape: {:?}",
        output.diagnostics
    );
}

#[test]
fn safe_global_callback_proof_rejects_deferred_execution() {
    for (name, source, expected_span) in [
        (
            "array from async map",
            r#"
                import { $state } from 'fict';
                async function pause() {}
                function App() {
                    const count = $state(0);
                    return Array.from([1], async () => { await pause(); return count; });
                }
            "#,
            "async () => { await pause(); return count; }",
        ),
        (
            "array from generator map",
            r#"
                import { $state } from 'fict';
                function App() {
                    const count = $state(0);
                    return Array.from([1], function* () { yield count; });
                }
            "#,
            "function* () { yield count; }",
        ),
        (
            "json parse async reviver",
            r#"
                import { $state } from 'fict';
                async function pause() {}
                function App() {
                    const count = $state(0);
                    const revive = async () => { await pause(); return count; };
                    return JSON.parse('{"value":1}', revive);
                }
            "#,
            "revive",
        ),
        (
            "json stringify async replacer",
            r#"
                import { $state } from 'fict';
                async function pause() {}
                function App() {
                    const count = $state(0);
                    return JSON.stringify({ value: 1 }, async () => {
                        await pause();
                        return count;
                    });
                }
            "#,
            "async () => {\n                        await pause();\n                        return count;\n                    }",
        ),
    ] {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == expected_span
                    })
            }),
            "{name}: expected FICT-R005 on {expected_span:?}, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn safe_global_callbacks_reject_reactive_protocol_inputs() {
    for (name, source, expected_span) in [
        (
            "array from source",
            r#"
                import { $state } from 'fict';
                function App() {
                    const groups = $state([[{ done: false }]]);
                    return Array.from(groups[0], item => {
                        item.done = true;
                        return item;
                    });
                }
            "#,
            "groups[0]",
        ),
        (
            "array from this argument",
            r#"
                import { $state } from 'fict';
                function App() {
                    const rows = $state([{ done: false }]);
                    return Array.from([1], function () {
                        this.done = true;
                        return 1;
                    }, rows[0]);
                }
            "#,
            "rows[0]",
        ),
        (
            "json stringify source",
            r#"
                import { $state } from 'fict';
                function App() {
                    const rows = $state([{ done: false }]);
                    return JSON.stringify(rows[0], function (_key, value) {
                        if (value && typeof value === 'object') value.done = true;
                        return value;
                    });
                }
            "#,
            "rows[0]",
        ),
    ] {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R002"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == expected_span
                    })
            }),
            "{name}: expected FICT-R002 on {expected_span:?}, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn state_method_proofs_reject_authored_builtin_overrides() {
    for (name, source, expected_span) in [
        (
            "prototype override",
            r#"
                import { $state } from 'fict';
                function App(sink) {
                    Array.prototype.includes = sink;
                    const rows = $state([1]);
                    return rows.includes(1);
                }
            "#,
            "rows.includes(1)",
        ),
        (
            "instance override through alias",
            r#"
                import { $state } from 'fict';
                function App(sink) {
                    const rows = $state([1]);
                    const alias = rows;
                    alias.includes = sink;
                    return rows.includes(1);
                }
            "#,
            "rows.includes(1)",
        ),
        (
            "object prototype override",
            r#"
                import { $state } from 'fict';
                function App(sink) {
                    Object.prototype.hasOwnProperty = sink;
                    const rows = $state([1]);
                    return rows.hasOwnProperty(0);
                }
            "#,
            "rows.hasOwnProperty(0)",
        ),
    ] {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-M"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == expected_span
                    })
            }),
            "{name}: expected FICT-M on {expected_span:?}, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn synchronous_builtin_callback_hosts_do_not_escape_reactive_captures() {
    let source = r#"
        import { $state, $store } from 'fict';
        function App() {
            const count = $state(0);
            const rows = $state([1, 2]);
            let replacedRows = $state([1, 2]);
            replacedRows = [3, 4];
            const storedRows = $store([1, 2]);
            const rowAlias = rows;
            const storedAlias = storedRows;
            const bytes = $state(new Uint8Array([1, 2]));
            const map = $state(new Map([[1, 2]]));
            const set = $state(new Set([1, 2]));
            const callbacks = { read: () => count };
            const readAlias = callbacks.read;
            class CallbackBox {
                read = () => count;
                method() { return count; }
            }
            const callbackBox = new CallbackBox();
            const results = [
                rowAlias.map(() => count),
                replacedRows.forEach(() => count),
                storedAlias.filter(() => count),
                bytes.map(() => count),
                bytes.reduce(() => count, 0),
                bytes.toSorted(() => count),
                map.forEach(() => count),
                set.forEach(() => count),
                rows.map(readAlias),
                rows.map(callbackBox.read),
                rows.map(callbackBox.method),
                rows.forEach(function* () { yield count; }),
            ];
            return results.length;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_some(), "{:?}", output.diagnostics);
    assert!(
        output
            .diagnostics
            .iter()
            .all(|diagnostic| { !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005") }),
        "proven synchronous built-in callback hosts must not be treated as escapes: {:?}",
        output.diagnostics
    );
}

#[test]
fn synchronous_string_replacers_do_not_escape_reactive_captures() {
    let source = r#"
        import { $state } from 'fict';
        function App() {
            const count = $state(0);
            const text = $state('a');
            const replace = () => count;
            return [
                text.replace('a', () => count),
                text.replaceAll('a', replace),
                'a'.replace('a', () => count),
                text.replace(/a/, () => count),
                text.replaceAll(/a/g, replace),
            ].join('');
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_some(), "{:?}", output.diagnostics);
    assert!(
        output
            .diagnostics
            .iter()
            .all(|diagnostic| { !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005") }),
        "standard string replacers run synchronously: {:?}",
        output.diagnostics
    );
}

#[test]
fn string_replacer_proof_rejects_async_and_unknown_boundaries() {
    for (name, source, expected_span, expected_code) in [
        (
            "async replacer",
            r#"
                import { $state } from 'fict';
                async function pause() {}
                function App() {
                    const count = $state(0);
                    const text = $state('a');
                    return text.replace('a', async () => { await pause(); return count; });
                }
            "#,
            "async () => { await pause(); return count; }",
            "FICT-R005",
        ),
        (
            "unknown receiver",
            r#"
                import { $state } from 'fict';
                function useRun(custom) {
                    const count = $state(0);
                    custom.replace('a', () => count);
                    return count;
                }
            "#,
            "() => count",
            "FICT-R005",
        ),
        (
            "overridden string prototype",
            r#"
                import { $state } from 'fict';
                function App(sink) {
                    const count = $state(0);
                    const text = $state('a');
                    String.prototype.replace = sink;
                    return text.replace('a', () => count);
                }
            "#,
            "() => count",
            "FICT-R005",
        ),
        (
            "search protocol callback",
            r#"
                import { $state } from 'fict';
                function App() {
                    const count = $state(0);
                    const text = $state('a');
                    const search = {
                        [Symbol.replace]() { return count; },
                    };
                    return text.replace(search, 'x');
                }
            "#,
            "search",
            "FICT-R005",
        ),
        (
            "search protocol retains replacer",
            r#"
                import { $state } from 'fict';
                function App() {
                    const count = $state(0);
                    const text = $state('a');
                    const search = {
                        [Symbol.replace](_text, replacer) {
                            globalThis.saved = replacer;
                            return '';
                        },
                    };
                    return text.replace(search, () => count);
                }
            "#,
            "() => count",
            "FICT-R005",
        ),
        (
            "non-callback replacement",
            r#"
                import { $state } from 'fict';
                function App() {
                    const rows = $state([{ done: false }]);
                    const text = $state('a');
                    return text.replace('a', rows[0]);
                }
            "#,
            "rows[0]",
            "FICT-R002",
        ),
    ] {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == expected_code
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == expected_span
                    })
            }),
            "{name}: expected {expected_code} on {expected_span:?}, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn synchronous_callback_host_proof_rejects_unknown_and_async_boundaries() {
    for (name, source) in [
        (
            "unknown forEach",
            r#"
                import { $state } from 'fict';
                function App(custom) {
                    const count = $state(0);
                    custom.forEach(() => count);
                    return count;
                }
            "#,
        ),
        (
            "async promise host",
            r#"
                import { $state } from 'fict';
                function App() {
                    const count = $state(0);
                    Promise.resolve().then(() => count);
                    return count;
                }
            "#,
        ),
        (
            "shadowed typed array",
            r#"
                import { $state } from 'fict';
                function App(Uint8Array) {
                    const count = $state(0);
                    const bytes = $state(new Uint8Array([1]));
                    bytes.map(() => count);
                    return count;
                }
            "#,
        ),
    ] {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")
            }),
            "{name}: expected an escape diagnostic, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn suspending_callbacks_cross_otherwise_synchronous_hosts() {
    for (name, source, expected_span) in [
        (
            "inline async callback",
            r#"
                import { $state } from 'fict';
                async function pause() {}
                function App() {
                    const count = $state(0);
                    const rows = $state([1]);
                    rows.map(async () => { await pause(); return count; });
                    return count;
                }
            "#,
            "async () => { await pause(); return count; }",
        ),
        (
            "bound async callback",
            r#"
                import { $state } from 'fict';
                async function pause() {}
                function App() {
                    const count = $state(0);
                    const rows = $state([1]);
                    const callback = async () => { await pause(); return count; };
                    rows.forEach(callback);
                    return count;
                }
            "#,
            "callback",
        ),
        (
            "retained generator callback",
            r#"
                import { $state } from 'fict';
                function App() {
                    const count = $state(0);
                    const rows = $state([1]);
                    rows.map(function* () { yield count; });
                    return count;
                }
            "#,
            "function* () { yield count; }",
        ),
        (
            "async callback property",
            r#"
                import { $state } from 'fict';
                async function pause() {}
                function App() {
                    const count = $state(0);
                    const rows = $state([1]);
                    const callbacks = {
                        read: async () => { await pause(); return count; },
                    };
                    rows.map(callbacks.read);
                    return count;
                }
            "#,
            "callbacks.read",
        ),
        (
            "async callback alias",
            r#"
                import { $state } from 'fict';
                async function pause() {}
                function App() {
                    const count = $state(0);
                    const rows = $state([1]);
                    const callback = async () => { await pause(); return count; };
                    const alias = callback;
                    rows.forEach(alias);
                    return count;
                }
            "#,
            "alias",
        ),
        (
            "getter returning async callback",
            r#"
                import { $state } from 'fict';
                async function pause() {}
                function App() {
                    const count = $state(0);
                    const rows = $state([1]);
                    class CallbackBox {
                        get read() {
                            return async () => { await pause(); return count; };
                        }
                    }
                    const callbackBox = new CallbackBox();
                    rows.map(callbackBox.read);
                    return count;
                }
            "#,
            "callbackBox.read",
        ),
    ] {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: expected a hard diagnostic");
        assert!(
            output.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R005"
                    && diagnostic.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == expected_span
                    })
            }),
            "{name}: expected FICT-R005 on {expected_span:?}, got {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn propagates_reactive_dependencies_through_pattern_defaults() {
    let source = r#"
        import { $state } from 'fict';
        function App() {
            let state = $state(1);
            let derived;
            [derived = state] = [];
            return derived;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified reactive pattern HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "App")
        })
        .expect("App function");
    let local = |name: &str| {
        function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"))
            .id
    };
    let state = local("state");
    let derived = local("derived");
    let ssa = analyze_ssa(function).expect("reactive-pattern SSA");
    let dependencies =
        analyze_dependencies(&hir, function.id, &ssa).expect("reactive-pattern dependencies");
    let aliases =
        analyze_aliases(&hir, function.id, &ssa, &dependencies).expect("reactive-pattern aliases");
    let shapes = analyze_shapes(&hir, function.id, &ssa, &dependencies, &aliases)
        .expect("reactive-pattern shapes");
    let scopes = analyze_reactive_scopes(&hir, function.id, &ssa, &dependencies, &aliases, &shapes)
        .expect("reactive-pattern scopes");
    let derived = scopes
        .bindings
        .iter()
        .find(|binding| binding.name.local == derived)
        .expect("derived pattern target");
    assert_eq!(derived.kind, ReactiveBindingKind::Derived);
    assert!(derived.dependencies.iter().any(|path| {
        matches!(path.base, fict_reactivity::DependencyBase::Ssa(name) if name.local == state)
    }));
    let escaped_source = r#"
            import { $state } from 'fict';
            function App(consume) {
                let state = $state(1);
                let derived;
                [derived = state] = [];
                return consume(derived);
            }
        "#;
    let escaped = build_hir(
        escaped_source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(escaped.hir.is_none());
    assert!(escaped.diagnostics.iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-R002"
            && diagnostic.primary_span.is_some_and(|span| {
                &escaped_source[span.start() as usize..span.end() as usize] == "derived"
            })
    }));
    let callback_default = build_hir(
        r#"
            import { $state } from 'fict';
            function App(consume) {
                let state = $state(1);
                let callback;
                [callback = () => state] = [];
                return consume(callback);
            }
        "#,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(callback_default.hir.is_none());
    assert!(callback_default.diagnostics.iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-R005" && diagnostic.message.contains("state")
    }));
}
#[test]
fn escape_diagnostics_keep_direct_props_roots_without_propagating_props_locals() {
    let accepted = build_hir(
        r#"
            import { resource } from 'fict/plus';
            const posts = resource(async (_context, id) => ({ id }));
            export function App(props) {
                const userId = props.userId;
                const result = posts.read(userId);
                return <button onClick={() => props.onSelect(result.data?.id ?? userId)}>
                    {result.data?.id}
                </button>;
            }
        "#,
        options(OxcSourceLanguage::TypeScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(accepted.hir.is_some(), "{:?}", accepted.diagnostics);
    assert!(
        accepted
            .diagnostics
            .iter()
            .all(|diagnostic| { !matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005") })
    );
    let direct_props = build_hir(
        r#"
            export function App(props) {
                consume(props);
                return <div>{props.value}</div>;
            }
        "#,
        options(OxcSourceLanguage::TypeScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(direct_props.hir.is_none());
    assert!(
        direct_props
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-R002")
    );
}
#[test]
fn materializes_plain_local_accesses_in_dependency_safe_source_order() {
    let source = r#"
        function plain(input) {
            let value = input;
            const assigned = (value = side('assign'));
            const compound = (value += side('compound'));
            const postfix = value++;
            return [value, assigned, compound, postfix];
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified plain-local HIR");
    let plain = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "plain")
        })
        .expect("plain function");
    let input = plain
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("input"))
        .expect("input local");
    let value = plain
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("value"))
        .expect("value local");
    assert!(plain.blocks[0].instructions.iter().any(|instruction| {
        matches!(
            &instruction.kind,
            HirInstructionKind::Read { place }
                if place == &fict_hir::Place::local(input.id)
        )
    }));
    assert!(plain.blocks[0].instructions.iter().any(|instruction| {
        matches!(
            &instruction.kind,
            HirInstructionKind::Read { place }
                if place == &fict_hir::Place::local(value.id)
        )
    }));
    let ordered_effects: Vec<_> = plain.blocks[0]
        .instructions
        .iter()
        .filter(|instruction| {
            matches!(
                instruction.kind,
                HirInstructionKind::Call(_)
                    | HirInstructionKind::Write { .. }
                    | HirInstructionKind::ReadWrite { .. }
            )
        })
        .map(|instruction| {
            let span = instruction
                .origin
                .primary_span
                .expect("authored effect span");
            &source[span.start() as usize..span.end() as usize]
        })
        .collect();
    assert_eq!(
        ordered_effects,
        [
            "side('assign')",
            "value = side('assign')",
            "side('compound')",
            "value += side('compound')",
            "value++",
        ]
    );
    assert!(plain.blocks[0].instructions.iter().any(|instruction| {
        matches!(
            instruction.kind,
            HirInstructionKind::Write { .. } | HirInstructionKind::ReadWrite { .. }
        ) && instruction.semantics.mutation == MutationEffect::Local
            && instruction.semantics.purity == Purity::Impure
    }));
}
#[test]
fn materializes_variable_initializers_and_opaque_destructuring_in_semantic_order() {
    let source = r#"
        function declarations(flag, input, effect, sourceValue, fallback) {
            var hoisted;
            if (flag) {
                var fromVar = effect('var');
                let fromLet = effect('let');
                const fromMember = input.value;
                const { value: picked = fallback() + 1, nested: { item }, ...rest } = sourceValue();
                return [fromVar, fromLet, fromMember, picked, item, rest];
            }
            return hoisted;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.as_ref().expect("verified declaration HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                hir.bindings[binding.as_usize()].display_name == "declarations"
            })
        })
        .expect("declarations function");
    let local = |name: &str| {
        function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"))
            .id
    };
    let authored = |instruction: &fict_hir::HirInstruction| {
        let span = instruction
            .origin
            .primary_span
            .expect("authored instruction");
        &source[span.start() as usize..span.end() as usize]
    };
    let find_result = |text: &str| {
        function
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .find(|instruction| authored(instruction) == text)
            .and_then(|instruction| instruction.result)
            .unwrap_or_else(|| panic!("result for {text}"))
    };
    let from_var = local("fromVar");
    let (var_declaration_block, var_initializer) = function
        .blocks
        .iter()
        .find_map(|block| {
            block
                .instructions
                .iter()
                .find_map(|instruction| match instruction.kind {
                    HirInstructionKind::Declare {
                        local,
                        declaration_kind: DeclarationKind::Var,
                        initializer,
                    } if local == from_var => Some((block.id, initializer)),
                    _ => None,
                })
        })
        .expect("hoisted var declaration");
    assert_eq!(var_declaration_block, function.entry);
    assert_eq!(var_initializer, None);
    let var_value = find_result("effect('var')");
    assert!(function.blocks.iter().any(|block| {
        block.instructions.iter().any(|instruction| {
            matches!(
                instruction.kind,
                HirInstructionKind::Write { place: ref target, value }
                    if target == &fict_hir::Place::local(from_var) && value == var_value
            )
        })
    }));
    let from_let = local("fromLet");
    let let_value = find_result("effect('let')");
    let (let_block, let_call_index, let_declaration_index) = function
        .blocks
        .iter()
        .find_map(|block| {
            let call = block
                .instructions
                .iter()
                .position(|instruction| instruction.result == Some(let_value))?;
            let declaration = block.instructions.iter().position(|instruction| {
                matches!(
                    instruction.kind,
                    HirInstructionKind::Declare {
                        local,
                        declaration_kind: DeclarationKind::Let,
                        initializer: Some(value),
                    } if local == from_let && value == let_value
                )
            })?;
            Some((block.id, call, declaration))
        })
        .expect("let declaration linked to its initializer");
    assert_ne!(let_block, function.entry);
    assert!(let_call_index < let_declaration_index);
    let from_member = local("fromMember");
    let member_value = find_result("input.value");
    assert!(function.blocks.iter().any(|block| {
        block.instructions.iter().any(|instruction| {
            matches!(
                instruction.kind,
                HirInstructionKind::Declare {
                    local,
                    declaration_kind: DeclarationKind::Const,
                    initializer: Some(value),
                } if local == from_member && value == member_value
            )
        })
    }));
    let fallback_calls = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .filter(|instruction| {
            matches!(instruction.kind, HirInstructionKind::Call(_))
                && authored(instruction) == "fallback()"
        })
        .count();
    assert_eq!(
        fallback_calls, 0,
        "pattern defaults stay deferred inside the adapter-owned fragment"
    );
    assert!(!function.blocks.iter().any(|block| {
        block.instructions.iter().any(|instruction| {
            matches!(
                instruction.kind,
                HirInstructionKind::Binary {
                    operator: BinaryOperator::Add,
                    ..
                }
            ) && authored(instruction) == "fallback() + 1"
        })
    }));
    let source_value = find_result("sourceValue()");
    let (pattern_value, pattern_fragment) = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find_map(|instruction| match &instruction.kind {
            HirInstructionKind::SyntaxFragment { fragment, inputs }
                if hir.syntax_fragments[fragment.as_usize()].kind
                    == SyntaxFragmentKind::Pattern
                    && inputs.as_slice() == [source_value] =>
            {
                Some((instruction.result?, *fragment))
            }
            _ => None,
        })
        .expect("opaque destructuring fragment");
    let pattern = &hir.syntax_fragments[pattern_fragment.as_usize()];
    let summary = pattern.summary.pattern.as_ref().expect("pattern summary");
    assert!(summary.has_defaults);
    assert!(summary.has_rest);
    assert!(pattern.summary.has_side_effects);
    assert!(pattern.summary.may_throw);
    let fallback_binding = hir
        .bindings
        .iter()
        .find(|binding| binding.display_name == "fallback")
        .expect("fallback parameter binding")
        .id;
    assert!(
        pattern
            .summary
            .referenced_bindings
            .contains(&fallback_binding),
        "opaque defaults retain their binding-aware dependencies"
    );
    assert_eq!(
        output.syntax_fragments[pattern_fragment.as_usize()].source,
        "{ value: picked = fallback() + 1, nested: { item }, ...rest }"
    );
    let declared = [local("picked"), local("item"), local("rest")];
    for target in declared {
        assert!(function.blocks.iter().any(|block| {
            block.instructions.iter().any(|instruction| {
                matches!(
                    instruction.kind,
                    HirInstructionKind::Declare {
                        local,
                        declaration_kind: DeclarationKind::Const,
                        initializer: Some(value),
                    } if local == target && value == pattern_value
                )
            })
        }));
    }
}
#[test]
fn materializes_literals_unary_and_binary_expressions_as_typed_values() {
    let source = r#"
        function expressions(input, side) {
            const negativeZero = -0;
            const arithmetic = 0x10 + 2 * 3;
            const exact = input === null;
            const loose = input == "1";
            const negated = !input;
            const ignored = void side();
            const big = 9007199254740993n;
            const regex = /a+/gi;
            const text = "line\nvalue";
            const enabled = true;
            return [negativeZero, arithmetic, exact, loose, negated, ignored, big, regex, text, enabled];
        }
        function branch(input) {
            if (input === null) return 1;
            return 0;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified typed-expression HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                hir.bindings[binding.as_usize()].display_name == "expressions"
            })
        })
        .expect("expressions function");
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let authored = |instruction: &fict_hir::HirInstruction| {
        let span = instruction
            .origin
            .primary_span
            .expect("authored expression");
        &source[span.start() as usize..span.end() as usize]
    };
    let typed_result = |text: &str| {
        instructions
            .iter()
            .find(|instruction| authored(instruction) == text)
            .and_then(|instruction| instruction.result)
            .unwrap_or_else(|| panic!("typed result for {text}"))
    };
    let zero = typed_result("0");
    assert!(matches!(
        function.values[zero.as_usize()].kind,
        ValueKind::Literal(LiteralValue::Number(number)) if number.to_bits() == 0.0_f64.to_bits()
    ));
    let negative_zero = typed_result("-0");
    assert!(instructions.iter().any(|instruction| {
        instruction.result == Some(negative_zero)
            && matches!(
                instruction.kind,
                HirInstructionKind::Unary {
                    operator: UnaryOperator::Minus,
                    argument,
                } if argument == zero
            )
    }));
    let multiply = typed_result("2 * 3");
    let arithmetic = typed_result("0x10 + 2 * 3");
    assert!(instructions.iter().any(|instruction| {
        instruction.result == Some(multiply)
            && matches!(
                instruction.kind,
                HirInstructionKind::Binary {
                    operator: BinaryOperator::Multiply,
                    ..
                }
            )
    }));
    assert!(instructions.iter().any(|instruction| {
        instruction.result == Some(arithmetic)
            && matches!(
                instruction.kind,
                HirInstructionKind::Binary {
                    operator: BinaryOperator::Add,
                    right,
                    ..
                } if right == multiply
            )
    }));
    let exact = instructions
        .iter()
        .find(|instruction| authored(instruction) == "input === null")
        .expect("strict equality");
    assert!(matches!(
        exact.kind,
        HirInstructionKind::Binary {
            operator: BinaryOperator::StrictEqual,
            ..
        }
    ));
    assert_eq!(exact.semantics, fict_hir::InstructionSemantics::PURE_EAGER);
    let loose = instructions
        .iter()
        .find(|instruction| authored(instruction) == "input == \"1\"")
        .expect("loose equality");
    assert!(matches!(
        loose.kind,
        HirInstructionKind::Binary {
            operator: BinaryOperator::Equal,
            ..
        }
    ));
    assert_eq!(loose.semantics.purity, Purity::Unknown);
    assert_eq!(loose.semantics.mutation, MutationEffect::Unknown);
    assert!(loose.semantics.may_throw);
    for (text, operator) in [
        ("!input", UnaryOperator::Not),
        ("void side()", UnaryOperator::Void),
    ] {
        let unary = instructions
            .iter()
            .find(|instruction| authored(instruction) == text)
            .unwrap_or_else(|| panic!("{text} unary"));
        assert!(matches!(
            unary.kind,
            HirInstructionKind::Unary {
                operator: candidate,
                ..
            } if candidate == operator
        ));
        assert_eq!(unary.semantics, fict_hir::InstructionSemantics::PURE_EAGER);
    }
    let literals: Vec<_> = instructions
        .iter()
        .filter_map(|instruction| match &instruction.kind {
            HirInstructionKind::Literal(literal) => Some((authored(instruction), literal)),
            _ => None,
        })
        .collect();
    assert!(literals.iter().any(|(text, literal)| {
        *text == "9007199254740993n"
            && *literal == &LiteralValue::BigInt("9007199254740993".to_owned())
    }));
    assert!(literals.iter().any(|(text, literal)| {
        *text == "/a+/gi"
            && *literal
                == &LiteralValue::RegExp {
                    pattern: "a+".to_owned(),
                    flags: "gi".to_owned(),
                }
    }));
    assert!(literals.iter().any(|(text, literal)| {
        *text == "\"line\\nvalue\"" && *literal == &LiteralValue::String("line\nvalue".into())
    }));
    assert!(
        literals
            .iter()
            .any(|(text, literal)| { *text == "true" && *literal == &LiteralValue::Boolean(true) })
    );
    for name in [
        "negativeZero",
        "arithmetic",
        "exact",
        "loose",
        "negated",
        "ignored",
        "big",
        "regex",
        "text",
        "enabled",
    ] {
        let local = function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"));
        assert!(instructions.iter().any(|instruction| {
            matches!(
                instruction.kind,
                HirInstructionKind::Declare {
                    local: candidate,
                    initializer: Some(_),
                    ..
                } if candidate == local.id
            )
        }));
    }
    let branch = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "branch")
        })
        .expect("branch function");
    let TerminatorKind::Branch { test, .. } = branch.blocks[0].terminator.kind else {
        panic!("branch terminator")
    };
    assert!(branch.blocks[0].instructions.iter().any(|instruction| {
        instruction.result == Some(test)
            && matches!(
                instruction.kind,
                HirInstructionKind::Binary {
                    operator: BinaryOperator::StrictEqual,
                    ..
                }
            )
    }));
}
#[test]
fn materializes_exact_utf16_strings_and_template_quasis() {
    let source = r#"
        function unicode(value) {
            const high = "\uD800";
            const lowTemplate = `\uDFFF`;
            const mixed = "\uFFFD\uD800";
            const astral = "\uD83D\uDE00";
            const dynamic = `left \uD800${value}\uDC00 right`;
            return [high, lowTemplate, mixed, astral, dynamic];
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified UTF-16 string HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "unicode")
        })
        .expect("unicode function");
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let instruction_for_result = |value| function.instruction_for_result(value).unwrap();
    let initializer = |name: &str| {
        let local = function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"));
        instructions
            .iter()
            .find_map(|instruction| match instruction.kind {
                HirInstructionKind::Declare {
                    local: candidate,
                    initializer,
                    ..
                } if candidate == local.id => initializer,
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name} initializer"))
    };
    let literal = |name: &str| {
        let instruction = instruction_for_result(initializer(name));
        let HirInstructionKind::Literal(LiteralValue::String(value)) = &instruction.kind else {
            panic!("typed {name} UTF-16 literal")
        };
        value
    };
    assert_eq!(literal("high").as_code_units(), &[0xd800]);
    assert_eq!(literal("lowTemplate").as_code_units(), &[0xdfff]);
    assert_eq!(literal("mixed").as_code_units(), &[0xfffd, 0xd800]);
    assert_eq!(literal("astral").as_code_units(), &[0xd83d, 0xde00]);
    let dynamic = instruction_for_result(initializer("dynamic"));
    let HirInstructionKind::TemplateLiteral {
        quasis,
        expressions,
    } = &dynamic.kind
    else {
        panic!("typed dynamic UTF-16 template")
    };
    assert_eq!(expressions.len(), 1);
    let expected_head =
        JavaScriptString::from("left ").concat(&JavaScriptString::from_code_units(vec![0xd800]));
    let expected_tail =
        JavaScriptString::from_code_units(vec![0xdc00]).concat(&JavaScriptString::from(" right"));
    assert_eq!(quasis, &[expected_head, expected_tail]);
    for name in ["high", "lowTemplate", "mixed", "astral", "dynamic"] {
        let root = instruction_for_result(initializer(name));
        assert!(
            !matches!(root.kind, HirInstructionKind::SyntaxFragment { .. }),
            "{name} must not fall back to adapter-owned syntax"
        );
    }
}
#[test]
fn distinguishes_unresolved_typeof_from_binding_reads() {
    let source = r#"
        function inspect(local) {
            const absent = typeof definitelyMissing;
            const host = typeof console;
            const bound = typeof local;
            return [absent, host, bound];
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified typeof HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "inspect")
        })
        .expect("inspect function");
    assert_eq!(function.parent, hir.root_function);
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let authored = |instruction: &fict_hir::HirInstruction| {
        let span = instruction
            .origin
            .primary_span
            .expect("authored typeof expression");
        &source[span.start() as usize..span.end() as usize]
    };
    for identifier in ["definitelyMissing", "console"] {
        let instruction = instructions
            .iter()
            .find(|instruction| {
                matches!(
                    &instruction.kind,
                    HirInstructionKind::UnresolvedTypeof {
                        identifier: candidate,
                    } if candidate == identifier
                )
            })
            .unwrap_or_else(|| panic!("typed unresolved typeof for {identifier}"));
        assert_eq!(
            instruction.semantics,
            fict_hir::InstructionSemantics::CONSERVATIVE_EAGER
        );
    }
    let bound = instructions
        .iter()
        .find(|instruction| authored(instruction) == "typeof local")
        .expect("bound typeof");
    assert!(matches!(
        bound.kind,
        HirInstructionKind::Unary {
            operator: UnaryOperator::TypeOf,
            ..
        }
    ));
    assert_eq!(bound.semantics, fict_hir::InstructionSemantics::PURE_EAGER);
    for name in ["absent", "host", "bound"] {
        let local = function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"));
        let initializer = instructions
            .iter()
            .find_map(|instruction| match instruction.kind {
                HirInstructionKind::Declare {
                    local: candidate,
                    initializer,
                    ..
                } if candidate == local.id => initializer,
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name} initializer"));
        let root = instructions
            .iter()
            .find(|instruction| instruction.result == Some(initializer))
            .unwrap_or_else(|| panic!("{name} root instruction"));
        assert!(
            !matches!(root.kind, HirInstructionKind::SyntaxFragment { .. }),
            "{name} must not fall back to adapter-owned syntax"
        );
    }
}
#[test]
fn materializes_this_new_target_and_import_meta_as_context_values() {
    let source = r#"
        export function inspect() {
            const receiver = this;
            const args = arguments;
            const target = new.target;
            const metadata = import.meta;
            const receiverField = this.value;
            const argLength = arguments.length;
            const targetField = new.target.name;
            const url = import.meta.url;
            const nested = () => [this, arguments, new.target, import.meta];
            return [receiver, args, target, metadata, receiverField, argLength, targetField, url, nested];
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified context-value HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "inspect")
        })
        .expect("inspect function");
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    for (kind, authored, expected_count) in [
        (ContextValueKind::This, "this", 2),
        (ContextValueKind::Arguments, "arguments", 2),
        (ContextValueKind::NewTarget, "new.target", 2),
        (ContextValueKind::ImportMeta, "import.meta", 2),
    ] {
        let contexts: Vec<_> = instructions
            .iter()
            .filter(|instruction| {
                matches!(instruction.kind, HirInstructionKind::Context { kind: candidate } if candidate == kind)
                    && instruction.origin.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == authored
                    })
            })
            .collect();
        assert_eq!(contexts.len(), expected_count, "typed {authored} contexts");
        for instruction in contexts {
            if kind == ContextValueKind::This {
                assert_eq!(instruction.semantics.purity, Purity::Pure);
                assert_eq!(instruction.semantics.mutation, MutationEffect::None);
                assert!(instruction.semantics.may_throw);
            } else {
                assert_eq!(
                    instruction.semantics,
                    fict_hir::InstructionSemantics::PURE_EAGER
                );
            }
        }
    }
    let instruction_for_result = |value| function.instruction_for_result(value).unwrap();
    let initializer = |name: &str| {
        let local = function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"));
        instructions
            .iter()
            .find_map(|instruction| match instruction.kind {
                HirInstructionKind::Declare {
                    local: candidate,
                    initializer,
                    ..
                } if candidate == local.id => initializer,
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name} initializer"))
    };
    for (name, kind) in [
        ("receiver", ContextValueKind::This),
        ("args", ContextValueKind::Arguments),
        ("target", ContextValueKind::NewTarget),
        ("metadata", ContextValueKind::ImportMeta),
    ] {
        assert!(matches!(
            instruction_for_result(initializer(name)).kind,
            HirInstructionKind::Context { kind: candidate } if candidate == kind
        ));
    }
    for (name, kind) in [
        ("receiverField", ContextValueKind::This),
        ("argLength", ContextValueKind::Arguments),
        ("targetField", ContextValueKind::NewTarget),
        ("url", ContextValueKind::ImportMeta),
    ] {
        let root = instruction_for_result(initializer(name));
        let HirInstructionKind::Read { place } = &root.kind else {
            panic!("typed projected context read for {name}")
        };
        let fict_hir::PlaceBase::Value(base) = place.base else {
            panic!("value-based context receiver for {name}")
        };
        assert!(matches!(
            instruction_for_result(base).kind,
            HirInstructionKind::Context { kind: candidate } if candidate == kind
        ));
    }
    for name in [
        "receiver",
        "args",
        "target",
        "metadata",
        "receiverField",
        "argLength",
        "targetField",
        "url",
    ] {
        assert!(
            !matches!(
                instruction_for_result(initializer(name)).kind,
                HirInstructionKind::SyntaxFragment { .. }
            ),
            "{name} must not fall back to adapter-owned syntax"
        );
    }
    let nested = hir
        .functions
        .iter()
        .find(|candidate| {
            candidate.flags.is_arrow
                && candidate.origin.primary_span.is_some_and(|span| {
                    &source[span.start() as usize..span.end() as usize]
                        == "() => [this, arguments, new.target, import.meta]"
                })
        })
        .expect("nested lexical-context arrow");
    assert_eq!(nested.parent, function.id);
    let nested_contexts: std::collections::BTreeSet<_> = nested
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .filter_map(|instruction| match instruction.kind {
            HirInstructionKind::Context { kind } => Some(kind),
            _ => None,
        })
        .collect();
    assert_eq!(
        nested_contexts,
        [
            ContextValueKind::This,
            ContextValueKind::Arguments,
            ContextValueKind::NewTarget,
            ContextValueKind::ImportMeta,
        ]
        .into_iter()
        .collect(),
        "arrow-owned context values retain lexical function form"
    );
}
#[test]
fn keeps_module_and_shadowed_arguments_outside_function_context_values() {
    let source = r#"
        const moduleArgs = arguments;
        function shadow(arguments) {
            return arguments;
        }
    "#;
    let output = build_hir(
        source,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Script,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified arguments ownership HIR");
    let arguments_global = hir
        .globals
        .iter()
        .find(|global| global.name == "arguments")
        .expect("module arguments remains an unresolved host global")
        .id;
    let root = &hir.functions[hir.root_function.as_usize()];
    assert!(
        root.blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .any(|instruction| matches!(
                instruction.kind,
                HirInstructionKind::Read {
                    place: fict_hir::Place {
                        base: fict_hir::PlaceBase::Global(global),
                        ..
                    },
                } if global == arguments_global
            ))
    );
    let shadow = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "shadow")
        })
        .expect("shadow function");
    assert!(
        !shadow
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .any(|instruction| matches!(
                instruction.kind,
                HirInstructionKind::Context {
                    kind: ContextValueKind::Arguments
                }
            ))
    );
    assert!(
        shadow
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .any(|instruction| matches!(
                instruction.kind,
                HirInstructionKind::Read {
                    place: fict_hir::Place {
                        base: fict_hir::PlaceBase::Local(_),
                        ..
                    },
                }
            ))
    );
}
#[test]
fn materializes_logical_and_conditional_expressions_with_lazy_arms() {
    let source = r#"
        function lazyExpressions(input, inspect, fallback) {
            const andValue = inspect('and-left', input) && fallback('and-right');
            const orValue = inspect('or-left', input) || fallback('or-right');
            const nullishValue = inspect('nullish-left', input) ?? fallback('nullish-right');
            const choice = inspect('test', input)
                ? fallback('consequent')
                : fallback('alternate');
            return [andValue, orValue, nullishValue, choice];
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified lazy-expression HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                hir.bindings[binding.as_usize()].display_name == "lazyExpressions"
            })
        })
        .expect("lazyExpressions function");
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let authored = |instruction: &fict_hir::HirInstruction| {
        let span = instruction
            .origin
            .primary_span
            .expect("authored expression");
        &source[span.start() as usize..span.end() as usize]
    };
    let instruction = |text: &str| {
        instructions
            .iter()
            .copied()
            .find(|instruction| authored(instruction) == text)
            .unwrap_or_else(|| panic!("instruction for {text}"))
    };
    for text in [
        "inspect('and-left', input)",
        "inspect('or-left', input)",
        "inspect('nullish-left', input)",
        "inspect('test', input)",
        "'and-left'",
        "'or-left'",
        "'nullish-left'",
        "'test'",
    ] {
        assert_eq!(
            instruction(text).semantics.evaluation,
            EvaluationMode::Eager,
            "logical left/tests must stay eager: {text}"
        );
    }
    for text in [
        "fallback('and-right')",
        "fallback('or-right')",
        "fallback('nullish-right')",
        "fallback('consequent')",
        "fallback('alternate')",
        "'and-right'",
        "'or-right'",
        "'nullish-right'",
        "'consequent'",
        "'alternate'",
    ] {
        assert_eq!(
            instruction(text).semantics.evaluation,
            EvaluationMode::Deferred,
            "short-circuit arms must stay lazy: {text}"
        );
    }
    for (text, operator, left, right) in [
        (
            "inspect('and-left', input) && fallback('and-right')",
            BinaryOperator::LogicalAnd,
            "inspect('and-left', input)",
            "fallback('and-right')",
        ),
        (
            "inspect('or-left', input) || fallback('or-right')",
            BinaryOperator::LogicalOr,
            "inspect('or-left', input)",
            "fallback('or-right')",
        ),
        (
            "inspect('nullish-left', input) ?? fallback('nullish-right')",
            BinaryOperator::NullishCoalescing,
            "inspect('nullish-left', input)",
            "fallback('nullish-right')",
        ),
    ] {
        let root = instruction(text);
        let left = instruction(left).result.expect("logical left result");
        let right = instruction(right).result.expect("logical right result");
        assert!(matches!(
            root.kind,
            HirInstructionKind::Binary {
                operator: candidate,
                left: candidate_left,
                right: candidate_right,
            } if candidate == operator && candidate_left == left && candidate_right == right
        ));
        assert_eq!(root.semantics, fict_hir::InstructionSemantics::PURE_EAGER);
    }
    let conditional = instructions
        .iter()
        .copied()
        .find(|instruction| {
            matches!(instruction.kind, HirInstructionKind::Conditional { .. })
                && authored(instruction).contains("? fallback('consequent')")
        })
        .expect("typed conditional expression");
    let test = instruction("inspect('test', input)")
        .result
        .expect("conditional test result");
    let consequent = instruction("fallback('consequent')")
        .result
        .expect("conditional consequent result");
    let alternate = instruction("fallback('alternate')")
        .result
        .expect("conditional alternate result");
    assert!(matches!(
        conditional.kind,
        HirInstructionKind::Conditional {
            test: candidate_test,
            consequent: candidate_consequent,
            alternate: candidate_alternate,
        } if candidate_test == test
            && candidate_consequent == consequent
            && candidate_alternate == alternate
    ));
    assert_eq!(
        conditional.semantics,
        fict_hir::InstructionSemantics::PURE_EAGER
    );
    for (name, expected) in [
        ("andValue", BinaryOperator::LogicalAnd),
        ("orValue", BinaryOperator::LogicalOr),
        ("nullishValue", BinaryOperator::NullishCoalescing),
    ] {
        let local = function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .expect("logical declaration local");
        assert!(instructions.iter().any(|instruction| {
            let HirInstructionKind::Declare {
                local: candidate,
                initializer: Some(initializer),
                ..
            } = instruction.kind
            else {
                return false;
            };
            candidate == local.id
                && instructions.iter().any(|root| {
                    root.result == Some(initializer)
                        && matches!(
                            root.kind,
                            HirInstructionKind::Binary {
                                operator,
                                ..
                            } if operator == expected
                        )
                })
        }));
    }
    let choice = function
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("choice"))
        .expect("conditional declaration local");
    assert!(instructions.iter().any(|instruction| {
        matches!(
            instruction.kind,
            HirInstructionKind::Declare {
                local,
                initializer: Some(initializer),
                ..
            } if local == choice.id && initializer == conditional.result.expect("conditional result")
        )
    }));
}
#[test]
fn materializes_array_holes_spreads_and_element_evaluation_order() {
    let source = r#"
        function arrays(input, make, tail) {
            const dense = [1, make('second'), input.value];
            const sparse = [, 1, ,];
            const spread = [make('before'), ...make('spread'), make('after'), , ...tail];
            const nodes = [<div />, input ? <span /> : <p />];
            return [dense, sparse, spread, nodes];
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified array HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "arrays")
        })
        .expect("arrays function");
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let authored = |instruction: &fict_hir::HirInstruction| {
        let span = instruction
            .origin
            .primary_span
            .expect("authored expression");
        &source[span.start() as usize..span.end() as usize]
    };
    let instruction = |text: &str| {
        instructions
            .iter()
            .copied()
            .find(|instruction| authored(instruction) == text)
            .unwrap_or_else(|| panic!("instruction for {text}"))
    };
    let dense = instruction("[1, make('second'), input.value]");
    let HirInstructionKind::Array {
        elements: dense_elements,
    } = &dense.kind
    else {
        panic!("typed dense array")
    };
    assert_eq!(dense_elements.len(), 3);
    assert!(matches!(dense_elements[0], ArrayElement::Value(_)));
    assert!(matches!(dense_elements[1], ArrayElement::Value(value)
        if Some(value) == instruction("make('second')").result));
    assert!(matches!(dense_elements[2], ArrayElement::Value(value)
        if Some(value) == instruction("input.value").result));
    assert_eq!(dense.semantics, fict_hir::InstructionSemantics::PURE_EAGER);
    let sparse = instruction("[, 1, ,]");
    let HirInstructionKind::Array {
        elements: sparse_elements,
    } = &sparse.kind
    else {
        panic!("typed sparse array")
    };
    assert_eq!(sparse_elements.len(), 3);
    assert!(matches!(sparse_elements[0], ArrayElement::Hole(_)));
    assert!(matches!(sparse_elements[1], ArrayElement::Value(_)));
    assert!(matches!(sparse_elements[2], ArrayElement::Hole(_)));
    let spread = instruction("[make('before'), ...make('spread'), make('after'), , ...tail]");
    let HirInstructionKind::Array {
        elements: spread_elements,
    } = &spread.kind
    else {
        panic!("typed spread array")
    };
    assert_eq!(spread_elements.len(), 5);
    let before = instruction("make('before')").result.expect("before value");
    let spread_value = instruction("make('spread')").result.expect("spread value");
    let after = instruction("make('after')").result.expect("after value");
    let tail = instruction("tail").result.expect("tail value");
    assert!(matches!(spread_elements[0], ArrayElement::Value(value) if value == before));
    assert!(matches!(
        spread_elements[1],
        ArrayElement::Spread { value, .. } if value == spread_value
    ));
    assert!(matches!(spread_elements[2], ArrayElement::Value(value) if value == after));
    assert!(matches!(spread_elements[3], ArrayElement::Hole(_)));
    assert!(matches!(
        spread_elements[4],
        ArrayElement::Spread { value, .. } if value == tail
    ));
    assert_eq!(
        spread.semantics,
        fict_hir::InstructionSemantics::CONSERVATIVE_EAGER
    );
    assert_eq!(
        instruction("make('before')").semantics.evaluation,
        EvaluationMode::Eager
    );
    for text in ["make('spread')", "make('after')", "tail"] {
        assert_eq!(
            instruction(text).semantics.evaluation,
            EvaluationMode::Deferred,
            "the array node owns evaluation from its first spread: {text}"
        );
    }
    let ordered_calls: Vec<_> = instructions
        .iter()
        .filter(|instruction| matches!(instruction.kind, HirInstructionKind::Call(_)))
        .map(|instruction| authored(instruction))
        .collect();
    assert_eq!(
        ordered_calls,
        [
            "make('second')",
            "make('before')",
            "make('spread')",
            "make('after')",
        ]
    );
    let nodes = instruction("[<div />, input ? <span /> : <p />]");
    let HirInstructionKind::Array {
        elements: node_elements,
    } = &nodes.kind
    else {
        panic!("typed JSX array")
    };
    let div = instruction("<div />").result.expect("div JSX value");
    let conditional = instruction("input ? <span /> : <p />");
    assert!(matches!(node_elements.as_slice(), [
        ArrayElement::Value(first),
        ArrayElement::Value(second),
    ] if *first == div && Some(*second) == conditional.result));
    let span = instruction("<span />").result.expect("span JSX value");
    let paragraph = instruction("<p />").result.expect("paragraph JSX value");
    assert!(matches!(
        conditional.kind,
        HirInstructionKind::Conditional {
            consequent,
            alternate,
            ..
        } if consequent == span && alternate == paragraph
    ));
    assert_eq!(
        instruction("<span />").semantics.evaluation,
        EvaluationMode::Deferred
    );
    assert_eq!(
        instruction("<p />").semantics.evaluation,
        EvaluationMode::Deferred
    );
    for (name, value) in [
        ("dense", dense),
        ("sparse", sparse),
        ("spread", spread),
        ("nodes", nodes),
    ] {
        let local = function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"));
        assert!(instructions.iter().any(|instruction| {
            matches!(
                instruction.kind,
                HirInstructionKind::Declare {
                    local: candidate,
                    initializer: Some(initializer),
                    ..
                } if candidate == local.id && Some(initializer) == value.result
            )
        }));
    }
}
#[test]
fn materializes_object_keys_entries_and_definition_order() {
    let source = r#"
        function objects(shorthand, make, value, __proto__) {
            const plain = {
                alpha: 1,
                "2": make('two'),
                0x3: value,
                shorthand,
                __proto__() { return 'method-proto'; },
            };
            const complex = {
                before: make('before'),
                [make('key')]: make('computed-value'),
                afterComputed: make('after-computed'),
                ...make('spread'),
                afterSpread: make('after-spread'),
                method(arg) { return arg; },
                get current() { return value; },
                set current(next) { void next; },
                ["__proto__"]: make('data-proto'),
            };
            const prototype = { "__proto__": null, safe: 1 };
            const shorthandProto = { __proto__ };
            const numericKeys = { 1e21: value, 1e-7: value, 1e-6: value };
            return [plain, complex, prototype, shorthandProto, numericKeys];
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified object HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "objects")
        })
        .expect("objects function");
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let authored = |instruction: &fict_hir::HirInstruction| {
        let span = instruction
            .origin
            .primary_span
            .expect("authored expression");
        &source[span.start() as usize..span.end() as usize]
    };
    let instruction = |text: &str| {
        instructions
            .iter()
            .copied()
            .find(|instruction| authored(instruction) == text)
            .unwrap_or_else(|| panic!("instruction for {text}"))
    };
    let object_for_local = |name: &str| {
        let local = function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"));
        let initializer = instructions
            .iter()
            .find_map(|instruction| match instruction.kind {
                HirInstructionKind::Declare {
                    local: candidate,
                    initializer,
                    ..
                } if candidate == local.id => initializer,
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name} initializer"));
        instructions
            .iter()
            .copied()
            .find(|instruction| instruction.result == Some(initializer))
            .unwrap_or_else(|| panic!("{name} object instruction"))
    };
    let plain = object_for_local("plain");
    let HirInstructionKind::Object {
        entries: plain_entries,
    } = &plain.kind
    else {
        panic!("typed plain object")
    };
    assert_eq!(plain.semantics, fict_hir::InstructionSemantics::PURE_EAGER);
    assert_eq!(plain_entries.len(), 5);
    assert!(matches!(
        &plain_entries[0],
        ObjectEntry::Property {
            key: PropertyKey::Static(name),
            kind: ObjectPropertyKind::Init,
            prototype_setter: false,
            ..
        } if name == "alpha"
    ));
    assert!(matches!(
        plain_entries[1],
        ObjectEntry::Property {
            key: PropertyKey::Index(2),
            ..
        }
    ));
    assert!(matches!(
        plain_entries[2],
        ObjectEntry::Property {
            key: PropertyKey::Index(3),
            ..
        }
    ));
    assert!(matches!(
        &plain_entries[3],
        ObjectEntry::Property {
            key: PropertyKey::Static(name),
            shorthand: true,
            prototype_setter: false,
            ..
        } if name == "shorthand"
    ));
    let ObjectEntry::Property {
        key: PropertyKey::Static(method_name),
        value: plain_method,
        kind: ObjectPropertyKind::Method,
        prototype_setter: false,
        ..
    } = &plain_entries[4]
    else {
        panic!("__proto__ method is an ordinary method")
    };
    assert_eq!(method_name, "__proto__");
    assert!(matches!(
        function.values[plain_method.as_usize()].kind,
        ValueKind::Function(_)
    ));
    assert_eq!(
        instructions
            .iter()
            .find(|candidate| candidate.result == Some(*plain_method))
            .expect("plain method function instruction")
            .semantics
            .evaluation,
        EvaluationMode::Eager
    );
    let complex = object_for_local("complex");
    let HirInstructionKind::Object {
        entries: complex_entries,
    } = &complex.kind
    else {
        panic!("typed complex object")
    };
    assert_eq!(complex_entries.len(), 9);
    assert_eq!(
        complex.semantics,
        fict_hir::InstructionSemantics::CONSERVATIVE_EAGER
    );
    let ObjectEntry::Property {
        key: PropertyKey::Computed(computed_key),
        kind: ObjectPropertyKind::Init,
        ..
    } = complex_entries[1]
    else {
        panic!("computed object property")
    };
    assert_eq!(Some(computed_key), instruction("make('key')").result);
    assert!(
        matches!(complex_entries[3], ObjectEntry::Spread { value, .. }
        if Some(value) == instruction("make('spread')").result)
    );
    for (index, kind) in [
        (5, ObjectPropertyKind::Method),
        (6, ObjectPropertyKind::Get),
        (7, ObjectPropertyKind::Set),
    ] {
        let ObjectEntry::Property {
            value,
            kind: candidate,
            prototype_setter: false,
            ..
        } = complex_entries[index]
        else {
            panic!("object callable entry {index}")
        };
        assert_eq!(candidate, kind);
        assert!(matches!(
            function.values[value.as_usize()].kind,
            ValueKind::Function(_)
        ));
        assert_eq!(
            instructions
                .iter()
                .find(|instruction| instruction.result == Some(value))
                .expect("callable property function instruction")
                .semantics
                .evaluation,
            EvaluationMode::Deferred
        );
    }
    assert!(matches!(
        complex_entries[8],
        ObjectEntry::Property {
            key: PropertyKey::Computed(_),
            prototype_setter: false,
            ..
        }
    ));
    assert_eq!(
        instruction("make('two')").semantics.evaluation,
        EvaluationMode::Eager
    );
    assert_eq!(
        instruction("make('before')").semantics.evaluation,
        EvaluationMode::Eager
    );
    for text in [
        "make('key')",
        "make('computed-value')",
        "make('after-computed')",
        "make('spread')",
        "make('after-spread')",
        "make('data-proto')",
    ] {
        assert_eq!(
            instruction(text).semantics.evaluation,
            EvaluationMode::Deferred,
            "the object node owns evaluation from its first computed key: {text}"
        );
    }
    let prototype = object_for_local("prototype");
    let HirInstructionKind::Object {
        entries: prototype_entries,
    } = &prototype.kind
    else {
        panic!("typed prototype object")
    };
    assert_eq!(
        prototype.semantics,
        fict_hir::InstructionSemantics::PURE_EAGER
    );
    assert!(matches!(
        &prototype_entries[0],
        ObjectEntry::Property {
            key: PropertyKey::Static(name),
            kind: ObjectPropertyKind::Init,
            shorthand: false,
            prototype_setter: true,
            ..
        } if name == "__proto__"
    ));
    assert!(matches!(
        &prototype_entries[1],
        ObjectEntry::Property {
            key: PropertyKey::Static(name),
            prototype_setter: false,
            ..
        } if name == "safe"
    ));
    let shorthand_proto = object_for_local("shorthandProto");
    let HirInstructionKind::Object {
        entries: shorthand_proto_entries,
    } = &shorthand_proto.kind
    else {
        panic!("typed shorthand __proto__ object")
    };
    assert!(matches!(
        &shorthand_proto_entries[0],
        ObjectEntry::Property {
            key: PropertyKey::Static(name),
            kind: ObjectPropertyKind::Init,
            shorthand: true,
            prototype_setter: false,
            ..
        } if name == "__proto__"
    ));
    let numeric_keys = object_for_local("numericKeys");
    let HirInstructionKind::Object {
        entries: numeric_key_entries,
    } = &numeric_keys.kind
    else {
        panic!("typed numeric-key object")
    };
    for (entry, expected) in numeric_key_entries
        .iter()
        .zip(["1e+21", "1e-7", "0.000001"])
    {
        assert!(matches!(
            entry,
            ObjectEntry::Property {
                key: PropertyKey::Static(name),
                prototype_setter: false,
                ..
            } if name == expected
        ));
    }
}
#[test]
fn materializes_constructor_calls_and_spread_iteration_order() {
    let source = r#"
        function construct(Ctor, getCtor, make, tail, value) {
            const empty = new Ctor;
            const direct = new Ctor(make('first'), () => value, make('third'));
            const spread = new (getCtor())(
                make('before'),
                ...make('spread'),
                make('after'),
                ...tail,
            );
            return [empty, direct, spread];
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified constructor HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "construct")
        })
        .expect("construct function");
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let authored = |instruction: &fict_hir::HirInstruction| {
        let span = instruction
            .origin
            .primary_span
            .expect("authored expression");
        &source[span.start() as usize..span.end() as usize]
    };
    let instruction = |text: &str| {
        instructions
            .iter()
            .copied()
            .find(|instruction| authored(instruction) == text)
            .unwrap_or_else(|| panic!("instruction for {text}"))
    };
    let constructor_for_local = |name: &str| {
        let local = function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"));
        let initializer = instructions
            .iter()
            .find_map(|instruction| match instruction.kind {
                HirInstructionKind::Declare {
                    local: candidate,
                    initializer,
                    ..
                } if candidate == local.id => initializer,
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name} initializer"));
        instructions
            .iter()
            .copied()
            .find(|instruction| instruction.result == Some(initializer))
            .unwrap_or_else(|| panic!("{name} constructor instruction"))
    };
    let empty = constructor_for_local("empty");
    let HirInstructionKind::New {
        callee: empty_callee,
        arguments: empty_arguments,
    } = &empty.kind
    else {
        panic!("typed empty constructor")
    };
    assert!(empty_arguments.is_empty());
    assert_eq!(
        function.values[empty_callee.as_usize()].kind,
        ValueKind::InstructionResult
    );
    assert_eq!(
        empty.semantics,
        fict_hir::InstructionSemantics::CONSERVATIVE_EAGER
    );
    let direct = constructor_for_local("direct");
    let HirInstructionKind::New {
        arguments: direct_arguments,
        ..
    } = &direct.kind
    else {
        panic!("typed direct constructor")
    };
    assert_eq!(direct_arguments.len(), 3);
    assert!(direct_arguments.iter().all(|argument| !argument.spread));
    assert_eq!(
        Some(direct_arguments[0].value),
        instruction("make('first')").result
    );
    assert!(matches!(
        function.values[direct_arguments[1].value.as_usize()].kind,
        ValueKind::Function(_)
    ));
    assert_eq!(
        Some(direct_arguments[2].value),
        instruction("make('third')").result
    );
    for argument in direct_arguments {
        assert_eq!(
            instructions
                .iter()
                .find(|instruction| instruction.result == Some(argument.value))
                .expect("direct constructor argument instruction")
                .semantics
                .evaluation,
            EvaluationMode::Eager
        );
    }
    let spread = constructor_for_local("spread");
    let HirInstructionKind::New { callee, arguments } = &spread.kind else {
        panic!("typed spread constructor")
    };
    assert_eq!(Some(*callee), instruction("getCtor()").result);
    assert_eq!(arguments.len(), 4);
    assert_eq!(
        arguments
            .iter()
            .map(|argument| argument.spread)
            .collect::<Vec<_>>(),
        [false, true, false, true]
    );
    assert_eq!(
        Some(arguments[0].value),
        instruction("make('before')").result
    );
    assert_eq!(
        Some(arguments[1].value),
        instruction("make('spread')").result
    );
    assert_eq!(
        Some(arguments[2].value),
        instruction("make('after')").result
    );
    assert_eq!(Some(arguments[3].value), instruction("tail").result);
    for text in ["getCtor()", "make('before')"] {
        assert_eq!(
            instruction(text).semantics.evaluation,
            EvaluationMode::Eager,
            "constructor and pre-spread arguments are eager: {text}"
        );
    }
    for text in ["make('spread')", "make('after')", "tail"] {
        assert_eq!(
            instruction(text).semantics.evaluation,
            EvaluationMode::Deferred,
            "the new node owns evaluation from its first spread: {text}"
        );
    }
    assert_eq!(
        spread.semantics,
        fict_hir::InstructionSemantics::CONSERVATIVE_EAGER
    );
}
#[test]
fn preserves_call_spread_optional_and_pure_evaluation_boundaries() {
    let source = r#"
        function invoke(fn, make, tail, value, object) {
            const direct = fn(make('first'), () => value, make('third'));
            const spread = fn(
                make('before'),
                ...make('spread'),
                make('after'),
                ...tail,
            );
            const optional = fn?.(
                make('optional-first'),
                () => value,
                ...make('optional-spread'),
                make('optional-after'),
            );
            const optionalMember = object?.method(make('member-optional'));
            const continuedMember = object?.nested.method(make('continued-optional'));
            const groupedMember = (object?.method)(make('grouped-eager'));
            const pure = /* @__PURE__ */ fn(make('pure'));
            const pureSpread = /* @__PURE__ */ fn(...make('pure-spread'));
            return [
                direct,
                spread,
                optional,
                optionalMember,
                continuedMember,
                groupedMember,
                pure,
                pureSpread,
            ];
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified call HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "invoke")
        })
        .expect("invoke function");
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let authored = |instruction: &fict_hir::HirInstruction| {
        let span = instruction
            .origin
            .primary_span
            .expect("authored expression");
        &source[span.start() as usize..span.end() as usize]
    };
    let instruction = |text: &str| {
        instructions
            .iter()
            .copied()
            .find(|instruction| authored(instruction) == text)
            .unwrap_or_else(|| panic!("instruction for {text}"))
    };
    let call_for_local = |name: &str| {
        let local = function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"));
        let initializer = instructions
            .iter()
            .find_map(|instruction| match instruction.kind {
                HirInstructionKind::Declare {
                    local: candidate,
                    initializer,
                    ..
                } if candidate == local.id => initializer,
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name} initializer"));
        instructions
            .iter()
            .copied()
            .find(|instruction| instruction.result == Some(initializer))
            .unwrap_or_else(|| panic!("{name} call instruction"))
    };
    let direct = call_for_local("direct");
    let HirInstructionKind::Call(direct_call) = &direct.kind else {
        panic!("typed direct call")
    };
    assert!(!direct_call.optional);
    assert!(direct_call.callee_reference.is_none());
    assert_eq!(direct_call.arguments.len(), 3);
    assert!(
        direct_call
            .arguments
            .iter()
            .all(|argument| !argument.spread)
    );
    assert!(matches!(
        function.values[direct_call.arguments[1].value.as_usize()].kind,
        ValueKind::Function(_)
    ));
    for argument in &direct_call.arguments {
        assert_eq!(
            instructions
                .iter()
                .find(|instruction| instruction.result == Some(argument.value))
                .expect("direct call argument instruction")
                .semantics
                .evaluation,
            EvaluationMode::Eager
        );
    }
    let spread = call_for_local("spread");
    let HirInstructionKind::Call(spread_call) = &spread.kind else {
        panic!("typed spread call")
    };
    assert!(spread_call.callee_reference.is_none());
    assert_eq!(
        spread_call
            .arguments
            .iter()
            .map(|argument| argument.spread)
            .collect::<Vec<_>>(),
        [false, true, false, true]
    );
    assert_eq!(
        instruction("make('before')").semantics.evaluation,
        EvaluationMode::Eager
    );
    for text in ["make('spread')", "make('after')", "tail"] {
        assert_eq!(
            instruction(text).semantics.evaluation,
            EvaluationMode::Deferred,
            "the call owns evaluation from its first spread: {text}"
        );
    }
    let optional = call_for_local("optional");
    let HirInstructionKind::Call(optional_call) = &optional.kind else {
        panic!("typed optional call")
    };
    assert!(optional_call.optional);
    assert!(optional_call.callee_reference.is_none());
    assert_eq!(optional_call.arguments.len(), 4);
    assert!(matches!(
        function.values[optional_call.arguments[1].value.as_usize()].kind,
        ValueKind::Function(_)
    ));
    for argument in &optional_call.arguments {
        assert_eq!(
            instructions
                .iter()
                .find(|instruction| instruction.result == Some(argument.value))
                .expect("optional call argument instruction")
                .semantics
                .evaluation,
            EvaluationMode::Deferred,
            "optional-call arguments must remain lazy"
        );
    }
    for text in [
        "make('optional-first')",
        "make('optional-spread')",
        "make('optional-after')",
    ] {
        assert_eq!(
            instruction(text).semantics.evaluation,
            EvaluationMode::Deferred
        );
    }
    for name in ["optionalMember", "continuedMember"] {
        let member = call_for_local(name);
        let HirInstructionKind::Call(member_call) = &member.kind else {
            panic!("typed optional-member call")
        };
        assert!(
            !member_call.optional,
            "the member, rather than the call token, starts the optional chain"
        );
        let reference = member_call
            .callee_reference
            .as_ref()
            .expect("method call reference");
        assert!(!reference.projections.is_empty());
        assert!(instructions.iter().any(|instruction| {
            instruction.result == Some(member_call.callee)
                && matches!(
                    &instruction.kind,
                    HirInstructionKind::Read { place } if place == reference
                )
        }));
        assert_eq!(member_call.arguments.len(), 1);
        assert_eq!(
            instructions
                .iter()
                .find(|instruction| { instruction.result == Some(member_call.arguments[0].value) })
                .expect("optional-member argument instruction")
                .semantics
                .evaluation,
            EvaluationMode::Deferred,
            "an earlier optional member controls the rest of its chain"
        );
    }
    assert_eq!(
        instruction("make('member-optional')").semantics.evaluation,
        EvaluationMode::Deferred
    );
    assert_eq!(
        instruction("make('continued-optional')")
            .semantics
            .evaluation,
        EvaluationMode::Deferred
    );
    let grouped = call_for_local("groupedMember");
    let HirInstructionKind::Call(grouped_call) = &grouped.kind else {
        panic!("typed grouped-member call")
    };
    assert!(!grouped_call.optional);
    assert!(grouped_call.callee_reference.is_some());
    assert_eq!(
        instruction("make('grouped-eager')").semantics.evaluation,
        EvaluationMode::Eager,
        "parentheses terminate the optional chain before the outer call"
    );
    let pure = call_for_local("pure");
    assert_eq!(pure.semantics.purity, Purity::Pure);
    assert_eq!(pure.semantics.mutation, MutationEffect::None);
    let pure_spread = call_for_local("pureSpread");
    assert_eq!(pure_spread.semantics.purity, Purity::Unknown);
    assert_eq!(pure_spread.semantics.mutation, MutationEffect::Unknown);
    assert_eq!(
        instruction("make('pure-spread')").semantics.evaluation,
        EvaluationMode::Deferred
    );
}
#[test]
fn preserves_exact_method_receivers_and_computed_keys_in_call_references() {
    let source = r#"
        function invoke(object, key, make, argument) {
            const staticResult = object.method(argument);
            const computedResult = object[key()](argument);
            const temporaryResult = make().method(argument);
            return [staticResult, computedResult, temporaryResult];
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified method-call HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "invoke")
        })
        .expect("invoke function");
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let authored = |instruction: &fict_hir::HirInstruction| {
        let span = instruction
            .origin
            .primary_span
            .expect("authored expression");
        &source[span.start() as usize..span.end() as usize]
    };
    let instruction = |text: &str| {
        instructions
            .iter()
            .copied()
            .find(|instruction| authored(instruction) == text)
            .unwrap_or_else(|| panic!("instruction for {text}"))
    };
    let call_for_local = |name: &str| {
        let local = function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"));
        let initializer = instructions
            .iter()
            .find_map(|instruction| match instruction.kind {
                HirInstructionKind::Declare {
                    local: candidate,
                    initializer,
                    ..
                } if candidate == local.id => initializer,
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name} initializer"));
        instructions
            .iter()
            .copied()
            .find(|instruction| instruction.result == Some(initializer))
            .unwrap_or_else(|| panic!("{name} call"))
    };
    let assert_matching_read = |call: &fict_hir::CallInstruction| {
        let reference = call
            .callee_reference
            .as_ref()
            .expect("method call reference");
        assert!(instructions.iter().any(|instruction| {
            instruction.result == Some(call.callee)
                && matches!(
                    &instruction.kind,
                    HirInstructionKind::Read { place } if place == reference
                )
        }));
        reference.clone()
    };
    let HirInstructionKind::Call(static_call) = &call_for_local("staticResult").kind else {
        panic!("static method call")
    };
    let static_reference = assert_matching_read(static_call);
    assert!(matches!(static_reference.base, PlaceBase::Local(_)));
    assert!(matches!(
        static_reference.projections.as_slice(),
        [Projection::StaticProperty {
            name,
            optional: false,
        }] if name == "method"
    ));
    let HirInstructionKind::Call(computed_call) = &call_for_local("computedResult").kind else {
        panic!("computed method call")
    };
    let computed_reference = assert_matching_read(computed_call);
    let [
        Projection::ComputedProperty {
            key: computed_key,
            optional: false,
        },
    ] = computed_reference.projections.as_slice()
    else {
        panic!("computed method projection")
    };
    let key_call = instruction("key()");
    assert_eq!(key_call.result, Some(*computed_key));
    let HirInstructionKind::Call(key_call) = &key_call.kind else {
        panic!("computed-key call")
    };
    assert!(key_call.callee_reference.is_none());
    assert_eq!(
        instructions
            .iter()
            .filter(|candidate| authored(candidate) == "key()")
            .count(),
        1,
        "a computed method key must be evaluated exactly once"
    );
    let HirInstructionKind::Call(temporary_call) = &call_for_local("temporaryResult").kind else {
        panic!("temporary-receiver method call")
    };
    let temporary_reference = assert_matching_read(temporary_call);
    let PlaceBase::Value(receiver) = temporary_reference.base else {
        panic!("temporary receiver value")
    };
    let receiver_call = instruction("make()");
    assert_eq!(receiver_call.result, Some(receiver));
    let HirInstructionKind::Call(receiver_call) = &receiver_call.kind else {
        panic!("temporary receiver call")
    };
    assert!(receiver_call.callee_reference.is_none());
    assert_eq!(
        instructions
            .iter()
            .filter(|candidate| authored(candidate) == "make()")
            .count(),
        1,
        "a temporary method receiver must be evaluated exactly once"
    );
}
#[test]
fn materializes_await_values_and_suspension_boundaries() {
    let source = r#"
        const top = await boot();
        async function run(load, consume, optional) {
            const direct = await load('direct');
            const nested = consume(await load('nested'));
            const deferred = optional?.(await load('optional'));
            return [direct, nested, deferred];
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified await HIR");
    let authored = |instruction: &fict_hir::HirInstruction| {
        let span = instruction
            .origin
            .primary_span
            .expect("authored await instruction");
        &source[span.start() as usize..span.end() as usize]
    };
    let module = &hir.functions[0];
    assert_eq!(module.kind, FunctionKind::Module);
    let module_instructions: Vec<_> = module
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let top = module_instructions
        .iter()
        .copied()
        .find(|instruction| authored(instruction) == "await boot()")
        .expect("top-level await instruction");
    let HirInstructionKind::Await { value: top_input } = top.kind else {
        panic!("typed top-level await")
    };
    assert_eq!(
        top.semantics,
        fict_hir::InstructionSemantics::CONSERVATIVE_EAGER
    );
    assert!(module_instructions.iter().any(|instruction| {
        instruction.result == Some(top_input)
            && authored(instruction) == "boot()"
            && matches!(instruction.kind, HirInstructionKind::Call(_))
    }));
    let run = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "run")
        })
        .expect("run function");
    assert!(run.flags.is_async);
    let instructions: Vec<_> = run
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let instruction = |text: &str| {
        instructions
            .iter()
            .copied()
            .find(|instruction| authored(instruction) == text)
            .unwrap_or_else(|| panic!("instruction for {text}"))
    };
    for (await_text, input_text) in [
        ("await load('direct')", "load('direct')"),
        ("await load('nested')", "load('nested')"),
        ("await load('optional')", "load('optional')"),
    ] {
        let await_instruction = instruction(await_text);
        let HirInstructionKind::Await { value } = await_instruction.kind else {
            panic!("typed await for {await_text}")
        };
        assert_eq!(Some(value), instruction(input_text).result);
        assert_eq!(await_instruction.semantics.purity, Purity::Unknown);
        assert_eq!(
            await_instruction.semantics.mutation,
            MutationEffect::Unknown
        );
        assert!(await_instruction.semantics.may_throw);
    }
    for text in [
        "load('direct')",
        "await load('direct')",
        "load('nested')",
        "await load('nested')",
    ] {
        assert_eq!(
            instruction(text).semantics.evaluation,
            EvaluationMode::Eager,
            "ordinary awaited work remains eager: {text}"
        );
    }
    for text in ["load('optional')", "await load('optional')"] {
        assert_eq!(
            instruction(text).semantics.evaluation,
            EvaluationMode::Deferred,
            "an optional call owns its await argument: {text}"
        );
    }
}
#[test]
fn materializes_yield_values_delegation_and_lazy_arguments() {
    let source = r#"
        function* generate(make, consume, optional) {
            const resumed = yield;
            const sent = yield make('value');
            const nested = consume(yield make('nested'));
            const delegated = yield* make('iterator');
            const deferred = optional?.(yield make('optional'));
            return [resumed, sent, nested, delegated, deferred];
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified yield HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "generate")
        })
        .expect("generate function");
    assert!(function.flags.is_generator);
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let authored = |instruction: &fict_hir::HirInstruction| {
        let span = instruction
            .origin
            .primary_span
            .expect("authored yield instruction");
        &source[span.start() as usize..span.end() as usize]
    };
    let instruction = |text: &str| {
        instructions
            .iter()
            .copied()
            .find(|instruction| authored(instruction) == text)
            .unwrap_or_else(|| panic!("instruction for {text}"))
    };
    let bare = instruction("yield");
    assert!(matches!(
        bare.kind,
        HirInstructionKind::Yield {
            value: None,
            delegate: false
        }
    ));
    assert_eq!(
        bare.semantics,
        fict_hir::InstructionSemantics::CONSERVATIVE_EAGER
    );
    for (yield_text, input_text, delegate) in [
        ("yield make('value')", "make('value')", false),
        ("yield make('nested')", "make('nested')", false),
        ("yield* make('iterator')", "make('iterator')", true),
        ("yield make('optional')", "make('optional')", false),
    ] {
        let yield_instruction = instruction(yield_text);
        let HirInstructionKind::Yield {
            value: Some(value),
            delegate: actual_delegate,
        } = yield_instruction.kind
        else {
            panic!("typed yield for {yield_text}")
        };
        assert_eq!(actual_delegate, delegate);
        assert_eq!(Some(value), instruction(input_text).result);
        assert_eq!(yield_instruction.semantics.purity, Purity::Unknown);
        assert_eq!(
            yield_instruction.semantics.mutation,
            MutationEffect::Unknown
        );
        assert!(yield_instruction.semantics.may_throw);
    }
    for text in [
        "make('value')",
        "yield make('value')",
        "make('nested')",
        "yield make('nested')",
        "make('iterator')",
        "yield* make('iterator')",
    ] {
        assert_eq!(
            instruction(text).semantics.evaluation,
            EvaluationMode::Eager,
            "ordinary yielded work remains eager: {text}"
        );
    }
    for text in ["make('optional')", "yield make('optional')"] {
        assert_eq!(
            instruction(text).semantics.evaluation,
            EvaluationMode::Deferred,
            "an optional call owns its yield argument: {text}"
        );
    }
}
#[test]
fn materializes_sequence_values_in_authored_evaluation_order() {
    let source = r#"
        function evaluate(make, optional, value) {
            const result = (make('first'), value, make('last'));
            let assigned;
            assigned = (make('assigned'), value);
            const deferred = optional?.((
                make('optional-first'),
                make('optional-last')
            ));
            return [result, assigned, deferred];
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified sequence HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "evaluate")
        })
        .expect("evaluate function");
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let authored = |instruction: &fict_hir::HirInstruction| {
        let span = instruction
            .origin
            .primary_span
            .expect("authored sequence instruction");
        &source[span.start() as usize..span.end() as usize]
    };
    let instruction_for_result = |value| function.instruction_for_result(value).unwrap();
    let local = |name: &str| {
        function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"))
    };
    let initializer = |name: &str| {
        let local = local(name);
        instructions
            .iter()
            .find_map(|instruction| match instruction.kind {
                HirInstructionKind::Declare {
                    local: candidate,
                    initializer,
                    ..
                } if candidate == local.id => initializer,
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name} initializer"))
    };
    let result_value = initializer("result");
    let result = instruction_for_result(result_value);
    let HirInstructionKind::Sequence { values } = &result.kind else {
        panic!("typed result sequence")
    };
    assert_eq!(
        authored(result),
        "make('first'), value, make('last')",
        "transparent parentheses must not force a syntax-fragment wrapper"
    );
    assert_eq!(result.semantics, fict_hir::InstructionSemantics::PURE_EAGER);
    assert_eq!(values.len(), 3);
    assert_eq!(authored(instruction_for_result(values[0])), "make('first')");
    assert_eq!(authored(instruction_for_result(values[1])), "value");
    assert_eq!(authored(instruction_for_result(values[2])), "make('last')");
    let positions: Vec<_> = values
        .iter()
        .map(|value| {
            instructions
                .iter()
                .position(|instruction| instruction.result == Some(*value))
                .expect("sequence input position")
        })
        .collect();
    assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
    assert!(
        positions[2]
            < instructions
                .iter()
                .position(|instruction| instruction.result == Some(result_value))
                .expect("sequence result position")
    );
    let assigned = local("assigned");
    let assigned_value = instructions
        .iter()
        .find_map(|instruction| match &instruction.kind {
            HirInstructionKind::Write { place, value }
                if place == &fict_hir::Place::local(assigned.id) =>
            {
                Some(*value)
            }
            _ => None,
        })
        .expect("assigned write value");
    let HirInstructionKind::Sequence { values } = &instruction_for_result(assigned_value).kind
    else {
        panic!("typed assignment sequence")
    };
    assert_eq!(values.len(), 2);
    assert_eq!(
        authored(instruction_for_result(values[0])),
        "make('assigned')"
    );
    assert_eq!(authored(instruction_for_result(values[1])), "value");
    let deferred_value = initializer("deferred");
    let deferred_call = instruction_for_result(deferred_value);
    let HirInstructionKind::Call(call) = &deferred_call.kind else {
        panic!("typed optional call")
    };
    assert!(call.optional);
    assert_eq!(call.arguments.len(), 1);
    let deferred_sequence = instruction_for_result(call.arguments[0].value);
    let HirInstructionKind::Sequence { values } = &deferred_sequence.kind else {
        panic!("typed optional argument sequence")
    };
    assert_eq!(values.len(), 2);
    for value in values {
        assert_eq!(
            instruction_for_result(*value).semantics.evaluation,
            EvaluationMode::Deferred
        );
    }
    assert_eq!(
        deferred_sequence.semantics.evaluation,
        EvaluationMode::Deferred
    );
}
#[test]
fn materializes_template_quasis_coercions_and_lazy_ownership() {
    let source = r#"
        function templates(make, optional, value) {
            const empty = ``;
            const escaped = `line\n`;
            const dynamic = `head ${make('first')} middle ${value} tail`;
            const lazy = optional?.(`lazy ${make('optional')} tail`);
            return [empty, escaped, dynamic, lazy];
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified template HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "templates")
        })
        .expect("templates function");
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let authored = |instruction: &fict_hir::HirInstruction| {
        let span = instruction
            .origin
            .primary_span
            .expect("authored template instruction");
        &source[span.start() as usize..span.end() as usize]
    };
    let instruction_for_result = |value| function.instruction_for_result(value).unwrap();
    let initializer = |name: &str| {
        let local = function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"));
        instructions
            .iter()
            .find_map(|instruction| match instruction.kind {
                HirInstructionKind::Declare {
                    local: candidate,
                    initializer,
                    ..
                } if candidate == local.id => initializer,
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name} initializer"))
    };
    for (name, expected) in [("empty", ""), ("escaped", "line\n")] {
        let instruction = instruction_for_result(initializer(name));
        assert_eq!(
            instruction.kind,
            HirInstructionKind::Literal(LiteralValue::String(expected.into()))
        );
        assert_eq!(
            instruction.semantics,
            fict_hir::InstructionSemantics::PURE_EAGER
        );
    }
    let dynamic = instruction_for_result(initializer("dynamic"));
    let HirInstructionKind::TemplateLiteral {
        quasis,
        expressions,
    } = &dynamic.kind
    else {
        panic!("typed dynamic template")
    };
    assert_eq!(quasis, &["head ".into(), " middle ".into(), " tail".into()]);
    assert_eq!(expressions.len(), 2);
    assert_eq!(
        authored(instruction_for_result(expressions[0])),
        "make('first')"
    );
    assert_eq!(authored(instruction_for_result(expressions[1])), "value");
    for expression in expressions {
        assert_eq!(
            instruction_for_result(*expression).semantics.evaluation,
            EvaluationMode::Deferred,
            "the template owns interleaved substitution coercion"
        );
    }
    assert_eq!(
        dynamic.semantics,
        fict_hir::InstructionSemantics::CONSERVATIVE_EAGER
    );
    let lazy_call = instruction_for_result(initializer("lazy"));
    let HirInstructionKind::Call(call) = &lazy_call.kind else {
        panic!("typed optional template call")
    };
    assert!(call.optional);
    assert_eq!(call.arguments.len(), 1);
    let lazy_template = instruction_for_result(call.arguments[0].value);
    let HirInstructionKind::TemplateLiteral { expressions, .. } = &lazy_template.kind else {
        panic!("typed lazy template")
    };
    assert_eq!(expressions.len(), 1);
    assert_eq!(
        authored(instruction_for_result(expressions[0])),
        "make('optional')"
    );
    assert_eq!(
        lazy_template.semantics.evaluation,
        EvaluationMode::Deferred,
        "the optional call owns the entire template operation"
    );
    assert_eq!(
        instruction_for_result(expressions[0]).semantics.evaluation,
        EvaluationMode::Deferred
    );
}
#[test]
fn materializes_tagged_template_objects_substitutions_and_utf16_cooked_values() {
    let source = r#"
        function tags(tag, receiver, make, key, value) {
            const escaped = tag`line\n`;
            const invalid = tag`\u{}`;
            const surrogate = tag`\uD800${value}`;
            const dynamic = tag`head ${make('first')} middle ${value} tail`;
            const member = receiver.tag`member ${value}`;
            const computed = receiver[key()]`computed ${value}`;
            const temporary = make('receiver').tag`temporary ${value}`;
            return [escaped, invalid, surrogate, dynamic, member, computed, temporary];
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified tagged-template HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "tags")
        })
        .expect("tags function");
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let authored = |instruction: &fict_hir::HirInstruction| {
        let span = instruction
            .origin
            .primary_span
            .expect("authored tagged-template instruction");
        &source[span.start() as usize..span.end() as usize]
    };
    let instruction_for_result = |value| function.instruction_for_result(value).unwrap();
    let local = |name: &str| {
        function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"))
    };
    let initializer = |name: &str| {
        let local = local(name);
        instructions
            .iter()
            .find_map(|instruction| match instruction.kind {
                HirInstructionKind::Declare {
                    local: candidate,
                    initializer,
                    ..
                } if candidate == local.id => initializer,
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name} initializer"))
    };
    let tagged = |name: &str| {
        let value = initializer(name);
        let instruction = instruction_for_result(value);
        let HirInstructionKind::TaggedTemplate {
            tag,
            tag_reference,
            quasis,
            substitutions,
            host,
        } = &instruction.kind
        else {
            panic!("typed {name} tagged template")
        };
        (
            instruction,
            *tag,
            tag_reference.clone(),
            quasis,
            substitutions,
            *host,
        )
    };
    let (escaped, _, reference, quasis, substitutions, host) = tagged("escaped");
    assert!(reference.is_none());
    assert!(substitutions.is_empty());
    assert_eq!(quasis.len(), 1);
    assert_eq!(quasis[0].raw, r"line\n");
    assert_eq!(quasis[0].cooked, Some(JavaScriptString::from("line\n")));
    assert_eq!(
        host,
        fict_hir::CallHost::Binding(local("tag").binding.expect("tag binding"))
    );
    assert_eq!(
        escaped.semantics,
        fict_hir::InstructionSemantics::CONSERVATIVE_EAGER
    );
    let (_, _, _, quasis, substitutions, _) = tagged("invalid");
    assert!(substitutions.is_empty());
    assert_eq!(quasis[0].raw, r"\u{}");
    assert_eq!(quasis[0].cooked, None);
    let (_, _, _, quasis, substitutions, _) = tagged("surrogate");
    assert_eq!(substitutions.len(), 1);
    assert_eq!(quasis.len(), 2);
    assert_eq!(quasis[0].raw, r"\uD800");
    assert_eq!(
        quasis[0].cooked,
        Some(JavaScriptString::from_code_units(vec![0xd800]))
    );
    assert_eq!(quasis[1].cooked, Some(JavaScriptString::default()));
    let (dynamic, tag, reference, quasis, substitutions, _) = tagged("dynamic");
    assert!(reference.is_none());
    assert_eq!(
        quasis
            .iter()
            .map(|quasi| quasi.raw.as_str())
            .collect::<Vec<_>>(),
        ["head ", " middle ", " tail"]
    );
    assert_eq!(substitutions.len(), 2);
    assert_eq!(
        authored(instruction_for_result(substitutions[0])),
        "make('first')"
    );
    assert_eq!(authored(instruction_for_result(substitutions[1])), "value");
    for substitution in substitutions {
        assert_eq!(
            instruction_for_result(*substitution).semantics.evaluation,
            EvaluationMode::Eager,
            "tag substitutions are passed without template string coercion"
        );
    }
    let position = |value| {
        instructions
            .iter()
            .position(|instruction| instruction.result == Some(value))
            .expect("tagged-template value position")
    };
    assert!(position(tag) < position(substitutions[0]));
    assert!(position(substitutions[0]) < position(substitutions[1]));
    assert!(position(substitutions[1]) < position(initializer("dynamic")));
    assert!(!instructions.iter().any(|instruction| {
        matches!(instruction.kind, HirInstructionKind::SyntaxFragment { .. })
            && instruction.origin.primary_span == dynamic.origin.primary_span
    }));
    let (_, member_tag, member_reference, _, substitutions, host) = tagged("member");
    assert_eq!(substitutions.len(), 1);
    assert_eq!(host, fict_hir::CallHost::Unknown);
    let member_reference = member_reference.expect("member tag reference");
    assert!(matches!(member_reference.base, PlaceBase::Local(_)));
    assert!(matches!(
        member_reference.projections.as_slice(),
        [Projection::StaticProperty {
            name,
            optional: false,
        }] if name == "tag"
    ));
    assert!(instructions.iter().any(|instruction| {
        instruction.result == Some(member_tag)
            && matches!(
                &instruction.kind,
                HirInstructionKind::Read { place } if place == &member_reference
            )
    }));
    let (_, computed_tag, computed_reference, _, _, host) = tagged("computed");
    assert_eq!(host, fict_hir::CallHost::Unknown);
    let computed_reference = computed_reference.expect("computed tag reference");
    let [
        Projection::ComputedProperty {
            key: computed_key,
            optional: false,
        },
    ] = computed_reference.projections.as_slice()
    else {
        panic!("computed tag projection")
    };
    assert_eq!(authored(instruction_for_result(*computed_key)), "key()");
    assert!(instructions.iter().any(|instruction| {
        instruction.result == Some(computed_tag)
            && matches!(
                &instruction.kind,
                HirInstructionKind::Read { place } if place == &computed_reference
            )
    }));
    assert_eq!(
        instructions
            .iter()
            .filter(|instruction| authored(instruction) == "key()")
            .count(),
        1,
        "a computed tag key must be evaluated exactly once"
    );
    let (_, temporary_tag, temporary_reference, _, _, host) = tagged("temporary");
    assert_eq!(host, fict_hir::CallHost::Unknown);
    let temporary_reference = temporary_reference.expect("temporary tag reference");
    let PlaceBase::Value(receiver) = temporary_reference.base else {
        panic!("temporary tag receiver")
    };
    assert_eq!(
        authored(instruction_for_result(receiver)),
        "make('receiver')"
    );
    assert!(instructions.iter().any(|instruction| {
        instruction.result == Some(temporary_tag)
            && matches!(
                &instruction.kind,
                HirInstructionKind::Read { place } if place == &temporary_reference
            )
    }));
    assert_eq!(
        instructions
            .iter()
            .filter(|instruction| authored(instruction) == "make('receiver')")
            .count(),
        1,
        "a temporary tag receiver must be evaluated exactly once"
    );
}
#[test]
fn materializes_dynamic_import_phases_options_and_coercion_order() {
    let source = r#"
        function loads(make, specifier, options, optional) {
            const simple = import(specifier);
            const configured = import(make('specifier'), make('options'));
            const sourcePhase = import.source(specifier);
            const deferPhase = import.defer(specifier);
            const lazy = optional?.(import(make('lazy'), options));
            return [simple, configured, sourcePhase, deferPhase, lazy];
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified dynamic-import HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "loads")
        })
        .expect("loads function");
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let authored = |instruction: &fict_hir::HirInstruction| {
        let span = instruction
            .origin
            .primary_span
            .expect("authored dynamic-import instruction");
        &source[span.start() as usize..span.end() as usize]
    };
    let instruction_for_result = |value| function.instruction_for_result(value).unwrap();
    let initializer = |name: &str| {
        let local = function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"));
        instructions
            .iter()
            .find_map(|instruction| match instruction.kind {
                HirInstructionKind::Declare {
                    local: candidate,
                    initializer,
                    ..
                } if candidate == local.id => initializer,
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name} initializer"))
    };
    let dynamic_import = |name: &str| {
        let value = initializer(name);
        let instruction = instruction_for_result(value);
        let HirInstructionKind::DynamicImport {
            specifier,
            options,
            phase,
        } = &instruction.kind
        else {
            panic!("typed {name} dynamic import")
        };
        (instruction, *specifier, *options, *phase)
    };
    let (simple, specifier, options, phase) = dynamic_import("simple");
    assert_eq!(phase, ImportPhase::Evaluation);
    assert!(options.is_none());
    assert_eq!(authored(instruction_for_result(specifier)), "specifier");
    assert_eq!(
        simple.semantics,
        fict_hir::InstructionSemantics::CONSERVATIVE_EAGER
    );
    let (configured, specifier, options, phase) = dynamic_import("configured");
    let options = options.expect("configured import options");
    assert_eq!(phase, ImportPhase::Evaluation);
    assert_eq!(
        authored(instruction_for_result(specifier)),
        "make('specifier')"
    );
    assert_eq!(authored(instruction_for_result(options)), "make('options')");
    let position = |value| {
        instructions
            .iter()
            .position(|instruction| instruction.result == Some(value))
            .expect("dynamic-import value position")
    };
    assert!(position(specifier) < position(options));
    assert!(position(options) < position(initializer("configured")));
    assert_eq!(
        instruction_for_result(specifier).semantics.evaluation,
        EvaluationMode::Eager
    );
    assert_eq!(
        instruction_for_result(options).semantics.evaluation,
        EvaluationMode::Eager
    );
    assert!(!instructions.iter().any(|instruction| {
        matches!(instruction.kind, HirInstructionKind::SyntaxFragment { .. })
            && instruction.origin.primary_span == configured.origin.primary_span
    }));
    assert_eq!(dynamic_import("sourcePhase").3, ImportPhase::Source);
    assert_eq!(dynamic_import("deferPhase").3, ImportPhase::Defer);
    let lazy_call = instruction_for_result(initializer("lazy"));
    let HirInstructionKind::Call(call) = &lazy_call.kind else {
        panic!("typed optional call around import")
    };
    assert!(call.optional);
    assert_eq!(call.arguments.len(), 1);
    let lazy_import = instruction_for_result(call.arguments[0].value);
    let HirInstructionKind::DynamicImport {
        specifier, options, ..
    } = lazy_import.kind
    else {
        panic!("typed lazy dynamic import")
    };
    assert!(options.is_some());
    assert_eq!(lazy_import.semantics.evaluation, EvaluationMode::Deferred);
    assert_eq!(
        instruction_for_result(specifier).semantics.evaluation,
        EvaluationMode::Deferred
    );
}
#[test]
fn materializes_static_computed_index_and_value_base_projections() {
    let source = r#"
        function project(obj) {
            const nested = obj.user.name;
            const dynamic = obj[key()];
            const indexed = obj[0];
            const temporary = make().value;
            const optional = obj?.user?.[key()];
            obj.user.name = rhs();
            obj[key()] += delta();
            obj[0]++;
            delete obj.ignored;
            return [nested, dynamic, indexed, temporary, optional, obj.user.name];
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified projected-place HIR");
    let project = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "project")
        })
        .expect("project function");
    let object = project
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("obj"))
        .expect("object parameter");
    let instructions: Vec<_> = project
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let deletion = instructions
        .iter()
        .find(|instruction| {
            instruction.origin.primary_span.is_some_and(|span| {
                &source[span.start() as usize..span.end() as usize] == "delete obj.ignored"
            })
        })
        .expect("typed property deletion");
    assert!(matches!(
        &deletion.kind,
        HirInstructionKind::Delete {
            target: DeleteTarget::Place(place),
        } if place.base == fict_hir::PlaceBase::Local(object.id)
            && matches!(
                place.projections.as_slice(),
                [fict_hir::Projection::StaticProperty { name, optional: false }]
                    if name == "ignored"
            )
    ));
    assert_eq!(deletion.semantics.mutation, MutationEffect::Observable);
    assert!(deletion.semantics.may_throw);
    let authored_projected_reads: Vec<_> = instructions
        .iter()
        .filter_map(|instruction| match &instruction.kind {
            HirInstructionKind::Read { place } if !place.projections.is_empty() => {
                let span = instruction.origin.primary_span?;
                Some((
                    &source[span.start() as usize..span.end() as usize],
                    place,
                    instruction.result,
                ))
            }
            _ => None,
        })
        .collect();
    assert!(authored_projected_reads.iter().any(|(authored, place, _)| {
        *authored == "obj.user.name"
            && place.base == fict_hir::PlaceBase::Local(object.id)
            && matches!(
                place.projections.as_slice(),
                [
                    fict_hir::Projection::StaticProperty { name: user, optional: false },
                    fict_hir::Projection::StaticProperty { name, optional: false },
                ] if user == "user" && name == "name"
            )
    }));
    assert!(authored_projected_reads.iter().any(|(authored, place, _)| {
        *authored == "obj[key()]"
            && matches!(
                place.projections.as_slice(),
                [fict_hir::Projection::ComputedProperty {
                    optional: false,
                    ..
                }]
            )
    }));
    assert!(authored_projected_reads.iter().any(|(authored, place, _)| {
        *authored == "obj[0]"
            && matches!(
                place.projections.as_slice(),
                [fict_hir::Projection::Index {
                    index: 0,
                    optional: false
                }]
            )
    }));
    assert!(authored_projected_reads.iter().any(|(authored, place, _)| {
        *authored == "obj?.user?.[key()]"
            && matches!(
                place.projections.as_slice(),
                [
                    fict_hir::Projection::StaticProperty { name, optional: true },
                    fict_hir::Projection::ComputedProperty { optional: true, .. },
                ] if name == "user"
            )
    }));
    let optional_span = instructions
        .iter()
        .find(|instruction| {
            instruction.origin.primary_span.is_some_and(|span| {
                &source[span.start() as usize..span.end() as usize] == "obj?.user?.[key()]"
            })
        })
        .and_then(|instruction| instruction.origin.primary_span)
        .expect("optional projection span");
    assert!(instructions.iter().any(|instruction| {
        matches!(instruction.kind, HirInstructionKind::Call(_))
            && instruction.origin.primary_span.is_some_and(|span| {
                optional_span.start() <= span.start()
                    && span.end() <= optional_span.end()
                    && &source[span.start() as usize..span.end() as usize] == "key()"
            })
            && instruction.semantics.evaluation == EvaluationMode::Deferred
    }));
    let value_base = authored_projected_reads
        .iter()
        .find(|(authored, _, _)| *authored == "make().value")
        .expect("temporary-base projection");
    let fict_hir::PlaceBase::Value(base) = value_base.1.base else {
        panic!("temporary member base must be an evaluated value")
    };
    assert!(instructions.iter().any(|instruction| {
        instruction.result == Some(base)
            && instruction
                .origin
                .primary_span
                .is_some_and(|span| &source[span.start() as usize..span.end() as usize] == "make()")
            && matches!(instruction.kind, HirInstructionKind::Call(_))
    }));
    let projected_mutations: Vec<_> = instructions
        .iter()
        .filter(|instruction| {
            matches!(
                &instruction.kind,
                HirInstructionKind::Write { place, .. }
                    | HirInstructionKind::ReadWrite { place, .. }
                    if !place.projections.is_empty()
            )
        })
        .collect();
    assert_eq!(projected_mutations.len(), 3);
    assert!(
        projected_mutations
            .iter()
            .all(|instruction| { instruction.semantics.mutation == MutationEffect::Observable })
    );
    assert_eq!(
        projected_mutations
            .iter()
            .map(|instruction| {
                let span = instruction
                    .origin
                    .primary_span
                    .expect("projected write span");
                &source[span.start() as usize..span.end() as usize]
            })
            .collect::<Vec<_>>(),
        ["obj.user.name = rhs()", "obj[key()] += delta()", "obj[0]++"]
    );
    let ordered_calls_and_writes: Vec<_> = instructions
        .iter()
        .filter(|instruction| {
            matches!(
                instruction.kind,
                HirInstructionKind::Call(_)
                    | HirInstructionKind::Write { .. }
                    | HirInstructionKind::ReadWrite { .. }
            )
        })
        .map(|instruction| {
            let span = instruction.origin.primary_span.expect("effect source span");
            &source[span.start() as usize..span.end() as usize]
        })
        .collect();
    assert_eq!(
        ordered_calls_and_writes,
        [
            "key()",
            "make()",
            "key()",
            "rhs()",
            "obj.user.name = rhs()",
            "key()",
            "delta()",
            "obj[key()] += delta()",
            "obj[0]++",
        ]
    );
    assert!(instructions.iter().all(|instruction| {
        instruction.origin.primary_span.is_none_or(|span| {
            &source[span.start() as usize..span.end() as usize] != "obj.ignored"
                || !matches!(instruction.kind, HirInstructionKind::Read { .. })
        })
    }));
}
#[test]
fn materializes_unresolved_host_places_without_lexical_ssa_or_target_reads() {
    let source = r#"
        function mutate(value, key, make) {
            globalSlot = value;
            globalSlot += value;
            globalSlot++;
            hostObject.fixed = value;
            hostObject[key] = value;
            make().field--;
            const read = hostObject.fixed;
            return read;
        }
    "#;
    let output = build_hir(
        source,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Script,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified host-place HIR");
    assert_eq!(
        hir.globals
            .iter()
            .map(|global| global.name.as_str())
            .collect::<Vec<_>>(),
        ["globalSlot", "hostObject"],
        "global IDs follow first source reference, not analysis phase order"
    );
    let global_slot = hir.globals[0].id;
    let host_object = hir.globals[1].id;
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "mutate")
        })
        .expect("mutate function");
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let authored = |instruction: &fict_hir::HirInstruction| {
        let span = instruction.origin.primary_span.expect("source instruction");
        &source[span.start() as usize..span.end() as usize]
    };
    let mutations: Vec<_> = instructions
        .iter()
        .copied()
        .filter(|instruction| {
            matches!(
                instruction.kind,
                HirInstructionKind::Write { .. } | HirInstructionKind::ReadWrite { .. }
            )
        })
        .collect();
    assert_eq!(
        mutations
            .iter()
            .map(|instruction| authored(instruction))
            .collect::<Vec<_>>(),
        [
            "globalSlot = value",
            "globalSlot += value",
            "globalSlot++",
            "hostObject.fixed = value",
            "hostObject[key] = value",
            "make().field--",
        ]
    );
    assert!(mutations.iter().all(|instruction| {
        instruction.semantics.mutation == MutationEffect::Observable
            && instruction.semantics.may_throw
    }));
    for mutation in &mutations[..3] {
        let place = match &mutation.kind {
            HirInstructionKind::Write { place, .. }
            | HirInstructionKind::ReadWrite { place, .. } => place,
            _ => unreachable!(),
        };
        assert_eq!(place.base, fict_hir::PlaceBase::Global(global_slot));
        assert!(place.projections.is_empty());
        assert!(!place.is_local());
    }
    assert!(matches!(
        mutations[1].kind,
        HirInstructionKind::ReadWrite {
            compound: Some(CompoundAssignmentOperator::Add),
            update: None,
            ..
        }
    ));
    assert!(matches!(
        mutations[2].kind,
        HirInstructionKind::ReadWrite {
            update: Some(UpdateOperator::Increment),
            prefix: false,
            ..
        }
    ));
    let static_write = match &mutations[3].kind {
        HirInstructionKind::Write { place, .. } => place,
        _ => panic!("static host write"),
    };
    assert!(matches!(
        (&static_write.base, static_write.projections.as_slice()),
        (
            fict_hir::PlaceBase::Global(id),
            [fict_hir::Projection::StaticProperty {
                name,
                optional: false,
            }]
        ) if *id == host_object && name == "fixed"
    ));
    let computed_write = match &mutations[4].kind {
        HirInstructionKind::Write { place, .. } => place,
        _ => panic!("computed host write"),
    };
    assert!(matches!(
        (&computed_write.base, computed_write.projections.as_slice()),
        (
            fict_hir::PlaceBase::Global(id),
            [fict_hir::Projection::ComputedProperty { optional: false, .. }]
        ) if *id == host_object
    ));
    let temporary_write = match &mutations[5].kind {
        HirInstructionKind::ReadWrite { place, .. } => place,
        _ => panic!("temporary update"),
    };
    let fict_hir::PlaceBase::Value(temporary_base) = temporary_write.base else {
        panic!("temporary member must retain its evaluated value base")
    };
    assert!(matches!(
        temporary_write.projections.as_slice(),
        [fict_hir::Projection::StaticProperty {
            name,
            optional: false,
        }] if name == "field"
    ));
    let call_position = instructions
        .iter()
        .position(|instruction| {
            instruction.result == Some(temporary_base)
                && matches!(instruction.kind, HirInstructionKind::Call(_))
                && authored(instruction) == "make()"
        })
        .expect("temporary base call");
    let update_position = instructions
        .iter()
        .position(|instruction| std::ptr::eq(*instruction, mutations[5]))
        .expect("temporary update position");
    assert!(call_position < update_position);
    let host_reads: Vec<_> = instructions
        .iter()
        .copied()
        .filter(|instruction| {
            matches!(
                &instruction.kind,
                HirInstructionKind::Read { place }
                    if place.base == fict_hir::PlaceBase::Global(host_object)
            )
        })
        .collect();
    assert_eq!(
        host_reads.len(),
        1,
        "assignment targets must not synthesize reads"
    );
    assert_eq!(authored(host_reads[0]), "hostObject.fixed");
    assert!(matches!(
        &host_reads[0].kind,
        HirInstructionKind::Read { place }
            if matches!(
                place.projections.as_slice(),
                [fict_hir::Projection::StaticProperty {
                    name,
                    optional: false,
                }] if name == "fixed"
            )
    ));
}
#[test]
fn materializes_bare_host_reads_without_breaking_special_or_dynamic_references() {
    let source = r#"
        function inspect(argument) {
            const direct = ambientValue;
            const called = ambientCall(argument);
            const shorthand = { ambientValue };
            const tagged = ambientTag`value:${argument}`;
            const member = ambientObject.field;
            const kind = typeof missingTypeof;
            const removed = delete missingDelete;
            return [direct, called, shorthand, tagged, member, kind, removed];
        }
        function shadow(ambientValue, ambientCall) {
            return ambientCall(ambientValue);
        }
        function dynamic(scope) {
            with (scope) {
                const read = withOnlyRead;
                withOnlyWrite = 2;
                const kind = typeof withOnlyTypeof;
                const removed = delete withOnlyDelete;
                return [read, kind, removed];
            }
        }
    "#;
    let output = build_hir(
        source,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Script,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified bare host-read HIR");
    assert_eq!(
        hir.globals
            .iter()
            .map(|global| global.name.as_str())
            .collect::<Vec<_>>(),
        ["ambientValue", "ambientCall", "ambientTag", "ambientObject"]
    );
    assert_eq!(
        hir.authored_free_names,
        [
            "ambientValue",
            "ambientCall",
            "ambientTag",
            "ambientObject",
            "missingTypeof",
            "missingDelete",
            "withOnlyRead",
            "withOnlyWrite",
            "withOnlyTypeof",
            "withOnlyDelete",
        ]
    );
    let global = |name: &str| {
        hir.globals
            .iter()
            .find(|global| global.name == name)
            .unwrap_or_else(|| panic!("{name} global"))
            .id
    };
    let function = |name: &str| {
        hir.functions
            .iter()
            .find(|function| {
                function
                    .binding
                    .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == name)
            })
            .unwrap_or_else(|| panic!("{name} function"))
    };
    let inspect = function("inspect");
    let instructions: Vec<_> = inspect
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let authored = |instruction: &fict_hir::HirInstruction| {
        let span = instruction.origin.primary_span.expect("source instruction");
        &source[span.start() as usize..span.end() as usize]
    };
    let global_reads: Vec<_> = instructions
        .iter()
        .copied()
        .filter(|instruction| {
            matches!(
                instruction.kind,
                HirInstructionKind::Read {
                    place: fict_hir::Place {
                        base: fict_hir::PlaceBase::Global(_),
                        ..
                    },
                }
            )
        })
        .collect();
    assert_eq!(
        global_reads
            .iter()
            .map(|instruction| authored(instruction))
            .collect::<Vec<_>>(),
        [
            "ambientValue",
            "ambientCall",
            "ambientValue",
            "ambientTag",
            "ambientObject.field",
        ]
    );
    assert!(global_reads[..4].iter().all(|instruction| {
        instruction.semantics == fict_hir::InstructionSemantics::CONSERVATIVE_EAGER
    }));
    assert!(matches!(
        &global_reads[4].kind,
        HirInstructionKind::Read { place }
            if place.base == fict_hir::PlaceBase::Global(global("ambientObject"))
                && matches!(
                    place.projections.as_slice(),
                    [fict_hir::Projection::StaticProperty {
                        name,
                        optional: false,
                    }] if name == "field"
                )
    ));
    assert!(!global_reads.iter().any(|instruction| {
        matches!(
            &instruction.kind,
            HirInstructionKind::Read { place }
                if place.base == fict_hir::PlaceBase::Global(global("ambientObject"))
                    && place.projections.is_empty()
        )
    }));
    let result_for_authored = |text: &str| {
        instructions
            .iter()
            .find(|instruction| authored(instruction) == text)
            .and_then(|instruction| instruction.result)
            .unwrap_or_else(|| panic!("{text} result"))
    };
    let ambient_call = result_for_authored("ambientCall");
    assert!(instructions.iter().any(|instruction| {
        matches!(
            &instruction.kind,
            HirInstructionKind::Call(call) if call.callee == ambient_call
        )
    }));
    let ambient_tag = result_for_authored("ambientTag");
    assert!(instructions.iter().any(|instruction| {
        matches!(
            &instruction.kind,
            HirInstructionKind::TaggedTemplate { tag, .. } if *tag == ambient_tag
        )
    }));
    assert!(instructions.iter().any(|instruction| {
        matches!(
            &instruction.kind,
            HirInstructionKind::UnresolvedTypeof { identifier }
                if identifier == "missingTypeof"
        )
    }));
    assert!(instructions.iter().any(|instruction| {
        matches!(
            &instruction.kind,
            HirInstructionKind::Delete {
                target: DeleteTarget::UnresolvedIdentifier(identifier),
            } if identifier == "missingDelete"
        )
    }));
    assert!(
        !hir.globals
            .iter()
            .any(|global| global.name == "missingTypeof" || global.name == "missingDelete")
    );
    let shadow = function("shadow");
    assert!(
        shadow
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .filter_map(|instruction| match &instruction.kind {
                HirInstructionKind::Read { place } => Some(place),
                _ => None,
            })
            .all(|place| matches!(place.base, fict_hir::PlaceBase::Local(_)))
    );
    let dynamic = function("dynamic");
    assert!(
        dynamic
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .all(|instruction| {
                !matches!(
                    instruction.kind,
                    HirInstructionKind::Read {
                        place: fict_hir::Place {
                            base: fict_hir::PlaceBase::Global(_),
                            ..
                        },
                    } | HirInstructionKind::Write {
                        place: fict_hir::Place {
                            base: fict_hir::PlaceBase::Global(_),
                            ..
                        },
                        ..
                    } | HirInstructionKind::ReadWrite {
                        place: fict_hir::Place {
                            base: fict_hir::PlaceBase::Global(_),
                            ..
                        },
                        ..
                    }
                )
            })
    );
    for name in [
        "withOnlyRead",
        "withOnlyWrite",
        "withOnlyTypeof",
        "withOnlyDelete",
    ] {
        assert!(!hir.globals.iter().any(|global| global.name == name));
    }
}
#[test]
fn materializes_reference_aware_delete_targets_without_property_reads() {
    let source = r#"
        function remove(obj, key, effect, local) {
            const staticResult = delete obj.fixed;
            const computedResult = delete obj[key()];
            const parenthesizedResult = delete (obj.nested);
            const optionalResult = delete obj?.optional;
            const valueResult = delete effect();
            const literalResult = delete 1;
            const localResult = delete local;
            const globalResult = delete ambientDeleteTarget;
            return [
                staticResult,
                computedResult,
                parenthesizedResult,
                optionalResult,
                valueResult,
                literalResult,
                localResult,
                globalResult,
            ];
        }
    "#;
    let output = build_hir(
        source,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Script,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified delete HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "remove")
        })
        .expect("remove function");
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let instruction_for_result = |value| function.instruction_for_result(value).unwrap();
    let initializer = |name: &str| {
        let local = function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"));
        instructions
            .iter()
            .find_map(|instruction| match instruction.kind {
                HirInstructionKind::Declare {
                    local: candidate,
                    initializer,
                    ..
                } if candidate == local.id => initializer,
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name} initializer"))
    };
    let root = |name: &str| instruction_for_result(initializer(name));
    let object = function
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("obj"))
        .expect("obj parameter");
    for (name, property, optional) in [
        ("staticResult", "fixed", false),
        ("parenthesizedResult", "nested", false),
        ("optionalResult", "optional", true),
    ] {
        let deletion = root(name);
        assert!(matches!(
            &deletion.kind,
            HirInstructionKind::Delete {
                target: DeleteTarget::Place(place),
            } if place.base == fict_hir::PlaceBase::Local(object.id)
                && matches!(
                    place.projections.as_slice(),
                    [fict_hir::Projection::StaticProperty {
                        name: candidate,
                        optional: candidate_optional,
                    }] if candidate == property && *candidate_optional == optional
                )
        ));
        assert_eq!(deletion.semantics.mutation, MutationEffect::Observable);
        assert!(deletion.semantics.may_throw);
    }
    let computed = root("computedResult");
    let HirInstructionKind::Delete {
        target: DeleteTarget::Place(computed_place),
    } = &computed.kind
    else {
        panic!("computed delete place")
    };
    let [
        fict_hir::Projection::ComputedProperty {
            key,
            optional: false,
        },
    ] = computed_place.projections.as_slice()
    else {
        panic!("computed delete key")
    };
    let key_call = instruction_for_result(*key);
    assert!(matches!(key_call.kind, HirInstructionKind::Call(_)));
    assert!(
        key_call
            .origin
            .primary_span
            .is_some_and(|span| { &source[span.start() as usize..span.end() as usize] == "key()" })
    );
    let position = |instruction: &fict_hir::HirInstruction| {
        instructions
            .iter()
            .position(|candidate| std::ptr::eq(*candidate, instruction))
            .expect("instruction position")
    };
    assert!(position(key_call) < position(computed));
    for (name, operand) in [("valueResult", "effect()"), ("literalResult", "1")] {
        let deletion = root(name);
        let HirInstructionKind::Delete {
            target: DeleteTarget::Value(value),
        } = deletion.kind
        else {
            panic!("ordinary value delete for {name}")
        };
        let operand_instruction = instruction_for_result(value);
        assert!(operand_instruction.origin.primary_span.is_some_and(|span| {
            &source[span.start() as usize..span.end() as usize] == operand
        }));
        assert_eq!(
            deletion.semantics,
            fict_hir::InstructionSemantics::PURE_EAGER
        );
        assert!(position(operand_instruction) < position(deletion));
    }
    let local_parameter = function
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("local"))
        .expect("local parameter");
    let local_delete = root("localResult");
    assert!(matches!(
        &local_delete.kind,
        HirInstructionKind::Delete {
            target: DeleteTarget::Place(place),
        } if place.base == fict_hir::PlaceBase::Local(local_parameter.id)
            && place.projections.is_empty()
    ));
    assert_eq!(
        local_delete.semantics,
        fict_hir::InstructionSemantics::PURE_EAGER
    );
    assert!(!instructions.iter().any(|instruction| {
        matches!(
            &instruction.kind,
            HirInstructionKind::Read { place }
                if place.base == fict_hir::PlaceBase::Local(local_parameter.id)
                    && place.projections.is_empty()
        )
    }));
    let global_delete = root("globalResult");
    assert!(matches!(
        &global_delete.kind,
        HirInstructionKind::Delete {
            target: DeleteTarget::UnresolvedIdentifier(identifier),
        } if identifier == "ambientDeleteTarget"
    ));
    assert_eq!(
        global_delete.semantics,
        fict_hir::InstructionSemantics::CONSERVATIVE_EAGER
    );
    for member in ["obj.fixed", "obj[key()]", "obj.nested", "obj?.optional"] {
        assert!(
            !instructions.iter().any(|instruction| {
                matches!(instruction.kind, HirInstructionKind::Read { .. })
                    && instruction.origin.primary_span.is_some_and(|span| {
                        &source[span.start() as usize..span.end() as usize] == member
                    })
            }),
            "delete must not read the current value of {member}"
        );
    }
    assert!(!instructions.iter().any(|instruction| {
        matches!(
            &instruction.kind,
            HirInstructionKind::Read { place }
                if place.base == fict_hir::PlaceBase::Local(object.id)
                    && place.projections.is_empty()
        )
    }));
    for name in [
        "staticResult",
        "computedResult",
        "parenthesizedResult",
        "optionalResult",
        "valueResult",
        "literalResult",
        "localResult",
        "globalResult",
    ] {
        assert!(
            !matches!(root(name).kind, HirInstructionKind::SyntaxFragment { .. }),
            "{name} must not fall back to adapter-owned syntax"
        );
    }
}
#[test]
fn classifies_nested_state_mutation_by_strict_guarantee_policy() {
    let source = r#"
        import { $state } from 'fict';
        function App() {
            const user = $state({ name: 'Ada' });
            user.name = 'Grace';
            return user.name;
        }
    "#;
    let strict = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(strict.hir.is_none());
    let finding = strict
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code.as_str() == "FICT-M")
        .expect("strict nested-mutation diagnostic");
    assert_eq!(
        finding.severity,
        fict_diagnostics::DiagnosticSeverity::Error
    );
    assert_eq!(
        finding.guarantee_class,
        fict_diagnostics::GuaranteeClass::Fallback
    );
    let fallback = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions {
            strict_guarantee: false,
            ..HirBuildOptions::default()
        },
    );
    assert!(fallback.hir.is_some(), "{:?}", fallback.diagnostics);
    let finding = fallback
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code.as_str() == "FICT-M")
        .expect("fallback nested-mutation warning");
    assert_eq!(
        finding.severity,
        fict_diagnostics::DiagnosticSeverity::Warning
    );
}
#[test]
fn classifies_state_array_mutating_methods_by_strict_guarantee_policy() {
    let source = r#"
        import { $state } from 'fict';
        function App() {
            const items = $state([1, 2]);
            items.copyWithin(0, 1); items.fill(0); items.pop(); items.push(3);
            items.reverse(); items.shift(); items.sort(); items.splice(0, 1); items.unshift(0);
            items.map(item => item * 2);
            return items.length;
        }
    "#;
    let strict = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(strict.hir.is_none());
    let findings = strict
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code.as_str() == "FICT-M")
        .collect::<Vec<_>>();
    assert_eq!(findings.len(), 9, "{:?}", strict.diagnostics);
    assert_eq!(
        findings[0].severity,
        fict_diagnostics::DiagnosticSeverity::Error
    );

    let fallback = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions {
            strict_guarantee: false,
            ..HirBuildOptions::default()
        },
    );
    assert!(fallback.hir.is_some(), "{:?}", fallback.diagnostics);
    let findings = fallback
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code.as_str() == "FICT-M")
        .collect::<Vec<_>>();
    assert_eq!(findings.len(), 9, "{:?}", fallback.diagnostics);
    assert_eq!(
        findings[0].severity,
        fict_diagnostics::DiagnosticSeverity::Warning
    );
}
#[test]
fn fails_closed_for_unproven_state_method_calls_across_builtin_receivers() {
    let source = r#"
        import { $state } from 'fict';
        function App(method) {
            const map = $state(new Map());
            map.set('x', 1); map.delete('x'); map.clear(); map.get('x'); map.has('x');
            const set = $state(new Set());
            set.add('x'); set.delete('x'); set.clear(); set.has('x');
            const date = $state(new Date());
            date.setTime(0); date.setFullYear(2025); date.getTime();
            const typed = $state(new Uint8Array(4));
            typed.set([1]); typed.copyWithin(0, 1); typed.fill(0); typed.reverse(); typed.sort();
            typed.includes(1); typed.slice(0);
            const custom = $state({ mutate() {}, read() {}, get() {}, map() {}, toString() {} });
            custom.mutate(); custom.read(); custom.get(); custom.map(); custom.toString();
            custom[method]();
            return map.get('x') ?? set.has('x') ?? date.getTime() ?? typed.includes(1);
        }
    "#;
    let strict = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(strict.hir.is_none());
    let findings = strict
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code.as_str() == "FICT-M")
        .collect::<Vec<_>>();
    assert_eq!(findings.len(), 19, "{:?}", strict.diagnostics);
    assert!(findings.iter().all(|diagnostic| {
        diagnostic.severity == fict_diagnostics::DiagnosticSeverity::Error
            && diagnostic.guarantee_class == fict_diagnostics::GuaranteeClass::Fallback
    }));

    let fallback = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions {
            strict_guarantee: false,
            ..HirBuildOptions::default()
        },
    );
    assert!(fallback.hir.is_some(), "{:?}", fallback.diagnostics);
    let findings = fallback
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code.as_str() == "FICT-M")
        .collect::<Vec<_>>();
    assert_eq!(findings.len(), 19, "{:?}", fallback.diagnostics);
    assert!(findings.iter().all(|diagnostic| {
        diagnostic.severity == fict_diagnostics::DiagnosticSeverity::Warning
    }));
}

#[test]
fn certifies_function_methods_but_not_shadowed_or_reassigned_builtin_receivers() {
    let source = r#"
        import { $state } from 'fict';
        function FunctionState() {
            const fn = $state((value) => value);
            fn.call(null, 1); fn.apply(null, [2]); fn.bind(null, 3); fn?.call(null, 4);
            const value = $state(123 as any);
            value.call(null);
        }
        function Shadowed() {
            class Map { get() {} }
            const map = $state(new Map());
            map.get();
        }
        function Reassigned() {
            let map = $state(new Map());
            map = { get() {} };
            map.get();
        }
        function DeclaredFamilies() {
            let items = $state<string[] | null>(null);
            items = ['next'];
            items.map(item => item.toUpperCase());
            let date = $state<Date | null>(null);
            date = new Date();
            date.toISOString();
        }
        function PreservedArrayAssignments() {
            let values = $state([1, 2, 3]);
            values = values.filter(value => value > 1);
            values.map(value => value * 2);
            let rows = $state(Array.from({ length: 2 }, (_, index) => index));
            rows = rows.map(value => value + 1);
            rows.map(value => value * 2);
        }
        function TypedParameterReplacement() {
            let items = $state(['first']);
            const replace = (value: string[]) => { items = value; };
            replace(['next']);
            items.map(item => item.toUpperCase());
        }
    "#;
    let fallback = build_hir(
        source,
        options(OxcSourceLanguage::TypeScript),
        &HirBuildOptions {
            strict_guarantee: false,
            ..HirBuildOptions::default()
        },
    );
    assert!(fallback.hir.is_some(), "{:?}", fallback.diagnostics);
    let findings = fallback
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code.as_str() == "FICT-M")
        .collect::<Vec<_>>();
    assert_eq!(findings.len(), 3, "{:?}", fallback.diagnostics);
}

#[test]
fn store_method_calls_do_not_use_the_shallow_state_mutation_policy() {
    let source = r#"
        import { $store } from 'fict';
        function App() {
            const model = $store({ customMutator() {}, values: new Map() });
            model.customMutator();
            model.values.set('x', 1);
            return model.values.get('x');
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_some(), "{:?}", output.diagnostics);
    assert!(
        output
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code.as_str() != "FICT-M"),
        "{:?}",
        output.diagnostics
    );
}

#[test]
fn classifies_nested_state_deletion_by_strict_guarantee_policy() {
    let source = r#"
        import { $state } from 'fict';
        function App() {
            const user = $state({ name: 'Ada' });
            const removed = delete user.name;
            return removed;
        }
    "#;
    let strict = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(strict.hir.is_none());
    let finding = strict
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code.as_str() == "FICT-M")
        .expect("strict nested-deletion diagnostic");
    assert_eq!(
        finding.severity,
        fict_diagnostics::DiagnosticSeverity::Error
    );
    assert_eq!(
        finding.guarantee_class,
        fict_diagnostics::GuaranteeClass::Fallback
    );
    let fallback = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions {
            strict_guarantee: false,
            ..HirBuildOptions::default()
        },
    );
    let finding = fallback
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code.as_str() == "FICT-M")
        .expect("fallback nested-deletion warning");
    assert_eq!(
        finding.severity,
        fict_diagnostics::DiagnosticSeverity::Warning
    );
    let hir = fallback.hir.expect("fallback nested-deletion HIR");
    assert!(hir.functions.iter().any(|function| {
        function
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .any(|instruction| {
                matches!(
                    &instruction.kind,
                    HirInstructionKind::Delete {
                        target: DeleteTarget::Place(place),
                    } if !place.projections.is_empty()
                )
            })
    }));
}
#[test]
fn classifies_hooks_and_binding_resolved_reactive_callbacks() {
    let source = r#"
        import { run as render } from './host';
        function useCounter() { return 1; }
        function use_counter() { return 2; }
        function useful() { return 3; }
        function useÉclair() { return 4; }
        render(() => useCounter());
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions {
            reactive_scopes: vec!["render".into()],
            ..HirBuildOptions::default()
        },
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let kind = |name| {
        hir.functions
            .iter()
            .find(|function| {
                function
                    .binding
                    .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == name)
            })
            .map(|function| function.kind)
    };
    assert_eq!(kind("useCounter"), Some(FunctionKind::Hook));
    assert_eq!(kind("use_counter"), Some(FunctionKind::Hook));
    assert_eq!(kind("useful"), Some(FunctionKind::Plain));
    assert_eq!(kind("useÉclair"), Some(FunctionKind::Plain));
    assert!(
        hir.functions
            .iter()
            .any(|function| function.kind == FunctionKind::ReactiveScope)
    );
    let render_call = hir.functions[0].blocks[0]
        .instructions
        .iter()
        .find_map(|instruction| match &instruction.kind {
            HirInstructionKind::Call(call) => Some(call),
            _ => None,
        })
        .expect("render call");
    assert!(matches!(render_call.host, CallHost::ReactiveScope(_)));
}

#[test]
fn matches_configured_reactive_scope_callee_forms_without_alias_or_shadow_leaks() {
    let source = r#"
        import { renderHook, renderHook as importedAlias } from './host';
        import * as utils from './host';

        renderHook(() => {});
        utils.renderHook(() => {});
        utils?.renderHook(() => {});
        utils.renderHook?.(() => {});
        globalRenderHook(() => {});

        utils['renderHook'](() => {});
        const alias = renderHook;
        alias(() => {});
        importedAlias(() => {});
        function shadow(renderHook) {
            renderHook(() => {});
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions {
            reactive_scopes: vec!["renderHook".into(), "globalRenderHook".into()],
            ..HirBuildOptions::default()
        },
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let calls: Vec<_> = hir
        .functions
        .iter()
        .flat_map(|function| &function.blocks)
        .flat_map(|block| &block.instructions)
        .filter_map(|instruction| match &instruction.kind {
            HirInstructionKind::Call(call) => instruction
                .origin
                .primary_span
                .map(|span| (&source[span.start() as usize..span.end() as usize], call)),
            _ => None,
        })
        .collect();
    let configured: Vec<_> = calls
        .iter()
        .filter_map(|(authored, call)| match call.host {
            CallHost::ReactiveScope(host) => Some((*authored, host)),
            CallHost::Unknown | CallHost::Binding(_) | CallHost::Function(_) => None,
        })
        .collect();
    assert_eq!(configured.len(), 5, "{configured:#?}");
    for expected in [
        "renderHook(() => {})",
        "utils.renderHook(() => {})",
        "utils?.renderHook(() => {})",
        "utils.renderHook?.(() => {})",
        "globalRenderHook(() => {})",
    ] {
        let host = configured
            .iter()
            .find_map(|(authored, host)| (*authored == expected).then_some(host))
            .unwrap_or_else(|| panic!("missing configured host {expected}: {configured:#?}"));
        assert_eq!(host.kind, ReactiveScopeKind::Configured);
    }
    assert!(
        configured
            .iter()
            .find(|(authored, _)| *authored == "renderHook(() => {})")
            .is_some_and(|(_, host)| host.callee.is_some())
    );
    assert!(
        configured
            .iter()
            .filter(|(authored, _)| *authored != "renderHook(() => {})")
            .all(|(_, host)| host.callee.is_none())
    );
    for rejected in [
        "utils['renderHook'](() => {})",
        "alias(() => {})",
        "importedAlias(() => {})",
        "renderHook(() => {})",
    ] {
        assert!(calls.iter().any(|(authored, call)| {
            *authored == rejected && !matches!(call.host, CallHost::ReactiveScope(_))
        }));
    }
    assert_eq!(
        hir.functions
            .iter()
            .filter(|function| function.kind == FunctionKind::ReactiveScope)
            .count(),
        5
    );
}

#[test]
fn classifies_named_function_expressions_by_their_public_binding() {
    let source = r#"
        import { $state } from 'fict';
        export const useF = function inner() {
            let count = $state(0);
            return typeof inner === 'function' ? count : -1;
        };
        const helper = function useInternal() {
            return typeof useInternal;
        };
        export const NamedView = function recursiveView() {
            return <span>view</span>;
        };
        const helperView = function InnerView() {
            return <span>helper</span>;
        };
        export function App() {
            const count = useF();
            return <div>{count}</div>;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let function = |name: &str| {
        hir.functions
            .iter()
            .find(|function| {
                function
                    .binding
                    .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == name)
            })
            .unwrap_or_else(|| panic!("missing {name} function"))
    };
    let use_f = function("useF");
    assert_eq!(use_f.kind, FunctionKind::Hook);
    assert_eq!(function("helper").kind, FunctionKind::Plain);
    assert_eq!(function("NamedView").kind, FunctionKind::Component);
    assert_eq!(function("helperView").kind, FunctionKind::Plain);
    let app = function("App");
    assert_eq!(app.kind, FunctionKind::Component);
    let use_f_binding = use_f.binding.expect("public hook binding");
    assert!(
        app.blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .any(|instruction| matches!(
                &instruction.kind,
                HirInstructionKind::Call(call) if call.host == CallHost::Binding(use_f_binding)
            ))
    );
    assert!(
        hir.bindings
            .iter()
            .any(|binding| binding.display_name == "inner")
    );
    assert!(
        hir.bindings
            .iter()
            .any(|binding| binding.display_name == "useInternal")
    );
}

#[test]
fn retains_patterns_and_function_bodies_as_owned_controlled_fragments() {
    let source = "const View = ({ value = 1, ...rest }) => value + rest.offset;";
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let view = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "View")
        })
        .expect("View arrow function");
    assert_eq!(view.kind, FunctionKind::Plain);
    let pattern = &hir.syntax_fragments[view.parameters[0].pattern.as_usize()];
    assert_eq!(pattern.kind, SyntaxFragmentKind::Pattern);
    let summary = pattern.summary.pattern.as_ref().expect("pattern summary");
    assert_eq!(summary.declared_bindings.len(), 2);
    assert!(summary.has_defaults);
    assert!(summary.has_rest);
    let adapter = output
        .syntax_fragments
        .iter()
        .find(|fragment| fragment.id == pattern.id)
        .expect("adapter fragment");
    assert!(adapter.source.contains("value = 1"));
}
#[test]
fn unsupported_macro_shapes_fail_closed_with_structured_codes() {
    let cases = [
        (
            "import { $state as state } from 'fict'; state?.(1);",
            "FICT-HIR-MACRO-OPTIONAL",
        ),
        (
            "import { $state as state } from 'fict'; const escaped = state;",
            "FICT-HIR-MACRO-VALUE",
        ),
        (
            "import * as Fict from 'fict'; Fict['$state'](1);",
            "FICT-HIR-MACRO-NAMESPACE",
        ),
        (
            "import * as Fict from 'fict/slim'; Fict.$effect(() => {});",
            "FICT-HIR-MACRO-NAMESPACE",
        ),
        (
            "import { $state as state } from 'fict'; const value = (0, state)(1);",
            "FICT-HIR-MACRO-VALUE",
        ),
        (
            "import { $effect as effect } from 'fict'; (0, effect)(() => {});",
            "FICT-HIR-MACRO-VALUE",
        ),
    ];
    for (source, code) in cases {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none());
        assert_eq!(output.diagnostics[0].code.as_str(), code);
    }
}

#[test]
fn treats_namespace_memo_macros_as_runtime_memo_accessors() {
    let source = r#"
        import { $memo as namedMemo, $state } from 'fict';
        import * as F from 'fict';
        function App() {
            let count = $state(1);
            const named = namedMemo(() => count * 4);
            const direct = F.$memo(() => count * 2);
            const computed = F['$memo']?.(() => count * 3);
            return <div>{named}{direct}{computed}</div>;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified namespace memo HIR");
    let runtime_memos: Vec<_> = hir
        .functions
        .iter()
        .flat_map(|function| &function.blocks[0].instructions)
        .filter_map(|instruction| match &instruction.kind {
            HirInstructionKind::Call(call)
                if call.reactive_kind == Some(ReactiveCallKind::Memo) =>
            {
                Some(call)
            }
            _ => None,
        })
        .collect();
    assert_eq!(runtime_memos.len(), 2);
    assert!(runtime_memos.iter().all(|call| {
        call.macro_kind.is_none()
            && matches!(
                &call.host,
                CallHost::ReactiveScope(host)
                    if host.kind == ReactiveScopeKind::MemoCallback
            )
    }));
    assert!(!runtime_memos[0].optional);
    assert!(runtime_memos[1].optional);
    assert_eq!(
        hir.functions
            .iter()
            .flat_map(|function| &function.blocks[0].instructions)
            .filter(|instruction| {
                matches!(
                    instruction.kind,
                    HirInstructionKind::Call(ref call)
                        if call.macro_kind == Some(FictMacroKind::Memo)
                )
            })
            .count(),
        1,
        "the named macro must not also be classified as a runtime creator"
    );
}
#[test]
fn applies_function_directives_and_erases_type_only_binding_ids() {
    let source = r#"
        import type { Shape } from './shape';
        export function useValue(value: Shape) {
            "use no memo";
            "use pure";
            return value;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::TypeScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let hook = hir
        .functions
        .iter()
        .find(|function| function.kind == FunctionKind::Hook)
        .expect("hook");
    assert!(hook.flags.no_memo);
    assert!(hook.flags.pure);
    assert!(
        hir.bindings
            .iter()
            .all(|binding| binding.display_name != "Shape")
    );
    for (index, binding) in hir.bindings.iter().enumerate() {
        assert_eq!(binding.id.as_usize(), index);
    }
}
#[test]
fn propagates_module_policies_without_leaking_function_policies() {
    let module_output = build_hir(
        r#"
            "use no memo";
            "use pure";
            export function TopLevel() {
                function Nested() { return 1; }
                return Nested();
            }
        "#,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(
        module_output.diagnostics.is_empty(),
        "{:?}",
        module_output.diagnostics
    );
    let module_hir = module_output.hir.expect("verified module-policy HIR");
    assert!(
        module_hir
            .functions
            .iter()
            .all(|function| function.flags.no_memo && function.flags.pure)
    );

    let local_output = build_hir(
        r#"
            export function Local() {
                "use no memo";
                "use pure";
                function Child() { return 1; }
                return Child();
            }
            export function Sibling() { return 2; }
        "#,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(
        local_output.diagnostics.is_empty(),
        "{:?}",
        local_output.diagnostics
    );
    let local_hir = local_output.hir.expect("verified function-policy HIR");
    for (name, expected) in [("Local", true), ("Child", false), ("Sibling", false)] {
        let function = local_hir
            .functions
            .iter()
            .find(|function| {
                function.binding.is_some_and(|binding| {
                    local_hir.bindings[binding.as_usize()].display_name == name
                })
            })
            .unwrap_or_else(|| panic!("{name} function"));
        assert_eq!(function.flags.no_memo, expected, "{name} no_memo");
        assert_eq!(function.flags.pure, expected, "{name} pure");
    }
}
#[test]
fn builds_structural_jsx_tags_attributes_children_and_prop_spreads() {
    let source = r#"
        import * as UI from './ui';
        import { Item } from './item';
        export function App({ items }) {
            return <UI.List dense title="items" {...items}>
                <Item value={items[0]} />
            </UI.List>;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    assert_eq!(hir.templates.len(), 1);
    let fict_hir::JsxNode::Element(root) = &hir.templates[0].root else {
        panic!("root JSX element")
    };
    let fict_hir::JsxElementName::Member {
        root: binding,
        properties,
    } = &root.name
    else {
        panic!("binding-aware member tag")
    };
    assert_eq!(properties, &["List"]);
    assert_eq!(hir.bindings[binding.as_usize()].display_name, "UI");
    assert_eq!(root.attributes.len(), 3);
    assert!(matches!(
        root.attributes[0],
        fict_hir::JsxAttribute::Named {
            value: fict_hir::JsxAttributeValue::ImplicitTrue,
            ..
        }
    ));
    assert!(
        root.attributes
            .iter()
            .any(|attribute| matches!(attribute, fict_hir::JsxAttribute::Spread { .. }))
    );
    assert!(root.children.iter().any(|child| matches!(
        child,
        fict_hir::JsxChild::Node(node)
            if matches!(node.as_ref(), fict_hir::JsxNode::Element(element)
                if matches!(element.name, fict_hir::JsxElementName::Component(_)))
    )));
}

#[test]
fn rejects_source_jsx_spread_children() {
    let cases = [
        (
            "intrinsic",
            "export function App(items) { return <div>{...items}</div>; }",
        ),
        (
            "component",
            "function Child() { return null; } export function App(items) { return <Child>{...items}</Child>; }",
        ),
        (
            "fragment",
            "export function App(items) { return <>{...items}</>; }",
        ),
    ];

    for (name, source) in cases {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScriptJsx),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{name}: {:?}", output.diagnostics);
        let diagnostics: Vec<_> = output
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code.as_str() == "FICT-J005")
            .collect();
        assert_eq!(diagnostics.len(), 1, "{name}: {:?}", output.diagnostics);
        assert_eq!(
            diagnostics[0].message, "JSX spread children are not supported",
            "{name}"
        );
    }
}
#[test]
fn models_binding_aware_direct_keyed_map_callbacks() {
    let source = r#"
        import { $state } from 'fict';
        export function App() {
            let rows = $state([{ id: 1, name: 'A' }]);
            return <ul>{rows.map((row, index) => <li key={row.id}>{index}:{row.name}</li>)}</ul>;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let fict_hir::JsxNode::Element(root) = &hir.templates[0].root else {
        panic!("intrinsic list root")
    };
    let fict_hir::JsxChild::Expression {
        list: Some(list), ..
    } = &root.children[0]
    else {
        panic!("keyed map metadata")
    };
    let fict_hir::JsxListReceiver::Binding {
        root: receiver,
        projected: false,
        ..
    } = list.receiver
    else {
        panic!("direct binding receiver")
    };
    assert_eq!(hir.bindings[receiver.as_usize()].display_name, "rows");
    assert!(hir.functions[list.callback.as_usize()].flags.is_arrow);
    assert_eq!(list.item_references.len(), 1);
    assert_eq!(list.index_references.len(), 1);
    assert!(list.needs_index);
    let key = list
        .key
        .and_then(|key| key.primary_span)
        .expect("source key span");
    assert_eq!(&source[key.start() as usize..key.end() as usize], "row.id");
    let mutated = build_hir(
        "export function App(rows) { return <ul>{rows.map(row => <li key={row.id}>{row++}</li>)}</ul>; }",
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(mutated.diagnostics.is_empty(), "{:?}", mutated.diagnostics);
    let mutated = mutated.hir.expect("verified fallback HIR");
    let fict_hir::JsxNode::Element(root) = &mutated.templates[0].root else {
        panic!("intrinsic list root")
    };
    assert!(matches!(
        &root.children[0],
        fict_hir::JsxChild::Expression { list: None, .. }
    ));
}
#[test]
fn models_direct_unkeyed_map_callbacks_with_index_identity() {
    let source = r#"
        import { $state } from 'fict';
        export function App() {
            let rows = $state([{ name: 'A' }]);
            return <ul>{rows.map((row, index) => <li data-index={index}>{row.name}</li>)}</ul>;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert_eq!(
        output
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<Vec<_>>(),
        ["FICT-J002"]
    );
    let hir = output.hir.expect("verified HIR");
    let fict_hir::JsxNode::Element(root) = &hir.templates[0].root else {
        panic!("intrinsic list root")
    };
    let fict_hir::JsxChild::Expression {
        list: Some(list), ..
    } = &root.children[0]
    else {
        panic!("unkeyed map metadata")
    };
    assert!(list.key.is_none());
    assert!(list.key_source.is_none());
    assert!(list.key_alias_initializer.is_none());
    assert_eq!(list.item_references.len(), 1);
    assert_eq!(list.index_references.len(), 1);
    assert!(list.needs_index);
    let spread = build_hir(
        "import { $state } from 'fict'; export function App() { let rows = $state([{ name: 'A' }]); return <ul>{rows.map(row => <li {...row}>{row.name}</li>)}</ul>; }",
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions {
            strict_guarantee: false,
            ..HirBuildOptions::default()
        },
    );
    assert_eq!(
        spread
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<Vec<_>>(),
        ["FICT-J002", "FICT-J003"]
    );
    let spread = spread.hir.expect("verified fallback HIR");
    let fict_hir::JsxNode::Element(root) = &spread.templates[0].root else {
        panic!("intrinsic list root")
    };
    assert!(matches!(
        &root.children[0],
        fict_hir::JsxChild::Expression { list: None, .. }
    ));
}
#[test]
fn traces_trusted_array_method_chains_to_their_base_receiver() {
    let source = r#"
        import { $state } from 'fict';
        export function App() {
            let rows = $state([{ id: 1, visible: true }]);
            return <ul>{rows.filter(row => row.visible).map(row => <li key={row.id}>{row.id}</li>)}</ul>;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let fict_hir::JsxNode::Element(root) = &hir.templates[0].root else {
        panic!("intrinsic list root")
    };
    let fict_hir::JsxChild::Expression {
        list: Some(list), ..
    } = &root.children[0]
    else {
        panic!("array chain map metadata")
    };
    let fict_hir::JsxListReceiver::Binding {
        root: receiver,
        projected: false,
        ..
    } = list.receiver
    else {
        panic!("array chain base binding")
    };
    assert_eq!(hir.bindings[receiver.as_usize()].display_name, "rows");
    let items = list.items.primary_span.expect("array chain items origin");
    assert_eq!(
        &source[items.start() as usize..items.end() as usize],
        "rows.filter(row => row.visible)"
    );
}

#[test]
fn jsx_list_proofs_reject_authored_array_method_overrides() {
    for (name, source) in [
        (
            "instance override",
            r#"
                export function App(sink) {
                    const rows = [{ id: 1 }];
                    rows.map = sink;
                    return <ul>{rows.map(row => <li key={row.id}>{row.id}</li>)}</ul>;
                }
            "#,
        ),
        (
            "override through alias",
            r#"
                export function App(sink) {
                    const rows = [{ id: 1 }];
                    const alias = rows;
                    alias.map = sink;
                    return <ul>{rows.map(row => <li key={row.id}>{row.id}</li>)}</ul>;
                }
            "#,
        ),
        (
            "prototype chain override",
            r#"
                export function App(sink) {
                    Array.prototype.filter = sink;
                    const rows = [{ id: 1 }];
                    return <ul>{rows.filter(Boolean).map(row => <li key={row.id}>{row.id}</li>)}</ul>;
                }
            "#,
        ),
        (
            "literal prototype override",
            r#"
                export function App(sink) {
                    Array.prototype.map = sink;
                    return <ul>{[{ id: 1 }].map(row => <li key={row.id}>{row.id}</li>)}</ul>;
                }
            "#,
        ),
        (
            "reflective instance override",
            r#"
                export function App() {
                    const rows = [{ id: 1 }];
                    Object.assign(rows, { map: sink });
                    return <ul>{rows.map(row => <li key={row.id}>{row.id}</li>)}</ul>;
                }
            "#,
        ),
    ] {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScriptJsx),
            &HirBuildOptions::default(),
        );
        assert!(
            output.diagnostics.is_empty(),
            "{name}: {:?}",
            output.diagnostics
        );
        let hir = output.hir.expect("verified fallback HIR");
        let fict_hir::JsxNode::Element(root) = &hir.templates[0].root else {
            panic!("{name}: intrinsic list root")
        };
        assert!(
            matches!(
                &root.children[0],
                fict_hir::JsxChild::Expression { list: None, .. }
            ),
            "{name}: overridden methods must not use list metadata"
        );
    }
}

#[test]
fn distinguishes_optional_map_members_from_optional_calls() {
    let source = r#"
        import { $state } from 'fict';
        export function App() {
            let rows = $state([{ id: 1 }]);
            return <ul>{rows?.map(row => <li key={row.id}>{row.id}</li>)}</ul>;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let fict_hir::JsxNode::Element(root) = &hir.templates[0].root else {
        panic!("intrinsic list root")
    };
    let fict_hir::JsxChild::Expression {
        list: Some(list), ..
    } = &root.children[0]
    else {
        panic!("optional map metadata")
    };
    assert!(list.optional);
    let optional_call = build_hir(
        "import { $state } from 'fict'; export function App() { let rows = $state([{ id: 1 }]); return <ul>{rows.map?.(row => <li key={row.id}>{row.id}</li>)}</ul>; }",
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(
        optional_call.diagnostics.is_empty(),
        "{:?}",
        optional_call.diagnostics
    );
    let optional_call = optional_call.hir.expect("verified fallback HIR");
    let fict_hir::JsxNode::Element(root) = &optional_call.templates[0].root else {
        panic!("intrinsic list root")
    };
    assert!(matches!(
        &root.children[0],
        fict_hir::JsxChild::Expression { list: None, .. }
    ));
}
#[test]
fn models_context_free_anonymous_function_map_callbacks() {
    let source = r#"
        import { $state } from 'fict';
        export function App() {
            let rows = $state([{ id: 1, name: 'A' }]);
            return <ul>{rows.map(function (row, index) { return <li key={row.id}>{index}:{row.name}</li>; })}</ul>;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let fict_hir::JsxNode::Element(root) = &hir.templates[0].root else {
        panic!("intrinsic list root")
    };
    let fict_hir::JsxChild::Expression {
        list: Some(list), ..
    } = &root.children[0]
    else {
        panic!("function map metadata")
    };
    assert!(!hir.functions[list.callback.as_usize()].flags.is_arrow);
    assert_eq!(list.item_references.len(), 1);
    assert_eq!(list.index_references.len(), 1);
    for callback in [
        "function (row) { return <li key={row.id}>{this.label}</li>; }",
        "function (row) { return <li key={row.id}>{arguments.length}</li>; }",
        "function render(row) { return <li key={row.id}>{row.id}</li>; }",
    ] {
        let fallback_source = format!(
            "import {{ $state }} from 'fict'; export function App() {{ let rows = $state([{{ id: 1 }}]); return <ul>{{rows.map({callback})}}</ul>; }}"
        );
        let fallback = build_hir(
            &fallback_source,
            options(OxcSourceLanguage::JavaScriptJsx),
            &HirBuildOptions::default(),
        );
        assert!(
            fallback.diagnostics.is_empty(),
            "{:?}",
            fallback.diagnostics
        );
        let fallback = fallback.hir.expect("verified fallback HIR");
        let fict_hir::JsxNode::Element(root) = &fallback.templates[0].root else {
            panic!("intrinsic list root")
        };
        assert!(matches!(
            &root.children[0],
            fict_hir::JsxChild::Expression { list: None, .. }
        ));
    }
}
#[test]
fn models_simple_component_object_props_with_exact_read_origins() {
    let source = r#"
        function Child({ value: renamed, label = String(renamed) } = { value: 'fallback' }) {
            return <span>{label}:{renamed}</span>;
        }
        function Method({ value, value: alias }) {
            return <span>{value.toString()}:{alias}</span>;
        }
        function Nested({ user: { name, profile: { age = 18 } } }) {
            return <span>{name}:{age}</span>;
        }
        function Rest({ id, title: heading, ...rest }) {
            return <span>{id}:{heading}:{rest.extra}</span>;
        }
        function Mutated({ reactive, local, count = 1, user: { name }, alias }) {
            local = 'changed';
            count++;
            name = name.toUpperCase();
            ({ alias } = { alias: 'reassigned' });
            return <span>{reactive}:{local}:{count}:{name}:{alias}</span>;
        }
        export function App(value) {
            return <><Child value={value} label="ok" /><Method value={value} /><Nested user={{ name: 'Ada', profile: {} }} /><Rest id="x" title="Title" extra="ok" /><Mutated reactive={value} local="initial" user={{ name: 'ann' }} alias="initial" /></>;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let child = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "Child")
        })
        .expect("Child component");
    assert_eq!(child.kind, FunctionKind::Component);
    assert!(child.parameters[0].binding.is_none());
    let parameter_default = child.parameters[0]
        .default_value
        .and_then(|origin| origin.primary_span)
        .expect("component parameter default expression");
    assert_eq!(
        &source[parameter_default.start() as usize..parameter_default.end() as usize],
        "{ value: 'fallback' }"
    );
    let properties = child.parameters[0]
        .object_properties
        .as_ref()
        .expect("modeled object props");
    assert_eq!(properties.len(), 2);
    assert_eq!(properties[0].path, ["value"]);
    assert_eq!(properties[1].path, ["label"]);
    assert!(properties[0].default_value.is_none());
    let label_default = properties[1]
        .default_value
        .and_then(|origin| origin.primary_span)
        .expect("label default expression");
    assert_eq!(
        &source[label_default.start() as usize..label_default.end() as usize],
        "String(renamed)"
    );
    assert_eq!(properties[0].references.len(), 2);
    assert_eq!(properties[1].references.len(), 1);
    for property in properties {
        for reference in &property.references {
            let reference = reference.primary_span.expect("prop reference origin");
            assert_eq!(
                &source[reference.start() as usize..reference.end() as usize],
                hir.bindings[property.binding.as_usize()].display_name
            );
        }
    }
    let method = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "Method")
        })
        .expect("Method component");
    let method_properties = method.parameters[0]
        .object_properties
        .as_ref()
        .expect("method receiver props remain modeled");
    assert_eq!(method_properties.len(), 2);
    assert!(
        method_properties
            .iter()
            .all(|property| property.path == ["value"])
    );
    let nested = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "Nested")
        })
        .expect("Nested component");
    let nested_properties = nested.parameters[0]
        .object_properties
        .as_ref()
        .expect("nested object props remain modeled");
    assert_eq!(nested_properties.len(), 2);
    assert_eq!(nested_properties[0].path, ["user", "name"]);
    assert_eq!(nested_properties[0].checks.len(), 1);
    assert_eq!(nested_properties[0].checks[0].path, ["user"]);
    assert_eq!(nested_properties[1].path, ["user", "profile", "age"]);
    assert_eq!(nested_properties[1].checks.len(), 1);
    assert_eq!(nested_properties[1].checks[0].path, ["user", "profile"]);
    assert!(nested_properties[1].default_value.is_some());
    let rest = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "Rest")
        })
        .expect("Rest component");
    let rest_binding = rest.parameters[0]
        .object_rest
        .as_ref()
        .expect("top-level props rest remains modeled");
    assert_eq!(rest_binding.excluded, ["id", "title"]);
    assert_eq!(
        hir.bindings[rest_binding.binding.as_usize()].display_name,
        "rest"
    );
    let mutated = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "Mutated")
        })
        .expect("Mutated component");
    let mutated_properties = mutated.parameters[0]
        .object_properties
        .as_ref()
        .expect("mutated props remain modeled");
    assert_eq!(mutated_properties.len(), 5);
    assert_eq!(mutated_properties[0].path, ["reactive"]);
    assert_eq!(
        mutated_properties[0].mode,
        fict_hir::HirObjectParameterMode::Accessor
    );
    assert_eq!(mutated_properties[0].references.len(), 1);
    assert_eq!(mutated_properties[1].path, ["local"]);
    assert_eq!(
        mutated_properties[1].mode,
        fict_hir::HirObjectParameterMode::Mutable
    );
    assert!(mutated_properties[1].references.is_empty());
    assert_eq!(mutated_properties[2].path, ["count"]);
    assert_eq!(
        mutated_properties[2].mode,
        fict_hir::HirObjectParameterMode::Mutable
    );
    assert!(mutated_properties[2].references.is_empty());
    assert!(mutated_properties[2].default_value.is_some());
    assert_eq!(mutated_properties[3].path, ["user", "name"]);
    assert_eq!(
        mutated_properties[3].mode,
        fict_hir::HirObjectParameterMode::Mutable
    );
    assert!(mutated_properties[3].references.is_empty());
    assert_eq!(mutated_properties[4].path, ["alias"]);
    assert_eq!(
        mutated_properties[4].mode,
        fict_hir::HirObjectParameterMode::Mutable
    );
    assert!(mutated_properties[4].references.is_empty());
    let callable = build_hir(
        "function Button({ onClick }) { const invoke = onClick; return <button onClick={() => invoke.call(null)}>go</button>; } function Mixed({ label }) { label(); return <span>{String(label)}</span>; } export function App(fn) { return <><Button onClick={fn} /><Mixed label={fn} /></>; }",
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(
        callable.diagnostics.is_empty(),
        "{:?}",
        callable.diagnostics
    );
    let callable = callable.hir.expect("verified callable props HIR");
    let button = callable
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                callable.bindings[binding.as_usize()].display_name == "Button"
            })
        })
        .expect("Button component");
    let callable_properties = button.parameters[0]
        .object_properties
        .as_ref()
        .expect("call-only prop remains modeled");
    assert_eq!(callable_properties.len(), 1);
    assert_eq!(
        callable_properties[0].mode,
        fict_hir::HirObjectParameterMode::Value
    );
    assert!(callable_properties[0].references.is_empty());
    let mixed = callable
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                callable.bindings[binding.as_usize()].display_name == "Mixed"
            })
        })
        .expect("Mixed component");
    let mixed_property = &mixed.parameters[0]
        .object_properties
        .as_ref()
        .expect("mixed callable prop remains modeled")[0];
    assert_eq!(
        mixed_property.mode,
        fict_hir::HirObjectParameterMode::Accessor
    );
    assert_eq!(mixed_property.references.len(), 2);
}

#[test]
fn keeps_ordinary_uppercase_functions_and_jsx_callbacks_plain() {
    let source = r#"
        import { $state } from 'fict';
        export function Helper({ a, b, unused }) {
            return b + a;
        }
        export const renderItems = items => items.map(item => <span>{item}</span>);
        export function App() {
            let count = $state(0);
            return <div>{count}</div>;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::TypeScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let function = |name: &str| {
        hir.functions
            .iter()
            .find(|function| {
                function
                    .binding
                    .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == name)
            })
            .unwrap_or_else(|| panic!("missing {name} function"))
    };

    assert_eq!(function("Helper").kind, FunctionKind::Plain);
    assert_eq!(function("renderItems").kind, FunctionKind::Plain);
    assert_eq!(function("App").kind, FunctionKind::Component);
}

#[test]
fn diagnoses_unsupported_component_props_patterns_with_strict_fallback_policy() {
    let source = r#"
        const key = 'name';
        function ArrayProps({ list: [first, second] }) {
            return <p>{first}:{second}</p>;
        }
        function ArrayRest({ list: [head, ...tail] }) {
            return <p>{head}:{tail.length}</p>;
        }
        function Computed({ [key]: value }) {
            return <p>{value}</p>;
        }
        function EmptyKey({ '': value }) {
            return <p>{value}</p>;
        }
        function NestedRest({ user: { ...userRest } }) {
            return <p>{String(userRest.name)}</p>;
        }
    "#;
    let strict = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(strict.hir.is_none());
    assert_eq!(
        strict
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<Vec<_>>(),
        [
            "FICT-P001",
            "FICT-P002",
            "FICT-P003",
            "FICT-P003",
            "FICT-P004"
        ]
    );
    assert!(strict.diagnostics.iter().all(|diagnostic| {
        diagnostic.severity == fict_diagnostics::DiagnosticSeverity::Error
            && diagnostic.guarantee_class == fict_diagnostics::GuaranteeClass::Fallback
            && diagnostic.primary_span.is_some()
    }));
    let issue_sources = strict
        .diagnostics
        .iter()
        .map(|diagnostic| {
            let span = diagnostic.primary_span.expect("props issue span");
            &source[span.start() as usize..span.end() as usize]
        })
        .collect::<Vec<_>>();
    assert_eq!(
        issue_sources,
        [
            "[first, second]",
            "[head, ...tail]",
            "[key]: value",
            "'': value",
            "...userRest"
        ]
    );
    let fallback = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions {
            strict_guarantee: false,
            ..HirBuildOptions::default()
        },
    );
    assert!(
        fallback.diagnostics.iter().all(|diagnostic| {
            diagnostic.severity == fict_diagnostics::DiagnosticSeverity::Warning
        }),
        "{:?}",
        fallback.diagnostics
    );
    let hir = fallback.hir.expect("fallback HIR");
    for name in [
        "ArrayProps",
        "ArrayRest",
        "Computed",
        "EmptyKey",
        "NestedRest",
    ] {
        let function = hir
            .functions
            .iter()
            .find(|function| {
                function
                    .binding
                    .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == name)
            })
            .unwrap_or_else(|| panic!("{name} component"));
        assert_eq!(function.kind, FunctionKind::Component);
        assert!(function.parameters[0].object_properties.is_none());
    }
}
#[test]
fn assigns_dense_function_local_storage_and_outer_captures_without_name_identity() {
    let source = r#"
        const outer = 1;
        function App() {
            const value = outer;
            function inner() {
                const value = outer;
                return value;
            }
            return inner() + value;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let value_bindings: Vec<_> = hir
        .bindings
        .iter()
        .filter(|binding| binding.display_name == "value")
        .map(|binding| binding.id)
        .collect();
    assert_eq!(value_bindings.len(), 2);
    assert_ne!(value_bindings[0], value_bindings[1]);
    let app = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "App")
        })
        .expect("App");
    assert_eq!(app.kind, FunctionKind::Plain);
    let inner = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "inner")
        })
        .expect("inner");
    for function in [app, inner] {
        for (index, local) in function.locals.iter().enumerate() {
            assert_eq!(local.id.as_usize(), index);
        }
        assert!(function.locals.iter().any(|local| {
            local.kind == fict_hir::LocalKind::Capture
                && local
                    .binding
                    .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "outer")
        }));
    }
    assert!(
        hir.functions[0]
            .locals
            .iter()
            .all(|local| local.kind != fict_hir::LocalKind::Capture)
    );
}
#[test]
fn enforces_state_owner_target_and_top_level_placement() {
    let cases = [
        (
            "import { $state } from 'fict'; const value = $state(0);",
            "FICT-PLACEMENT-STATE-OWNER",
        ),
        (
            "import { $state } from 'fict'; function helper() { const value = $state(0); }",
            "FICT-PLACEMENT-STATE-OWNER",
        ),
        (
            "import { $state } from 'fict'; function App() { function nested() { const value = $state(0); } return null; }",
            "FICT-PLACEMENT-STATE-NESTED",
        ),
        (
            "import { $state } from 'fict'; function App() { function Child() { const value = $state(0); return value; } return null; }",
            "FICT-PLACEMENT-STATE-NESTED",
        ),
        (
            "import { $state } from 'fict'; function App() { if (ready) { const value = $state(0); } return null; }",
            "FICT-PLACEMENT-STATE-CONTROL",
        ),
        (
            "import { $state } from 'fict'; function App() { consume($state(0)); return null; }",
            "FICT-PLACEMENT-STATE-TARGET",
        ),
        (
            "import { $state } from 'fict'; function App() { const { value } = $state({ value: 0 }); return null; }",
            "FICT-PLACEMENT-STATE-DESTRUCTURE",
        ),
    ];
    for (source, expected) in cases {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{source}");
        let diagnostic = output
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code.as_str() == expected)
            .unwrap_or_else(|| panic!("{source}: {:?}", output.diagnostics));
        if expected == "FICT-PLACEMENT-STATE-OWNER" {
            assert!(
                diagnostic
                    .help
                    .as_deref()
                    .is_some_and(|help| help.contains("directly declared component or hook")),
                "{source}: {diagnostic:?}"
            );
        }
    }
    for source in [
        "import { $state } from 'fict'; function App() { const value = $state(0); return value; }",
        "import { $state } from 'fict'; function useValue() { const value = $state(0); return value; }",
    ] {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
        assert!(output.hir.is_some());
    }
}
#[test]
fn enforces_effect_and_memo_control_flow_placement() {
    let cases = [
        (
            "import { $effect } from 'fict'; function helper() { $effect(() => {}); }",
            "FICT-PLACEMENT-EFFECT-OWNER",
        ),
        (
            "import { $effect } from 'fict'; function App() { if (ready) $effect(() => {}); return null; }",
            "FICT-PLACEMENT-EFFECT-CONTROL",
        ),
        (
            "import { $effect } from 'fict'; function App() { function nested() { $effect(() => {}); } return null; }",
            "FICT-PLACEMENT-EFFECT-NESTED",
        ),
        (
            "import { $memo } from 'fict'; function App() { while (ready) { $memo(() => value); } return null; }",
            "FICT-PLACEMENT-MEMO-CONTROL",
        ),
    ];
    for (source, expected) in cases {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{source}");
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == expected),
            "{source}: {:?}",
            output.diagnostics
        );
    }
    for (source, advisory) in [
        (
            "import { $effect } from 'fict'; $effect(() => {});",
            "FICT-E001",
        ),
        (
            "import { $memo } from 'fict'; { $memo(() => value); }",
            "FICT-M001",
        ),
    ] {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert_eq!(
            output
                .diagnostics
                .iter()
                .map(|diagnostic| diagnostic.code.as_str())
                .collect::<Vec<_>>(),
            [advisory]
        );
        assert!(output.hir.is_some());
    }
}
#[test]
fn configured_reactive_scope_is_a_binding_resolved_state_owner() {
    let source = r#"
        import { renderHook as run } from './host';
        import { $state } from 'fict';
        run(() => {
            const value = $state(0);
            return value;
        });
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions {
            reactive_scopes: vec!["run".into()],
            ..HirBuildOptions::default()
        },
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    assert!(output.hir.is_some());
}
#[test]
fn enforces_direct_hook_owner_and_control_flow_placement_by_binding() {
    let cases = [
        (
            "import { use_counter } from './hooks'; use_counter();",
            "FICT-PLACEMENT-HOOK-OWNER",
        ),
        (
            "import { useCounter } from './hooks'; function App() { if (ready) useCounter(); return null; }",
            "FICT-PLACEMENT-HOOK-CONTROL",
        ),
        (
            "import { useCounter } from './hooks'; function App() { ready && useCounter(); return null; }",
            "FICT-PLACEMENT-HOOK-CONTROL",
        ),
        (
            "import { useCounter } from './hooks'; function App() { function Child() { useCounter(); return null; } return null; }",
            "FICT-PLACEMENT-HOOK-CONTROL",
        ),
    ];
    for (source, expected) in cases {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{source}");
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == expected)
        );
    }
    for source in [
        "import { useCounter } from './hooks'; function App() { useCounter(); return null; }",
        "function helper(useCounter) { return useCounter(); }",
        "import { useCounter as counter } from './hooks'; counter();",
    ] {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(
            output.diagnostics.is_empty(),
            "{source}: {:?}",
            output.diagnostics
        );
    }
}
#[test]
fn enforces_binding_aware_runtime_reactive_control_flow_placement() {
    let source = r#"
        import { createSelector as select } from 'fict';
        import { createEffect as effect, createMemo as memo } from '@fictjs/runtime';
        import * as Advanced from 'fict/advanced';
        function Demo({ ready, items, value }) {
            if (ready) select(() => value);
            for (const item of items) Advanced.createSelector(() => item);
            ready && select(() => value);
            if (ready) select?.(() => value);
            if (ready) memo?.(() => value);
            if (ready) effect(() => console.log(value));
            select(() => value) && ready;
            return <div>{ready && select(() => value)(value)}{ready && memo(() => value)()}{ready && (effect(() => void value), '')}</div>;
        }
        function Nested({ ready, value }) {
            if (ready) {
                const setup = () => select(() => value);
                console.log(setup);
            }
            return <div />;
        }
        function Immediate({ ready, value }) {
            if (ready) (() => select(() => value))();
            return <div />;
        }
        function Shadow({ ready, value }, select) {
            if (ready) select(() => value);
            return <div />;
        }
    "#;
    let strict = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(strict.hir.is_none());
    let findings = strict
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code.as_str() == "FICT-R004")
        .collect::<Vec<_>>();
    assert_eq!(findings.len(), 7, "{:?}", strict.diagnostics);
    assert!(findings.iter().all(|diagnostic| {
        diagnostic.severity == fict_diagnostics::DiagnosticSeverity::Error
            && diagnostic.guarantee_class == fict_diagnostics::GuaranteeClass::Fallback
    }));
    let finding_sources = findings
        .iter()
        .map(|diagnostic| {
            let span = diagnostic.primary_span.expect("selector placement span");
            &source[span.start() as usize..span.end() as usize]
        })
        .collect::<Vec<_>>();
    assert_eq!(
        finding_sources,
        [
            "select(() => value)",
            "Advanced.createSelector(() => item)",
            "select(() => value)",
            "select?.(() => value)",
            "memo?.(() => value)",
            "effect(() => console.log(value))",
            "select(() => value)"
        ]
    );
    let fallback = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions {
            strict_guarantee: false,
            reactive_creation_control_flow_severity: fict_diagnostics::DiagnosticSeverity::Warning,
            ..HirBuildOptions::default()
        },
    );
    assert!(fallback.hir.is_some(), "{:?}", fallback.diagnostics);
    assert_eq!(
        fallback
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code.as_str() == "FICT-R004")
            .count(),
        7
    );
    assert!(fallback.diagnostics.iter().all(|diagnostic| {
        diagnostic.severity == fict_diagnostics::DiagnosticSeverity::Warning
    }));
}

#[test]
fn enforces_render_effect_control_flow_placement_by_import_identity() {
    let cases = [
        "import { createRenderEffect } from 'fict/advanced'; function Demo(ready) { if (ready) createRenderEffect(() => {}); }",
        "import { createRenderEffect as renderEffect } from 'fict/advanced'; function Demo(ready) { if (ready) renderEffect(() => {}); }",
        "import * as Advanced from 'fict/advanced'; function Demo(ready) { if (ready) Advanced.createRenderEffect(() => {}); }",
        "import { createRenderEffect } from '@fictjs/runtime/advanced'; function Demo(ready) { if (ready) createRenderEffect(() => {}); }",
        "import * as RuntimeAdvanced from '@fictjs/runtime/advanced'; function Demo(items) { for (const item of items) RuntimeAdvanced.createRenderEffect?.(() => item); }",
    ];

    for source in cases {
        let strict = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(strict.hir.is_none(), "{source}: {:?}", strict.diagnostics);
        let findings: Vec<_> = strict
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code.as_str() == "FICT-R004")
            .collect();
        assert_eq!(findings.len(), 1, "{source}: {:?}", strict.diagnostics);
        assert_eq!(
            findings[0].severity,
            fict_diagnostics::DiagnosticSeverity::Error,
            "{source}"
        );
    }

    let shadow = build_hir(
        "function Demo(ready) { const createRenderEffect = callback => callback(); if (ready) createRenderEffect(() => {}); }",
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(shadow.hir.is_some(), "{:?}", shadow.diagnostics);
    assert!(
        shadow
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code.as_str() != "FICT-R004")
    );

    let fallback = build_hir(
        cases[0],
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions {
            reactive_creation_control_flow_severity: fict_diagnostics::DiagnosticSeverity::Warning,
            ..HirBuildOptions::default()
        },
    );
    assert!(fallback.hir.is_some(), "{:?}", fallback.diagnostics);
    assert!(fallback.diagnostics.iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-R004"
            && diagnostic.severity == fict_diagnostics::DiagnosticSeverity::Warning
    }));
}
#[test]
fn enforces_namespace_and_member_hook_placement() {
    let cases = [
        (
            "import * as hooks from './hooks'; hooks.useCounter();",
            "FICT-PLACEMENT-HOOK-OWNER",
        ),
        (
            "import * as hooks from './hooks'; function App() { if (ready) hooks.useCounter(); return null; }",
            "FICT-PLACEMENT-HOOK-CONTROL",
        ),
        (
            "const api = { use_counter() {} }; function App() { if (ready) api['use_counter'](); return null; }",
            "FICT-PLACEMENT-HOOK-CONTROL",
        ),
    ];
    for (source, expected) in cases {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{source}");
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == expected)
        );
    }
    for source in [
        "import * as hooks from './hooks'; function App() { hooks.useCounter?.(); return null; }",
        "const api = { useCounter() {} }; api.useCounter();",
    ] {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(
            output.diagnostics.is_empty(),
            "{source}: {:?}",
            output.diagnostics
        );
    }
}
#[test]
fn diagnoses_binding_aware_reactive_writes_in_jsx_children() {
    let source = r#"
        import { $state, $store } from 'fict';
        function App(values) {
            let count = $state(0);
            let alias = count;
            const model = $store({ value: 0 });
            let local = 0;
            return <>
                {count++}
                {++alias}
                {count = count + 1}
                {count += 1}
                {(local = 1, count++, count)}
                {model.value++}
                {([count] = values, count)}
                {({ value: model.value } = { value: 1 }, model.value)}
                {() => count++}
                <button onClick={() => count++}>{local++}</button>
                <section>{<span>{count++}</span>}</section>
            </>;
        }
    "#;
    let strict = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(strict.hir.is_none());
    let findings = strict
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code.as_str() == "FICT-R007")
        .collect::<Vec<_>>();
    assert_eq!(findings.len(), 9, "{:?}", strict.diagnostics);
    assert!(findings.iter().all(|diagnostic| {
        diagnostic.severity == fict_diagnostics::DiagnosticSeverity::Error
            && diagnostic.guarantee_class == fict_diagnostics::GuaranteeClass::Fallback
            && diagnostic.primary_span.is_some()
    }));
    let finding_sources = findings
        .iter()
        .map(|diagnostic| {
            let span = diagnostic.primary_span.expect("JSX child span");
            &source[span.start() as usize..span.end() as usize]
        })
        .collect::<Vec<_>>();
    assert_eq!(
        finding_sources,
        [
            "{count++}",
            "{++alias}",
            "{count = count + 1}",
            "{count += 1}",
            "{(local = 1, count++, count)}",
            "{model.value++}",
            "{([count] = values, count)}",
            "{({ value: model.value } = { value: 1 }, model.value)}",
            "{count++}"
        ]
    );
    let fallback = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions {
            strict_guarantee: false,
            ..HirBuildOptions::default()
        },
    );
    assert!(fallback.hir.is_some(), "{:?}", fallback.diagnostics);
    assert_eq!(
        fallback
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code.as_str() == "FICT-R007")
            .count(),
        9
    );
    assert!(
        fallback
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code.as_str() == "FICT-R007")
            .all(|diagnostic| {
                diagnostic.severity == fict_diagnostics::DiagnosticSeverity::Warning
            })
    );
}
#[test]
fn diagnoses_only_intrinsic_jsx_spreads_once_per_element() {
    let source = r#"
        function Widget(props) {
            return <span>{props.title}</span>;
        }
        function App(domProps, svgProps, componentProps, UI) {
            return <>
                <div {...domProps} title="demo" {...domProps} />
                <svg:path {...svgProps} />
                <Widget {...componentProps} />
                <UI.Widget {...componentProps} />
            </>;
        }
    "#;
    let strict = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(strict.hir.is_none());
    let findings = strict
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code.as_str() == "FICT-J003")
        .collect::<Vec<_>>();
    assert_eq!(findings.len(), 2, "{:?}", strict.diagnostics);
    assert!(findings.iter().all(|diagnostic| {
        diagnostic.severity == fict_diagnostics::DiagnosticSeverity::Error
            && diagnostic.guarantee_class == fict_diagnostics::GuaranteeClass::Fallback
    }));
    let finding_sources = findings
        .iter()
        .map(|diagnostic| {
            let span = diagnostic.primary_span.expect("native spread span");
            &source[span.start() as usize..span.end() as usize]
        })
        .collect::<Vec<_>>();
    assert_eq!(finding_sources, ["{...domProps}", "{...svgProps}"]);
    let fallback = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions {
            strict_guarantee: false,
            ..HirBuildOptions::default()
        },
    );
    assert!(fallback.hir.is_some(), "{:?}", fallback.diagnostics);
    assert_eq!(
        fallback
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code.as_str() == "FICT-J003")
            .count(),
        2
    );
}
#[test]
fn diagnoses_shallow_inline_non_event_jsx_function_props() {
    let source = r#"
        function Panel({ label, ok, stable }) {
            return <>
                <Button renderLabel={() => label} />
                <Button renderLabel={function () { return label; }} />
                <Button renderLabel={ok ? () => label : null} />
                <Button renderLabel={ok && (() => label)} />
                <Button renderLabel={(0, () => label)} />
                <Button renderLabel={((() => label) as unknown)} />
                <Button renderLabel={stable} />
                <Button renderLabel={(() => label, stable)} />
                <Button config={{ render: () => label }} />
                <button onClick={() => label} ref={node => node} onclick={() => label} />
            </>;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::TypeScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(output.hir.is_some(), "{:?}", output.diagnostics);
    let findings = output
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code.as_str() == "FICT-X003")
        .collect::<Vec<_>>();
    assert_eq!(findings.len(), 7, "{:?}", output.diagnostics);
    assert!(findings.iter().all(|diagnostic| {
        diagnostic.severity == fict_diagnostics::DiagnosticSeverity::Warning
            && diagnostic.guarantee_class == fict_diagnostics::GuaranteeClass::Advisory
    }));
    let finding_sources = findings
        .iter()
        .map(|diagnostic| {
            let span = diagnostic.primary_span.expect("inline function prop span");
            &source[span.start() as usize..span.end() as usize]
        })
        .collect::<Vec<_>>();
    assert_eq!(
        finding_sources,
        [
            "renderLabel={() => label}",
            "renderLabel={function () { return label; }}",
            "renderLabel={ok ? () => label : null}",
            "renderLabel={ok && (() => label)}",
            "renderLabel={(0, () => label)}",
            "renderLabel={((() => label) as unknown)}",
            "onclick={() => label}"
        ]
    );
}
#[test]
fn retains_classes_with_exact_definition_and_initializer_timing() {
    let source = r#"
        function build(base, key, staticValue, instanceValue, methodValue) {
            class Example extends base() {
                [key()] = instanceValue();
                accessor current = instanceValue();
                static [key()] = staticValue();
                static accessor stable = staticValue();
                static { staticValue(); }
                [key()]() { return methodValue(); }
            }
            const Expression = class extends base() {
                field = instanceValue();
                static field = staticValue();
            };
            return [Example, Expression];
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::TypeScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.as_ref().expect("verified class HIR");
    let function = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "build")
        })
        .expect("build function");
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let authored = |instruction: &fict_hir::HirInstruction| {
        let span = instruction
            .origin
            .primary_span
            .expect("authored instruction");
        &source[span.start() as usize..span.end() as usize]
    };
    let fragment_kind =
        |fragment: fict_hir::SyntaxFragmentId| hir.syntax_fragments[fragment.as_usize()].kind;
    let class_instructions: Vec<_> = instructions
        .iter()
        .copied()
        .filter(|instruction| {
            matches!(
                instruction.kind,
                HirInstructionKind::SyntaxFragment { fragment, .. }
                    if fragment_kind(fragment) == SyntaxFragmentKind::Class
            )
        })
        .collect();
    assert_eq!(class_instructions.len(), 2);
    let declaration_class = class_instructions
        .iter()
        .copied()
        .find(|instruction| authored(instruction).contains("class Example"))
        .expect("class declaration fragment");
    let expression_class = class_instructions
        .iter()
        .copied()
        .find(|instruction| !authored(instruction).contains("class Example"))
        .expect("class expression fragment");
    let HirInstructionKind::SyntaxFragment {
        fragment: declaration_fragment,
        inputs: declaration_inputs,
    } = &declaration_class.kind
    else {
        unreachable!()
    };
    let HirInstructionKind::SyntaxFragment {
        fragment: expression_fragment,
        inputs: expression_inputs,
    } = &expression_class.kind
    else {
        unreachable!()
    };
    assert_eq!(
        output.syntax_fragments[declaration_fragment.as_usize()].source,
        authored(declaration_class)
    );
    assert_eq!(
        output.syntax_fragments[expression_fragment.as_usize()].source,
        authored(expression_class)
    );
    assert!(
        !hir.syntax_fragments[declaration_fragment.as_usize()]
            .summary
            .contains_decorators
    );
    assert!(
        !hir.syntax_fragments[expression_fragment.as_usize()]
            .summary
            .contains_decorators
    );
    let summary_names = |fragment: fict_hir::SyntaxFragmentId| {
        hir.syntax_fragments[fragment.as_usize()]
            .summary
            .referenced_bindings
            .iter()
            .map(|binding| hir.bindings[binding.as_usize()].display_name.as_str())
            .collect::<Vec<_>>()
    };
    let declaration_references = summary_names(*declaration_fragment);
    assert!(declaration_references.contains(&"base"));
    assert!(declaration_references.contains(&"key"));
    assert!(declaration_references.contains(&"staticValue"));
    assert!(!declaration_references.contains(&"instanceValue"));
    assert!(!declaration_references.contains(&"methodValue"));
    let expression_references = summary_names(*expression_fragment);
    assert!(expression_references.contains(&"base"));
    assert!(expression_references.contains(&"staticValue"));
    assert!(!expression_references.contains(&"instanceValue"));
    let local = |name: &str| {
        function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"))
    };
    assert!(instructions.iter().any(|instruction| {
        matches!(
            instruction.kind,
            HirInstructionKind::Declare {
                local: candidate,
                declaration_kind: DeclarationKind::Class,
                initializer: Some(initializer),
            } if candidate == local("Example").id
                && initializer == declaration_class.result.expect("class declaration value")
        )
    }));
    assert!(instructions.iter().any(|instruction| {
        matches!(
            instruction.kind,
            HirInstructionKind::Declare {
                local: candidate,
                declaration_kind: DeclarationKind::Const,
                initializer: Some(initializer),
            } if candidate == local("Expression").id
                && initializer == expression_class.result.expect("class expression value")
        )
    }));
    let calls = |source_text: &str| {
        instructions
            .iter()
            .copied()
            .filter(|instruction| {
                matches!(instruction.kind, HirInstructionKind::Call(_))
                    && authored(instruction) == source_text
            })
            .collect::<Vec<_>>()
    };
    for source_text in ["base()", "key()", "staticValue()"] {
        let matches = calls(source_text);
        assert!(!matches.is_empty(), "{source_text} calls");
        assert!(
            matches
                .iter()
                .all(|instruction| { instruction.semantics.evaluation == EvaluationMode::Eager })
        );
    }
    let instance_calls = calls("instanceValue()");
    assert_eq!(instance_calls.len(), 3);
    assert!(
        instance_calls
            .iter()
            .all(|instruction| { instruction.semantics.evaluation == EvaluationMode::Deferred })
    );
    for instance_call in instance_calls {
        let value = instance_call
            .result
            .expect("instance initializer call value");
        assert!(!declaration_inputs.contains(&value));
        assert!(!expression_inputs.contains(&value));
    }
    for class in &class_instructions {
        assert!(!instructions.iter().any(|instruction| {
            instruction.origin.primary_span == class.origin.primary_span
                && matches!(
                    instruction.kind,
                    HirInstructionKind::SyntaxFragment { fragment, .. }
                        if fragment_kind(fragment) == SyntaxFragmentKind::Expression
                )
        }));
    }
}
fn memo_side_effect_diagnostics(source: &str) -> Vec<fict_diagnostics::Diagnostic> {
    build_hir(
        source,
        options(OxcSourceLanguage::TypeScriptJsx),
        &HirBuildOptions {
            strict_guarantee: false,
            ..HirBuildOptions::default()
        },
    )
    .diagnostics
    .into_iter()
    .filter(|diagnostic| diagnostic.code.as_str() == "FICT-M003")
    .collect()
}
#[test]
fn diagnoses_eager_memo_side_effect_evaluation_shapes() {
    let callbacks = [
        "() => { count++; return count; }",
        "function () { fetch('/api'); return 1; }",
        "() => { fetch('/api'); return 1; }",
        "() => fetch?.('/api')",
        "() => console.log?.('side')",
        "() => items.push?.(1)",
        "() => JSON.stringify({ get value() { return 1; } })",
        "() => Array.from([1], value => value)",
        "() => String({ toString() { return 'x'; } })",
        "() => [fetch('/api')]",
        "() => [...fetch('/api')]",
        "() => ({ value: fetch('/api') })",
        "() => ({ [fetch('/api')]: 1 })",
        "() => ({ [fetch('/api')]() { return 1; } })",
        "() => ({ ...fetch('/api') })",
        "() => fetch('/api') || 1",
        "() => fetch('/api') + 1",
        "() => void fetch('/api')",
        "() => `${fetch('/api')}`",
        "() => tag`${fetch('/api')}`",
        "() => obj[fetch('/api')]",
        "() => obj?.[fetch('/api')]",
        "() => obj['method']()",
        "() => Math.max(fetch('/api'), 1)",
        "() => wrap(...[fetch('/api')])",
        "() => class { static value = fetch('/api'); }",
        "() => class extends fetch('/api') {}",
        "() => class { [fetch('/api')]() {} }",
        "() => class { static [fetch('/api')] = 1; }",
        "() => class { static { fetch('/api'); } }",
        "() => <div data-x={fetch('/api')} />",
        "() => <div>{fetch('/api')}</div>",
        "() => <div {...fetch('/api')} />",
        "() => <>{fetch('/api')}</>",
        "() => (() => { fetch('/api'); return 1; })()",
        "async () => { const value = await fetch('/api'); return value; }",
        "() => { const value = fetch('/api'); return value; }",
        "() => { const { value = fetch('/api') } = {}; return value; }",
        "() => { if (ok) fetch('/api'); return 1; }",
        "() => { for (const item of [1]) fetch('/api'); return 1; }",
        "() => { try { fetch('/api'); } catch {} return 1; }",
        "() => { throw error; }",
        "() => { delete obj.value; return 1; }",
        "() => new Date()",
        "(0, () => { fetch('/api'); return 1; })",
        "ok ? () => fetch('/api') : () => 1",
        "ok && (() => fetch('/api'))",
        "((() => fetch('/api')) as unknown)",
        "(() => fetch('/api')) satisfies (() => unknown)",
    ];
    for callback in callbacks {
        let source =
            format!("import {{ $memo }} from 'fict'; const value = $memo({callback}); void value;");
        let diagnostics = memo_side_effect_diagnostics(&source);
        assert_eq!(diagnostics.len(), 1, "{callback}: {diagnostics:?}");
        assert_eq!(
            diagnostics[0].severity,
            fict_diagnostics::DiagnosticSeverity::Warning,
            "{callback}"
        );
        assert_eq!(
            diagnostics[0].guarantee_class,
            fict_diagnostics::GuaranteeClass::Fallback,
            "{callback}"
        );
        let span = diagnostics[0].primary_span.expect("memo callback span");
        let callback_source = &source[span.start() as usize..span.end() as usize];
        assert!(
            callback_source.contains("=>") || callback_source.starts_with("function"),
            "{callback}: {span:?}"
        );
    }
}
#[test]
fn accepts_pure_and_lazy_memo_evaluation_shapes() {
    let callbacks = [
        "() => Math.abs(-1)",
        "function () { return Math.abs(-1); }",
        "() => maybe?.()",
        "() => JSON.parse('{\"value\":1}')",
        "() => JSON.stringify({ value: [1, 'x'] })",
        "() => Object.values({ value: 1 })",
        "() => Object.entries({ value: 1 })",
        "() => Array.from([1, 2])",
        "() => Array.isArray([])",
        "() => String('x')",
        "() => Number(1)",
        "() => parseInt('10')",
        "() => ({ run() { fetch('/api'); }, get value() { fetch('/api'); return 1; } })",
        "() => class { field = fetch('/api'); method() { fetch('/api'); } static method() { fetch('/api'); } get value() { fetch('/api'); return 1; } }",
        "() => <button onClick={() => fetch('/api')}>go</button>",
        "() => () => fetch('/api')",
        "() => { const later = () => fetch('/api'); return later; }",
        "() => { const value = 1; const { other = 2 } = {}; return value + other; }",
        "() => { if (ok) { const value = 1; } for (const item of [1]) { const copy = item; } return 1; }",
        "() => (() => 1)()",
        "() => wrap(1)",
    ];
    for callback in callbacks {
        let source =
            format!("import {{ $memo }} from 'fict'; const value = $memo({callback}); void value;");
        let diagnostics = memo_side_effect_diagnostics(&source);
        assert!(diagnostics.is_empty(), "{callback}: {diagnostics:?}");
    }
    let non_tail = "import { $memo } from 'fict'; const stable = () => 1; const value = $memo((() => fetch('/api'), stable));";
    assert!(memo_side_effect_diagnostics(non_tail).is_empty());
}
#[test]
fn resolves_memo_and_safe_global_bindings_before_side_effect_diagnostics() {
    let source = r#"
        import { $memo } from 'fict';
        import { createMemo as runtimeMemo } from '@fictjs/runtime';
        const JSON = { stringify(value: unknown) { return String(value); } };
        const Math = { max(left: number, right: number) { return left + right; } };
        const first = $memo(() => JSON.stringify({ value: 1 }));
        const second = $memo(() => Math.max(1, 2));
        const third = runtimeMemo(() => fetch('/api'));
        function shadow($memo: (callback: () => unknown) => unknown) {
            return $memo(() => fetch('/shadowed'));
        }
        void first; void second; void third; void shadow;
    "#;
    let diagnostics = memo_side_effect_diagnostics(source);
    assert_eq!(diagnostics.len(), 3, "{diagnostics:?}");
}
