use fict_hir::{
    BlockId, FileId, FunctionFlags, FunctionId, FunctionKind, HirBlock, HirFile, HirFunction,
    HirInstruction, HirInstructionKind, HirScope, HirTerminator, HirValue, InstructionSemantics,
    LiteralValue, NumberLiteral, ObjectEntry, ObjectPropertyKind, Origin, PropertyKey, ScopeId,
    ScopeKind, StructuredSourceHint, StructuredSourceKind, StructuredSwitchCaseHint,
    TerminatorKind, ValueId, ValueKind, print_hir, verify_hir,
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
