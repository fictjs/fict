use fict_hir::{
    BinaryOperator, BlockId, CallHost, CallInstruction, DeclarationKind, FileId, FunctionFlags,
    FunctionId, FunctionKind, HirBlock, HirFile, HirFunction, HirInstruction, HirInstructionKind,
    HirLocal, HirScope, HirTerminator, HirValue, InstructionSemantics, LiteralValue, LocalId,
    LocalKind, NumberLiteral, Origin, Place, PlaceBase, Projection, ScopeId, ScopeKind, SourceSpan,
    TaggedTemplateQuasi, TerminatorKind, UnaryOperator, ValueId, ValueKind, verify_hir,
};
use fict_reactivity::{
    ConstantPropagationOptions, analyze_aliases, analyze_constants, analyze_cse, analyze_dce,
    analyze_dependencies, analyze_ssa, apply_constant_folding, apply_cse_rewrites, apply_dce,
};

fn origin() -> Origin {
    Origin::source(SourceSpan::empty(0))
}

fn instruction(result: Option<u32>, kind: HirInstructionKind) -> HirInstruction {
    HirInstruction {
        result: result.map(ValueId::new),
        kind,
        semantics: InstructionSemantics::PURE_EAGER,
        origin: origin(),
    }
}

fn file() -> HirFile {
    let zero = LiteralValue::Number(NumberLiteral::from_f64(0.0));
    let function = HirFunction {
        id: FunctionId::new(0),
        binding: None,
        scope: ScopeId::new(0),
        kind: FunctionKind::Module,
        flags: FunctionFlags::default(),
        parameters: Vec::new(),
        locals: vec![HirLocal {
            id: LocalId::new(0),
            binding: None,
            scope: ScopeId::new(0),
            kind: LocalKind::User,
            declaration_kind: DeclarationKind::Const,
            debug_name: Some("zero".into()),
            origin: origin(),
        }],
        values: vec![
            HirValue {
                id: ValueId::new(0),
                kind: ValueKind::Literal(zero.clone()),
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
                kind: ValueKind::InstructionResult,
                origin: origin(),
            },
        ],
        blocks: vec![HirBlock {
            id: BlockId::new(0),
            scope: ScopeId::new(0),
            instructions: vec![
                instruction(Some(0), HirInstructionKind::Literal(zero)),
                instruction(
                    None,
                    HirInstructionKind::Declare {
                        local: LocalId::new(0),
                        declaration_kind: DeclarationKind::Const,
                        initializer: Some(ValueId::new(0)),
                    },
                ),
                instruction(
                    Some(1),
                    HirInstructionKind::Read {
                        place: Place::local(LocalId::new(0)),
                    },
                ),
                instruction(
                    Some(2),
                    HirInstructionKind::Unary {
                        operator: UnaryOperator::Minus,
                        argument: ValueId::new(1),
                    },
                ),
                instruction(
                    Some(3),
                    HirInstructionKind::Binary {
                        operator: BinaryOperator::Divide,
                        left: ValueId::new(0),
                        right: ValueId::new(0),
                    },
                ),
                instruction(
                    Some(4),
                    HirInstructionKind::Binary {
                        operator: BinaryOperator::StrictEqual,
                        left: ValueId::new(2),
                        right: ValueId::new(0),
                    },
                ),
            ],
            terminator: HirTerminator {
                kind: TerminatorKind::Return {
                    value: Some(ValueId::new(4)),
                },
                origin: origin(),
            },
            source_hint: None,
            origin: origin(),
        }],
        entry: BlockId::new(0),
        regions: Vec::new(),
        origin: origin(),
    };
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
fn folds_through_ssa_reads_and_preserves_negative_zero_and_nan() {
    let file = file();
    verify_hir(&file).expect("valid constant fixture");
    let ssa = analyze_ssa(&file.functions[0]).expect("SSA");
    let analysis = analyze_constants(
        &file.functions[0],
        &ssa,
        ConstantPropagationOptions::default(),
    )
    .expect("constants");

    let negative_zero = analysis
        .values
        .iter()
        .find(|fact| fact.value == ValueId::new(2))
        .expect("negative zero");
    assert!(matches!(
        negative_zero.literal,
        LiteralValue::Number(number) if number.is_negative_zero()
    ));
    let nan = analysis
        .values
        .iter()
        .find(|fact| fact.value == ValueId::new(3))
        .expect("NaN");
    assert!(matches!(
        nan.literal,
        LiteralValue::Number(number) if number.to_f64().is_nan()
    ));
    assert!(matches!(
        analysis
            .values
            .iter()
            .find(|fact| fact.value == ValueId::new(4))
            .map(|fact| &fact.literal),
        Some(LiteralValue::Boolean(true))
    ));
    assert_eq!(
        analysis.foldable_values,
        [
            ValueId::new(1),
            ValueId::new(2),
            ValueId::new(3),
            ValueId::new(4)
        ]
    );

    let optimized =
        apply_constant_folding(&file, FunctionId::new(0), &analysis).expect("verified folded HIR");
    assert!(
        optimized.functions[0].blocks[0].instructions[2..]
            .iter()
            .all(|instruction| matches!(instruction.kind, HirInstructionKind::Literal(_)))
    );
}

#[test]
fn fails_closed_when_the_fixed_point_budget_is_exhausted() {
    let file = file();
    let ssa = analyze_ssa(&file.functions[0]).expect("SSA");
    let diagnostics = analyze_constants(
        &file.functions[0],
        &ssa,
        ConstantPropagationOptions { max_iterations: 1 },
    )
    .expect_err("one sweep cannot converge the SSA chain");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-OPT-NONCONVERGENCE")
    );
}

#[test]
fn tracks_assignment_expression_constants_without_removing_the_write() {
    let mut file = file();
    let two = LiteralValue::Number(NumberLiteral::from_f64(2.0));
    file.functions[0].locals[0].declaration_kind = DeclarationKind::Let;
    file.functions[0].values = vec![
        HirValue {
            id: ValueId::new(0),
            kind: ValueKind::Literal(two.clone()),
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
    file.functions[0].blocks[0].instructions = vec![
        instruction(Some(0), HirInstructionKind::Literal(two)),
        instruction(
            None,
            HirInstructionKind::Declare {
                local: LocalId::new(0),
                declaration_kind: DeclarationKind::Let,
                initializer: Some(ValueId::new(0)),
            },
        ),
        HirInstruction {
            result: Some(ValueId::new(1)),
            kind: HirInstructionKind::Write {
                place: Place::local(LocalId::new(0)),
                value: ValueId::new(0),
            },
            semantics: InstructionSemantics {
                mutation: fict_hir::MutationEffect::Local,
                ..InstructionSemantics::CONSERVATIVE_EAGER
            },
            origin: origin(),
        },
        instruction(
            Some(2),
            HirInstructionKind::Binary {
                operator: BinaryOperator::Add,
                left: ValueId::new(1),
                right: ValueId::new(0),
            },
        ),
    ];
    file.functions[0].blocks[0].terminator.kind = TerminatorKind::Return {
        value: Some(ValueId::new(2)),
    };
    verify_hir(&file).expect("valid assignment constant fixture");
    let ssa = analyze_ssa(&file.functions[0]).expect("SSA");
    let analysis = analyze_constants(
        &file.functions[0],
        &ssa,
        ConstantPropagationOptions::default(),
    )
    .expect("assignment constants");

    assert!(analysis.values.iter().any(|fact| {
        fact.value == ValueId::new(1)
            && matches!(fact.literal, LiteralValue::Number(number) if number.to_f64() == 2.0)
    }));
    assert!(analysis.values.iter().any(|fact| {
        fact.value == ValueId::new(2)
            && matches!(fact.literal, LiteralValue::Number(number) if number.to_f64() == 4.0)
    }));
    assert!(!analysis.foldable_values.contains(&ValueId::new(1)));
    assert!(analysis.foldable_values.contains(&ValueId::new(2)));

    let optimized = apply_constant_folding(&file, FunctionId::new(0), &analysis)
        .expect("folded assignment HIR");
    assert!(matches!(
        optimized.functions[0].blocks[0].instructions[2].kind,
        HirInstructionKind::Write { .. }
    ));
    assert!(matches!(
        optimized.functions[0].blocks[0].instructions[3].kind,
        HirInstructionKind::Literal(LiteralValue::Number(number)) if number.to_f64() == 4.0
    ));
}

#[test]
fn cse_reuses_pure_values_but_never_crosses_an_unknown_call_barrier() {
    let mut file = file();
    let zero = LiteralValue::Number(NumberLiteral::from_f64(0.0));
    file.functions[0].locals.clear();
    file.functions[0].values = (0..6)
        .map(|id| HirValue {
            id: ValueId::new(id),
            kind: if id == 0 {
                ValueKind::Literal(zero.clone())
            } else {
                ValueKind::InstructionResult
            },
            origin: origin(),
        })
        .collect();
    file.functions[0].blocks[0].instructions = vec![
        instruction(Some(0), HirInstructionKind::Literal(zero)),
        instruction(
            Some(1),
            HirInstructionKind::Binary {
                operator: BinaryOperator::Add,
                left: ValueId::new(0),
                right: ValueId::new(0),
            },
        ),
        instruction(
            Some(2),
            HirInstructionKind::Binary {
                operator: BinaryOperator::Add,
                left: ValueId::new(0),
                right: ValueId::new(0),
            },
        ),
        HirInstruction {
            result: Some(ValueId::new(3)),
            kind: HirInstructionKind::Call(CallInstruction {
                callee: ValueId::new(0),
                callee_reference: None,
                arguments: Vec::new(),
                host: CallHost::Unknown,
                macro_kind: None,
                reactive_kind: None,
                optional: false,
            }),
            semantics: InstructionSemantics::CONSERVATIVE_EAGER,
            origin: origin(),
        },
        instruction(
            Some(4),
            HirInstructionKind::Binary {
                operator: BinaryOperator::Add,
                left: ValueId::new(0),
                right: ValueId::new(0),
            },
        ),
        instruction(
            Some(5),
            HirInstructionKind::Unary {
                operator: UnaryOperator::Minus,
                argument: ValueId::new(2),
            },
        ),
    ];
    file.functions[0].blocks[0].terminator.kind = TerminatorKind::Return {
        value: Some(ValueId::new(5)),
    };
    verify_hir(&file).expect("valid CSE fixture");
    let ssa = analyze_ssa(&file.functions[0]).expect("SSA");
    let dependencies = analyze_dependencies(&file, FunctionId::new(0), &ssa).expect("dependencies");
    let analysis = analyze_cse(&file.functions[0], &ssa, &dependencies).expect("CSE");
    assert_eq!(analysis.replacements.len(), 1);
    assert_eq!(analysis.replacements[0].duplicate, ValueId::new(2));
    assert_eq!(analysis.replacements[0].canonical, ValueId::new(1));
    assert!(analysis.stats.invalidations >= 1);

    let optimized =
        apply_cse_rewrites(&file, FunctionId::new(0), &analysis).expect("verified CSE rewrite");
    assert!(matches!(
        optimized.functions[0].blocks[0].instructions[5].kind,
        HirInstructionKind::Unary {
            argument,
            ..
        } if argument == ValueId::new(1)
    ));

    let optimized_ssa = analyze_ssa(&optimized.functions[0]).expect("rewritten SSA");
    let optimized_dependencies =
        analyze_dependencies(&optimized, FunctionId::new(0), &optimized_ssa)
            .expect("rewritten dependencies");
    let aliases = analyze_aliases(
        &optimized,
        FunctionId::new(0),
        &optimized_ssa,
        &optimized_dependencies,
    )
    .expect("rewritten aliases");
    let dce = analyze_dce(
        &optimized,
        FunctionId::new(0),
        &optimized_ssa,
        &optimized_dependencies,
        &aliases,
    )
    .expect("DCE");
    assert_eq!(dce.dead_values, [ValueId::new(2), ValueId::new(4)]);
    assert_eq!(dce.inline_candidates.len(), 1);
    assert_eq!(dce.inline_candidates[0].value, ValueId::new(5));

    let compacted =
        apply_dce(&optimized, FunctionId::new(0), &dce).expect("verified compact DCE result");
    assert_eq!(compacted.functions[0].values.len(), 4);
    assert_eq!(compacted.functions[0].blocks[0].instructions.len(), 4);
    assert!(matches!(
        compacted.functions[0].blocks[0].terminator.kind,
        TerminatorKind::Return {
            value: Some(value)
        } if value == ValueId::new(3)
    ));
}

#[test]
fn cse_and_dce_remap_method_call_references_with_their_callee_reads() {
    let mut file = file();
    let zero = LiteralValue::Number(NumberLiteral::from_f64(0.0));
    let key = LiteralValue::Boolean(true);
    file.functions[0].locals.clear();
    file.functions[0].values = vec![
        HirValue {
            id: ValueId::new(0),
            kind: ValueKind::Literal(zero.clone()),
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
            kind: ValueKind::Literal(key.clone()),
            origin: origin(),
        },
        HirValue {
            id: ValueId::new(4),
            kind: ValueKind::InstructionResult,
            origin: origin(),
        },
        HirValue {
            id: ValueId::new(5),
            kind: ValueKind::InstructionResult,
            origin: origin(),
        },
    ];
    let duplicate_base = || HirInstructionKind::Binary {
        operator: BinaryOperator::Add,
        left: ValueId::new(0),
        right: ValueId::new(0),
    };
    let method = Place {
        base: PlaceBase::Value(ValueId::new(2)),
        projections: vec![Projection::ComputedProperty {
            key: ValueId::new(3),
            optional: false,
        }],
    };
    file.functions[0].blocks[0].instructions = vec![
        instruction(Some(0), HirInstructionKind::Literal(zero)),
        instruction(Some(1), duplicate_base()),
        instruction(Some(2), duplicate_base()),
        instruction(Some(3), HirInstructionKind::Literal(key)),
        instruction(
            Some(4),
            HirInstructionKind::Read {
                place: method.clone(),
            },
        ),
        HirInstruction {
            result: Some(ValueId::new(5)),
            kind: HirInstructionKind::Call(CallInstruction {
                callee: ValueId::new(4),
                callee_reference: Some(method),
                arguments: Vec::new(),
                host: CallHost::Unknown,
                macro_kind: None,
                reactive_kind: None,
                optional: false,
            }),
            semantics: InstructionSemantics::CONSERVATIVE_EAGER,
            origin: origin(),
        },
    ];
    file.functions[0].blocks[0].terminator.kind = TerminatorKind::Return {
        value: Some(ValueId::new(5)),
    };
    verify_hir(&file).expect("valid method-call optimizer fixture");

    let ssa = analyze_ssa(&file.functions[0]).expect("SSA");
    let dependencies = analyze_dependencies(&file, FunctionId::new(0), &ssa).expect("dependencies");
    let cse = analyze_cse(&file.functions[0], &ssa, &dependencies).expect("CSE");
    assert!(cse.replacements.iter().any(|replacement| {
        replacement.duplicate == ValueId::new(2) && replacement.canonical == ValueId::new(1)
    }));
    let rewritten =
        apply_cse_rewrites(&file, FunctionId::new(0), &cse).expect("verified CSE rewrite");
    let read_place = match &rewritten.functions[0].blocks[0].instructions[4].kind {
        HirInstructionKind::Read { place } => place,
        _ => panic!("method read"),
    };
    let call = match &rewritten.functions[0].blocks[0].instructions[5].kind {
        HirInstructionKind::Call(call) => call,
        _ => panic!("method call"),
    };
    assert_eq!(call.callee_reference.as_ref(), Some(read_place));
    assert!(matches!(read_place.base, PlaceBase::Value(value) if value == ValueId::new(1)));

    let ssa = analyze_ssa(&rewritten.functions[0]).expect("rewritten SSA");
    let dependencies =
        analyze_dependencies(&rewritten, FunctionId::new(0), &ssa).expect("rewritten dependencies");
    let aliases = analyze_aliases(&rewritten, FunctionId::new(0), &ssa, &dependencies)
        .expect("rewritten aliases");
    let dce = analyze_dce(
        &rewritten,
        FunctionId::new(0),
        &ssa,
        &dependencies,
        &aliases,
    )
    .expect("DCE");
    assert!(dce.dead_values.contains(&ValueId::new(2)));
    let compacted =
        apply_dce(&rewritten, FunctionId::new(0), &dce).expect("verified compact DCE result");
    let read_place = match &compacted.functions[0].blocks[0].instructions[3].kind {
        HirInstructionKind::Read { place } => place,
        _ => panic!("compacted method read"),
    };
    let call = match &compacted.functions[0].blocks[0].instructions[4].kind {
        HirInstructionKind::Call(call) => call,
        _ => panic!("compacted method call"),
    };
    assert_eq!(call.callee, ValueId::new(3));
    assert_eq!(call.callee_reference.as_ref(), Some(read_place));
    assert!(matches!(read_place.base, PlaceBase::Value(value) if value == ValueId::new(1)));
    assert!(matches!(
        read_place.projections.as_slice(),
        [Projection::ComputedProperty {
            key,
            optional: false,
        }] if *key == ValueId::new(2)
    ));
}

#[test]
fn cse_and_dce_remap_method_tag_references_with_their_tag_reads() {
    let mut file = file();
    let zero = LiteralValue::Number(NumberLiteral::from_f64(0.0));
    let key = LiteralValue::Boolean(true);
    file.functions[0].locals.clear();
    file.functions[0].values = vec![
        HirValue {
            id: ValueId::new(0),
            kind: ValueKind::Literal(zero.clone()),
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
            kind: ValueKind::Literal(key.clone()),
            origin: origin(),
        },
        HirValue {
            id: ValueId::new(4),
            kind: ValueKind::InstructionResult,
            origin: origin(),
        },
        HirValue {
            id: ValueId::new(5),
            kind: ValueKind::InstructionResult,
            origin: origin(),
        },
    ];
    let duplicate_base = || HirInstructionKind::Binary {
        operator: BinaryOperator::Add,
        left: ValueId::new(0),
        right: ValueId::new(0),
    };
    let tag = Place {
        base: PlaceBase::Value(ValueId::new(2)),
        projections: vec![Projection::ComputedProperty {
            key: ValueId::new(3),
            optional: false,
        }],
    };
    file.functions[0].blocks[0].instructions = vec![
        instruction(Some(0), HirInstructionKind::Literal(zero)),
        instruction(Some(1), duplicate_base()),
        instruction(Some(2), duplicate_base()),
        instruction(Some(3), HirInstructionKind::Literal(key)),
        instruction(Some(4), HirInstructionKind::Read { place: tag.clone() }),
        HirInstruction {
            result: Some(ValueId::new(5)),
            kind: HirInstructionKind::TaggedTemplate {
                tag: ValueId::new(4),
                tag_reference: Some(tag),
                quasis: vec![TaggedTemplateQuasi {
                    cooked: Some("value".into()),
                    raw: "value".to_owned(),
                }],
                substitutions: Vec::new(),
                host: CallHost::Unknown,
            },
            semantics: InstructionSemantics::CONSERVATIVE_EAGER,
            origin: origin(),
        },
    ];
    file.functions[0].blocks[0].terminator.kind = TerminatorKind::Return {
        value: Some(ValueId::new(5)),
    };
    verify_hir(&file).expect("valid method-tag optimizer fixture");

    let ssa = analyze_ssa(&file.functions[0]).expect("SSA");
    let dependencies = analyze_dependencies(&file, FunctionId::new(0), &ssa).expect("dependencies");
    let cse = analyze_cse(&file.functions[0], &ssa, &dependencies).expect("CSE");
    assert!(cse.replacements.iter().any(|replacement| {
        replacement.duplicate == ValueId::new(2) && replacement.canonical == ValueId::new(1)
    }));
    let rewritten =
        apply_cse_rewrites(&file, FunctionId::new(0), &cse).expect("verified CSE rewrite");
    let read_place = match &rewritten.functions[0].blocks[0].instructions[4].kind {
        HirInstructionKind::Read { place } => place,
        _ => panic!("tag read"),
    };
    let (tag, tag_reference) = match &rewritten.functions[0].blocks[0].instructions[5].kind {
        HirInstructionKind::TaggedTemplate {
            tag, tag_reference, ..
        } => (*tag, tag_reference),
        _ => panic!("tagged template"),
    };
    assert_eq!(tag, ValueId::new(4));
    assert_eq!(tag_reference.as_ref(), Some(read_place));
    assert!(matches!(read_place.base, PlaceBase::Value(value) if value == ValueId::new(1)));

    let ssa = analyze_ssa(&rewritten.functions[0]).expect("rewritten SSA");
    let dependencies =
        analyze_dependencies(&rewritten, FunctionId::new(0), &ssa).expect("rewritten dependencies");
    let aliases = analyze_aliases(&rewritten, FunctionId::new(0), &ssa, &dependencies)
        .expect("rewritten aliases");
    let dce = analyze_dce(
        &rewritten,
        FunctionId::new(0),
        &ssa,
        &dependencies,
        &aliases,
    )
    .expect("DCE");
    assert!(dce.dead_values.contains(&ValueId::new(2)));
    let compacted =
        apply_dce(&rewritten, FunctionId::new(0), &dce).expect("verified compact DCE result");
    let read_place = match &compacted.functions[0].blocks[0].instructions[3].kind {
        HirInstructionKind::Read { place } => place,
        _ => panic!("compacted tag read"),
    };
    let (tag, tag_reference) = match &compacted.functions[0].blocks[0].instructions[4].kind {
        HirInstructionKind::TaggedTemplate {
            tag, tag_reference, ..
        } => (*tag, tag_reference),
        _ => panic!("compacted tagged template"),
    };
    assert_eq!(tag, ValueId::new(3));
    assert_eq!(tag_reference.as_ref(), Some(read_place));
    assert!(matches!(read_place.base, PlaceBase::Value(value) if value == ValueId::new(1)));
    assert!(matches!(
        read_place.projections.as_slice(),
        [Projection::ComputedProperty {
            key,
            optional: false,
        }] if *key == ValueId::new(2)
    ));
}
