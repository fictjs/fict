use crate::{
    EmitOperation, EmitTemporary, EmitTemporaryId, RuntimeHelper, name_allocator::NameAllocator,
};
use fict_hir::{
    BlockId, FunctionKind, HirFile, HirFunction, HirInstructionKind, LiteralValue, Origin,
    OriginKind, PlaceBase, SourceSpan, TerminatorKind, UnaryOperator, ValueId, ValueKind,
};
use fict_reactivity::{StructuredConstructKind, StructurizeAnalysis};
use std::collections::BTreeSet;
pub(crate) fn lower_conditional_returns(
    hir: &HirFile,
    function: &HirFunction,
    control_flow: &StructurizeAnalysis,
    temporaries: &mut Vec<EmitTemporary>,
    names: &mut NameAllocator,
    operations: &mut Vec<EmitOperation>,
) {
    if function.kind != FunctionKind::Component {
        return;
    }
    let mut plans = Vec::new();
    for block in &function.blocks {
        let TerminatorKind::Return { value: Some(value) } = block.terminator.kind else {
            continue;
        };
        let Some(instruction) = function.instruction_for_result(value) else {
            continue;
        };
        let HirInstructionKind::Conditional {
            test,
            consequent,
            alternate,
        } = &instruction.kind
        else {
            continue;
        };
        let Some(test_span) = function.values[test.as_usize()].origin.primary_span else {
            continue;
        };
        if reactive_test(function, operations, test_span)
            && let Some(consequent) =
                renderable_return_value(hir, function, Some(*consequent), instruction.origin)
            && let Some(alternate) =
                renderable_return_value(hir, function, Some(*alternate), instruction.origin)
            && consequent != alternate
        {
            plans.push((
                instruction.origin,
                false,
                exact_control_flow_coverage(instruction.origin),
            ));
        }
    }
    let mut dynamic_blocks = BTreeSet::new();
    for construct in control_flow
        .top_level_constructs
        .iter()
        .filter_map(|id| control_flow.constructs.get(*id as usize))
    {
        if !matches!(
            construct.kind,
            StructuredConstructKind::Conditional { .. } | StructuredConstructKind::Switch { .. }
        ) {
            continue;
        }
        let block = &function.blocks[construct.header.as_usize()];
        let Some(hint) = &block.source_hint else {
            continue;
        };
        if let StructuredConstructKind::Conditional { .. } = construct.kind
            && let TerminatorKind::Branch {
                test,
                consequent,
                alternate,
            } = block.terminator.kind
            && function.values[test.as_usize()]
                .origin
                .primary_span
                .is_some_and(|span| reactive_test(function, operations, span))
            && let Some((consequent, consequent_blocks)) =
                returned_renderable(hir, function, consequent)
            && let Some((alternate, alternate_blocks)) =
                returned_renderable(hir, function, alternate)
            && consequent != alternate
        {
            plans.push((hint.origin, false, exact_control_flow_coverage(hint.origin)));
            dynamic_blocks.extend(consequent_blocks);
            dynamic_blocks.extend(alternate_blocks);
            continue;
        }
        let Some((returned, story_blocks)) =
            returned_renderable_story(hir, function, construct.header)
        else {
            continue;
        };
        if returned.len() > 1 && story_has_reactive_control(function, operations, &story_blocks) {
            plans.push((
                hint.origin,
                true,
                story_control_flow_coverage(function, control_flow, &story_blocks),
            ));
            dynamic_blocks.extend(story_blocks);
        }
    }
    for (origin, track_branch_reads, covered_control_flow) in plans {
        let id = EmitTemporaryId::new(u32::try_from(temporaries.len()).unwrap_or(u32::MAX));
        temporaries.push(EmitTemporary {
            id,
            name: names.allocate("__fict_cond_return"),
            origin,
        });
        operations.push(EmitOperation::ConditionalReturn {
            target: id,
            helper: RuntimeHelper::Conditional,
            create_helper: RuntimeHelper::CreateElement,
            cleanup_helper: RuntimeHelper::OnDestroy,
            track_branch_reads,
            covered_control_flow,
            origin,
        });
    }
    use_dynamic_branch_helpers(function, &dynamic_blocks, operations);
}

fn exact_control_flow_coverage(origin: Origin) -> Vec<SourceSpan> {
    origin.primary_span.into_iter().collect()
}

fn story_control_flow_coverage(
    function: &HirFunction,
    control_flow: &StructurizeAnalysis,
    story_blocks: &BTreeSet<BlockId>,
) -> Vec<SourceSpan> {
    let mut spans: Vec<_> = control_flow
        .constructs
        .iter()
        .filter(|construct| {
            story_blocks.contains(&construct.header)
                && matches!(
                    construct.kind,
                    StructuredConstructKind::Conditional { .. }
                        | StructuredConstructKind::Switch { .. }
                )
        })
        .filter_map(|construct| function.blocks.get(construct.header.as_usize()))
        .filter_map(|block| block.source_hint.as_ref())
        .filter_map(|hint| hint.origin.primary_span)
        .collect();
    spans.sort_unstable();
    spans.dedup();
    spans
}

fn use_dynamic_branch_helpers(
    function: &HirFunction,
    dynamic_blocks: &BTreeSet<fict_hir::BlockId>,
    operations: &mut [EmitOperation],
) {
    let dynamic_results: BTreeSet<_> = dynamic_blocks
        .iter()
        .flat_map(|block| &function.blocks[block.as_usize()].instructions)
        .filter_map(|instruction| instruction.result)
        .collect();
    for operation in operations {
        match operation {
            EmitOperation::CreateDerived {
                source_result,
                helper: Some(helper),
                ..
            } if dynamic_results.contains(source_result) && *helper == RuntimeHelper::UseMemo => {
                // Conditional factories rerun outside component hook execution. A root-owned memo
                // follows the branch lifecycle without consuming the component hook cursor.
                *helper = RuntimeHelper::Memo;
            }
            _ => {}
        }
    }
}
fn reactive_test(
    function: &HirFunction,
    operations: &[EmitOperation],
    test_span: SourceSpan,
) -> bool {
    let contains =
        |span: SourceSpan| test_span.start() <= span.start() && span.end() <= test_span.end();
    operations.iter().any(|operation| {
        matches!(operation, EmitOperation::ReadReactive { origin, .. }
            if origin.primary_span.is_some_and(contains))
    }) || function.parameters.iter().any(|parameter| {
        parameter
            .object_properties
            .iter()
            .flatten()
            .flat_map(|property| &property.references)
            .any(|origin| origin.primary_span.is_some_and(contains))
    }) || function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .any(|instruction| {
            let HirInstructionKind::Read { place } = &instruction.kind else {
                return false;
            };
            let local = match place.base {
                PlaceBase::Local(local) => local,
                PlaceBase::Ssa(name) => name.local,
                PlaceBase::Global(_) | PlaceBase::Value(_) => return false,
            };
            function
                .parameters
                .iter()
                .any(|parameter| parameter.local == local)
                && instruction.origin.primary_span.is_some_and(contains)
        })
}
fn jsx_value(function: &HirFunction, value: ValueId) -> bool {
    function
        .instruction_for_result(value)
        .is_some_and(|instruction| matches!(instruction.kind, HirInstructionKind::Jsx { .. }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum RenderableReturnValue {
    Empty,
    Jsx(ValueId),
}

fn renderable_return_value(
    hir: &HirFile,
    function: &HirFunction,
    value: Option<ValueId>,
    return_origin: Origin,
) -> Option<RenderableReturnValue> {
    let Some(value) = value else {
        return matches!(return_origin.kind, OriginKind::Source)
            .then_some(RenderableReturnValue::Empty);
    };
    if jsx_value(function, value) {
        return Some(RenderableReturnValue::Jsx(value));
    }
    let value_data = function.values.get(value.as_usize())?;
    let is_nullish = matches!(
        &value_data.kind,
        ValueKind::Literal(LiteralValue::Null | LiteralValue::Undefined)
    ) || function
        .instruction_for_result(value)
        .is_some_and(|instruction| match &instruction.kind {
            HirInstructionKind::Literal(LiteralValue::Null | LiteralValue::Undefined)
            | HirInstructionKind::Unary {
                operator: UnaryOperator::Void,
                ..
            } => true,
            HirInstructionKind::Read { place } if place.projections.is_empty() => {
                let PlaceBase::Global(global) = place.base else {
                    return false;
                };
                hir.globals
                    .get(global.as_usize())
                    .is_some_and(|global| global.name == "undefined")
            }
            _ => false,
        });
    is_nullish.then_some(RenderableReturnValue::Empty)
}

fn returned_renderable(
    hir: &HirFile,
    function: &HirFunction,
    start: fict_hir::BlockId,
) -> Option<(RenderableReturnValue, BTreeSet<fict_hir::BlockId>)> {
    let mut current = start;
    let mut visited = BTreeSet::new();
    loop {
        if !visited.insert(current) {
            return None;
        }
        let block = function.blocks.get(current.as_usize())?;
        match block.terminator.kind {
            TerminatorKind::Return { value } => {
                return renderable_return_value(hir, function, value, block.terminator.origin)
                    .map(|value| (value, visited));
            }
            TerminatorKind::Goto { target } if block.instructions.is_empty() => current = target,
            _ => return None,
        }
    }
}

fn returned_renderable_story(
    hir: &HirFile,
    function: &HirFunction,
    start: BlockId,
) -> Option<(BTreeSet<RenderableReturnValue>, BTreeSet<BlockId>)> {
    fn visit(
        hir: &HirFile,
        function: &HirFunction,
        block_id: BlockId,
        active: &mut BTreeSet<BlockId>,
        complete: &mut BTreeSet<BlockId>,
        blocks: &mut BTreeSet<BlockId>,
        returned: &mut BTreeSet<RenderableReturnValue>,
    ) -> bool {
        if complete.contains(&block_id) {
            return true;
        }
        if !active.insert(block_id) {
            return false;
        }
        blocks.insert(block_id);
        let Some(block) = function.blocks.get(block_id.as_usize()) else {
            active.remove(&block_id);
            return false;
        };
        let valid = match &block.terminator.kind {
            TerminatorKind::Return { value } => {
                let Some(value) =
                    renderable_return_value(hir, function, *value, block.terminator.origin)
                else {
                    active.remove(&block_id);
                    return false;
                };
                returned.insert(value);
                true
            }
            TerminatorKind::Goto { target } => {
                visit(hir, function, *target, active, complete, blocks, returned)
            }
            TerminatorKind::Branch {
                consequent,
                alternate,
                ..
            } => {
                visit(
                    hir,
                    function,
                    *consequent,
                    active,
                    complete,
                    blocks,
                    returned,
                ) && visit(
                    hir, function, *alternate, active, complete, blocks, returned,
                )
            }
            TerminatorKind::Switch { cases, .. }
                if cases.iter().any(|case| case.test.is_none()) =>
            {
                cases.iter().all(|case| {
                    visit(
                        hir,
                        function,
                        case.target,
                        active,
                        complete,
                        blocks,
                        returned,
                    )
                })
            }
            TerminatorKind::Throw { .. }
            | TerminatorKind::ForIn { .. }
            | TerminatorKind::ForOf { .. }
            | TerminatorKind::Switch { .. }
            | TerminatorKind::Try { .. }
            | TerminatorKind::Unreachable => false,
        };
        active.remove(&block_id);
        if valid {
            complete.insert(block_id);
        }
        valid
    }

    let mut active = BTreeSet::new();
    let mut complete = BTreeSet::new();
    let mut blocks = BTreeSet::new();
    let mut returned = BTreeSet::new();
    visit(
        hir,
        function,
        start,
        &mut active,
        &mut complete,
        &mut blocks,
        &mut returned,
    )
    .then_some((returned, blocks))
}

pub(crate) fn story_has_reactive_control(
    function: &HirFunction,
    operations: &[EmitOperation],
    blocks: &BTreeSet<BlockId>,
) -> bool {
    blocks.iter().any(|block| {
        let controls: Vec<_> = match &function.blocks[block.as_usize()].terminator.kind {
            TerminatorKind::Branch { test, .. } => vec![*test],
            TerminatorKind::Switch {
                discriminant,
                cases,
            } => std::iter::once(*discriminant)
                .chain(cases.iter().filter_map(|case| case.test))
                .collect(),
            TerminatorKind::ForIn { object, .. } => vec![*object],
            TerminatorKind::ForOf { iterable, .. } => vec![*iterable],
            TerminatorKind::Return { .. }
            | TerminatorKind::Throw { .. }
            | TerminatorKind::Goto { .. }
            | TerminatorKind::Try { .. }
            | TerminatorKind::Unreachable => Vec::new(),
        };
        controls.into_iter().any(|control| {
            reactive_control_value(function, operations, control, &mut BTreeSet::new())
        })
    })
}

fn reactive_control_value(
    function: &HirFunction,
    operations: &[EmitOperation],
    value: ValueId,
    visited: &mut BTreeSet<ValueId>,
) -> bool {
    if !visited.insert(value) {
        return false;
    }
    if function.values[value.as_usize()]
        .origin
        .primary_span
        .is_some_and(|span| reactive_test(function, operations, span))
    {
        return true;
    }
    function
        .instruction_for_result(value)
        .is_some_and(|instruction| match instruction.kind {
            HirInstructionKind::Binary { left, right, .. } => {
                reactive_control_value(function, operations, left, visited)
                    || reactive_control_value(function, operations, right, visited)
            }
            _ => false,
        })
}
