use crate::{
    EmitOperation, EmitTemporary, EmitTemporaryId, RuntimeHelper, name_allocator::NameAllocator,
};
use fict_hir::{
    FunctionKind, HirFunction, HirInstructionKind, PlaceBase, SourceSpan, TerminatorKind, ValueId,
};
use fict_reactivity::{StructuredConstructKind, StructurizeAnalysis};
use std::collections::BTreeSet;
pub(crate) fn lower_conditional_returns(
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
            && jsx_value(function, *consequent)
            && jsx_value(function, *alternate)
            && consequent != alternate
        {
            plans.push(instruction.origin);
        }
    }
    let mut dynamic_blocks = BTreeSet::new();
    for construct in control_flow
        .top_level_constructs
        .iter()
        .filter_map(|id| control_flow.constructs.get(*id as usize))
    {
        if !matches!(construct.kind, StructuredConstructKind::Conditional { .. }) {
            continue;
        }
        let block = &function.blocks[construct.header.as_usize()];
        let Some(hint) = &block.source_hint else {
            continue;
        };
        let TerminatorKind::Branch {
            test,
            consequent,
            alternate,
        } = block.terminator.kind
        else {
            continue;
        };
        let Some(test_span) = function.values[test.as_usize()].origin.primary_span else {
            continue;
        };
        if !reactive_test(function, operations, test_span) {
            continue;
        }
        let Some((consequent, consequent_blocks)) = returned_jsx(function, consequent) else {
            continue;
        };
        let Some((alternate, alternate_blocks)) = returned_jsx(function, alternate) else {
            continue;
        };
        if consequent != alternate {
            plans.push(hint.origin);
            dynamic_blocks.extend(consequent_blocks);
            dynamic_blocks.extend(alternate_blocks);
        }
    }
    for origin in plans {
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
            origin,
        });
    }
    use_dynamic_branch_helpers(function, &dynamic_blocks, operations);
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
fn returned_jsx(
    function: &HirFunction,
    start: fict_hir::BlockId,
) -> Option<(ValueId, BTreeSet<fict_hir::BlockId>)> {
    let mut current = start;
    let mut visited = BTreeSet::new();
    loop {
        if !visited.insert(current) {
            return None;
        }
        let block = function.blocks.get(current.as_usize())?;
        match block.terminator.kind {
            TerminatorKind::Return { value: Some(value) } if jsx_value(function, value) => {
                return Some((value, visited));
            }
            TerminatorKind::Goto { target } if block.instructions.is_empty() => current = target,
            _ => return None,
        }
    }
}
