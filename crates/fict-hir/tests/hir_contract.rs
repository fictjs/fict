use fict_hir::{
    BlockId, FileId, FunctionFlags, FunctionId, FunctionKind, HirBlock, HirFile, HirFunction,
    HirInstruction, HirInstructionKind, HirScope, HirTerminator, HirValue, InstructionSemantics,
    LiteralValue, NumberLiteral, Origin, ScopeId, ScopeKind, TerminatorKind, ValueId, ValueKind,
    print_hir, verify_hir,
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
