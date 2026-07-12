use fict_hir::{
    BinaryOperator, BlockId, DeclarationKind, FileId, FunctionFlags, FunctionId, FunctionKind,
    HirBlock, HirFile, HirFunction, HirInstruction, HirInstructionKind, HirLocal, HirScope,
    HirTerminator, HirValue, InstructionSemantics, LiteralValue, LocalId, LocalKind, NumberLiteral,
    Origin, Place, ScopeId, ScopeKind, SourceSpan, TerminatorKind, UnaryOperator, ValueId,
    ValueKind, verify_hir,
};
use fict_reactivity::{
    ConstantPropagationOptions, analyze_constants, analyze_ssa, apply_constant_folding,
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
