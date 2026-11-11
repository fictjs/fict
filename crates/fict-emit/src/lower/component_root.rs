//! Component setup runs once. A returned value needs its own reactive consumer,
//! just like an expression in JSX; setup allocations must remain outside it.

use crate::{ComponentRoot, ComponentRootHazard, EmitOperation, ReactiveSlot, ReactiveSlotKind};
use fict_hir::{
    CallHost, FunctionKind, HirFile, HirFunction, HirInstructionKind, ImportedName, TerminatorKind,
    ValueKind,
};
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn lower_component_roots(
    hir: &HirFile,
    function: &HirFunction,
    operations: &mut [EmitOperation],
    slots: &[ReactiveSlot],
) {
    if function.kind != FunctionKind::Component {
        return;
    }
    let instructions: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .collect();
    let by_value: BTreeMap<_, _> = instructions
        .iter()
        .filter_map(|instruction| instruction.result.map(|value| (value, *instruction)))
        .collect();
    let mut by_span: Vec<_> = instructions
        .iter()
        .filter_map(|instruction| {
            instruction
                .origin
                .primary_span
                .map(|span| (span, *instruction))
        })
        .collect();
    by_span.sort_unstable_by_key(|(span, _)| (span.start(), span.end()));
    let conditional_returns: BTreeSet<_> = operations
        .iter()
        .filter_map(|operation| match operation {
            EmitOperation::ConditionalReturn { origin, .. } => origin.primary_span,
            _ => None,
        })
        .collect();
    let signal_reads: BTreeMap<_, _> = operations
        .iter()
        .filter_map(|operation| match operation {
            EmitOperation::ReadReactive {
                slot,
                origin,
                accessor_depth,
                call_value: false,
                ..
            } if slots
                .get(slot.as_usize())
                .is_some_and(|slot| slot.kind == ReactiveSlotKind::Signal) =>
            {
                origin
                    .primary_span
                    .map(|span| (span, usize::from(*accessor_depth)))
            }
            _ => None,
        })
        .collect();
    let mut plans = BTreeMap::new();
    for block in &function.blocks {
        let TerminatorKind::Return { value: Some(value) } = block.terminator.kind else {
            continue;
        };
        let returned = &function.values[value.as_usize()];
        let definition = by_value.get(&value).copied();
        if matches!(
            returned.kind,
            ValueKind::Literal(_) | ValueKind::Function(_)
        ) || definition.is_some_and(|instruction| {
            matches!(
                instruction.kind,
                HirInstructionKind::Jsx { .. }
                    | HirInstructionKind::Literal(_)
                    | HirInstructionKind::Function { .. }
            ) || matches!(&instruction.kind, HirInstructionKind::Call(call)
                        if setup_call(hir, call))
        }) || returned
            .origin
            .primary_span
            .is_some_and(|span| conditional_returns.contains(&span))
        {
            continue;
        }
        let Some(span) = block.terminator.origin.primary_span else {
            continue;
        };
        let start = by_span.partition_point(|(candidate, _)| candidate.start() < span.start());
        let hazard = by_span[start..]
            .iter()
            .take_while(|(candidate, _)| candidate.start() <= span.end())
            .filter(|(candidate, _)| candidate.end() <= span.end())
            .find_map(|(_, instruction)| match &instruction.kind {
                HirInstructionKind::Call(call) if setup_call(hir, call) => {
                    Some(ComponentRootHazard::Setup)
                }
                HirInstructionKind::Call(call)
                    if !call.arguments.is_empty()
                        && function.values[call.callee.as_usize()]
                            .origin
                            .primary_span
                            .is_some_and(|span| {
                                signal_reads.get(&span).is_some_and(|depth| {
                                    *depth
                                        == call
                                            .callee_reference
                                            .as_ref()
                                            .map_or(0, |place| place.projections.len())
                                })
                            }) =>
                {
                    Some(ComponentRootHazard::Mutation)
                }
                HirInstructionKind::Await { .. } | HirInstructionKind::Yield { .. } => {
                    Some(ComponentRootHazard::Suspension)
                }
                HirInstructionKind::Write { .. }
                | HirInstructionKind::ReadWrite { .. }
                | HirInstructionKind::PatternAssignment { .. }
                | HirInstructionKind::Delete { .. } => Some(ComponentRootHazard::Mutation),
                _ => None,
            });
        plans.insert(
            span,
            hazard.map_or(ComponentRoot::Reactive, ComponentRoot::Snapshot),
        );
    }
    for operation in operations {
        if let EmitOperation::Return {
            component_root,
            origin,
            ..
        } = operation
        {
            *component_root = origin
                .primary_span
                .and_then(|span| plans.get(&span).copied());
        }
    }
}

fn setup_call(hir: &HirFile, call: &fict_hir::CallInstruction) -> bool {
    if call.setup_only {
        return true;
    }
    let binding = match call.host {
        CallHost::Binding(binding) => Some(binding),
        CallHost::ReactiveScope(host) => host.callee,
        _ => None,
    };
    let Some(import) = binding.and_then(|binding| hir.bindings[binding.as_usize()].import.as_ref())
    else {
        return false;
    };
    // Lifecycle and ownership APIs also have setup semantics even though they do
    // not allocate a reactive value. Match resolved imports, never local spellings.
    matches!(
        import.source.as_str(),
        "fict"
            | "fict/advanced"
            | "fict/internal"
            | "fict/plus"
            | "fict/slim"
            | "@fictjs/runtime"
            | "@fictjs/runtime/advanced"
            | "@fictjs/runtime/internal"
    ) && matches!(&import.imported, ImportedName::Named(name) if matches!(name.as_str(),
            "createSignal" | "createRoot" | "onMount" | "onDestroy" | "onCleanup" | "useContext"
            | "createContext" | "createPortal" | "render" | "hydrate"))
}
