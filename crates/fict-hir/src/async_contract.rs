//! Source value/accessor distinctions for explicit async declarations and immutable aliases.

use std::collections::{BTreeMap, BTreeSet};

use crate::{
    BinaryOperator, BindingId, CallHost, DeclarationKind, FictMacroKind, FunctionId, HirFile,
    HirInstructionKind, ImportedHookReturn, ImportedReactiveKind, LocalKind, Place, PlaceBase,
    Projection, ReactiveCallKind, ValueId,
};

/// Recover an explicit async source surface without inferring Promise semantics.
/// The fact does not claim that an alias allocates a new async node.
pub fn async_value_kind(
    file: &HirFile,
    function: FunctionId,
    value: ValueId,
    hooks: Option<&BTreeMap<BindingId, ImportedHookReturn>>,
) -> Option<ImportedReactiveKind> {
    query(file, function, Input::Value(value), hooks, true)
}

/// Recover the async source surface of a dependency path, including hook properties.
pub fn async_place_kind(
    file: &HirFile,
    function: FunctionId,
    place: &Place,
    hooks: Option<&BTreeMap<BindingId, ImportedHookReturn>>,
) -> Option<ImportedReactiveKind> {
    query(file, function, Input::Place(place.clone()), hooks, true)
}

/// Prove a direct immutable accessor identity, without a reactive selection.
pub fn async_accessor_identity(
    file: &HirFile,
    function: FunctionId,
    value: ValueId,
    hooks: Option<&BTreeMap<BindingId, ImportedHookReturn>>,
) -> bool {
    query(file, function, Input::Value(value), hooks, false)
        == Some(ImportedReactiveKind::AsyncAccessor)
}

enum Input {
    Value(ValueId),
    Place(Place),
}

fn query(
    file: &HirFile,
    mut owner: FunctionId,
    mut input: Input,
    hooks: Option<&BTreeMap<BindingId, ImportedHookReturn>>,
    selections: bool,
) -> Option<ImportedReactiveKind> {
    let mut seen = BTreeSet::new();
    let mut visited: BTreeMap<(FunctionId, ValueId), Vec<Vec<Projection>>> = BTreeMap::new();
    let mut projections: Vec<Projection> = Vec::new();
    let mut alternatives = Vec::new();
    let mut result = None;
    macro_rules! finish {
        ($kind:expr) => {{
            let kind = $kind?;
            if result.is_some_and(|previous| previous != kind) {
                return None;
            }
            result = Some(kind);
            let Some((next_owner, next_input, next_projections, next_seen)) = alternatives.pop()
            else {
                return result;
            };
            owner = next_owner;
            input = next_input;
            projections = next_projections;
            seen = next_seen;
            continue;
        }};
    }
    loop {
        let function = file.functions.get(owner.as_usize())?;
        match input {
            Input::Value(value) => {
                if !seen.insert((owner, value)) {
                    return None;
                }
                // Every queued branch must agree with the same result. Reuse a
                // shared subgraph after its first branch completes; its remaining
                // alternatives stay queued and still reject any conflicting kind.
                // Keep the path-local cycle check above this shortcut.
                let paths = visited.entry((owner, value)).or_default();
                if paths.contains(&projections) && result.is_some() {
                    finish!(result);
                }
                paths.push(projections.clone());
                match &function.instruction_for_result(value)?.kind {
                    HirInstructionKind::Call(call) => {
                        match (call.macro_kind, call.reactive_kind) {
                            (Some(FictMacroKind::Async), _) => {
                                finish!(projected(ImportedReactiveKind::Async, projections.len()));
                            }
                            (_, Some(ReactiveCallKind::AsyncMemo)) => {
                                finish!(projected(
                                    ImportedReactiveKind::AsyncAccessor,
                                    projections.len()
                                ));
                            }
                            _ => {}
                        }
                        let binding = match call.host {
                            CallHost::Binding(binding) => binding,
                            CallHost::ReactiveScope(host) => host.callee?,
                            _ => return None,
                        };
                        let import = file.bindings.get(binding.as_usize())?.import.as_ref();
                        let info = if let Some(place) = &call.callee_reference
                            && !place.projections.is_empty()
                        {
                            import?.resolve_hook_member(&place.projections)
                        } else {
                            import
                                .and_then(|import| import.hook_return.as_ref())
                                .or_else(|| hooks?.get(&binding))
                        }?;
                        if let Some(kind) = info.direct_accessor {
                            finish!(projected(kind, projections.len()));
                        }
                        let member = info.resolve_property(projections.first()?)?;
                        finish!(projected(member.kind, projections.len() - 1));
                    }
                    HirInstructionKind::Conditional {
                        consequent,
                        alternate,
                        ..
                    }
                    | HirInstructionKind::Binary {
                        operator:
                            BinaryOperator::LogicalAnd
                            | BinaryOperator::LogicalOr
                            | BinaryOperator::NullishCoalescing,
                        left: consequent,
                        right: alternate,
                    } => {
                        if !selections {
                            return None;
                        }
                        alternatives.push((
                            owner,
                            Input::Value(*alternate),
                            projections.clone(),
                            seen.clone(),
                        ));
                        input = Input::Value(*consequent);
                    }
                    HirInstructionKind::Read { place } => input = Input::Place(place.clone()),
                    HirInstructionKind::Sequence { values } => {
                        input = Input::Value(*values.last()?)
                    }
                    _ => return None,
                }
            }
            Input::Place(mut place) => {
                place.projections.append(&mut projections);
                projections = place.projections;
                let local = match place.base {
                    PlaceBase::Local(local) => local,
                    PlaceBase::Ssa(name) => name.local,
                    PlaceBase::Value(value) => {
                        input = Input::Value(value);
                        continue;
                    }
                    PlaceBase::Global(_) => return None,
                };
                let local = function.locals.get(local.as_usize())?;
                let binding = local.binding?;
                if let Some(import) = file.bindings.get(binding.as_usize())?.import.as_ref() {
                    if let Some(kind) = import.reactive {
                        finish!(projected(kind, projections.len()));
                    }
                    let member = import.resolve_reactive_member(&projections)?;
                    finish!(projected(
                        member.kind,
                        projections.len() - member.accessor_depth
                    ));
                }
                let (source_owner, function, local) = if local.kind == LocalKind::Capture {
                    file.functions.iter().find_map(|function| {
                        let local = function.locals.iter().find(|local| {
                            local.binding == Some(binding) && local.kind != LocalKind::Capture
                        })?;
                        Some((function.id, function, local))
                    })?
                } else {
                    (owner, function, local)
                };
                if local.declaration_kind != DeclarationKind::Const {
                    return None;
                }
                let initializer = function
                    .blocks
                    .iter()
                    .flat_map(|block| &block.instructions)
                    .find_map(|instruction| match instruction.kind {
                        HirInstructionKind::Declare {
                            local: target,
                            initializer,
                            ..
                        } if target == local.id => initializer,
                        _ => None,
                    })?;
                owner = source_owner;
                input = Input::Value(initializer);
            }
        }
    }
}

fn projected(kind: ImportedReactiveKind, depth: usize) -> Option<ImportedReactiveKind> {
    match kind {
        ImportedReactiveKind::Async => Some(ImportedReactiveKind::Async),
        ImportedReactiveKind::AsyncAccessor if depth == 0 => {
            Some(ImportedReactiveKind::AsyncAccessor)
        }
        ImportedReactiveKind::AsyncAccessor => Some(ImportedReactiveKind::Async),
        _ => None,
    }
}
