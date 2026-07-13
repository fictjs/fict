use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_hir::{
    FictMacroKind, FunctionId, FunctionKind, HirFile, HirInstructionKind, JsxAttribute,
    JsxAttributeValue, JsxChild, JsxElementName, JsxNode, LocalId, PlaceBase, TemplateId,
    TerminatorKind, ValueId, ValueKind,
};
use fict_reactivity::{ReactiveCycleAnalysis, RegionAnalysis, analyze_cfg, structurize_cfg};

use crate::{
    CleanupOwner, ComponentProp, ComponentTarget, DELEGATED_EVENTS, DomBindingKind, DomNamespace,
    EmitFunction, EmitOperation, EmitProgram, EmitSlotId, EmitTemporary, EmitTemporaryId,
    EmitValueRef, PropsOperation, ReactiveSlot, ReactiveSlotKind, RuntimeFamily, RuntimeHelper,
    RuntimeImportIntent, verify_emit_program,
};

/// Phase-1 Core lowering configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoJsxLoweringOptions {
    /// Runtime package/import family.
    pub runtime_family: RuntimeFamily,
    /// Reject derived SCCs instead of emitting best-effort non-memo regions.
    pub strict_guarantee: bool,
    /// Allow Preview ABI helpers (none are emitted by this phase).
    pub preview: bool,
}

impl Default for NoJsxLoweringOptions {
    fn default() -> Self {
        Self {
            runtime_family: RuntimeFamily::Fict,
            strict_guarantee: true,
            preview: false,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct MacroSite {
    result: ValueId,
    local: Option<LocalId>,
    kind: FictMacroKind,
    slot: EmitSlotId,
}

/// Lower state/memo/effect and reactive reads/writes while preserving ordinary HIR.
pub fn lower_no_jsx(
    hir: &HirFile,
    regions: &[RegionAnalysis],
    cycles: &[ReactiveCycleAnalysis],
    options: NoJsxLoweringOptions,
) -> Result<EmitProgram, DiagnosticBundle> {
    lower_program(hir, regions, cycles, options, false)
}

/// Lower Core intrinsic JSX in addition to no-JSX reactivity.
pub fn lower_core(
    hir: &HirFile,
    regions: &[RegionAnalysis],
    cycles: &[ReactiveCycleAnalysis],
    options: NoJsxLoweringOptions,
) -> Result<EmitProgram, DiagnosticBundle> {
    lower_program(hir, regions, cycles, options, true)
}

fn lower_program(
    hir: &HirFile,
    regions: &[RegionAnalysis],
    cycles: &[ReactiveCycleAnalysis],
    options: NoJsxLoweringOptions,
    allow_jsx: bool,
) -> Result<EmitProgram, DiagnosticBundle> {
    if regions.len() != hir.functions.len() || cycles.len() != hir.functions.len() {
        return Err(DiagnosticBundle::new(vec![lower_error(
            "FICT-EMIT-ANALYSIS",
            "no-JSX lowering requires final region and cycle analysis for every function",
            GuaranteeClass::Internal,
        )]));
    }
    if options.strict_guarantee
        && let Some(cycle) = cycles.iter().flat_map(|analysis| &analysis.cycles).next()
    {
        return Err(DiagnosticBundle::new(vec![lower_error(
            "FICT-R-CYCLE",
            format!(
                "detected cyclic derived dependency across {} binding(s)",
                cycle.nodes.len()
            ),
            GuaranteeClass::Fallback,
        )]));
    }
    let mut functions = Vec::with_capacity(hir.functions.len());
    for (function_index, function) in hir.functions.iter().enumerate() {
        if !allow_jsx
            && let Some(instruction) = function
                .blocks
                .iter()
                .flat_map(|block| &block.instructions)
                .find(|instruction| matches!(instruction.kind, HirInstructionKind::Jsx { .. }))
        {
            let mut diagnostic = lower_error(
                "FICT-EMIT-JSX-STAGE",
                "JSX reached the no-JSX lowering phase",
                GuaranteeClass::Internal,
            );
            diagnostic.primary_span = instruction.origin.primary_span;
            return Err(DiagnosticBundle::new(vec![diagnostic]));
        }
        functions.push(lower_function(
            hir,
            FunctionId::new(count_u32(function_index)),
            &regions[function_index],
            allow_jsx,
        )?);
    }
    let helpers: BTreeSet<_> = functions
        .iter()
        .flat_map(|function| function.operations.iter().filter_map(EmitOperation::helper))
        .collect();
    if options.strict_guarantee
        && functions
            .iter()
            .any(|function| function.control_flow.fallback.is_some())
    {
        return Err(DiagnosticBundle::new(vec![lower_error(
            "FICT-R-CONTROL-FALLBACK",
            "irreducible control flow requires state-machine fallback",
            GuaranteeClass::Fallback,
        )]));
    }
    let imports = helpers
        .into_iter()
        .map(|helper| RuntimeImportIntent {
            helper,
            local: helper.spec().preferred_local.to_owned(),
        })
        .collect();
    let program = EmitProgram {
        runtime_family: options.runtime_family,
        preview: options.preview,
        strict_rejected: false,
        imports,
        functions,
    };
    verify_emit_program(hir, regions, &program)?;
    Ok(program)
}

fn lower_function(
    hir: &HirFile,
    function_id: FunctionId,
    regions: &RegionAnalysis,
    allow_jsx: bool,
) -> Result<EmitFunction, DiagnosticBundle> {
    let function = &hir.functions[function_id.as_usize()];
    let declarations_by_value: BTreeMap<_, _> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .filter_map(|instruction| match &instruction.kind {
            HirInstructionKind::Declare {
                local,
                initializer: Some(value),
                ..
            } => Some((*value, *local)),
            _ => None,
        })
        .collect();
    let mut sites = Vec::new();
    for block in &function.blocks {
        for instruction in &block.instructions {
            let HirInstructionKind::Call(call) = &instruction.kind else {
                continue;
            };
            let Some(kind) = call.macro_kind else {
                continue;
            };
            let Some(result) = instruction.result else {
                return Err(DiagnosticBundle::new(vec![lower_error(
                    "FICT-EMIT-MACRO-RESULT",
                    "reactive macro call has no HIR result",
                    GuaranteeClass::Internal,
                )]));
            };
            sites.push(MacroSite {
                result,
                local: declarations_by_value.get(&result).copied(),
                kind,
                slot: EmitSlotId::new(count_u32(sites.len())),
            });
        }
    }
    let site_by_result: BTreeMap<_, _> = sites.iter().map(|site| (site.result, *site)).collect();
    let slot_by_local: BTreeMap<_, _> = sites
        .iter()
        .filter_map(|site| site.local.map(|local| (local, site.slot)))
        .collect();
    let slots = sites
        .iter()
        .map(|site| ReactiveSlot {
            id: site.slot,
            kind: match site.kind {
                FictMacroKind::State => ReactiveSlotKind::Signal,
                FictMacroKind::Memo => ReactiveSlotKind::Memo,
                FictMacroKind::Effect => ReactiveSlotKind::Effect,
            },
            binding: site
                .local
                .and_then(|local| function.locals.get(local.as_usize()))
                .and_then(|local| local.binding),
            control_path: Vec::new(),
            origin: macro_origin(function, site.result),
        })
        .collect();
    let mut temporaries = Vec::new();
    let mut value_temporaries = BTreeMap::new();
    let mut operations = Vec::new();
    let mut declared_templates = BTreeSet::new();
    for block in &function.blocks {
        for (instruction_index, instruction) in block.instructions.iter().enumerate() {
            if let HirInstructionKind::Call(call) = &instruction.kind
                && call.macro_kind.is_some()
            {
                let result = instruction.result.expect("macro result validated");
                let site = site_by_result[&result];
                match site.kind {
                    FictMacroKind::State | FictMacroKind::Memo => {
                        operations.push(EmitOperation::CreateReactive {
                            slot: site.slot,
                            source_result: result,
                            local: site.local,
                            initializer: call
                                .arguments
                                .first()
                                .map(|argument| lower_value(argument.value, &value_temporaries)),
                            helper: creation_helper(function.kind, site.kind),
                            origin: instruction.origin,
                        });
                    }
                    FictMacroKind::Effect => {
                        let Some(callback) = call.arguments.first() else {
                            return Err(DiagnosticBundle::new(vec![lower_error(
                                "FICT-EMIT-EFFECT-CALLBACK",
                                "effect macro has no callback input",
                                GuaranteeClass::Internal,
                            )]));
                        };
                        operations.push(EmitOperation::RegisterEffect {
                            slot: site.slot,
                            source_result: Some(result),
                            callback: lower_value(callback.value, &value_temporaries),
                            helper: effect_helper(function.kind),
                            cleanup: CleanupOwner::Slot(site.slot),
                            origin: instruction.origin,
                        });
                    }
                }
                continue;
            }
            if let HirInstructionKind::Declare {
                initializer: Some(initializer),
                ..
            } = instruction.kind
                && site_by_result.contains_key(&initializer)
            {
                continue;
            }
            match &instruction.kind {
                HirInstructionKind::Read { place } => {
                    let Some(slot) = place_local(place.base)
                        .and_then(|local| slot_by_local.get(&local).copied())
                    else {
                        preserve(&mut operations, block.id, instruction_index, instruction);
                        continue;
                    };
                    let Some(result) = instruction.result else {
                        return Err(DiagnosticBundle::new(vec![lower_error(
                            "FICT-EMIT-READ-RESULT",
                            "reactive read has no HIR result",
                            GuaranteeClass::Internal,
                        )]));
                    };
                    let target = allocate_temporary(
                        &mut temporaries,
                        format!("__fict_v{}", result.index()),
                        instruction.origin,
                    );
                    value_temporaries.insert(result, target);
                    operations.push(EmitOperation::ReadReactive {
                        slot,
                        source_result: result,
                        projections: place.projections.clone(),
                        target,
                        helper: None,
                        origin: instruction.origin,
                    });
                }
                HirInstructionKind::Write { place, value } => {
                    let Some(slot) = place_local(place.base)
                        .and_then(|local| slot_by_local.get(&local).copied())
                    else {
                        preserve(&mut operations, block.id, instruction_index, instruction);
                        continue;
                    };
                    operations.push(EmitOperation::WriteReactive {
                        slot,
                        projections: place.projections.clone(),
                        value: lower_value(*value, &value_temporaries),
                        origin: instruction.origin,
                    });
                }
                HirInstructionKind::ReadWrite {
                    place,
                    compound,
                    value,
                    update,
                    prefix,
                } => {
                    let Some(slot) = place_local(place.base)
                        .and_then(|local| slot_by_local.get(&local).copied())
                    else {
                        preserve(&mut operations, block.id, instruction_index, instruction);
                        continue;
                    };
                    let target = instruction.result.map(|result| {
                        let target = allocate_temporary(
                            &mut temporaries,
                            format!("__fict_v{}", result.index()),
                            instruction.origin,
                        );
                        value_temporaries.insert(result, target);
                        target
                    });
                    operations.push(EmitOperation::UpdateReactive {
                        slot,
                        source_result: instruction.result,
                        projections: place.projections.clone(),
                        compound: *compound,
                        value: value.map(|value| lower_value(value, &value_temporaries)),
                        update: *update,
                        prefix: *prefix,
                        target,
                        origin: instruction.origin,
                    });
                }
                HirInstructionKind::Jsx { template } if allow_jsx => {
                    lower_jsx_instruction(
                        hir,
                        function_id,
                        *template,
                        instruction,
                        &mut declared_templates,
                        &mut temporaries,
                        &mut value_temporaries,
                        &mut operations,
                        regions
                            .top_level_regions
                            .first()
                            .copied()
                            .map_or(CleanupOwner::Function, CleanupOwner::Region),
                    )?;
                }
                _ => preserve(&mut operations, block.id, instruction_index, instruction),
            }
        }
        match &block.terminator.kind {
            TerminatorKind::Return { value } => operations.push(EmitOperation::Return {
                value: value.map(|value| lower_value(value, &value_temporaries)),
                origin: block.terminator.origin,
            }),
            TerminatorKind::Throw { .. }
            | TerminatorKind::Goto { .. }
            | TerminatorKind::Branch { .. }
            | TerminatorKind::Switch { .. }
            | TerminatorKind::Try { .. }
            | TerminatorKind::Unreachable => {}
        }
    }
    Ok(EmitFunction {
        source: function_id,
        slots,
        temporaries,
        regions: regions.top_level_regions.clone(),
        control_flow: structurize_cfg(function, &analyze_cfg(function)?)?,
        operations,
    })
}

#[derive(Debug)]
enum TemplateBinding {
    Attribute {
        path: Vec<u32>,
        name: String,
        value: ValueId,
    },
    Spread {
        path: Vec<u32>,
        value: ValueId,
    },
    Child {
        parent_path: Vec<u32>,
        value: ValueId,
    },
    Event {
        path: Vec<u32>,
        event: String,
        handler: ValueId,
    },
    Ref {
        path: Vec<u32>,
        reference: ValueId,
    },
}

struct SerializedTemplate {
    html: String,
    namespace: DomNamespace,
    bindings: Vec<TemplateBinding>,
}

#[allow(clippy::too_many_arguments)]
fn lower_jsx_instruction(
    hir: &HirFile,
    function_id: FunctionId,
    template_id: TemplateId,
    instruction: &fict_hir::HirInstruction,
    declared_templates: &mut BTreeSet<TemplateId>,
    temporaries: &mut Vec<EmitTemporary>,
    value_temporaries: &mut BTreeMap<ValueId, EmitTemporaryId>,
    operations: &mut Vec<EmitOperation>,
    cleanup: CleanupOwner,
) -> Result<(), DiagnosticBundle> {
    let Some(template) = hir.templates.get(template_id.as_usize()) else {
        return Err(DiagnosticBundle::new(vec![lower_error(
            "FICT-EMIT-TEMPLATE",
            "JSX instruction references a missing template",
            GuaranteeClass::Internal,
        )]));
    };
    if template.owner != function_id {
        return Err(DiagnosticBundle::new(vec![lower_error(
            "FICT-EMIT-TEMPLATE-OWNER",
            "JSX template belongs to another function value arena",
            GuaranteeClass::Internal,
        )]));
    }
    if let JsxNode::Element(element) = &template.root
        && !matches!(element.name, JsxElementName::Intrinsic(_))
    {
        return lower_component_jsx(
            hir,
            function_id,
            element,
            instruction,
            temporaries,
            value_temporaries,
            operations,
        );
    }
    let serialized = serialize_template(&template.root)?;
    if declared_templates.insert(template_id) {
        operations.push(EmitOperation::DeclareTemplate {
            template: template_id,
            html: serialized.html,
            namespace: serialized.namespace,
            helper: RuntimeHelper::Template,
            origin: template.origin,
        });
    }
    let Some(result) = instruction.result else {
        return Err(DiagnosticBundle::new(vec![lower_error(
            "FICT-EMIT-JSX-RESULT",
            "JSX instruction has no HIR result",
            GuaranteeClass::Internal,
        )]));
    };
    let root = allocate_temporary(
        temporaries,
        format!("__fict_jsx{}", result.index()),
        instruction.origin,
    );
    value_temporaries.insert(result, root);
    operations.push(EmitOperation::CloneTemplate {
        template: template_id,
        source_result: result,
        target: root,
        origin: instruction.origin,
    });
    let mut resolved = BTreeMap::new();
    for binding in serialized.bindings {
        match binding {
            TemplateBinding::Attribute { path, name, value } => {
                let element = resolved_element(
                    root,
                    path,
                    &mut resolved,
                    temporaries,
                    operations,
                    instruction.origin,
                );
                let reactive = !matches!(
                    hir.functions[function_id.as_usize()].values[value.as_usize()].kind,
                    ValueKind::Literal(_)
                );
                let kind = dom_binding_kind(&name);
                let helper = dom_binding_helper(&kind, reactive);
                operations.push(EmitOperation::BindDom {
                    element,
                    kind,
                    value: lower_value(value, value_temporaries),
                    reactive,
                    helper,
                    origin: instruction.origin,
                });
            }
            TemplateBinding::Spread { path, value } => {
                let element = resolved_element(
                    root,
                    path,
                    &mut resolved,
                    temporaries,
                    operations,
                    instruction.origin,
                );
                operations.push(EmitOperation::ApplyProps {
                    target: element,
                    operation: PropsOperation::Spread {
                        source: lower_value(value, value_temporaries),
                        namespace: serialized.namespace,
                        skip_children: false,
                        excluded: Vec::new(),
                    },
                    helper: RuntimeHelper::Spread,
                    origin: instruction.origin,
                });
            }
            TemplateBinding::Child { parent_path, value } => {
                let parent = resolved_element(
                    root,
                    parent_path,
                    &mut resolved,
                    temporaries,
                    operations,
                    instruction.origin,
                );
                operations.push(EmitOperation::Insert {
                    parent,
                    value: lower_value(value, value_temporaries),
                    before: None,
                    helper: RuntimeHelper::Insert,
                    origin: instruction.origin,
                });
            }
            TemplateBinding::Event {
                path,
                event,
                handler,
            } => {
                let element = resolved_element(
                    root,
                    path,
                    &mut resolved,
                    temporaries,
                    operations,
                    instruction.origin,
                );
                let delegated = DELEGATED_EVENTS.contains(&event.as_str());
                operations.push(EmitOperation::BindEvent {
                    element,
                    event,
                    handler: lower_value(handler, value_temporaries),
                    delegated,
                    helper: if delegated {
                        RuntimeHelper::DelegateEvents
                    } else {
                        RuntimeHelper::BindEvent
                    },
                    cleanup,
                    origin: instruction.origin,
                });
            }
            TemplateBinding::Ref { path, reference } => {
                let element = resolved_element(
                    root,
                    path,
                    &mut resolved,
                    temporaries,
                    operations,
                    instruction.origin,
                );
                operations.push(EmitOperation::BindRef {
                    element,
                    reference: lower_value(reference, value_temporaries),
                    helper: RuntimeHelper::BindRef,
                    cleanup,
                    origin: instruction.origin,
                });
            }
        }
    }
    Ok(())
}

fn lower_component_jsx(
    hir: &HirFile,
    function_id: FunctionId,
    element: &fict_hir::JsxElement,
    instruction: &fict_hir::HirInstruction,
    temporaries: &mut Vec<EmitTemporary>,
    value_temporaries: &mut BTreeMap<ValueId, EmitTemporaryId>,
    operations: &mut Vec<EmitOperation>,
) -> Result<(), DiagnosticBundle> {
    let component = match &element.name {
        JsxElementName::Component(binding) => ComponentTarget::Binding(*binding),
        JsxElementName::Member { root, properties } => ComponentTarget::Member {
            root: *root,
            properties: properties.clone(),
        },
        JsxElementName::Dynamic(value) => {
            ComponentTarget::Dynamic(lower_value(*value, value_temporaries))
        }
        JsxElementName::Intrinsic(_) => unreachable!("intrinsic handled by template lowering"),
    };
    let mut props = Vec::new();
    for attribute in &element.attributes {
        match attribute {
            JsxAttribute::Named { name, value, .. } => {
                let (value, getter) = match value {
                    JsxAttributeValue::ImplicitTrue => (
                        EmitValueRef::Literal(fict_hir::LiteralValue::Boolean(true)),
                        false,
                    ),
                    JsxAttributeValue::Text(value) => (
                        EmitValueRef::Literal(fict_hir::LiteralValue::String(value.clone())),
                        false,
                    ),
                    JsxAttributeValue::Expression(value) => (
                        lower_value(*value, value_temporaries),
                        !matches!(
                            hir.functions[function_id.as_usize()].values[value.as_usize()].kind,
                            ValueKind::Literal(_)
                        ),
                    ),
                    JsxAttributeValue::Node(_) => {
                        return Err(DiagnosticBundle::new(vec![lower_error(
                            "FICT-EMIT-COMPONENT-PROP-NODE",
                            "node-valued component props require nested JSX lowering",
                            GuaranteeClass::Unsupported,
                        )]));
                    }
                };
                props.push(ComponentProp::Named {
                    name: name.clone(),
                    value,
                    getter,
                });
            }
            JsxAttribute::Spread { value, .. } => {
                props.push(ComponentProp::Spread(lower_value(
                    *value,
                    value_temporaries,
                )));
            }
        }
    }
    let mut children = Vec::new();
    for child in &element.children {
        match child {
            JsxChild::Text { value, .. } => children.push(EmitValueRef::Literal(
                fict_hir::LiteralValue::String(value.clone()),
            )),
            JsxChild::Expression { value, .. } | JsxChild::Spread { value, .. } => {
                children.push(lower_value(*value, value_temporaries));
            }
            JsxChild::Node(_) => {
                return Err(DiagnosticBundle::new(vec![lower_error(
                    "FICT-EMIT-COMPONENT-CHILD",
                    "nested component JSX children require recursive component lowering",
                    GuaranteeClass::Unsupported,
                )]));
            }
        }
    }
    let Some(result) = instruction.result else {
        return Err(DiagnosticBundle::new(vec![lower_error(
            "FICT-EMIT-JSX-RESULT",
            "component JSX instruction has no HIR result",
            GuaranteeClass::Internal,
        )]));
    };
    let target = allocate_temporary(
        temporaries,
        format!("__fict_component{}", result.index()),
        instruction.origin,
    );
    value_temporaries.insert(result, target);
    operations.push(EmitOperation::InvokeComponent {
        target,
        component,
        props,
        children,
        origin: instruction.origin,
    });
    Ok(())
}

fn serialize_template(root: &JsxNode) -> Result<SerializedTemplate, DiagnosticBundle> {
    let namespace = match root {
        JsxNode::Element(element) => match &element.name {
            JsxElementName::Intrinsic(name) if name == "svg" => DomNamespace::Svg,
            JsxElementName::Intrinsic(name) if name == "math" => DomNamespace::MathMl,
            _ => DomNamespace::Html,
        },
        JsxNode::Fragment { .. } => DomNamespace::Html,
    };
    let mut html = String::new();
    let mut bindings = Vec::new();
    serialize_node(root, &mut Vec::new(), &mut html, &mut bindings)?;
    if html.is_empty() {
        html.push_str("<!---->");
    }
    Ok(SerializedTemplate {
        html,
        namespace,
        bindings,
    })
}

fn serialize_node(
    node: &JsxNode,
    path: &mut Vec<u32>,
    html: &mut String,
    bindings: &mut Vec<TemplateBinding>,
) -> Result<(), DiagnosticBundle> {
    match node {
        JsxNode::Fragment { children, .. } => {
            serialize_children(children, path, html, bindings)?;
        }
        JsxNode::Element(element) => {
            let JsxElementName::Intrinsic(tag) = &element.name else {
                return Err(DiagnosticBundle::new(vec![lower_error(
                    "FICT-EMIT-COMPONENT-STAGE",
                    "component/dynamic JSX requires the component lowering phase",
                    GuaranteeClass::Unsupported,
                )]));
            };
            if !valid_markup_name(tag) {
                return Err(DiagnosticBundle::new(vec![lower_error(
                    "FICT-EMIT-TAG",
                    "intrinsic JSX tag contains unsafe markup characters",
                    GuaranteeClass::Unsupported,
                )]));
            }
            html.push('<');
            html.push_str(tag);
            for attribute in &element.attributes {
                match attribute {
                    JsxAttribute::Named { name, value, .. } => {
                        if !valid_markup_name(name) {
                            return Err(DiagnosticBundle::new(vec![lower_error(
                                "FICT-EMIT-ATTRIBUTE",
                                "JSX attribute contains unsafe markup characters",
                                GuaranteeClass::Unsupported,
                            )]));
                        }
                        match value {
                            JsxAttributeValue::ImplicitTrue => {
                                html.push(' ');
                                html.push_str(name);
                            }
                            JsxAttributeValue::Text(value) => {
                                html.push(' ');
                                html.push_str(name);
                                html.push_str("=\"");
                                escape_attribute(value, html);
                                html.push('"');
                            }
                            JsxAttributeValue::Expression(value) => {
                                if name == "ref" {
                                    bindings.push(TemplateBinding::Ref {
                                        path: path.clone(),
                                        reference: *value,
                                    });
                                } else if let Some(event) = event_name(name) {
                                    bindings.push(TemplateBinding::Event {
                                        path: path.clone(),
                                        event,
                                        handler: *value,
                                    });
                                } else {
                                    bindings.push(TemplateBinding::Attribute {
                                        path: path.clone(),
                                        name: name.clone(),
                                        value: *value,
                                    });
                                }
                            }
                            JsxAttributeValue::Node(_) => {
                                return Err(DiagnosticBundle::new(vec![lower_error(
                                    "FICT-EMIT-ATTRIBUTE-NODE",
                                    "JSX node-valued attributes require component lowering",
                                    GuaranteeClass::Unsupported,
                                )]));
                            }
                        }
                    }
                    JsxAttribute::Spread { value, .. } => bindings.push(TemplateBinding::Spread {
                        path: path.clone(),
                        value: *value,
                    }),
                }
            }
            html.push('>');
            serialize_children(&element.children, path, html, bindings)?;
            html.push_str("</");
            html.push_str(tag);
            html.push('>');
        }
    }
    Ok(())
}

fn serialize_children(
    children: &[JsxChild],
    parent_path: &mut Vec<u32>,
    html: &mut String,
    bindings: &mut Vec<TemplateBinding>,
) -> Result<(), DiagnosticBundle> {
    for (index, child) in children.iter().enumerate() {
        match child {
            JsxChild::Text { value, .. } => escape_text(value, html),
            JsxChild::Expression { value, .. } | JsxChild::Spread { value, .. } => {
                html.push_str("<!---->");
                bindings.push(TemplateBinding::Child {
                    parent_path: parent_path.clone(),
                    value: *value,
                });
            }
            JsxChild::Node(node) => {
                parent_path.push(count_u32(index));
                serialize_node(node, parent_path, html, bindings)?;
                parent_path.pop();
            }
        }
    }
    Ok(())
}

fn resolved_element(
    root: EmitTemporaryId,
    path: Vec<u32>,
    resolved: &mut BTreeMap<Vec<u32>, EmitTemporaryId>,
    temporaries: &mut Vec<EmitTemporary>,
    operations: &mut Vec<EmitOperation>,
    origin: fict_hir::Origin,
) -> EmitTemporaryId {
    if path.is_empty() {
        return root;
    }
    if let Some(temporary) = resolved.get(&path) {
        return *temporary;
    }
    let target = allocate_temporary(
        temporaries,
        format!("__fict_node{}", temporaries.len()),
        origin,
    );
    operations.push(EmitOperation::ResolveElement {
        root,
        path: path.clone(),
        target,
        helper: RuntimeHelper::ResolvePath,
        origin,
    });
    resolved.insert(path, target);
    target
}

fn dom_binding_kind(name: &str) -> DomBindingKind {
    match name {
        "class" | "className" => DomBindingKind::Class,
        "style" => DomBindingKind::Style,
        "value" | "checked" | "selected" | "textContent" | "innerHTML" => {
            DomBindingKind::Property(name.to_owned())
        }
        _ => DomBindingKind::Attribute(name.to_owned()),
    }
}

fn dom_binding_helper(kind: &DomBindingKind, reactive: bool) -> RuntimeHelper {
    match (kind, reactive) {
        (DomBindingKind::Text, true) => RuntimeHelper::BindText,
        (DomBindingKind::Text, false) => RuntimeHelper::SetText,
        (DomBindingKind::TextContent, true) => RuntimeHelper::BindTextContent,
        (DomBindingKind::TextContent, false) => RuntimeHelper::SetTextContent,
        (DomBindingKind::Attribute(_), true) => RuntimeHelper::BindAttribute,
        (DomBindingKind::Attribute(_), false) => RuntimeHelper::SetAttr,
        (DomBindingKind::Property(_), true) => RuntimeHelper::BindProperty,
        (DomBindingKind::Property(_), false) => RuntimeHelper::SetProp,
        (DomBindingKind::Class, true) => RuntimeHelper::BindClass,
        (DomBindingKind::Class, false) => RuntimeHelper::SetClass,
        (DomBindingKind::Style, true) => RuntimeHelper::BindStyle,
        (DomBindingKind::Style, false) => RuntimeHelper::SetStyle,
        (DomBindingKind::Spread, _) => RuntimeHelper::Spread,
    }
}

fn escape_text(value: &str, output: &mut String) {
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            _ => output.push(character),
        }
    }
}

fn escape_attribute(value: &str, output: &mut String) {
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '"' => output.push_str("&quot;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            _ => output.push(character),
        }
    }
}

fn valid_markup_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
}

fn event_name(attribute: &str) -> Option<String> {
    if let Some(event) = attribute.strip_prefix("on:")
        && !event.is_empty()
    {
        return Some(event.to_ascii_lowercase());
    }
    let event = attribute.strip_prefix("on")?;
    if event.is_empty() {
        return None;
    }
    Some(event.to_ascii_lowercase())
}

fn creation_helper(kind: FunctionKind, macro_kind: FictMacroKind) -> RuntimeHelper {
    let scoped = matches!(
        kind,
        FunctionKind::Component | FunctionKind::Hook | FunctionKind::ReactiveScope
    );
    match (macro_kind, scoped) {
        (FictMacroKind::State, false) => RuntimeHelper::Signal,
        (FictMacroKind::State, true) => RuntimeHelper::UseSignal,
        (FictMacroKind::Memo, false) => RuntimeHelper::Memo,
        (FictMacroKind::Memo, true) => RuntimeHelper::UseMemo,
        (FictMacroKind::Effect, _) => unreachable!("effect has a dedicated helper"),
    }
}

fn effect_helper(kind: FunctionKind) -> RuntimeHelper {
    if matches!(
        kind,
        FunctionKind::Component | FunctionKind::Hook | FunctionKind::ReactiveScope
    ) {
        RuntimeHelper::UseEffect
    } else {
        RuntimeHelper::Effect
    }
}

fn place_local(base: PlaceBase) -> Option<LocalId> {
    match base {
        PlaceBase::Local(local) => Some(local),
        PlaceBase::Ssa(name) => Some(name.local),
        PlaceBase::Value(_) => None,
    }
}

fn lower_value(value: ValueId, temporaries: &BTreeMap<ValueId, EmitTemporaryId>) -> EmitValueRef {
    temporaries
        .get(&value)
        .copied()
        .map_or(EmitValueRef::Hir(value), EmitValueRef::Temporary)
}

fn allocate_temporary(
    temporaries: &mut Vec<EmitTemporary>,
    name: String,
    origin: fict_hir::Origin,
) -> EmitTemporaryId {
    let id = EmitTemporaryId::new(count_u32(temporaries.len()));
    temporaries.push(EmitTemporary { id, name, origin });
    id
}

fn preserve(
    operations: &mut Vec<EmitOperation>,
    block: fict_hir::BlockId,
    instruction: usize,
    hir: &fict_hir::HirInstruction,
) {
    operations.push(EmitOperation::PreserveHir {
        block,
        instruction: count_u32(instruction),
        origin: hir.origin,
    });
}

fn macro_origin(function: &fict_hir::HirFunction, result: ValueId) -> fict_hir::Origin {
    function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find(|instruction| instruction.result == Some(result))
        .map_or(function.origin, |instruction| instruction.origin)
}

fn lower_error(
    code: &'static str,
    message: impl Into<String>,
    guarantee: GuaranteeClass,
) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("lowering diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(guarantee)
}

fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
