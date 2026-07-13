use fict_hir::{
    BlockId, CallHost, DeleteTarget, FileId, FunctionFlags, FunctionId, FunctionKind, GlobalId,
    HirBlock, HirFile, HirFunction, HirGlobal, HirInstruction, HirInstructionKind, HirScope,
    HirTerminator, HirValue, ImportPhase, InstructionSemantics, JavaScriptString, LiteralValue,
    NumberLiteral, ObjectEntry, ObjectPropertyKind, Origin, Place, PlaceBase, Projection,
    PropertyKey, ScopeId, ScopeKind, StructuredSourceHint, StructuredSourceKind,
    StructuredSwitchCaseHint, TaggedTemplateQuasi, TerminatorKind, ValueId, ValueKind, print_hir,
    verify_hir,
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
        functions: vec![HirFunction {
            id: FunctionId::new(0),
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
            "function fn0 kind=Module binding=- scope=scope0 async=false generator=false ",
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
