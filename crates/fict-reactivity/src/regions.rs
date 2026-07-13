use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_hir::{
    BlockId, EvaluationMode, FictMacroKind, HirFile, HirFunction, HirInstructionKind, RegionId,
    ScopeId, SsaName, TerminatorKind,
};

use crate::{
    DependencyAnalysis, DependencyBase, DependencyPath, InstructionLocation, ReactiveCycleAnalysis,
    ReactiveScopeAnalysis, SsaAnalysis, SsaDefinitionLocation, verify_reactive_cycles,
    verify_reactive_scopes,
};

/// Contiguous half-open HIR instruction range owned by one region.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RegionInstructionRange {
    /// CFG block.
    pub block: BlockId,
    /// First owned instruction index.
    pub start: u32,
    /// Exclusive end instruction index.
    pub end: u32,
}

/// One barrier-safe reactive evaluation region.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReactiveRegion {
    /// Dense function-local region identity.
    pub id: RegionId,
    /// Lexical scope active in the region's block.
    pub scope: ScopeId,
    /// Contiguous ranges in deterministic CFG/source order.
    pub ranges: Vec<RegionInstructionRange>,
    /// CFG blocks covered by the region.
    pub blocks: Vec<BlockId>,
    /// External tracked dependencies.
    pub inputs: Vec<DependencyPath>,
    /// Tracked SSA definitions produced by this region.
    pub outputs: Vec<SsaName>,
    /// Parent lexical/dominating region.
    pub parent: Option<RegionId>,
    /// Nested regions.
    pub children: Vec<RegionId>,
    /// Reactive terminator/control read is owned by this region.
    pub has_control_flow: bool,
    /// JSX materialization occurs in the ranges.
    pub has_jsx: bool,
    /// Await/yield/deferred evaluation occurs in the ranges.
    pub has_async: bool,
    /// Effect macro or observable/unknown mutation occurs in the ranges.
    pub has_external_effect: bool,
    /// A reordering barrier instruction is owned by this region.
    pub has_barrier: bool,
    /// A derived SCC prevents memoized evaluation.
    pub cycle_blocked: bool,
    /// Region is safe and useful to memoize.
    pub should_memoize: bool,
}

/// Region formation statistics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RegionStats {
    /// Regions emitted.
    pub regions: u32,
    /// Instruction ranges.
    pub ranges: u32,
    /// Memoizable regions.
    pub memoized_regions: u32,
    /// Control-flow regions.
    pub control_flow_regions: u32,
    /// Barrier singleton regions.
    pub barrier_regions: u32,
    /// Maximum parent/child nesting depth.
    pub maximum_depth: u32,
}

/// Complete region plan and per-block lookup table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegionAnalysis {
    /// Dense region arena.
    pub regions: Vec<ReactiveRegion>,
    /// Region IDs by CFG block.
    pub regions_by_block: Vec<Vec<RegionId>>,
    /// Regions without a parent.
    pub top_level_regions: Vec<RegionId>,
    /// Deterministic statistics.
    pub stats: RegionStats,
}

/// Form barrier-safe reactive regions and lexical/dominating hierarchy.
pub fn analyze_regions(
    file: &HirFile,
    function: &HirFunction,
    ssa: &SsaAnalysis,
    dependencies: &DependencyAnalysis,
    scopes: &ReactiveScopeAnalysis,
    cycles: &ReactiveCycleAnalysis,
) -> Result<RegionAnalysis, DiagnosticBundle> {
    verify_reactive_scopes(function, ssa, dependencies, scopes)?;
    verify_reactive_cycles(function, scopes, cycles)?;
    let tracked: BTreeSet<_> = scopes.bindings.iter().map(|binding| binding.name).collect();
    let mut active_by_block: BTreeMap<BlockId, BTreeSet<u32>> = BTreeMap::new();
    let mut phi_outputs: BTreeMap<BlockId, Vec<SsaName>> = BTreeMap::new();
    for binding in &scopes.bindings {
        match binding.location {
            SsaDefinitionLocation::Instruction { block, instruction } => {
                active_by_block
                    .entry(block)
                    .or_default()
                    .insert(instruction);
            }
            SsaDefinitionLocation::Phi(block) => {
                phi_outputs.entry(block).or_default().push(binding.name);
            }
            SsaDefinitionLocation::Entry => {}
        }
    }
    for read in &dependencies.reads {
        if path_is_tracked(&read.path, &tracked) {
            active_by_block
                .entry(read.location.block)
                .or_default()
                .insert(read.location.instruction);
        }
    }
    for write in &dependencies.writes {
        if path_is_tracked(&write.path, &tracked) {
            active_by_block
                .entry(write.location.block)
                .or_default()
                .insert(write.location.instruction);
        }
    }
    for block in &function.blocks {
        for (index, instruction) in block.instructions.iter().enumerate() {
            if matches!(
                &instruction.kind,
                HirInstructionKind::Call(call) if call.macro_kind.is_some()
            ) {
                active_by_block
                    .entry(block.id)
                    .or_default()
                    .insert(count_u32(index));
            }
        }
    }
    let barriers: BTreeMap<_, _> = dependencies
        .barriers
        .iter()
        .map(|barrier| (barrier.location, barrier))
        .collect();
    let cyclic_nodes: BTreeSet<_> = cycles
        .cycles
        .iter()
        .flat_map(|cycle| cycle.nodes.iter().copied())
        .collect();
    let mut regions = Vec::new();
    for block in &function.blocks {
        if !ssa.cfg.reachable[block.id.as_usize()] {
            continue;
        }
        let active = active_by_block.get(&block.id).cloned().unwrap_or_default();
        let has_phi = phi_outputs.contains_key(&block.id);
        if active.is_empty() && !has_phi {
            continue;
        }
        let ranges = split_ranges(block, &active, &barriers);
        if ranges.is_empty() && has_phi {
            regions.push(build_region(
                file,
                function,
                scopes,
                dependencies,
                &cyclic_nodes,
                RegionId::new(count_u32(regions.len())),
                RegionInstructionRange {
                    block: block.id,
                    start: 0,
                    end: 0,
                },
                phi_outputs.get(&block.id).map_or(&[][..], Vec::as_slice),
                false,
            ));
            continue;
        }
        for (range_index, (range, has_barrier)) in ranges.iter().enumerate() {
            let phis = if range_index == 0 {
                phi_outputs.get(&block.id).map_or(&[][..], Vec::as_slice)
            } else {
                &[]
            };
            regions.push(build_region(
                file,
                function,
                scopes,
                dependencies,
                &cyclic_nodes,
                RegionId::new(count_u32(regions.len())),
                *range,
                phis,
                *has_barrier,
            ));
        }
    }
    assign_hierarchy(file, function, ssa, &mut regions);
    let mut regions_by_block = vec![Vec::new(); function.blocks.len()];
    for region in &regions {
        for block in &region.blocks {
            regions_by_block[block.as_usize()].push(region.id);
        }
    }
    let top_level_regions = regions
        .iter()
        .filter(|region| region.parent.is_none())
        .map(|region| region.id)
        .collect();
    let stats = RegionStats {
        regions: count_u32(regions.len()),
        ranges: count_u32(regions.iter().map(|region| region.ranges.len()).sum()),
        memoized_regions: count_u32(
            regions
                .iter()
                .filter(|region| region.should_memoize)
                .count(),
        ),
        control_flow_regions: count_u32(
            regions
                .iter()
                .filter(|region| region.has_control_flow)
                .count(),
        ),
        barrier_regions: count_u32(regions.iter().filter(|region| region.has_barrier).count()),
        maximum_depth: maximum_depth(&regions),
    };
    let analysis = RegionAnalysis {
        regions,
        regions_by_block,
        top_level_regions,
        stats,
    };
    verify_regions(function, dependencies, scopes, cycles, &analysis)?;
    Ok(analysis)
}

/// Copy region identities into a verified HIR function for downstream emission.
#[must_use]
pub fn materialize_regions(function: &HirFunction, analysis: &RegionAnalysis) -> HirFunction {
    let mut result = function.clone();
    result.regions = analysis.regions.iter().map(|region| region.id).collect();
    result
}

/// Verify range/barrier safety, I/O ownership, hierarchy, indexes, and stats.
pub fn verify_regions(
    function: &HirFunction,
    dependencies: &DependencyAnalysis,
    scopes: &ReactiveScopeAnalysis,
    cycles: &ReactiveCycleAnalysis,
    analysis: &RegionAnalysis,
) -> Result<(), DiagnosticBundle> {
    let mut diagnostics = DiagnosticBundle::default();
    let expected_ids: Vec<_> = (0..analysis.regions.len())
        .map(|index| RegionId::new(count_u32(index)))
        .collect();
    let actual_ids: Vec<_> = analysis.regions.iter().map(|region| region.id).collect();
    if actual_ids != expected_ids {
        diagnostics.push(region_error(
            "FICT-REGION-ID",
            "region IDs must be dense and arena ordered",
        ));
    }
    let barrier_locations: BTreeSet<_> = dependencies
        .barriers
        .iter()
        .map(|barrier| barrier.location)
        .collect();
    let cyclic_nodes: BTreeSet<_> = cycles
        .cycles
        .iter()
        .flat_map(|cycle| cycle.nodes.iter().copied())
        .collect();
    let mut output_owners = BTreeMap::new();
    let mut ranges_by_block: BTreeMap<BlockId, Vec<RegionInstructionRange>> = BTreeMap::new();
    for region in &analysis.regions {
        if region.ranges.is_empty()
            || region.ranges.windows(2).any(|pair| pair[0] >= pair[1])
            || region.inputs.windows(2).any(|pair| pair[0] >= pair[1])
            || region.outputs.windows(2).any(|pair| pair[0] >= pair[1])
            || region.children.windows(2).any(|pair| pair[0] >= pair[1])
        {
            diagnostics.push(region_error(
                "FICT-REGION-ORDER",
                "region ranges, inputs, outputs, and children must be sorted and unique",
            ));
        }
        for range in &region.ranges {
            let valid = function
                .blocks
                .get(range.block.as_usize())
                .is_some_and(|block| {
                    range.start <= range.end && range.end as usize <= block.instructions.len()
                });
            if !valid {
                diagnostics.push(region_error(
                    "FICT-REGION-RANGE",
                    "region instruction range is outside its CFG block",
                ));
            }
            ranges_by_block.entry(range.block).or_default().push(*range);
            let contained_barriers = (range.start..range.end)
                .filter(|index| {
                    barrier_locations.contains(&InstructionLocation {
                        block: range.block,
                        instruction: *index,
                    })
                })
                .count();
            if contained_barriers > 0 && range.end.saturating_sub(range.start) != 1 {
                diagnostics.push(region_error(
                    "FICT-REGION-BARRIER",
                    "a region cannot cross a reordering barrier",
                ));
            }
            if region.has_barrier != (contained_barriers > 0) {
                diagnostics.push(region_error(
                    "FICT-REGION-BARRIER-FLAG",
                    "region barrier flag must match its instruction ranges",
                ));
            }
        }
        for output in &region.outputs {
            if output_owners.insert(*output, region.id).is_some() {
                diagnostics.push(region_error(
                    "FICT-REGION-OUTPUT",
                    "tracked output must be owned by exactly one region",
                ));
            }
        }
        let expected_cycle_blocked = region
            .outputs
            .iter()
            .any(|output| cyclic_nodes.contains(output));
        if region.cycle_blocked != expected_cycle_blocked
            || (region.should_memoize
                && (region.inputs.is_empty()
                    || region.has_async
                    || region.has_external_effect
                    || region.has_barrier
                    || region.cycle_blocked
                    || function.flags.no_memo))
        {
            diagnostics.push(region_error(
                "FICT-REGION-MEMO",
                "memoization flag violates region safety requirements",
            ));
        }
        if let Some(parent) = region.parent
            && (parent == region.id
                || analysis
                    .regions
                    .get(parent.as_usize())
                    .is_none_or(|owner| !owner.children.contains(&region.id)))
        {
            diagnostics.push(region_error(
                "FICT-REGION-PARENT",
                "region parent/child links must be bidirectionally consistent",
            ));
        }
        for child in &region.children {
            if analysis
                .regions
                .get(child.as_usize())
                .is_none_or(|nested| nested.parent != Some(region.id))
            {
                diagnostics.push(region_error(
                    "FICT-REGION-CHILD",
                    "region child link must reference its parent",
                ));
            }
        }
    }
    for ranges in ranges_by_block.values_mut() {
        ranges.sort_unstable();
        if ranges.windows(2).any(|pair| pair[0].end > pair[1].start) {
            diagnostics.push(region_error(
                "FICT-REGION-OVERLAP",
                "sibling region instruction ranges cannot overlap",
            ));
        }
    }
    let expected_outputs: BTreeSet<_> = scopes
        .bindings
        .iter()
        .filter(|binding| binding.location != SsaDefinitionLocation::Entry)
        .map(|binding| binding.name)
        .collect();
    if output_owners.keys().copied().collect::<BTreeSet<_>>() != expected_outputs {
        diagnostics.push(region_error(
            "FICT-REGION-OUTPUT-COVERAGE",
            "regions must own every non-entry tracked definition exactly once",
        ));
    }
    if analysis.regions_by_block.len() != function.blocks.len() {
        diagnostics.push(region_error(
            "FICT-REGION-BLOCK-INDEX",
            "region block index must match the CFG arena",
        ));
    } else {
        for (block_index, ids) in analysis.regions_by_block.iter().enumerate() {
            if ids.windows(2).any(|pair| pair[0] >= pair[1])
                || ids.iter().any(|id| {
                    analysis.regions.get(id.as_usize()).is_none_or(|region| {
                        !region
                            .blocks
                            .contains(&BlockId::new(count_u32(block_index)))
                    })
                })
            {
                diagnostics.push(region_error(
                    "FICT-REGION-BLOCK-INDEX",
                    "per-block region IDs must be sorted and reference owning regions",
                ));
            }
        }
    }
    let expected_top: Vec<_> = analysis
        .regions
        .iter()
        .filter(|region| region.parent.is_none())
        .map(|region| region.id)
        .collect();
    if analysis.top_level_regions != expected_top
        || analysis.stats.regions != count_u32(analysis.regions.len())
        || analysis.stats.ranges
            != count_u32(
                analysis
                    .regions
                    .iter()
                    .map(|region| region.ranges.len())
                    .sum(),
            )
        || analysis.stats.memoized_regions
            != count_u32(
                analysis
                    .regions
                    .iter()
                    .filter(|region| region.should_memoize)
                    .count(),
            )
        || analysis.stats.control_flow_regions
            != count_u32(
                analysis
                    .regions
                    .iter()
                    .filter(|region| region.has_control_flow)
                    .count(),
            )
        || analysis.stats.barrier_regions
            != count_u32(
                analysis
                    .regions
                    .iter()
                    .filter(|region| region.has_barrier)
                    .count(),
            )
        || analysis.stats.maximum_depth != maximum_depth(&analysis.regions)
    {
        diagnostics.push(region_error(
            "FICT-REGION-STATS",
            "region indexes or stats do not match the region arena",
        ));
    }
    if diagnostics.is_empty() {
        Ok(())
    } else {
        Err(diagnostics)
    }
}

fn split_ranges(
    block: &fict_hir::HirBlock,
    active: &BTreeSet<u32>,
    barriers: &BTreeMap<InstructionLocation, &crate::BarrierFact>,
) -> Vec<(RegionInstructionRange, bool)> {
    let mut result = Vec::new();
    let mut window_start = 0_u32;
    let instruction_count = count_u32(block.instructions.len());
    for index in 0..instruction_count {
        let location = InstructionLocation {
            block: block.id,
            instruction: index,
        };
        if !barriers.contains_key(&location) {
            continue;
        }
        push_active_window(&mut result, block.id, window_start, index, active);
        if active.contains(&index) {
            result.push((
                RegionInstructionRange {
                    block: block.id,
                    start: index,
                    end: index.saturating_add(1),
                },
                true,
            ));
        }
        window_start = index.saturating_add(1);
    }
    push_active_window(
        &mut result,
        block.id,
        window_start,
        instruction_count,
        active,
    );
    result
}

fn push_active_window(
    result: &mut Vec<(RegionInstructionRange, bool)>,
    block: BlockId,
    start: u32,
    end: u32,
    active: &BTreeSet<u32>,
) {
    let first = active.range(start..end).next().copied();
    let last = active.range(start..end).next_back().copied();
    if let (Some(first), Some(last)) = (first, last) {
        result.push((
            RegionInstructionRange {
                block,
                start: first,
                end: last.saturating_add(1),
            },
            false,
        ));
    }
}

#[allow(clippy::too_many_arguments)]
fn build_region(
    _file: &HirFile,
    function: &HirFunction,
    scopes: &ReactiveScopeAnalysis,
    dependencies: &DependencyAnalysis,
    cyclic_nodes: &BTreeSet<SsaName>,
    id: RegionId,
    range: RegionInstructionRange,
    phi_outputs: &[SsaName],
    has_barrier: bool,
) -> ReactiveRegion {
    let block = &function.blocks[range.block.as_usize()];
    let contains = |location: InstructionLocation| {
        location.block == range.block
            && location.instruction >= range.start
            && location.instruction < range.end
    };
    let mut outputs: BTreeSet<_> = phi_outputs.iter().copied().collect();
    outputs.extend(scopes.bindings.iter().filter_map(|binding| {
        if let SsaDefinitionLocation::Instruction { block, instruction } = binding.location
            && contains(InstructionLocation { block, instruction })
        {
            return Some(binding.name);
        }
        None
    }));
    let mut inputs: BTreeSet<_> = dependencies
        .reads
        .iter()
        .filter(|read| contains(read.location))
        .map(|read| read.path.clone())
        .filter(|path| !matches!(path.base, DependencyBase::Ssa(name) if outputs.contains(&name)))
        .collect();
    for output in phi_outputs {
        if let Some(binding) = scopes
            .bindings
            .iter()
            .find(|binding| binding.name == *output)
        {
            inputs.extend(
                binding
                    .dependencies
                    .iter()
                    .filter(|path| {
                        !matches!(path.base, DependencyBase::Ssa(name) if outputs.contains(&name))
                    })
                    .cloned(),
            );
        }
    }
    let has_external_effect = block
        .instructions
        .get(range.start as usize..range.end as usize)
        .unwrap_or(&[])
        .iter()
        .any(|instruction| {
            instruction.semantics.has_observable_mutation()
                || matches!(
                    &instruction.kind,
                    HirInstructionKind::Call(call)
                        if call.macro_kind == Some(FictMacroKind::Effect)
                )
        });
    let has_jsx = block
        .instructions
        .get(range.start as usize..range.end as usize)
        .unwrap_or(&[])
        .iter()
        .any(|instruction| matches!(instruction.kind, HirInstructionKind::Jsx { .. }));
    let has_async = block
        .instructions
        .get(range.start as usize..range.end as usize)
        .unwrap_or(&[])
        .iter()
        .any(|instruction| {
            instruction.semantics.evaluation == EvaluationMode::Deferred
                || matches!(
                    instruction.kind,
                    HirInstructionKind::Await { .. }
                        | HirInstructionKind::Yield { .. }
                        | HirInstructionKind::Iteration {
                            kind: fict_hir::IterationKind::AwaitOf,
                            ..
                        }
                )
        });
    let owns_last_instruction = range.end as usize == block.instructions.len();
    let has_control_flow = owns_last_instruction
        && scopes
            .blocks
            .iter()
            .find(|fact| fact.block == block.id)
            .is_some_and(|fact| !fact.control_flow_reads.is_empty())
        && matches!(
            block.terminator.kind,
            TerminatorKind::Branch { .. }
                | TerminatorKind::ForIn { .. }
                | TerminatorKind::ForOf { .. }
                | TerminatorKind::Switch { .. }
                | TerminatorKind::Try { .. }
        );
    let cycle_blocked = outputs.iter().any(|output| cyclic_nodes.contains(output));
    let should_memoize = !function.flags.no_memo
        && !inputs.is_empty()
        && !has_async
        && !has_external_effect
        && !has_barrier
        && !cycle_blocked;
    ReactiveRegion {
        id,
        scope: block.scope,
        ranges: vec![range],
        blocks: vec![block.id],
        inputs: inputs.into_iter().collect(),
        outputs: outputs.into_iter().collect(),
        parent: None,
        children: Vec::new(),
        has_control_flow,
        has_jsx,
        has_async,
        has_external_effect,
        has_barrier,
        cycle_blocked,
        should_memoize,
    }
}

fn assign_hierarchy(
    file: &HirFile,
    function: &HirFunction,
    ssa: &SsaAnalysis,
    regions: &mut [ReactiveRegion],
) {
    let scope_parent: BTreeMap<_, _> = file
        .scopes
        .iter()
        .map(|scope| (scope.id, scope.parent))
        .collect();
    let snapshots = regions.to_vec();
    for child in regions.iter_mut() {
        let child_block = child.blocks[0];
        let mut candidates: Vec<_> = snapshots
            .iter()
            .filter(|parent| {
                parent.id != child.id
                    && scope_is_ancestor(parent.scope, child.scope, &scope_parent)
                    && parent.scope != child.scope
                    && ssa.cfg.dominates(parent.blocks[0], child_block)
            })
            .collect();
        candidates
            .sort_by_key(|parent| (scope_depth(parent.scope, &scope_parent), parent.id.index()));
        child.parent = candidates.last().map(|parent| parent.id);
    }
    let parent_links: Vec<_> = regions
        .iter()
        .filter_map(|region| region.parent.map(|parent| (parent, region.id)))
        .collect();
    for (parent, child) in parent_links {
        if let Some(region) = regions.get_mut(parent.as_usize()) {
            region.children.push(child);
        }
    }
    let _ = function;
}

fn scope_is_ancestor(
    ancestor: ScopeId,
    mut scope: ScopeId,
    parents: &BTreeMap<ScopeId, Option<ScopeId>>,
) -> bool {
    let mut remaining = parents.len().saturating_add(1);
    while remaining > 0 {
        if scope == ancestor {
            return true;
        }
        let Some(Some(parent)) = parents.get(&scope) else {
            return false;
        };
        scope = *parent;
        remaining -= 1;
    }
    false
}

fn scope_depth(mut scope: ScopeId, parents: &BTreeMap<ScopeId, Option<ScopeId>>) -> usize {
    let mut depth = 0_usize;
    let mut remaining = parents.len().saturating_add(1);
    while remaining > 0 {
        let Some(Some(parent)) = parents.get(&scope) else {
            break;
        };
        depth = depth.saturating_add(1);
        scope = *parent;
        remaining -= 1;
    }
    depth
}

fn maximum_depth(regions: &[ReactiveRegion]) -> u32 {
    regions
        .iter()
        .map(|region| {
            let mut depth = 1_u32;
            let mut parent = region.parent;
            let mut remaining = regions.len();
            while let Some(id) = parent {
                if remaining == 0 {
                    return u32::MAX;
                }
                depth = depth.saturating_add(1);
                parent = regions.get(id.as_usize()).and_then(|region| region.parent);
                remaining -= 1;
            }
            depth
        })
        .max()
        .unwrap_or(0)
}

fn path_is_tracked(path: &DependencyPath, tracked: &BTreeSet<SsaName>) -> bool {
    matches!(path.base, DependencyBase::Ssa(name) if tracked.contains(&name))
}

fn region_error(code: &'static str, message: impl Into<String>) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("region diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(GuaranteeClass::Internal)
}

fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
