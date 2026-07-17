use fict_compiler::{CorePassBudgets, CorePassOptions, run_core_passes};
use fict_compiler_oxc::{
    HirBuildOptions, OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, build_hir,
};
use fict_hir::{
    ContextValueKind, DeleteTarget, FunctionKind, HirInstructionKind, LiteralValue, MutationEffect,
    StructuredSourceKind,
};
use fict_metadata::{
    HookReturnInfo, MetadataResolutionStatus, ModuleReactiveMetadata, ReactiveExportKind,
    ResolvedMetadataInput,
};
use fict_reactivity::{
    BarrierKind, DependencyBase, DependencySegment, EscapeKind, ReactiveBindingKind, ShapeKind,
    ShapeSource, SsaDefinitionKind, SsaDefinitionLocation, StructuredConstructKind,
    StructuredLoopKind,
};

fn build_fixture() -> fict_hir::HirFile {
    let output = build_hir(
        r#"
            import { $state as state } from 'fict';
            export function App(props) {
                const count = state(props.initial);
                const doubled = count + count;
                return <button>{doubled}</button>;
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScriptJsx,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    output.hir.expect("verified frontend HIR")
}

#[test]
fn runs_complete_core_pipeline_and_materializes_region_ids() {
    let input = build_fixture();
    let output = run_core_passes(&input, CorePassOptions::default()).expect("core passes");

    assert_eq!(output.functions.len(), output.hir.functions.len());
    assert_eq!(
        output.stats.counters.get("functions").copied(),
        Some(output.hir.functions.len() as u64)
    );
    assert!(output.stats.stage_durations_ns.contains_key("verify-hir"));
    assert!(output.stats.stage_durations_ns.contains_key("ssa"));
    assert!(output.stats.stage_durations_ns.contains_key("regions"));
    assert!(output.stats.stage_durations_ns.contains_key("structurize"));
    for function in &output.functions {
        assert_eq!(
            output.hir.functions[function.function.as_usize()]
                .regions
                .len(),
            function.regions.regions.len()
        );
    }
    let app = output
        .hir
        .functions
        .iter()
        .find(|function| function.kind == FunctionKind::Component)
        .expect("component function");
    let doubled = app
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("doubled"))
        .expect("doubled local");
    assert!(
        output.functions[app.id.as_usize()]
            .scopes
            .bindings
            .iter()
            .any(|binding| {
                binding.name.local == doubled.id && binding.kind == ReactiveBindingKind::Derived
            }),
        "coercive derived expressions remain reactive while their barrier blocks optimization"
    );
    assert!(
        output.functions[app.id.as_usize()]
            .regions
            .regions
            .iter()
            .any(|region| region.has_jsx),
        "reactive JSX materialization must belong to an explicit region"
    );
}

#[test]
fn classifies_direct_references_to_derived_values_as_reactive_aliases() {
    let frontend = build_hir(
        r#"
            import { $state } from 'fict';
            export function Counter() {
                const count = $state(0);
                const active = count !== 0;
                const alias = active;
                return alias;
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified alias HIR"),
        CorePassOptions {
            optimize: false,
            ..CorePassOptions::default()
        },
    )
    .expect("core passes over derived alias");
    let function = output
        .hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                output.hir.bindings[binding.as_usize()].display_name == "Counter"
            })
        })
        .expect("Counter function");
    let analysis = &output.functions[function.id.as_usize()];
    let kinds: std::collections::BTreeMap<_, _> = analysis
        .scopes
        .bindings
        .iter()
        .filter_map(|binding| {
            function.locals[binding.name.local.as_usize()]
                .debug_name
                .as_deref()
                .map(|name| (name, binding.kind))
        })
        .collect();

    assert_eq!(kinds["count"], ReactiveBindingKind::State);
    assert_eq!(kinds["active"], ReactiveBindingKind::Derived);
    assert_eq!(kinds["alias"], ReactiveBindingKind::Alias);
}

#[test]
fn propagates_recursive_import_metadata_into_scopes_and_regions() {
    let frontend = build_hir(
        r#"
            import * as dep from './dep';
            export function App() {
                const derived = dep.state.value === 2;
                const plain = dep.plain === 2;
                return [derived, plain];
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions {
            resolved_metadata: vec![ResolvedMetadataInput {
                request: "./dep".into(),
                resolved_id: Some("/src/dep.ts".into()),
                status: MetadataResolutionStatus::Resolved,
                metadata: Some(ModuleReactiveMetadata {
                    exports: [("state".into(), ReactiveExportKind::Store)]
                        .into_iter()
                        .collect(),
                    ..ModuleReactiveMetadata::new()
                }),
                fingerprint: "sha256:dep".into(),
            }],
            ..HirBuildOptions::default()
        },
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified namespace metadata HIR"),
        CorePassOptions {
            optimize: false,
            ..CorePassOptions::default()
        },
    )
    .expect("core passes over namespace metadata");
    let function = output
        .hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                output.hir.bindings[binding.as_usize()].display_name == "App"
            })
        })
        .expect("App function");
    let analysis = &output.functions[function.id.as_usize()];
    let derived = function
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("derived"))
        .expect("derived local");
    let plain = function
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("plain"))
        .expect("plain local");
    let derived_binding = analysis
        .scopes
        .bindings
        .iter()
        .find(|binding| binding.name.local == derived.id)
        .expect("derived namespace binding");

    assert_eq!(derived_binding.kind, ReactiveBindingKind::Derived);
    assert!(derived_binding.dependencies.iter().any(|path| {
        path.segments.as_slice()
            == [
                DependencySegment::Static {
                    name: "state".into(),
                    optional: false,
                },
                DependencySegment::Static {
                    name: "value".into(),
                    optional: false,
                },
            ]
    }));
    assert!(
        analysis
            .scopes
            .bindings
            .iter()
            .all(|binding| binding.name.local != plain.id)
    );
    assert!(analysis.regions.regions.iter().any(|region| {
        region.inputs.iter().any(|path| {
            path.segments.as_slice()
                == [
                    DependencySegment::Static {
                        name: "state".into(),
                        optional: false,
                    },
                    DependencySegment::Static {
                        name: "value".into(),
                        optional: false,
                    },
                ]
        })
    }));
    assert!(analysis.regions.regions.iter().all(|region| {
        region.inputs.iter().all(|path| {
            !path.segments.iter().any(|segment| {
                matches!(segment, DependencySegment::Static { name, .. } if name == "plain")
            })
        })
    }));
}

#[test]
fn classifies_direct_imported_hook_accessors_in_reactive_scopes() {
    let frontend = build_hir(
        r#"
            import { useCount, useDouble, useStore } from './hooks';
            export function App() {
                const count = useCount();
                const doubled = useDouble();
                const state = useStore();
                const derived = count === doubled;
                return [derived, state.value];
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions {
            resolved_metadata: vec![ResolvedMetadataInput {
                request: "./hooks".into(),
                resolved_id: Some("/src/hooks.ts".into()),
                status: MetadataResolutionStatus::Resolved,
                metadata: Some(ModuleReactiveMetadata {
                    hooks: [
                        ("useCount", ReactiveExportKind::Signal),
                        ("useDouble", ReactiveExportKind::Memo),
                        ("useStore", ReactiveExportKind::Store),
                    ]
                    .into_iter()
                    .map(|(name, kind)| {
                        (
                            name.into(),
                            HookReturnInfo {
                                direct_accessor: Some(kind),
                                ..HookReturnInfo::default()
                            },
                        )
                    })
                    .collect(),
                    ..ModuleReactiveMetadata::new()
                }),
                fingerprint: "sha256:hooks".into(),
            }],
            ..HirBuildOptions::default()
        },
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified imported hook HIR"),
        CorePassOptions {
            optimize: false,
            ..CorePassOptions::default()
        },
    )
    .expect("core passes over imported hook accessors");
    let function = output
        .hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                output.hir.bindings[binding.as_usize()].display_name == "App"
            })
        })
        .expect("App function");
    let analysis = &output.functions[function.id.as_usize()];
    let kinds: std::collections::BTreeMap<_, _> = analysis
        .scopes
        .bindings
        .iter()
        .filter_map(|binding| {
            function.locals[binding.name.local.as_usize()]
                .debug_name
                .as_deref()
                .map(|name| (name, binding.kind))
        })
        .collect();

    assert_eq!(kinds["count"], ReactiveBindingKind::State);
    assert_eq!(kinds["doubled"], ReactiveBindingKind::Memo);
    assert_eq!(kinds["state"], ReactiveBindingKind::Store);
    assert_eq!(kinds["derived"], ReactiveBindingKind::Derived);
}

#[test]
fn propagates_structured_imported_hook_members_into_scopes_and_regions() {
    let frontend = build_hir(
        r#"
            import { useCounter } from './hooks';
            export function App() {
                const api = useCounter();
                const derived = api.count === 1;
                const dynamic = api[globalThis.key] === 1;
                const reader = () => {
                    const nestedDerived = api.count === 2;
                    return nestedDerived;
                };
                return [derived, dynamic, reader];
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions {
            resolved_metadata: vec![ResolvedMetadataInput {
                request: "./hooks".into(),
                resolved_id: Some("/src/hooks.ts".into()),
                status: MetadataResolutionStatus::Resolved,
                metadata: Some(ModuleReactiveMetadata {
                    hooks: [(
                        "useCounter".into(),
                        HookReturnInfo {
                            object_props: [("count".into(), ReactiveExportKind::Signal)]
                                .into_iter()
                                .collect(),
                            ..HookReturnInfo::default()
                        },
                    )]
                    .into_iter()
                    .collect(),
                    ..ModuleReactiveMetadata::new()
                }),
                fingerprint: "sha256:structured-hooks".into(),
            }],
            ..HirBuildOptions::default()
        },
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified structured hook HIR"),
        CorePassOptions {
            optimize: false,
            ..CorePassOptions::default()
        },
    )
    .expect("core passes over structured imported hook members");
    let function = output
        .hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                output.hir.bindings[binding.as_usize()].display_name == "App"
            })
        })
        .expect("App function");
    let analysis = &output.functions[function.id.as_usize()];
    let derived = function
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("derived"))
        .expect("derived local");
    let dynamic = function
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("dynamic"))
        .expect("dynamic local");
    let derived_binding = analysis
        .scopes
        .bindings
        .iter()
        .find(|binding| binding.name.local == derived.id)
        .expect("derived structured hook binding");

    assert_eq!(derived_binding.kind, ReactiveBindingKind::Derived);
    assert!(derived_binding.dependencies.iter().any(|path| {
        path.segments.first()
            == Some(&DependencySegment::Static {
                name: "count".into(),
                optional: false,
            })
    }));
    assert!(
        analysis
            .scopes
            .bindings
            .iter()
            .all(|binding| binding.name.local != dynamic.id)
    );
    assert!(analysis.regions.regions.iter().any(|region| {
        region.inputs.iter().any(|path| {
            path.segments.first()
                == Some(&DependencySegment::Static {
                    name: "count".into(),
                    optional: false,
                })
        })
    }));

    let nested = output
        .hir
        .functions
        .iter()
        .find(|function| {
            function
                .locals
                .iter()
                .any(|local| local.debug_name.as_deref() == Some("nestedDerived"))
        })
        .expect("capturing reader function");
    let nested_derived = nested
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("nestedDerived"))
        .expect("nested derived local");
    let nested_analysis = &output.functions[nested.id.as_usize()];
    let nested_binding = nested_analysis
        .scopes
        .bindings
        .iter()
        .find(|binding| binding.name.local == nested_derived.id)
        .expect("captured hook member derived binding");
    assert_eq!(nested_binding.kind, ReactiveBindingKind::Derived);
    assert!(nested_binding.dependencies.iter().any(|path| {
        path.segments.first()
            == Some(&DependencySegment::Static {
                name: "count".into(),
                optional: false,
            })
    }));
    assert!(nested_analysis.regions.regions.iter().any(|region| {
        region.inputs.iter().any(|path| {
            path.segments.first()
                == Some(&DependencySegment::Static {
                    name: "count".into(),
                    optional: false,
                })
        })
    }));
}

#[test]
fn propagates_namespace_hook_members_into_scopes_and_regions() {
    let frontend = build_hir(
        r#"
            import * as hooks from './hooks';
            export function App() {
                const api = hooks.useCounter();
                const derived = api.count === 1;
                const reader = () => {
                    const nestedDerived = api.count === 2;
                    return nestedDerived;
                };
                return [derived, reader];
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions {
            resolved_metadata: vec![ResolvedMetadataInput {
                request: "./hooks".into(),
                resolved_id: Some("/src/hooks.ts".into()),
                status: MetadataResolutionStatus::Resolved,
                metadata: Some(ModuleReactiveMetadata {
                    hooks: [(
                        "useCounter".into(),
                        HookReturnInfo {
                            object_props: [("count".into(), ReactiveExportKind::Signal)]
                                .into_iter()
                                .collect(),
                            ..HookReturnInfo::default()
                        },
                    )]
                    .into_iter()
                    .collect(),
                    ..ModuleReactiveMetadata::new()
                }),
                fingerprint: "sha256:namespace-hooks".into(),
            }],
            ..HirBuildOptions::default()
        },
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified namespace hook HIR"),
        CorePassOptions {
            optimize: false,
            ..CorePassOptions::default()
        },
    )
    .expect("core passes over namespace hook members");
    let assert_count_dependency = |function: &fict_hir::HirFunction, local_name: &str| {
        let local = function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(local_name))
            .unwrap_or_else(|| panic!("{local_name} local"));
        let analysis = &output.functions[function.id.as_usize()];
        let binding = analysis
            .scopes
            .bindings
            .iter()
            .find(|binding| binding.name.local == local.id)
            .unwrap_or_else(|| panic!("{local_name} reactive binding"));
        assert_eq!(binding.kind, ReactiveBindingKind::Derived);
        assert!(binding.dependencies.iter().any(|path| {
            path.segments.first()
                == Some(&DependencySegment::Static {
                    name: "count".into(),
                    optional: false,
                })
        }));
        assert!(analysis.regions.regions.iter().any(|region| {
            region.inputs.iter().any(|path| {
                path.segments.first()
                    == Some(&DependencySegment::Static {
                        name: "count".into(),
                        optional: false,
                    })
            })
        }));
    };
    let app = output
        .hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                output.hir.bindings[binding.as_usize()].display_name == "App"
            })
        })
        .expect("App function");
    assert_count_dependency(app, "derived");
    let reader = output
        .hir
        .functions
        .iter()
        .find(|function| {
            function
                .locals
                .iter()
                .any(|local| local.debug_name.as_deref() == Some("nestedDerived"))
        })
        .expect("capturing reader function");
    assert_count_dependency(reader, "nestedDerived");
}

#[test]
fn keeps_dynamic_reads_closed_and_only_treats_the_first_component_parameter_as_props() {
    let frontend = build_hir(
        r#"
            import { createSignal } from 'fict/advanced';
            export function Lookup(props, key) {
                const marker = createSignal(0);
                const model = { a: 1, b: 2 };
                return props[key] + model[key] + marker();
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions {
            strict_guarantee: false,
            ..HirBuildOptions::default()
        },
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified dynamic shape HIR"),
        CorePassOptions {
            optimize: false,
            ..CorePassOptions::default()
        },
    )
    .expect("core passes over dynamic shape reads");
    let function = output
        .hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                output.hir.bindings[binding.as_usize()].display_name == "Lookup"
            })
        })
        .expect("Lookup function");
    let analysis = &output.functions[function.id.as_usize()];
    let final_shape = |name: &str| {
        let local = function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"));
        &analysis
            .shapes
            .shapes
            .iter()
            .filter(|fact| fact.name.local == local.id)
            .max_by_key(|fact| fact.name.version.index())
            .unwrap_or_else(|| panic!("{name} shape"))
            .shape
    };

    assert_eq!(final_shape("props").kind, ShapeKind::Object);
    assert_ne!(final_shape("key").kind, ShapeKind::Object);
    assert!(final_shape("model").dynamic_access);
    assert!(final_shape("model").complete_key_set);
}

#[test]
fn optimized_hir_keeps_method_call_references_aligned_with_callee_reads() {
    let frontend = build_hir(
        r#"
            export function invoke(object, key, argument) {
                const first = argument + 1;
                const second = argument + 1;
                return object[key](second + first);
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified method-call HIR"),
        CorePassOptions::default(),
    )
    .expect("optimized core passes over method call");
    let function = output
        .hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                output.hir.bindings[binding.as_usize()].display_name == "invoke"
            })
        })
        .expect("invoke function");
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let call = instructions
        .iter()
        .find_map(|instruction| match &instruction.kind {
            HirInstructionKind::Call(call) if call.callee_reference.is_some() => Some(call),
            _ => None,
        })
        .expect("method call");
    let reference = call
        .callee_reference
        .as_ref()
        .expect("method-call reference");
    assert!(instructions.iter().any(|instruction| {
        instruction.result == Some(call.callee)
            && matches!(
                &instruction.kind,
                HirInstructionKind::Read { place } if place == reference
            )
    }));
    assert!(
        output
            .stats
            .stage_durations_ns
            .contains_key("verify-optimized-hir")
    );
}

#[test]
fn rejects_hir_that_exceeds_an_explicit_resource_budget() {
    let input = build_fixture();
    let diagnostics = run_core_passes(
        &input,
        CorePassOptions {
            optimize: false,
            budgets: CorePassBudgets {
                max_blocks: 0,
                ..CorePassBudgets::default()
            },
        },
    )
    .expect_err("zero block budget");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-PASS-BUDGET")
    );
}

#[test]
fn sequence_results_depend_on_and_inherit_shape_from_only_the_final_value() {
    let frontend = build_hir(
        r#"
            export function evaluate(preceding, finalValue, touch) {
                const alias = (preceding, finalValue);
                const shaped = (touch(), [1, 2]);
                return [alias, shaped];
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified sequence HIR"),
        CorePassOptions {
            optimize: false,
            ..CorePassOptions::default()
        },
    )
    .expect("core passes over sequences");
    let function = output
        .hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                output.hir.bindings[binding.as_usize()].display_name == "evaluate"
            })
        })
        .expect("evaluate function");
    let analysis = &output.functions[function.id.as_usize()];
    let local = |name: &str| {
        function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"))
    };
    let initializer = |name: &str| {
        let local = local(name);
        function
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .find_map(|instruction| match instruction.kind {
                fict_hir::HirInstructionKind::Declare {
                    local: candidate,
                    initializer,
                    ..
                } if candidate == local.id => initializer,
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name} initializer"))
    };

    let alias_value = initializer("alias");
    let alias_dependencies = &analysis.dependencies.value_dependencies[alias_value.as_usize()];
    assert_eq!(alias_dependencies.len(), 1);
    assert!(matches!(
        alias_dependencies[0].base,
        DependencyBase::Ssa(name) if name.local == local("finalValue").id
    ));

    let shaped = local("shaped");
    let shaped_definition = analysis
        .ssa
        .definitions
        .iter()
        .find(|definition| {
            definition.name.local == shaped.id && definition.kind == SsaDefinitionKind::Declare
        })
        .expect("shaped declaration definition");
    let shaped_shape = analysis
        .shapes
        .shapes
        .iter()
        .find(|shape| shape.name == shaped_definition.name)
        .expect("shaped sequence shape");
    assert_eq!(shaped_shape.shape.kind, ShapeKind::Array);
    assert_eq!(shaped_shape.shape.array_length, Some(2));
}

#[test]
fn plain_assignment_results_inherit_their_rhs_shape() {
    let frontend = build_hir(
        r#"
            export function assign(target) {
                const object = { value: 1 };
                const assigned = (target = object);
                return assigned;
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified assignment HIR"),
        CorePassOptions {
            optimize: false,
            ..CorePassOptions::default()
        },
    )
    .expect("core passes over assignment result");
    let function = output
        .hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                output.hir.bindings[binding.as_usize()].display_name == "assign"
            })
        })
        .expect("assign function");
    let assigned = function
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("assigned"))
        .expect("assigned local");
    let object = function
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("object"))
        .expect("object local");
    let target = function
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("target"))
        .expect("target local");
    let analysis = &output.functions[function.id.as_usize()];
    let definition = analysis
        .ssa
        .definitions
        .iter()
        .find(|definition| {
            definition.name.local == assigned.id && definition.kind == SsaDefinitionKind::Declare
        })
        .expect("assigned declaration definition");
    let shape = analysis
        .shapes
        .shapes
        .iter()
        .find(|shape| shape.name == definition.name)
        .expect("assigned object shape");
    assert_eq!(shape.shape.kind, ShapeKind::Object);
    let object_definition = analysis
        .ssa
        .definitions
        .iter()
        .find(|definition| {
            definition.name.local == object.id && definition.kind == SsaDefinitionKind::Declare
        })
        .expect("object declaration definition");
    assert_eq!(
        shape.shape.source,
        ShapeSource::Alias(object_definition.name)
    );
    let target_definition = analysis
        .ssa
        .definitions
        .iter()
        .find(|definition| {
            definition.name.local == target.id && definition.kind == SsaDefinitionKind::Write
        })
        .expect("target write definition");
    let alias_class = analysis
        .aliases
        .classes
        .iter()
        .find(|class| class.members.contains(&definition.name))
        .expect("assigned alias class");
    assert!(alias_class.members.contains(&object_definition.name));
    assert!(alias_class.members.contains(&target_definition.name));
}

#[test]
fn template_results_depend_on_every_substitution_and_remain_primitive() {
    let frontend = build_hir(
        r#"
            export function format(first, second) {
                const text = `head ${first} middle ${second} tail`;
                return text;
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified template HIR"),
        CorePassOptions {
            optimize: false,
            ..CorePassOptions::default()
        },
    )
    .expect("core passes over templates");
    let function = output
        .hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                output.hir.bindings[binding.as_usize()].display_name == "format"
            })
        })
        .expect("format function");
    let analysis = &output.functions[function.id.as_usize()];
    let local = |name: &str| {
        function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"))
    };
    let text = local("text");
    let text_value = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find_map(|instruction| match instruction.kind {
            fict_hir::HirInstructionKind::Declare {
                local, initializer, ..
            } if local == text.id => initializer,
            _ => None,
        })
        .expect("text initializer");
    let dependencies = &analysis.dependencies.value_dependencies[text_value.as_usize()];
    assert_eq!(dependencies.len(), 2);
    let dependency_locals: std::collections::BTreeSet<_> = dependencies
        .iter()
        .filter_map(|dependency| match dependency.base {
            DependencyBase::Ssa(name) => Some(name.local),
            DependencyBase::Global(_) | DependencyBase::Value(_) => None,
        })
        .collect();
    assert_eq!(
        dependency_locals,
        [local("first").id, local("second").id]
            .into_iter()
            .collect()
    );

    let definition = analysis
        .ssa
        .definitions
        .iter()
        .find(|definition| {
            definition.name.local == text.id && definition.kind == SsaDefinitionKind::Declare
        })
        .expect("text declaration definition");
    let shape = analysis
        .shapes
        .shapes
        .iter()
        .find(|shape| shape.name == definition.name)
        .expect("template result shape");
    assert_eq!(shape.shape.kind, ShapeKind::Primitive);
    assert!(matches!(
        shape.shape.source,
        ShapeSource::TemplateLiteral(value) if value == text_value
    ));
}

#[test]
fn unresolved_typeof_has_no_false_value_dependency_and_a_primitive_shape() {
    let frontend = build_hir(
        r#"
            export function inspect() {
                const kind = typeof ambientValue;
                return kind;
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified unresolved typeof HIR"),
        CorePassOptions {
            optimize: false,
            ..CorePassOptions::default()
        },
    )
    .expect("core passes over unresolved typeof");
    let function = output
        .hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                output.hir.bindings[binding.as_usize()].display_name == "inspect"
            })
        })
        .expect("inspect function");
    let analysis = &output.functions[function.id.as_usize()];
    let local = function
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("kind"))
        .expect("kind local");
    let value = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find_map(|instruction| match instruction.kind {
            fict_hir::HirInstructionKind::Declare {
                local: candidate,
                initializer,
                ..
            } if candidate == local.id => initializer,
            _ => None,
        })
        .expect("kind initializer");
    assert!(analysis.dependencies.value_dependencies[value.as_usize()].is_empty());

    let definition = analysis
        .ssa
        .definitions
        .iter()
        .find(|definition| {
            definition.name.local == local.id && definition.kind == SsaDefinitionKind::Declare
        })
        .expect("kind declaration definition");
    let shape = analysis
        .shapes
        .shapes
        .iter()
        .find(|shape| shape.name == definition.name)
        .expect("typeof result shape");
    assert_eq!(shape.shape.kind, ShapeKind::Primitive);
    assert!(matches!(
        shape.shape.source,
        ShapeSource::UnresolvedTypeof(source) if source == value
    ));
}

#[test]
fn context_values_have_no_false_local_dependencies_and_keep_runtime_shapes() {
    let frontend = build_hir(
        r#"
        export function inspect() {
            const receiver = this;
            const args = arguments;
            const target = new.target;
            const metadata = import.meta;
            return [receiver, args, target, metadata];
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified context-value HIR"),
        CorePassOptions {
            optimize: false,
            ..CorePassOptions::default()
        },
    )
    .expect("core passes over context values");
    let function = output
        .hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                output.hir.bindings[binding.as_usize()].display_name == "inspect"
            })
        })
        .expect("inspect function");
    let analysis = &output.functions[function.id.as_usize()];

    for (name, kind, expected_shape) in [
        ("receiver", ContextValueKind::This, ShapeKind::Unknown),
        ("args", ContextValueKind::Arguments, ShapeKind::Object),
        ("target", ContextValueKind::NewTarget, ShapeKind::Unknown),
        ("metadata", ContextValueKind::ImportMeta, ShapeKind::Object),
    ] {
        let local = function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"));
        let value = function
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .find_map(|instruction| match instruction.kind {
                fict_hir::HirInstructionKind::Declare {
                    local: candidate,
                    initializer,
                    ..
                } if candidate == local.id => initializer,
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name} initializer"));
        assert!(analysis.dependencies.value_dependencies[value.as_usize()].is_empty());

        let definition = analysis
            .ssa
            .definitions
            .iter()
            .find(|definition| {
                definition.name.local == local.id && definition.kind == SsaDefinitionKind::Declare
            })
            .unwrap_or_else(|| panic!("{name} declaration definition"));
        let shape = analysis
            .shapes
            .shapes
            .iter()
            .find(|shape| shape.name == definition.name)
            .unwrap_or_else(|| panic!("{name} context shape"));
        assert_eq!(shape.shape.kind, expected_shape);
        assert!(matches!(
            shape.shape.source,
            ShapeSource::ContextValue(source, candidate)
                if source == value && candidate == kind
        ));
    }
}

#[test]
fn projected_delete_tracks_its_reference_write_dependency_and_boolean_shape() {
    let frontend = build_hir(
        r#"
            export function remove(obj, key) {
                const removed = delete obj[key];
                return removed;
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified projected-delete HIR"),
        CorePassOptions {
            optimize: false,
            ..CorePassOptions::default()
        },
    )
    .expect("core passes over projected delete");
    let function = output
        .hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                output.hir.bindings[binding.as_usize()].display_name == "remove"
            })
        })
        .expect("remove function");
    let analysis = &output.functions[function.id.as_usize()];
    let local = |name: &str| {
        function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"))
    };
    let removed = local("removed");
    let removed_value = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find_map(|instruction| match instruction.kind {
            HirInstructionKind::Declare {
                local, initializer, ..
            } if local == removed.id => initializer,
            _ => None,
        })
        .expect("removed initializer");
    let delete_instruction = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find(|instruction| instruction.result == Some(removed_value))
        .expect("delete instruction");
    let DeleteTarget::Place(place) = (match &delete_instruction.kind {
        HirInstructionKind::Delete { target } => target,
        other => panic!("expected delete instruction, found {other:?}"),
    }) else {
        panic!("expected projected delete place")
    };
    assert_eq!(place.projections.len(), 1);
    assert_eq!(
        delete_instruction.semantics.mutation,
        MutationEffect::Observable
    );

    let dependencies = &analysis.dependencies.value_dependencies[removed_value.as_usize()];
    assert_eq!(dependencies.len(), 1);
    let path = &dependencies[0];
    assert!(matches!(
        path.base,
        DependencyBase::Ssa(name) if name.local == local("obj").id
    ));
    assert!(matches!(
        path.segments.as_slice(),
        [DependencySegment::Dynamic {
            optional: false,
            ..
        }]
    ));
    assert!(
        analysis
            .dependencies
            .writes
            .iter()
            .any(|write| { write.path == *path && write.mutation == MutationEffect::Observable })
    );

    let definition = analysis
        .ssa
        .definitions
        .iter()
        .find(|definition| {
            definition.name.local == removed.id && definition.kind == SsaDefinitionKind::Declare
        })
        .expect("removed declaration definition");
    let shape = analysis
        .shapes
        .shapes
        .iter()
        .find(|shape| shape.name == definition.name)
        .expect("delete result shape");
    assert_eq!(shape.shape.kind, ShapeKind::Primitive);
    assert!(matches!(
        shape.shape.source,
        ShapeSource::Delete(value) if value == removed_value
    ));
}

#[test]
fn host_places_flow_through_dependencies_without_creating_lexical_ssa_storage() {
    let source = r#"
        function mutate(value, key) {
            globalSlot = value;
            hostObject[key] = value;
            const read = hostObject.fixed;
            return read;
        }
    "#;
    let frontend = build_hir(
        source,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Script,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified host-place HIR"),
        CorePassOptions {
            optimize: false,
            ..CorePassOptions::default()
        },
    )
    .expect("core passes over host places");
    let global_slot = output
        .hir
        .globals
        .iter()
        .find(|global| global.name == "globalSlot")
        .expect("global slot")
        .id;
    let host_object = output
        .hir
        .globals
        .iter()
        .find(|global| global.name == "hostObject")
        .expect("host object")
        .id;
    let function = output
        .hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                output.hir.bindings[binding.as_usize()].display_name == "mutate"
            })
        })
        .expect("mutate function");
    let analysis = &output.functions[function.id.as_usize()];
    let local = |name: &str| {
        function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"))
    };

    let direct_write = analysis
        .dependencies
        .writes
        .iter()
        .find(|write| {
            write.path.base == DependencyBase::Global(global_slot) && write.path.segments.is_empty()
        })
        .expect("direct global write dependency");
    assert_eq!(direct_write.mutation, MutationEffect::Observable);
    assert!(!analysis.ssa.definitions.iter().any(|definition| {
        definition.location
            == SsaDefinitionLocation::Instruction {
                block: direct_write.location.block,
                instruction: direct_write.location.instruction,
            }
            && matches!(
                definition.kind,
                SsaDefinitionKind::Write | SsaDefinitionKind::ReadWrite
            )
    }));

    let projected_write = analysis
        .dependencies
        .writes
        .iter()
        .find(|write| write.path.base == DependencyBase::Global(host_object))
        .expect("projected host write dependency");
    assert_eq!(projected_write.mutation, MutationEffect::Observable);
    assert!(matches!(
        projected_write.path.segments.as_slice(),
        [DependencySegment::Dynamic {
            optional: false,
            ..
        }]
    ));
    assert!(analysis.dependencies.escapes.iter().any(|escape| {
        escape.kind == EscapeKind::ObservableWrite
            && matches!(
                escape.path.base,
                DependencyBase::Ssa(name) if name.local == local("value").id
            )
    }));

    let host_read = analysis
        .dependencies
        .reads
        .iter()
        .find(|read| read.path.base == DependencyBase::Global(host_object))
        .expect("host member read dependency");
    assert!(matches!(
        host_read.path.segments.as_slice(),
        [DependencySegment::Static {
            name,
            optional: false,
        }] if name == "fixed"
    ));
    let read_value = function.blocks[host_read.location.block.as_usize()].instructions
        [host_read.location.instruction as usize]
        .result
        .expect("host read result");
    assert!(
        analysis.dependencies.value_dependencies[read_value.as_usize()]
            .iter()
            .any(|path| path == &host_read.path)
    );

    let global_shape_accesses: Vec<_> = analysis
        .shapes
        .property_accesses
        .iter()
        .filter(|access| access.path.base == DependencyBase::Global(host_object))
        .collect();
    assert_eq!(global_shape_accesses.len(), 2);
    assert!(
        analysis
            .shapes
            .shapes
            .iter()
            .all(|shape| shape.name.local.as_usize() < function.locals.len())
    );
}

#[test]
fn bare_host_reads_are_external_dependencies_and_conservative_barriers() {
    let frontend = build_hir(
        r#"
            function inspect(value) {
                const direct = hostValue;
                return hostCall(direct, value);
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Script,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified host-read HIR"),
        CorePassOptions {
            optimize: false,
            ..CorePassOptions::default()
        },
    )
    .expect("core passes over bare host reads");
    let global = |name: &str| {
        output
            .hir
            .globals
            .iter()
            .find(|global| global.name == name)
            .unwrap_or_else(|| panic!("{name} global"))
            .id
    };
    let host_value = global("hostValue");
    let host_call = global("hostCall");
    let function = output
        .hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                output.hir.bindings[binding.as_usize()].display_name == "inspect"
            })
        })
        .expect("inspect function");
    let analysis = &output.functions[function.id.as_usize()];
    let local = |name: &str| {
        function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"))
    };
    let host_reads: Vec<_> = analysis
        .dependencies
        .reads
        .iter()
        .filter(|read| matches!(read.path.base, DependencyBase::Global(_)))
        .collect();
    assert_eq!(host_reads.len(), 2);
    assert_eq!(
        host_reads
            .iter()
            .map(|read| read.path.base)
            .collect::<Vec<_>>(),
        [
            DependencyBase::Global(host_value),
            DependencyBase::Global(host_call),
        ]
    );
    assert!(host_reads.iter().all(|read| read.path.segments.is_empty()));
    for read in &host_reads {
        let instruction = &function.blocks[read.location.block.as_usize()].instructions
            [read.location.instruction as usize];
        let result = instruction.result.expect("host read result");
        assert_eq!(
            analysis.dependencies.value_dependencies[result.as_usize()].as_slice(),
            std::slice::from_ref(&read.path)
        );
        let barrier = analysis
            .dependencies
            .barriers
            .iter()
            .find(|barrier| barrier.location == read.location)
            .expect("host read barrier");
        assert_eq!(
            barrier.kinds,
            [
                BarrierKind::UnknownMutation,
                BarrierKind::MayThrow,
                BarrierKind::UnknownPurity,
            ]
        );
        assert!(!analysis.ssa.definitions.iter().any(|definition| {
            definition.location
                == SsaDefinitionLocation::Instruction {
                    block: read.location.block,
                    instruction: read.location.instruction,
                }
        }));
    }

    assert!(analysis.dependencies.escapes.iter().any(|escape| {
        escape.kind == EscapeKind::UnknownCall
            && matches!(
                escape.path.base,
                DependencyBase::Ssa(name) if name.local == local("direct").id
            )
    }));
    assert!(analysis.dependencies.escapes.iter().any(|escape| {
        escape.kind == EscapeKind::UnknownCall
            && matches!(
                escape.path.base,
                DependencyBase::Ssa(name) if name.local == local("value").id
            )
    }));
    let direct_definition = analysis
        .ssa
        .definitions
        .iter()
        .find(|definition| {
            definition.name.local == local("direct").id
                && definition.kind == SsaDefinitionKind::Declare
        })
        .expect("direct declaration definition");
    let direct_shape = analysis
        .shapes
        .shapes
        .iter()
        .find(|shape| shape.name == direct_definition.name)
        .expect("direct host value shape");
    assert_eq!(direct_shape.shape.kind, ShapeKind::Unknown);
    assert_eq!(direct_shape.shape.source, ShapeSource::UnknownOperation);
}

#[test]
fn optimizer_folds_non_reference_and_local_delete_results() {
    let frontend = build_hir(
        r#"
            function fold(local) {
                const valueResult = delete 1;
                const localResult = delete local;
                return [valueResult, localResult];
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Script,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified foldable-delete HIR"),
        CorePassOptions::default(),
    )
    .expect("optimized core passes over foldable deletes");
    let function = output
        .hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                output.hir.bindings[binding.as_usize()].display_name == "fold"
            })
        })
        .expect("fold function");
    let initializer_literal = |name: &str| {
        let local = function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"));
        let initializer = function
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .find_map(|instruction| match instruction.kind {
                HirInstructionKind::Declare {
                    local: candidate,
                    initializer,
                    ..
                } if candidate == local.id => initializer,
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name} initializer"));
        function
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .find_map(|instruction| {
                (instruction.result == Some(initializer)).then_some(&instruction.kind)
            })
            .unwrap_or_else(|| panic!("{name} initializer instruction"))
    };
    assert!(matches!(
        initializer_literal("valueResult"),
        HirInstructionKind::Literal(LiteralValue::Boolean(true))
    ));
    assert!(matches!(
        initializer_literal("localResult"),
        HirInstructionKind::Literal(LiteralValue::Boolean(false))
    ));
}

#[test]
fn tagged_templates_track_tag_substitutions_and_unknown_call_escapes() {
    let frontend = build_hir(
        r#"
            export function render(tag, first, second) {
                const result = tag`head ${first} middle ${second} tail`;
                return result;
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified tagged-template HIR"),
        CorePassOptions {
            optimize: false,
            ..CorePassOptions::default()
        },
    )
    .expect("core passes over tagged templates");
    let function = output
        .hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                output.hir.bindings[binding.as_usize()].display_name == "render"
            })
        })
        .expect("render function");
    let analysis = &output.functions[function.id.as_usize()];
    let local = |name: &str| {
        function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"))
    };
    let result = local("result");
    let result_value = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find_map(|instruction| match instruction.kind {
            fict_hir::HirInstructionKind::Declare {
                local, initializer, ..
            } if local == result.id => initializer,
            _ => None,
        })
        .expect("tagged-template result initializer");
    let dependency_locals: std::collections::BTreeSet<_> = analysis.dependencies.value_dependencies
        [result_value.as_usize()]
    .iter()
    .filter_map(|dependency| match dependency.base {
        DependencyBase::Ssa(name) => Some(name.local),
        DependencyBase::Global(_) | DependencyBase::Value(_) => None,
    })
    .collect();
    assert_eq!(
        dependency_locals,
        [local("tag").id, local("first").id, local("second").id]
            .into_iter()
            .collect()
    );

    let unknown_call_escapes: std::collections::BTreeSet<_> = analysis
        .dependencies
        .escapes
        .iter()
        .filter(|escape| escape.kind == EscapeKind::UnknownCall)
        .filter_map(|escape| match escape.path.base {
            DependencyBase::Ssa(name) => Some(name.local),
            DependencyBase::Global(_) | DependencyBase::Value(_) => None,
        })
        .collect();
    assert_eq!(
        unknown_call_escapes,
        [local("first").id, local("second").id]
            .into_iter()
            .collect()
    );

    let definition = analysis
        .ssa
        .definitions
        .iter()
        .find(|definition| {
            definition.name.local == result.id && definition.kind == SsaDefinitionKind::Declare
        })
        .expect("result declaration definition");
    let shape = analysis
        .shapes
        .shapes
        .iter()
        .find(|shape| shape.name == definition.name)
        .expect("tagged-template result shape");
    assert_eq!(shape.shape.kind, ShapeKind::Unknown);
    assert_eq!(shape.shape.source, ShapeSource::UnknownOperation);
}

#[test]
fn dynamic_imports_track_inputs_and_produce_promise_object_shapes() {
    let frontend = build_hir(
        r#"
            export function load(specifier, options) {
                const request = import(specifier, options);
                return request;
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScript,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified dynamic-import HIR"),
        CorePassOptions {
            optimize: false,
            ..CorePassOptions::default()
        },
    )
    .expect("core passes over dynamic imports");
    let function = output
        .hir
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                output.hir.bindings[binding.as_usize()].display_name == "load"
            })
        })
        .expect("load function");
    let analysis = &output.functions[function.id.as_usize()];
    let local = |name: &str| {
        function
            .locals
            .iter()
            .find(|local| local.debug_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} local"))
    };
    let request = local("request");
    let request_value = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find_map(|instruction| match instruction.kind {
            fict_hir::HirInstructionKind::Declare {
                local, initializer, ..
            } if local == request.id => initializer,
            _ => None,
        })
        .expect("dynamic-import request initializer");
    let dependency_locals: std::collections::BTreeSet<_> = analysis.dependencies.value_dependencies
        [request_value.as_usize()]
    .iter()
    .filter_map(|dependency| match dependency.base {
        DependencyBase::Ssa(name) => Some(name.local),
        DependencyBase::Global(_) | DependencyBase::Value(_) => None,
    })
    .collect();
    assert_eq!(
        dependency_locals,
        [local("specifier").id, local("options").id]
            .into_iter()
            .collect()
    );

    let definition = analysis
        .ssa
        .definitions
        .iter()
        .find(|definition| {
            definition.name.local == request.id && definition.kind == SsaDefinitionKind::Declare
        })
        .expect("request declaration definition");
    let shape = analysis
        .shapes
        .shapes
        .iter()
        .find(|shape| shape.name == definition.name)
        .expect("dynamic-import result shape");
    assert_eq!(shape.shape.kind, ShapeKind::Object);
    assert!(matches!(
        shape.shape.source,
        ShapeSource::DynamicImport(value) if value == request_value
    ));
    assert!(!shape.shape.complete_key_set);
}

#[test]
fn analyzes_frontend_if_cfg_as_control_dependent_reactive_work() {
    let frontend = build_hir(
        r#"
            import { $state } from 'fict';
            export function App() {
                const count = $state(0);
                if (count > 10 && maybe()) return <Big />;
                return <Small />;
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScriptJsx,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified frontend CFG"),
        CorePassOptions::default(),
    )
    .expect("core passes over frontend CFG");
    let app = output
        .hir
        .functions
        .iter()
        .find(|function| function.kind == FunctionKind::Component)
        .expect("component function");
    let analysis = &output.functions[app.id.as_usize()];

    assert_eq!(app.blocks.len(), 4);
    assert!(!analysis.dependencies.control_flow_reads.is_empty());
    assert!(!analysis.dependencies.barriers.is_empty());
    assert_eq!(analysis.structurize.stats.conditionals, 1);
    assert!(analysis.structurize.fallback.is_none());
    assert_eq!(
        analysis
            .ssa
            .cfg
            .reachable
            .iter()
            .filter(|reachable| **reachable)
            .count(),
        4
    );
}

#[test]
fn analyzes_frontend_while_cfg_with_a_backedge_and_reactive_phi() {
    let frontend = build_hir(
        r#"
            import { $state } from 'fict';
            export function App() {
                let count = $state(0);
                while (count < 3) count++;
                return <span>{count}</span>;
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScriptJsx,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified frontend loop CFG"),
        CorePassOptions::default(),
    )
    .expect("core passes over loop CFG");
    let app = output
        .hir
        .functions
        .iter()
        .find(|function| function.kind == FunctionKind::Component)
        .expect("component function");
    let analysis = &output.functions[app.id.as_usize()];
    let count = app
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("count"))
        .expect("count local")
        .id;

    assert_eq!(app.blocks.len(), 4);
    assert_eq!(analysis.ssa.cfg.back_edges.len(), 1);
    assert_eq!(analysis.ssa.cfg.loop_headers.len(), 1);
    assert!(
        analysis
            .ssa
            .phis
            .iter()
            .any(|phi| phi.target.local == count)
    );
    assert!(!analysis.dependencies.control_flow_reads.is_empty());
    assert_eq!(analysis.structurize.stats.loops, 1);
    assert!(analysis.structurize.fallback.is_none());
    let header = analysis.ssa.cfg.loop_headers[0];
    assert!(matches!(
        app.blocks[header.as_usize()]
            .source_hint
            .as_ref()
            .map(|hint| &hint.kind),
        Some(StructuredSourceKind::WhileLoop)
    ));
}

#[test]
fn analyzes_frontend_for_of_cfg_with_iteration_definitions_and_reactive_source() {
    let frontend = build_hir(
        r#"
            import { $state } from 'fict';
            export function App() {
                let items = $state([1, 2]);
                let total = $state(0);
                for (const item of items) {
                    total += item;
                }
                return <span>{total}</span>;
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScriptJsx,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified frontend for-of CFG"),
        CorePassOptions::default(),
    )
    .expect("core passes over for-of CFG");
    let app = output
        .hir
        .functions
        .iter()
        .find(|function| function.kind == FunctionKind::Component)
        .expect("component function");
    let analysis = &output.functions[app.id.as_usize()];
    let item = app
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("item"))
        .expect("iteration local")
        .id;
    let items = app
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("items"))
        .expect("iterable local")
        .id;
    let total = app
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("total"))
        .expect("total local")
        .id;

    assert_eq!(app.blocks.len(), 4);
    assert_eq!(analysis.ssa.cfg.back_edges.len(), 1);
    assert!(analysis.ssa.definitions.iter().any(|definition| {
        definition.name.local == item && definition.kind == SsaDefinitionKind::Iteration
    }));
    assert!(
        analysis
            .ssa
            .phis
            .iter()
            .any(|phi| phi.target.local == total)
    );
    assert!(
        analysis
            .dependencies
            .control_flow_reads
            .iter()
            .any(|path| path.local() == Some(items))
    );
    assert!(analysis.structurize.constructs.iter().any(|construct| {
        matches!(
            construct.kind,
            StructuredConstructKind::Loop {
                kind: StructuredLoopKind::ForOf,
                ..
            }
        )
    }));
    assert!(analysis.structurize.fallback.is_none());
}

#[test]
fn analyzes_frontend_switch_cfg_with_ordered_dispatch_phi_and_reactive_control() {
    let frontend = build_hir(
        r#"
            import { $state } from 'fict';
            export function App() {
                let mode = $state(0);
                let label = $state('zero');
                switch (mode) {
                    case 0:
                        label = 'zero';
                        break;
                    case 1:
                        label = 'one';
                        break;
                    default:
                        label = 'many';
                }
                return <span>{label}</span>;
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScriptJsx,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified frontend switch CFG"),
        CorePassOptions::default(),
    )
    .expect("core passes over switch CFG");
    let app = output
        .hir
        .functions
        .iter()
        .find(|function| function.kind == FunctionKind::Component)
        .expect("component function");
    let analysis = &output.functions[app.id.as_usize()];
    let mode = app
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("mode"))
        .expect("mode local")
        .id;
    let label = app
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("label"))
        .expect("label local")
        .id;

    assert!(
        analysis
            .dependencies
            .control_flow_reads
            .iter()
            .any(|path| path.local() == Some(mode))
    );
    assert!(
        analysis
            .ssa
            .phis
            .iter()
            .any(|phi| phi.target.local == label)
    );
    assert_eq!(analysis.structurize.stats.switches, 1);
    assert_eq!(analysis.structurize.stats.conditionals, 0);
    let switch = analysis
        .structurize
        .constructs
        .iter()
        .find_map(|construct| match &construct.kind {
            StructuredConstructKind::Switch { arms, join } => Some((arms, join)),
            _ => None,
        })
        .expect("structured switch");
    assert_eq!(switch.0.len(), 3);
    assert_eq!(switch.0.iter().filter(|arm| arm.is_default).count(), 1);
    assert!(switch.1.is_some());
    assert!(analysis.structurize.fallback.is_none());
}

#[test]
fn analyzes_frontend_try_cfg_with_catch_finally_and_reactive_phi() {
    let frontend = build_hir(
        r#"
            import { $state } from 'fict';
            export function App(shouldThrow) {
                let result = $state('init');
                try {
                    result = 'try';
                    if (shouldThrow) throw new Error('boom');
                } catch (error) {
                    result = error.message;
                } finally {
                    result += '!';
                }
                return <span>{result}</span>;
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScriptJsx,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified frontend try CFG"),
        CorePassOptions::default(),
    )
    .expect("core passes over try CFG");
    let app = output
        .hir
        .functions
        .iter()
        .find(|function| function.kind == FunctionKind::Component)
        .expect("component function");
    let analysis = &output.functions[app.id.as_usize()];
    let result = app
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("result"))
        .expect("result local")
        .id;

    assert!(
        analysis
            .ssa
            .phis
            .iter()
            .any(|phi| phi.target.local == result)
    );
    assert_eq!(analysis.structurize.stats.tries, 1);
    assert!(analysis.structurize.constructs.iter().any(|construct| {
        matches!(
            construct.kind,
            StructuredConstructKind::Try {
                catch: Some(_),
                finally: Some(_),
                ..
            }
        )
    }));
    assert!(analysis.structurize.fallback.is_none());
}
