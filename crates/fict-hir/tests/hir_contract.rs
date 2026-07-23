use fict_hir::{
    Binding, BindingId, BindingKind, BlockId, CallArgument, CallHost, CallInstruction,
    DeclarationKind, DeleteTarget, FileId, FunctionFlags, FunctionId, FunctionKind, GlobalId,
    HirBlock, HirFile, HirFunction, HirGlobal, HirInstruction, HirInstructionKind, HirLocal,
    HirPatternWrite, HirScope, HirTerminator, HirValue, ImportPhase, InstructionSemantics,
    JavaScriptString, LiteralValue, LocalId, LocalKind, ModuleExport, ModuleLocalExport,
    ModulePlan, NumberLiteral, ObjectEntry, ObjectPropertyKind, Origin, PatternSummary, Place,
    PlaceBase, Projection, PropertyKey, ReactiveScopeHost, ReactiveScopeKind, ScopeId, ScopeKind,
    StructuredSourceHint, StructuredSourceKind, StructuredSwitchCaseHint, SyntaxFragment,
    SyntaxFragmentId, SyntaxFragmentKind, SyntaxSummary, TaggedTemplateQuasi, TerminatorKind,
    ValueId, ValueKind, print_hir, verify_hir, verify_module_plan,
};

fn empty_file() -> HirFile {
    let origin = Origin::source(fict_hir::SourceSpan::empty(0));
    HirFile {
        id: FileId::new(0),
        source_len: 0,
        root_function: FunctionId::new(0),
        scopes: vec![HirScope {
            id: ScopeId::new(0),
            parent: None,
            kind: ScopeKind::Module,
            origin,
        }],
        bindings: Vec::new(),
        globals: Vec::new(),
        authored_free_names: Vec::new(),
        functions: vec![HirFunction {
            id: FunctionId::new(0),
            parent: FunctionId::new(0),
            binding: None,
            scope: ScopeId::new(0),
            kind: FunctionKind::Module,
            flags: FunctionFlags::default(),
            parameters: Vec::new(),
            locals: Vec::new(),
            values: Vec::new(),
            blocks: vec![HirBlock {
                id: BlockId::new(0),
                scope: ScopeId::new(0),
                instructions: Vec::new(),
                terminator: HirTerminator {
                    kind: TerminatorKind::Return { value: None },
                    origin,
                },
                source_hint: None,
                origin,
            }],
            entry: BlockId::new(0),
            effect_statements: Vec::new(),
            regions: Vec::new(),
            origin,
        }],
        templates: Vec::new(),
        syntax_fragments: Vec::new(),
    }
}

#[test]
fn valid_empty_hir_has_a_canonical_snapshot() {
    let file = empty_file();
    verify_hir(&file).expect("empty HIR should be valid");

    assert_eq!(
        print_hir(&file),
        concat!(
            "file file0 source_len=0 root=fn0\n",
            "scope scope0 kind=Module parent=- origin=source@0..0\n",
            "function fn0 parent=fn0 kind=Module binding=- scope=scope0 async=false generator=false ",
            "arrow=false no_memo=false pure=false entry=block0 regions=[] origin=source@0..0\n",
            "  block block0 scope=scope0 hint=None origin=source@0..0\n",
            "    terminator kind=Return { value: None } origin=source@0..0\n",
        )
    );
}

#[test]
fn verifier_reports_arena_and_span_corruption_without_panicking() {
    let mut file = empty_file();
    file.root_function = FunctionId::new(9);
    file.scopes[0].id = ScopeId::new(4);
    file.functions[0].origin =
        Origin::source(fict_hir::SourceSpan::new(0, 1).expect("well-formed but out-of-file span"));

    let diagnostics = verify_hir(&file)
        .expect_err("corrupted HIR must fail")
        .into_sorted();
    let codes: Vec<_> = diagnostics
        .iter()
        .map(|diagnostic| diagnostic.code.as_str())
        .collect();

    assert!(codes.contains(&"FICT-HIR-ID"));
    assert!(codes.contains(&"FICT-HIR-SPAN"));
    assert!(diagnostics.iter().all(|diagnostic| {
        diagnostic.guarantee_class == fict_diagnostics::GuaranteeClass::Internal
    }));
}

#[test]
fn verifier_rejects_non_canonical_function_parent_ownership() {
    let mut file = empty_file();
    file.functions[0].parent = FunctionId::new(1);

    let diagnostics = verify_hir(&file)
        .expect_err("root ownership must be canonical")
        .into_sorted();
    assert!(diagnostics.iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-FUNCTION"
            && diagnostic.message.contains("lexical parent")
    }));
}

#[test]
fn verifier_only_allows_configured_reactive_hosts_without_lexical_bindings() {
    let mut file = empty_file();
    let origin = file.functions[0].origin;
    file.functions[0].values.extend([
        HirValue {
            id: ValueId::new(0),
            kind: ValueKind::Literal(LiteralValue::Undefined),
            origin,
        },
        HirValue {
            id: ValueId::new(1),
            kind: ValueKind::InstructionResult,
            origin,
        },
    ]);
    file.functions[0].blocks[0].instructions.extend([
        HirInstruction {
            result: Some(ValueId::new(0)),
            kind: HirInstructionKind::Literal(LiteralValue::Undefined),
            semantics: InstructionSemantics::PURE_EAGER,
            origin,
        },
        HirInstruction {
            result: Some(ValueId::new(1)),
            kind: HirInstructionKind::Call(CallInstruction {
                callee: ValueId::new(0),
                callee_reference: None,
                state_receiver_kind: fict_hir::StateReceiverKind::Unknown,
                arguments: vec![CallArgument {
                    value: ValueId::new(0),
                    spread: false,
                }],
                host: CallHost::ReactiveScope(ReactiveScopeHost {
                    callee: None,
                    callback_index: 0,
                    kind: ReactiveScopeKind::Configured,
                }),
                macro_kind: None,
                reactive_kind: None,
                optional: false,
            }),
            semantics: InstructionSemantics::CONSERVATIVE_EAGER,
            origin,
        },
    ]);
    verify_hir(&file).expect("configured global reactive host");

    let HirInstructionKind::Call(call) = &mut file.functions[0].blocks[0].instructions[1].kind
    else {
        panic!("call fixture")
    };
    let CallHost::ReactiveScope(host) = &mut call.host else {
        panic!("reactive host fixture")
    };
    host.kind = ReactiveScopeKind::EffectCallback;
    let diagnostics = verify_hir(&file).expect_err("runtime reactive host must retain a binding");
    assert!(diagnostics.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-CALL-HOST"
            && diagnostic.message.contains("callee binding")
    }));
}

#[test]
fn module_plan_verifier_fails_closed_on_invalid_ownership() {
    let mut file = empty_file();
    file.source_len = 4;
    let plan = ModulePlan {
        has_module_syntax: false,
        exports: vec![
            ModuleExport::Local {
                exported: "named".into(),
                target: ModuleLocalExport::DefaultExpression,
                origin: Origin::source(
                    fict_hir::SourceSpan::new(0, 2).expect("module export span"),
                ),
            },
            ModuleExport::Local {
                exported: "missing".into(),
                target: ModuleLocalExport::Binding(BindingId::new(7)),
                origin: Origin::source(
                    fict_hir::SourceSpan::new(2, 4).expect("module export span"),
                ),
            },
            ModuleExport::Star {
                source: String::new(),
                origin: Origin::source(
                    fict_hir::SourceSpan::new(4, 5).expect("out-of-file export span"),
                ),
            },
        ],
    };

    let diagnostics = verify_module_plan(&file, &plan)
        .expect_err("invalid module ownership must fail")
        .into_sorted();
    assert!(diagnostics.len() >= 5, "{diagnostics:?}");
    assert!(
        diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code.as_str() == "FICT-HIR-MODULE")
    );
    assert!(diagnostics.iter().all(|diagnostic| {
        diagnostic.guarantee_class == fict_diagnostics::GuaranteeClass::Internal
    }));
}

#[test]
fn verifier_enforces_pattern_assignment_result_write_and_summary_invariants() {
    let mut file = empty_file();
    file.source_len = 4;
    let assignment_origin =
        Origin::source(fict_hir::SourceSpan::new(0, 4).expect("assignment fixture span"));
    let pattern_origin =
        Origin::source(fict_hir::SourceSpan::new(0, 2).expect("pattern fixture span"));
    let write_origin = Origin::source(fict_hir::SourceSpan::new(0, 1).expect("write fixture span"));
    file.bindings.push(Binding {
        id: BindingId::new(0),
        scope: ScopeId::new(0),
        kind: BindingKind::Let,
        display_name: "target".into(),
        import: None,
        origin: write_origin,
    });
    file.syntax_fragments.push(SyntaxFragment {
        id: SyntaxFragmentId::new(0),
        kind: SyntaxFragmentKind::Pattern,
        origin: pattern_origin,
        summary: SyntaxSummary {
            pattern: Some(PatternSummary {
                assigned_bindings: vec![BindingId::new(0)],
                ..PatternSummary::default()
            }),
            has_side_effects: true,
            may_throw: true,
            ..SyntaxSummary::default()
        },
    });
    file.functions[0].locals.push(HirLocal {
        id: LocalId::new(0),
        binding: Some(BindingId::new(0)),
        scope: ScopeId::new(0),
        kind: LocalKind::User,
        declaration_kind: DeclarationKind::Let,
        debug_name: Some("target".into()),
        origin: write_origin,
    });
    file.functions[0].values.extend([
        HirValue {
            id: ValueId::new(0),
            kind: ValueKind::Literal(LiteralValue::Undefined),
            origin: assignment_origin,
        },
        HirValue {
            id: ValueId::new(1),
            kind: ValueKind::InstructionResult,
            origin: assignment_origin,
        },
    ]);
    file.functions[0].blocks[0].instructions.extend([
        HirInstruction {
            result: Some(ValueId::new(0)),
            kind: HirInstructionKind::Literal(LiteralValue::Undefined),
            semantics: InstructionSemantics::PURE_EAGER,
            origin: assignment_origin,
        },
        HirInstruction {
            result: Some(ValueId::new(1)),
            kind: HirInstructionKind::PatternAssignment {
                value: ValueId::new(0),
                pattern: SyntaxFragmentId::new(0),
                writes: vec![HirPatternWrite {
                    local: LocalId::new(0),
                    origin: write_origin,
                }],
            },
            semantics: InstructionSemantics::CONSERVATIVE_EAGER,
            origin: assignment_origin,
        },
    ]);
    file.functions[0].blocks[0].terminator.kind = TerminatorKind::Return {
        value: Some(ValueId::new(1)),
    };

    verify_hir(&file).expect("well-formed pattern assignment");

    let mut missing_result = file.clone();
    missing_result.functions[0].blocks[0].instructions[1].result = None;
    let diagnostics = verify_hir(&missing_result).expect_err("pattern result is mandatory");
    assert!(diagnostics.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-INSTRUCTION"
            && diagnostic.message.contains("right-hand-side result")
    }));

    let mut outside_pattern = file.clone();
    let HirInstructionKind::PatternAssignment { writes, .. } =
        &mut outside_pattern.functions[0].blocks[0].instructions[1].kind
    else {
        panic!("pattern fixture")
    };
    writes[0].origin =
        Origin::source(fict_hir::SourceSpan::new(2, 3).expect("outside-pattern span"));
    let diagnostics = verify_hir(&outside_pattern).expect_err("write origin must be contained");
    assert!(diagnostics.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-INSTRUCTION"
            && diagnostic.message.contains("contained by its pattern")
    }));

    let mut missing_summary = file;
    missing_summary.syntax_fragments[0]
        .summary
        .pattern
        .as_mut()
        .expect("pattern summary")
        .assigned_bindings
        .clear();
    let diagnostics = verify_hir(&missing_summary).expect_err("write must appear in summary");
    assert!(diagnostics.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-INSTRUCTION"
            && diagnostic.message.contains("assigned-binding summary")
    }));
}

#[test]
fn verifier_enforces_interned_global_identity_and_place_references() {
    let mut file = empty_file();
    let origin = Origin::source(fict_hir::SourceSpan::empty(0));
    file.globals.push(HirGlobal {
        id: GlobalId::new(0),
        name: "hostObject".to_owned(),
        origin,
    });
    file.functions[0].values.push(HirValue {
        id: ValueId::new(0),
        kind: ValueKind::InstructionResult,
        origin,
    });
    file.functions[0].blocks[0]
        .instructions
        .push(HirInstruction {
            result: Some(ValueId::new(0)),
            kind: HirInstructionKind::Read {
                place: Place {
                    base: PlaceBase::Global(GlobalId::new(0)),
                    projections: Vec::new(),
                },
            },
            semantics: InstructionSemantics::CONSERVATIVE_EAGER,
            origin,
        });

    verify_hir(&file).expect("well-formed global place");
    let HirInstructionKind::Read { place } = &mut file.functions[0].blocks[0].instructions[0].kind
    else {
        panic!("global read fixture")
    };
    assert!(!place.is_local());
    place.base = PlaceBase::Global(GlobalId::new(9));
    let invalid_reference = verify_hir(&file).expect_err("invalid global reference must fail");
    assert!(invalid_reference.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-REF" && diagnostic.message.contains("global9")
    }));

    let HirInstructionKind::Read { place } = &mut file.functions[0].blocks[0].instructions[0].kind
    else {
        panic!("global read fixture")
    };
    place.base = PlaceBase::Global(GlobalId::new(0));
    file.functions[0].blocks[0].instructions[0].semantics = InstructionSemantics::PURE_EAGER;
    let unsafe_semantics =
        verify_hir(&file).expect_err("pure unresolved global read must fail verification");
    assert!(unsafe_semantics.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-READ"
            && diagnostic.message.contains("conservative host semantics")
    }));

    let mut duplicate = empty_file();
    duplicate.globals.extend([
        HirGlobal {
            id: GlobalId::new(0),
            name: "hostObject".to_owned(),
            origin,
        },
        HirGlobal {
            id: GlobalId::new(1),
            name: "hostObject".to_owned(),
            origin,
        },
    ]);
    let duplicate_name = verify_hir(&duplicate).expect_err("duplicate global name must fail");
    assert!(duplicate_name.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-GLOBAL"
            && diagnostic.message.contains("interned more than once")
    }));

    duplicate.globals[1].name.clear();
    duplicate.globals[1].id = GlobalId::new(7);
    let invalid_arena = verify_hir(&duplicate).expect_err("invalid global arena must fail");
    assert!(
        invalid_arena
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-HIR-ID")
    );
    assert!(
        invalid_arena
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-HIR-GLOBAL")
    );
}

#[test]
fn verifier_requires_method_calls_to_retain_the_exact_callee_read_reference() {
    let mut file = empty_file();
    let origin = Origin::source(fict_hir::SourceSpan::empty(0));
    let method = Place {
        base: PlaceBase::Global(GlobalId::new(0)),
        projections: vec![Projection::StaticProperty {
            name: "method".to_owned(),
            optional: false,
        }],
    };
    file.globals.push(HirGlobal {
        id: GlobalId::new(0),
        name: "hostObject".to_owned(),
        origin,
    });
    file.functions[0].values.extend([
        HirValue {
            id: ValueId::new(0),
            kind: ValueKind::InstructionResult,
            origin,
        },
        HirValue {
            id: ValueId::new(1),
            kind: ValueKind::InstructionResult,
            origin,
        },
    ]);
    file.functions[0].blocks[0].instructions.extend([
        HirInstruction {
            result: Some(ValueId::new(0)),
            kind: HirInstructionKind::Read {
                place: method.clone(),
            },
            semantics: InstructionSemantics::CONSERVATIVE_EAGER,
            origin,
        },
        HirInstruction {
            result: Some(ValueId::new(1)),
            kind: HirInstructionKind::Call(CallInstruction {
                callee: ValueId::new(0),
                callee_reference: Some(method.clone()),
                state_receiver_kind: fict_hir::StateReceiverKind::Unknown,
                arguments: Vec::new(),
                host: CallHost::Unknown,
                macro_kind: None,
                reactive_kind: None,
                optional: false,
            }),
            semantics: InstructionSemantics::CONSERVATIVE_EAGER,
            origin,
        },
    ]);

    verify_hir(&file).expect("well-formed method-call reference");

    let HirInstructionKind::Call(call) = &mut file.functions[0].blocks[0].instructions[1].kind
    else {
        panic!("method-call fixture")
    };
    call.callee_reference = Some(Place {
        base: PlaceBase::Global(GlobalId::new(0)),
        projections: vec![Projection::StaticProperty {
            name: "other".to_owned(),
            optional: false,
        }],
    });
    let mismatched = verify_hir(&file).expect_err("mismatched method reference must fail");
    assert!(mismatched.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-CALL-REFERENCE"
            && diagnostic.message.contains("match the read")
    }));

    let HirInstructionKind::Call(call) = &mut file.functions[0].blocks[0].instructions[1].kind
    else {
        panic!("method-call fixture")
    };
    call.callee_reference = Some(Place {
        base: PlaceBase::Global(GlobalId::new(0)),
        projections: Vec::new(),
    });
    let unprojected = verify_hir(&file).expect_err("unprojected method reference must fail");
    assert!(unprojected.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-CALL-REFERENCE"
            && diagnostic.message.contains("property projection")
    }));
}

#[test]
fn verifier_rejects_a_value_definition_that_changes_literal_bits() {
    let mut file = empty_file();
    let origin = Origin::source(fict_hir::SourceSpan::empty(0));
    file.functions[0].values.push(HirValue {
        id: ValueId::new(0),
        kind: ValueKind::Literal(LiteralValue::Number(NumberLiteral::from_f64(-0.0))),
        origin,
    });
    file.functions[0].blocks[0]
        .instructions
        .push(HirInstruction {
            result: Some(ValueId::new(0)),
            kind: HirInstructionKind::Literal(LiteralValue::Number(NumberLiteral::from_f64(0.0))),
            semantics: InstructionSemantics::PURE_EAGER,
            origin,
        });

    let diagnostics = verify_hir(&file).expect_err("literal mismatch must fail");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-HIR-VALUE")
    );
}

#[test]
fn verifier_requires_an_identifier_for_unresolved_typeof() {
    let mut file = empty_file();
    let origin = Origin::source(fict_hir::SourceSpan::empty(0));
    file.functions[0].values.push(HirValue {
        id: ValueId::new(0),
        kind: ValueKind::InstructionResult,
        origin,
    });
    file.functions[0].blocks[0]
        .instructions
        .push(HirInstruction {
            result: Some(ValueId::new(0)),
            kind: HirInstructionKind::UnresolvedTypeof {
                identifier: "ambientValue".to_owned(),
            },
            semantics: InstructionSemantics::CONSERVATIVE_EAGER,
            origin,
        });

    verify_hir(&file).expect("well-formed unresolved typeof HIR");
    let HirInstructionKind::UnresolvedTypeof { identifier } =
        &mut file.functions[0].blocks[0].instructions[0].kind
    else {
        panic!("unresolved typeof fixture")
    };
    identifier.clear();
    let diagnostics = verify_hir(&file).expect_err("empty typeof identifier must fail");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-HIR-TYPEOF")
    );
}

#[test]
fn verifier_enforces_delete_target_references_and_mutation_semantics() {
    let mut file = empty_file();
    let origin = Origin::source(fict_hir::SourceSpan::empty(0));
    file.functions[0].values.extend([
        HirValue {
            id: ValueId::new(0),
            kind: ValueKind::Literal(LiteralValue::Number(NumberLiteral::from_f64(1.0))),
            origin,
        },
        HirValue {
            id: ValueId::new(1),
            kind: ValueKind::InstructionResult,
            origin,
        },
    ]);
    file.functions[0].blocks[0].instructions.extend([
        HirInstruction {
            result: Some(ValueId::new(0)),
            kind: HirInstructionKind::Literal(LiteralValue::Number(NumberLiteral::from_f64(1.0))),
            semantics: InstructionSemantics::PURE_EAGER,
            origin,
        },
        HirInstruction {
            result: Some(ValueId::new(1)),
            kind: HirInstructionKind::Delete {
                target: DeleteTarget::Value(ValueId::new(0)),
            },
            semantics: InstructionSemantics::PURE_EAGER,
            origin,
        },
    ]);

    verify_hir(&file).expect("well-formed value deletion");
    let HirInstructionKind::Delete { target } =
        &mut file.functions[0].blocks[0].instructions[1].kind
    else {
        panic!("delete fixture")
    };
    *target = DeleteTarget::Value(ValueId::new(99));
    let invalid_value = verify_hir(&file).expect_err("invalid delete value must fail");
    assert!(invalid_value.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-REF" && diagnostic.message.contains("value99")
    }));

    let HirInstructionKind::Delete { target } =
        &mut file.functions[0].blocks[0].instructions[1].kind
    else {
        panic!("delete fixture")
    };
    *target = DeleteTarget::UnresolvedIdentifier(String::new());
    file.functions[0].blocks[0].instructions[1].semantics =
        InstructionSemantics::CONSERVATIVE_EAGER;
    let empty_identifier = verify_hir(&file).expect_err("empty delete identifier must fail");
    assert!(empty_identifier.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-DELETE"
            && diagnostic.message.contains("non-empty identifier")
    }));

    let HirInstructionKind::Delete { target } =
        &mut file.functions[0].blocks[0].instructions[1].kind
    else {
        panic!("delete fixture")
    };
    *target = DeleteTarget::Place(Place {
        base: PlaceBase::Value(ValueId::new(0)),
        projections: vec![Projection::StaticProperty {
            name: "field".to_owned(),
            optional: false,
        }],
    });
    file.functions[0].blocks[0].instructions[1].semantics = InstructionSemantics::PURE_EAGER;
    let missing_mutation = verify_hir(&file).expect_err("pure property delete must fail");
    assert!(missing_mutation.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-DELETE"
            && diagnostic.message.contains("observable mutation")
    }));

    let HirInstructionKind::Delete { target } =
        &mut file.functions[0].blocks[0].instructions[1].kind
    else {
        panic!("delete fixture")
    };
    *target = DeleteTarget::Place(Place {
        base: PlaceBase::Value(ValueId::new(0)),
        projections: Vec::new(),
    });
    file.functions[0].blocks[0].instructions[1].semantics = InstructionSemantics::PURE_EAGER;
    let invalid_place = verify_hir(&file).expect_err("unprojected value place must fail");
    assert!(invalid_place.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-DELETE"
            && diagnostic.message.contains("must use a value target")
    }));

    file.globals.push(HirGlobal {
        id: GlobalId::new(0),
        name: "ambientTarget".to_owned(),
        origin,
    });
    let HirInstructionKind::Delete { target } =
        &mut file.functions[0].blocks[0].instructions[1].kind
    else {
        panic!("delete fixture")
    };
    *target = DeleteTarget::Place(Place {
        base: PlaceBase::Global(GlobalId::new(0)),
        projections: Vec::new(),
    });
    let invalid_global = verify_hir(&file).expect_err("unprojected global delete must fail");
    assert!(invalid_global.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-DELETE"
            && diagnostic.message.contains("unresolved-identifier target")
    }));
}

#[test]
fn verifier_checks_every_typed_conditional_input() {
    let mut file = empty_file();
    let origin = Origin::source(fict_hir::SourceSpan::empty(0));
    let literals = [
        LiteralValue::Boolean(true),
        LiteralValue::Number(NumberLiteral::from_f64(1.0)),
        LiteralValue::Number(NumberLiteral::from_f64(2.0)),
    ];
    for (index, literal) in literals.iter().enumerate() {
        let value = ValueId::new(u32::try_from(index).expect("small fixture index"));
        file.functions[0].values.push(HirValue {
            id: value,
            kind: ValueKind::Literal(literal.clone()),
            origin,
        });
        file.functions[0].blocks[0]
            .instructions
            .push(HirInstruction {
                result: Some(value),
                kind: HirInstructionKind::Literal(literal.clone()),
                semantics: InstructionSemantics::PURE_EAGER,
                origin,
            });
    }
    file.functions[0].values.push(HirValue {
        id: ValueId::new(3),
        kind: ValueKind::InstructionResult,
        origin,
    });
    file.functions[0].blocks[0]
        .instructions
        .push(HirInstruction {
            result: Some(ValueId::new(3)),
            kind: HirInstructionKind::Conditional {
                test: ValueId::new(0),
                consequent: ValueId::new(1),
                alternate: ValueId::new(2),
            },
            semantics: InstructionSemantics::PURE_EAGER,
            origin,
        });

    verify_hir(&file).expect("well-formed conditional HIR");
    let HirInstructionKind::Conditional { alternate, .. } =
        &mut file.functions[0].blocks[0].instructions[3].kind
    else {
        panic!("conditional fixture")
    };
    *alternate = ValueId::new(99);
    let diagnostics = verify_hir(&file).expect_err("invalid conditional arm must fail");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-HIR-REF"
                && diagnostic.message.contains("value99"))
    );
}

#[test]
fn verifier_requires_a_nontrivial_sequence_and_checks_every_value() {
    let mut file = empty_file();
    let origin = Origin::source(fict_hir::SourceSpan::empty(0));
    for index in 0..2 {
        let value = ValueId::new(index);
        let literal = LiteralValue::Number(NumberLiteral::from_f64(f64::from(index)));
        file.functions[0].values.push(HirValue {
            id: value,
            kind: ValueKind::Literal(literal.clone()),
            origin,
        });
        file.functions[0].blocks[0]
            .instructions
            .push(HirInstruction {
                result: Some(value),
                kind: HirInstructionKind::Literal(literal),
                semantics: InstructionSemantics::PURE_EAGER,
                origin,
            });
    }
    file.functions[0].values.push(HirValue {
        id: ValueId::new(2),
        kind: ValueKind::InstructionResult,
        origin,
    });
    file.functions[0].blocks[0]
        .instructions
        .push(HirInstruction {
            result: Some(ValueId::new(2)),
            kind: HirInstructionKind::Sequence {
                values: vec![ValueId::new(0), ValueId::new(1)],
            },
            semantics: InstructionSemantics::PURE_EAGER,
            origin,
        });

    verify_hir(&file).expect("well-formed sequence HIR");
    let HirInstructionKind::Sequence { values } =
        &mut file.functions[0].blocks[0].instructions[2].kind
    else {
        panic!("sequence fixture")
    };
    values[1] = ValueId::new(99);
    let invalid_value = verify_hir(&file).expect_err("invalid sequence input must fail");
    assert!(invalid_value.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-REF" && diagnostic.message.contains("value99")
    }));

    let HirInstructionKind::Sequence { values } =
        &mut file.functions[0].blocks[0].instructions[2].kind
    else {
        panic!("sequence fixture")
    };
    values.truncate(1);
    let trivial = verify_hir(&file).expect_err("one-value sequence must fail");
    assert!(trivial.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-SEQUENCE"
            && diagnostic.message.contains("at least two")
    }));
}

#[test]
fn verifier_enforces_template_quasi_expression_arity() {
    let mut file = empty_file();
    let origin = Origin::source(fict_hir::SourceSpan::empty(0));
    for index in 0..2 {
        let value = ValueId::new(index);
        let literal = LiteralValue::Number(NumberLiteral::from_f64(f64::from(index)));
        file.functions[0].values.push(HirValue {
            id: value,
            kind: ValueKind::Literal(literal.clone()),
            origin,
        });
        file.functions[0].blocks[0]
            .instructions
            .push(HirInstruction {
                result: Some(value),
                kind: HirInstructionKind::Literal(literal),
                semantics: InstructionSemantics::PURE_EAGER,
                origin,
            });
    }
    file.functions[0].values.push(HirValue {
        id: ValueId::new(2),
        kind: ValueKind::InstructionResult,
        origin,
    });
    file.functions[0].blocks[0]
        .instructions
        .push(HirInstruction {
            result: Some(ValueId::new(2)),
            kind: HirInstructionKind::TemplateLiteral {
                quasis: vec!["head".into(), "middle".into(), "tail".into()],
                expressions: vec![ValueId::new(0), ValueId::new(1)],
            },
            semantics: InstructionSemantics::CONSERVATIVE_EAGER,
            origin,
        });

    verify_hir(&file).expect("well-formed template HIR");
    let HirInstructionKind::TemplateLiteral { quasis, .. } =
        &mut file.functions[0].blocks[0].instructions[2].kind
    else {
        panic!("template fixture")
    };
    quasis.pop();
    let diagnostics = verify_hir(&file).expect_err("template arity mismatch must fail");
    assert!(diagnostics.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-TEMPLATE"
            && diagnostic.message.contains("one more quasi")
    }));
}

#[test]
fn verifier_enforces_tagged_template_inputs_and_arity() {
    let mut file = empty_file();
    let origin = Origin::source(fict_hir::SourceSpan::empty(0));
    for (index, literal) in [
        LiteralValue::String("tag".into()),
        LiteralValue::Number(NumberLiteral::from_f64(1.0)),
    ]
    .into_iter()
    .enumerate()
    {
        let value = ValueId::new(index as u32);
        file.functions[0].values.push(HirValue {
            id: value,
            kind: ValueKind::Literal(literal.clone()),
            origin,
        });
        file.functions[0].blocks[0]
            .instructions
            .push(HirInstruction {
                result: Some(value),
                kind: HirInstructionKind::Literal(literal),
                semantics: InstructionSemantics::PURE_EAGER,
                origin,
            });
    }
    file.functions[0].values.push(HirValue {
        id: ValueId::new(2),
        kind: ValueKind::InstructionResult,
        origin,
    });
    file.functions[0].blocks[0]
        .instructions
        .push(HirInstruction {
            result: Some(ValueId::new(2)),
            kind: HirInstructionKind::TaggedTemplate {
                tag: ValueId::new(0),
                tag_reference: None,
                quasis: vec![
                    TaggedTemplateQuasi {
                        cooked: Some(JavaScriptString::from_code_units(vec![u16::from(b'a')])),
                        raw: "a".to_owned(),
                    },
                    TaggedTemplateQuasi {
                        cooked: None,
                        raw: r"\u{}".to_owned(),
                    },
                ],
                substitutions: vec![ValueId::new(1)],
                host: CallHost::Unknown,
            },
            semantics: InstructionSemantics::CONSERVATIVE_EAGER,
            origin,
        });

    verify_hir(&file).expect("well-formed tagged template HIR");
    let HirInstructionKind::TaggedTemplate { quasis, .. } =
        &mut file.functions[0].blocks[0].instructions[2].kind
    else {
        panic!("tagged template fixture")
    };
    quasis.pop();
    let diagnostics = verify_hir(&file).expect_err("tagged template arity mismatch must fail");
    assert!(diagnostics.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-TAGGED-TEMPLATE"
            && diagnostic.message.contains("one more quasi")
    }));

    let HirInstructionKind::TaggedTemplate { tag, quasis, .. } =
        &mut file.functions[0].blocks[0].instructions[2].kind
    else {
        panic!("tagged template fixture")
    };
    quasis.push(TaggedTemplateQuasi {
        cooked: Some(JavaScriptString::default()),
        raw: String::new(),
    });
    *tag = ValueId::new(99);
    let diagnostics = verify_hir(&file).expect_err("invalid tagged template tag must fail");
    assert!(diagnostics.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-REF" && diagnostic.message.contains("value99")
    }));
}

#[test]
fn verifier_requires_method_tags_to_retain_the_exact_tag_read_reference() {
    let mut file = empty_file();
    let origin = Origin::source(fict_hir::SourceSpan::empty(0));
    let method = Place {
        base: PlaceBase::Global(GlobalId::new(0)),
        projections: vec![Projection::StaticProperty {
            name: "tag".to_owned(),
            optional: false,
        }],
    };
    file.globals.push(HirGlobal {
        id: GlobalId::new(0),
        name: "hostObject".to_owned(),
        origin,
    });
    file.functions[0].values.extend([
        HirValue {
            id: ValueId::new(0),
            kind: ValueKind::InstructionResult,
            origin,
        },
        HirValue {
            id: ValueId::new(1),
            kind: ValueKind::InstructionResult,
            origin,
        },
    ]);
    file.functions[0].blocks[0].instructions.extend([
        HirInstruction {
            result: Some(ValueId::new(0)),
            kind: HirInstructionKind::Read {
                place: method.clone(),
            },
            semantics: InstructionSemantics::CONSERVATIVE_EAGER,
            origin,
        },
        HirInstruction {
            result: Some(ValueId::new(1)),
            kind: HirInstructionKind::TaggedTemplate {
                tag: ValueId::new(0),
                tag_reference: Some(method),
                quasis: vec![TaggedTemplateQuasi {
                    cooked: Some(JavaScriptString::from("value")),
                    raw: "value".to_owned(),
                }],
                substitutions: Vec::new(),
                host: CallHost::Unknown,
            },
            semantics: InstructionSemantics::CONSERVATIVE_EAGER,
            origin,
        },
    ]);

    verify_hir(&file).expect("well-formed method-tag reference");

    let HirInstructionKind::TaggedTemplate { tag_reference, .. } =
        &mut file.functions[0].blocks[0].instructions[1].kind
    else {
        panic!("method-tag fixture")
    };
    *tag_reference = Some(Place {
        base: PlaceBase::Global(GlobalId::new(0)),
        projections: vec![Projection::StaticProperty {
            name: "other".to_owned(),
            optional: false,
        }],
    });
    let diagnostics = verify_hir(&file).expect_err("mismatched method-tag reference must fail");
    assert!(diagnostics.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-TAG-REFERENCE"
            && diagnostic.message.contains("match the read")
    }));
}

#[test]
fn verifier_checks_dynamic_import_specifier_and_options() {
    let mut file = empty_file();
    let origin = Origin::source(fict_hir::SourceSpan::empty(0));
    for index in 0..2 {
        let value = ValueId::new(index);
        let literal = LiteralValue::String(format!("input-{index}").into());
        file.functions[0].values.push(HirValue {
            id: value,
            kind: ValueKind::Literal(literal.clone()),
            origin,
        });
        file.functions[0].blocks[0]
            .instructions
            .push(HirInstruction {
                result: Some(value),
                kind: HirInstructionKind::Literal(literal),
                semantics: InstructionSemantics::PURE_EAGER,
                origin,
            });
    }
    file.functions[0].values.push(HirValue {
        id: ValueId::new(2),
        kind: ValueKind::InstructionResult,
        origin,
    });
    file.functions[0].blocks[0]
        .instructions
        .push(HirInstruction {
            result: Some(ValueId::new(2)),
            kind: HirInstructionKind::DynamicImport {
                specifier: ValueId::new(0),
                options: Some(ValueId::new(1)),
                phase: ImportPhase::Source,
            },
            semantics: InstructionSemantics::CONSERVATIVE_EAGER,
            origin,
        });

    verify_hir(&file).expect("well-formed dynamic import HIR");
    let HirInstructionKind::DynamicImport { options, .. } =
        &mut file.functions[0].blocks[0].instructions[2].kind
    else {
        panic!("dynamic import fixture")
    };
    *options = Some(ValueId::new(99));
    let diagnostics = verify_hir(&file).expect_err("invalid import options must fail");
    assert!(diagnostics.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-REF" && diagnostic.message.contains("value99")
    }));
}

#[test]
fn verifier_enforces_object_prototype_setter_invariants() {
    let mut file = empty_file();
    let origin = Origin::source(fict_hir::SourceSpan::empty(0));
    file.functions[0].values.extend([
        HirValue {
            id: ValueId::new(0),
            kind: ValueKind::Literal(LiteralValue::Null),
            origin,
        },
        HirValue {
            id: ValueId::new(1),
            kind: ValueKind::InstructionResult,
            origin,
        },
    ]);
    file.functions[0].blocks[0].instructions.extend([
        HirInstruction {
            result: Some(ValueId::new(0)),
            kind: HirInstructionKind::Literal(LiteralValue::Null),
            semantics: InstructionSemantics::PURE_EAGER,
            origin,
        },
        HirInstruction {
            result: Some(ValueId::new(1)),
            kind: HirInstructionKind::Object {
                entries: vec![ObjectEntry::Property {
                    key: PropertyKey::Static("__proto__".to_owned()),
                    value: ValueId::new(0),
                    kind: ObjectPropertyKind::Init,
                    shorthand: false,
                    prototype_setter: true,
                    origin,
                }],
            },
            semantics: InstructionSemantics::PURE_EAGER,
            origin,
        },
    ]);

    verify_hir(&file).expect("one well-formed prototype setter is valid");
    let HirInstructionKind::Object { entries } =
        &mut file.functions[0].blocks[0].instructions[1].kind
    else {
        panic!("object fixture")
    };
    entries.push(entries[0].clone());
    let duplicate = verify_hir(&file).expect_err("duplicate prototype setters must fail");
    assert!(duplicate.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-OBJECT"
            && diagnostic.message.contains("multiple __proto__")
    }));

    let HirInstructionKind::Object { entries } =
        &mut file.functions[0].blocks[0].instructions[1].kind
    else {
        panic!("object fixture")
    };
    entries.truncate(1);
    let ObjectEntry::Property { shorthand, .. } = &mut entries[0] else {
        panic!("property fixture")
    };
    *shorthand = true;
    let malformed = verify_hir(&file).expect_err("shorthand prototype setter must fail");
    assert!(malformed.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-OBJECT"
            && diagnostic.message.contains("non-shorthand")
    }));
}

#[test]
fn verifier_rejects_overlapping_switch_test_and_body_blocks() {
    let mut file = empty_file();
    let origin = Origin::source(fict_hir::SourceSpan::empty(0));
    file.functions[0].blocks = vec![
        HirBlock {
            id: BlockId::new(0),
            scope: ScopeId::new(0),
            instructions: Vec::new(),
            terminator: HirTerminator {
                kind: TerminatorKind::Goto {
                    target: BlockId::new(1),
                },
                origin,
            },
            source_hint: Some(StructuredSourceHint {
                kind: StructuredSourceKind::Switch,
                exit: Some(BlockId::new(2)),
                switch_cases: vec![StructuredSwitchCaseHint {
                    test: Some(BlockId::new(1)),
                    body: BlockId::new(1),
                    origin,
                }],
                origin,
            }),
            origin,
        },
        HirBlock {
            id: BlockId::new(1),
            scope: ScopeId::new(0),
            instructions: Vec::new(),
            terminator: HirTerminator {
                kind: TerminatorKind::Goto {
                    target: BlockId::new(2),
                },
                origin,
            },
            source_hint: None,
            origin,
        },
        HirBlock {
            id: BlockId::new(2),
            scope: ScopeId::new(0),
            instructions: Vec::new(),
            terminator: HirTerminator {
                kind: TerminatorKind::Return { value: None },
                origin,
            },
            source_hint: None,
            origin,
        },
    ];

    let diagnostics = verify_hir(&file).expect_err("overlapping switch blocks must fail");
    assert!(diagnostics.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-SOURCE-HINT"
            && diagnostic.message.contains("disjoint")
    }));
}

#[test]
fn verifier_rejects_overlapping_try_targets() {
    let mut file = empty_file();
    let origin = Origin::source(fict_hir::SourceSpan::empty(0));
    file.functions[0].blocks = vec![
        HirBlock {
            id: BlockId::new(0),
            scope: ScopeId::new(0),
            instructions: Vec::new(),
            terminator: HirTerminator {
                kind: TerminatorKind::Try {
                    body: BlockId::new(1),
                    catch: Some(BlockId::new(1)),
                    finally: None,
                    continuation: BlockId::new(2),
                },
                origin,
            },
            source_hint: None,
            origin,
        },
        HirBlock {
            id: BlockId::new(1),
            scope: ScopeId::new(0),
            instructions: Vec::new(),
            terminator: HirTerminator {
                kind: TerminatorKind::Goto {
                    target: BlockId::new(2),
                },
                origin,
            },
            source_hint: None,
            origin,
        },
        HirBlock {
            id: BlockId::new(2),
            scope: ScopeId::new(0),
            instructions: Vec::new(),
            terminator: HirTerminator {
                kind: TerminatorKind::Return { value: None },
                origin,
            },
            source_hint: None,
            origin,
        },
    ];

    let diagnostics = verify_hir(&file).expect_err("overlapping try targets must fail");
    assert!(diagnostics.as_slice().iter().any(|diagnostic| {
        diagnostic.code.as_str() == "FICT-HIR-CFG"
            && diagnostic.message.contains("must be distinct")
    }));
}
