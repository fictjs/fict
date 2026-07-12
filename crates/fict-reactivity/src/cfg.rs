use std::collections::BTreeSet;

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_hir::{BlockId, HirFunction, TerminatorKind};

/// Deterministic control-flow facts for one HIR function.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CfgAnalysis {
    /// Successors in block-ID order with duplicate branch targets removed.
    pub successors: Vec<Vec<BlockId>>,
    /// Predecessors in block-ID order.
    pub predecessors: Vec<Vec<BlockId>>,
    /// Blocks reachable from the function entry.
    pub reachable: Vec<bool>,
    /// Reachable blocks in reverse postorder.
    pub reverse_postorder: Vec<BlockId>,
    /// Immediate dominator for each reachable non-entry block.
    pub immediate_dominators: Vec<Option<BlockId>>,
    /// Dominator-tree children in block-ID order.
    pub dominator_children: Vec<Vec<BlockId>>,
    /// Cytron dominance frontier for each reachable block.
    pub dominance_frontiers: Vec<Vec<BlockId>>,
    /// Edges whose target dominates their source.
    pub back_edges: Vec<(BlockId, BlockId)>,
    /// Unique loop headers derived from back-edge targets.
    pub loop_headers: Vec<BlockId>,
    /// Number of fixed-point sweeps used by immediate-dominator analysis.
    pub dominator_iterations: u32,
}

impl CfgAnalysis {
    /// Return whether `dominator` dominates `block`.
    #[must_use]
    pub fn dominates(&self, dominator: BlockId, mut block: BlockId) -> bool {
        if dominator == block {
            return self
                .reachable
                .get(block.as_usize())
                .copied()
                .unwrap_or(false);
        }
        let mut remaining = self.immediate_dominators.len();
        while remaining > 0 {
            let Some(parent) = self
                .immediate_dominators
                .get(block.as_usize())
                .copied()
                .flatten()
            else {
                return false;
            };
            if parent == dominator {
                return true;
            }
            if parent == block {
                return false;
            }
            block = parent;
            remaining -= 1;
        }
        false
    }

    /// Number of unique CFG edges.
    #[must_use]
    pub fn edge_count(&self) -> usize {
        self.successors.iter().map(Vec::len).sum()
    }
}

/// Analyze and validate one function's control-flow graph.
pub fn analyze_cfg(function: &HirFunction) -> Result<CfgAnalysis, DiagnosticBundle> {
    let block_count = function.blocks.len();
    let mut diagnostics = DiagnosticBundle::default();
    if function.entry.as_usize() >= block_count {
        diagnostics.push(cfg_error(
            "FICT-CFG-ENTRY",
            format!(
                "fn{} entry block{} is outside its block arena",
                function.id.index(),
                function.entry.index()
            ),
        ));
        return Err(diagnostics);
    }

    let mut successors = Vec::with_capacity(block_count);
    for block in &function.blocks {
        let mut targets = terminator_targets(&block.terminator.kind);
        targets.sort_unstable();
        targets.dedup();
        for target in &targets {
            if target.as_usize() >= block_count {
                diagnostics.push(cfg_error(
                    "FICT-CFG-TARGET",
                    format!(
                        "fn{} block{} targets missing block{}",
                        function.id.index(),
                        block.id.index(),
                        target.index()
                    ),
                ));
            }
        }
        successors.push(targets);
    }
    if !diagnostics.is_empty() {
        return Err(diagnostics);
    }

    let mut predecessors = vec![Vec::new(); block_count];
    for (source, targets) in successors.iter().enumerate() {
        for target in targets {
            predecessors[target.as_usize()].push(BlockId::new(count_u32(source)));
        }
    }

    let (reachable, reverse_postorder) = reachable_reverse_postorder(function.entry, &successors);
    let (immediate_dominators, dominator_iterations) = compute_immediate_dominators(
        function.entry,
        &predecessors,
        &reverse_postorder,
        &reachable,
    )?;

    let mut dominator_children = vec![Vec::new(); block_count];
    for (block, parent) in immediate_dominators.iter().copied().enumerate() {
        if let Some(parent) = parent {
            dominator_children[parent.as_usize()].push(BlockId::new(count_u32(block)));
        }
    }

    let dominance_frontiers =
        compute_dominance_frontiers(&predecessors, &reachable, &immediate_dominators);
    let partial = CfgAnalysis {
        successors,
        predecessors,
        reachable,
        reverse_postorder,
        immediate_dominators,
        dominator_children,
        dominance_frontiers,
        back_edges: Vec::new(),
        loop_headers: Vec::new(),
        dominator_iterations,
    };
    let mut back_edges = Vec::new();
    let mut loop_headers = BTreeSet::new();
    for (source, targets) in partial.successors.iter().enumerate() {
        let source = BlockId::new(count_u32(source));
        if !partial.reachable[source.as_usize()] {
            continue;
        }
        for target in targets {
            if partial.dominates(*target, source) {
                back_edges.push((source, *target));
                loop_headers.insert(*target);
            }
        }
    }

    Ok(CfgAnalysis {
        back_edges,
        loop_headers: loop_headers.into_iter().collect(),
        ..partial
    })
}

fn reachable_reverse_postorder(
    entry: BlockId,
    successors: &[Vec<BlockId>],
) -> (Vec<bool>, Vec<BlockId>) {
    let mut reachable = vec![false; successors.len()];
    let mut postorder = Vec::with_capacity(successors.len());
    let mut stack = vec![(entry, false)];
    while let Some((block, exiting)) = stack.pop() {
        if exiting {
            postorder.push(block);
            continue;
        }
        if reachable[block.as_usize()] {
            continue;
        }
        reachable[block.as_usize()] = true;
        stack.push((block, true));
        for successor in successors[block.as_usize()].iter().rev() {
            if !reachable[successor.as_usize()] {
                stack.push((*successor, false));
            }
        }
    }
    postorder.reverse();
    (reachable, postorder)
}

fn compute_immediate_dominators(
    entry: BlockId,
    predecessors: &[Vec<BlockId>],
    reverse_postorder: &[BlockId],
    reachable: &[bool],
) -> Result<(Vec<Option<BlockId>>, u32), DiagnosticBundle> {
    let mut idom = vec![None; predecessors.len()];
    idom[entry.as_usize()] = Some(entry);
    let mut rpo_position = vec![usize::MAX; predecessors.len()];
    for (position, block) in reverse_postorder.iter().enumerate() {
        rpo_position[block.as_usize()] = position;
    }

    let maximum_iterations = reverse_postorder
        .len()
        .saturating_mul(reverse_postorder.len().max(1))
        .saturating_add(1);
    let mut iterations = 0_usize;
    loop {
        iterations = iterations.saturating_add(1);
        if iterations > maximum_iterations {
            return Err(DiagnosticBundle::new(vec![cfg_error(
                "FICT-CFG-FIXED-POINT",
                "dominator analysis exceeded its deterministic iteration limit",
            )]));
        }
        let mut changed = false;
        for block in reverse_postorder.iter().copied().skip(1) {
            if !reachable[block.as_usize()] {
                continue;
            }
            let mut defined_predecessors = predecessors[block.as_usize()]
                .iter()
                .copied()
                .filter(|predecessor| idom[predecessor.as_usize()].is_some());
            let Some(mut next) = defined_predecessors.next() else {
                continue;
            };
            for predecessor in defined_predecessors {
                next = intersect(predecessor, next, &idom, &rpo_position);
            }
            if idom[block.as_usize()] != Some(next) {
                idom[block.as_usize()] = Some(next);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    idom[entry.as_usize()] = None;
    Ok((idom, count_u32(iterations)))
}

fn intersect(
    mut left: BlockId,
    mut right: BlockId,
    idom: &[Option<BlockId>],
    rpo_position: &[usize],
) -> BlockId {
    let mut remaining = idom.len().saturating_mul(2).saturating_add(1);
    while left != right && remaining > 0 {
        while rpo_position[left.as_usize()] > rpo_position[right.as_usize()] {
            left = idom[left.as_usize()].expect("defined dominator predecessor");
        }
        while rpo_position[right.as_usize()] > rpo_position[left.as_usize()] {
            right = idom[right.as_usize()].expect("defined dominator predecessor");
        }
        remaining -= 1;
    }
    left
}

fn compute_dominance_frontiers(
    predecessors: &[Vec<BlockId>],
    reachable: &[bool],
    idom: &[Option<BlockId>],
) -> Vec<Vec<BlockId>> {
    let mut frontiers = vec![BTreeSet::new(); predecessors.len()];
    for (block_index, block_predecessors) in predecessors.iter().enumerate() {
        if !reachable[block_index] || block_predecessors.len() < 2 {
            continue;
        }
        let block = BlockId::new(count_u32(block_index));
        let Some(stop) = idom[block_index] else {
            continue;
        };
        for predecessor in block_predecessors {
            let mut runner = *predecessor;
            let mut remaining = idom.len();
            while runner != stop && remaining > 0 {
                frontiers[runner.as_usize()].insert(block);
                let Some(parent) = idom[runner.as_usize()] else {
                    break;
                };
                runner = parent;
                remaining -= 1;
            }
        }
    }
    frontiers
        .into_iter()
        .map(|frontier| frontier.into_iter().collect())
        .collect()
}

fn terminator_targets(terminator: &TerminatorKind) -> Vec<BlockId> {
    match terminator {
        TerminatorKind::Return { .. }
        | TerminatorKind::Throw { .. }
        | TerminatorKind::Unreachable => Vec::new(),
        TerminatorKind::Goto { target } => vec![*target],
        TerminatorKind::Branch {
            consequent,
            alternate,
            ..
        } => vec![*consequent, *alternate],
        TerminatorKind::Switch { cases, .. } => cases.iter().map(|case| case.target).collect(),
        TerminatorKind::Try {
            body,
            catch,
            finally,
            continuation,
        } => {
            let mut targets = vec![*body, *continuation];
            targets.extend(*catch);
            targets.extend(*finally);
            targets
        }
    }
}

fn cfg_error(code: &'static str, message: impl Into<String>) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("CFG diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(GuaranteeClass::Internal)
}

fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
