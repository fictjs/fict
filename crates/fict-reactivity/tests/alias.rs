use fict_hir::{
    BlockId, CallArgument, CallHost, CallInstruction, DeclarationKind, FileId, FunctionFlags,
    FunctionId, FunctionKind, HirBlock, HirFile, HirFunction, HirInstruction, HirInstructionKind,
    HirLocal, HirScope, HirTerminator, HirValue, InstructionSemantics, LiteralValue, LocalId,
    LocalKind, MutationEffect, ObjectEntry, ObjectPropertyKind, Origin, Place, PlaceBase,
    Projection, PropertyKey, ScopeId, ScopeKind, SourceSpan, TerminatorKind, ValueId, ValueKind,
    verify_hir,
};
use fict_reactivity::{
    AliasInvalidationReason, analyze_aliases, analyze_dependencies, analyze_ssa, verify_aliases,
};

fn origin() -> Origin {
    Origin::source(SourceSpan::empty(0))
}

fn local(id: u32, name: &str) -> HirLocal {
    HirLocal {
        id: LocalId::new(id),
        binding: None,
        scope: ScopeId::new(0),
        kind: LocalKind::User,
        declaration_kind: DeclarationKind::Const,
        debug_name: Some(name.into()),
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

fn declare(local: u32, initializer: ValueId) -> HirInstruction {
    HirInstruction {
        result: None,
        kind: HirInstructionKind::Declare {
            local: LocalId::new(local),
            declaration_kind: DeclarationKind::Const,
            initializer: Some(initializer),
        },
        semantics: InstructionSemantics::PURE_EAGER,
        origin: origin(),
    }
}

fn read(result: u32, local: u32) -> HirInstruction {
    HirInstruction {
        result: Some(ValueId::new(result)),
        kind: HirInstructionKind::Read {
            place: Place::local(LocalId::new(local)),
        },
        semantics: InstructionSemantics::PURE_EAGER,
        origin: origin(),
    }
}

fn write(local: u32, value: ValueId) -> HirInstruction {
    HirInstruction {
        result: None,
        kind: HirInstructionKind::Write {
            place: Place::local(LocalId::new(local)),
            value,
        },
        semantics: InstructionSemantics {
            mutation: MutationEffect::Local,
            ..InstructionSemantics::CONSERVATIVE_EAGER
        },
        origin: origin(),
    }
}

#[test]
fn forms_versioned_alias_classes_and_invalidates_every_member() {
    let values = vec![
        HirValue {
            id: ValueId::new(0),
            kind: ValueKind::Literal(LiteralValue::Boolean(true)),
            origin: origin(),
        },
        HirValue {
            id: ValueId::new(1),
            kind: ValueKind::InstructionResult,
            origin: origin(),
        },
        HirValue {
            id: ValueId::new(2),
            kind: ValueKind::InstructionResult,
            origin: origin(),
        },
        HirValue {
            id: ValueId::new(3),
            kind: ValueKind::InstructionResult,
            origin: origin(),
        },
        HirValue {
            id: ValueId::new(4),
            kind: ValueKind::Literal(LiteralValue::Undefined),
            origin: origin(),
        },
        HirValue {
            id: ValueId::new(5),
            kind: ValueKind::InstructionResult,
            origin: origin(),
        },
    ];
    let function = HirFunction {
        id: FunctionId::new(0),
        binding: None,
        scope: ScopeId::new(0),
        kind: FunctionKind::Module,
        flags: FunctionFlags::default(),
        parameters: Vec::new(),
        locals: vec![
            local(0, "a"),
            local(1, "b"),
            local(2, "c"),
            local(3, "not_alias"),
        ],
        values,
        blocks: vec![block(
            0,
            vec![
                HirInstruction {
                    result: Some(ValueId::new(0)),
                    kind: HirInstructionKind::Literal(LiteralValue::Boolean(true)),
                    semantics: InstructionSemantics::PURE_EAGER,
                    origin: origin(),
                },
                HirInstruction {
                    result: Some(ValueId::new(1)),
                    kind: HirInstructionKind::Object {
                        entries: vec![ObjectEntry::Property {
                            key: PropertyKey::Static("x".into()),
                            value: ValueId::new(0),
                            kind: ObjectPropertyKind::Init,
                            shorthand: false,
                            prototype_setter: false,
                            origin: origin(),
                        }],
                    },
                    semantics: InstructionSemantics::PURE_EAGER,
                    origin: origin(),
                },
                declare(0, ValueId::new(1)),
                read(2, 0),
                declare(1, ValueId::new(2)),
                read(3, 1),
                declare(2, ValueId::new(3)),
                HirInstruction {
                    result: None,
                    kind: HirInstructionKind::Write {
                        place: Place {
                            base: PlaceBase::Local(LocalId::new(1)),
                            projections: vec![Projection::StaticProperty {
                                name: "x".into(),
                                optional: false,
                            }],
                        },
                        value: ValueId::new(0),
                    },
                    semantics: InstructionSemantics {
                        mutation: MutationEffect::Local,
                        ..InstructionSemantics::CONSERVATIVE_EAGER
                    },
                    origin: origin(),
                },
                HirInstruction {
                    result: Some(ValueId::new(4)),
                    kind: HirInstructionKind::Literal(LiteralValue::Undefined),
                    semantics: InstructionSemantics::PURE_EAGER,
                    origin: origin(),
                },
                HirInstruction {
                    result: Some(ValueId::new(5)),
                    kind: HirInstructionKind::Call(CallInstruction {
                        callee: ValueId::new(4),
                        arguments: vec![CallArgument {
                            value: ValueId::new(3),
                            spread: false,
                        }],
                        host: CallHost::Unknown,
                        macro_kind: None,
                        reactive_kind: None,
                        optional: false,
                    }),
                    semantics: InstructionSemantics::CONSERVATIVE_EAGER,
                    origin: origin(),
                },
                declare(3, ValueId::new(5)),
            ],
            TerminatorKind::Return { value: None },
        )],
        entry: BlockId::new(0),
        regions: Vec::new(),
        origin: origin(),
    };
    let file = file(function);
    verify_hir(&file).expect("valid alias fixture");
    let ssa = analyze_ssa(&file.functions[0]).expect("SSA");
    let dependencies = analyze_dependencies(&file, FunctionId::new(0), &ssa).expect("dependencies");
    let analysis =
        analyze_aliases(&file, FunctionId::new(0), &ssa, &dependencies).expect("aliases");

    assert_eq!(analysis.edges.len(), 2);
    let class = analysis
        .classes
        .iter()
        .find(|class| class.members.len() == 3)
        .expect("a/b/c alias class");
    assert_eq!(class.root.local, LocalId::new(0));
    assert_eq!(
        class
            .members
            .iter()
            .map(|name| name.local)
            .collect::<Vec<_>>(),
        [LocalId::new(0), LocalId::new(1), LocalId::new(2)]
    );
    assert!(analysis.invalidations.iter().any(|invalidation| {
        invalidation.reason == AliasInvalidationReason::ProjectedWrite
            && invalidation.affected == class.members
    }));
    assert!(analysis.invalidations.iter().any(|invalidation| {
        invalidation.reason == AliasInvalidationReason::UnknownCall
            && invalidation.affected == class.members
    }));
    assert!(
        analysis
            .edges
            .iter()
            .all(|edge| edge.alias.local != LocalId::new(3))
    );

    let mut corrupted = analysis.clone();
    corrupted.classes[0].members.clear();
    let diagnostics =
        verify_aliases(&file.functions[0], &ssa, &corrupted).expect_err("empty alias class");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-ALIAS-CLASS")
    );
}

#[test]
fn phi_aliases_only_when_all_reachable_sources_share_one_root() {
    let values = vec![
        HirValue {
            id: ValueId::new(0),
            kind: ValueKind::Literal(LiteralValue::Boolean(true)),
            origin: origin(),
        },
        HirValue {
            id: ValueId::new(1),
            kind: ValueKind::InstructionResult,
            origin: origin(),
        },
        HirValue {
            id: ValueId::new(2),
            kind: ValueKind::InstructionResult,
            origin: origin(),
        },
    ];
    let function = HirFunction {
        id: FunctionId::new(0),
        binding: None,
        scope: ScopeId::new(0),
        kind: FunctionKind::Module,
        flags: FunctionFlags::default(),
        parameters: Vec::new(),
        locals: vec![local(0, "root"), local(1, "branch_alias")],
        values,
        blocks: vec![
            block(
                0,
                vec![
                    HirInstruction {
                        result: Some(ValueId::new(0)),
                        kind: HirInstructionKind::Literal(LiteralValue::Boolean(true)),
                        semantics: InstructionSemantics::PURE_EAGER,
                        origin: origin(),
                    },
                    declare(0, ValueId::new(0)),
                ],
                TerminatorKind::Branch {
                    test: ValueId::new(0),
                    consequent: BlockId::new(1),
                    alternate: BlockId::new(2),
                },
            ),
            block(
                1,
                vec![read(1, 0), write(1, ValueId::new(1))],
                TerminatorKind::Goto {
                    target: BlockId::new(3),
                },
            ),
            block(
                2,
                vec![read(2, 0), write(1, ValueId::new(2))],
                TerminatorKind::Goto {
                    target: BlockId::new(3),
                },
            ),
            block(3, Vec::new(), TerminatorKind::Return { value: None }),
        ],
        entry: BlockId::new(0),
        regions: Vec::new(),
        origin: origin(),
    };
    let file = file(function);
    verify_hir(&file).expect("valid Phi alias fixture");
    let ssa = analyze_ssa(&file.functions[0]).expect("SSA");
    assert_eq!(ssa.phis.len(), 1);
    let dependencies = analyze_dependencies(&file, FunctionId::new(0), &ssa).expect("dependencies");
    let analysis =
        analyze_aliases(&file, FunctionId::new(0), &ssa, &dependencies).expect("aliases");
    let phi_target = ssa.phis[0].target;
    let edge = analysis
        .edges
        .iter()
        .find(|edge| edge.alias == phi_target)
        .expect("Phi alias edge");
    assert_eq!(edge.source.local, LocalId::new(0));
}
