use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write;

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_hir::{
    BlockId, HirFunction, HirInstruction, HirInstructionKind, HirValue, LocalId, LocalKind, Place,
    PlaceBase, SsaName, SsaVersion, ValueId, ValueKind,
};

use crate::{CfgAnalysis, analyze_cfg};

/// Kind of definition that creates one structural SSA name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SsaDefinitionKind {
    /// Initial function-entry storage state.
    Entry,
    /// Function parameter value available at entry.
    Parameter,
    /// HIR declaration instruction.
    Declare,
    /// Direct local assignment.
    Write,
    /// Direct local compound assignment or update.
    ReadWrite,
    /// Per-step binding or assignment performed by an iteration loop.
    Iteration,
    /// Dominance-frontier merge.
    Phi,
}

/// Location of an SSA definition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SsaDefinitionLocation {
    /// Implicit function entry.
    Entry,
    /// Phi list at block entry.
    Phi(BlockId),
    /// HIR instruction index in one block.
    Instruction {
        /// Defining block.
        block: BlockId,
        /// Zero-based instruction index before Phi materialization.
        instruction: u32,
    },
}

/// One unique SSA definition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SsaDefinition {
    /// Structural local/version identity.
    pub name: SsaName,
    /// Source operation category.
    pub kind: SsaDefinitionKind,
    /// Definition location.
    pub location: SsaDefinitionLocation,
}

/// Kind of local use observed by SSA construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SsaUseKind {
    /// Local or property read.
    Read,
    /// Base-object read required by a projected write.
    ProjectedWriteBase,
    /// Read side of a compound assignment or update.
    ReadWrite,
    /// Incoming Phi edge.
    Phi,
}

/// Location of an SSA use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SsaUseLocation {
    /// HIR instruction use.
    Instruction {
        /// Containing block.
        block: BlockId,
        /// Zero-based instruction index before Phi materialization.
        instruction: u32,
    },
    /// Value flowing from a predecessor into a successor Phi.
    PhiEdge {
        /// Source CFG block.
        predecessor: BlockId,
        /// Phi-containing successor.
        successor: BlockId,
    },
}

/// One resolved SSA use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SsaUse {
    /// Structural definition identity read at this site.
    pub name: SsaName,
    /// Use category.
    pub kind: SsaUseKind,
    /// Use location.
    pub location: SsaUseLocation,
}

/// Phi node computed for one block/local pair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SsaPhi {
    /// Merge block.
    pub block: BlockId,
    /// Newly defined version.
    pub target: SsaName,
    /// Reachable predecessor and incoming name pairs in block-ID order.
    pub sources: Vec<(BlockId, SsaName)>,
}

/// Bounded pass statistics exposed to optimizer/explain layers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SsaStats {
    /// Reachable blocks processed.
    pub reachable_blocks: u32,
    /// Definition records including implicit entry definitions.
    pub definitions: u32,
    /// Use records including Phi edges.
    pub uses: u32,
    /// Inserted Phi nodes.
    pub phis: u32,
    /// Dominance-frontier worklist pops.
    pub phi_worklist_steps: u32,
}

/// Complete SSA side table for one HIR function.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SsaAnalysis {
    /// CFG facts used to construct this result.
    pub cfg: CfgAnalysis,
    /// Unique definitions in deterministic construction order.
    pub definitions: Vec<SsaDefinition>,
    /// Uses in deterministic block/instruction/edge order.
    pub uses: Vec<SsaUse>,
    /// Phi nodes in block/local order.
    pub phis: Vec<SsaPhi>,
    /// Current version before block-entry Phi definitions.
    pub block_entry: Vec<Vec<Option<SsaName>>>,
    /// Current version after the complete block.
    pub block_exit: Vec<Vec<Option<SsaName>>>,
    /// Pass statistics.
    pub stats: SsaStats,
}

/// Print a deterministic structural SSA snapshot without display-name identity.
#[must_use]
pub fn print_ssa(analysis: &SsaAnalysis) -> String {
    let mut output = String::new();
    writeln!(
        output,
        "ssa blocks={} edges={} reachable={} defs={} uses={} phis={} phi_steps={}",
        analysis.cfg.successors.len(),
        analysis.cfg.edge_count(),
        analysis.stats.reachable_blocks,
        analysis.stats.definitions,
        analysis.stats.uses,
        analysis.stats.phis,
        analysis.stats.phi_worklist_steps
    )
    .expect("writing to String cannot fail");
    for definition in &analysis.definitions {
        writeln!(
            output,
            "  def local{}.{} {:?} {:?}",
            definition.name.local.index(),
            definition.name.version.index(),
            definition.kind,
            definition.location
        )
        .expect("writing to String cannot fail");
    }
    for usage in &analysis.uses {
        writeln!(
            output,
            "  use local{}.{} {:?} {:?}",
            usage.name.local.index(),
            usage.name.version.index(),
            usage.kind,
            usage.location
        )
        .expect("writing to String cannot fail");
    }
    for phi in &analysis.phis {
        write!(
            output,
            "  phi block{} local{}.{} <-",
            phi.block.index(),
            phi.target.local.index(),
            phi.target.version.index()
        )
        .expect("writing to String cannot fail");
        for (predecessor, source) in &phi.sources {
            write!(
                output,
                " block{}:local{}.{}",
                predecessor.index(),
                source.local.index(),
                source.version.index()
            )
            .expect("writing to String cannot fail");
        }
        output.push('\n');
    }
    output
}

/// Build structural SSA facts and verify dominance/use invariants.
pub fn analyze_ssa(function: &HirFunction) -> Result<SsaAnalysis, DiagnosticBundle> {
    let cfg = analyze_cfg(function)?;
    let local_count = function.locals.len();
    let mut diagnostics = validate_local_references(function, &cfg);
    if !diagnostics.is_empty() {
        return Err(diagnostics);
    }

    let (phi_locals, phi_worklist_steps) = place_phis(function, &cfg);
    let mut counters = vec![0_u32; local_count];
    let mut stacks: Vec<Vec<SsaName>> = function
        .locals
        .iter()
        .map(|local| vec![SsaName::new(local.id, SsaVersion::INITIAL)])
        .collect();
    let mut definitions: Vec<_> = function
        .locals
        .iter()
        .map(|local| SsaDefinition {
            name: SsaName::new(local.id, SsaVersion::INITIAL),
            kind: if local.kind == LocalKind::Parameter {
                SsaDefinitionKind::Parameter
            } else {
                SsaDefinitionKind::Entry
            },
            location: SsaDefinitionLocation::Entry,
        })
        .collect();
    let mut uses = Vec::new();
    let mut phi_targets = BTreeMap::new();
    let mut phi_sources: BTreeMap<(BlockId, LocalId), Vec<(BlockId, SsaName)>> = BTreeMap::new();
    let mut block_entry = vec![vec![None; local_count]; function.blocks.len()];
    let mut block_exit = vec![vec![None; local_count]; function.blocks.len()];

    enum Event {
        Enter(BlockId),
        Exit(Vec<LocalId>),
    }
    let mut events = vec![Event::Enter(function.entry)];
    while let Some(event) = events.pop() {
        match event {
            Event::Enter(block) => {
                for (local_index, stack) in stacks.iter().enumerate() {
                    block_entry[block.as_usize()][local_index] = stack.last().copied();
                }
                let mut pushed = Vec::new();
                for local in &phi_locals[block.as_usize()] {
                    let name = next_name(*local, &mut counters);
                    stacks[local.as_usize()].push(name);
                    pushed.push(*local);
                    phi_targets.insert((block, *local), name);
                    definitions.push(SsaDefinition {
                        name,
                        kind: SsaDefinitionKind::Phi,
                        location: SsaDefinitionLocation::Phi(block),
                    });
                }

                for (instruction_index, instruction) in function.blocks[block.as_usize()]
                    .instructions
                    .iter()
                    .enumerate()
                {
                    let location = SsaUseLocation::Instruction {
                        block,
                        instruction: count_u32(instruction_index),
                    };
                    match &instruction.kind {
                        HirInstructionKind::Declare { local, .. } => {
                            define_instruction(
                                *local,
                                SsaDefinitionKind::Declare,
                                block,
                                instruction_index,
                                &mut counters,
                                &mut stacks,
                                &mut definitions,
                                &mut pushed,
                            );
                        }
                        HirInstructionKind::Read { place } => {
                            record_place_use(place, SsaUseKind::Read, location, &stacks, &mut uses);
                        }
                        HirInstructionKind::Write { place, .. } => {
                            if place.is_local() {
                                if let Some(local) = place_local(place) {
                                    define_instruction(
                                        local,
                                        SsaDefinitionKind::Write,
                                        block,
                                        instruction_index,
                                        &mut counters,
                                        &mut stacks,
                                        &mut definitions,
                                        &mut pushed,
                                    );
                                }
                            } else {
                                record_place_use(
                                    place,
                                    SsaUseKind::ProjectedWriteBase,
                                    location,
                                    &stacks,
                                    &mut uses,
                                );
                            }
                        }
                        HirInstructionKind::ReadWrite { place, .. } => {
                            record_place_use(
                                place,
                                SsaUseKind::ReadWrite,
                                location,
                                &stacks,
                                &mut uses,
                            );
                            if place.is_local()
                                && let Some(local) = place_local(place)
                            {
                                define_instruction(
                                    local,
                                    SsaDefinitionKind::ReadWrite,
                                    block,
                                    instruction_index,
                                    &mut counters,
                                    &mut stacks,
                                    &mut definitions,
                                    &mut pushed,
                                );
                            }
                        }
                        HirInstructionKind::Iteration { targets, .. } => {
                            for local in targets {
                                define_instruction(
                                    *local,
                                    SsaDefinitionKind::Iteration,
                                    block,
                                    instruction_index,
                                    &mut counters,
                                    &mut stacks,
                                    &mut definitions,
                                    &mut pushed,
                                );
                            }
                        }
                        HirInstructionKind::Literal(_)
                        | HirInstructionKind::Unary { .. }
                        | HirInstructionKind::Binary { .. }
                        | HirInstructionKind::Conditional { .. }
                        | HirInstructionKind::Sequence { .. }
                        | HirInstructionKind::TemplateLiteral { .. }
                        | HirInstructionKind::Call(_)
                        | HirInstructionKind::New { .. }
                        | HirInstructionKind::Array { .. }
                        | HirInstructionKind::Object { .. }
                        | HirInstructionKind::Function { .. }
                        | HirInstructionKind::Jsx { .. }
                        | HirInstructionKind::Await { .. }
                        | HirInstructionKind::Yield { .. }
                        | HirInstructionKind::Phi { .. }
                        | HirInstructionKind::SyntaxFragment { .. }
                        | HirInstructionKind::Debugger => {}
                    }
                }

                for (local_index, stack) in stacks.iter().enumerate() {
                    block_exit[block.as_usize()][local_index] = stack.last().copied();
                }
                for successor in &cfg.successors[block.as_usize()] {
                    if !cfg.reachable[successor.as_usize()] {
                        continue;
                    }
                    for local in &phi_locals[successor.as_usize()] {
                        if let Some(name) = stacks[local.as_usize()].last().copied() {
                            phi_sources
                                .entry((*successor, *local))
                                .or_default()
                                .push((block, name));
                            uses.push(SsaUse {
                                name,
                                kind: SsaUseKind::Phi,
                                location: SsaUseLocation::PhiEdge {
                                    predecessor: block,
                                    successor: *successor,
                                },
                            });
                        }
                    }
                }

                events.push(Event::Exit(pushed));
                for child in cfg.dominator_children[block.as_usize()].iter().rev() {
                    events.push(Event::Enter(*child));
                }
            }
            Event::Exit(pushed) => {
                for local in pushed.into_iter().rev() {
                    stacks[local.as_usize()].pop();
                }
            }
        }
    }

    let mut phis = Vec::new();
    for (block_index, locals) in phi_locals.iter().enumerate() {
        let block = BlockId::new(count_u32(block_index));
        for local in locals {
            let Some(target) = phi_targets.get(&(block, *local)).copied() else {
                continue;
            };
            let mut sources = phi_sources.remove(&(block, *local)).unwrap_or_default();
            sources.sort_unstable_by_key(|(predecessor, _)| *predecessor);
            phis.push(SsaPhi {
                block,
                target,
                sources,
            });
        }
    }

    let stats = SsaStats {
        reachable_blocks: count_u32(cfg.reachable.iter().filter(|reachable| **reachable).count()),
        definitions: count_u32(definitions.len()),
        uses: count_u32(uses.len()),
        phis: count_u32(phis.len()),
        phi_worklist_steps,
    };
    let analysis = SsaAnalysis {
        cfg,
        definitions,
        uses,
        phis,
        block_entry,
        block_exit,
        stats,
    };
    if let Err(verification) = verify_ssa(function, &analysis) {
        for diagnostic in verification.into_sorted() {
            diagnostics.push(diagnostic);
        }
        return Err(diagnostics);
    }
    Ok(analysis)
}

/// Insert analyzed Phi nodes into a cloned HIR function.
#[must_use]
pub fn materialize_ssa(function: &HirFunction, analysis: &SsaAnalysis) -> HirFunction {
    let mut function = function.clone();
    for block_index in 0..function.blocks.len() {
        let block = BlockId::new(count_u32(block_index));
        let origin = function.blocks[block_index].origin;
        let mut instructions = Vec::new();
        for phi in analysis.phis.iter().filter(|phi| phi.block == block) {
            let value = ValueId::new(count_u32(function.values.len()));
            function.values.push(HirValue {
                id: value,
                kind: ValueKind::Ssa(phi.target),
                origin,
            });
            instructions.push(HirInstruction {
                result: Some(value),
                kind: HirInstructionKind::Phi {
                    target: phi.target,
                    sources: phi.sources.clone(),
                },
                semantics: fict_hir::InstructionSemantics::PURE_EAGER,
                origin,
            });
        }
        instructions.append(&mut function.blocks[block_index].instructions);
        function.blocks[block_index].instructions = instructions;
    }
    function
}

/// Verify definition uniqueness, Phi completeness, and SSA dominance.
pub fn verify_ssa(function: &HirFunction, analysis: &SsaAnalysis) -> Result<(), DiagnosticBundle> {
    let mut diagnostics = DiagnosticBundle::default();
    if analysis.block_entry.len() != function.blocks.len()
        || analysis.block_exit.len() != function.blocks.len()
    {
        diagnostics.push(ssa_error(
            "FICT-SSA-ARENA",
            "SSA block entry/exit arenas must match the HIR block arena",
        ));
    }

    let mut definition_by_name = BTreeMap::new();
    for definition in &analysis.definitions {
        if definition.name.local.as_usize() >= function.locals.len() {
            diagnostics.push(ssa_error(
                "FICT-SSA-LOCAL",
                format!(
                    "SSA definition references local{} outside the local arena",
                    definition.name.local.index()
                ),
            ));
        }
        if definition_by_name
            .insert(definition.name, *definition)
            .is_some()
        {
            diagnostics.push(ssa_error(
                "FICT-SSA-DEFINITION",
                format!(
                    "local{} version{} has more than one definition",
                    definition.name.local.index(),
                    definition.name.version.index()
                ),
            ));
        }
    }

    for local in &function.locals {
        let initial = SsaName::new(local.id, SsaVersion::INITIAL);
        if !definition_by_name.contains_key(&initial) {
            diagnostics.push(ssa_error(
                "FICT-SSA-ENTRY",
                format!("local{} is missing its entry definition", local.id.index()),
            ));
        }
    }

    let phi_by_block_local: BTreeMap<_, _> = analysis
        .phis
        .iter()
        .map(|phi| ((phi.block, phi.target.local), phi))
        .collect();
    if phi_by_block_local.len() != analysis.phis.len() {
        diagnostics.push(ssa_error(
            "FICT-SSA-PHI",
            "a block cannot contain more than one Phi for the same local",
        ));
    }
    for phi in &analysis.phis {
        let expected: BTreeSet<_> = analysis.cfg.predecessors[phi.block.as_usize()]
            .iter()
            .copied()
            .filter(|predecessor| analysis.cfg.reachable[predecessor.as_usize()])
            .collect();
        let actual: BTreeSet<_> = phi.sources.iter().map(|(block, _)| *block).collect();
        if expected != actual || actual.len() != phi.sources.len() {
            diagnostics.push(ssa_error(
                "FICT-SSA-PHI-SOURCES",
                format!(
                    "block{} Phi sources do not match reachable predecessors",
                    phi.block.index()
                ),
            ));
        }
        if definition_by_name
            .get(&phi.target)
            .is_none_or(|definition| definition.location != SsaDefinitionLocation::Phi(phi.block))
        {
            diagnostics.push(ssa_error(
                "FICT-SSA-PHI-TARGET",
                format!(
                    "block{} Phi target has no matching definition",
                    phi.block.index()
                ),
            ));
        }
    }

    for usage in &analysis.uses {
        let Some(definition) = definition_by_name.get(&usage.name) else {
            diagnostics.push(ssa_error(
                "FICT-SSA-USE",
                format!(
                    "use of local{} version{} has no definition",
                    usage.name.local.index(),
                    usage.name.version.index()
                ),
            ));
            continue;
        };
        let (use_block, use_instruction) = match usage.location {
            SsaUseLocation::Instruction { block, instruction } => (block, Some(instruction)),
            SsaUseLocation::PhiEdge { predecessor, .. } => (predecessor, None),
        };
        if !definition_dominates_use(*definition, use_block, use_instruction, &analysis.cfg) {
            diagnostics.push(ssa_error(
                "FICT-SSA-DOMINANCE",
                format!(
                    "local{} version{} does not dominate its use in block{}",
                    usage.name.local.index(),
                    usage.name.version.index(),
                    use_block.index()
                ),
            ));
        }
    }

    if diagnostics.is_empty() {
        Ok(())
    } else {
        Err(diagnostics)
    }
}

fn place_phis(function: &HirFunction, cfg: &CfgAnalysis) -> (Vec<BTreeSet<LocalId>>, u32) {
    let mut definition_blocks = vec![BTreeSet::new(); function.locals.len()];
    for local in &function.locals {
        definition_blocks[local.id.as_usize()].insert(function.entry);
    }
    for block in &function.blocks {
        if !cfg.reachable[block.id.as_usize()] {
            continue;
        }
        for instruction in &block.instructions {
            for local in defined_locals(instruction) {
                definition_blocks[local.as_usize()].insert(block.id);
            }
        }
    }

    let mut phi_locals = vec![BTreeSet::new(); function.blocks.len()];
    let mut steps = 0_u32;
    for local in &function.locals {
        if definition_blocks[local.id.as_usize()].len() <= 1 {
            continue;
        }
        let mut work = definition_blocks[local.id.as_usize()].clone();
        let mut visited = work.clone();
        while let Some(block) = work.pop_first() {
            steps = steps.saturating_add(1);
            for frontier in &cfg.dominance_frontiers[block.as_usize()] {
                if phi_locals[frontier.as_usize()].insert(local.id) && visited.insert(*frontier) {
                    work.insert(*frontier);
                }
            }
        }
    }
    (phi_locals, steps)
}

fn validate_local_references(function: &HirFunction, cfg: &CfgAnalysis) -> DiagnosticBundle {
    let mut diagnostics = DiagnosticBundle::default();
    for block in &function.blocks {
        if !cfg.reachable[block.id.as_usize()] {
            continue;
        }
        for instruction in &block.instructions {
            let referenced: Vec<_> = match &instruction.kind {
                HirInstructionKind::Declare { local, .. } => vec![*local],
                HirInstructionKind::Read { place }
                | HirInstructionKind::Write { place, .. }
                | HirInstructionKind::ReadWrite { place, .. } => {
                    place_local(place).into_iter().collect()
                }
                HirInstructionKind::Iteration { targets, .. } => targets.clone(),
                _ => Vec::new(),
            };
            if referenced
                .iter()
                .any(|local| local.as_usize() >= function.locals.len())
            {
                diagnostics.push(ssa_error(
                    "FICT-SSA-LOCAL",
                    "HIR instruction references a local outside the function arena",
                ));
            }
        }
    }
    diagnostics
}

fn defined_locals(instruction: &HirInstruction) -> Vec<LocalId> {
    match &instruction.kind {
        HirInstructionKind::Declare { local, .. } => vec![*local],
        HirInstructionKind::Write { place, .. } | HirInstructionKind::ReadWrite { place, .. }
            if place.is_local() =>
        {
            place_local(place).into_iter().collect()
        }
        HirInstructionKind::Iteration { targets, .. } => targets.clone(),
        _ => Vec::new(),
    }
}

fn place_local(place: &Place) -> Option<LocalId> {
    match place.base {
        PlaceBase::Local(local) => Some(local),
        PlaceBase::Ssa(name) => Some(name.local),
        PlaceBase::Value(_) => None,
    }
}

fn record_place_use(
    place: &Place,
    kind: SsaUseKind,
    location: SsaUseLocation,
    stacks: &[Vec<SsaName>],
    uses: &mut Vec<SsaUse>,
) {
    let Some(local) = place_local(place) else {
        return;
    };
    if let Some(name) = stacks[local.as_usize()].last().copied() {
        uses.push(SsaUse {
            name,
            kind,
            location,
        });
    }
}

#[allow(clippy::too_many_arguments)]
fn define_instruction(
    local: LocalId,
    kind: SsaDefinitionKind,
    block: BlockId,
    instruction: usize,
    counters: &mut [u32],
    stacks: &mut [Vec<SsaName>],
    definitions: &mut Vec<SsaDefinition>,
    pushed: &mut Vec<LocalId>,
) {
    let name = next_name(local, counters);
    stacks[local.as_usize()].push(name);
    pushed.push(local);
    definitions.push(SsaDefinition {
        name,
        kind,
        location: SsaDefinitionLocation::Instruction {
            block,
            instruction: count_u32(instruction),
        },
    });
}

fn next_name(local: LocalId, counters: &mut [u32]) -> SsaName {
    let counter = &mut counters[local.as_usize()];
    *counter = counter.saturating_add(1);
    SsaName::new(local, SsaVersion::new(*counter))
}

fn definition_dominates_use(
    definition: SsaDefinition,
    use_block: BlockId,
    use_instruction: Option<u32>,
    cfg: &CfgAnalysis,
) -> bool {
    match definition.location {
        SsaDefinitionLocation::Entry => cfg.reachable[use_block.as_usize()],
        SsaDefinitionLocation::Phi(block) => block == use_block || cfg.dominates(block, use_block),
        SsaDefinitionLocation::Instruction { block, instruction } => {
            if block == use_block {
                use_instruction.is_none_or(|usage| instruction < usage)
            } else {
                cfg.dominates(block, use_block)
            }
        }
    }
}

fn ssa_error(code: &'static str, message: impl Into<String>) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("SSA diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(GuaranteeClass::Internal)
}

fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
