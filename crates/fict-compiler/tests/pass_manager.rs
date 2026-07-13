use fict_compiler::{CorePassBudgets, CorePassOptions, run_core_passes};
use fict_compiler_oxc::{
    HirBuildOptions, OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, build_hir,
};
use fict_hir::{
    ContextValueKind, DeleteTarget, FunctionKind, HirInstructionKind, LiteralValue, MutationEffect,
    StructuredSourceKind,
};
use fict_reactivity::{
    DependencyBase, DependencySegment, EscapeKind, ShapeKind, ShapeSource, SsaDefinitionKind,
    StructuredConstructKind, StructuredLoopKind,
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
            DependencyBase::Value(_) => None,
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
                const target = new.target;
                const metadata = import.meta;
                return [receiver, target, metadata];
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
        DependencyBase::Value(_) => None,
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
            DependencyBase::Value(_) => None,
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
        DependencyBase::Value(_) => None,
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
