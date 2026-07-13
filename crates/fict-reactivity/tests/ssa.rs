use fict_hir::{
    BindingId, BlockId, DeclarationKind, FileId, FunctionFlags, FunctionId, FunctionKind, HirBlock,
    HirFile, HirFunction, HirInstruction, HirInstructionKind, HirLocal, HirScope, HirTerminator,
    HirValue, InstructionSemantics, LiteralValue, LocalId, LocalKind, MutationEffect,
    NumberLiteral, Origin, Place, PlaceBase, Projection, ScopeId, ScopeKind, SourceSpan, SsaName,
    SsaVersion, TerminatorKind, ValueId, ValueKind, verify_hir,
};
use fict_reactivity::{
    SsaDefinitionKind, SsaUseKind, analyze_ssa, materialize_ssa, print_ssa, verify_ssa,
};

fn origin() -> Origin {
    Origin::source(SourceSpan::empty(0))
}

fn literal(id: u32, value: LiteralValue) -> HirInstruction {
    HirInstruction {
        result: Some(ValueId::new(id)),
        kind: HirInstructionKind::Literal(value),
        semantics: InstructionSemantics::PURE_EAGER,
        origin: origin(),
    }
}

fn write(local: LocalId, value: ValueId, projections: Vec<Projection>) -> HirInstruction {
    HirInstruction {
        result: None,
        kind: HirInstructionKind::Write {
            place: Place {
                base: PlaceBase::Local(local),
                projections,
            },
            value,
        },
        semantics: InstructionSemantics {
            mutation: MutationEffect::Local,
            ..InstructionSemantics::CONSERVATIVE_EAGER
        },
        origin: origin(),
    }
}

fn block(id: u32, instructions: Vec<HirInstruction>, terminator: TerminatorKind) -> HirBlock {
    HirBlock {
        id: BlockId::new(id),
        scope: ScopeId::new(0),
        instructions,
        terminator: HirTerminator {
            kind: terminator,
            origin: origin(),
        },
        source_hint: None,
        origin: origin(),
    }
}

fn file(function: HirFunction) -> HirFile {
    HirFile {
        id: FileId::new(0),
        source_len: 0,
        root_function: FunctionId::new(0),
        scopes: vec![HirScope {
            id: ScopeId::new(0),
            parent: None,
            kind: ScopeKind::Module,
            origin: origin(),
        }],
        bindings: Vec::new(),
        globals: Vec::new(),
        functions: vec![function],
        templates: Vec::new(),
        syntax_fragments: Vec::new(),
    }
}

fn local() -> HirLocal {
    HirLocal {
        id: LocalId::new(0),
        binding: None::<BindingId>,
        scope: ScopeId::new(0),
        kind: LocalKind::User,
        declaration_kind: DeclarationKind::Let,
        debug_name: Some("value".into()),
        origin: origin(),
    }
}

fn diamond_function() -> HirFunction {
    let zero = LiteralValue::Number(NumberLiteral::from_f64(0.0));
    let one = LiteralValue::Number(NumberLiteral::from_f64(1.0));
    let two = LiteralValue::Number(NumberLiteral::from_f64(2.0));
    HirFunction {
        id: FunctionId::new(0),
        binding: None,
        scope: ScopeId::new(0),
        kind: FunctionKind::Module,
        flags: FunctionFlags::default(),
        parameters: Vec::new(),
        locals: vec![local()],
        values: vec![
            HirValue {
                id: ValueId::new(0),
                kind: ValueKind::Literal(zero.clone()),
                origin: origin(),
            },
            HirValue {
                id: ValueId::new(1),
                kind: ValueKind::Literal(one.clone()),
                origin: origin(),
            },
            HirValue {
                id: ValueId::new(2),
                kind: ValueKind::Literal(two.clone()),
                origin: origin(),
            },
            HirValue {
                id: ValueId::new(3),
                kind: ValueKind::InstructionResult,
                origin: origin(),
            },
        ],
        blocks: vec![
            block(
                0,
                vec![
                    literal(0, zero),
                    HirInstruction {
                        result: None,
                        kind: HirInstructionKind::Declare {
                            local: LocalId::new(0),
                            declaration_kind: DeclarationKind::Let,
                            initializer: Some(ValueId::new(0)),
                        },
                        semantics: InstructionSemantics::PURE_EAGER,
                        origin: origin(),
                    },
                ],
                TerminatorKind::Branch {
                    test: ValueId::new(0),
                    consequent: BlockId::new(1),
                    alternate: BlockId::new(2),
                },
            ),
            block(
                1,
                vec![
                    literal(1, one),
                    write(LocalId::new(0), ValueId::new(1), Vec::new()),
                ],
                TerminatorKind::Goto {
                    target: BlockId::new(3),
                },
            ),
            block(
                2,
                vec![
                    literal(2, two),
                    write(LocalId::new(0), ValueId::new(2), Vec::new()),
                ],
                TerminatorKind::Goto {
                    target: BlockId::new(3),
                },
            ),
            block(
                3,
                vec![HirInstruction {
                    result: Some(ValueId::new(3)),
                    kind: HirInstructionKind::Read {
                        place: Place::local(LocalId::new(0)),
                    },
                    semantics: InstructionSemantics::PURE_EAGER,
                    origin: origin(),
                }],
                TerminatorKind::Return {
                    value: Some(ValueId::new(3)),
                },
            ),
        ],
        entry: BlockId::new(0),
        regions: Vec::new(),
        origin: origin(),
    }
}

#[test]
fn inserts_structural_phi_for_diamond_and_materializes_verified_hir() {
    let function = diamond_function();
    verify_hir(&file(function.clone())).expect("input HIR");
    let analysis = analyze_ssa(&function).expect("SSA");
    assert_eq!(analysis.stats.phis, 1);
    let phi = &analysis.phis[0];
    assert_eq!(phi.block, BlockId::new(3));
    assert_eq!(
        phi.target,
        SsaName::new(LocalId::new(0), SsaVersion::new(4))
    );
    assert_eq!(
        phi.sources,
        [
            (
                BlockId::new(1),
                SsaName::new(LocalId::new(0), SsaVersion::new(2))
            ),
            (
                BlockId::new(2),
                SsaName::new(LocalId::new(0), SsaVersion::new(3))
            )
        ]
    );
    assert_eq!(
        analysis.block_entry[3][0],
        Some(SsaName::new(LocalId::new(0), SsaVersion::new(1)))
    );
    assert_eq!(
        analysis.block_exit[3][0],
        Some(SsaName::new(LocalId::new(0), SsaVersion::new(4)))
    );
    assert!(
        analysis
            .uses
            .iter()
            .any(|usage| usage.kind == SsaUseKind::Read && usage.name == phi.target)
    );
    let snapshot = print_ssa(&analysis);
    assert!(snapshot.contains("phi block3 local0.4 <- block1:local0.2 block2:local0.3"));
    assert_eq!(snapshot, print_ssa(&analysis));

    let materialized = materialize_ssa(&function, &analysis);
    let materialized_file = file(materialized);
    verify_hir(&materialized_file).expect("materialized SSA HIR");
    assert!(matches!(
        materialized_file.functions[0].blocks[3].instructions[0].kind,
        HirInstructionKind::Phi { .. }
    ));
}

#[test]
fn loop_phi_uses_preheader_and_back_edge_versions() {
    let mut function = diamond_function();
    function.blocks = vec![
        function.blocks[0].clone(),
        block(
            1,
            vec![HirInstruction {
                result: Some(ValueId::new(3)),
                kind: HirInstructionKind::Read {
                    place: Place::local(LocalId::new(0)),
                },
                semantics: InstructionSemantics::PURE_EAGER,
                origin: origin(),
            }],
            TerminatorKind::Branch {
                test: ValueId::new(0),
                consequent: BlockId::new(2),
                alternate: BlockId::new(3),
            },
        ),
        function.blocks[1].clone(),
        block(
            3,
            Vec::new(),
            TerminatorKind::Return {
                value: Some(ValueId::new(3)),
            },
        ),
    ];
    function.blocks[0].terminator.kind = TerminatorKind::Goto {
        target: BlockId::new(1),
    };
    function.blocks[2].id = BlockId::new(2);
    function.blocks[2].terminator.kind = TerminatorKind::Goto {
        target: BlockId::new(1),
    };

    let analysis = analyze_ssa(&function).expect("loop SSA");
    assert_eq!(analysis.phis.len(), 1);
    let phi = &analysis.phis[0];
    assert_eq!(phi.block, BlockId::new(1));
    assert_eq!(phi.sources[0].0, BlockId::new(0));
    assert_eq!(phi.sources[1].0, BlockId::new(2));
    assert_eq!(analysis.cfg.loop_headers, [BlockId::new(1)]);
}

#[test]
fn projected_write_reads_the_base_without_creating_a_new_local_version() {
    let mut function = diamond_function();
    function.blocks = vec![block(
        0,
        vec![
            function.blocks[0].instructions[0].clone(),
            function.blocks[0].instructions[1].clone(),
            write(
                LocalId::new(0),
                ValueId::new(0),
                vec![Projection::StaticProperty {
                    name: "field".into(),
                    optional: false,
                }],
            ),
        ],
        TerminatorKind::Return { value: None },
    )];
    function.values.truncate(1);

    let analysis = analyze_ssa(&function).expect("projected write SSA");
    assert_eq!(
        analysis
            .definitions
            .iter()
            .filter(|definition| definition.kind == SsaDefinitionKind::Write)
            .count(),
        0
    );
    assert!(
        analysis
            .uses
            .iter()
            .any(|usage| usage.kind == SsaUseKind::ProjectedWriteBase)
    );
}

#[test]
fn verifier_rejects_unknown_and_non_dominating_versions() {
    let function = diamond_function();
    let mut analysis = analyze_ssa(&function).expect("SSA");
    let read = analysis
        .uses
        .iter_mut()
        .find(|usage| usage.kind == SsaUseKind::Read)
        .expect("read use");
    read.name = SsaName::new(LocalId::new(0), SsaVersion::new(999));
    let diagnostics = verify_ssa(&function, &analysis).expect_err("unknown version");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-SSA-USE")
    );

    let mut analysis = analyze_ssa(&function).expect("SSA");
    let read = analysis
        .uses
        .iter_mut()
        .find(|usage| usage.kind == SsaUseKind::Read)
        .expect("read use");
    read.name = SsaName::new(LocalId::new(0), SsaVersion::new(2));
    let diagnostics = verify_ssa(&function, &analysis).expect_err("branch definition");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-SSA-DOMINANCE")
    );
}
