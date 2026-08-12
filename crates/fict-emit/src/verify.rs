use crate::{
    CleanupOwner, DomNamespace, EmitOperation, EmitProgram, EmitValueRef, RuntimeHelper,
    RuntimeHelperStability, verify_runtime_abi,
};
use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_hir::HirFile;
use fict_reactivity::{RegionAnalysis, analyze_cfg, verify_structurized_cfg};
use std::collections::{BTreeMap, BTreeSet};
/// Verify EmitIR helper, slot/temp, region/template, cleanup, and rejection invariants.
pub fn verify_emit_program(
    hir: &HirFile,
    analyses: &[RegionAnalysis],
    program: &EmitProgram,
) -> Result<(), DiagnosticBundle> {
    let mut diagnostics = DiagnosticBundle::default();
    if verify_runtime_abi().is_err() {
        diagnostics.push(emit_error(
            "FICT-EMIT-ABI",
            "runtime ABI registry is inconsistent",
        ));
    }
    if program.strict_rejected
        && (!program.imports.is_empty()
            || program
                .functions
                .iter()
                .any(|function| !function.operations.is_empty()))
    {
        diagnostics.push(emit_error(
            "FICT-EMIT-REJECTED",
            "strict-rejected modules cannot contain partial output",
        ));
    }
    if program.functions.len() != hir.functions.len()
        || analyses.len() != hir.functions.len()
        || program
            .functions
            .iter()
            .enumerate()
            .any(|(index, function)| function.source.as_usize() != index)
    {
        diagnostics.push(emit_error(
            "FICT-EMIT-FUNCTION",
            "EmitIR functions must match the HIR function arena",
        ));
    }
    verify_module_plan(hir, program, &mut diagnostics);
    verify_local_hook_returns(hir, program, &mut diagnostics);
    verify_imports(program, &mut diagnostics);
    verify_preview_plan(hir, program, &mut diagnostics);
    let import_names: BTreeSet<_> = program
        .imports
        .iter()
        .map(|intent| intent.local.as_str())
        .collect();
    let source_names: BTreeSet<_> = hir
        .bindings
        .iter()
        .map(|binding| binding.display_name.as_str())
        .chain(hir.globals.iter().map(|global| global.name.as_str()))
        .chain(hir.authored_free_names.iter().map(String::as_str))
        .chain(hir.functions.iter().flat_map(|function| {
            function
                .locals
                .iter()
                .filter_map(|local| local.debug_name.as_deref())
        }))
        .collect();
    if import_names.iter().any(|name| source_names.contains(name)) {
        diagnostics.push(emit_error(
            "FICT-EMIT-IMPORT-COLLISION",
            "generated runtime import locals must not collide with any authored identifier",
        ));
    }
    for function in &program.functions {
        let Some(hir_function) = hir.functions.get(function.source.as_usize()) else {
            continue;
        };
        let analysis = analyses.get(function.source.as_usize());
        for (index, slot) in function.slots.iter().enumerate() {
            if slot.id.as_usize() != index
                || slot.control_path.windows(2).any(|pair| pair[0] >= pair[1])
            {
                diagnostics.push(emit_error(
                    "FICT-EMIT-SLOT",
                    "reactive slots must be dense with canonical control paths",
                ));
            }
            if let crate::ReactiveSlotStorage::Captured { owner } = slot.storage {
                let capture_valid = owner != function.source
                    && slot.binding.is_some()
                    && program
                        .functions
                        .get(owner.as_usize())
                        .is_some_and(|owner| {
                            owner.slots.iter().any(|candidate| {
                                matches!(
                                    candidate.storage,
                                    crate::ReactiveSlotStorage::Owned
                                        | crate::ReactiveSlotStorage::HookReturn { .. }
                                ) && candidate.binding == slot.binding
                                    && candidate.kind == slot.kind
                            })
                        });
                if !capture_valid {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-CAPTURE",
                        "captured reactive slots must reference an owned slot with the same binding and kind",
                    ));
                }
            }
            if let crate::ReactiveSlotStorage::CapturedHookReturn {
                owner,
                call,
                hook,
                property,
            } = slot.storage
            {
                let capture_valid = owner != function.source
                    && slot.binding.is_some()
                    && program
                        .functions
                        .get(owner.as_usize())
                        .is_some_and(|owner| {
                            owner.slots.iter().any(|candidate| {
                                matches!(
                                    candidate.storage,
                                    crate::ReactiveSlotStorage::HookReturn {
                                        call: candidate_call,
                                        hook: candidate_hook,
                                        property: Some(candidate_property),
                                    } if candidate_call == call
                                        && candidate_hook == hook
                                        && candidate_property == property
                                ) && candidate.binding == slot.binding
                                    && candidate.kind == slot.kind
                            })
                        });
                if !capture_valid {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-HOOK-CAPTURE",
                        "captured hook members must reference a matching owner accessor slot",
                    ));
                }
            }
            if let crate::ReactiveSlotStorage::Imported { member } = slot.storage {
                let import = slot
                    .binding
                    .and_then(|binding| hir.bindings.get(binding.as_usize()))
                    .and_then(|binding| binding.import.as_ref());
                let imported_kind = match member {
                    None => import.and_then(|import| import.reactive),
                    Some(member) => import
                        .and_then(|import| import.reactive_members.get(member as usize))
                        .map(|member| member.kind),
                };
                let kind_matches = matches!(
                    (imported_kind, slot.kind),
                    (
                        Some(fict_hir::ImportedReactiveKind::Signal),
                        crate::ReactiveSlotKind::Signal
                    ) | (
                        Some(fict_hir::ImportedReactiveKind::Memo),
                        crate::ReactiveSlotKind::Memo
                    ) | (
                        Some(fict_hir::ImportedReactiveKind::Store),
                        crate::ReactiveSlotKind::Store
                    )
                );
                let local_exists = slot.binding.is_some_and(|binding| {
                    hir_function
                        .locals
                        .iter()
                        .any(|local| local.binding == Some(binding))
                });
                if !kind_matches || !local_exists {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-IMPORTED-SLOT",
                        "imported reactive slots must match a metadata-annotated local binding",
                    ));
                }
            }
            if let crate::ReactiveSlotStorage::HookReturn {
                call,
                hook: hook_binding,
                property,
            } = slot.storage
            {
                let source_call = hook_call_instruction(hir_function, call);
                let shape = source_call.and_then(|call| {
                    hook_return_shape(hir, &program.local_hook_returns, call, hook_binding)
                });
                let reactive_kind = match property {
                    None => shape.and_then(|shape| shape.direct_accessor),
                    Some(property) => shape.and_then(|shape| {
                        let properties = match property.collection {
                            fict_hir::ImportedHookPropertyCollection::Object => {
                                &shape.object_properties
                            }
                            fict_hir::ImportedHookPropertyCollection::Array => {
                                &shape.array_properties
                            }
                        };
                        properties
                            .get(property.property_index)
                            .filter(|candidate| candidate.kind == property.kind)
                            .map(|candidate| candidate.kind)
                    }),
                };
                let call_matches = source_call.is_some() && shape.is_some();
                let kind_matches = matches!(
                    (reactive_kind, slot.kind),
                    (
                        Some(fict_hir::ImportedReactiveKind::Signal),
                        crate::ReactiveSlotKind::Signal
                    ) | (
                        Some(fict_hir::ImportedReactiveKind::Memo),
                        crate::ReactiveSlotKind::Memo
                    )
                );
                let binding_matches = slot.binding.is_none_or(|binding| {
                    hir_function.locals.iter().any(|local| {
                        local.binding == Some(binding)
                            && hir_function
                                .blocks
                                .iter()
                                .flat_map(|block| &block.instructions)
                                .any(|instruction| {
                                    matches!(
                                        instruction.kind,
                                        fict_hir::HirInstructionKind::Declare {
                                            local: declared,
                                            initializer: Some(initializer),
                                            ..
                                        } if declared == local.id && initializer == call
                                    )
                                })
                    })
                });
                let shape_matches = shape
                    .is_some_and(|shape| property.is_none() == shape.direct_accessor.is_some());
                if !call_matches || !kind_matches || !binding_matches || !shape_matches {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-HOOK-RETURN-SLOT",
                        "hook return slots must match accessor return metadata",
                    ));
                }
            }
        }
        let mut temporary_names = BTreeSet::new();
        for (index, temporary) in function.temporaries.iter().enumerate() {
            if temporary.id.as_usize() != index
                || !valid_identifier(&temporary.name)
                || !temporary_names.insert(temporary.name.as_str())
                || import_names.contains(temporary.name.as_str())
                || source_names.contains(temporary.name.as_str())
            {
                diagnostics.push(emit_error(
                    "FICT-EMIT-TEMP",
                    "temporaries must be dense, unique identifiers without authored or import collisions",
                ));
            }
        }
        let needs_context = function
            .operations
            .iter()
            .filter_map(EmitOperation::helper)
            .any(is_scoped_helper);
        match &function.context {
            Some(context)
                if !needs_context
                    || context.helper != RuntimeHelper::UseContext
                    || context.origin != hir_function.origin
                    || !valid_identifier(&context.local)
                    || import_names.contains(context.local.as_str())
                    || source_names.contains(context.local.as_str())
                    || temporary_names.contains(context.local.as_str()) =>
            {
                diagnostics.push(emit_error(
                    "FICT-EMIT-CONTEXT",
                    "function context must be collision-free and exactly match scoped helper use",
                ));
            }
            None if needs_context => diagnostics.push(emit_error(
                "FICT-EMIT-CONTEXT",
                "scoped runtime helpers require a function context plan",
            )),
            Some(_) | None => {}
        }
        if let Some(props) = &function.props {
            let mut generated_names = BTreeSet::new();
            generated_names.insert(props.source.as_str());
            let expected = hir_function
                .parameters
                .first()
                .and_then(|parameter| parameter.object_properties.as_ref());
            let structurally_valid = expected.is_some_and(|expected| {
                props.parameter == hir_function.parameters[0].origin
                    && props.default.as_ref().map(|default| default.value)
                        == hir_function.parameters[0].default_value
                    && match (&props.rest, &hir_function.parameters[0].object_rest) {
                        (Some(planned), Some(source)) => hir
                            .bindings
                            .get(source.binding.as_usize())
                            .is_some_and(|binding| {
                                planned.binding == source.binding
                                    && planned.local == binding.display_name
                                    && planned.excluded == source.excluded
                                    && planned.origin == source.origin
                            }),
                        (None, None) => true,
                        (Some(_), None) | (None, Some(_)) => false,
                    }
                    && props.bindings.len() == expected.len()
                    && props
                        .bindings
                        .iter()
                        .zip(expected)
                        .all(|(planned, source)| {
                            hir.bindings
                                .get(source.binding.as_usize())
                                .is_some_and(|binding| {
                                    planned.path == source.path
                                        && planned.local == binding.display_name
                                        && planned.mode
                                            == match source.mode {
                                                fict_hir::HirObjectParameterMode::Accessor => {
                                                    crate::EmitPropMode::Accessor
                                                }
                                                fict_hir::HirObjectParameterMode::Value => {
                                                    crate::EmitPropMode::Value
                                                }
                                                fict_hir::HirObjectParameterMode::Mutable => {
                                                    crate::EmitPropMode::Mutable
                                                }
                                            }
                                        && planned.checks.len() == source.checks.len()
                                        && planned.checks.iter().zip(&source.checks).all(
                                            |(planned, source)| {
                                                planned.path == source.path
                                                    && planned.origin == source.origin
                                            },
                                        )
                                        && planned.references == source.references
                                        && planned.default_value == source.default_value
                                        && planned.default_dependencies
                                            == source.default_dependencies
                                        && planned.default_local.is_some()
                                            == source.default_value.is_some()
                                        && planned.origin == source.origin
                                })
                        })
            });
            if hir_function.kind != fict_hir::FunctionKind::Component
                || props.helper
                    != props
                        .bindings
                        .iter()
                        .any(|binding| binding.mode == crate::EmitPropMode::Accessor)
                        .then_some(RuntimeHelper::Prop)
                || !valid_identifier(&props.source)
                || import_names.contains(props.source.as_str())
                || source_names.contains(props.source.as_str())
                || temporary_names.contains(props.source.as_str())
                || function
                    .context
                    .as_ref()
                    .is_some_and(|context| context.local == props.source)
                || props.default.as_ref().is_some_and(|default| {
                    default.value.primary_span.is_none()
                        || !valid_identifier(&default.input)
                        || !generated_names.insert(default.input.as_str())
                        || import_names.contains(default.input.as_str())
                        || source_names.contains(default.input.as_str())
                        || temporary_names.contains(default.input.as_str())
                        || function
                            .context
                            .as_ref()
                            .is_some_and(|context| context.local == default.input)
                })
                || props.rest.as_ref().is_some_and(|rest| {
                    rest.helper != RuntimeHelper::PropsRest
                        || !valid_identifier(&rest.local)
                        || rest.excluded.iter().any(String::is_empty)
                        || rest.origin.primary_span.is_none()
                })
                || props.bindings.iter().any(|binding| {
                    binding.path.is_empty()
                        || binding.path.iter().any(String::is_empty)
                        || !valid_identifier(&binding.local)
                        || (binding.mode == crate::EmitPropMode::Value
                            && (!binding.references.is_empty()
                                || binding.default_value.is_some()
                                || binding.default_local.is_some()))
                        || (binding.mode == crate::EmitPropMode::Mutable
                            && !binding.references.is_empty())
                        || binding.checks.iter().any(|check| {
                            check.path.is_empty()
                                || check.path.iter().any(String::is_empty)
                                || !valid_identifier(&check.local)
                                || !generated_names.insert(check.local.as_str())
                                || import_names.contains(check.local.as_str())
                                || source_names.contains(check.local.as_str())
                                || temporary_names.contains(check.local.as_str())
                                || function
                                    .context
                                    .as_ref()
                                    .is_some_and(|context| context.local == check.local)
                        })
                        || binding
                            .default_value
                            .is_some_and(|origin| origin.primary_span.is_none())
                        || binding.default_local.as_ref().is_some_and(|local| {
                            !valid_identifier(local)
                                || !generated_names.insert(local.as_str())
                                || import_names.contains(local.as_str())
                                || source_names.contains(local.as_str())
                                || temporary_names.contains(local.as_str())
                                || local == &props.source
                                || function
                                    .context
                                    .as_ref()
                                    .is_some_and(|context| context.local == local.as_str())
                        })
                        || binding
                            .references
                            .iter()
                            .any(|origin| origin.primary_span.is_none())
                })
                || !structurally_valid
            {
                diagnostics.push(emit_error(
                    "FICT-EMIT-PROPS",
                    "component props plans must exactly match a collision-free modeled object parameter",
                ));
            }
        }
        if function.regions.windows(2).any(|pair| pair[0] >= pair[1])
            || function.regions.iter().any(|region| {
                analysis.is_none_or(|analysis| analysis.regions.get(region.as_usize()).is_none())
            })
            || analysis.is_some_and(|analysis| function.regions != analysis.top_level_regions)
        {
            diagnostics.push(emit_error(
                "FICT-EMIT-REGION",
                "function regions must be sorted known analysis regions",
            ));
        }
        match analyze_cfg(hir_function)
            .and_then(|cfg| verify_structurized_cfg(hir_function, &cfg, &function.control_flow))
        {
            Ok(()) => {}
            Err(bundle) => {
                for diagnostic in bundle.as_slice() {
                    diagnostics.push(diagnostic.clone());
                }
            }
        }
        verify_operations(
            hir,
            &program.local_hook_returns,
            hir_function,
            function,
            analysis,
            &mut diagnostics,
        );
    }
    if diagnostics.is_empty() {
        Ok(())
    } else {
        Err(diagnostics)
    }
}
fn verify_local_hook_returns(
    hir: &HirFile,
    program: &EmitProgram,
    diagnostics: &mut DiagnosticBundle,
) {
    for (binding, shape) in &program.local_hook_returns {
        let function_exists = hir
            .functions
            .iter()
            .any(|function| function.binding == Some(*binding));
        let has_shape = shape.direct_accessor.is_some()
            || !shape.object_properties.is_empty()
            || !shape.array_properties.is_empty();
        let canonical = [&shape.object_properties, &shape.array_properties]
            .into_iter()
            .all(|properties| properties.windows(2).all(|pair| pair[0].key < pair[1].key));
        if !function_exists || !has_shape || !canonical {
            diagnostics.push(emit_error(
                "FICT-EMIT-LOCAL-HOOK",
                "same-module hook metadata must identify one function and use a canonical non-empty shape",
            ));
        }
    }
}
fn verify_imports(program: &EmitProgram, diagnostics: &mut DiagnosticBundle) {
    let used: BTreeSet<_> = program
        .functions
        .iter()
        .flat_map(|function| {
            function
                .operations
                .iter()
                .flat_map(|operation| operation.helper_slots().into_iter().flatten())
                .chain(function.context.iter().map(|context| context.helper))
                .chain(function.props.iter().filter_map(|props| props.helper))
                .chain(
                    function
                        .props
                        .iter()
                        .filter_map(|props| props.rest.as_ref().map(|rest| rest.helper)),
                )
        })
        .chain(
            program
                .preview_plan
                .iter()
                .flat_map(|preview| preview.helpers.iter().copied()),
        )
        .collect();
    let imported: BTreeSet<_> = program.imports.iter().map(|intent| intent.helper).collect();
    if imported != used
        || imported.len() != program.imports.len()
        || program
            .imports
            .windows(2)
            .any(|pair| pair[0].helper >= pair[1].helper)
    {
        diagnostics.push(emit_error(
            "FICT-EMIT-IMPORTS",
            "runtime imports must exactly match used helpers in ABI order",
        ));
    }
    let mut names = BTreeSet::new();
    for intent in &program.imports {
        let spec = intent.helper.spec();
        if !valid_identifier(&intent.local) || !names.insert(intent.local.as_str()) {
            diagnostics.push(emit_error(
                "FICT-EMIT-IMPORT-NAME",
                "runtime import locals must be unique valid identifiers",
            ));
        }
        if intent.imported != spec.export
            || intent.module_request != spec.module_request(program.runtime_family)
            || !program.module.reserved_names.contains(&intent.local)
        {
            diagnostics.push(emit_error(
                "FICT-EMIT-IMPORT-ABI",
                "runtime import source/export must match its ABI family and reserve its local",
            ));
        }
        if !program.preview && intent.helper.spec().stability == RuntimeHelperStability::Preview {
            diagnostics.push(emit_error(
                "FICT-EMIT-PREVIEW",
                "Core EmitIR cannot import a Preview-only helper",
            ));
        }
    }
    if !program.preview && program.preview_plan.is_some() {
        diagnostics.push(emit_error(
            "FICT-EMIT-PREVIEW",
            "Core EmitIR cannot carry a Preview plan",
        ));
    }
}
fn verify_preview_plan(hir: &HirFile, program: &EmitProgram, diagnostics: &mut DiagnosticBundle) {
    let Some(preview) = &program.preview_plan else {
        return;
    };
    for handler in &preview.handlers {
        let prop_sources = program
            .functions
            .get(handler.owner.as_usize())
            .and_then(|function| function.props.as_ref());
        let prop_captures_valid = handler
            .prop_captures
            .windows(2)
            .all(|pair| pair[0].binding < pair[1].binding)
            && handler.prop_captures.iter().all(|capture| {
                prop_sources.is_some_and(|props| {
                    props.bindings.iter().any(|source| {
                        source.binding == capture.binding
                            && source.local == capture.local
                            && source.path == capture.path
                            && source.mode == capture.mode
                            && source.default_value == capture.default_value
                    })
                })
            });
        if !prop_captures_valid {
            diagnostics.push(emit_error(
                "FICT-EMIT-PREVIEW-PROPS",
                "Preview prop captures must be ordered copies of the owning component props plan",
            ));
        }
        let valid_local_function = |local: &crate::EmitPreviewLocalHandler| {
            let binding = hir.bindings.get(local.binding.as_usize());
            let function = hir.functions.get(local.function.as_usize());
            binding.is_some_and(|binding| {
                binding.display_name == local.local
                    && matches!(
                        binding.kind,
                        fict_hir::BindingKind::Const | fict_hir::BindingKind::Function
                    )
                    && !hir
                        .scopes
                        .get(binding.scope.as_usize())
                        .is_some_and(|scope| scope.kind == fict_hir::ScopeKind::Module)
            }) && function.is_some_and(|function| {
                function.binding == Some(local.binding)
                    && function.parent == handler.owner
                    && function.origin == local.definition_origin
            }) && !preview_binding_has_runtime_write(hir, local.binding)
        };
        let local_functions_valid = handler
            .local_functions
            .windows(2)
            .all(|pair| pair[0].binding < pair[1].binding)
            && handler.local_functions.iter().all(|local| {
                valid_local_function(local)
                    && handler
                        .local_handler
                        .as_ref()
                        .is_none_or(|handler| handler.binding != local.binding)
                    && !handler
                        .module_captures
                        .iter()
                        .any(|capture| capture.binding == local.binding)
                    && !handler
                        .lexical_captures
                        .iter()
                        .any(|capture| capture.binding == local.binding)
                    && !handler
                        .prop_captures
                        .iter()
                        .any(|capture| capture.binding == local.binding)
                    && !handler
                        .prop_rest_captures
                        .iter()
                        .any(|capture| capture.binding == local.binding)
            });
        if !local_functions_valid {
            diagnostics.push(emit_error(
                "FICT-EMIT-PREVIEW-FUNCTION",
                "Preview local function dependencies must be ordered, disjoint stable functions owned by the component",
            ));
        }
        let Some(local) = &handler.local_handler else {
            continue;
        };
        let valid = valid_local_function(local)
            && handler.handler_function == Some(local.function)
            && !handler
                .module_captures
                .iter()
                .any(|capture| capture.binding == local.binding);
        if !valid {
            diagnostics.push(emit_error(
                "FICT-EMIT-PREVIEW-HANDLER",
                "Preview local handlers must identify a stable source function owned by the component",
            ));
        }
    }
}
fn preview_binding_has_runtime_write(hir: &HirFile, binding: fict_hir::BindingId) -> bool {
    hir.functions.iter().any(|function| {
        function
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .any(|instruction| match &instruction.kind {
                fict_hir::HirInstructionKind::Write { place, .. }
                | fict_hir::HirInstructionKind::ReadWrite { place, .. } => {
                    preview_place_binding(function, place) == Some(binding)
                }
                fict_hir::HirInstructionKind::Iteration { targets, .. } => {
                    targets.iter().any(|local| {
                        function
                            .locals
                            .get(local.as_usize())
                            .and_then(|local| local.binding)
                            == Some(binding)
                    })
                }
                fict_hir::HirInstructionKind::PatternAssignment { writes, .. } => {
                    writes.iter().any(|write| {
                        function
                            .locals
                            .get(write.local.as_usize())
                            .and_then(|local| local.binding)
                            == Some(binding)
                    })
                }
                _ => false,
            })
    })
}
fn preview_place_binding(
    function: &fict_hir::HirFunction,
    place: &fict_hir::Place,
) -> Option<fict_hir::BindingId> {
    let local = match place.base {
        fict_hir::PlaceBase::Local(local) => local,
        fict_hir::PlaceBase::Ssa(name) => name.local,
        fict_hir::PlaceBase::Global(_) | fict_hir::PlaceBase::Value(_) => return None,
    };
    function.locals.get(local.as_usize())?.binding
}
fn verify_module_plan(hir: &HirFile, program: &EmitProgram, diagnostics: &mut DiagnosticBundle) {
    if program
        .module
        .reserved_names
        .windows(2)
        .any(|pair| pair[0] >= pair[1])
        || program.module.reserved_names.iter().any(String::is_empty)
    {
        diagnostics.push(emit_error(
            "FICT-EMIT-MODULE-NAMES",
            "module reserved names must be non-empty, sorted, and unique",
        ));
    }
    let expected_fragment = hir
        .functions
        .get(hir.root_function.as_usize())
        .and_then(|function| {
            function
                .blocks
                .iter()
                .flat_map(|block| &block.instructions)
                .rev()
                .find_map(|instruction| match instruction.kind {
                    fict_hir::HirInstructionKind::SyntaxFragment { fragment, .. }
                        if instruction.result.is_none() =>
                    {
                        Some(fragment)
                    }
                    _ => None,
                })
        });
    if program.module.source_fragment != expected_fragment
        || program.module.source_fragment.is_some_and(|fragment| {
            hir.syntax_fragments
                .get(fragment.as_usize())
                .is_none_or(|fragment| fragment.kind != fict_hir::SyntaxFragmentKind::Statement)
        })
    {
        diagnostics.push(emit_error(
            "FICT-EMIT-MODULE-SOURCE",
            "module plan must preserve the root adapter-owned statement fragment",
        ));
    }
    let required_names = hir
        .bindings
        .iter()
        .map(|binding| binding.display_name.as_str())
        .chain(hir.functions.iter().flat_map(|function| {
            function
                .locals
                .iter()
                .filter_map(|local| local.debug_name.as_deref())
        }))
        .chain(program.functions.iter().flat_map(|function| {
            function
                .temporaries
                .iter()
                .map(|temporary| temporary.name.as_str())
                .chain(
                    function
                        .context
                        .iter()
                        .map(|context| context.local.as_str()),
                )
                .chain(function.props.iter().map(|props| props.source.as_str()))
                .chain(function.props.iter().filter_map(|props| {
                    props.default.as_ref().map(|default| default.input.as_str())
                }))
                .chain(function.props.iter().flat_map(|props| {
                    props
                        .bindings
                        .iter()
                        .filter_map(|binding| binding.default_local.as_deref())
                }))
                .chain(function.props.iter().flat_map(|props| {
                    props
                        .bindings
                        .iter()
                        .flat_map(|binding| binding.checks.iter().map(|check| check.local.as_str()))
                }))
                .chain(
                    function
                        .operations
                        .iter()
                        .filter_map(|operation| match operation {
                            EmitOperation::DeclareTemplate { local, .. } => Some(local.as_str()),
                            _ => None,
                        }),
                )
        }));
    if required_names.into_iter().any(|name| {
        !program
            .module
            .reserved_names
            .iter()
            .any(|item| item == name)
    }) {
        diagnostics.push(emit_error(
            "FICT-EMIT-MODULE-NAMES",
            "module name plan must reserve every source binding and generated temporary",
        ));
    }
}
fn is_scoped_helper(helper: RuntimeHelper) -> bool {
    matches!(
        helper,
        RuntimeHelper::UseSignal | RuntimeHelper::UseMemo | RuntimeHelper::UseEffect
    )
}
fn verify_operations(
    hir: &HirFile,
    local_hook_returns: &BTreeMap<fict_hir::BindingId, fict_hir::ImportedHookReturn>,
    hir_function: &fict_hir::HirFunction,
    function: &crate::EmitFunction,
    analysis: Option<&RegionAnalysis>,
    diagnostics: &mut DiagnosticBundle,
) {
    let mut defined = BTreeSet::new();
    let mut templates = BTreeSet::new();
    for operation in &function.operations {
        verify_helper_semantics(function, operation, diagnostics);
        operation.visit_values(|value| {
            let valid = match value {
                EmitValueRef::Hir(value) => hir_function.values.get(value.as_usize()).is_some(),
                EmitValueRef::Ssa(name) => hir_function.locals.get(name.local.as_usize()).is_some(),
                EmitValueRef::Slot(slot) => function.slots.get(slot.as_usize()).is_some(),
                EmitValueRef::Temporary(temporary) => defined.contains(temporary),
                EmitValueRef::Literal(_) => true,
                EmitValueRef::Function(function) => {
                    hir.functions.get(function.as_usize()).is_some()
                }
                EmitValueRef::Binding(binding) => hir.bindings.get(binding.as_usize()).is_some(),
                EmitValueRef::Text(segments) => {
                    !segments.is_empty()
                        && segments.iter().all(|segment| match segment {
                            crate::DomTextSegment::Literal(_) => true,
                            crate::DomTextSegment::Source { value, .. } => {
                                value.is_none_or(|value| {
                                    hir_function.values.get(value.as_usize()).is_some()
                                })
                            }
                        })
                }
            };
            if !valid {
                diagnostics.push(emit_error(
                    "FICT-EMIT-VALUE",
                    "value references an unknown or not-yet-defined arena entry",
                ));
            }
        });
        operation.visit_temporary_uses(|temporary| {
            if !defined.contains(&temporary) {
                diagnostics.push(emit_error(
                    "FICT-EMIT-TEMP-USE",
                    "temporary must be defined before use",
                ));
            }
        });
        if let Some(temporary) = operation.defined_temporary()
            && (!defined.insert(temporary)
                || function.temporaries.get(temporary.as_usize()).is_none())
        {
            diagnostics.push(emit_error(
                "FICT-EMIT-TEMP-DEF",
                "temporary must be declared and defined exactly once",
            ));
        }
        match operation {
            EmitOperation::PreserveHir {
                block, instruction, ..
            } => {
                if hir_function
                    .blocks
                    .get(block.as_usize())
                    .and_then(|block| block.instructions.get(*instruction as usize))
                    .is_none()
                {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-HIR",
                        "preserved HIR location is invalid",
                    ));
                }
            }
            EmitOperation::CreateReactive {
                slot,
                source_result,
                ..
            }
            | EmitOperation::CreateDerived {
                slot,
                source_result,
                ..
            } => {
                verify_slot(function, *slot, diagnostics);
                verify_source_result(hir_function, *source_result, diagnostics);
            }
            EmitOperation::ReadReactive {
                slot,
                source_result,
                projections,
                accessor_depth,
                ..
            } => verify_reactive_read(
                hir,
                local_hook_returns,
                hir_function,
                function,
                *slot,
                *source_result,
                projections,
                *accessor_depth,
                diagnostics,
            ),
            EmitOperation::TrackRuntimeReactive {
                slot,
                source_result,
                local,
                cleanup,
                ..
            } => {
                verify_slot(function, *slot, diagnostics);
                verify_source_result(hir_function, *source_result, diagnostics);
                verify_cleanup(function, analysis, *cleanup, diagnostics);
                verify_runtime_reactive_site(
                    hir_function,
                    function,
                    *slot,
                    *source_result,
                    *local,
                    diagnostics,
                );
            }
            EmitOperation::WriteReactive {
                slot,
                source_result: None,
                ..
            }
            | EmitOperation::UpdateReactive {
                slot,
                source_result: None,
                ..
            } => {
                verify_slot(function, *slot, diagnostics);
            }
            EmitOperation::WriteReactive {
                slot,
                source_result: Some(source_result),
                ..
            }
            | EmitOperation::UpdateReactive {
                slot,
                source_result: Some(source_result),
                ..
            } => {
                verify_slot(function, *slot, diagnostics);
                verify_source_result(hir_function, *source_result, diagnostics);
            }
            EmitOperation::DeleteReactive {
                slot,
                source_result,
                projections,
                ..
            } => {
                verify_slot(function, *slot, diagnostics);
                verify_source_result(hir_function, *source_result, diagnostics);
                if projections.is_empty() {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-DELETE",
                        "reactive deletion requires a projected property target",
                    ));
                }
            }
            EmitOperation::WriteReactivePattern {
                source_result,
                targets,
                origin,
                ..
            } => {
                verify_source_result(hir_function, *source_result, diagnostics);
                let source = hir_function.instruction_for_result(*source_result);
                let mut origins = BTreeSet::new();
                if targets.is_empty()
                    || targets.iter().any(|target| {
                        verify_slot(function, target.slot, diagnostics);
                        let slot_binding = function
                            .slots
                            .get(target.slot.as_usize())
                            .and_then(|slot| slot.binding);
                        let local_binding = hir_function
                            .locals
                            .get(target.local.as_usize())
                            .and_then(|local| local.binding);
                        let source_matches = source.is_some_and(|instruction| {
                            let fict_hir::HirInstructionKind::PatternAssignment {
                                writes,
                                projected_writes,
                                ..
                            } = &instruction.kind
                            else {
                                return false;
                            };
                            instruction.origin == *origin
                                && (writes.iter().any(|write| {
                                    write.local == target.local && write.origin == target.origin
                                }) || projected_writes.iter().any(|(place, origin)| {
                                    origin == &target.origin
                                        && matches!(place.base,
                                    fict_hir::PlaceBase::Local(local) if local == target.local)
                                }))
                        });
                        target.origin.primary_span.is_none()
                            || !origins.insert(target.origin)
                            || slot_binding.is_none()
                            || slot_binding != local_binding
                            || !source_matches
                    })
                {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-PATTERN",
                        "reactive pattern targets must match source HIR writes and slots",
                    ));
                }
            }
            EmitOperation::RegisterEffect {
                slot,
                source_result,
                cleanup,
                ..
            } => {
                verify_slot(function, *slot, diagnostics);
                if let Some(source_result) = source_result {
                    verify_source_result(hir_function, *source_result, diagnostics);
                }
                verify_cleanup(function, analysis, *cleanup, diagnostics);
            }
            EmitOperation::RegisterReactiveStatementEffect {
                source_result,
                origin,
                ..
            } => {
                verify_source_result(hir_function, *source_result, diagnostics);
                let statement_span = origin.primary_span;
                let matches_statement = hir_function
                    .blocks
                    .iter()
                    .flat_map(|block| &block.instructions)
                    .find(|instruction| instruction.result == Some(*source_result))
                    .is_some_and(|instruction| {
                        matches!(instruction.kind, fict_hir::HirInstructionKind::Read { .. })
                            && statement_span
                                .zip(instruction.origin.primary_span)
                                .is_some_and(|(statement, read)| {
                                    statement.start() <= read.start()
                                        && read.end() <= statement.end()
                                })
                    });
                if !hir_function.effect_statements.contains(origin) || !matches_statement {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-STATEMENT-EFFECT",
                        "reactive statement effect must match an eligible tracked source read",
                    ));
                }
            }
            EmitOperation::CreateVNode {
                template,
                source_result,
                reactive_helper,
                fragment_helper,
                ..
            } => {
                verify_source_result(hir_function, *source_result, diagnostics);
                let template = hir.templates.get(template.as_usize());
                if template.is_none_or(|item| item.owner != function.source) {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-VNODE",
                        "VNode operation must reference a JSX template owned by its function",
                    ));
                }
                if template.is_some_and(|template| {
                    template.contains_fragment
                        != (*fragment_helper == Some(RuntimeHelper::Fragment))
                }) {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-VNODE-FRAGMENT",
                        "VNode operation fragment helper must match its JSX template",
                    ));
                }
                if *reactive_helper != RuntimeHelper::ReactiveGetter {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-VNODE-REACTIVE",
                        "VNode operation must expose the reactive getter runtime helper",
                    ));
                }
            }
            EmitOperation::DeclareTemplate {
                template,
                local,
                html,
                namespace,
                ..
            } => {
                if !valid_identifier(local)
                    || html.is_empty()
                    || *namespace == DomNamespace::Parent
                    || hir
                        .templates
                        .get(template.as_usize())
                        .is_none_or(|item| item.owner != function.source)
                    || !templates.insert(*template)
                {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-TEMPLATE",
                        "template declarations must be non-empty, unique, owned, and concrete",
                    ));
                }
            }
            EmitOperation::CloneTemplate {
                template,
                source_result,
                ..
            } => {
                verify_source_result(hir_function, *source_result, diagnostics);
                if !templates.contains(template) {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-TEMPLATE-ORDER",
                        "template must be declared before cloning",
                    ));
                }
            }
            EmitOperation::InvokeComponent {
                component,
                props,
                children,
                ..
            } => {
                let target_valid = match component {
                    crate::ComponentTarget::Binding(binding) => {
                        hir.bindings.get(binding.as_usize()).is_some()
                    }
                    crate::ComponentTarget::Member { root, properties } => {
                        hir.bindings.get(root.as_usize()).is_some()
                            && !properties.is_empty()
                            && properties.iter().all(|property| !property.is_empty())
                    }
                    crate::ComponentTarget::Dynamic(_) => true,
                };
                if !target_valid
                    || props.iter().any(|prop| {
                        matches!(
                            prop,
                            crate::ComponentProp::Named { name, .. }
                                | crate::ComponentProp::Node { name, .. }
                                if name.is_empty()
                        )
                    })
                    || props.iter().any(|prop| {
                        matches!(
                            prop,
                            crate::ComponentProp::Node { origin, .. }
                                if origin.primary_span.is_none()
                        )
                    })
                    || children.iter().any(|child| {
                        matches!(
                            child,
                            crate::ComponentChild::Node(origin) if origin.primary_span.is_none()
                        )
                    })
                {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-COMPONENT",
                        "component target and prop names must retain valid semantic identity",
                    ));
                }
            }
            EmitOperation::BindEvent { cleanup, .. }
            | EmitOperation::BindRef { cleanup, .. }
            | EmitOperation::Conditional { cleanup, .. } => {
                verify_cleanup(function, analysis, *cleanup, diagnostics);
            }
            EmitOperation::ControlFlowRegion {
                outputs, origin, ..
            } => {
                let mut bindings = BTreeSet::new();
                let valid = matches!(
                    function.kind,
                    fict_hir::FunctionKind::Component | fict_hir::FunctionKind::Hook
                ) && origin.primary_span.is_some()
                    && !outputs.is_empty()
                    && outputs.iter().all(|output| {
                        let Some(local) = hir_function.locals.get(output.local.as_usize()) else {
                            return false;
                        };
                        valid_identifier(&output.name)
                            && bindings.insert(output.binding)
                            && output.declaration.primary_span.is_some()
                            && output
                                .references
                                .iter()
                                .all(|reference| reference.primary_span.is_some())
                            && output.owner_references.iter().all(|reference| {
                                reference.primary_span.is_some()
                                    && output.references.contains(reference)
                            })
                            && local.kind == fict_hir::LocalKind::User
                            && matches!(
                                local.declaration_kind,
                                fict_hir::DeclarationKind::Let | fict_hir::DeclarationKind::Var
                            )
                            && local.binding == Some(output.binding)
                            && local.debug_name.as_deref() == Some(output.name.as_str())
                            && local.origin == output.declaration
                    });
                if !valid {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-CONTROL-REGION",
                        "control-flow region outputs must be unique mutable component or hook locals with exact semantic identity",
                    ));
                }
            }
            EmitOperation::KeyedChild {
                source_result,
                render,
                render_key,
                items,
                key,
                key_source,
                key_alias_initializer,
                item_references,
                index_references,
                cleanup,
                ..
            } => {
                verify_source_result(hir_function, *source_result, diagnostics);
                verify_cleanup(function, analysis, *cleanup, diagnostics);
                if hir.functions.get(render.as_usize()).is_none()
                    || !valid_identifier(render_key)
                    || items.primary_span.is_none()
                    || key.is_some_and(|origin| origin.primary_span.is_none())
                    || key_source.is_some_and(|origin| origin.primary_span.is_none())
                    || key.is_some() != key_source.is_some()
                    || key_alias_initializer.is_some() && key.is_none()
                    || key_alias_initializer.is_some_and(|origin| origin.primary_span.is_none())
                    || item_references
                        .iter()
                        .chain(index_references)
                        .any(|origin| origin.primary_span.is_none())
                {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-KEYED-CHILD",
                        "keyed child references must retain valid functions and source origins",
                    ));
                }
            }
            EmitOperation::KeyedList {
                source_result,
                cleanup,
                ..
            } => {
                verify_source_result(hir_function, *source_result, diagnostics);
                verify_cleanup(function, analysis, *cleanup, diagnostics);
            }
            _ => {}
        }
    }
}
fn verify_source_result(
    function: &fict_hir::HirFunction,
    value: fict_hir::ValueId,
    diagnostics: &mut DiagnosticBundle,
) {
    if function.values.get(value.as_usize()).is_none() {
        diagnostics.push(emit_error(
            "FICT-EMIT-SOURCE-RESULT",
            "lowered operation references a missing source HIR result",
        ));
    }
}
fn hook_call_instruction(
    function: &fict_hir::HirFunction,
    value: fict_hir::ValueId,
) -> Option<&fict_hir::CallInstruction> {
    function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find(|instruction| instruction.result == Some(value))
        .and_then(|instruction| match &instruction.kind {
            fict_hir::HirInstructionKind::Call(call) => Some(call),
            _ => None,
        })
}
fn hook_return_shape<'a>(
    hir: &'a HirFile,
    local_hook_returns: &'a BTreeMap<fict_hir::BindingId, fict_hir::ImportedHookReturn>,
    call: &fict_hir::CallInstruction,
    expected_hook: fict_hir::BindingId,
) -> Option<&'a fict_hir::ImportedHookReturn> {
    let fict_hir::CallHost::Binding(hook_binding) = call.host else {
        return None;
    };
    if hook_binding != expected_hook {
        return None;
    }
    if call
        .callee_reference
        .as_ref()
        .is_none_or(|place| place.projections.is_empty())
        && let Some(shape) = local_hook_returns.get(&hook_binding)
    {
        return Some(shape);
    }
    let import = hir.bindings.get(hook_binding.as_usize())?.import.as_ref()?;
    match call.callee_reference.as_ref() {
        Some(place) if !place.projections.is_empty() => {
            import.resolve_hook_member(&place.projections)
        }
        Some(_) | None => import.hook_return.as_ref(),
    }
}

#[allow(clippy::too_many_arguments)]
fn verify_reactive_read(
    hir: &HirFile,
    local_hook_returns: &BTreeMap<fict_hir::BindingId, fict_hir::ImportedHookReturn>,
    hir_function: &fict_hir::HirFunction,
    function: &crate::EmitFunction,
    slot_id: crate::EmitSlotId,
    source_result: fict_hir::ValueId,
    projections: &[fict_hir::Projection],
    accessor_depth: u16,
    diagnostics: &mut DiagnosticBundle,
) {
    verify_slot(function, slot_id, diagnostics);
    verify_source_result(hir_function, source_result, diagnostics);
    let source_instruction = hir_function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find(|instruction| instruction.result == Some(source_result));
    let source_place = source_instruction.and_then(|instruction| match &instruction.kind {
        fict_hir::HirInstructionKind::Read { place } => Some(place),
        _ => None,
    });
    let slot = function.slots.get(slot_id.as_usize());
    let (basic_valid, storage_valid) = match slot.map(|slot| slot.storage) {
        Some(crate::ReactiveSlotStorage::Imported {
            member: Some(member),
        }) => {
            let basic_valid = source_place.is_some_and(|place| place.projections == projections)
                && usize::from(accessor_depth) <= projections.len();
            let root_binding = source_place.and_then(|place| {
                let local = match place.base {
                    fict_hir::PlaceBase::Local(local) => local,
                    fict_hir::PlaceBase::Ssa(name) => name.local,
                    fict_hir::PlaceBase::Global(_) | fict_hir::PlaceBase::Value(_) => return None,
                };
                hir_function.locals.get(local.as_usize())?.binding
            });
            let resolved = root_binding
                .and_then(|binding| hir.bindings.get(binding.as_usize()))
                .and_then(|binding| binding.import.as_ref())
                .and_then(|import| import.resolve_reactive_member(projections));
            let storage_valid = resolved.is_some_and(|resolved| {
                resolved.member_index == member as usize
                    && resolved.accessor_depth == usize::from(accessor_depth)
                    && slot.is_some_and(|slot| slot.binding == root_binding)
            });
            (basic_valid, storage_valid)
        }
        Some(crate::ReactiveSlotStorage::CapturedHookReturn {
            owner,
            call,
            hook: hook_binding,
            property,
        }) => {
            let local = source_place.and_then(|place| match place.base {
                fict_hir::PlaceBase::Local(local) => Some(local),
                fict_hir::PlaceBase::Ssa(name) => Some(name.local),
                fict_hir::PlaceBase::Global(_) | fict_hir::PlaceBase::Value(_) => None,
            });
            let binding_matches = local.is_some_and(|local| {
                hir_function
                    .locals
                    .get(local.as_usize())
                    .is_some_and(|local| {
                        local.kind == fict_hir::LocalKind::Capture
                            && slot.is_some_and(|slot| slot.binding == local.binding)
                    })
            });
            let shape = hir
                .functions
                .get(owner.as_usize())
                .and_then(|owner| hook_call_instruction(owner, call))
                .and_then(|call| hook_return_shape(hir, local_hook_returns, call, hook_binding));
            let resolved_property = source_place
                .and_then(|place| place.projections.first())
                .and_then(|projection| shape?.resolve_property(projection));
            let kind_matches = slot.is_some_and(|slot| {
                matches!(
                    (property.kind, slot.kind),
                    (
                        fict_hir::ImportedReactiveKind::Signal,
                        crate::ReactiveSlotKind::Signal
                    ) | (
                        fict_hir::ImportedReactiveKind::Memo,
                        crate::ReactiveSlotKind::Memo
                    )
                )
            });
            (
                source_place.is_some_and(|place| place.projections == projections)
                    && !projections.is_empty()
                    && accessor_depth == 1,
                binding_matches
                    && kind_matches
                    && shape.is_some_and(|shape| shape.direct_accessor.is_none())
                    && resolved_property == Some(property),
            )
        }
        Some(crate::ReactiveSlotStorage::Imported { member: None })
        | Some(crate::ReactiveSlotStorage::Owned)
        | Some(crate::ReactiveSlotStorage::Captured { .. }) => (
            source_place.is_some_and(|place| place.projections == projections)
                && usize::from(accessor_depth) <= projections.len(),
            accessor_depth == 0,
        ),
        Some(crate::ReactiveSlotStorage::HookReturn {
            call,
            hook: hook_binding,
            property,
        }) => {
            let local = source_place.and_then(|place| match place.base {
                fict_hir::PlaceBase::Local(local) => Some(local),
                fict_hir::PlaceBase::Ssa(name) => Some(name.local),
                fict_hir::PlaceBase::Global(_) | fict_hir::PlaceBase::Value(_) => None,
            });
            let local_call = local.is_some_and(|local| {
                hir_function
                    .blocks
                    .iter()
                    .flat_map(|block| &block.instructions)
                    .any(|instruction| {
                        matches!(
                            instruction.kind,
                            fict_hir::HirInstructionKind::Declare {
                                local: declared,
                                initializer: Some(initializer),
                                ..
                            } if declared == local && initializer == call
                        )
                    })
            }) && local.is_some_and(|local| {
                slot.is_some_and(|slot| {
                    slot.binding
                        == hir_function
                            .locals
                            .get(local.as_usize())
                            .and_then(|local| local.binding)
                })
            });
            let shape = hook_call_instruction(hir_function, call)
                .and_then(|call| hook_return_shape(hir, local_hook_returns, call, hook_binding));
            let reactive_kind = match property {
                None => shape.and_then(|shape| shape.direct_accessor),
                Some(property) => Some(property.kind),
            };
            let kind_matches = slot.is_some_and(|slot| {
                matches!(
                    (reactive_kind, slot.kind),
                    (
                        Some(fict_hir::ImportedReactiveKind::Signal),
                        crate::ReactiveSlotKind::Signal
                    ) | (
                        Some(fict_hir::ImportedReactiveKind::Memo),
                        crate::ReactiveSlotKind::Memo
                    )
                )
            });
            match property {
                None => {
                    let direct_call = source_result == call
                        && source_instruction.is_some_and(|instruction| {
                            matches!(instruction.kind, fict_hir::HirInstructionKind::Call(_))
                        });
                    (
                        projections.is_empty()
                            && accessor_depth == 0
                            && (direct_call
                                || (local_call
                                    && source_place
                                        .is_some_and(|place| place.projections.is_empty()))),
                        kind_matches,
                    )
                }
                Some(property) => {
                    let direct_call = source_place.is_some_and(|place| {
                        matches!(place.base, fict_hir::PlaceBase::Value(value) if value == call)
                    });
                    let binding_matches = if direct_call {
                        slot.is_some_and(|slot| slot.binding.is_none())
                    } else {
                        local_call
                    };
                    let resolved_property = source_place
                        .and_then(|place| place.projections.first())
                        .and_then(|projection| shape?.resolve_property(projection));
                    (
                        source_place.is_some_and(|place| place.projections == projections)
                            && !projections.is_empty()
                            && accessor_depth == 1
                            && (direct_call || local_call),
                        kind_matches
                            && binding_matches
                            && shape.is_some_and(|shape| shape.direct_accessor.is_none())
                            && resolved_property == Some(property),
                    )
                }
            }
        }
        None => (false, false),
    };
    if !basic_valid || !storage_valid {
        diagnostics.push(emit_error(
            "FICT-EMIT-REACTIVE-READ",
            "reactive reads must match their source place, slot storage, and accessor depth",
        ));
    }
}

fn verify_helper_semantics(
    function: &crate::EmitFunction,
    operation: &EmitOperation,
    diagnostics: &mut DiagnosticBundle,
) {
    let valid = match operation {
        EmitOperation::CreateReactive { slot, helper, .. } => {
            function.slots.get(slot.as_usize()).is_some_and(|slot| {
                slot.storage == crate::ReactiveSlotStorage::Owned
                    && match slot.kind {
                        crate::ReactiveSlotKind::Signal => {
                            matches!(helper, RuntimeHelper::Signal | RuntimeHelper::UseSignal)
                        }
                        crate::ReactiveSlotKind::Memo => {
                            matches!(helper, RuntimeHelper::Memo | RuntimeHelper::UseMemo)
                        }
                        crate::ReactiveSlotKind::Selector => {
                            *helper == RuntimeHelper::CreateSelector
                        }
                        crate::ReactiveSlotKind::Effect
                        | crate::ReactiveSlotKind::Context
                        | crate::ReactiveSlotKind::Store
                        | crate::ReactiveSlotKind::Resource => false,
                    }
            })
        }
        EmitOperation::CreateDerived { slot, helper, .. } => {
            function.slots.get(slot.as_usize()).is_some_and(|slot| {
                slot.storage == crate::ReactiveSlotStorage::Owned
                    && slot.kind == crate::ReactiveSlotKind::Memo
                    && helper.is_none_or(|helper| {
                        matches!(helper, RuntimeHelper::Memo | RuntimeHelper::UseMemo)
                    })
            })
        }
        EmitOperation::RegisterEffect { helper, .. }
        | EmitOperation::RegisterReactiveStatementEffect { helper, .. } => {
            matches!(helper, RuntimeHelper::Effect | RuntimeHelper::UseEffect)
        }
        EmitOperation::DeclareTemplate { helper, .. } => *helper == RuntimeHelper::Template,
        EmitOperation::BindDom {
            kind,
            value,
            reactive,
            helper,
            ..
        } => {
            (!matches!(value, crate::EmitValueRef::Text(_))
                || matches!(kind, crate::DomBindingKind::TextContent))
                && match (kind, reactive) {
                    (crate::DomBindingKind::Text, true) => *helper == RuntimeHelper::BindText,
                    (crate::DomBindingKind::Text, false) => *helper == RuntimeHelper::SetText,
                    (crate::DomBindingKind::TextContent, true) => {
                        *helper == RuntimeHelper::BindTextContent
                    }
                    (crate::DomBindingKind::TextContent, false) => {
                        *helper == RuntimeHelper::SetTextContent
                    }
                    (crate::DomBindingKind::Attribute(_), true) => {
                        *helper == RuntimeHelper::BindAttribute
                    }
                    (crate::DomBindingKind::Attribute(_), false) => {
                        *helper == RuntimeHelper::SetAttr
                    }
                    (crate::DomBindingKind::BooleanAttribute(_), true) => {
                        *helper == RuntimeHelper::BindBooleanAttribute
                    }
                    (crate::DomBindingKind::BooleanAttribute(_), false) => {
                        *helper == RuntimeHelper::SetBooleanAttribute
                    }
                    (crate::DomBindingKind::Property(_), true) => {
                        *helper == RuntimeHelper::BindProperty
                    }
                    (crate::DomBindingKind::Property(_), false) => {
                        *helper == RuntimeHelper::SetProp
                    }
                    (crate::DomBindingKind::Class, true) => *helper == RuntimeHelper::BindClass,
                    (crate::DomBindingKind::Class, false) => *helper == RuntimeHelper::SetClass,
                    (crate::DomBindingKind::Style, true) => *helper == RuntimeHelper::BindStyle,
                    (crate::DomBindingKind::Style, false) => *helper == RuntimeHelper::SetStyle,
                    (crate::DomBindingKind::Spread, _) => *helper == RuntimeHelper::Spread,
                }
        }
        EmitOperation::ApplyProps { helper, .. } => *helper == RuntimeHelper::Spread,
        EmitOperation::BindEvent {
            event,
            options,
            delegated,
            helper,
            cleanup_helper,
            ..
        } => {
            if event.is_empty() {
                false
            } else if *delegated {
                options.is_empty()
                    && *helper == RuntimeHelper::AddEventListener
                    && cleanup_helper.is_none()
            } else {
                *helper == RuntimeHelper::BindEvent
                    && *cleanup_helper == Some(RuntimeHelper::OnDestroy)
            }
        }
        EmitOperation::BindRef { helper, .. } => *helper == RuntimeHelper::BindRef,
        EmitOperation::Insert {
            namespace,
            helper,
            create_helper,
            fragment_helper,
            ..
        } => {
            *helper == RuntimeHelper::Insert
                && fragment_helper.is_none_or(|helper| helper == RuntimeHelper::Fragment)
                && match namespace {
                    DomNamespace::Html => *create_helper == RuntimeHelper::CreateElement,
                    DomNamespace::Svg
                    | DomNamespace::MathMl
                    | DomNamespace::MathMlTextIntegration
                    | DomNamespace::MathMlAnnotationXml => {
                        *create_helper == RuntimeHelper::CreateElementInNamespace
                    }
                    DomNamespace::Parent => {
                        *create_helper == RuntimeHelper::CreateElementInParentNamespace
                    }
                }
        }
        EmitOperation::Conditional {
            namespace,
            helper,
            create_helper,
            cleanup_helper,
            fragment_helper,
            ..
        } => {
            *helper == RuntimeHelper::Conditional
                && *cleanup_helper == RuntimeHelper::OnDestroy
                && fragment_helper.is_none_or(|helper| helper == RuntimeHelper::Fragment)
                && match namespace {
                    DomNamespace::Html => *create_helper == RuntimeHelper::CreateElement,
                    DomNamespace::Svg
                    | DomNamespace::MathMl
                    | DomNamespace::MathMlTextIntegration
                    | DomNamespace::MathMlAnnotationXml => {
                        *create_helper == RuntimeHelper::CreateElementInNamespace
                    }
                    DomNamespace::Parent => {
                        *create_helper == RuntimeHelper::CreateElementInParentNamespace
                    }
                }
        }
        EmitOperation::ConditionalReturn {
            helper,
            create_helper,
            cleanup_helper,
            track_branch_reads,
            covered_control_flow,
            origin,
            ..
        } => {
            *helper == RuntimeHelper::Conditional
                && *create_helper == RuntimeHelper::CreateElement
                && *cleanup_helper == RuntimeHelper::OnDestroy
                && !covered_control_flow.is_empty()
                && origin
                    .primary_span
                    .is_some_and(|span| covered_control_flow.binary_search(&span).is_ok())
                && covered_control_flow
                    .windows(2)
                    .all(|pair| pair[0] < pair[1])
                && (*track_branch_reads || covered_control_flow.len() == 1)
        }
        EmitOperation::ControlFlowRegion {
            helper, outputs, ..
        } => *helper == RuntimeHelper::UseMemo && !outputs.is_empty(),
        EmitOperation::KeyedChild {
            helper,
            cleanup_helper,
            ..
        } => *helper == RuntimeHelper::KeyedList && *cleanup_helper == RuntimeHelper::OnDestroy,
        EmitOperation::KeyedList { helper, .. } => *helper == RuntimeHelper::KeyedList,
        EmitOperation::ReadReactive { helper, .. } => {
            helper.is_none_or(|helper| helper == RuntimeHelper::ReactiveGetter)
        }
        EmitOperation::CreateVNode {
            reactive_helper,
            fragment_helper,
            ..
        } => {
            *reactive_helper == RuntimeHelper::ReactiveGetter
                && fragment_helper.is_none_or(|helper| helper == RuntimeHelper::Fragment)
        }
        EmitOperation::CloneTemplate {
            namespace_helper,
            reactive_helper,
            fragment_helper,
            ..
        } => {
            namespace_helper.is_none_or(|helper| helper == RuntimeHelper::ElementNamespaceMatches)
                && reactive_helper.is_none_or(|helper| helper == RuntimeHelper::ReactiveGetter)
                && fragment_helper.is_none_or(|helper| helper == RuntimeHelper::Fragment)
        }
        EmitOperation::ResolveElement { helper, path, .. } => {
            *helper == RuntimeHelper::ResolvePath && !path.is_empty()
        }
        EmitOperation::InvokeComponent {
            props,
            children,
            prop_helper,
            children_helper,
            merge_helper,
            non_reactive_helper,
            reactive_function_helper,
            vnode_reactive_helper,
            fragment_helper,
            ..
        } => {
            let needs_prop = props.iter().any(|prop| {
                matches!(
                    prop,
                    crate::ComponentProp::Named { getter: true, .. }
                        | crate::ComponentProp::Spread { getter: true, .. }
                )
            });
            let needs_merge = props
                .iter()
                .any(|prop| matches!(prop, crate::ComponentProp::Spread { .. }));
            let needs_children = children
                .iter()
                .any(|child| matches!(child, crate::ComponentChild::Value { getter: true, .. }));
            let needs_non_reactive = props.iter().any(|prop| {
                matches!(
                    prop,
                    crate::ComponentProp::Named {
                        non_reactive: true,
                        ..
                    }
                )
            }) || children.iter().any(|child| {
                matches!(
                    child,
                    crate::ComponentChild::Value {
                        non_reactive: true,
                        ..
                    }
                )
            });
            let needs_reactive_function = props.iter().any(|prop| {
                matches!(
                    prop,
                    crate::ComponentProp::Named {
                        reactive_function: true,
                        ..
                    }
                )
            });
            let needs_vnode_reactive = props
                .iter()
                .any(|prop| matches!(prop, crate::ComponentProp::Node { .. }))
                || children
                    .iter()
                    .any(|child| matches!(child, crate::ComponentChild::Node(_)));
            let wrappers_exclusive = props.iter().all(|prop| {
                let crate::ComponentProp::Named {
                    getter,
                    non_reactive,
                    reactive_function,
                    ..
                } = prop
                else {
                    return true;
                };
                usize::from(*getter) + usize::from(*non_reactive) + usize::from(*reactive_function)
                    <= 1
            }) && children.iter().all(|child| {
                !matches!(
                    child,
                    crate::ComponentChild::Value {
                        getter: true,
                        non_reactive: true,
                        ..
                    }
                )
            });
            wrappers_exclusive
                && *prop_helper == needs_prop.then_some(RuntimeHelper::PropGetter)
                && *children_helper == needs_children.then_some(RuntimeHelper::Prop)
                && *merge_helper == needs_merge.then_some(RuntimeHelper::MergeProps)
                && *non_reactive_helper == needs_non_reactive.then_some(RuntimeHelper::NonReactive)
                && *reactive_function_helper
                    == needs_reactive_function.then_some(RuntimeHelper::ReactiveGetter)
                && *vnode_reactive_helper
                    == needs_vnode_reactive.then_some(RuntimeHelper::ReactiveGetter)
                && fragment_helper.is_none_or(|helper| helper == RuntimeHelper::Fragment)
        }
        EmitOperation::PreserveHir { .. }
        | EmitOperation::TrackRuntimeReactive { .. }
        | EmitOperation::WriteReactive { .. }
        | EmitOperation::WriteReactivePattern { .. }
        | EmitOperation::UpdateReactive { .. }
        | EmitOperation::DeleteReactive { .. }
        | EmitOperation::Evaluate { .. }
        | EmitOperation::Return { .. } => true,
    };
    if !valid {
        diagnostics.push(emit_error(
            "FICT-EMIT-HELPER",
            "operation uses a runtime helper incompatible with its semantics",
        ));
    }
}

fn verify_runtime_reactive_site(
    hir_function: &fict_hir::HirFunction,
    function: &crate::EmitFunction,
    slot: crate::EmitSlotId,
    source_result: fict_hir::ValueId,
    local: Option<fict_hir::LocalId>,
    diagnostics: &mut DiagnosticBundle,
) {
    let source_kind = hir_function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find_map(|instruction| {
            (instruction.result == Some(source_result)).then_some(match &instruction.kind {
                fict_hir::HirInstructionKind::Call(call) => call.reactive_kind,
                _ => None,
            })
        })
        .flatten();
    let expected = match source_kind {
        Some(fict_hir::ReactiveCallKind::Memo) => crate::ReactiveSlotKind::Memo,
        Some(fict_hir::ReactiveCallKind::Store) => crate::ReactiveSlotKind::Store,
        Some(fict_hir::ReactiveCallKind::Resource) => crate::ReactiveSlotKind::Resource,
        Some(fict_hir::ReactiveCallKind::Selector) => crate::ReactiveSlotKind::Selector,
        None => {
            diagnostics.push(emit_error(
                "FICT-EMIT-RUNTIME-REACTIVE",
                "tracked runtime reactive slot must originate from a classified HIR call",
            ));
            return;
        }
    };
    if function
        .slots
        .get(slot.as_usize())
        .is_none_or(|actual| actual.kind != expected)
    {
        diagnostics.push(emit_error(
            "FICT-EMIT-RUNTIME-REACTIVE",
            "runtime reactive call kind must match its EmitIR slot kind",
        ));
    }
    if let Some(local) = local
        && (hir_function.locals.get(local.as_usize()).is_none()
            || !hir_function.blocks.iter().any(|block| {
                block.instructions.iter().any(|instruction| {
                    matches!(
                        instruction.kind,
                        fict_hir::HirInstructionKind::Declare {
                            local: declared,
                            initializer: Some(initializer),
                            ..
                        } if declared == local && initializer == source_result
                    )
                })
            }))
    {
        diagnostics.push(emit_error(
            "FICT-EMIT-RUNTIME-REACTIVE",
            "runtime reactive local must be declared from the classified call result",
        ));
    }
}

fn verify_slot(
    function: &crate::EmitFunction,
    slot: crate::EmitSlotId,
    diagnostics: &mut DiagnosticBundle,
) {
    if function.slots.get(slot.as_usize()).is_none() {
        diagnostics.push(emit_error(
            "FICT-EMIT-SLOT-USE",
            "operation references an unknown slot",
        ));
    }
}

fn verify_cleanup(
    function: &crate::EmitFunction,
    analysis: Option<&RegionAnalysis>,
    cleanup: CleanupOwner,
    diagnostics: &mut DiagnosticBundle,
) {
    let valid = match cleanup {
        CleanupOwner::Slot(slot) => function.slots.get(slot.as_usize()).is_some(),
        CleanupOwner::Region(region) => {
            analysis.is_some_and(|analysis| analysis.regions.get(region.as_usize()).is_some())
        }
        CleanupOwner::Function => true,
    };
    if !valid {
        diagnostics.push(emit_error("FICT-EMIT-CLEANUP", "cleanup owner is unknown"));
    }
}

fn valid_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    (first == b'$' || first == b'_' || first.is_ascii_alphabetic())
        && bytes.all(|byte| byte == b'$' || byte == b'_' || byte.is_ascii_alphanumeric())
}

fn emit_error(code: &'static str, message: impl Into<String>) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("EmitIR diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(GuaranteeClass::Internal)
}
