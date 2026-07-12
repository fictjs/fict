use std::collections::{BTreeMap, BTreeSet, VecDeque};

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_hir::{BlockId, HirFunction, StructuredSourceKind, TerminatorKind};

use crate::CfgAnalysis;

/// Loop syntax recovered from source hints or conservative CFG shape.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum StructuredLoopKind {
    /// Generic pre-test loop when no stronger source hint survives.
    While,
    /// Source `do ... while`.
    DoWhile,
    /// Source classic `for`.
    For,
    /// Source `for ... of`.
    ForOf,
    /// Source `for await ... of`.
    ForAwaitOf,
    /// Source `for ... in`.
    ForIn,
}

/// One switch dispatch arm.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructuredSwitchArm {
    /// Source-order case index.
    pub case_index: u32,
    /// Arm entry block.
    pub target: BlockId,
    /// Blocks reached before the shared join.
    pub blocks: Vec<BlockId>,
    /// Default arm.
    pub is_default: bool,
}

/// Recovered structured construct payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StructuredConstructKind {
    /// Conditional branch with an optional shared join.
    Conditional {
        /// Truthy entry.
        consequent: BlockId,
        /// Falsy entry.
        alternate: BlockId,
        /// Nearest common forward join.
        join: Option<BlockId>,
    },
    /// Multi-way switch.
    Switch {
        /// Cases in source order.
        arms: Vec<StructuredSwitchArm>,
        /// Shared forward join.
        join: Option<BlockId>,
    },
    /// Reducible natural loop.
    Loop {
        /// Recovered loop syntax.
        kind: StructuredLoopKind,
        /// Entries from the header into the loop body.
        body_entries: Vec<BlockId>,
        /// Successors leaving the natural loop.
        exits: Vec<BlockId>,
    },
    /// Structured try/catch/finally control transfer.
    Try {
        /// Try-body entry.
        body: BlockId,
        /// Catch entry.
        catch: Option<BlockId>,
        /// Finally entry.
        finally: Option<BlockId>,
        /// Normal continuation.
        continuation: BlockId,
    },
}

/// One recovered construct and its nesting relationship.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructuredConstruct {
    /// Dense construct identity.
    pub id: u32,
    /// Header/dispatch block.
    pub header: BlockId,
    /// Construct-specific payload.
    pub kind: StructuredConstructKind,
    /// Sorted blocks owned by the construct, including its header.
    pub blocks: Vec<BlockId>,
    /// Smallest strict containing construct.
    pub parent: Option<u32>,
    /// Direct nested constructs.
    pub children: Vec<u32>,
}

/// Why structured recovery deliberately chose a state-machine emitter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum StructurizeFallbackReason {
    /// A cyclic SCC has multiple externally reachable entries.
    IrreducibleControlFlow,
}

/// Explicit fallback plan preserving CFG evaluation order and edges.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateMachineFallback {
    /// Fallback reason.
    pub reason: StructurizeFallbackReason,
    /// Reachable blocks in reverse postorder.
    pub block_order: Vec<BlockId>,
    /// Irreducible SCC witnesses.
    pub components: Vec<Vec<BlockId>>,
}

/// Structurization statistics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct StructurizeStats {
    /// Recovered constructs.
    pub constructs: u32,
    /// Conditional constructs.
    pub conditionals: u32,
    /// Switch constructs.
    pub switches: u32,
    /// Natural loops.
    pub loops: u32,
    /// Try constructs.
    pub tries: u32,
    /// Whether state-machine fallback is required.
    pub fallback: bool,
}

/// Deterministic structured branch plan or explicit fallback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructurizeAnalysis {
    /// Reachable block order used by emission.
    pub block_order: Vec<BlockId>,
    /// Recovered constructs, outer headers first by CFG order.
    pub constructs: Vec<StructuredConstruct>,
    /// Top-level construct IDs.
    pub top_level_constructs: Vec<u32>,
    /// Fallback plan for irreducible CFGs.
    pub fallback: Option<StateMachineFallback>,
    /// Deterministic statistics.
    pub stats: StructurizeStats,
}

/// Recover structured constructs from a validated Fict CFG.
pub fn structurize_cfg(
    function: &HirFunction,
    cfg: &CfgAnalysis,
) -> Result<StructurizeAnalysis, DiagnosticBundle> {
    let irreducible = irreducible_components(cfg);
    if !irreducible.is_empty() {
        let analysis = StructurizeAnalysis {
            block_order: cfg.reverse_postorder.clone(),
            constructs: Vec::new(),
            top_level_constructs: Vec::new(),
            fallback: Some(StateMachineFallback {
                reason: StructurizeFallbackReason::IrreducibleControlFlow,
                block_order: cfg.reverse_postorder.clone(),
                components: irreducible,
            }),
            stats: StructurizeStats {
                fallback: true,
                ..StructurizeStats::default()
            },
        };
        verify_structurized_cfg(function, cfg, &analysis)?;
        return Ok(analysis);
    }

    let loops = natural_loops(cfg);
    let loop_headers: BTreeSet<_> = loops.keys().copied().collect();
    let mut constructs = Vec::new();
    for header in &cfg.reverse_postorder {
        if let Some(loop_blocks) = loops.get(header) {
            let block = &function.blocks[header.as_usize()];
            let body_entries = cfg.successors[header.as_usize()]
                .iter()
                .copied()
                .filter(|successor| loop_blocks.contains(successor) && successor != header)
                .collect();
            let exits = loop_blocks
                .iter()
                .flat_map(|member| cfg.successors[member.as_usize()].iter().copied())
                .filter(|successor| !loop_blocks.contains(successor))
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            constructs.push(StructuredConstruct {
                id: count_u32(constructs.len()),
                header: *header,
                kind: StructuredConstructKind::Loop {
                    kind: loop_kind(block.source_hint.as_ref().map(|hint| &hint.kind)),
                    body_entries,
                    exits,
                },
                blocks: loop_blocks.iter().copied().collect(),
                parent: None,
                children: Vec::new(),
            });
        }
        let block = &function.blocks[header.as_usize()];
        match &block.terminator.kind {
            TerminatorKind::Branch {
                consequent,
                alternate,
                ..
            } if !loop_headers.contains(header) => {
                let join = nearest_common_join(&[*consequent, *alternate], *header, cfg);
                let mut blocks = BTreeSet::from([*header]);
                blocks.extend(blocks_until(*consequent, join, *header, cfg));
                blocks.extend(blocks_until(*alternate, join, *header, cfg));
                constructs.push(StructuredConstruct {
                    id: count_u32(constructs.len()),
                    header: *header,
                    kind: StructuredConstructKind::Conditional {
                        consequent: *consequent,
                        alternate: *alternate,
                        join,
                    },
                    blocks: blocks.into_iter().collect(),
                    parent: None,
                    children: Vec::new(),
                });
            }
            TerminatorKind::Switch { cases, .. } => {
                let targets: Vec<_> = cases.iter().map(|case| case.target).collect();
                let join = nearest_common_join(&targets, *header, cfg);
                let arms = cases
                    .iter()
                    .enumerate()
                    .map(|(index, case)| StructuredSwitchArm {
                        case_index: count_u32(index),
                        target: case.target,
                        blocks: blocks_until(case.target, join, *header, cfg)
                            .into_iter()
                            .collect(),
                        is_default: case.test.is_none(),
                    })
                    .collect::<Vec<_>>();
                let mut blocks = BTreeSet::from([*header]);
                for arm in &arms {
                    blocks.extend(arm.blocks.iter().copied());
                }
                constructs.push(StructuredConstruct {
                    id: count_u32(constructs.len()),
                    header: *header,
                    kind: StructuredConstructKind::Switch { arms, join },
                    blocks: blocks.into_iter().collect(),
                    parent: None,
                    children: Vec::new(),
                });
            }
            TerminatorKind::Try {
                body,
                catch,
                finally,
                continuation,
            } => {
                let mut blocks = BTreeSet::from([*header]);
                for entry in std::iter::once(*body).chain(*catch).chain(*finally) {
                    blocks.extend(blocks_until(entry, Some(*continuation), *header, cfg));
                }
                constructs.push(StructuredConstruct {
                    id: count_u32(constructs.len()),
                    header: *header,
                    kind: StructuredConstructKind::Try {
                        body: *body,
                        catch: *catch,
                        finally: *finally,
                        continuation: *continuation,
                    },
                    blocks: blocks.into_iter().collect(),
                    parent: None,
                    children: Vec::new(),
                });
            }
            TerminatorKind::Return { .. }
            | TerminatorKind::Throw { .. }
            | TerminatorKind::Goto { .. }
            | TerminatorKind::Branch { .. }
            | TerminatorKind::Unreachable => {}
        }
    }
    assign_construct_hierarchy(&mut constructs);
    let top_level_constructs = constructs
        .iter()
        .filter(|construct| construct.parent.is_none())
        .map(|construct| construct.id)
        .collect();
    let stats = StructurizeStats {
        constructs: count_u32(constructs.len()),
        conditionals: count_u32(
            constructs
                .iter()
                .filter(|construct| {
                    matches!(construct.kind, StructuredConstructKind::Conditional { .. })
                })
                .count(),
        ),
        switches: count_u32(
            constructs
                .iter()
                .filter(|construct| {
                    matches!(construct.kind, StructuredConstructKind::Switch { .. })
                })
                .count(),
        ),
        loops: count_u32(
            constructs
                .iter()
                .filter(|construct| matches!(construct.kind, StructuredConstructKind::Loop { .. }))
                .count(),
        ),
        tries: count_u32(
            constructs
                .iter()
                .filter(|construct| matches!(construct.kind, StructuredConstructKind::Try { .. }))
                .count(),
        ),
        fallback: false,
    };
    let analysis = StructurizeAnalysis {
        block_order: cfg.reverse_postorder.clone(),
        constructs,
        top_level_constructs,
        fallback: None,
        stats,
    };
    verify_structurized_cfg(function, cfg, &analysis)?;
    Ok(analysis)
}

/// Verify recovered construct references, nesting, fallback, and statistics.
pub fn verify_structurized_cfg(
    function: &HirFunction,
    cfg: &CfgAnalysis,
    analysis: &StructurizeAnalysis,
) -> Result<(), DiagnosticBundle> {
    let mut diagnostics = DiagnosticBundle::default();
    if analysis.block_order != cfg.reverse_postorder {
        diagnostics.push(structurize_error(
            "FICT-STRUCT-ORDER",
            "structured block order must match validated CFG reverse postorder",
        ));
    }
    if let Some(fallback) = &analysis.fallback {
        if !analysis.constructs.is_empty()
            || !analysis.top_level_constructs.is_empty()
            || fallback.block_order != cfg.reverse_postorder
            || fallback.components.is_empty()
            || fallback.components.iter().any(|component| {
                component.len() < 2 || component.windows(2).any(|pair| pair[0] >= pair[1])
            })
        {
            diagnostics.push(structurize_error(
                "FICT-STRUCT-FALLBACK",
                "state-machine fallback must contain canonical irreducible SCC witnesses",
            ));
        }
    } else {
        for (index, construct) in analysis.constructs.iter().enumerate() {
            if construct.id != count_u32(index)
                || construct.blocks.is_empty()
                || construct.blocks.windows(2).any(|pair| pair[0] >= pair[1])
                || !construct.blocks.contains(&construct.header)
                || construct
                    .blocks
                    .iter()
                    .any(|block| function.blocks.get(block.as_usize()).is_none())
                || construct.children.windows(2).any(|pair| pair[0] >= pair[1])
            {
                diagnostics.push(structurize_error(
                    "FICT-STRUCT-CONSTRUCT",
                    "structured constructs must be dense, sorted, and reference valid blocks",
                ));
            }
            if let Some(parent) = construct.parent
                && analysis
                    .constructs
                    .get(parent as usize)
                    .is_none_or(|owner| {
                        !owner.children.contains(&construct.id)
                            || !strictly_contains(&owner.blocks, &construct.blocks)
                    })
            {
                diagnostics.push(structurize_error(
                    "FICT-STRUCT-PARENT",
                    "construct nesting must be bidirectional strict block containment",
                ));
            }
        }
        let expected_top: Vec<_> = analysis
            .constructs
            .iter()
            .filter(|construct| construct.parent.is_none())
            .map(|construct| construct.id)
            .collect();
        if analysis.top_level_constructs != expected_top {
            diagnostics.push(structurize_error(
                "FICT-STRUCT-TOP",
                "top-level construct index must match parent links",
            ));
        }
    }
    let expected = StructurizeStats {
        constructs: count_u32(analysis.constructs.len()),
        conditionals: count_u32(
            analysis
                .constructs
                .iter()
                .filter(|construct| {
                    matches!(construct.kind, StructuredConstructKind::Conditional { .. })
                })
                .count(),
        ),
        switches: count_u32(
            analysis
                .constructs
                .iter()
                .filter(|construct| {
                    matches!(construct.kind, StructuredConstructKind::Switch { .. })
                })
                .count(),
        ),
        loops: count_u32(
            analysis
                .constructs
                .iter()
                .filter(|construct| matches!(construct.kind, StructuredConstructKind::Loop { .. }))
                .count(),
        ),
        tries: count_u32(
            analysis
                .constructs
                .iter()
                .filter(|construct| matches!(construct.kind, StructuredConstructKind::Try { .. }))
                .count(),
        ),
        fallback: analysis.fallback.is_some(),
    };
    if analysis.stats != expected {
        diagnostics.push(structurize_error(
            "FICT-STRUCT-STATS",
            "structurization stats do not match the plan",
        ));
    }
    if diagnostics.is_empty() {
        Ok(())
    } else {
        Err(diagnostics)
    }
}

fn natural_loops(cfg: &CfgAnalysis) -> BTreeMap<BlockId, BTreeSet<BlockId>> {
    let mut loops: BTreeMap<BlockId, BTreeSet<BlockId>> = BTreeMap::new();
    for (source, header) in &cfg.back_edges {
        let members = loops.entry(*header).or_default();
        members.insert(*header);
        members.insert(*source);
        let mut stack = vec![*source];
        while let Some(block) = stack.pop() {
            for predecessor in &cfg.predecessors[block.as_usize()] {
                if members.insert(*predecessor) && *predecessor != *header {
                    stack.push(*predecessor);
                }
            }
        }
    }
    loops
}

fn nearest_common_join(starts: &[BlockId], header: BlockId, cfg: &CfgAnalysis) -> Option<BlockId> {
    if starts.is_empty() {
        return None;
    }
    let distances: Vec<_> = starts.iter().map(|start| distances(*start, cfg)).collect();
    cfg.reverse_postorder
        .iter()
        .copied()
        .filter(|candidate| *candidate != header)
        .filter_map(|candidate| {
            let values: Option<Vec<_>> = distances
                .iter()
                .map(|distance| distance.get(&candidate).copied())
                .collect();
            values.map(|values| {
                (
                    values.iter().sum::<usize>(),
                    values.iter().max().copied().unwrap_or(0),
                    candidate,
                )
            })
        })
        .min_by_key(|(sum, maximum, candidate)| (*maximum, *sum, candidate.index()))
        .map(|(_, _, candidate)| candidate)
}

fn distances(start: BlockId, cfg: &CfgAnalysis) -> BTreeMap<BlockId, usize> {
    let mut result = BTreeMap::from([(start, 0_usize)]);
    let mut queue = VecDeque::from([start]);
    while let Some(block) = queue.pop_front() {
        let next_distance = result[&block].saturating_add(1);
        for successor in &cfg.successors[block.as_usize()] {
            if !result.contains_key(successor) {
                result.insert(*successor, next_distance);
                queue.push_back(*successor);
            }
        }
    }
    result
}

fn blocks_until(
    start: BlockId,
    stop: Option<BlockId>,
    header: BlockId,
    cfg: &CfgAnalysis,
) -> BTreeSet<BlockId> {
    let mut result = BTreeSet::new();
    let mut stack = vec![start];
    while let Some(block) = stack.pop() {
        if Some(block) == stop || block == header || !cfg.dominates(header, block) {
            continue;
        }
        if !result.insert(block) {
            continue;
        }
        for successor in cfg.successors[block.as_usize()].iter().rev() {
            stack.push(*successor);
        }
    }
    result
}

fn irreducible_components(cfg: &CfgAnalysis) -> Vec<Vec<BlockId>> {
    let components = cfg_components(cfg);
    let mut irreducible = Vec::new();
    for component in components {
        let cyclic =
            component.len() > 1 || cfg.successors[component[0].as_usize()].contains(&component[0]);
        if !cyclic {
            continue;
        }
        let members: BTreeSet<_> = component.iter().copied().collect();
        let entries: BTreeSet<_> = component
            .iter()
            .copied()
            .filter(|member| {
                cfg.predecessors[member.as_usize()]
                    .iter()
                    .any(|predecessor| !members.contains(predecessor))
            })
            .collect();
        let header = if entries.len() == 1 {
            entries.first().copied()
        } else if entries.is_empty()
            && cfg
                .reverse_postorder
                .first()
                .is_some_and(|entry| members.contains(entry))
        {
            cfg.reverse_postorder.first().copied()
        } else {
            None
        };
        let reducible = header
            .is_some_and(|entry| component.iter().all(|member| cfg.dominates(entry, *member)));
        if !reducible {
            irreducible.push(component);
        }
    }
    irreducible.sort_by_key(|component| component[0]);
    irreducible
}

fn cfg_components(cfg: &CfgAnalysis) -> Vec<Vec<BlockId>> {
    let nodes = cfg.reverse_postorder.to_vec();
    let mut finish = Vec::new();
    let mut visited = BTreeSet::new();
    for root in &nodes {
        if !visited.insert(*root) {
            continue;
        }
        let mut stack = vec![(*root, 0_usize)];
        while let Some((node, next)) = stack.last_mut() {
            let successors = &cfg.successors[node.as_usize()];
            if *next < successors.len() {
                let successor = successors[*next];
                *next += 1;
                if cfg.reachable[successor.as_usize()] && visited.insert(successor) {
                    stack.push((successor, 0));
                }
            } else {
                finish.push(stack.pop().expect("non-empty CFG SCC stack").0);
            }
        }
    }
    visited.clear();
    let mut components = Vec::new();
    for root in finish.into_iter().rev() {
        if !visited.insert(root) {
            continue;
        }
        let mut component = Vec::new();
        let mut stack = vec![root];
        while let Some(node) = stack.pop() {
            component.push(node);
            for predecessor in cfg.predecessors[node.as_usize()].iter().rev() {
                if cfg.reachable[predecessor.as_usize()] && visited.insert(*predecessor) {
                    stack.push(*predecessor);
                }
            }
        }
        component.sort_unstable();
        components.push(component);
    }
    components
}

fn assign_construct_hierarchy(constructs: &mut [StructuredConstruct]) {
    let snapshots = constructs.to_vec();
    for construct in constructs.iter_mut() {
        let mut candidates: Vec<_> = snapshots
            .iter()
            .filter(|candidate| {
                candidate.id != construct.id
                    && strictly_contains(&candidate.blocks, &construct.blocks)
            })
            .collect();
        candidates.sort_by_key(|candidate| (candidate.blocks.len(), candidate.id));
        construct.parent = candidates.first().map(|candidate| candidate.id);
    }
    let links: Vec<_> = constructs
        .iter()
        .filter_map(|construct| construct.parent.map(|parent| (parent, construct.id)))
        .collect();
    for (parent, child) in links {
        if let Some(owner) = constructs.get_mut(parent as usize) {
            owner.children.push(child);
        }
    }
}

fn strictly_contains(outer: &[BlockId], inner: &[BlockId]) -> bool {
    outer.len() > inner.len() && inner.iter().all(|block| outer.binary_search(block).is_ok())
}

fn loop_kind(hint: Option<&StructuredSourceKind>) -> StructuredLoopKind {
    match hint {
        Some(StructuredSourceKind::DoWhileLoop) => StructuredLoopKind::DoWhile,
        Some(StructuredSourceKind::ForLoop) => StructuredLoopKind::For,
        Some(StructuredSourceKind::ForOfLoop) => StructuredLoopKind::ForOf,
        Some(StructuredSourceKind::ForAwaitOfLoop) => StructuredLoopKind::ForAwaitOf,
        Some(StructuredSourceKind::ForInLoop) => StructuredLoopKind::ForIn,
        Some(StructuredSourceKind::WhileLoop)
        | Some(
            StructuredSourceKind::LexicalBlock
            | StructuredSourceKind::Conditional
            | StructuredSourceKind::Switch
            | StructuredSourceKind::Try
            | StructuredSourceKind::Catch
            | StructuredSourceKind::Finally
            | StructuredSourceKind::Labeled(_),
        )
        | None => StructuredLoopKind::While,
    }
}

fn structurize_error(code: &'static str, message: impl Into<String>) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("structurize diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(GuaranteeClass::Internal)
}

fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
