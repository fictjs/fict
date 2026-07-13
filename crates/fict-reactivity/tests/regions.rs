use fict_hir::{
    BinaryOperator, BlockId, CallArgument, CallHost, CallInstruction, DeclarationKind,
    FictMacroKind, FileId, FunctionFlags, FunctionId, FunctionKind, HirBlock, HirFile, HirFunction,
    HirInstruction, HirInstructionKind, HirLocal, HirScope, HirTerminator, HirValue,
    InstructionSemantics, LiteralValue, LocalId, LocalKind, NumberLiteral, Origin, Place, ScopeId,
    ScopeKind, SourceSpan, TerminatorKind, ValueId, ValueKind, verify_hir,
};
use fict_reactivity::{
    analyze_aliases, analyze_dependencies, analyze_reactive_cycles, analyze_reactive_scopes,
    analyze_regions, analyze_shapes, analyze_ssa, materialize_regions, verify_regions,
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

fn call(result: u32, macro_kind: Option<FictMacroKind>) -> HirInstruction {
    HirInstruction {
        result: Some(ValueId::new(result)),
        kind: HirInstructionKind::Call(CallInstruction {
            callee: ValueId::new(0),
            callee_reference: None,
            arguments: if macro_kind == Some(FictMacroKind::State) {
                vec![CallArgument {
                    value: ValueId::new(1),
                    spread: false,
                }]
            } else {
                Vec::new()
            },
            host: CallHost::Unknown,
            macro_kind,
            reactive_kind: None,
            optional: false,
        }),
        semantics: InstructionSemantics::CONSERVATIVE_EAGER,
        origin: origin(),
    }
}

fn analyze(function: HirFunction) -> fict_reactivity::RegionAnalysis {
    let file = HirFile {
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
    };
    verify_hir(&file).expect("valid region fixture");
    let function = &file.functions[0];
    let ssa = analyze_ssa(function).expect("SSA");
    let dependencies = analyze_dependencies(&file, FunctionId::new(0), &ssa).expect("dependencies");
    let aliases = analyze_aliases(&file, FunctionId::new(0), &ssa, &dependencies).expect("aliases");
    let shapes =
        analyze_shapes(&file, FunctionId::new(0), &ssa, &dependencies, &aliases).expect("shapes");
    let scopes = analyze_reactive_scopes(&file, FunctionId::new(0), &ssa, &dependencies, &shapes)
        .expect("scopes");
    let cycles = analyze_reactive_cycles(function, &scopes).expect("cycles");
    analyze_regions(&file, function, &ssa, &dependencies, &scopes, &cycles).expect("regions")
}

#[test]
fn splits_regions_at_barriers_and_memoizes_only_safe_derived_ranges() {
    let number = || LiteralValue::Number(NumberLiteral::from_f64(1.0));
    let function = HirFunction {
        id: FunctionId::new(0),
        binding: None,
        scope: ScopeId::new(0),
        kind: FunctionKind::Module,
        flags: FunctionFlags::default(),
        parameters: Vec::new(),
        locals: vec![local(0, "state"), local(1, "derived")],
        values: vec![
            value(0, ValueKind::Literal(LiteralValue::Undefined)),
            value(1, ValueKind::Literal(number())),
            value(2, ValueKind::InstructionResult),
            value(3, ValueKind::InstructionResult),
            value(4, ValueKind::InstructionResult),
            value(5, ValueKind::Literal(number())),
            value(6, ValueKind::InstructionResult),
            value(7, ValueKind::InstructionResult),
        ],
        blocks: vec![HirBlock {
            id: BlockId::new(0),
            scope: ScopeId::new(0),
            instructions: vec![
                instruction(
                    Some(0),
                    HirInstructionKind::Literal(LiteralValue::Undefined),
                ),
                instruction(Some(1), HirInstructionKind::Literal(number())),
                call(2, Some(FictMacroKind::State)),
                instruction(
                    None,
                    HirInstructionKind::Declare {
                        local: LocalId::new(0),
                        declaration_kind: DeclarationKind::Const,
                        initializer: Some(ValueId::new(2)),
                    },
                ),
                call(3, None),
                instruction(
                    Some(4),
                    HirInstructionKind::Read {
                        place: Place::local(LocalId::new(0)),
                    },
                ),
                instruction(Some(5), HirInstructionKind::Literal(number())),
                instruction(
                    Some(6),
                    HirInstructionKind::Binary {
                        operator: BinaryOperator::Add,
                        left: ValueId::new(4),
                        right: ValueId::new(5),
                    },
                ),
                instruction(
                    None,
                    HirInstructionKind::Declare {
                        local: LocalId::new(1),
                        declaration_kind: DeclarationKind::Const,
                        initializer: Some(ValueId::new(6)),
                    },
                ),
                call(7, Some(FictMacroKind::Effect)),
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
    let file = HirFile {
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
    };
    verify_hir(&file).expect("valid region fixture");
    let function = &file.functions[0];
    let ssa = analyze_ssa(function).expect("SSA");
    let dependencies = analyze_dependencies(&file, FunctionId::new(0), &ssa).expect("dependencies");
    let aliases = analyze_aliases(&file, FunctionId::new(0), &ssa, &dependencies).expect("aliases");
    let shapes =
        analyze_shapes(&file, FunctionId::new(0), &ssa, &dependencies, &aliases).expect("shapes");
    let scopes = analyze_reactive_scopes(&file, FunctionId::new(0), &ssa, &dependencies, &shapes)
        .expect("scopes");
    let cycles = analyze_reactive_cycles(function, &scopes).expect("cycles");
    let analysis =
        analyze_regions(&file, function, &ssa, &dependencies, &scopes, &cycles).expect("regions");

    assert_eq!(analysis.regions.len(), 4);
    assert_eq!(analysis.regions[0].ranges[0].start, 2);
    assert!(analysis.regions[0].has_barrier);
    assert_eq!(analysis.regions[1].outputs.len(), 1);
    assert_eq!(analysis.regions[2].ranges[0].start, 5);
    assert_eq!(analysis.regions[2].ranges[0].end, 9);
    assert_eq!(analysis.regions[2].inputs.len(), 1);
    assert_eq!(analysis.regions[2].outputs.len(), 1);
    assert!(analysis.regions[2].should_memoize);
    assert!(analysis.regions[3].has_external_effect);
    assert!(!analysis.regions[3].should_memoize);
    assert_eq!(analysis.regions_by_block[0].len(), 4);

    let materialized = materialize_regions(function, &analysis);
    assert_eq!(materialized.regions.len(), 4);

    let mut corrupted = analysis.clone();
    corrupted.regions[1].ranges[0].end = 5;
    let diagnostics = verify_regions(function, &dependencies, &scopes, &cycles, &corrupted)
        .expect_err("range crossing unknown call barrier");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-REGION-BARRIER")
    );
}

#[test]
fn assigns_control_flow_to_the_region_containing_the_controlling_read() {
    let number = || LiteralValue::Number(NumberLiteral::from_f64(1.0));
    let function = HirFunction {
        id: FunctionId::new(0),
        binding: None,
        scope: ScopeId::new(0),
        kind: FunctionKind::Module,
        flags: FunctionFlags::default(),
        parameters: Vec::new(),
        locals: vec![local(0, "state")],
        values: vec![
            value(0, ValueKind::Literal(LiteralValue::Undefined)),
            value(1, ValueKind::Literal(number())),
            value(2, ValueKind::InstructionResult),
            value(3, ValueKind::InstructionResult),
            value(4, ValueKind::Literal(number())),
        ],
        blocks: vec![
            HirBlock {
                id: BlockId::new(0),
                scope: ScopeId::new(0),
                instructions: vec![
                    instruction(
                        Some(0),
                        HirInstructionKind::Literal(LiteralValue::Undefined),
                    ),
                    instruction(Some(1), HirInstructionKind::Literal(number())),
                    call(2, Some(FictMacroKind::State)),
                    instruction(
                        None,
                        HirInstructionKind::Declare {
                            local: LocalId::new(0),
                            declaration_kind: DeclarationKind::Const,
                            initializer: Some(ValueId::new(2)),
                        },
                    ),
                    instruction(
                        Some(3),
                        HirInstructionKind::Read {
                            place: Place::local(LocalId::new(0)),
                        },
                    ),
                    // This unrelated trailing value keeps the controlling read away from the
                    // physical end of the block. Control ownership follows the read, not layout.
                    instruction(Some(4), HirInstructionKind::Literal(number())),
                ],
                terminator: HirTerminator {
                    kind: TerminatorKind::Branch {
                        test: ValueId::new(3),
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
                instructions: Vec::new(),
                terminator: HirTerminator {
                    kind: TerminatorKind::Return { value: None },
                    origin: origin(),
                },
                source_hint: None,
                origin: origin(),
            },
            HirBlock {
                id: BlockId::new(2),
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

    let analysis = analyze(function);
    let control_region = analysis
        .regions
        .iter()
        .find(|region| region.has_control_flow)
        .expect("controlling read region");
    assert_eq!(control_region.ranges[0].start, 3);
    assert_eq!(control_region.ranges[0].end, 5);
    assert_eq!(analysis.stats.control_flow_regions, 1);
}
