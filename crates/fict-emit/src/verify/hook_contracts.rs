//! Verify hook return sources and accessor read contracts.

use super::*;

pub(super) fn verify_source_result(
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
pub(super) fn hook_call_instruction(
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
pub(super) fn hook_return_shape<'a>(
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
pub(super) fn verify_reactive_read(
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
            let kind_matches =
                slot.is_some_and(|slot| accessor_kind_matches(Some(property.kind), slot.kind));
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
        | Some(crate::ReactiveSlotStorage::HookBinding)
        | Some(crate::ReactiveSlotStorage::Owned)
        | Some(crate::ReactiveSlotStorage::Alias { .. })
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
            let kind_matches =
                slot.is_some_and(|slot| accessor_kind_matches(reactive_kind, slot.kind));
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
