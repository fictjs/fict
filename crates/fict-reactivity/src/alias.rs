use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_hir::{FunctionId, HirFile, HirInstructionKind, LocalId, PlaceBase, SsaName, ValueId};

use crate::{
    BarrierKind, DependencyAnalysis, DependencyBase, EscapeKind, InstructionLocation, SsaAnalysis,
    SsaDefinitionLocation, verify_dependencies, verify_ssa,
};

/// Proven assignment alias between structural SSA identities.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AliasEdge {
    /// Newly defined alias.
    pub alias: SsaName,
    /// Canonical source identity at analysis completion.
    pub source: SsaName,
}

/// One canonical alias equivalence class.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AliasClass {
    /// Deterministic canonical root.
    pub root: SsaName,
    /// All definitions resolving to the root, including the root itself.
    pub members: Vec<SsaName>,
}

/// Why cached/member facts for an alias class must be invalidated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum AliasInvalidationReason {
    /// Property/index mutation through an alias.
    ProjectedWrite,
    /// Alias or member passed to an unknown call.
    UnknownCall,
    /// Value stored into an externally observable place.
    ObservableWrite,
    /// Unknown mutation barrier without a narrower affected path.
    UnknownBarrier,
}

/// Alias class invalidation at one instruction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AliasInvalidation {
    /// Invalidating instruction.
    pub location: InstructionLocation,
    /// Invalidation reason.
    pub reason: AliasInvalidationReason,
    /// Complete sorted class affected by the operation.
    pub affected: Vec<SsaName>,
}

/// Alias pass statistics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AliasStats {
    /// Proven directed alias edges.
    pub edges: u32,
    /// Canonical classes.
    pub classes: u32,
    /// Invalidation facts.
    pub invalidations: u32,
    /// Phi/root fixed-point sweeps.
    pub fixed_point_iterations: u32,
}

/// Version-aware alias and invalidation result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AliasAnalysis {
    /// Directed aliases in target-version order.
    pub edges: Vec<AliasEdge>,
    /// Complete definition partition by canonical root.
    pub classes: Vec<AliasClass>,
    /// Conservative invalidations.
    pub invalidations: Vec<AliasInvalidation>,
    /// Pass statistics.
    pub stats: AliasStats,
}

/// Analyze direct aliases and conservative class invalidation.
pub fn analyze_aliases(
    file: &HirFile,
    function_id: FunctionId,
    ssa: &SsaAnalysis,
    dependencies: &DependencyAnalysis,
) -> Result<AliasAnalysis, DiagnosticBundle> {
    let Some(function) = file.functions.get(function_id.as_usize()) else {
        return Err(DiagnosticBundle::new(vec![alias_error(
            "FICT-ALIAS-FUNCTION",
            "alias analysis function is outside the HIR arena",
        )]));
    };
    verify_ssa(function, ssa)?;
    verify_dependencies(file, function_id, ssa, dependencies)?;

    let definitions_by_location: BTreeMap<_, _> = ssa
        .definitions
        .iter()
        .filter_map(|definition| match definition.location {
            SsaDefinitionLocation::Instruction { block, instruction } => {
                Some(((block, instruction, definition.name.local), definition.name))
            }
            SsaDefinitionLocation::Entry | SsaDefinitionLocation::Phi(_) => None,
        })
        .collect();
    let direct_value_sources = direct_value_sources(function, dependencies);
    let mut parents = BTreeMap::new();
    for block in &function.blocks {
        if !ssa.cfg.reachable[block.id.as_usize()] {
            continue;
        }
        for (instruction_index, instruction) in block.instructions.iter().enumerate() {
            let (target, initializer) = match &instruction.kind {
                HirInstructionKind::Declare {
                    local, initializer, ..
                } => (*local, *initializer),
                HirInstructionKind::Write { place, value } if place.is_local() => {
                    let Some(local) = place_local(place.base) else {
                        continue;
                    };
                    (local, Some(*value))
                }
                _ => continue,
            };
            let Some(source) =
                initializer.and_then(|value| direct_value_sources.get(&value).copied())
            else {
                continue;
            };
            let Some(target) = definitions_by_location
                .get(&(block.id, count_u32(instruction_index), target))
                .copied()
            else {
                continue;
            };
            if target != source {
                parents.insert(target, source);
            }
        }
    }

    let maximum_iterations = ssa
        .definitions
        .len()
        .saturating_add(ssa.phis.len())
        .saturating_add(2);
    let mut iterations = 0_usize;
    loop {
        iterations = iterations.saturating_add(1);
        if iterations > maximum_iterations {
            return Err(DiagnosticBundle::new(vec![alias_error(
                "FICT-ALIAS-FIXED-POINT",
                "alias/Phi propagation exceeded its deterministic iteration limit",
            )]));
        }
        let mut changed = false;
        for phi in &ssa.phis {
            let roots: BTreeSet<_> = phi
                .sources
                .iter()
                .map(|(_, source)| resolve_root(*source, &parents))
                .collect();
            if roots.len() == 1 {
                let source = *roots.first().expect("one Phi alias root");
                if phi.target != source && parents.get(&phi.target) != Some(&source) {
                    parents.insert(phi.target, source);
                    changed = true;
                }
            }
        }
        let compressed: Vec<_> = parents
            .iter()
            .map(|(alias, source)| (*alias, resolve_root(*source, &parents)))
            .collect();
        for (alias, source) in compressed {
            if parents.get(&alias) != Some(&source) {
                parents.insert(alias, source);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    let mut edges: Vec<_> = parents
        .keys()
        .copied()
        .map(|alias| AliasEdge {
            alias,
            source: resolve_root(alias, &parents),
        })
        .collect();
    edges.sort_unstable();
    let all_definitions: BTreeSet<_> = ssa
        .definitions
        .iter()
        .map(|definition| definition.name)
        .collect();
    let mut class_map: BTreeMap<SsaName, Vec<SsaName>> = BTreeMap::new();
    for definition in &all_definitions {
        class_map
            .entry(resolve_root(*definition, &parents))
            .or_default()
            .push(*definition);
    }
    let classes: Vec<_> = class_map
        .into_iter()
        .map(|(root, members)| AliasClass { root, members })
        .collect();
    let member_by_name: BTreeMap<_, _> = classes
        .iter()
        .flat_map(|class| {
            class
                .members
                .iter()
                .copied()
                .map(|member| (member, class.members.clone()))
        })
        .collect();
    let invalidations = build_invalidations(dependencies, &member_by_name, &all_definitions);
    let stats = AliasStats {
        edges: count_u32(edges.len()),
        classes: count_u32(classes.len()),
        invalidations: count_u32(invalidations.len()),
        fixed_point_iterations: count_u32(iterations),
    };
    let analysis = AliasAnalysis {
        edges,
        classes,
        invalidations,
        stats,
    };
    verify_aliases(function, ssa, &analysis)?;
    Ok(analysis)
}

/// Verify alias roots, class partition, invalidations, and stats.
pub fn verify_aliases(
    function: &fict_hir::HirFunction,
    ssa: &SsaAnalysis,
    analysis: &AliasAnalysis,
) -> Result<(), DiagnosticBundle> {
    let mut diagnostics = DiagnosticBundle::default();
    let definitions: BTreeSet<_> = ssa
        .definitions
        .iter()
        .map(|definition| definition.name)
        .collect();
    for edge in &analysis.edges {
        if !definitions.contains(&edge.alias) || !definitions.contains(&edge.source) {
            diagnostics.push(alias_error(
                "FICT-ALIAS-DEFINITION",
                "alias edge references an unknown SSA definition",
            ));
        }
    }
    let mut partition = BTreeSet::new();
    let mut previous_root = None;
    for class in &analysis.classes {
        if previous_root.is_some_and(|root| root >= class.root)
            || class.members.is_empty()
            || class.members.windows(2).any(|pair| pair[0] >= pair[1])
            || !class.members.contains(&class.root)
        {
            diagnostics.push(alias_error(
                "FICT-ALIAS-CLASS",
                "alias classes must have sorted roots and sorted unique members including the root",
            ));
        }
        for member in &class.members {
            if !partition.insert(*member) {
                diagnostics.push(alias_error(
                    "FICT-ALIAS-CLASS",
                    "SSA definition occurs in more than one alias class",
                ));
            }
        }
        previous_root = Some(class.root);
    }
    if partition != definitions {
        diagnostics.push(alias_error(
            "FICT-ALIAS-CLASS",
            "alias classes must partition every SSA definition",
        ));
    }
    for invalidation in &analysis.invalidations {
        if invalidation.affected.is_empty()
            || invalidation
                .affected
                .windows(2)
                .any(|pair| pair[0] >= pair[1])
            || invalidation
                .affected
                .iter()
                .any(|name| !definitions.contains(name))
        {
            diagnostics.push(alias_error(
                "FICT-ALIAS-INVALIDATION",
                "alias invalidation must contain sorted known SSA definitions",
            ));
        }
        if function
            .blocks
            .get(invalidation.location.block.as_usize())
            .is_none_or(|block| {
                invalidation.location.instruction as usize >= block.instructions.len()
            })
        {
            diagnostics.push(alias_error(
                "FICT-ALIAS-LOCATION",
                "alias invalidation references an instruction outside the HIR arena",
            ));
        }
    }
    if analysis.stats.edges != count_u32(analysis.edges.len())
        || analysis.stats.classes != count_u32(analysis.classes.len())
        || analysis.stats.invalidations != count_u32(analysis.invalidations.len())
    {
        diagnostics.push(alias_error(
            "FICT-ALIAS-STATS",
            "alias stats do not match result arenas",
        ));
    }
    if diagnostics.is_empty() {
        Ok(())
    } else {
        Err(diagnostics)
    }
}

fn direct_value_sources(
    function: &fict_hir::HirFunction,
    dependencies: &DependencyAnalysis,
) -> BTreeMap<ValueId, SsaName> {
    let mut sources = BTreeMap::new();
    let mut forwarded_values = BTreeMap::new();
    for block in &function.blocks {
        for instruction in &block.instructions {
            let Some(result) = instruction.result else {
                continue;
            };
            match &instruction.kind {
                HirInstructionKind::Read { .. } => {
                    let Some(paths) = dependencies.value_dependencies.get(result.as_usize()) else {
                        continue;
                    };
                    if let [path] = paths.as_slice()
                        && path.segments.is_empty()
                        && let DependencyBase::Ssa(name) = path.base
                    {
                        sources.insert(result, name);
                    }
                }
                HirInstructionKind::Write { value, .. } => {
                    forwarded_values.insert(result, *value);
                }
                HirInstructionKind::PatternAssignment { value, .. } => {
                    forwarded_values.insert(result, *value);
                }
                HirInstructionKind::Sequence { values } => {
                    if let Some(value) = values.last() {
                        forwarded_values.insert(result, *value);
                    }
                }
                _ => {}
            }
        }
    }
    for result in forwarded_values.keys().copied().collect::<Vec<_>>() {
        let mut value = result;
        let mut visited = BTreeSet::new();
        while visited.insert(value) {
            if let Some(source) = sources.get(&value).copied() {
                sources.insert(result, source);
                break;
            }
            let Some(next) = forwarded_values.get(&value).copied() else {
                break;
            };
            value = next;
        }
    }
    sources
}

fn build_invalidations(
    dependencies: &DependencyAnalysis,
    members: &BTreeMap<SsaName, Vec<SsaName>>,
    all_definitions: &BTreeSet<SsaName>,
) -> Vec<AliasInvalidation> {
    let mut invalidations = Vec::new();
    for write in &dependencies.writes {
        if write.path.segments.is_empty() {
            continue;
        }
        if let DependencyBase::Ssa(name) = write.path.base {
            invalidations.push(AliasInvalidation {
                location: write.location,
                reason: AliasInvalidationReason::ProjectedWrite,
                affected: members.get(&name).cloned().unwrap_or_else(|| vec![name]),
            });
        }
    }
    for escape in &dependencies.escapes {
        let Some(location) = escape.location else {
            continue;
        };
        let reason = match escape.kind {
            EscapeKind::UnknownCall | EscapeKind::CallbackCapture => {
                AliasInvalidationReason::UnknownCall
            }
            EscapeKind::ObservableWrite => AliasInvalidationReason::ObservableWrite,
            EscapeKind::Return
            | EscapeKind::Throw
            | EscapeKind::Constructor
            | EscapeKind::DeferredCapture
            | EscapeKind::SyntaxFragment => continue,
        };
        if let DependencyBase::Ssa(name) = escape.path.base {
            invalidations.push(AliasInvalidation {
                location,
                reason,
                affected: members.get(&name).cloned().unwrap_or_else(|| vec![name]),
            });
        }
    }
    for barrier in &dependencies.barriers {
        if !barrier.kinds.contains(&BarrierKind::UnknownMutation)
            || all_definitions.is_empty()
            || invalidations
                .iter()
                .any(|invalidation| invalidation.location == barrier.location)
        {
            continue;
        }
        invalidations.push(AliasInvalidation {
            location: barrier.location,
            reason: AliasInvalidationReason::UnknownBarrier,
            affected: all_definitions.iter().copied().collect(),
        });
    }
    invalidations.sort_by(|left, right| {
        left.location
            .cmp(&right.location)
            .then_with(|| left.reason.cmp(&right.reason))
            .then_with(|| left.affected.cmp(&right.affected))
    });
    invalidations.dedup();
    invalidations
}

fn resolve_root(mut name: SsaName, parents: &BTreeMap<SsaName, SsaName>) -> SsaName {
    let mut remaining = parents.len().saturating_add(1);
    while remaining > 0 {
        let Some(parent) = parents.get(&name).copied() else {
            break;
        };
        if parent == name {
            break;
        }
        name = parent;
        remaining -= 1;
    }
    name
}

fn place_local(base: PlaceBase) -> Option<LocalId> {
    match base {
        PlaceBase::Local(local) => Some(local),
        PlaceBase::Ssa(name) => Some(name.local),
        PlaceBase::Global(_) | PlaceBase::Value(_) => None,
    }
}

fn alias_error(code: &'static str, message: impl Into<String>) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("alias diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(GuaranteeClass::Internal)
}

fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
