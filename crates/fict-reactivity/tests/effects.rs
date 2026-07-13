use fict_hir::{
    BinaryOperator, Binding, BindingId, BindingKind, BlockId, CallArgument, CallHost,
    CallInstruction, DeclarationKind, EvaluationMode, FileId, FunctionFlags, FunctionId,
    FunctionKind, HirBlock, HirFile, HirFunction, HirInstruction, HirInstructionKind, HirLocal,
    HirScope, HirTerminator, HirValue, InstructionSemantics, LiteralValue, LocalId, LocalKind,
    MutationEffect, NumberLiteral, Origin, Place, PlaceBase, Projection, Purity, ReactiveCallKind,
    ReactiveScopeHost, ReactiveScopeKind, ScopeId, ScopeKind, SourceSpan, TerminatorKind, ValueId,
    ValueKind, verify_hir,
};
use fict_reactivity::{
    BarrierKind, CallbackDisposition, DependencyBase, DependencySegment, EscapeKind,
    analyze_dependencies, analyze_ssa, verify_dependencies,
};

fn origin() -> Origin {
    Origin::source(SourceSpan::empty(0))
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

fn literal(id: u32, value: LiteralValue) -> HirInstruction {
    HirInstruction {
        result: Some(ValueId::new(id)),
        kind: HirInstructionKind::Literal(value),
        semantics: InstructionSemantics::PURE_EAGER,
        origin: origin(),
    }
}

fn base_file(functions: Vec<HirFunction>, bindings: Vec<Binding>) -> HirFile {
    let mut scopes = vec![HirScope {
        id: ScopeId::new(0),
        parent: None,
        kind: ScopeKind::Module,
        origin: origin(),
    }];
    if functions.len() > 1 {
        scopes.push(HirScope {
            id: ScopeId::new(1),
            parent: Some(ScopeId::new(0)),
            kind: ScopeKind::Function,
            origin: origin(),
        });
    }
    HirFile {
        id: FileId::new(0),
        source_len: 0,
        root_function: FunctionId::new(0),
        scopes,
        bindings,
        globals: Vec::new(),
        functions,
        templates: Vec::new(),
        syntax_fragments: Vec::new(),
    }
}

fn user_local(binding: Option<BindingId>) -> HirLocal {
    HirLocal {
        id: LocalId::new(0),
        binding,
        scope: ScopeId::new(0),
        kind: LocalKind::User,
        declaration_kind: DeclarationKind::Const,
        debug_name: Some("state".into()),
        origin: origin(),
    }
}

#[test]
fn tracks_static_dynamic_control_and_escape_paths_with_barriers() {
    let number = LiteralValue::Number(NumberLiteral::from_f64(1.0));
    let key = LiteralValue::String("dynamic".into());
    let static_place = Place {
        base: PlaceBase::Local(LocalId::new(0)),
        projections: vec![
            Projection::StaticProperty {
                name: "user".into(),
                optional: false,
            },
            Projection::StaticProperty {
                name: "name".into(),
                optional: true,
            },
        ],
    };
    let dynamic_place = Place {
        base: PlaceBase::Local(LocalId::new(0)),
        projections: vec![Projection::ComputedProperty {
            key: ValueId::new(2),
            optional: false,
        }],
    };
    let values = vec![
        HirValue {
            id: ValueId::new(0),
            kind: ValueKind::Literal(number.clone()),
            origin: origin(),
        },
        HirValue {
            id: ValueId::new(1),
            kind: ValueKind::InstructionResult,
            origin: origin(),
        },
        HirValue {
            id: ValueId::new(2),
            kind: ValueKind::Literal(key.clone()),
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
    ];
    let function = HirFunction {
        id: FunctionId::new(0),
        binding: None,
        scope: ScopeId::new(0),
        kind: FunctionKind::Module,
        flags: FunctionFlags::default(),
        parameters: Vec::new(),
        locals: vec![user_local(None)],
        values,
        blocks: vec![
            block(
                0,
                vec![
                    literal(0, number),
                    HirInstruction {
                        result: None,
                        kind: HirInstructionKind::Declare {
                            local: LocalId::new(0),
                            declaration_kind: DeclarationKind::Const,
                            initializer: Some(ValueId::new(0)),
                        },
                        semantics: InstructionSemantics::PURE_EAGER,
                        origin: origin(),
                    },
                    literal(2, key),
                    HirInstruction {
                        result: Some(ValueId::new(1)),
                        kind: HirInstructionKind::Read {
                            place: static_place.clone(),
                        },
                        semantics: InstructionSemantics::PURE_EAGER,
                        origin: origin(),
                    },
                    HirInstruction {
                        result: Some(ValueId::new(3)),
                        kind: HirInstructionKind::Read {
                            place: dynamic_place,
                        },
                        semantics: InstructionSemantics::PURE_EAGER,
                        origin: origin(),
                    },
                    HirInstruction {
                        result: Some(ValueId::new(4)),
                        kind: HirInstructionKind::Binary {
                            operator: BinaryOperator::Add,
                            left: ValueId::new(1),
                            right: ValueId::new(3),
                        },
                        semantics: InstructionSemantics::PURE_EAGER,
                        origin: origin(),
                    },
                ],
                TerminatorKind::Branch {
                    test: ValueId::new(4),
                    consequent: BlockId::new(1),
                    alternate: BlockId::new(2),
                },
            ),
            block(
                1,
                vec![HirInstruction {
                    result: None,
                    kind: HirInstructionKind::Write {
                        place: static_place,
                        value: ValueId::new(0),
                    },
                    semantics: InstructionSemantics {
                        purity: Purity::Impure,
                        mutation: MutationEffect::Observable,
                        evaluation: EvaluationMode::Eager,
                        may_throw: true,
                    },
                    origin: origin(),
                }],
                TerminatorKind::Return {
                    value: Some(ValueId::new(4)),
                },
            ),
            block(
                2,
                Vec::new(),
                TerminatorKind::Return {
                    value: Some(ValueId::new(1)),
                },
            ),
        ],
        entry: BlockId::new(0),
        regions: Vec::new(),
        origin: origin(),
    };
    let file = base_file(vec![function], Vec::new());
    verify_hir(&file).expect("valid effects fixture");
    let ssa = analyze_ssa(&file.functions[0]).expect("SSA");
    let analysis = analyze_dependencies(&file, FunctionId::new(0), &ssa).expect("dependencies");

    assert_eq!(analysis.reads.len(), 2);
    assert!(analysis.reads.iter().all(|read| read.controls_flow));
    assert_eq!(analysis.control_flow_reads.len(), 2);
    assert!(analysis.reads.iter().any(|read| {
        matches!(read.path.base, DependencyBase::Ssa(_))
            && read.path.segments
                == [
                    DependencySegment::Static {
                        name: "user".into(),
                        optional: false,
                    },
                    DependencySegment::Static {
                        name: "name".into(),
                        optional: true,
                    },
                ]
    }));
    assert!(analysis.reads.iter().any(|read| read.path.is_dynamic()));
    assert_eq!(analysis.value_dependencies[4].len(), 2);
    assert!(
        analysis
            .escapes
            .iter()
            .any(|escape| escape.kind == EscapeKind::Return)
    );
    assert!(analysis.barriers.iter().any(|barrier| {
        barrier.kinds.contains(&BarrierKind::ObservableMutation)
            && barrier.kinds.contains(&BarrierKind::MayThrow)
    }));

    let mut corrupted = analysis.clone();
    corrupted.reads[0].path.base = DependencyBase::Ssa(fict_hir::SsaName::new(
        LocalId::new(0),
        fict_hir::SsaVersion::new(999),
    ));
    let diagnostics = verify_dependencies(&file, FunctionId::new(0), &ssa, &corrupted)
        .expect_err("unknown dependency SSA name");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-ANALYSIS-SSA")
    );
}

#[test]
fn classifies_callback_hosts_captures_and_unknown_argument_escapes() {
    let binding = Binding {
        id: BindingId::new(0),
        scope: ScopeId::new(0),
        kind: BindingKind::Const,
        display_name: "captured".into(),
        import: None,
        origin: origin(),
    };
    let number = LiteralValue::Number(NumberLiteral::from_f64(1.0));
    let undefined = LiteralValue::Undefined;
    let values = vec![
        HirValue {
            id: ValueId::new(0),
            kind: ValueKind::Literal(number.clone()),
            origin: origin(),
        },
        HirValue {
            id: ValueId::new(1),
            kind: ValueKind::Function(FunctionId::new(1)),
            origin: origin(),
        },
        HirValue {
            id: ValueId::new(2),
            kind: ValueKind::Literal(undefined.clone()),
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
        HirValue {
            id: ValueId::new(5),
            kind: ValueKind::InstructionResult,
            origin: origin(),
        },
        HirValue {
            id: ValueId::new(6),
            kind: ValueKind::InstructionResult,
            origin: origin(),
        },
        HirValue {
            id: ValueId::new(7),
            kind: ValueKind::InstructionResult,
            origin: origin(),
        },
        HirValue {
            id: ValueId::new(8),
            kind: ValueKind::InstructionResult,
            origin: origin(),
        },
    ];
    let call = |result: u32, host: CallHost, argument: ValueId| HirInstruction {
        result: Some(ValueId::new(result)),
        kind: HirInstructionKind::Call(CallInstruction {
            callee: ValueId::new(2),
            callee_reference: None,
            arguments: vec![CallArgument {
                value: argument,
                spread: false,
            }],
            host,
            macro_kind: None,
            reactive_kind: None,
            optional: false,
        }),
        semantics: InstructionSemantics::CONSERVATIVE_EAGER,
        origin: origin(),
    };
    let runtime_callback_call =
        |result: u32, kind: ReactiveCallKind, argument: ValueId| HirInstruction {
            result: Some(ValueId::new(result)),
            kind: HirInstructionKind::Call(CallInstruction {
                callee: ValueId::new(2),
                callee_reference: None,
                arguments: vec![CallArgument {
                    value: argument,
                    spread: false,
                }],
                host: CallHost::Binding(BindingId::new(0)),
                macro_kind: None,
                reactive_kind: Some(kind),
                optional: false,
            }),
            semantics: InstructionSemantics::CONSERVATIVE_EAGER,
            origin: origin(),
        };
    let outer = HirFunction {
        id: FunctionId::new(0),
        binding: None,
        scope: ScopeId::new(0),
        kind: FunctionKind::Module,
        flags: FunctionFlags::default(),
        parameters: Vec::new(),
        locals: vec![user_local(Some(BindingId::new(0)))],
        values,
        blocks: vec![block(
            0,
            vec![
                literal(0, number),
                HirInstruction {
                    result: None,
                    kind: HirInstructionKind::Declare {
                        local: LocalId::new(0),
                        declaration_kind: DeclarationKind::Const,
                        initializer: Some(ValueId::new(0)),
                    },
                    semantics: InstructionSemantics::PURE_EAGER,
                    origin: origin(),
                },
                HirInstruction {
                    result: Some(ValueId::new(1)),
                    kind: HirInstructionKind::Function {
                        function: FunctionId::new(1),
                    },
                    semantics: InstructionSemantics::PURE_EAGER,
                    origin: origin(),
                },
                literal(2, undefined),
                call(3, CallHost::Unknown, ValueId::new(1)),
                call(
                    4,
                    CallHost::ReactiveScope(ReactiveScopeHost {
                        callee: BindingId::new(0),
                        callback_index: 0,
                        kind: ReactiveScopeKind::Configured,
                    }),
                    ValueId::new(1),
                ),
                HirInstruction {
                    result: Some(ValueId::new(5)),
                    kind: HirInstructionKind::Read {
                        place: Place::local(LocalId::new(0)),
                    },
                    semantics: InstructionSemantics::PURE_EAGER,
                    origin: origin(),
                },
                call(6, CallHost::Unknown, ValueId::new(5)),
                runtime_callback_call(7, ReactiveCallKind::Resource, ValueId::new(1)),
                runtime_callback_call(8, ReactiveCallKind::Selector, ValueId::new(1)),
            ],
            TerminatorKind::Return { value: None },
        )],
        entry: BlockId::new(0),
        regions: Vec::new(),
        origin: origin(),
    };
    let nested = HirFunction {
        id: FunctionId::new(1),
        binding: None,
        scope: ScopeId::new(1),
        kind: FunctionKind::Plain,
        flags: FunctionFlags::default(),
        parameters: Vec::new(),
        locals: vec![HirLocal {
            id: LocalId::new(0),
            binding: Some(BindingId::new(0)),
            scope: ScopeId::new(1),
            kind: LocalKind::Capture,
            declaration_kind: DeclarationKind::Generated,
            debug_name: Some("captured".into()),
            origin: origin(),
        }],
        values: Vec::new(),
        blocks: vec![HirBlock {
            id: BlockId::new(0),
            scope: ScopeId::new(1),
            instructions: Vec::new(),
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
    let file = base_file(vec![outer, nested], vec![binding]);
    verify_hir(&file).expect("valid callback fixture");
    let ssa = analyze_ssa(&file.functions[0]).expect("SSA");
    let analysis = analyze_dependencies(&file, FunctionId::new(0), &ssa).expect("dependencies");

    assert_eq!(analysis.callbacks.len(), 4);
    assert_eq!(
        analysis.callbacks[0].disposition,
        CallbackDisposition::EscapesUnknown
    );
    assert_eq!(
        analysis.callbacks[1].disposition,
        CallbackDisposition::Reactive(ReactiveScopeKind::Configured)
    );
    assert_eq!(
        analysis.callbacks[2].disposition,
        CallbackDisposition::Resource
    );
    assert_eq!(
        analysis.callbacks[3].disposition,
        CallbackDisposition::Selector
    );
    for kind in [
        EscapeKind::CallbackCapture,
        EscapeKind::DeferredCapture,
        EscapeKind::UnknownCall,
    ] {
        assert!(analysis.escapes.iter().any(|escape| escape.kind == kind));
    }
    assert!(
        analysis
            .escapes
            .iter()
            .filter(|escape| {
                matches!(
                    escape.kind,
                    EscapeKind::CallbackCapture | EscapeKind::DeferredCapture
                )
            })
            .all(|escape| matches!(
                escape.path.base,
                DependencyBase::Ssa(name) if name.version.index() == 1
            ))
    );
    assert!(
        analysis
            .barriers
            .iter()
            .filter(|barrier| {
                barrier.kinds.contains(&BarrierKind::UnknownMutation)
                    && barrier.kinds.contains(&BarrierKind::UnknownPurity)
                    && barrier.kinds.contains(&BarrierKind::MayThrow)
            })
            .count()
            >= 3
    );

    let mut corrupted = analysis.clone();
    corrupted.callbacks[2].disposition = CallbackDisposition::Memo;
    let diagnostics = verify_dependencies(&file, FunctionId::new(0), &ssa, &corrupted)
        .expect_err("runtime callback disposition is verified");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-ANALYSIS-CALLBACK-KIND")
    );
}
