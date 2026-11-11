//! Preserve accessor identities while recursively collecting hook return values.

use super::*;

pub(super) fn hook_return_accessor_reads(function: &HirFunction) -> BTreeSet<ValueId> {
    if function.kind != FunctionKind::Hook {
        return BTreeSet::new();
    }
    let mut visited = BTreeSet::new();
    let mut reads = BTreeSet::new();
    for value in function.blocks.iter().filter_map(|block| {
        let TerminatorKind::Return { value: Some(value) } = block.terminator.kind else {
            return None;
        };
        Some(value)
    }) {
        collect_hook_return_accessor_reads(function, value, &mut visited, &mut reads);
    }
    reads
}
fn collect_hook_return_accessor_reads(
    function: &HirFunction,
    value: ValueId,
    visited: &mut BTreeSet<ValueId>,
    reads: &mut BTreeSet<ValueId>,
) {
    if !visited.insert(value) {
        return;
    }
    let Some(instruction) = function.instruction_for_result(value) else {
        return;
    };
    match &instruction.kind {
        HirInstructionKind::Read { .. } | HirInstructionKind::Call(_) => {
            reads.insert(value);
        }
        HirInstructionKind::Object { entries } => {
            for entry in entries {
                let ObjectEntry::Property {
                    value,
                    kind: ObjectPropertyKind::Init,
                    prototype_setter: false,
                    ..
                } = entry
                else {
                    continue;
                };
                collect_hook_return_accessor_reads(function, *value, visited, reads);
            }
        }
        HirInstructionKind::Array { elements } => {
            for element in elements {
                let ArrayElement::Value(value) = element else {
                    continue;
                };
                collect_hook_return_accessor_reads(function, *value, visited, reads);
            }
        }
        HirInstructionKind::Conditional {
            consequent,
            alternate,
            ..
        } => {
            collect_hook_return_accessor_reads(function, *consequent, visited, reads);
            collect_hook_return_accessor_reads(function, *alternate, visited, reads);
        }
        HirInstructionKind::Sequence { values } => {
            for value in values {
                collect_hook_return_accessor_reads(function, *value, visited, reads);
            }
        }
        _ => {}
    }
}
