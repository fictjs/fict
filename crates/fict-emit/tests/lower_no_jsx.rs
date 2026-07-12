use fict_emit::{EmitOperation, NoJsxLoweringOptions, RuntimeFamily, RuntimeHelper, lower_no_jsx};
use fict_hir::{
    BlockId, CallArgument, CallHost, CallInstruction, DeclarationKind, FictMacroKind, FileId,
    FunctionFlags, FunctionId, FunctionKind, HirBlock, HirFile, HirFunction, HirInstruction,
    HirInstructionKind, HirLocal, HirScope, HirTerminator, HirValue, InstructionSemantics,
    LiteralValue, LocalId, LocalKind, MutationEffect, NumberLiteral, Origin, Place, ScopeId,
    ScopeKind, SourceSpan, TerminatorKind, UpdateOperator, ValueId, ValueKind, verify_hir,
};
use fict_reactivity::{
    ReactiveCycleAnalysis, RegionAnalysis, analyze_aliases, analyze_dependencies,
    analyze_reactive_cycles, analyze_reactive_scopes, analyze_regions, analyze_shapes, analyze_ssa,
};

fn origin() -> Origin {
    Origin::source(SourceSpan::empty(0))
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

fn fixture(kind: FunctionKind) -> HirFile {
    let number = || LiteralValue::Number(NumberLiteral::from_f64(1.0));
    let macro_call = |result, macro_kind, arguments| HirInstruction {
        result: Some(ValueId::new(result)),
        kind: HirInstructionKind::Call(CallInstruction {
            callee: ValueId::new(0),
            arguments,
            host: CallHost::Unknown,
            macro_kind: Some(macro_kind),
            optional: false,
        }),
        semantics: InstructionSemantics::CONSERVATIVE_EAGER,
        origin: origin(),
    };
    let function = HirFunction {
        id: FunctionId::new(0),
        binding: None,
        scope: ScopeId::new(0),
        kind,
        flags: FunctionFlags::default(),
        parameters: Vec::new(),
        locals: vec![HirLocal {
            id: LocalId::new(0),
            binding: None,
            scope: ScopeId::new(0),
            kind: LocalKind::User,
            declaration_kind: DeclarationKind::Let,
            debug_name: Some("count".into()),
            origin: origin(),
        }],
        values: vec![
            value(0, ValueKind::Literal(LiteralValue::Undefined)),
            value(1, ValueKind::Literal(number())),
            value(2, ValueKind::InstructionResult),
            value(3, ValueKind::InstructionResult),
            value(4, ValueKind::Literal(number())),
            value(5, ValueKind::InstructionResult),
            value(6, ValueKind::InstructionResult),
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
                macro_call(
                    2,
                    FictMacroKind::State,
                    vec![CallArgument {
                        value: ValueId::new(1),
                        spread: false,
                    }],
                ),
                instruction(
                    None,
                    HirInstructionKind::Declare {
                        local: LocalId::new(0),
                        declaration_kind: DeclarationKind::Let,
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
                HirInstruction {
                    result: None,
                    kind: HirInstructionKind::Write {
                        place: Place::local(LocalId::new(0)),
                        value: ValueId::new(4),
                    },
                    semantics: InstructionSemantics {
                        mutation: MutationEffect::Local,
                        ..InstructionSemantics::CONSERVATIVE_EAGER
                    },
                    origin: origin(),
                },
                HirInstruction {
                    result: Some(ValueId::new(5)),
                    kind: HirInstructionKind::ReadWrite {
                        place: Place::local(LocalId::new(0)),
                        compound: None,
                        value: None,
                        update: Some(UpdateOperator::Increment),
                        prefix: false,
                    },
                    semantics: InstructionSemantics {
                        mutation: MutationEffect::Local,
                        ..InstructionSemantics::CONSERVATIVE_EAGER
                    },
                    origin: origin(),
                },
                macro_call(
                    6,
                    FictMacroKind::Effect,
                    vec![CallArgument {
                        value: ValueId::new(0),
                        spread: false,
                    }],
                ),
            ],
            terminator: HirTerminator {
                kind: TerminatorKind::Return {
                    value: Some(ValueId::new(5)),
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

fn analyses(hir: &HirFile) -> (Vec<RegionAnalysis>, Vec<ReactiveCycleAnalysis>) {
    let function_id = FunctionId::new(0);
    let function = &hir.functions[0];
    let ssa = analyze_ssa(function).expect("SSA");
    let dependencies = analyze_dependencies(hir, function_id, &ssa).expect("dependencies");
    let aliases = analyze_aliases(hir, function_id, &ssa, &dependencies).expect("aliases");
    let shapes = analyze_shapes(hir, function_id, &ssa, &dependencies, &aliases).expect("shapes");
    let scopes =
        analyze_reactive_scopes(hir, function_id, &ssa, &dependencies, &shapes).expect("scopes");
    let cycles = analyze_reactive_cycles(function, &scopes).expect("cycles");
    let regions =
        analyze_regions(hir, function, &ssa, &dependencies, &scopes, &cycles).expect("regions");
    (vec![regions], vec![cycles])
}

#[test]
fn lowers_module_state_reads_writes_updates_and_effects() {
    let hir = fixture(FunctionKind::Module);
    verify_hir(&hir).expect("valid lowering fixture");
    let (regions, cycles) = analyses(&hir);
    let program = lower_no_jsx(
        &hir,
        &regions,
        &cycles,
        NoJsxLoweringOptions {
            runtime_family: RuntimeFamily::Runtime,
            ..NoJsxLoweringOptions::default()
        },
    )
    .expect("no-JSX lowering");
    assert_eq!(program.functions[0].slots.len(), 2);
    assert!(
        program
            .imports
            .iter()
            .any(|intent| intent.helper == RuntimeHelper::Signal)
    );
    assert!(
        program
            .imports
            .iter()
            .any(|intent| intent.helper == RuntimeHelper::Effect)
    );
    assert!(
        program.functions[0]
            .operations
            .iter()
            .any(|operation| matches!(operation, EmitOperation::ReadReactive { .. }))
    );
    assert!(
        program.functions[0]
            .operations
            .iter()
            .any(|operation| matches!(operation, EmitOperation::WriteReactive { .. }))
    );
    assert!(
        program.functions[0]
            .operations
            .iter()
            .any(|operation| matches!(
                operation,
                EmitOperation::UpdateReactive { prefix: false, .. }
            ))
    );
    assert!(
        program.functions[0]
            .operations
            .iter()
            .any(|operation| matches!(operation, EmitOperation::RegisterEffect { .. }))
    );
}

#[test]
fn selects_hook_context_helpers_inside_components() {
    let hir = fixture(FunctionKind::Component);
    let (regions, cycles) = analyses(&hir);
    let program = lower_no_jsx(&hir, &regions, &cycles, NoJsxLoweringOptions::default())
        .expect("component lowering");
    assert!(
        program
            .imports
            .iter()
            .any(|intent| intent.helper == RuntimeHelper::UseSignal)
    );
    assert!(
        program
            .imports
            .iter()
            .any(|intent| intent.helper == RuntimeHelper::UseEffect)
    );
    assert!(
        !program
            .imports
            .iter()
            .any(|intent| intent.helper == RuntimeHelper::Signal)
    );
}
