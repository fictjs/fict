use fict_hir::{
    BlockId, FunctionFlags, FunctionId, FunctionKind, HirBlock, HirFunction, HirTerminator, Origin,
    ScopeId, SourceSpan, TerminatorKind, ValueId,
};
use fict_reactivity::analyze_cfg;
use std::collections::BTreeSet;

fn origin() -> Origin {
    Origin::source(SourceSpan::empty(0))
}

fn block(id: u32, terminator: TerminatorKind) -> HirBlock {
    HirBlock {
        id: BlockId::new(id),
        scope: ScopeId::new(0),
        instructions: Vec::new(),
        terminator: HirTerminator {
            kind: terminator,
            origin: origin(),
        },
        source_hint: None,
        origin: origin(),
    }
}

fn function(blocks: Vec<HirBlock>) -> HirFunction {
    HirFunction {
        id: FunctionId::new(0),
        parent: FunctionId::new(0),
        binding: None,
        scope: ScopeId::new(0),
        kind: FunctionKind::Module,
        flags: FunctionFlags::default(),
        parameters: Vec::new(),
        locals: Vec::new(),
        values: Vec::new(),
        blocks,
        entry: BlockId::new(0),
        regions: Vec::new(),
        origin: origin(),
    }
}

#[test]
fn computes_diamond_dominators_frontiers_and_unique_edges() {
    let function = function(vec![
        block(
            0,
            TerminatorKind::Branch {
                test: ValueId::new(0),
                consequent: BlockId::new(1),
                alternate: BlockId::new(2),
            },
        ),
        block(
            1,
            TerminatorKind::Goto {
                target: BlockId::new(3),
            },
        ),
        block(
            2,
            TerminatorKind::Goto {
                target: BlockId::new(3),
            },
        ),
        block(3, TerminatorKind::Return { value: None }),
    ]);

    let cfg = analyze_cfg(&function).expect("valid CFG");
    assert_eq!(cfg.edge_count(), 4);
    assert!(cfg.reachable.iter().all(|reachable| *reachable));
    assert_eq!(cfg.predecessors[3], [BlockId::new(1), BlockId::new(2)]);
    assert_eq!(cfg.immediate_dominators[1], Some(BlockId::new(0)));
    assert_eq!(cfg.immediate_dominators[2], Some(BlockId::new(0)));
    assert_eq!(cfg.immediate_dominators[3], Some(BlockId::new(0)));
    assert_eq!(cfg.dominance_frontiers[1], [BlockId::new(3)]);
    assert_eq!(cfg.dominance_frontiers[2], [BlockId::new(3)]);
    assert!(cfg.dominates(BlockId::new(0), BlockId::new(3)));
    assert!(!cfg.dominates(BlockId::new(1), BlockId::new(2)));
    assert!(cfg.back_edges.is_empty());
}

#[test]
fn detects_loop_back_edges_and_ignores_unreachable_blocks() {
    let function = function(vec![
        block(
            0,
            TerminatorKind::Goto {
                target: BlockId::new(1),
            },
        ),
        block(
            1,
            TerminatorKind::Branch {
                test: ValueId::new(0),
                consequent: BlockId::new(2),
                alternate: BlockId::new(3),
            },
        ),
        block(
            2,
            TerminatorKind::Goto {
                target: BlockId::new(1),
            },
        ),
        block(3, TerminatorKind::Return { value: None }),
        block(4, TerminatorKind::Return { value: None }),
    ]);

    let cfg = analyze_cfg(&function).expect("valid CFG");
    assert_eq!(cfg.reachable, [true, true, true, true, false]);
    assert_eq!(cfg.back_edges, [(BlockId::new(2), BlockId::new(1))]);
    assert_eq!(cfg.loop_headers, [BlockId::new(1)]);
    assert_eq!(cfg.immediate_dominators[4], None);
}

#[test]
fn deduplicates_equal_branch_targets_and_rejects_missing_targets() {
    let same_target = function(vec![
        block(
            0,
            TerminatorKind::Branch {
                test: ValueId::new(0),
                consequent: BlockId::new(1),
                alternate: BlockId::new(1),
            },
        ),
        block(1, TerminatorKind::Return { value: None }),
    ]);
    let cfg = analyze_cfg(&same_target).expect("valid CFG");
    assert_eq!(cfg.successors[0], [BlockId::new(1)]);
    assert_eq!(cfg.predecessors[1], [BlockId::new(0)]);

    let invalid = function(vec![block(
        0,
        TerminatorKind::Goto {
            target: BlockId::new(8),
        },
    )]);
    let diagnostics = analyze_cfg(&invalid).expect_err("invalid target");
    assert_eq!(diagnostics.as_slice()[0].code.as_str(), "FICT-CFG-TARGET");
}

#[test]
fn analyzes_deep_linear_cfg_without_recursive_traversal() {
    let block_count = 5_000_u32;
    let blocks = (0..block_count)
        .map(|id| {
            if id + 1 == block_count {
                block(id, TerminatorKind::Return { value: None })
            } else {
                block(
                    id,
                    TerminatorKind::Goto {
                        target: BlockId::new(id + 1),
                    },
                )
            }
        })
        .collect();
    let cfg = analyze_cfg(&function(blocks)).expect("deep CFG");
    assert_eq!(cfg.reverse_postorder.len(), block_count as usize);
    assert_eq!(cfg.edge_count(), block_count as usize - 1);
    assert!(cfg.dominates(BlockId::new(0), BlockId::new(block_count - 1)));
    assert!(cfg.dominator_iterations <= 2);
}

#[test]
fn dominators_match_a_naive_set_fixed_point_across_generated_dags() {
    let mut seed = 0x5eed_f1c7_u64;
    for block_count in 2_u32..32 {
        for _case in 0..8 {
            let mut blocks = Vec::new();
            for id in 0..block_count {
                if id + 1 == block_count {
                    blocks.push(block(id, TerminatorKind::Return { value: None }));
                    continue;
                }
                seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
                let remaining = block_count - id - 1;
                let second = id + 1 + ((seed >> 32) as u32 % remaining);
                blocks.push(if second == id + 1 {
                    block(
                        id,
                        TerminatorKind::Goto {
                            target: BlockId::new(id + 1),
                        },
                    )
                } else {
                    block(
                        id,
                        TerminatorKind::Branch {
                            test: ValueId::new(0),
                            consequent: BlockId::new(id + 1),
                            alternate: BlockId::new(second),
                        },
                    )
                });
            }

            let cfg = analyze_cfg(&function(blocks)).expect("generated DAG");
            let universe: BTreeSet<_> = (0..block_count).map(BlockId::new).collect();
            let mut dominators = vec![universe.clone(); block_count as usize];
            dominators[0] = BTreeSet::from([BlockId::new(0)]);
            loop {
                let mut changed = false;
                for id in 1..block_count {
                    let mut next = universe.clone();
                    for predecessor in &cfg.predecessors[id as usize] {
                        next = next
                            .intersection(&dominators[predecessor.as_usize()])
                            .copied()
                            .collect();
                    }
                    next.insert(BlockId::new(id));
                    if next != dominators[id as usize] {
                        dominators[id as usize] = next;
                        changed = true;
                    }
                }
                if !changed {
                    break;
                }
            }

            for block_id in 0..block_count {
                for candidate in 0..block_count {
                    assert_eq!(
                        cfg.dominates(BlockId::new(candidate), BlockId::new(block_id)),
                        dominators[block_id as usize].contains(&BlockId::new(candidate)),
                        "blocks={block_count}, candidate={candidate}, block={block_id}"
                    );
                }
            }
        }
    }
}
