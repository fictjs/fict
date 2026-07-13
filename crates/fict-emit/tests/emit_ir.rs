use fict_emit::{
    DomBindingKind, DomNamespace, EmitFunction, EmitOperation, EmitProgram, EmitSlotId,
    EmitTemporary, EmitTemporaryId, EmitValueRef, ReactiveSlot, ReactiveSlotKind, RuntimeFamily,
    RuntimeHelper, RuntimeImportIntent, verify_emit_program,
};
use fict_hir::{
    BlockId, FileId, FunctionFlags, FunctionId, FunctionKind, HirBlock, HirFile, HirFunction,
    HirScope, HirTerminator, LiteralValue, Origin, ScopeId, ScopeKind, SourceSpan, TerminatorKind,
};
use fict_reactivity::RegionAnalysis;

fn origin() -> Origin {
    Origin::source(SourceSpan::empty(0))
}

fn hir() -> HirFile {
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
        functions: vec![HirFunction {
            id: FunctionId::new(0),
            binding: None,
            scope: ScopeId::new(0),
            kind: FunctionKind::Module,
            flags: FunctionFlags::default(),
            parameters: Vec::new(),
            locals: Vec::new(),
            values: vec![fict_hir::HirValue {
                id: fict_hir::ValueId::new(0),
                kind: fict_hir::ValueKind::Literal(LiteralValue::Undefined),
                origin: origin(),
            }],
            blocks: vec![HirBlock {
                id: BlockId::new(0),
                scope: ScopeId::new(0),
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
        }],
        templates: Vec::new(),
        syntax_fragments: Vec::new(),
    }
}

fn regions() -> Vec<RegionAnalysis> {
    vec![RegionAnalysis {
        regions: Vec::new(),
        regions_by_block: vec![Vec::new()],
        top_level_regions: Vec::new(),
        stats: Default::default(),
    }]
}

fn program() -> EmitProgram {
    EmitProgram {
        runtime_family: RuntimeFamily::Runtime,
        preview: false,
        strict_rejected: false,
        imports: vec![
            RuntimeImportIntent {
                helper: RuntimeHelper::Signal,
                local: "createSignal".into(),
            },
            RuntimeImportIntent {
                helper: RuntimeHelper::CreateElement,
                local: "createElement".into(),
            },
            RuntimeImportIntent {
                helper: RuntimeHelper::SetText,
                local: "setText".into(),
            },
        ],
        functions: vec![EmitFunction {
            source: FunctionId::new(0),
            slots: vec![ReactiveSlot {
                id: EmitSlotId::new(0),
                kind: ReactiveSlotKind::Signal,
                binding: None,
                control_path: Vec::new(),
                origin: origin(),
            }],
            temporaries: vec![EmitTemporary {
                id: EmitTemporaryId::new(0),
                name: "element".into(),
                origin: origin(),
            }],
            regions: Vec::new(),
            control_flow: fict_reactivity::structurize_cfg(
                &hir().functions[0],
                &fict_reactivity::analyze_cfg(&hir().functions[0]).expect("CFG"),
            )
            .expect("structured CFG"),
            operations: vec![
                EmitOperation::CreateReactive {
                    slot: EmitSlotId::new(0),
                    source_result: fict_hir::ValueId::new(0),
                    local: None,
                    initializer: Some(EmitValueRef::Literal(LiteralValue::Undefined)),
                    helper: RuntimeHelper::Signal,
                    origin: origin(),
                },
                EmitOperation::CreateElement {
                    target: EmitTemporaryId::new(0),
                    tag: EmitValueRef::Literal(LiteralValue::String("div".into())),
                    namespace: DomNamespace::Html,
                    helper: RuntimeHelper::CreateElement,
                    origin: origin(),
                },
                EmitOperation::BindDom {
                    element: EmitTemporaryId::new(0),
                    kind: DomBindingKind::Text,
                    value: EmitValueRef::Literal(LiteralValue::String("hello".into())),
                    reactive: false,
                    helper: RuntimeHelper::SetText,
                    origin: origin(),
                },
                EmitOperation::Return {
                    value: Some(EmitValueRef::Temporary(EmitTemporaryId::new(0))),
                    origin: origin(),
                },
            ],
        }],
    }
}

#[test]
fn accepts_exact_helper_intents_and_defined_temporaries() {
    verify_emit_program(&hir(), &regions(), &program()).expect("valid EmitIR");
}

#[test]
fn rejects_partial_strict_output_and_preview_helper_leaks() {
    let mut program = program();
    program.strict_rejected = true;
    program.preview = false;
    program.imports[0] = RuntimeImportIntent {
        helper: RuntimeHelper::Qrl,
        local: "__fictQrl".into(),
    };
    let EmitOperation::CreateReactive { helper, .. } = &mut program.functions[0].operations[0]
    else {
        unreachable!()
    };
    *helper = RuntimeHelper::Qrl;
    let diagnostics =
        verify_emit_program(&hir(), &regions(), &program).expect_err("invalid output");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| { diagnostic.code.as_str() == "FICT-EMIT-REJECTED" })
    );
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| { diagnostic.code.as_str() == "FICT-EMIT-PREVIEW" })
    );
}
