//! Value semantics for implicit computations depending on explicit async sources.

use crate::{DependencyBase, DependencySegment, ReactiveScopeAnalysis};
use fict_hir::{
    BindingId, HirFile, HirFunction, HirInstructionKind, ImportedHookReturn, LocalId, Place,
    PlaceBase, Projection,
};
use std::collections::{BTreeMap, BTreeSet};

/// Find locals whose ordinary derived values depend on an explicit async surface.
/// These values retain JavaScript call semantics even when represented by a memo getter.
pub fn async_dependent_locals(
    file: &HirFile,
    function: &HirFunction,
    scopes: &ReactiveScopeAnalysis,
    hooks: &BTreeMap<BindingId, ImportedHookReturn>,
) -> BTreeSet<LocalId> {
    let mut locals = BTreeSet::new();
    for local in &function.locals {
        if fict_hir::async_place_kind(
            file,
            function.id,
            &Place {
                base: PlaceBase::Local(local.id),
                projections: Vec::new(),
            },
            Some(hooks),
        )
        .is_some()
        {
            locals.insert(local.id);
        }
    }
    for instruction in function.blocks.iter().flat_map(|block| &block.instructions) {
        if let HirInstructionKind::Declare {
            local,
            initializer: Some(value),
            ..
        } = instruction.kind
            && fict_hir::async_value_kind(file, function.id, value, Some(hooks)).is_some()
        {
            locals.insert(local);
        }
    }
    loop {
        let mut changed = false;
        for fact in &scopes.bindings {
            if locals.contains(&fact.name.local) {
                continue;
            }
            if fact.dependencies.iter().any(|path| {
                if path.local().is_some_and(|local| locals.contains(&local)) {
                    return true;
                }
                let base = match path.base {
                    DependencyBase::Ssa(name) => PlaceBase::Ssa(name),
                    DependencyBase::Value(value) => PlaceBase::Value(value),
                    DependencyBase::Global(global) => PlaceBase::Global(global),
                };
                let projections = path
                    .segments
                    .iter()
                    .map(|segment| match segment {
                        DependencySegment::Static { name, optional } => {
                            Projection::StaticProperty {
                                name: name.clone(),
                                optional: *optional,
                            }
                        }
                        DependencySegment::Index { index, optional } => Projection::Index {
                            index: *index,
                            optional: *optional,
                        },
                        DependencySegment::Dynamic { key, optional } => {
                            Projection::ComputedProperty {
                                key: *key,
                                optional: *optional,
                            }
                        }
                    })
                    .collect();
                fict_hir::async_place_kind(
                    file,
                    function.id,
                    &Place { base, projections },
                    Some(hooks),
                )
                .is_some()
            }) {
                changed |= locals.insert(fact.name.local);
            }
        }
        if !changed {
            return locals;
        }
    }
}
