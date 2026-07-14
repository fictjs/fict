use fict_hir::{
    BlockId, FunctionFlags, FunctionId, FunctionKind, HirBlock, HirFunction, HirTerminator, Origin,
    ScopeId, SourceSpan, StructuredSourceHint, StructuredSourceKind, StructuredSwitchCaseHint,
    TerminatorKind, ValueId,
};
use fict_reactivity::{
    StructuredConstructKind, StructuredLoopKind, StructurizeFallbackReason, analyze_cfg,
    structurize_cfg, verify_structurized_cfg,
};

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
fn recovers_diamond_condition_and_shared_join() {
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
    let cfg = analyze_cfg(&function).expect("diamond CFG");
    let analysis = structurize_cfg(&function, &cfg).expect("structured diamond");
    assert!(analysis.fallback.is_none());
    assert_eq!(analysis.constructs.len(), 1);
    assert_eq!(
        analysis.constructs[0].blocks,
        [BlockId::new(0), BlockId::new(1), BlockId::new(2)]
    );
    assert!(matches!(
        analysis.constructs[0].kind,
        StructuredConstructKind::Conditional {
            join: Some(join),
            ..
        } if join == BlockId::new(3)
    ));

    let mut corrupted = analysis.clone();
    corrupted.constructs[0].blocks.remove(0);
    let diagnostics =
        verify_structurized_cfg(&function, &cfg, &corrupted).expect_err("construct without header");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-STRUCT-CONSTRUCT")
    );
}

#[test]
fn recovers_a_reducible_natural_loop_and_source_kind() {
    let mut header = block(
        1,
        TerminatorKind::Branch {
            test: ValueId::new(0),
            consequent: BlockId::new(2),
            alternate: BlockId::new(3),
        },
    );
    header.source_hint = Some(StructuredSourceHint {
        kind: StructuredSourceKind::ForOfLoop,
        exit: Some(BlockId::new(3)),
        switch_cases: Vec::new(),
        origin: origin(),
    });
    let function = function(vec![
        block(
            0,
            TerminatorKind::Goto {
                target: BlockId::new(1),
            },
        ),
        header,
        block(
            2,
            TerminatorKind::Goto {
                target: BlockId::new(1),
            },
        ),
        block(3, TerminatorKind::Return { value: None }),
    ]);
    let cfg = analyze_cfg(&function).expect("loop CFG");
    let analysis = structurize_cfg(&function, &cfg).expect("structured loop");
    assert!(analysis.fallback.is_none());
    let loop_construct = analysis
        .constructs
        .iter()
        .find(|construct| matches!(construct.kind, StructuredConstructKind::Loop { .. }))
        .expect("natural loop");
    assert_eq!(loop_construct.blocks, [BlockId::new(1), BlockId::new(2)]);
    assert!(matches!(
        &loop_construct.kind,
        StructuredConstructKind::Loop {
            kind: StructuredLoopKind::ForOf,
            exits,
            ..
        } if exits == &[BlockId::new(3)]
    ));
}

#[test]
fn recovers_an_ordered_branch_chain_as_one_switch() {
    let mut header = block(
        0,
        TerminatorKind::Goto {
            target: BlockId::new(1),
        },
    );
    header.source_hint = Some(StructuredSourceHint {
        kind: StructuredSourceKind::Switch,
        exit: Some(BlockId::new(4)),
        switch_cases: vec![
            StructuredSwitchCaseHint {
                test: Some(BlockId::new(1)),
                body: BlockId::new(2),
                origin: origin(),
            },
            StructuredSwitchCaseHint {
                test: None,
                body: BlockId::new(3),
                origin: origin(),
            },
        ],
        origin: origin(),
    });
    let function = function(vec![
        header,
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
                target: BlockId::new(3),
            },
        ),
        block(
            3,
            TerminatorKind::Goto {
                target: BlockId::new(4),
            },
        ),
        block(4, TerminatorKind::Return { value: None }),
    ]);

    let cfg = analyze_cfg(&function).expect("switch CFG");
    let analysis = structurize_cfg(&function, &cfg).expect("structured switch");
    assert_eq!(analysis.stats.switches, 1);
    assert_eq!(analysis.stats.conditionals, 0);
    assert!(analysis.fallback.is_none());
    let construct = analysis
        .constructs
        .iter()
        .find(|construct| matches!(construct.kind, StructuredConstructKind::Switch { .. }))
        .expect("switch construct");
    assert!(matches!(
        &construct.kind,
        StructuredConstructKind::Switch {
            arms,
            join: Some(join),
        } if arms.len() == 2 && arms[1].is_default && *join == BlockId::new(4)
    ));
}

#[test]
fn recovers_try_catch_finally_with_one_continuation() {
    let function = function(vec![
        block(
            0,
            TerminatorKind::Try {
                body: BlockId::new(1),
                catch: Some(BlockId::new(2)),
                finally: Some(BlockId::new(3)),
                continuation: BlockId::new(4),
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
        block(
            3,
            TerminatorKind::Goto {
                target: BlockId::new(4),
            },
        ),
        block(4, TerminatorKind::Return { value: None }),
    ]);

    let cfg = analyze_cfg(&function).expect("try CFG");
    let analysis = structurize_cfg(&function, &cfg).expect("structured try");
    assert_eq!(analysis.stats.tries, 1);
    assert!(analysis.fallback.is_none());
    assert!(analysis.constructs.iter().any(|construct| {
        matches!(
            construct.kind,
            StructuredConstructKind::Try {
                body,
                catch: Some(catch),
                finally: Some(finally),
                continuation,
            } if body == BlockId::new(1)
                && catch == BlockId::new(2)
                && finally == BlockId::new(3)
                && continuation == BlockId::new(4)
        )
    }));
}

#[test]
fn falls_back_for_a_multi_entry_irreducible_scc() {
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
                target: BlockId::new(2),
            },
        ),
        block(
            2,
            TerminatorKind::Branch {
                test: ValueId::new(0),
                consequent: BlockId::new(1),
                alternate: BlockId::new(3),
            },
        ),
        block(3, TerminatorKind::Return { value: None }),
    ]);
    let cfg = analyze_cfg(&function).expect("irreducible CFG");
    let analysis = structurize_cfg(&function, &cfg).expect("explicit fallback");
    let fallback = analysis.fallback.expect("state-machine fallback");
    assert_eq!(
        fallback.reason,
        StructurizeFallbackReason::IrreducibleControlFlow
    );
    assert_eq!(fallback.components, [[BlockId::new(1), BlockId::new(2)]]);
    assert!(analysis.constructs.is_empty());
}
