use std::collections::BTreeSet;

use fict_diagnostics::Diagnostic;
use fict_emit::{EmitOperation, EmitProgram, EmitValueRef};
use fict_hir::{
    FunctionId, HirFile, HirFunction, HirInstructionKind, Origin, PlaceBase, ValueId, ValueKind,
};

/// Remove the early E001 advisory only when verified EmitIR proves that the registered effect
/// callback reads a control-flow-region accessor. The frontend cannot see that later rewrite and
/// otherwise mistakes the region output for a non-reactive local snapshot.
pub(crate) fn suppress_region_backed_effect_advisories(
    diagnostics: &mut Vec<Diagnostic>,
    hir: Option<&HirFile>,
    emit: Option<&EmitProgram>,
) {
    let (Some(hir), Some(emit)) = (hir, emit) else {
        return;
    };
    let mut region_backed_effects = BTreeSet::new();
    for function in &emit.functions {
        let Some(owner) = hir.functions.get(function.source.as_usize()) else {
            continue;
        };
        let region_references: Vec<_> = function
            .operations
            .iter()
            .filter_map(|operation| match operation {
                EmitOperation::ControlFlowRegion { outputs, .. } => Some(outputs),
                _ => None,
            })
            .flatten()
            .flat_map(|output| &output.references)
            .copied()
            .collect();
        if region_references.is_empty() {
            continue;
        }
        for operation in &function.operations {
            let EmitOperation::RegisterEffect {
                callback, origin, ..
            } = operation
            else {
                continue;
            };
            let Some(effect_span) = origin.primary_span else {
                continue;
            };
            let Some(callback) = resolve_callback_function(hir, owner, callback) else {
                continue;
            };
            let Some(callback) = hir.functions.get(callback.as_usize()) else {
                continue;
            };
            if region_references
                .iter()
                .any(|reference| directly_reads_reference(callback, *reference))
            {
                region_backed_effects.insert(effect_span);
            }
        }
    }
    diagnostics.retain(|diagnostic| {
        diagnostic.code.as_str() != "FICT-E001"
            || diagnostic
                .primary_span
                .is_none_or(|span| !region_backed_effects.contains(&span))
    });
}

fn resolve_callback_function(
    hir: &HirFile,
    owner: &HirFunction,
    callback: &EmitValueRef,
) -> Option<FunctionId> {
    match callback {
        EmitValueRef::Function(function) => Some(*function),
        EmitValueRef::Hir(value) => {
            resolve_value_function(hir, owner, *value, &mut BTreeSet::new())
        }
        EmitValueRef::Ssa(_)
        | EmitValueRef::Slot(_)
        | EmitValueRef::Temporary(_)
        | EmitValueRef::Literal(_)
        | EmitValueRef::Binding(_)
        | EmitValueRef::Text(_) => None,
    }
}

fn resolve_value_function(
    hir: &HirFile,
    function: &HirFunction,
    value: ValueId,
    visited: &mut BTreeSet<ValueId>,
) -> Option<FunctionId> {
    if !visited.insert(value) {
        return None;
    }
    if let ValueKind::Function(nested) = function.values.get(value.as_usize())?.kind {
        return Some(nested);
    }
    let instruction = function.instruction_for_result(value)?;
    if matches!(instruction.kind, HirInstructionKind::SyntaxFragment { .. }) {
        let origin = function.values.get(value.as_usize())?.origin.primary_span?;
        for candidate in function
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .rev()
            .filter_map(|candidate| candidate.result.map(|result| (candidate, result)))
            .filter(|(candidate, result)| {
                *result != value && candidate.origin.primary_span == Some(origin)
            })
        {
            if let Some(resolved) = resolve_value_function(hir, function, candidate.1, visited) {
                return Some(resolved);
            }
        }
        return None;
    }
    let HirInstructionKind::Read { place } = &instruction.kind else {
        return None;
    };
    if !place.projections.is_empty() {
        return None;
    }
    let local = match place.base {
        PlaceBase::Local(local) => local,
        PlaceBase::Ssa(name) => name.local,
        PlaceBase::Global(_) | PlaceBase::Value(_) => return None,
    };
    for declaration in function.blocks.iter().flat_map(|block| &block.instructions) {
        let HirInstructionKind::Declare {
            local: declared,
            initializer: Some(initializer),
            ..
        } = declaration.kind
        else {
            continue;
        };
        if declared == local {
            return resolve_value_function(hir, function, initializer, visited);
        }
    }
    let binding = function.locals.get(local.as_usize())?.binding?;
    hir.functions
        .iter()
        .find(|candidate| candidate.binding == Some(binding))
        .map(|candidate| candidate.id)
}

fn directly_reads_reference(function: &HirFunction, reference: Origin) -> bool {
    function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .any(|instruction| instruction.origin.primary_span == reference.primary_span)
}
