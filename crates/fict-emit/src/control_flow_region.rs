use std::{cmp::Reverse, collections::BTreeSet};

use fict_hir::{
    DeclarationKind, FunctionKind, HirFile, HirFunction, HirInstruction, HirInstructionKind,
    LocalId, LocalKind, Place, PlaceBase, SourceSpan, StructuredSourceKind, TerminatorKind,
};
use fict_reactivity::{StructuredConstructKind, StructurizeAnalysis};

use crate::{
    ControlFlowRegionOutput, EmitOperation, EmitTemporary, EmitTemporaryId, RuntimeHelper,
    name_allocator::NameAllocator,
};

/// Lower the conservative subset of statement control flow whose assigned locals escape the
/// dispatcher. Strict-guarantee policy still rejects FICT-R006 before code generation; this plan
/// makes the explicitly requested fallback mode live instead of silently retaining a first-render
/// snapshot.
pub(crate) fn lower_control_flow_regions(
    hir: &HirFile,
    function: &HirFunction,
    control_flow: &StructurizeAnalysis,
    temporaries: &mut Vec<EmitTemporary>,
    names: &mut NameAllocator,
    operations: &mut Vec<EmitOperation>,
) {
    if !matches!(function.kind, FunctionKind::Component | FunctionKind::Hook)
        || function.flags.no_memo
        || function.flags.is_async
        || function.flags.is_generator
    {
        return;
    }

    let reactive_locals: BTreeSet<_> = operations
        .iter()
        .filter_map(|operation| match operation {
            EmitOperation::CreateReactive {
                local: Some(local), ..
            }
            | EmitOperation::TrackRuntimeReactive {
                local: Some(local), ..
            } => Some(*local),
            _ => None,
        })
        .collect();

    let mut constructs: Vec<_> = control_flow
        .top_level_constructs
        .iter()
        .filter_map(|id| control_flow.constructs.get(*id as usize))
        .collect();
    constructs.sort_by_key(|construct| {
        function.blocks[construct.header.as_usize()]
            .source_hint
            .as_ref()
            .and_then(|hint| hint.origin.primary_span)
            .map_or((u32::MAX, Reverse(0)), |span| {
                (span.start(), Reverse(span.end()))
            })
    });
    let mut covered = Vec::new();
    for construct in constructs {
        if !matches!(
            construct.kind,
            StructuredConstructKind::Conditional { .. }
                | StructuredConstructKind::Switch { .. }
                | StructuredConstructKind::Try { .. }
                | StructuredConstructKind::Loop { .. }
        ) {
            continue;
        }
        let Some(origin) = function.blocks[construct.header.as_usize()]
            .source_hint
            .as_ref()
            .filter(|hint| {
                matches!(
                    (&construct.kind, &hint.kind),
                    (
                        StructuredConstructKind::Conditional { .. },
                        StructuredSourceKind::Conditional
                    ) | (
                        StructuredConstructKind::Switch { .. },
                        StructuredSourceKind::Switch
                    ) | (
                        StructuredConstructKind::Try { .. },
                        StructuredSourceKind::Try
                    ) | (
                        StructuredConstructKind::Loop { .. },
                        StructuredSourceKind::WhileLoop
                            | StructuredSourceKind::DoWhileLoop
                            | StructuredSourceKind::ForLoop
                            | StructuredSourceKind::ForOfLoop
                            | StructuredSourceKind::ForAwaitOfLoop
                            | StructuredSourceKind::ForInLoop
                    )
                )
            })
            .map(|hint| hint.origin)
        else {
            continue;
        };
        let Some(control_span) = origin.primary_span else {
            continue;
        };
        let exits_function = construct.blocks.iter().any(|block| {
            matches!(
                &function.blocks[block.as_usize()].terminator.kind,
                TerminatorKind::Return { .. } | TerminatorKind::Throw { .. }
            )
        });
        if exits_function
            && (function.kind == FunctionKind::Hook
                || matches!(construct.kind, StructuredConstructKind::Loop { .. }))
        {
            continue;
        }
        if operations.iter().any(|operation| {
            matches!(operation, EmitOperation::ConditionalReturn { origin, .. }
                if origin.primary_span == Some(control_span))
        }) {
            continue;
        }
        if covered
            .iter()
            .copied()
            .any(|outer| contains(outer, control_span))
        {
            continue;
        }
        let story_blocks: BTreeSet<_> = construct.blocks.iter().copied().collect();
        if !crate::conditional_return::story_has_reactive_control(
            function,
            operations,
            &story_blocks,
        ) {
            continue;
        }

        let assigned: BTreeSet<_> = construct
            .blocks
            .iter()
            .flat_map(|block| &function.blocks[block.as_usize()].instructions)
            .filter(|instruction| {
                instruction
                    .origin
                    .primary_span
                    .is_some_and(|span| contains(control_span, span))
            })
            .flat_map(region_output_writes)
            .collect();

        let mut outputs: Vec<_> = assigned
            .into_iter()
            .filter_map(|local| {
                output_for_local(hir, function, local, control_span, &reactive_locals)
            })
            .collect();
        outputs.sort_by_key(|output| {
            output
                .declaration
                .primary_span
                .map_or(u32::MAX, SourceSpan::start)
        });
        outputs.dedup_by_key(|output| output.binding);
        if outputs.is_empty() {
            continue;
        }
        covered.push(control_span);

        let id = EmitTemporaryId::new(u32::try_from(temporaries.len()).unwrap_or(u32::MAX));
        temporaries.push(EmitTemporary {
            id,
            name: names.allocate("__fict_region"),
            origin,
        });
        operations.push(EmitOperation::ControlFlowRegion {
            target: id,
            helper: RuntimeHelper::UseMemo,
            outputs,
            origin,
        });
    }
}

fn output_for_local(
    hir: &HirFile,
    function: &HirFunction,
    local: LocalId,
    control_span: SourceSpan,
    reactive_locals: &BTreeSet<LocalId>,
) -> Option<ControlFlowRegionOutput> {
    let storage = function.locals.get(local.as_usize())?;
    let declaration = storage.origin.primary_span?;
    let declaration_is_outer = declaration.start() < control_span.start();
    let declaration_is_region_var =
        storage.declaration_kind == DeclarationKind::Var && contains(control_span, declaration);
    if storage.kind != LocalKind::User
        || storage.scope != function.scope
        || !matches!(
            storage.declaration_kind,
            DeclarationKind::Let | DeclarationKind::Var
        )
        || (!declaration_is_outer && !declaration_is_region_var)
        || reactive_locals.contains(&local)
    {
        return None;
    }

    let mut references = Vec::new();
    let mut owner_references = Vec::new();
    let mut read_inside = false;
    for instruction in function.blocks.iter().flat_map(|block| &block.instructions) {
        let span = instruction.origin.primary_span;
        if direct_writes(instruction).any(|candidate| candidate == local)
            && !span.is_some_and(|span| contains(control_span, span))
        {
            return None;
        }
        if reads_local(instruction, local) {
            let span = span?;
            if contains(control_span, span) {
                read_inside = true;
                continue;
            }
            if span.start() < control_span.start() {
                // Immediate reads before the dispatcher would observe the authored outer binding;
                // moving that binding into a lazy memo would change evaluation order.
                return None;
            }
            references.push(instruction.origin);
            owner_references.push(instruction.origin);
        }
    }

    let binding = storage.binding?;
    for candidate in &hir.functions {
        if candidate.id == function.id || !is_descendant(hir, candidate, function) {
            continue;
        }
        for capture in candidate
            .locals
            .iter()
            .filter(|capture| capture.binding == Some(binding))
        {
            for instruction in candidate
                .blocks
                .iter()
                .flat_map(|block| &block.instructions)
            {
                if direct_writes(instruction).any(|local| local == capture.id) {
                    return None;
                }
                if reads_local(instruction, capture.id) {
                    let span = instruction.origin.primary_span?;
                    if contains(control_span, span) {
                        read_inside = true;
                    } else if span.start() < control_span.start() {
                        return None;
                    } else {
                        references.push(instruction.origin);
                    }
                }
            }
        }
    }
    references.sort_by_key(|origin| {
        origin
            .primary_span
            .map_or((u32::MAX, u32::MAX), |span| (span.start(), span.end()))
    });
    references.dedup();
    owner_references.sort_by_key(|origin| {
        origin
            .primary_span
            .map_or((u32::MAX, u32::MAX), |span| (span.start(), span.end()))
    });
    owner_references.dedup();
    if references.is_empty() && !read_inside {
        return None;
    }

    Some(ControlFlowRegionOutput {
        local,
        binding,
        name: storage.debug_name.clone()?,
        declaration: storage.origin,
        references,
        owner_references,
    })
}

fn is_descendant(hir: &HirFile, candidate: &HirFunction, ancestor: &HirFunction) -> bool {
    let mut parent = candidate.parent;
    for _ in 0..hir.functions.len() {
        if parent == ancestor.id {
            return true;
        }
        let Some(function) = hir.functions.get(parent.as_usize()) else {
            return false;
        };
        if function.parent == parent {
            return false;
        }
        parent = function.parent;
    }
    false
}

fn direct_writes(instruction: &HirInstruction) -> impl Iterator<Item = LocalId> + '_ {
    let mut locals = Vec::new();
    match &instruction.kind {
        HirInstructionKind::Write { place, .. } | HirInstructionKind::ReadWrite { place, .. } => {
            if let Some(local) = direct_local(place) {
                locals.push(local);
            }
        }
        HirInstructionKind::PatternAssignment { writes, .. } => {
            locals.extend(writes.iter().map(|write| write.local));
        }
        HirInstructionKind::Iteration { targets, .. } => {
            locals.extend(targets.iter().copied());
        }
        _ => {}
    }
    locals.into_iter()
}

fn region_output_writes(instruction: &HirInstruction) -> impl Iterator<Item = LocalId> + '_ {
    let mut locals: Vec<_> = direct_writes(instruction).collect();
    if let HirInstructionKind::Declare {
        local,
        declaration_kind: DeclarationKind::Var,
        ..
    } = &instruction.kind
    {
        locals.push(*local);
    }
    locals.into_iter()
}

fn reads_local(instruction: &HirInstruction, local: LocalId) -> bool {
    match &instruction.kind {
        HirInstructionKind::Read { place } | HirInstructionKind::ReadWrite { place, .. } => {
            place_local(place) == Some(local)
        }
        _ => false,
    }
}

fn direct_local(place: &Place) -> Option<LocalId> {
    place
        .projections
        .is_empty()
        .then(|| place_local(place))
        .flatten()
}

fn place_local(place: &Place) -> Option<LocalId> {
    match place.base {
        PlaceBase::Local(local) => Some(local),
        PlaceBase::Ssa(name) => Some(name.local),
        PlaceBase::Global(_) | PlaceBase::Value(_) => None,
    }
}

fn contains(outer: SourceSpan, inner: SourceSpan) -> bool {
    outer.start() <= inner.start() && inner.end() <= outer.end()
}
