//! Resolve literal and stable-local branch facts for hook return contracts.

use super::*;

pub(super) fn known_truthiness(
    function: &HirFunction,
    value: ValueId,
    slot: HookSlotShape,
) -> Option<bool> {
    if matches!(slot, HookSlotShape::Accessor(_)) {
        return Some(true);
    }
    static_truthiness(function, value, &mut BTreeSet::new())
}

pub(super) fn static_truthiness(
    function: &HirFunction,
    value: ValueId,
    visiting: &mut BTreeSet<ValueId>,
) -> Option<bool> {
    if !visiting.insert(value) {
        return None;
    }
    if let Some(initializer) = stable_read_initializer(function, value) {
        let result = static_truthiness(function, initializer, visiting);
        visiting.remove(&value);
        return result;
    }
    let result = match &defining_instruction(function, value)?.kind {
        HirInstructionKind::Literal(literal) => match literal {
            LiteralValue::Null | LiteralValue::Undefined => Some(false),
            LiteralValue::Boolean(value) => Some(*value),
            LiteralValue::Number(value) => {
                let value = value.to_f64();
                Some(value != 0.0 && !value.is_nan())
            }
            LiteralValue::BigInt(value) => {
                Some(!value.trim_start_matches(['-', '+', '0']).is_empty())
            }
            LiteralValue::String(value) => Some(!value.is_empty()),
            LiteralValue::RegExp { .. } => Some(true),
        },
        HirInstructionKind::Array { .. }
        | HirInstructionKind::Object { .. }
        | HirInstructionKind::Function { .. } => Some(true),
        HirInstructionKind::Sequence { values } => values
            .last()
            .and_then(|value| static_truthiness(function, *value, visiting)),
        HirInstructionKind::Conditional {
            consequent,
            alternate,
            ..
        } => {
            let consequent = static_truthiness(function, *consequent, visiting)?;
            let alternate = static_truthiness(function, *alternate, visiting)?;
            (consequent == alternate).then_some(consequent)
        }
        _ => None,
    };
    visiting.remove(&value);
    result
}

pub(super) fn known_nullish(
    function: &HirFunction,
    value: ValueId,
    slot: HookSlotShape,
) -> Option<bool> {
    if matches!(slot, HookSlotShape::Accessor(_)) {
        return Some(false);
    }
    static_nullish(function, value, &mut BTreeSet::new())
}

pub(super) fn static_nullish(
    function: &HirFunction,
    value: ValueId,
    visiting: &mut BTreeSet<ValueId>,
) -> Option<bool> {
    if !visiting.insert(value) {
        return None;
    }
    if let Some(initializer) = stable_read_initializer(function, value) {
        let result = static_nullish(function, initializer, visiting);
        visiting.remove(&value);
        return result;
    }
    let result = match &defining_instruction(function, value)?.kind {
        HirInstructionKind::Literal(LiteralValue::Null | LiteralValue::Undefined) => Some(true),
        HirInstructionKind::Literal(_)
        | HirInstructionKind::Array { .. }
        | HirInstructionKind::Object { .. }
        | HirInstructionKind::Function { .. } => Some(false),
        HirInstructionKind::Sequence { values } => values
            .last()
            .and_then(|value| static_nullish(function, *value, visiting)),
        HirInstructionKind::Conditional {
            consequent,
            alternate,
            ..
        } => {
            let consequent = static_nullish(function, *consequent, visiting)?;
            let alternate = static_nullish(function, *alternate, visiting)?;
            (consequent == alternate).then_some(consequent)
        }
        _ => None,
    };
    visiting.remove(&value);
    result
}

pub(super) fn known_materialized_value_read(
    function: &HirFunction,
    value: ValueId,
    bindings: &BTreeMap<BindingId, ReactiveExportKind>,
) -> Option<ReactiveExportKind> {
    let Some(HirInstructionKind::Read { place }) =
        defining_instruction(function, value).map(|instruction| &instruction.kind)
    else {
        return None;
    };
    if !place.projections.is_empty() {
        return None;
    }
    let local = match place.base {
        PlaceBase::Local(local) => local,
        PlaceBase::Ssa(name) => name.local,
        _ => return None,
    };
    function.locals[local.as_usize()]
        .binding
        .and_then(|binding| bindings.get(&binding).copied())
}

pub(super) fn stable_read_initializer(function: &HirFunction, value: ValueId) -> Option<ValueId> {
    let HirInstructionKind::Read { place } = &defining_instruction(function, value)?.kind else {
        return None;
    };
    if !place.projections.is_empty() {
        return None;
    }
    if let PlaceBase::Value(value) = place.base {
        return Some(value);
    }
    let local = match place.base {
        PlaceBase::Local(local) => local,
        PlaceBase::Ssa(name) => name.local,
        PlaceBase::Global(_) | PlaceBase::Value(_) => return None,
    };
    stable_local_initializer(function, local)
}

pub(super) fn stable_local_initializer(
    function: &HirFunction,
    local: fict_hir::LocalId,
) -> Option<ValueId> {
    if function.locals.get(local.as_usize())?.declaration_kind != DeclarationKind::Const {
        return None;
    }
    function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find_map(|instruction| match instruction.kind {
            HirInstructionKind::Declare {
                local: declared,
                initializer,
                ..
            } if declared == local => initializer,
            _ => None,
        })
}
