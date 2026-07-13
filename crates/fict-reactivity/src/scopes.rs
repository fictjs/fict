use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_hir::{
    BlockId, EvaluationMode, FictMacroKind, FunctionId, HirFile, HirInstructionKind,
    MutationEffect, Purity, ReactiveCallKind, SsaName,
};

use crate::{
    DependencyAnalysis, DependencyBase, DependencyPath, ShapeAnalysis, ShapeKind, ShapeSource,
    SsaAnalysis, SsaDefinitionLocation, verify_dependencies, verify_shapes, verify_ssa,
};

/// How a reactive SSA binding obtained tracked semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ReactiveBindingKind {
    /// `$state` result.
    State,
    /// `$memo` result.
    Memo,
    /// `$store` deep proxy result.
    Store,
    /// `resource` factory result.
    Resource,
    /// `createSelector` keyed accessor result.
    Selector,
    /// Direct alias of another tracked binding.
    Alias,
    /// Pure value transitively derived from tracked inputs.
    Derived,
}

impl ReactiveBindingKind {
    /// Stateful roots own invalidation independently and therefore break derived SCCs.
    #[must_use]
    pub const fn breaks_derived_cycle(self) -> bool {
        matches!(self, Self::State | Self::Store | Self::Resource)
    }
}

/// One tracked SSA definition and its external inputs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReactiveBindingFact {
    /// Versioned local definition.
    pub name: SsaName,
    /// Reactive classification.
    pub kind: ReactiveBindingKind,
    /// Sorted dependencies used to compute this definition.
    pub dependencies: Vec<DependencyPath>,
    /// Defining instruction/Phi, absent only for impossible entry seeds.
    pub location: SsaDefinitionLocation,
}

/// Reactive activity attached to one CFG block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReactiveBlockFact {
    /// CFG block.
    pub block: BlockId,
    /// Tracked definitions created in the block.
    pub declarations: Vec<SsaName>,
    /// Tracked paths read by the block.
    pub reads: Vec<DependencyPath>,
    /// Tracked paths written by the block.
    pub writes: Vec<DependencyPath>,
    /// Tracked reads controlling a terminator.
    pub control_flow_reads: Vec<DependencyPath>,
    /// Effect macro or observable/unknown mutation occurs in the block.
    pub has_external_effect: bool,
    /// Reordering barrier occurs in the block.
    pub has_barrier: bool,
}

/// Reactive-scope pass statistics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ReactiveScopeStats {
    /// Tracked SSA bindings.
    pub bindings: u32,
    /// CFG blocks with reactive activity.
    pub active_blocks: u32,
    /// Pure derived bindings.
    pub derived_bindings: u32,
    /// Blocks containing external effects.
    pub effect_blocks: u32,
    /// Fixed-point sweeps.
    pub fixed_point_iterations: u32,
}

/// Binding-aware tracked-value and per-block scope facts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReactiveScopeAnalysis {
    /// Tracked definitions sorted by SSA name.
    pub bindings: Vec<ReactiveBindingFact>,
    /// Active blocks sorted by block ID.
    pub blocks: Vec<ReactiveBlockFact>,
    /// Deterministic pass statistics.
    pub stats: ReactiveScopeStats,
}

/// Propagate state/memo identity into pure derived definitions and reactive block facts.
pub fn analyze_reactive_scopes(
    file: &HirFile,
    function_id: FunctionId,
    ssa: &SsaAnalysis,
    dependencies: &DependencyAnalysis,
    shapes: &ShapeAnalysis,
) -> Result<ReactiveScopeAnalysis, DiagnosticBundle> {
    let Some(function) = file.functions.get(function_id.as_usize()) else {
        return Err(DiagnosticBundle::new(vec![scope_error(
            "FICT-SCOPE-FUNCTION",
            "reactive scope function is outside the HIR arena",
        )]));
    };
    verify_ssa(function, ssa)?;
    verify_dependencies(file, function_id, ssa, dependencies)?;
    let empty_aliases = crate::AliasAnalysis {
        edges: Vec::new(),
        classes: ssa
            .definitions
            .iter()
            .map(|definition| crate::AliasClass {
                root: definition.name,
                members: vec![definition.name],
            })
            .collect(),
        invalidations: Vec::new(),
        stats: crate::AliasStats {
            classes: count_u32(ssa.definitions.len()),
            ..crate::AliasStats::default()
        },
    };
    // Shape's own verifier only needs the alias partition. The real alias verifier
    // already ran inside shape construction and cannot be reconstructed from shapes.
    verify_shapes(function, ssa, &empty_aliases, shapes)?;

    let shape_by_name: BTreeMap<_, _> = shapes
        .shapes
        .iter()
        .map(|fact| (fact.name, &fact.shape))
        .collect();
    let candidates = binding_candidates(function, ssa, dependencies);
    let mut kinds = BTreeMap::new();
    for definition in &ssa.definitions {
        let Some(shape) = shape_by_name.get(&definition.name) else {
            continue;
        };
        let kind = match shape.source {
            ShapeSource::ReactiveMacro(FictMacroKind::State) => Some(ReactiveBindingKind::State),
            ShapeSource::ReactiveMacro(FictMacroKind::Memo) => Some(ReactiveBindingKind::Memo),
            ShapeSource::RuntimeReactive(ReactiveCallKind::Store) => {
                Some(ReactiveBindingKind::Store)
            }
            ShapeSource::RuntimeReactive(ReactiveCallKind::Resource) => {
                Some(ReactiveBindingKind::Resource)
            }
            ShapeSource::RuntimeReactive(ReactiveCallKind::Selector) => {
                Some(ReactiveBindingKind::Selector)
            }
            ShapeSource::Alias(_) if shape.kind == ShapeKind::Reactive => {
                Some(ReactiveBindingKind::Alias)
            }
            ShapeSource::Entry
            | ShapeSource::Parameter
            | ShapeSource::Literal(_)
            | ShapeSource::TemplateLiteral(_)
            | ShapeSource::DynamicImport(_)
            | ShapeSource::ObjectLiteral(_)
            | ShapeSource::ArrayLiteral(_)
            | ShapeSource::Function(_)
            | ShapeSource::UnknownOperation
            | ShapeSource::ReactiveMacro(FictMacroKind::Effect)
            | ShapeSource::Alias(_)
            | ShapeSource::Phi => None,
        };
        if let Some(kind) = kind {
            kinds.insert(definition.name, kind);
        }
    }

    let maximum_iterations = ssa.definitions.len().saturating_add(2);
    let mut iterations = 0_usize;
    loop {
        iterations = iterations.saturating_add(1);
        if iterations > maximum_iterations {
            return Err(DiagnosticBundle::new(vec![scope_error(
                "FICT-SCOPE-FIXED-POINT",
                "reactive binding propagation exceeded its deterministic iteration limit",
            )]));
        }
        let previous = kinds.clone();
        for candidate in &candidates {
            if previous.contains_key(&candidate.name) || !candidate.eligible_for_derivation {
                continue;
            }
            if candidate.dependencies.iter().any(|path| {
                matches!(path.base, DependencyBase::Ssa(source) if previous.contains_key(&source))
            }) || candidate
                .phi_sources
                .iter()
                .any(|source| previous.contains_key(source))
            {
                kinds.insert(candidate.name, ReactiveBindingKind::Derived);
            }
        }
        if kinds == previous {
            break;
        }
    }

    let candidate_by_name: BTreeMap<_, _> = candidates
        .iter()
        .map(|candidate| (candidate.name, candidate))
        .collect();
    let bindings: Vec<_> = ssa
        .definitions
        .iter()
        .filter_map(|definition| {
            let kind = kinds.get(&definition.name).copied()?;
            let dependencies = candidate_by_name
                .get(&definition.name)
                .map_or_else(Vec::new, |candidate| candidate.dependencies.clone());
            Some(ReactiveBindingFact {
                name: definition.name,
                kind,
                dependencies,
                location: definition.location,
            })
        })
        .collect();
    let tracked: BTreeSet<_> = bindings.iter().map(|binding| binding.name).collect();
    let definitions_by_block = definitions_by_block(&bindings);
    let effect_blocks = effect_blocks(function, dependencies);
    let barrier_blocks: BTreeSet<_> = dependencies
        .barriers
        .iter()
        .map(|barrier| barrier.location.block)
        .collect();
    let mut blocks = Vec::new();
    for block in &function.blocks {
        if !ssa.cfg.reachable[block.id.as_usize()] {
            continue;
        }
        let reads = paths_in_block(
            dependencies
                .reads
                .iter()
                .filter(|read| read.location.block == block.id)
                .map(|read| &read.path),
            &tracked,
        );
        let writes = paths_in_block(
            dependencies
                .writes
                .iter()
                .filter(|write| write.location.block == block.id)
                .map(|write| &write.path),
            &tracked,
        );
        let control_flow_reads = paths_in_block(
            dependencies
                .reads
                .iter()
                .filter(|read| read.location.block == block.id && read.controls_flow)
                .map(|read| &read.path),
            &tracked,
        );
        let declarations = definitions_by_block
            .get(&block.id)
            .cloned()
            .unwrap_or_default();
        let has_external_effect = effect_blocks.contains(&block.id);
        let has_barrier = barrier_blocks.contains(&block.id);
        if declarations.is_empty() && reads.is_empty() && writes.is_empty() && !has_external_effect
        {
            continue;
        }
        blocks.push(ReactiveBlockFact {
            block: block.id,
            declarations,
            reads,
            writes,
            control_flow_reads,
            has_external_effect,
            has_barrier,
        });
    }
    let stats = ReactiveScopeStats {
        bindings: count_u32(bindings.len()),
        active_blocks: count_u32(blocks.len()),
        derived_bindings: count_u32(
            bindings
                .iter()
                .filter(|binding| binding.kind == ReactiveBindingKind::Derived)
                .count(),
        ),
        effect_blocks: count_u32(
            blocks
                .iter()
                .filter(|block| block.has_external_effect)
                .count(),
        ),
        fixed_point_iterations: count_u32(iterations),
    };
    let analysis = ReactiveScopeAnalysis {
        bindings,
        blocks,
        stats,
    };
    verify_reactive_scopes(function, ssa, dependencies, &analysis)?;
    Ok(analysis)
}

/// Verify tracked binding identities, block facts, and deterministic statistics.
pub fn verify_reactive_scopes(
    function: &fict_hir::HirFunction,
    ssa: &SsaAnalysis,
    dependencies: &DependencyAnalysis,
    analysis: &ReactiveScopeAnalysis,
) -> Result<(), DiagnosticBundle> {
    let mut diagnostics = DiagnosticBundle::default();
    let definitions: BTreeSet<_> = ssa
        .definitions
        .iter()
        .map(|definition| definition.name)
        .collect();
    let binding_names: BTreeSet<_> = analysis
        .bindings
        .iter()
        .map(|binding| binding.name)
        .collect();
    if binding_names.len() != analysis.bindings.len()
        || binding_names.iter().any(|name| !definitions.contains(name))
    {
        diagnostics.push(scope_error(
            "FICT-SCOPE-BINDING",
            "reactive bindings must be unique known SSA definitions",
        ));
    }
    for binding in &analysis.bindings {
        if binding
            .dependencies
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
        {
            diagnostics.push(scope_error(
                "FICT-SCOPE-DEPS",
                "reactive binding dependencies must be sorted and unique",
            ));
        }
    }
    if analysis
        .blocks
        .windows(2)
        .any(|pair| pair[0].block >= pair[1].block)
    {
        diagnostics.push(scope_error(
            "FICT-SCOPE-BLOCK-ORDER",
            "reactive block facts must be strictly ordered",
        ));
    }
    let dependency_blocks: BTreeSet<_> = dependencies
        .reads
        .iter()
        .map(|read| read.location.block)
        .chain(dependencies.writes.iter().map(|write| write.location.block))
        .collect();
    for block in &analysis.blocks {
        if function.blocks.get(block.block.as_usize()).is_none()
            || (!dependency_blocks.contains(&block.block)
                && block.declarations.is_empty()
                && !block.has_external_effect)
        {
            diagnostics.push(scope_error(
                "FICT-SCOPE-BLOCK",
                "reactive block facts must reference active CFG blocks",
            ));
        }
        for paths in [&block.reads, &block.writes, &block.control_flow_reads] {
            if paths.windows(2).any(|pair| pair[0] >= pair[1]) {
                diagnostics.push(scope_error(
                    "FICT-SCOPE-PATH-ORDER",
                    "reactive block paths must be sorted and unique",
                ));
            }
        }
    }
    if analysis.stats.bindings != count_u32(analysis.bindings.len())
        || analysis.stats.active_blocks != count_u32(analysis.blocks.len())
        || analysis.stats.derived_bindings
            != count_u32(
                analysis
                    .bindings
                    .iter()
                    .filter(|binding| binding.kind == ReactiveBindingKind::Derived)
                    .count(),
            )
        || analysis.stats.effect_blocks
            != count_u32(
                analysis
                    .blocks
                    .iter()
                    .filter(|block| block.has_external_effect)
                    .count(),
            )
        || analysis.stats.fixed_point_iterations == 0
    {
        diagnostics.push(scope_error(
            "FICT-SCOPE-STATS",
            "reactive scope stats do not match result arenas",
        ));
    }
    if diagnostics.is_empty() {
        Ok(())
    } else {
        Err(diagnostics)
    }
}

#[derive(Debug)]
struct BindingCandidate {
    name: SsaName,
    dependencies: Vec<DependencyPath>,
    phi_sources: Vec<SsaName>,
    eligible_for_derivation: bool,
}

fn binding_candidates(
    function: &fict_hir::HirFunction,
    ssa: &SsaAnalysis,
    dependencies: &DependencyAnalysis,
) -> Vec<BindingCandidate> {
    let mut result_semantics = BTreeMap::new();
    for block in &function.blocks {
        for instruction in &block.instructions {
            if let Some(value) = instruction.result {
                result_semantics.insert(value, instruction.semantics);
            }
        }
    }
    ssa.definitions
        .iter()
        .map(|definition| {
            let mut paths = BTreeSet::new();
            let mut phi_sources = Vec::new();
            let mut eligible = false;
            match definition.location {
                SsaDefinitionLocation::Instruction { block, instruction } => {
                    if let Some(hir_instruction) = function
                        .blocks
                        .get(block.as_usize())
                        .and_then(|block| block.instructions.get(instruction as usize))
                    {
                        let value = match &hir_instruction.kind {
                            HirInstructionKind::Declare { initializer, .. } => *initializer,
                            HirInstructionKind::Write { place, value } if place.is_local() => {
                                Some(*value)
                            }
                            HirInstructionKind::Iteration {
                                source, targets, ..
                            } if targets.contains(&definition.name.local) => {
                                paths.extend(
                                    dependencies
                                        .value_dependencies
                                        .get(source.as_usize())
                                        .into_iter()
                                        .flatten()
                                        .cloned(),
                                );
                                None
                            }
                            _ => None,
                        };
                        if let Some(value) = value {
                            paths.extend(
                                dependencies
                                    .value_dependencies
                                    .get(value.as_usize())
                                    .into_iter()
                                    .flatten()
                                    .cloned(),
                            );
                            eligible = result_semantics.get(&value).is_some_and(|semantics| {
                                semantics.purity == Purity::Pure
                                    && semantics.mutation == MutationEffect::None
                                    && semantics.evaluation == EvaluationMode::Eager
                                    && !semantics.may_throw
                            });
                        }
                    }
                }
                SsaDefinitionLocation::Phi(_) => {
                    if let Some(phi) = ssa.phis.iter().find(|phi| phi.target == definition.name) {
                        phi_sources.extend(phi.sources.iter().map(|(_, source)| *source));
                        phi_sources.sort_unstable();
                        phi_sources.dedup();
                        eligible = true;
                    }
                }
                SsaDefinitionLocation::Entry => {}
            }
            BindingCandidate {
                name: definition.name,
                dependencies: paths.into_iter().collect(),
                phi_sources,
                eligible_for_derivation: eligible,
            }
        })
        .collect()
}

fn definitions_by_block(bindings: &[ReactiveBindingFact]) -> BTreeMap<BlockId, Vec<SsaName>> {
    let mut by_block: BTreeMap<BlockId, Vec<SsaName>> = BTreeMap::new();
    for binding in bindings {
        let block = match binding.location {
            SsaDefinitionLocation::Instruction { block, .. }
            | SsaDefinitionLocation::Phi(block) => block,
            SsaDefinitionLocation::Entry => continue,
        };
        by_block.entry(block).or_default().push(binding.name);
    }
    by_block
}

fn effect_blocks(
    function: &fict_hir::HirFunction,
    dependencies: &DependencyAnalysis,
) -> BTreeSet<BlockId> {
    let mut blocks: BTreeSet<_> = dependencies
        .writes
        .iter()
        .filter(|write| {
            matches!(
                write.mutation,
                MutationEffect::Observable | MutationEffect::Unknown
            )
        })
        .map(|write| write.location.block)
        .collect();
    for block in &function.blocks {
        if block.instructions.iter().any(|instruction| {
            matches!(
                &instruction.kind,
                HirInstructionKind::Call(call)
                    if call.macro_kind == Some(FictMacroKind::Effect)
            )
        }) {
            blocks.insert(block.id);
        }
    }
    blocks
}

fn paths_in_block<'a>(
    paths: impl Iterator<Item = &'a DependencyPath>,
    tracked: &BTreeSet<SsaName>,
) -> Vec<DependencyPath> {
    paths
        .filter(|path| matches!(path.base, DependencyBase::Ssa(name) if tracked.contains(&name)))
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn scope_error(code: &'static str, message: impl Into<String>) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("scope diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(GuaranteeClass::Internal)
}

fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
