use fict_emit::{
    DomNamespace, EmitOperation, NoJsxLoweringOptions, RuntimeFamily, RuntimeHelper, lower_core,
    lower_no_jsx,
};
use fict_hir::{
    Binding, BindingId, BindingKind, BlockId, CallArgument, CallHost, CallInstruction,
    DeclarationKind, FictMacroKind, FileId, FunctionFlags, FunctionId, FunctionKind, HirBlock,
    HirFile, HirFunction, HirInstruction, HirInstructionKind, HirLocal, HirScope, HirTerminator,
    HirValue, InstructionSemantics, JsxAttribute, JsxAttributeValue, JsxChild, JsxElement,
    JsxElementName, JsxNode, JsxTemplate, LiteralValue, LocalId, LocalKind, MutationEffect,
    NumberLiteral, Origin, Place, ScopeId, ScopeKind, SourceSpan, TemplateId, TerminatorKind,
    UpdateOperator, ValueId, ValueKind, verify_hir,
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

#[test]
fn lowers_intrinsic_templates_with_escaping_paths_and_static_bindings() {
    let mut hir = fixture(FunctionKind::Module);
    hir.functions[0].locals.clear();
    hir.functions[0].values = vec![
        value(
            0,
            ValueKind::Literal(LiteralValue::String("dynamic".into())),
        ),
        value(1, ValueKind::InstructionResult),
    ];
    hir.functions[0].blocks[0].instructions = vec![
        instruction(
            Some(0),
            HirInstructionKind::Literal(LiteralValue::String("dynamic".into())),
        ),
        instruction(
            Some(1),
            HirInstructionKind::Jsx {
                template: TemplateId::new(0),
            },
        ),
    ];
    hir.functions[0].blocks[0].terminator.kind = TerminatorKind::Return {
        value: Some(ValueId::new(1)),
    };
    hir.templates = vec![JsxTemplate {
        id: TemplateId::new(0),
        owner: FunctionId::new(0),
        root: JsxNode::Element(JsxElement {
            name: JsxElementName::Intrinsic("div".into()),
            attributes: vec![
                JsxAttribute::Named {
                    name: "title".into(),
                    value: JsxAttributeValue::Text("<&\"".into()),
                    origin: origin(),
                },
                JsxAttribute::Named {
                    name: "data-value".into(),
                    value: JsxAttributeValue::Expression(ValueId::new(0)),
                    origin: origin(),
                },
                JsxAttribute::Named {
                    name: "onClick".into(),
                    value: JsxAttributeValue::Expression(ValueId::new(0)),
                    origin: origin(),
                },
                JsxAttribute::Named {
                    name: "ref".into(),
                    value: JsxAttributeValue::Expression(ValueId::new(0)),
                    origin: origin(),
                },
            ],
            children: vec![
                JsxChild::Text {
                    value: "<hello>".into(),
                    origin: origin(),
                },
                JsxChild::Node(Box::new(JsxNode::Element(JsxElement {
                    name: JsxElementName::Intrinsic("span".into()),
                    attributes: Vec::new(),
                    children: vec![JsxChild::Expression {
                        value: ValueId::new(0),
                        origin: origin(),
                    }],
                    origin: origin(),
                }))),
            ],
            origin: origin(),
        }),
        origin: origin(),
    }];
    verify_hir(&hir).expect("valid JSX fixture");
    let (regions, cycles) = analyses(&hir);
    let program = lower_core(&hir, &regions, &cycles, NoJsxLoweringOptions::default())
        .expect("intrinsic JSX lowering");
    let declare = program.functions[0]
        .operations
        .iter()
        .find_map(|operation| match operation {
            EmitOperation::DeclareTemplate {
                html, namespace, ..
            } => Some((html, namespace)),
            _ => None,
        })
        .expect("template declaration");
    assert_eq!(*declare.1, DomNamespace::Html);
    assert!(declare.0.contains("title=\"&lt;&amp;&quot;\""));
    assert!(declare.0.contains("&lt;hello&gt;"));
    assert!(program.functions[0].operations.iter().any(|operation| {
        matches!(operation, EmitOperation::CloneTemplate { source_result, .. } if *source_result == ValueId::new(1))
    }));
    assert!(program.functions[0].operations.iter().any(|operation| {
        matches!(operation, EmitOperation::ResolveElement { path, .. } if path == &[1])
    }));
    assert!(program.functions[0].operations.iter().any(|operation| {
        matches!(
            operation,
            EmitOperation::BindDom {
                helper: RuntimeHelper::SetAttr,
                ..
            }
        )
    }));
    assert!(program.functions[0].operations.iter().any(|operation| {
        matches!(
            operation,
            EmitOperation::Insert {
                helper: RuntimeHelper::Insert,
                ..
            }
        )
    }));
    assert!(program.functions[0].operations.iter().any(|operation| {
        matches!(
            operation,
            EmitOperation::BindEvent {
                event,
                delegated: true,
                helper: RuntimeHelper::DelegateEvents,
                ..
            } if event == "click"
        )
    }));
    assert!(program.functions[0].operations.iter().any(|operation| {
        matches!(
            operation,
            EmitOperation::BindRef {
                helper: RuntimeHelper::BindRef,
                cleanup: fict_emit::CleanupOwner::Function,
                ..
            }
        )
    }));
    assert!(!declare.0.contains("onClick"));
    assert!(!declare.0.contains(" ref"));

    let diagnostics = lower_no_jsx(&hir, &regions, &cycles, NoJsxLoweringOptions::default())
        .expect_err("no-JSX phase rejects JSX");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-EMIT-JSX-STAGE")
    );
}

#[test]
fn lowers_binding_aware_component_props_spreads_and_children_in_source_order() {
    let mut hir = fixture(FunctionKind::Module);
    hir.functions[0].locals.clear();
    hir.functions[0].values = vec![
        value(0, ValueKind::Literal(LiteralValue::String("value".into()))),
        value(1, ValueKind::InstructionResult),
    ];
    hir.functions[0].blocks[0].instructions = vec![
        instruction(
            Some(0),
            HirInstructionKind::Literal(LiteralValue::String("value".into())),
        ),
        instruction(
            Some(1),
            HirInstructionKind::Jsx {
                template: TemplateId::new(0),
            },
        ),
    ];
    hir.functions[0].blocks[0].terminator.kind = TerminatorKind::Return {
        value: Some(ValueId::new(1)),
    };
    hir.bindings = vec![Binding {
        id: BindingId::new(0),
        scope: ScopeId::new(0),
        kind: BindingKind::Function,
        display_name: "Card".into(),
        import: None,
        origin: origin(),
    }];
    hir.templates = vec![JsxTemplate {
        id: TemplateId::new(0),
        owner: FunctionId::new(0),
        root: JsxNode::Element(JsxElement {
            name: JsxElementName::Component(BindingId::new(0)),
            attributes: vec![
                JsxAttribute::Named {
                    name: "title".into(),
                    value: JsxAttributeValue::Text("hello".into()),
                    origin: origin(),
                },
                JsxAttribute::Spread {
                    value: ValueId::new(0),
                    origin: origin(),
                },
                JsxAttribute::Named {
                    name: "value".into(),
                    value: JsxAttributeValue::Expression(ValueId::new(0)),
                    origin: origin(),
                },
            ],
            children: vec![JsxChild::Text {
                value: "child".into(),
                origin: origin(),
            }],
            origin: origin(),
        }),
        origin: origin(),
    }];
    verify_hir(&hir).expect("valid component JSX fixture");
    let (regions, cycles) = analyses(&hir);
    let program = lower_core(&hir, &regions, &cycles, NoJsxLoweringOptions::default())
        .expect("component JSX lowering");
    let operation = program.functions[0]
        .operations
        .iter()
        .find(|operation| matches!(operation, EmitOperation::InvokeComponent { .. }))
        .expect("component invocation");
    let EmitOperation::InvokeComponent {
        component,
        props,
        children,
        ..
    } = operation
    else {
        unreachable!()
    };
    assert!(matches!(
        component,
        fict_emit::ComponentTarget::Binding(binding) if *binding == BindingId::new(0)
    ));
    assert_eq!(props.len(), 3);
    assert!(matches!(props[1], fict_emit::ComponentProp::Spread(_)));
    assert_eq!(children.len(), 1);
}

#[test]
fn carries_structured_conditional_plan_into_emit_function() {
    let mut hir = fixture(FunctionKind::Module);
    hir.functions[0].blocks[0].terminator.kind = TerminatorKind::Branch {
        test: ValueId::new(3),
        consequent: BlockId::new(1),
        alternate: BlockId::new(2),
    };
    for id in [1, 2] {
        hir.functions[0].blocks.push(HirBlock {
            id: BlockId::new(id),
            scope: ScopeId::new(0),
            instructions: Vec::new(),
            terminator: HirTerminator {
                kind: TerminatorKind::Return {
                    value: Some(ValueId::new(3)),
                },
                origin: origin(),
            },
            source_hint: None,
            origin: origin(),
        });
    }
    verify_hir(&hir).expect("valid conditional fixture");
    let (regions, cycles) = analyses(&hir);
    let program = lower_core(&hir, &regions, &cycles, NoJsxLoweringOptions::default())
        .expect("conditional lowering");
    assert!(
        program.functions[0]
            .control_flow
            .constructs
            .iter()
            .any(|construct| matches!(
                construct.kind,
                fict_reactivity::StructuredConstructKind::Conditional { .. }
            ))
    );
    assert!(program.functions[0].control_flow.fallback.is_none());
}
