use fict_hir::{
    BinaryOperator, Binding, BindingId, BindingKind, BlockId, CallArgument, CallHost,
    CallInstruction, DeclarationKind, FictMacroKind, FileId, FunctionFlags, FunctionId,
    FunctionKind, HirBlock, HirFile, HirFunction, HirInstruction, HirInstructionKind, HirLocal,
    HirScope, HirTerminator, HirValue, ImportBinding, ImportKind, ImportedName,
    InstructionSemantics, LiteralValue, LocalId, LocalKind, NumberLiteral, Origin, Place,
    ReactiveCallKind, ScopeId, ScopeKind, SourceSpan, TerminatorKind, ValueId, ValueKind,
    verify_hir,
};
use fict_reactivity::{
    ReactiveBindingKind, analyze_aliases, analyze_dependencies, analyze_reactive_scopes,
    analyze_shapes, analyze_ssa, verify_reactive_scopes,
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

fn runtime_reactive_call(result: u32, binding: u32, kind: ReactiveCallKind) -> HirInstruction {
    HirInstruction {
        result: Some(ValueId::new(result)),
        kind: HirInstructionKind::Call(CallInstruction {
            callee: ValueId::new(0),
            callee_reference: None,
            arguments: vec![CallArgument {
                value: ValueId::new(1),
                spread: false,
            }],
            host: CallHost::Binding(BindingId::new(binding)),
            macro_kind: None,
            reactive_kind: Some(kind),
            optional: false,
        }),
        semantics: InstructionSemantics::CONSERVATIVE_EAGER,
        origin: origin(),
    }
}

fn block(id: u32, instructions: Vec<HirInstruction>, kind: TerminatorKind) -> HirBlock {
    HirBlock {
        id: BlockId::new(id),
        scope: ScopeId::new(0),
        instructions,
        terminator: HirTerminator {
            kind,
            origin: origin(),
        },
        source_hint: None,
        origin: origin(),
    }
}

#[test]
fn propagates_state_into_pure_derived_bindings_and_active_blocks() {
    let number = || LiteralValue::Number(NumberLiteral::from_f64(1.0));
    let call = |kind, arguments| {
        HirInstructionKind::Call(CallInstruction {
            callee: ValueId::new(0),
            callee_reference: None,
            arguments,
            host: CallHost::Unknown,
            macro_kind: Some(kind),
            reactive_kind: None,
            optional: false,
        })
    };
    let function = HirFunction {
        id: FunctionId::new(0),
        binding: None,
        scope: ScopeId::new(0),
        kind: FunctionKind::Module,
        flags: FunctionFlags::default(),
        parameters: Vec::new(),
        locals: vec![
            local(0, "state"),
            local(1, "derived"),
            local(2, "store"),
            local(3, "resource"),
            local(4, "selector"),
        ],
        values: vec![
            value(0, ValueKind::Literal(LiteralValue::Undefined)),
            value(1, ValueKind::Literal(number())),
            value(2, ValueKind::InstructionResult),
            value(3, ValueKind::InstructionResult),
            value(4, ValueKind::Literal(number())),
            value(5, ValueKind::InstructionResult),
            value(6, ValueKind::InstructionResult),
            value(7, ValueKind::InstructionResult),
            value(8, ValueKind::InstructionResult),
            value(9, ValueKind::InstructionResult),
        ],
        blocks: vec![
            block(
                0,
                vec![
                    instruction(
                        Some(0),
                        HirInstructionKind::Literal(LiteralValue::Undefined),
                    ),
                    instruction(Some(1), HirInstructionKind::Literal(number())),
                    HirInstruction {
                        result: Some(ValueId::new(2)),
                        kind: call(
                            FictMacroKind::State,
                            vec![CallArgument {
                                value: ValueId::new(1),
                                spread: false,
                            }],
                        ),
                        semantics: InstructionSemantics::CONSERVATIVE_EAGER,
                        origin: origin(),
                    },
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
                    instruction(Some(4), HirInstructionKind::Literal(number())),
                    instruction(
                        Some(5),
                        HirInstructionKind::Binary {
                            operator: BinaryOperator::Add,
                            left: ValueId::new(3),
                            right: ValueId::new(4),
                        },
                    ),
                    instruction(
                        None,
                        HirInstructionKind::Declare {
                            local: LocalId::new(1),
                            declaration_kind: DeclarationKind::Const,
                            initializer: Some(ValueId::new(5)),
                        },
                    ),
                    HirInstruction {
                        result: Some(ValueId::new(6)),
                        kind: call(FictMacroKind::Effect, Vec::new()),
                        semantics: InstructionSemantics::CONSERVATIVE_EAGER,
                        origin: origin(),
                    },
                    runtime_reactive_call(7, 0, ReactiveCallKind::Store),
                    instruction(
                        None,
                        HirInstructionKind::Declare {
                            local: LocalId::new(2),
                            declaration_kind: DeclarationKind::Const,
                            initializer: Some(ValueId::new(7)),
                        },
                    ),
                    runtime_reactive_call(8, 1, ReactiveCallKind::Resource),
                    instruction(
                        None,
                        HirInstructionKind::Declare {
                            local: LocalId::new(3),
                            declaration_kind: DeclarationKind::Const,
                            initializer: Some(ValueId::new(8)),
                        },
                    ),
                    runtime_reactive_call(9, 2, ReactiveCallKind::Selector),
                    instruction(
                        None,
                        HirInstructionKind::Declare {
                            local: LocalId::new(4),
                            declaration_kind: DeclarationKind::Const,
                            initializer: Some(ValueId::new(9)),
                        },
                    ),
                ],
                TerminatorKind::Branch {
                    test: ValueId::new(3),
                    consequent: BlockId::new(1),
                    alternate: BlockId::new(2),
                },
            ),
            block(1, Vec::new(), TerminatorKind::Return { value: None }),
            block(2, Vec::new(), TerminatorKind::Return { value: None }),
        ],
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
        bindings: [
            ("$store", "fict"),
            ("resource", "fict/plus"),
            ("createSelector", "@fictjs/runtime/advanced"),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (name, source))| Binding {
            id: BindingId::new(u32::try_from(index).expect("binding id")),
            scope: ScopeId::new(0),
            kind: BindingKind::Import,
            display_name: name.into(),
            import: Some(ImportBinding {
                source: source.into(),
                imported: ImportedName::Named(name.into()),
                kind: ImportKind::Value,
            }),
            origin: origin(),
        })
        .collect(),
        globals: Vec::new(),
        functions: vec![function],
        templates: Vec::new(),
        syntax_fragments: Vec::new(),
    };
    verify_hir(&file).expect("valid reactive scope fixture");
    let ssa = analyze_ssa(&file.functions[0]).expect("SSA");
    let dependencies = analyze_dependencies(&file, FunctionId::new(0), &ssa).expect("dependencies");
    let aliases = analyze_aliases(&file, FunctionId::new(0), &ssa, &dependencies).expect("aliases");
    let shapes =
        analyze_shapes(&file, FunctionId::new(0), &ssa, &dependencies, &aliases).expect("shapes");
    let analysis = analyze_reactive_scopes(
        &file,
        FunctionId::new(0),
        &ssa,
        &dependencies,
        &aliases,
        &shapes,
    )
    .expect("reactive scopes");

    assert_eq!(analysis.bindings.len(), 5);
    assert_eq!(analysis.bindings[0].kind, ReactiveBindingKind::State);
    assert_eq!(analysis.bindings[1].kind, ReactiveBindingKind::Derived);
    assert_eq!(analysis.bindings[2].kind, ReactiveBindingKind::Store);
    assert_eq!(analysis.bindings[3].kind, ReactiveBindingKind::Resource);
    assert_eq!(analysis.bindings[4].kind, ReactiveBindingKind::Selector);
    assert_eq!(analysis.bindings[1].dependencies.len(), 1);
    assert_eq!(analysis.blocks.len(), 1);
    assert_eq!(analysis.blocks[0].block, BlockId::new(0));
    assert!(analysis.blocks[0].has_external_effect);
    assert!(analysis.blocks[0].has_barrier);
    assert_eq!(analysis.blocks[0].control_flow_reads.len(), 1);
    assert_eq!(analysis.stats.derived_bindings, 1);

    let mut corrupted = analysis.clone();
    corrupted.bindings.push(corrupted.bindings[0].clone());
    let diagnostics = verify_reactive_scopes(&file.functions[0], &ssa, &dependencies, &corrupted)
        .expect_err("duplicate tracked binding");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-SCOPE-BINDING")
    );
}
