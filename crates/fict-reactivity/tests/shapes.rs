use fict_hir::{
    ArrayElement, BlockId, CallArgument, CallHost, CallInstruction, DeclarationKind, FileId,
    FunctionFlags, FunctionId, FunctionKind, HirBlock, HirFile, HirFunction, HirInstruction,
    HirInstructionKind, HirLocal, HirScope, HirTerminator, HirValue, InstructionSemantics,
    LiteralValue, LocalId, LocalKind, MutationEffect, ObjectEntry, ObjectPropertyKind, Origin,
    Place, PlaceBase, Projection, PropertyKey, ScopeId, ScopeKind, SourceSpan, TerminatorKind,
    ValueId, ValueKind, verify_hir,
};
use fict_reactivity::{
    ShapeKey, ShapeKind, ShapeSource, analyze_aliases, analyze_dependencies, analyze_shapes,
    analyze_ssa, verify_shapes,
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

fn value(id: u32, kind: ValueKind) -> HirValue {
    HirValue {
        id: ValueId::new(id),
        kind,
        origin: origin(),
    }
}

fn instruction(result: Option<u32>, kind: HirInstructionKind) -> HirInstruction {
    HirInstruction {
        result: result.map(ValueId::new),
        kind,
        semantics: InstructionSemantics::PURE_EAGER,
        origin: origin(),
    }
}

fn declare(local: u32, initializer: u32) -> HirInstruction {
    instruction(
        None,
        HirInstructionKind::Declare {
            local: LocalId::new(local),
            declaration_kind: DeclarationKind::Const,
            initializer: Some(ValueId::new(initializer)),
        },
    )
}

fn read(result: u32, place: Place) -> HirInstruction {
    instruction(Some(result), HirInstructionKind::Read { place })
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

#[test]
fn propagates_shape_state_across_aliases() {
    let values = vec![
        value(0, ValueKind::Literal(LiteralValue::Boolean(true))),
        value(1, ValueKind::InstructionResult),
        value(2, ValueKind::InstructionResult),
        value(3, ValueKind::InstructionResult),
        value(4, ValueKind::Literal(LiteralValue::String("key".into()))),
        value(5, ValueKind::InstructionResult),
        value(6, ValueKind::Literal(LiteralValue::Undefined)),
        value(7, ValueKind::InstructionResult),
        value(8, ValueKind::InstructionResult),
    ];
    let function = HirFunction {
        id: FunctionId::new(0),
        binding: None,
        scope: ScopeId::new(0),
        kind: FunctionKind::Module,
        flags: FunctionFlags::default(),
        parameters: Vec::new(),
        locals: vec![local(0, "object"), local(1, "alias"), local(2, "array")],
        values,
        blocks: vec![HirBlock {
            id: BlockId::new(0),
            scope: ScopeId::new(0),
            instructions: vec![
                instruction(
                    Some(0),
                    HirInstructionKind::Literal(LiteralValue::Boolean(true)),
                ),
                instruction(
                    Some(1),
                    HirInstructionKind::Object {
                        entries: vec![
                            ObjectEntry::Property {
                                key: PropertyKey::Static("x".into()),
                                value: ValueId::new(0),
                                kind: ObjectPropertyKind::Init,
                                shorthand: false,
                                prototype_setter: false,
                                origin: origin(),
                            },
                            ObjectEntry::Property {
                                key: PropertyKey::Static("__proto__".into()),
                                value: ValueId::new(0),
                                kind: ObjectPropertyKind::Init,
                                shorthand: false,
                                prototype_setter: true,
                                origin: origin(),
                            },
                        ],
                    },
                ),
                declare(0, 1),
                read(2, Place::local(LocalId::new(0))),
                declare(1, 2),
                instruction(
                    Some(3),
                    HirInstructionKind::Array {
                        elements: vec![
                            ArrayElement::Value(ValueId::new(0)),
                            ArrayElement::Hole(origin()),
                            ArrayElement::Value(ValueId::new(0)),
                        ],
                    },
                ),
                declare(2, 3),
                HirInstruction {
                    result: None,
                    kind: HirInstructionKind::Write {
                        place: Place {
                            base: PlaceBase::Local(LocalId::new(2)),
                            projections: vec![Projection::Index {
                                index: 5,
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
                    result: None,
                    kind: HirInstructionKind::Write {
                        place: Place {
                            base: PlaceBase::Local(LocalId::new(1)),
                            projections: vec![Projection::StaticProperty {
                                name: "y".into(),
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
                instruction(
                    Some(4),
                    HirInstructionKind::Literal(LiteralValue::String("key".into())),
                ),
                read(
                    5,
                    Place {
                        base: PlaceBase::Local(LocalId::new(0)),
                        projections: vec![Projection::ComputedProperty {
                            key: ValueId::new(4),
                            optional: false,
                        }],
                    },
                ),
                instruction(
                    Some(6),
                    HirInstructionKind::Literal(LiteralValue::Undefined),
                ),
                read(7, Place::local(LocalId::new(1))),
                HirInstruction {
                    result: Some(ValueId::new(8)),
                    kind: HirInstructionKind::Call(CallInstruction {
                        callee: ValueId::new(6),
                        arguments: vec![CallArgument {
                            value: ValueId::new(7),
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
            ],
            terminator: HirTerminator {
                kind: TerminatorKind::Return { value: None },
                origin: origin(),
            },
            source_hint: None,
            origin: origin(),
        }],
        entry: BlockId::new(0),
        regions: Vec::new(),
        origin: origin(),
    };
    let file = file(function);
    verify_hir(&file).expect("valid shape fixture");
    let ssa = analyze_ssa(&file.functions[0]).expect("SSA");
    let dependencies = analyze_dependencies(&file, FunctionId::new(0), &ssa).expect("dependencies");
    let aliases = analyze_aliases(&file, FunctionId::new(0), &ssa, &dependencies).expect("aliases");
    let analysis =
        analyze_shapes(&file, FunctionId::new(0), &ssa, &dependencies, &aliases).expect("shapes");

    for local in [LocalId::new(0), LocalId::new(1)] {
        let shape = &analysis
            .shapes
            .iter()
            .filter(|fact| fact.name.local == local)
            .max_by_key(|fact| fact.name.version.index())
            .expect("object alias shape")
            .shape;
        assert_eq!(shape.kind, ShapeKind::Object);
        assert_eq!(
            shape.known_keys,
            [ShapeKey::Static("x".into()), ShapeKey::Static("y".into())]
        );
        assert_eq!(shape.mutable_keys, [ShapeKey::Static("y".into())]);
        assert!(shape.dynamic_access);
        assert!(!shape.complete_key_set);
        assert!(shape.escapes);
    }

    let array = &analysis
        .shapes
        .iter()
        .filter(|fact| fact.name.local == LocalId::new(2))
        .max_by_key(|fact| fact.name.version.index())
        .expect("array shape")
        .shape;
    assert_eq!(array.kind, ShapeKind::Array);
    assert_eq!(
        array.known_keys,
        [ShapeKey::Index(0), ShapeKey::Index(2), ShapeKey::Index(5)]
    );
    assert_eq!(array.mutable_keys, [ShapeKey::Index(5)]);
    assert_eq!(array.array_length, Some(6));
    assert!(array.complete_key_set);
    assert!(!array.has_spread);
    assert_eq!(analysis.property_accesses.len(), 3);

    let mut corrupted = analysis.clone();
    let object = corrupted
        .shapes
        .iter_mut()
        .filter(|fact| fact.name.local == LocalId::new(0))
        .max_by_key(|fact| fact.name.version.index())
        .expect("object shape");
    object.shape.complete_key_set = true;
    let diagnostics = verify_shapes(&file.functions[0], &ssa, &aliases, &corrupted)
        .expect_err("dynamic shape cannot be complete");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-SHAPE-COMPLETE")
    );
}

#[test]
fn spread_arrays_remain_open_and_have_no_exact_length() {
    let function = HirFunction {
        id: FunctionId::new(0),
        binding: None,
        scope: ScopeId::new(0),
        kind: FunctionKind::Module,
        flags: FunctionFlags::default(),
        parameters: Vec::new(),
        locals: vec![local(0, "array")],
        values: vec![
            value(0, ValueKind::Literal(LiteralValue::Boolean(true))),
            value(1, ValueKind::InstructionResult),
        ],
        blocks: vec![HirBlock {
            id: BlockId::new(0),
            scope: ScopeId::new(0),
            instructions: vec![
                instruction(
                    Some(0),
                    HirInstructionKind::Literal(LiteralValue::Boolean(true)),
                ),
                instruction(
                    Some(1),
                    HirInstructionKind::Array {
                        elements: vec![
                            ArrayElement::Value(ValueId::new(0)),
                            ArrayElement::Spread {
                                value: ValueId::new(0),
                                origin: origin(),
                            },
                        ],
                    },
                ),
                declare(0, 1),
            ],
            terminator: HirTerminator {
                kind: TerminatorKind::Return { value: None },
                origin: origin(),
            },
            source_hint: None,
            origin: origin(),
        }],
        entry: BlockId::new(0),
        regions: Vec::new(),
        origin: origin(),
    };
    let file = file(function);
    verify_hir(&file).expect("valid spread fixture");
    let ssa = analyze_ssa(&file.functions[0]).expect("SSA");
    let dependencies = analyze_dependencies(&file, FunctionId::new(0), &ssa).expect("dependencies");
    let aliases = analyze_aliases(&file, FunctionId::new(0), &ssa, &dependencies).expect("aliases");
    let analysis =
        analyze_shapes(&file, FunctionId::new(0), &ssa, &dependencies, &aliases).expect("shapes");
    let shape = &analysis
        .shapes
        .iter()
        .filter(|fact| fact.name.local == LocalId::new(0))
        .max_by_key(|fact| fact.name.version.index())
        .expect("array shape")
        .shape;
    assert!(shape.has_spread);
    assert!(!shape.complete_key_set);
    assert_eq!(shape.array_length, None);
}

#[test]
fn phi_join_keeps_object_kind_but_opens_different_key_sets() {
    let property = |name: &str| ObjectEntry::Property {
        key: PropertyKey::Static(name.into()),
        value: ValueId::new(0),
        kind: ObjectPropertyKind::Init,
        shorthand: false,
        prototype_setter: false,
        origin: origin(),
    };
    let function = HirFunction {
        id: FunctionId::new(0),
        binding: None,
        scope: ScopeId::new(0),
        kind: FunctionKind::Module,
        flags: FunctionFlags::default(),
        parameters: Vec::new(),
        locals: vec![local(0, "joined")],
        values: vec![
            value(0, ValueKind::Literal(LiteralValue::Boolean(true))),
            value(1, ValueKind::InstructionResult),
            value(2, ValueKind::InstructionResult),
        ],
        blocks: vec![
            HirBlock {
                id: BlockId::new(0),
                scope: ScopeId::new(0),
                instructions: vec![
                    instruction(
                        Some(0),
                        HirInstructionKind::Literal(LiteralValue::Boolean(true)),
                    ),
                    instruction(
                        Some(1),
                        HirInstructionKind::Object {
                            entries: vec![property("x")],
                        },
                    ),
                    instruction(
                        Some(2),
                        HirInstructionKind::Object {
                            entries: vec![property("y")],
                        },
                    ),
                ],
                terminator: HirTerminator {
                    kind: TerminatorKind::Branch {
                        test: ValueId::new(0),
                        consequent: BlockId::new(1),
                        alternate: BlockId::new(2),
                    },
                    origin: origin(),
                },
                source_hint: None,
                origin: origin(),
            },
            HirBlock {
                id: BlockId::new(1),
                scope: ScopeId::new(0),
                instructions: vec![HirInstruction {
                    result: None,
                    kind: HirInstructionKind::Write {
                        place: Place::local(LocalId::new(0)),
                        value: ValueId::new(1),
                    },
                    semantics: InstructionSemantics {
                        mutation: MutationEffect::Local,
                        ..InstructionSemantics::CONSERVATIVE_EAGER
                    },
                    origin: origin(),
                }],
                terminator: HirTerminator {
                    kind: TerminatorKind::Goto {
                        target: BlockId::new(3),
                    },
                    origin: origin(),
                },
                source_hint: None,
                origin: origin(),
            },
            HirBlock {
                id: BlockId::new(2),
                scope: ScopeId::new(0),
                instructions: vec![HirInstruction {
                    result: None,
                    kind: HirInstructionKind::Write {
                        place: Place::local(LocalId::new(0)),
                        value: ValueId::new(2),
                    },
                    semantics: InstructionSemantics {
                        mutation: MutationEffect::Local,
                        ..InstructionSemantics::CONSERVATIVE_EAGER
                    },
                    origin: origin(),
                }],
                terminator: HirTerminator {
                    kind: TerminatorKind::Goto {
                        target: BlockId::new(3),
                    },
                    origin: origin(),
                },
                source_hint: None,
                origin: origin(),
            },
            HirBlock {
                id: BlockId::new(3),
                scope: ScopeId::new(0),
                instructions: Vec::new(),
                terminator: HirTerminator {
                    kind: TerminatorKind::Return { value: None },
                    origin: origin(),
                },
                source_hint: None,
                origin: origin(),
            },
        ],
        entry: BlockId::new(0),
        regions: Vec::new(),
        origin: origin(),
    };
    let file = file(function);
    verify_hir(&file).expect("valid Phi shape fixture");
    let ssa = analyze_ssa(&file.functions[0]).expect("SSA");
    let dependencies = analyze_dependencies(&file, FunctionId::new(0), &ssa).expect("dependencies");
    let aliases = analyze_aliases(&file, FunctionId::new(0), &ssa, &dependencies).expect("aliases");
    let analysis =
        analyze_shapes(&file, FunctionId::new(0), &ssa, &dependencies, &aliases).expect("shapes");
    let phi = ssa.phis.first().expect("join Phi");
    let shape = &analysis
        .shapes
        .iter()
        .find(|fact| fact.name == phi.target)
        .expect("Phi shape")
        .shape;
    assert_eq!(shape.kind, ShapeKind::Object);
    assert_eq!(shape.source, ShapeSource::Phi);
    assert_eq!(
        shape.known_keys,
        [ShapeKey::Static("x".into()), ShapeKey::Static("y".into())]
    );
    assert!(!shape.complete_key_set);
}
