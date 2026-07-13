use fict_emit::{
    CleanupOwner, DomNamespace, EmitOperation, NoJsxLoweringOptions, ReactiveSlotKind,
    RuntimeFamily, RuntimeHelper, lower_core, lower_no_jsx,
};
use fict_hir::{
    Binding, BindingId, BindingKind, BlockId, CallArgument, CallHost, CallInstruction,
    DeclarationKind, FictMacroKind, FileId, FunctionFlags, FunctionId, FunctionKind, HirBlock,
    HirFile, HirFunction, HirInstruction, HirInstructionKind, HirLocal, HirScope, HirTerminator,
    HirValue, ImportBinding, ImportKind, ImportedName, InstructionSemantics, JsxAttribute,
    JsxAttributeValue, JsxChild, JsxElement, JsxElementName, JsxExpressionKind, JsxNode,
    JsxTemplate, LiteralValue, LocalId, LocalKind, MutationEffect, NumberLiteral, Origin, Place,
    ReactiveCallKind, ScopeId, ScopeKind, SourceSpan, SyntaxFragment, SyntaxFragmentId,
    SyntaxFragmentKind, SyntaxSummary, TemplateId, TerminatorKind, UpdateOperator, ValueId,
    ValueKind, verify_hir,
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
            callee_reference: None,
            arguments,
            host: CallHost::Unknown,
            macro_kind: Some(macro_kind),
            reactive_kind: None,
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
            value(7, ValueKind::InstructionResult),
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
                    result: Some(ValueId::new(7)),
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
                    value: Some(ValueId::new(7)),
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
        globals: Vec::new(),
        functions: vec![function],
        templates: Vec::new(),
        syntax_fragments: Vec::new(),
    }
}

fn analyses(hir: &HirFile) -> (Vec<RegionAnalysis>, Vec<ReactiveCycleAnalysis>) {
    let mut all_regions = Vec::with_capacity(hir.functions.len());
    let mut all_cycles = Vec::with_capacity(hir.functions.len());
    for (index, function) in hir.functions.iter().enumerate() {
        let function_id = FunctionId::new(u32::try_from(index).expect("function id fits u32"));
        let ssa = analyze_ssa(function).expect("SSA");
        let dependencies = analyze_dependencies(hir, function_id, &ssa).expect("dependencies");
        let aliases = analyze_aliases(hir, function_id, &ssa, &dependencies).expect("aliases");
        let shapes =
            analyze_shapes(hir, function_id, &ssa, &dependencies, &aliases).expect("shapes");
        let scopes = analyze_reactive_scopes(hir, function_id, &ssa, &dependencies, &shapes)
            .expect("scopes");
        let cycles = analyze_reactive_cycles(function, &scopes).expect("cycles");
        let regions =
            analyze_regions(hir, function, &ssa, &dependencies, &scopes, &cycles).expect("regions");
        all_regions.push(regions);
        all_cycles.push(cycles);
    }
    (all_regions, all_cycles)
}

fn empty_nested_function(id: u32, scope: u32) -> HirFunction {
    HirFunction {
        id: FunctionId::new(id),
        binding: None,
        scope: ScopeId::new(scope),
        kind: FunctionKind::Plain,
        flags: FunctionFlags {
            is_arrow: true,
            ..FunctionFlags::default()
        },
        parameters: Vec::new(),
        locals: Vec::new(),
        values: Vec::new(),
        blocks: vec![HirBlock {
            id: BlockId::new(0),
            scope: ScopeId::new(scope),
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
    }
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
    let write = program.functions[0]
        .operations
        .iter()
        .find(|operation| matches!(operation, EmitOperation::WriteReactive { .. }))
        .expect("reactive write operation");
    let write_target = match write {
        EmitOperation::WriteReactive {
            source_result: Some(source_result),
            target: Some(target),
            ..
        } if *source_result == ValueId::new(7) => *target,
        _ => panic!("result-bearing write must define its EmitIR temporary"),
    };
    assert!(program.functions[0].operations.iter().any(|operation| {
        matches!(
            operation,
            EmitOperation::Return {
                value: Some(fict_emit::EmitValueRef::Temporary(target)),
                ..
            } if *target == write_target
        )
    }));
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
        program
            .imports
            .iter()
            .any(|intent| intent.helper == RuntimeHelper::UseContext)
    );
    let context = program.functions[0]
        .context
        .as_ref()
        .expect("component hook context");
    assert_eq!(context.helper, RuntimeHelper::UseContext);
    assert_eq!(context.local, "__fictCtx");
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
    hir.source_len = 100;
    hir.functions[0].locals.clear();
    hir.functions[0].values = vec![
        value(
            0,
            ValueKind::Literal(LiteralValue::String("dynamic".into())),
        ),
        value(1, ValueKind::InstructionResult),
    ];
    let binding_origin = Origin::source(SourceSpan::new(10, 17).expect("binding span"));
    hir.functions[0].values[0].origin = binding_origin;
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
                JsxAttribute::Spread {
                    value: ValueId::new(0),
                    getter: false,
                    origin: origin(),
                },
                JsxAttribute::Named {
                    name: "data-after".into(),
                    value: JsxAttributeValue::Text("after".into()),
                    origin: origin(),
                },
                JsxAttribute::Named {
                    name: "data-value".into(),
                    value: JsxAttributeValue::Expression {
                        value: ValueId::new(0),
                        function_like: false,
                        contains_fragment: false,
                    },
                    origin: origin(),
                },
                JsxAttribute::Named {
                    name: "onClick".into(),
                    value: JsxAttributeValue::Expression {
                        value: ValueId::new(0),
                        function_like: false,
                        contains_fragment: false,
                    },
                    origin: origin(),
                },
                JsxAttribute::Named {
                    name: "ref".into(),
                    value: JsxAttributeValue::Expression {
                        value: ValueId::new(0),
                        function_like: false,
                        contains_fragment: false,
                    },
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
                        kind: JsxExpressionKind::Value,
                        contains_fragment: false,
                        function_like: false,
                        list: None,
                        origin: origin(),
                    }],
                    origin: origin(),
                }))),
            ],
            origin: origin(),
        }),
        contains_fragment: false,
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
    assert!(!declare.0.contains("data-after"));
    assert!(declare.0.contains("&lt;hello&gt;"));
    assert!(program.functions[0].operations.iter().any(|operation| {
        matches!(operation, EmitOperation::CloneTemplate { source_result, .. } if *source_result == ValueId::new(1))
    }));
    let spread_index = program.functions[0]
        .operations
        .iter()
        .position(|operation| {
            matches!(
                operation,
                EmitOperation::ApplyProps {
                    operation: fict_emit::PropsOperation::Spread {
                        skip_children: true,
                        ..
                    },
                    ..
                }
            )
        })
        .expect("ordered spread binding");
    let trailing_static_index = program.functions[0]
        .operations
        .iter()
        .position(|operation| {
            matches!(
                operation,
                EmitOperation::BindDom {
                    kind: fict_emit::DomBindingKind::Attribute(name),
                    reactive: false,
                    ..
                } if name == "data-after"
            )
        })
        .expect("trailing static binding");
    assert!(spread_index < trailing_static_index);
    assert!(program.functions[0].operations.iter().any(|operation| {
        matches!(
            operation,
            EmitOperation::BindDom { origin, .. } if *origin == binding_origin
        )
    }));
    assert!(program.functions[0].operations.iter().any(|operation| {
        matches!(operation, EmitOperation::ResolveElement { path, .. } if path == &[1])
    }));
    assert!(program.functions[0].operations.iter().any(|operation| {
        matches!(operation, EmitOperation::ResolveElement { path, .. } if path == &[1, 0])
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
                before: Some(_),
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
                helper: RuntimeHelper::AddEventListener,
                cleanup_helper: None,
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

    let vnode = lower_core(
        &hir,
        &regions,
        &cycles,
        NoJsxLoweringOptions {
            fine_grained_dom: false,
            ..NoJsxLoweringOptions::default()
        },
    )
    .expect("VNode JSX fallback");
    assert!(vnode.functions[0].operations.iter().any(|operation| {
        matches!(
            operation,
            EmitOperation::CreateVNode {
                template,
                source_result,
                fragment_helper: None,
                ..
            } if *template == TemplateId::new(0) && *source_result == ValueId::new(1)
        )
    }));
    assert!(
        !vnode
            .imports
            .iter()
            .any(|intent| intent.helper == RuntimeHelper::Fragment)
    );
    assert!(
        !vnode.functions[0]
            .operations
            .iter()
            .any(|operation| { matches!(operation, EmitOperation::DeclareTemplate { .. }) })
    );

    let diagnostics = lower_no_jsx(&hir, &regions, &cycles, NoJsxLoweringOptions::default())
        .expect_err("no-JSX phase rejects JSX");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-EMIT-JSX-STAGE")
    );

    let JsxNode::Element(root) = &mut hir.templates[0].root else {
        unreachable!()
    };
    root.children
        .push(JsxChild::Node(Box::new(JsxNode::Fragment {
            children: vec![JsxChild::Text {
                value: "fragment".into(),
                origin: origin(),
            }],
            origin: origin(),
        })));
    hir.templates[0].contains_fragment = true;
    verify_hir(&hir).expect("valid nested fragment fixture");
    let fragment_vnode = lower_core(
        &hir,
        &regions,
        &cycles,
        NoJsxLoweringOptions {
            fine_grained_dom: false,
            ..NoJsxLoweringOptions::default()
        },
    )
    .expect("fragment VNode JSX fallback");
    assert!(
        fragment_vnode.functions[0]
            .operations
            .iter()
            .any(|operation| {
                matches!(
                    operation,
                    EmitOperation::CreateVNode {
                        fragment_helper: Some(RuntimeHelper::Fragment),
                        ..
                    }
                )
            })
    );
    assert!(
        fragment_vnode
            .imports
            .iter()
            .any(|intent| intent.helper == RuntimeHelper::Fragment)
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
                    getter: false,
                    origin: origin(),
                },
                JsxAttribute::Named {
                    name: "value".into(),
                    value: JsxAttributeValue::Expression {
                        value: ValueId::new(0),
                        function_like: false,
                        contains_fragment: false,
                    },
                    origin: origin(),
                },
            ],
            children: vec![JsxChild::Text {
                value: "child".into(),
                origin: origin(),
            }],
            origin: origin(),
        }),
        contains_fragment: false,
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
    assert!(matches!(
        props[1],
        fict_emit::ComponentProp::Spread { getter: false, .. }
    ));
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

#[test]
fn lowers_only_binding_aware_runtime_keyed_list_calls() {
    let mut hir = fixture(FunctionKind::Module);
    hir.scopes.extend([1, 2].map(|id| HirScope {
        id: ScopeId::new(id),
        parent: Some(ScopeId::new(0)),
        kind: ScopeKind::Function,
        origin: origin(),
    }));
    hir.bindings = vec![Binding {
        id: BindingId::new(0),
        scope: ScopeId::new(0),
        kind: BindingKind::Import,
        display_name: "list".into(),
        import: Some(ImportBinding {
            source: "fict/internal/list".into(),
            imported: ImportedName::Named("createKeyedList".into()),
            kind: ImportKind::Value,
        }),
        origin: origin(),
    }];
    hir.functions[0].locals.clear();
    hir.functions[0].values = vec![
        value(0, ValueKind::Literal(LiteralValue::Undefined)),
        value(
            1,
            ValueKind::Literal(LiteralValue::Number(NumberLiteral::from_f64(1.0))),
        ),
        value(2, ValueKind::Function(FunctionId::new(1))),
        value(3, ValueKind::Function(FunctionId::new(2))),
        value(4, ValueKind::InstructionResult),
    ];
    hir.functions[0].blocks[0].instructions = vec![
        instruction(
            Some(0),
            HirInstructionKind::Literal(LiteralValue::Undefined),
        ),
        instruction(
            Some(1),
            HirInstructionKind::Literal(LiteralValue::Number(NumberLiteral::from_f64(1.0))),
        ),
        instruction(
            Some(2),
            HirInstructionKind::Function {
                function: FunctionId::new(1),
            },
        ),
        instruction(
            Some(3),
            HirInstructionKind::Function {
                function: FunctionId::new(2),
            },
        ),
        HirInstruction {
            result: Some(ValueId::new(4)),
            kind: HirInstructionKind::Call(CallInstruction {
                callee: ValueId::new(0),
                callee_reference: None,
                arguments: vec![
                    CallArgument {
                        value: ValueId::new(1),
                        spread: false,
                    },
                    CallArgument {
                        value: ValueId::new(2),
                        spread: false,
                    },
                    CallArgument {
                        value: ValueId::new(3),
                        spread: false,
                    },
                ],
                host: CallHost::Binding(BindingId::new(0)),
                macro_kind: None,
                reactive_kind: None,
                optional: false,
            }),
            semantics: InstructionSemantics::CONSERVATIVE_EAGER,
            origin: origin(),
        },
    ];
    hir.functions[0].blocks[0].terminator.kind = TerminatorKind::Return {
        value: Some(ValueId::new(4)),
    };
    hir.functions.push(empty_nested_function(1, 1));
    hir.functions.push(empty_nested_function(2, 2));
    verify_hir(&hir).expect("valid keyed-list fixture");

    let (regions, cycles) = analyses(&hir);
    let program = lower_core(&hir, &regions, &cycles, NoJsxLoweringOptions::default())
        .expect("keyed-list lowering");
    assert!(
        program
            .imports
            .iter()
            .any(|intent| intent.helper == RuntimeHelper::KeyedList)
    );
    assert!(program.functions[0].operations.iter().any(|operation| {
        matches!(
            operation,
            EmitOperation::KeyedList {
                source_result,
                key: Some(key),
                render,
                ..
            } if *source_result == ValueId::new(4)
                && *key == FunctionId::new(1)
                && *render == FunctionId::new(2)
        )
    }));

    hir.bindings[0].import.as_mut().expect("import").source = "third-party/list".into();
    let (regions, cycles) = analyses(&hir);
    let spoofed = lower_core(&hir, &regions, &cycles, NoJsxLoweringOptions::default())
        .expect("same-named third-party helper remains ordinary HIR");
    assert!(
        !spoofed
            .imports
            .iter()
            .any(|intent| intent.helper == RuntimeHelper::KeyedList)
    );
    assert!(
        spoofed.functions[0]
            .operations
            .iter()
            .any(|operation| matches!(operation, EmitOperation::PreserveHir { .. }))
    );
}

#[test]
fn tracks_preserved_store_resource_and_selector_calls() {
    let mut hir = fixture(FunctionKind::Module);
    hir.bindings = [
        ("$store", "fict", ReactiveCallKind::Store),
        ("resource", "fict/plus", ReactiveCallKind::Resource),
        (
            "createSelector",
            "@fictjs/runtime/advanced",
            ReactiveCallKind::Selector,
        ),
    ]
    .into_iter()
    .enumerate()
    .map(|(index, (name, source, _))| Binding {
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
    .collect();
    hir.functions[0].locals = ["store", "resource", "selector"]
        .into_iter()
        .enumerate()
        .map(|(index, name)| HirLocal {
            id: LocalId::new(u32::try_from(index).expect("local id")),
            binding: None,
            scope: ScopeId::new(0),
            kind: LocalKind::User,
            declaration_kind: DeclarationKind::Const,
            debug_name: Some(name.into()),
            origin: origin(),
        })
        .collect();
    hir.functions[0].values = vec![
        value(0, ValueKind::Literal(LiteralValue::Undefined)),
        value(
            1,
            ValueKind::Literal(LiteralValue::Number(NumberLiteral::from_f64(1.0))),
        ),
        value(2, ValueKind::InstructionResult),
        value(3, ValueKind::InstructionResult),
        value(4, ValueKind::InstructionResult),
        value(5, ValueKind::InstructionResult),
    ];
    let runtime_call = |result: u32, binding: u32, kind: ReactiveCallKind| HirInstruction {
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
    };
    let declaration = |local: u32, initializer: u32| {
        instruction(
            None,
            HirInstructionKind::Declare {
                local: LocalId::new(local),
                declaration_kind: DeclarationKind::Const,
                initializer: Some(ValueId::new(initializer)),
            },
        )
    };
    hir.functions[0].blocks[0].instructions = vec![
        instruction(
            Some(0),
            HirInstructionKind::Literal(LiteralValue::Undefined),
        ),
        instruction(
            Some(1),
            HirInstructionKind::Literal(LiteralValue::Number(NumberLiteral::from_f64(1.0))),
        ),
        runtime_call(2, 0, ReactiveCallKind::Store),
        declaration(0, 2),
        runtime_call(3, 1, ReactiveCallKind::Resource),
        declaration(1, 3),
        runtime_call(4, 2, ReactiveCallKind::Selector),
        declaration(2, 4),
        instruction(
            Some(5),
            HirInstructionKind::Read {
                place: Place::local(LocalId::new(0)),
            },
        ),
    ];
    hir.functions[0].blocks[0].terminator.kind = TerminatorKind::Return {
        value: Some(ValueId::new(5)),
    };
    verify_hir(&hir).expect("valid runtime reactive fixture");
    let (regions, cycles) = analyses(&hir);
    let program = lower_no_jsx(&hir, &regions, &cycles, NoJsxLoweringOptions::default())
        .expect("runtime reactive tracking");
    assert_eq!(
        program.functions[0]
            .slots
            .iter()
            .map(|slot| slot.kind)
            .collect::<Vec<_>>(),
        [
            ReactiveSlotKind::Store,
            ReactiveSlotKind::Resource,
            ReactiveSlotKind::Selector,
        ]
    );
    let tracked: Vec<_> = program.functions[0]
        .operations
        .iter()
        .filter_map(|operation| match operation {
            EmitOperation::TrackRuntimeReactive { slot, cleanup, .. } => Some((*slot, *cleanup)),
            _ => None,
        })
        .collect();
    assert_eq!(tracked.len(), 3);
    assert!(
        tracked
            .iter()
            .all(|(slot, cleanup)| *cleanup == CleanupOwner::Slot(*slot))
    );
    assert!(
        !program.functions[0]
            .operations
            .iter()
            .any(|operation| matches!(operation, EmitOperation::ReadReactive { .. }))
    );
    assert!(
        !program
            .imports
            .iter()
            .any(|intent| intent.helper == RuntimeHelper::CreateSelector),
        "preserved runtime calls must not request replacement helpers"
    );
}

#[test]
fn allocates_collision_free_module_helpers_and_temporaries() {
    let mut hir = fixture(FunctionKind::Module);
    hir.functions[0].locals[0].debug_name = Some("__fict_v3".into());
    hir.bindings = ["createSignal", "createSignal_1"]
        .into_iter()
        .enumerate()
        .map(|(index, name)| Binding {
            id: BindingId::new(u32::try_from(index).expect("binding id")),
            scope: ScopeId::new(0),
            kind: BindingKind::Const,
            display_name: name.into(),
            import: None,
            origin: origin(),
        })
        .collect();
    hir.syntax_fragments = vec![SyntaxFragment {
        id: SyntaxFragmentId::new(0),
        kind: SyntaxFragmentKind::Statement,
        summary: SyntaxSummary::default(),
        origin: origin(),
    }];
    hir.functions[0].blocks[0].instructions.push(instruction(
        None,
        HirInstructionKind::SyntaxFragment {
            fragment: SyntaxFragmentId::new(0),
            inputs: Vec::new(),
        },
    ));
    verify_hir(&hir).expect("valid collision fixture");
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
    .expect("collision-free lowering");
    let signal = program
        .imports
        .iter()
        .find(|intent| intent.helper == RuntimeHelper::Signal)
        .expect("signal import");
    assert_eq!(signal.module_request, "@fictjs/runtime/internal");
    assert_eq!(signal.imported, "createSignal");
    assert_eq!(signal.local, "createSignal_2");
    assert!(
        program.functions[0]
            .temporaries
            .iter()
            .any(|temporary| { temporary.name == "__fict_v3_1" })
    );
    assert_eq!(
        program.module.source_fragment,
        Some(SyntaxFragmentId::new(0))
    );
    for reserved in [
        "createSignal",
        "createSignal_1",
        "createSignal_2",
        "__fict_v3",
        "__fict_v3_1",
        "undefined",
    ] {
        assert!(
            program
                .module
                .reserved_names
                .iter()
                .any(|name| name == reserved)
        );
    }
}
