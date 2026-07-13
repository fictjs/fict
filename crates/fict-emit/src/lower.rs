use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_hir::{
    CallHost, FictMacroKind, FunctionId, FunctionKind, HirFile, HirInstructionKind, ImportedName,
    JsxAttribute, JsxAttributeValue, JsxChild, JsxElementName, JsxNode, LocalId, PlaceBase,
    ReactiveCallKind, TemplateId, TerminatorKind, ValueId, ValueKind,
};
use fict_reactivity::{ReactiveCycleAnalysis, RegionAnalysis, analyze_cfg, structurize_cfg};

use crate::{
    CleanupOwner, ComponentProp, ComponentTarget, DELEGATED_EVENTS, DomBindingKind, DomNamespace,
    EmitContext, EmitFunction, EmitModulePlan, EmitOperation, EmitProgram, EmitSlotId,
    EmitTemporary, EmitTemporaryId, EmitValueRef, PropsOperation, ReactiveSlot, ReactiveSlotKind,
    ReactiveSlotStorage, RuntimeFamily, RuntimeHelper, RuntimeImportIntent,
    name_allocator::NameAllocator, verify_emit_program,
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
struct ReactiveSite {
    result: ValueId,
    local: Option<LocalId>,
    kind: ReactiveSiteKind,
    slot: EmitSlotId,
}

#[derive(Debug, Clone, Copy)]
struct ReactiveBindingSite {
    owner: FunctionId,
    binding: fict_hir::BindingId,
    kind: ReactiveSlotKind,
    origin: fict_hir::Origin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReactiveSiteKind {
    Macro(FictMacroKind),
    Runtime(ReactiveCallKind),
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
    let reactive_bindings = collect_reactive_binding_sites(hir)?;
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
            &reactive_bindings,
            allow_jsx,
        )?);
    }
    let helpers: BTreeSet<_> = functions
        .iter()
        .flat_map(|function| {
            function
                .operations
                .iter()
                .filter_map(EmitOperation::helper)
                .chain(function.context.iter().map(|context| context.helper))
        })
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
    let source_names = hir
        .bindings
        .iter()
        .map(|binding| binding.display_name.clone())
        .chain(hir.functions.iter().flat_map(|function| {
            function
                .locals
                .iter()
                .filter_map(|local| local.debug_name.clone())
        }))
        .chain(
            functions
                .iter()
                .flat_map(|function| function.temporaries.iter().map(|temp| temp.name.clone())),
        )
        .chain(functions.iter().filter_map(|function| {
            function
                .context
                .as_ref()
                .map(|context| context.local.clone())
        }));
    let mut module_names = NameAllocator::new(source_names);
    let imports = helpers
        .into_iter()
        .map(|helper| {
            let spec = helper.spec();
            RuntimeImportIntent {
                helper,
                module_request: spec.module_request(options.runtime_family).to_owned(),
                imported: spec.export.to_owned(),
                local: module_names.allocate(spec.preferred_local),
            }
        })
        .collect();
    let program = EmitProgram {
        runtime_family: options.runtime_family,
        preview: options.preview,
        strict_rejected: false,
        module: EmitModulePlan {
            source_fragment: module_source_fragment(hir),
            reserved_names: module_names.names(),
        },
        imports,
        functions,
    };
    verify_emit_program(hir, regions, &program)?;
    Ok(program)
}

fn module_source_fragment(hir: &HirFile) -> Option<fict_hir::SyntaxFragmentId> {
    hir.functions
        .get(hir.root_function.as_usize())?
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .rev()
        .find_map(|instruction| match instruction.kind {
            HirInstructionKind::SyntaxFragment { fragment, .. } if instruction.result.is_none() => {
                Some(fragment)
            }
            _ => None,
        })
}

fn collect_reactive_binding_sites(
    hir: &HirFile,
) -> Result<BTreeMap<fict_hir::BindingId, ReactiveBindingSite>, DiagnosticBundle> {
    let mut sites = BTreeMap::new();
    for (function_index, function) in hir.functions.iter().enumerate() {
        let owner = FunctionId::new(count_u32(function_index));
        let declarations: BTreeMap<_, _> = function
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .filter_map(|instruction| match instruction.kind {
                HirInstructionKind::Declare {
                    local,
                    initializer: Some(initializer),
                    ..
                } => function.locals[local.as_usize()]
                    .binding
                    .map(|binding| (initializer, binding)),
                _ => None,
            })
            .collect();
        for instruction in function.blocks.iter().flat_map(|block| &block.instructions) {
            let HirInstructionKind::Call(call) = &instruction.kind else {
                continue;
            };
            let Some(kind) = call.macro_kind else {
                continue;
            };
            let slot_kind = match kind {
                FictMacroKind::State => ReactiveSlotKind::Signal,
                FictMacroKind::Memo => ReactiveSlotKind::Memo,
                FictMacroKind::Effect => continue,
            };
            let Some(binding) = instruction
                .result
                .and_then(|result| declarations.get(&result).copied())
            else {
                continue;
            };
            if sites
                .insert(
                    binding,
                    ReactiveBindingSite {
                        owner,
                        binding,
                        kind: slot_kind,
                        origin: instruction.origin,
                    },
                )
                .is_some()
            {
                return Err(DiagnosticBundle::new(vec![lower_error(
                    "FICT-EMIT-REACTIVE-BINDING",
                    "one semantic binding cannot own multiple reactive creation sites",
                    GuaranteeClass::Internal,
                )]));
            }
        }
    }
    Ok(sites)
}

fn lower_function(
    hir: &HirFile,
    function_id: FunctionId,
    regions: &RegionAnalysis,
    reactive_bindings: &BTreeMap<fict_hir::BindingId, ReactiveBindingSite>,
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
            let Some(kind) = call
                .macro_kind
                .map(ReactiveSiteKind::Macro)
                .or_else(|| call.reactive_kind.map(ReactiveSiteKind::Runtime))
            else {
                continue;
            };
            let Some(result) = instruction.result else {
                return Err(DiagnosticBundle::new(vec![lower_error(
                    "FICT-EMIT-REACTIVE-RESULT",
                    "reactive creation call has no HIR result",
                    GuaranteeClass::Internal,
                )]));
            };
            sites.push(ReactiveSite {
                result,
                local: declarations_by_value.get(&result).copied(),
                kind,
                slot: EmitSlotId::new(count_u32(sites.len())),
            });
        }
    }
    let site_by_result: BTreeMap<_, _> = sites.iter().map(|site| (site.result, *site)).collect();
    let macro_results: BTreeSet<_> = sites
        .iter()
        .filter_map(|site| matches!(site.kind, ReactiveSiteKind::Macro(_)).then_some(site.result))
        .collect();
    let keyed_results: BTreeSet<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .filter_map(|instruction| {
            let HirInstructionKind::Call(call) = &instruction.kind else {
                return None;
            };
            is_runtime_helper_call(hir, call, RuntimeHelper::KeyedList)
                .then_some(instruction.result)
                .flatten()
        })
        .collect();
    let captured_sites: Vec<_> = function
        .locals
        .iter()
        .filter(|local| local.kind == fict_hir::LocalKind::Capture)
        .filter_map(|local| {
            let binding = local.binding?;
            let site = reactive_bindings.get(&binding).copied()?;
            (site.owner != function_id).then_some((local.id, site))
        })
        .enumerate()
        .map(|(index, (local, site))| {
            (
                local,
                site,
                EmitSlotId::new(count_u32(sites.len().saturating_add(index))),
            )
        })
        .collect();
    let mut slot_by_local: BTreeMap<_, _> = sites
        .iter()
        .filter_map(|site| {
            matches!(
                site.kind,
                ReactiveSiteKind::Macro(FictMacroKind::State | FictMacroKind::Memo)
            )
            .then_some(site.local)
            .flatten()
            .map(|local| (local, site.slot))
        })
        .collect();
    slot_by_local.extend(
        captured_sites
            .iter()
            .map(|(local, _, slot)| (*local, *slot)),
    );
    let mut slots: Vec<_> = sites
        .iter()
        .map(|site| ReactiveSlot {
            id: site.slot,
            kind: match site.kind {
                ReactiveSiteKind::Macro(FictMacroKind::State) => ReactiveSlotKind::Signal,
                ReactiveSiteKind::Macro(FictMacroKind::Memo) => ReactiveSlotKind::Memo,
                ReactiveSiteKind::Macro(FictMacroKind::Effect) => ReactiveSlotKind::Effect,
                ReactiveSiteKind::Runtime(ReactiveCallKind::Store) => ReactiveSlotKind::Store,
                ReactiveSiteKind::Runtime(ReactiveCallKind::Resource) => ReactiveSlotKind::Resource,
                ReactiveSiteKind::Runtime(ReactiveCallKind::Selector) => ReactiveSlotKind::Selector,
            },
            storage: ReactiveSlotStorage::Owned,
            binding: site
                .local
                .and_then(|local| function.locals.get(local.as_usize()))
                .and_then(|local| local.binding),
            control_path: Vec::new(),
            origin: reactive_site_origin(function, site.result),
        })
        .collect();
    slots.extend(captured_sites.iter().map(|(_, site, slot)| ReactiveSlot {
        id: *slot,
        kind: site.kind,
        storage: ReactiveSlotStorage::Captured { owner: site.owner },
        binding: Some(site.binding),
        control_path: Vec::new(),
        origin: site.origin,
    }));
    let mut temporary_names = NameAllocator::new(
        hir.bindings
            .iter()
            .map(|binding| binding.display_name.clone())
            .chain(
                function
                    .locals
                    .iter()
                    .filter_map(|local| local.debug_name.clone()),
            ),
    );
    let mut temporaries = Vec::new();
    let mut value_temporaries = BTreeMap::new();
    let mut operations = Vec::new();
    let mut declared_templates = BTreeSet::new();
    let cleanup = regions
        .top_level_regions
        .first()
        .copied()
        .map_or(CleanupOwner::Function, CleanupOwner::Region);
    for block in &function.blocks {
        for (instruction_index, instruction) in block.instructions.iter().enumerate() {
            if let HirInstructionKind::Call(call) = &instruction.kind
                && let Some(site) = instruction
                    .result
                    .and_then(|result| site_by_result.get(&result).copied())
            {
                let result = instruction.result.expect("reactive result validated");
                match site.kind {
                    ReactiveSiteKind::Macro(FictMacroKind::State | FictMacroKind::Memo) => {
                        operations.push(EmitOperation::CreateReactive {
                            slot: site.slot,
                            source_result: result,
                            local: site.local,
                            initializer: call
                                .arguments
                                .first()
                                .map(|argument| lower_value(argument.value, &value_temporaries)),
                            helper: creation_helper(
                                function.kind,
                                call.macro_kind.expect("macro site"),
                            ),
                            origin: instruction.origin,
                        });
                    }
                    ReactiveSiteKind::Macro(FictMacroKind::Effect) => {
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
                    ReactiveSiteKind::Runtime(_) => {
                        operations.push(EmitOperation::TrackRuntimeReactive {
                            slot: site.slot,
                            source_result: result,
                            local: site.local,
                            cleanup: CleanupOwner::Slot(site.slot),
                            origin: instruction.origin,
                        });
                        preserve(&mut operations, block.id, instruction_index, instruction);
                    }
                }
                continue;
            }
            if let HirInstructionKind::Call(call) = &instruction.kind
                && instruction
                    .result
                    .is_some_and(|result| keyed_results.contains(&result))
            {
                let result = instruction.result.expect("keyed result selected");
                if call.arguments.len() < 3 {
                    return Err(DiagnosticBundle::new(vec![lower_error(
                        "FICT-EMIT-KEYED-ARGS",
                        "createKeyedList requires items, key, and render inputs",
                        GuaranteeClass::Unsupported,
                    )]));
                }
                let key = function_value(function, call.arguments[1].value).ok_or_else(|| {
                    DiagnosticBundle::new(vec![lower_error(
                        "FICT-EMIT-KEYED-KEY",
                        "keyed list key input must be a statically known function",
                        GuaranteeClass::Unsupported,
                    )])
                })?;
                let render =
                    function_value(function, call.arguments[2].value).ok_or_else(|| {
                        DiagnosticBundle::new(vec![lower_error(
                            "FICT-EMIT-KEYED-RENDER",
                            "keyed list render input must be a statically known function",
                            GuaranteeClass::Unsupported,
                        )])
                    })?;
                let target = allocate_temporary(
                    &mut temporaries,
                    &mut temporary_names,
                    format!("__fict_list{}", result.index()),
                    instruction.origin,
                );
                value_temporaries.insert(result, target);
                operations.push(EmitOperation::KeyedList {
                    target,
                    source_result: result,
                    items: lower_value(call.arguments[0].value, &value_temporaries),
                    key: Some(key),
                    render,
                    helper: RuntimeHelper::KeyedList,
                    cleanup,
                    origin: instruction.origin,
                });
                continue;
            }
            if let HirInstructionKind::Declare {
                initializer: Some(initializer),
                ..
            } = instruction.kind
                && (macro_results.contains(&initializer) || keyed_results.contains(&initializer))
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
                        &mut temporary_names,
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
                            &mut temporary_names,
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
                        &mut temporary_names,
                        &mut value_temporaries,
                        &mut operations,
                        cleanup,
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
    let context = operations
        .iter()
        .filter_map(EmitOperation::helper)
        .any(is_scoped_helper)
        .then(|| EmitContext {
            local: temporary_names.allocate("__fictCtx"),
            helper: RuntimeHelper::UseContext,
            origin: function.origin,
        });
    Ok(EmitFunction {
        source: function_id,
        context,
        slots,
        temporaries,
        regions: regions.top_level_regions.clone(),
        control_flow: structurize_cfg(function, &analyze_cfg(function)?)?,
        operations,
    })
}

fn is_scoped_helper(helper: RuntimeHelper) -> bool {
    matches!(
        helper,
        RuntimeHelper::UseSignal | RuntimeHelper::UseMemo | RuntimeHelper::UseEffect
    )
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
        namespace: DomNamespace,
    },
    Child {
        parent_path: Vec<u32>,
        value: ValueId,
        namespace: DomNamespace,
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

#[derive(Debug)]
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
    temporary_names: &mut NameAllocator,
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
            temporary_names,
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
        temporary_names,
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
                    temporary_names,
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
            TemplateBinding::Spread {
                path,
                value,
                namespace,
            } => {
                let element = resolved_element(
                    root,
                    path,
                    &mut resolved,
                    temporaries,
                    temporary_names,
                    operations,
                    instruction.origin,
                );
                operations.push(EmitOperation::ApplyProps {
                    target: element,
                    operation: PropsOperation::Spread {
                        source: lower_value(value, value_temporaries),
                        namespace,
                        skip_children: false,
                        excluded: Vec::new(),
                    },
                    helper: RuntimeHelper::Spread,
                    origin: instruction.origin,
                });
            }
            TemplateBinding::Child {
                parent_path,
                value,
                namespace,
            } => {
                let parent = resolved_element(
                    root,
                    parent_path,
                    &mut resolved,
                    temporaries,
                    temporary_names,
                    operations,
                    instruction.origin,
                );
                operations.push(EmitOperation::Insert {
                    parent,
                    value: lower_value(value, value_temporaries),
                    before: None,
                    namespace,
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
                    temporary_names,
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
                    temporary_names,
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

#[allow(clippy::too_many_arguments)]
fn lower_component_jsx(
    hir: &HirFile,
    function_id: FunctionId,
    element: &fict_hir::JsxElement,
    instruction: &fict_hir::HirInstruction,
    temporaries: &mut Vec<EmitTemporary>,
    temporary_names: &mut NameAllocator,
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
        temporary_names,
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
            JsxElementName::Intrinsic(name) => resolve_element_namespace(name, None, true),
            _ => DomNamespace::Html,
        },
        JsxNode::Fragment { .. } => DomNamespace::Html,
    };
    let mut html = String::new();
    let mut bindings = Vec::new();
    serialize_node(root, None, true, &mut Vec::new(), &mut html, &mut bindings)?;
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
    parent_namespace: Option<DomNamespace>,
    allow_standalone: bool,
    path: &mut Vec<u32>,
    html: &mut String,
    bindings: &mut Vec<TemplateBinding>,
) -> Result<u32, DiagnosticBundle> {
    match node {
        JsxNode::Fragment { children, .. } => serialize_children(
            children,
            path,
            html,
            bindings,
            None,
            parent_namespace.unwrap_or(DomNamespace::Html),
            parent_namespace.unwrap_or(DomNamespace::Html),
        ),
        JsxNode::Element(element) => {
            let JsxElementName::Intrinsic(tag) = &element.name else {
                return Err(DiagnosticBundle::new(vec![lower_error(
                    "FICT-EMIT-COMPONENT-STAGE",
                    "component/dynamic JSX requires the component lowering phase",
                    GuaranteeClass::Unsupported,
                )]));
            };
            let element_namespace =
                resolve_element_namespace(tag, parent_namespace, allow_standalone);
            let child_namespace =
                resolve_child_namespace(tag, element_namespace, &element.attributes);
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
                        let name = normalize_attribute_name(tag, name, element_namespace);
                        if !valid_markup_name(&name) {
                            return Err(DiagnosticBundle::new(vec![lower_error(
                                "FICT-EMIT-ATTRIBUTE",
                                "JSX attribute contains unsafe markup characters",
                                GuaranteeClass::Unsupported,
                            )]));
                        }
                        match value {
                            JsxAttributeValue::ImplicitTrue => {
                                html.push(' ');
                                html.push_str(&name);
                            }
                            JsxAttributeValue::Text(value) => {
                                html.push(' ');
                                html.push_str(&name);
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
                                } else if let Some(event) = event_name(&name) {
                                    bindings.push(TemplateBinding::Event {
                                        path: path.clone(),
                                        event,
                                        handler: *value,
                                    });
                                } else {
                                    bindings.push(TemplateBinding::Attribute {
                                        path: path.clone(),
                                        name,
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
                    JsxAttribute::Spread { value, .. } => {
                        bindings.push(TemplateBinding::Spread {
                            path: path.clone(),
                            value: *value,
                            namespace: element_namespace,
                        });
                    }
                }
            }
            html.push('>');
            if is_html_void_element(tag, element_namespace) {
                if element.children.iter().any(renderable_child) {
                    return Err(DiagnosticBundle::new(vec![lower_error(
                        "FICT-EMIT-VOID-CHILD",
                        "HTML void elements cannot contain JSX children",
                        GuaranteeClass::Unsupported,
                    )]));
                }
            } else {
                serialize_children(
                    &element.children,
                    path,
                    html,
                    bindings,
                    Some(tag),
                    element_namespace,
                    child_namespace,
                )?;
                html.push_str("</");
                html.push_str(tag);
                html.push('>');
            }
            Ok(1)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn serialize_children(
    children: &[JsxChild],
    parent_path: &mut Vec<u32>,
    html: &mut String,
    bindings: &mut Vec<TemplateBinding>,
    parent_tag: Option<&str>,
    parent_element_namespace: DomNamespace,
    child_namespace: DomNamespace,
) -> Result<u32, DiagnosticBundle> {
    let mut child_index = 0_u32;
    let mut source_index = 0_usize;
    let mut previous_static_text = false;
    while source_index < children.len() {
        let child = &children[source_index];
        match child {
            JsxChild::Text { value, .. } => {
                if !value.is_empty() {
                    escape_text(value, html);
                    if !previous_static_text {
                        child_index += 1;
                    }
                    previous_static_text = true;
                }
            }
            JsxChild::Expression { value, .. } | JsxChild::Spread { value, .. } => {
                previous_static_text = false;
                html.push_str("<!---->");
                bindings.push(TemplateBinding::Child {
                    parent_path: parent_path.clone(),
                    value: *value,
                    namespace: child_namespace,
                });
                child_index += 1;
            }
            JsxChild::Node(node) => {
                previous_static_text = false;
                if child_namespace == DomNamespace::Parent {
                    return Err(DiagnosticBundle::new(vec![lower_error(
                        "FICT-EMIT-NAMESPACE-DYNAMIC",
                        "runtime annotation-xml encoding requires nested JSX to be lowered through a parent-derived slot",
                        GuaranteeClass::Unsupported,
                    )]));
                }
                if is_implicit_table_child(parent_tag, parent_element_namespace, child, "tr") {
                    parent_path.push(child_index);
                    html.push_str("<tbody>");
                    let mut row_index = 0_u32;
                    while source_index < children.len()
                        && is_implicit_table_child(
                            parent_tag,
                            parent_element_namespace,
                            &children[source_index],
                            "tr",
                        )
                    {
                        let JsxChild::Node(row) = &children[source_index] else {
                            unreachable!("table child predicate requires a JSX node")
                        };
                        parent_path.push(row_index);
                        serialize_node(
                            row,
                            Some(child_namespace),
                            false,
                            parent_path,
                            html,
                            bindings,
                        )?;
                        parent_path.pop();
                        row_index += 1;
                        source_index += 1;
                    }
                    html.push_str("</tbody>");
                    parent_path.pop();
                    child_index += 1;
                    continue;
                }
                if is_implicit_table_child(parent_tag, parent_element_namespace, child, "col") {
                    parent_path.push(child_index);
                    html.push_str("<colgroup>");
                    let mut column_index = 0_u32;
                    while source_index < children.len()
                        && is_implicit_table_child(
                            parent_tag,
                            parent_element_namespace,
                            &children[source_index],
                            "col",
                        )
                    {
                        let JsxChild::Node(column) = &children[source_index] else {
                            unreachable!("table child predicate requires a JSX node")
                        };
                        parent_path.push(column_index);
                        serialize_node(
                            column,
                            Some(child_namespace),
                            false,
                            parent_path,
                            html,
                            bindings,
                        )?;
                        parent_path.pop();
                        column_index += 1;
                        source_index += 1;
                    }
                    html.push_str("</colgroup>");
                    parent_path.pop();
                    child_index += 1;
                    continue;
                }
                parent_path.push(child_index);
                let node_count = serialize_node(
                    node,
                    Some(child_namespace),
                    false,
                    parent_path,
                    html,
                    bindings,
                )?;
                parent_path.pop();
                child_index += node_count;
            }
        }
        source_index += 1;
    }
    Ok(child_index)
}

fn resolve_element_namespace(
    tag: &str,
    parent: Option<DomNamespace>,
    allow_standalone: bool,
) -> DomNamespace {
    let tag = tag.to_ascii_lowercase();
    match parent {
        None | Some(DomNamespace::Html) => {
            if tag == "svg" {
                DomNamespace::Svg
            } else if tag == "math" {
                DomNamespace::MathMl
            } else if parent.is_none() && allow_standalone && is_standalone_svg_tag(&tag) {
                DomNamespace::Svg
            } else if parent.is_none() && allow_standalone && is_standalone_mathml_tag(&tag) {
                DomNamespace::MathMl
            } else {
                DomNamespace::Html
            }
        }
        Some(DomNamespace::Svg) => DomNamespace::Svg,
        Some(DomNamespace::MathMl) => DomNamespace::MathMl,
        Some(DomNamespace::MathMlTextIntegration) => {
            if tag == "svg" {
                DomNamespace::Svg
            } else if tag == "math" || matches!(tag.as_str(), "mglyph" | "malignmark") {
                DomNamespace::MathMl
            } else {
                DomNamespace::Html
            }
        }
        Some(DomNamespace::MathMlAnnotationXml) => {
            if tag == "svg" {
                DomNamespace::Svg
            } else {
                DomNamespace::MathMl
            }
        }
        Some(DomNamespace::Parent) => DomNamespace::Parent,
    }
}

fn resolve_child_namespace(
    tag: &str,
    element_namespace: DomNamespace,
    attributes: &[JsxAttribute],
) -> DomNamespace {
    let tag = tag.to_ascii_lowercase();
    if element_namespace == DomNamespace::Svg
        && matches!(tag.as_str(), "foreignobject" | "title" | "desc")
    {
        return DomNamespace::Html;
    }
    if element_namespace == DomNamespace::MathMl && tag == "annotation-xml" {
        return match annotation_xml_encoding(attributes) {
            AnnotationXmlEncoding::Html => DomNamespace::Html,
            AnnotationXmlEncoding::Other => DomNamespace::MathMlAnnotationXml,
            AnnotationXmlEncoding::Dynamic => DomNamespace::Parent,
        };
    }
    if element_namespace == DomNamespace::MathMl
        && matches!(tag.as_str(), "mi" | "mo" | "mn" | "ms" | "mtext")
    {
        return DomNamespace::MathMlTextIntegration;
    }
    element_namespace
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AnnotationXmlEncoding {
    Html,
    Other,
    Dynamic,
}

fn annotation_xml_encoding(attributes: &[JsxAttribute]) -> AnnotationXmlEncoding {
    let mut encoding = AnnotationXmlEncoding::Other;
    for attribute in attributes {
        match attribute {
            JsxAttribute::Spread { .. } => encoding = AnnotationXmlEncoding::Dynamic,
            JsxAttribute::Named { name, value, .. } if name.eq_ignore_ascii_case("encoding") => {
                encoding = match value {
                    JsxAttributeValue::Text(value)
                        if matches!(
                            value.to_ascii_lowercase().as_str(),
                            "text/html" | "application/xhtml+xml"
                        ) =>
                    {
                        AnnotationXmlEncoding::Html
                    }
                    JsxAttributeValue::Expression(_) | JsxAttributeValue::Node(_) => {
                        AnnotationXmlEncoding::Dynamic
                    }
                    JsxAttributeValue::ImplicitTrue | JsxAttributeValue::Text(_) => {
                        AnnotationXmlEncoding::Other
                    }
                };
            }
            JsxAttribute::Named { .. } => {}
        }
    }
    encoding
}

fn normalize_attribute_name(tag: &str, name: &str, namespace: DomNamespace) -> String {
    if tag.eq_ignore_ascii_case("annotation-xml") && name.eq_ignore_ascii_case("encoding") {
        return "encoding".to_owned();
    }
    match name {
        "className" => return "class".to_owned(),
        "htmlFor" => return "for".to_owned(),
        _ => {}
    }
    if namespace != DomNamespace::Svg {
        return name.to_owned();
    }
    match name {
        "xmlnsXlink" => "xmlns:xlink",
        "strokeWidth" => "stroke-width",
        "strokeLinecap" => "stroke-linecap",
        "strokeLinejoin" => "stroke-linejoin",
        "strokeDasharray" => "stroke-dasharray",
        "strokeDashoffset" => "stroke-dashoffset",
        "strokeOpacity" => "stroke-opacity",
        "fillOpacity" => "fill-opacity",
        "fillRule" => "fill-rule",
        "clipRule" => "clip-rule",
        "transformOrigin" => "transform-origin",
        "clipPath" => "clip-path",
        "textAnchor" => "text-anchor",
        "dominantBaseline" => "dominant-baseline",
        "fontSize" => "font-size",
        "fontFamily" => "font-family",
        "fontWeight" => "font-weight",
        "xlinkHref" => "xlink:href",
        "stopColor" => "stop-color",
        "stopOpacity" => "stop-opacity",
        "markerStart" => "marker-start",
        "markerMid" => "marker-mid",
        "markerEnd" => "marker-end",
        "vectorEffect" => "vector-effect",
        _ => name,
    }
    .to_owned()
}

fn is_implicit_table_child(
    parent_tag: Option<&str>,
    parent_namespace: DomNamespace,
    child: &JsxChild,
    expected: &str,
) -> bool {
    if parent_namespace != DomNamespace::Html
        || !parent_tag.is_some_and(|tag| tag.eq_ignore_ascii_case("table"))
    {
        return false;
    }
    matches!(
        child,
        JsxChild::Node(node)
            if matches!(
                node.as_ref(),
                JsxNode::Element(element)
                    if matches!(&element.name, JsxElementName::Intrinsic(tag) if tag.eq_ignore_ascii_case(expected))
            )
    )
}

fn renderable_child(child: &JsxChild) -> bool {
    !matches!(child, JsxChild::Text { value, .. } if value.is_empty())
}

fn is_html_void_element(tag: &str, namespace: DomNamespace) -> bool {
    namespace == DomNamespace::Html
        && matches!(
            tag.to_ascii_lowercase().as_str(),
            "area"
                | "base"
                | "br"
                | "col"
                | "embed"
                | "hr"
                | "img"
                | "input"
                | "link"
                | "meta"
                | "param"
                | "source"
                | "track"
                | "wbr"
        )
}

fn is_standalone_svg_tag(tag: &str) -> bool {
    matches!(
        tag,
        "animate"
            | "animatemotion"
            | "animatetransform"
            | "circle"
            | "clippath"
            | "defs"
            | "desc"
            | "ellipse"
            | "feblend"
            | "fecolormatrix"
            | "fecomponenttransfer"
            | "fecomposite"
            | "feconvolvematrix"
            | "fediffuselighting"
            | "fedisplacementmap"
            | "fedistantlight"
            | "fedropshadow"
            | "feflood"
            | "fefunca"
            | "fefuncb"
            | "fefuncg"
            | "fefuncr"
            | "fegaussianblur"
            | "feimage"
            | "femerge"
            | "femergenode"
            | "femorphology"
            | "feoffset"
            | "fepointlight"
            | "fespecularlighting"
            | "fespotlight"
            | "fetile"
            | "feturbulence"
            | "filter"
            | "g"
            | "image"
            | "line"
            | "lineargradient"
            | "marker"
            | "mask"
            | "metadata"
            | "mpath"
            | "path"
            | "pattern"
            | "polygon"
            | "polyline"
            | "radialgradient"
            | "rect"
            | "set"
            | "stop"
            | "switch"
            | "symbol"
            | "text"
            | "textpath"
            | "tspan"
            | "use"
            | "view"
    )
}

fn is_standalone_mathml_tag(tag: &str) -> bool {
    matches!(
        tag,
        "mi" | "mo"
            | "mn"
            | "ms"
            | "mtext"
            | "annotation"
            | "maction"
            | "maligngroup"
            | "malignmark"
            | "menclose"
            | "merror"
            | "mfenced"
            | "mfrac"
            | "mglyph"
            | "mlabeledtr"
            | "mlongdiv"
            | "mmultiscripts"
            | "mover"
            | "mpadded"
            | "mphantom"
            | "mroot"
            | "mrow"
            | "msgroup"
            | "msline"
            | "mspace"
            | "msqrt"
            | "msrow"
            | "mstack"
            | "mstyle"
            | "msub"
            | "msubsup"
            | "msup"
            | "mtable"
            | "mtd"
            | "mtr"
            | "munder"
            | "munderover"
            | "semantics"
    )
}

fn resolved_element(
    root: EmitTemporaryId,
    path: Vec<u32>,
    resolved: &mut BTreeMap<Vec<u32>, EmitTemporaryId>,
    temporaries: &mut Vec<EmitTemporary>,
    temporary_names: &mut NameAllocator,
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
        temporary_names,
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

fn is_runtime_helper_call(
    hir: &HirFile,
    call: &fict_hir::CallInstruction,
    helper: RuntimeHelper,
) -> bool {
    let CallHost::Binding(binding) = call.host else {
        return false;
    };
    let Some(import) = hir
        .bindings
        .get(binding.as_usize())
        .and_then(|binding| binding.import.as_ref())
    else {
        return false;
    };
    let ImportedName::Named(name) = &import.imported else {
        return false;
    };
    let spec = helper.spec();
    name == spec.export
        && [RuntimeFamily::Fict, RuntimeFamily::Runtime]
            .into_iter()
            .any(|family| import.source == spec.module_request(family))
}

fn function_value(function: &fict_hir::HirFunction, value: ValueId) -> Option<FunctionId> {
    match function.values.get(value.as_usize())?.kind {
        ValueKind::Function(function) => Some(function),
        _ => None,
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
    names: &mut NameAllocator,
    preferred: String,
    origin: fict_hir::Origin,
) -> EmitTemporaryId {
    let id = EmitTemporaryId::new(count_u32(temporaries.len()));
    let name = names.allocate(&preferred);
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

fn reactive_site_origin(function: &fict_hir::HirFunction, result: ValueId) -> fict_hir::Origin {
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

#[cfg(test)]
mod namespace_tests {
    use super::*;
    use fict_diagnostics::SourceSpan;
    use fict_hir::{JsxElement, Origin};

    fn test_origin() -> Origin {
        Origin::source(SourceSpan::empty(0))
    }

    fn element(tag: &str, attributes: Vec<JsxAttribute>, children: Vec<JsxChild>) -> JsxNode {
        JsxNode::Element(JsxElement {
            name: JsxElementName::Intrinsic(tag.to_owned()),
            attributes,
            children,
            origin: test_origin(),
        })
    }

    fn node(node: JsxNode) -> JsxChild {
        JsxChild::Node(Box::new(node))
    }

    fn spread(value: u32) -> JsxAttribute {
        JsxAttribute::Spread {
            value: ValueId::new(value),
            origin: test_origin(),
        }
    }

    fn expression(value: u32) -> JsxChild {
        JsxChild::Expression {
            value: ValueId::new(value),
            origin: test_origin(),
        }
    }

    #[test]
    fn resolves_svg_integration_points_and_normalizes_attributes() {
        let root = element(
            "svg",
            Vec::new(),
            vec![
                node(element(
                    "path",
                    vec![
                        JsxAttribute::Named {
                            name: "strokeWidth".into(),
                            value: JsxAttributeValue::Text("2".into()),
                            origin: test_origin(),
                        },
                        JsxAttribute::Named {
                            name: "xlinkHref".into(),
                            value: JsxAttributeValue::Expression(ValueId::new(9)),
                            origin: test_origin(),
                        },
                        spread(0),
                    ],
                    Vec::new(),
                )),
                node(element(
                    "foreignObject",
                    Vec::new(),
                    vec![node(element("div", vec![spread(1)], Vec::new()))],
                )),
                node(element(
                    "title",
                    Vec::new(),
                    vec![node(element("span", vec![spread(2)], Vec::new()))],
                )),
                node(element("math", vec![spread(3)], Vec::new())),
            ],
        );
        let serialized = serialize_template(&root).expect("SVG namespace serialization");
        assert_eq!(serialized.namespace, DomNamespace::Svg);
        assert!(serialized.html.contains("stroke-width=\"2\""));
        assert!(serialized.bindings.iter().any(|binding| matches!(
            binding,
            TemplateBinding::Attribute { name, .. } if name == "xlink:href"
        )));
        let spread_namespaces: Vec<_> = serialized
            .bindings
            .iter()
            .filter_map(|binding| match binding {
                TemplateBinding::Spread { namespace, .. } => Some(*namespace),
                _ => None,
            })
            .collect();
        assert_eq!(
            spread_namespaces,
            [
                DomNamespace::Svg,
                DomNamespace::Html,
                DomNamespace::Html,
                DomNamespace::Svg,
            ]
        );
    }

    #[test]
    fn resolves_mathml_text_annotation_and_runtime_parent_contexts() {
        let root = element(
            "math",
            Vec::new(),
            vec![
                node(element(
                    "mtext",
                    Vec::new(),
                    vec![
                        node(element("span", vec![spread(0)], Vec::new())),
                        node(element("mglyph", vec![spread(1)], Vec::new())),
                        expression(10),
                    ],
                )),
                node(element(
                    "annotation-xml",
                    vec![JsxAttribute::Named {
                        name: "ENCODING".into(),
                        value: JsxAttributeValue::Text("text/html".into()),
                        origin: test_origin(),
                    }],
                    vec![node(element("div", vec![spread(2)], Vec::new()))],
                )),
                node(element(
                    "annotation-xml",
                    vec![JsxAttribute::Named {
                        name: "encoding".into(),
                        value: JsxAttributeValue::Text("application/xml".into()),
                        origin: test_origin(),
                    }],
                    vec![node(element("mi", vec![spread(3)], Vec::new()))],
                )),
                node(element(
                    "annotation-xml",
                    vec![JsxAttribute::Named {
                        name: "encoding".into(),
                        value: JsxAttributeValue::Expression(ValueId::new(11)),
                        origin: test_origin(),
                    }],
                    vec![expression(12)],
                )),
            ],
        );
        let serialized = serialize_template(&root).expect("MathML namespace serialization");
        assert_eq!(serialized.namespace, DomNamespace::MathMl);
        let spread_namespaces: Vec<_> = serialized
            .bindings
            .iter()
            .filter_map(|binding| match binding {
                TemplateBinding::Spread { namespace, .. } => Some(*namespace),
                _ => None,
            })
            .collect();
        assert_eq!(
            spread_namespaces,
            [
                DomNamespace::Html,
                DomNamespace::MathMl,
                DomNamespace::Html,
                DomNamespace::MathMl,
            ]
        );
        assert!(serialized.bindings.iter().any(|binding| matches!(
            binding,
            TemplateBinding::Child {
                value,
                namespace: DomNamespace::MathMlTextIntegration,
                ..
            } if *value == ValueId::new(10)
        )));
        assert!(serialized.bindings.iter().any(|binding| matches!(
            binding,
            TemplateBinding::Child {
                value,
                namespace: DomNamespace::Parent,
                ..
            } if *value == ValueId::new(12)
        )));
    }

    #[test]
    fn materializes_implicit_table_groups_and_browser_paths() {
        let root = element(
            "table",
            Vec::new(),
            vec![
                node(element("col", vec![spread(0)], Vec::new())),
                node(element("col", Vec::new(), Vec::new())),
                node(element(
                    "tr",
                    Vec::new(),
                    vec![node(element("td", vec![spread(1)], Vec::new()))],
                )),
                node(element(
                    "tr",
                    Vec::new(),
                    vec![node(element("td", vec![spread(2)], Vec::new()))],
                )),
            ],
        );
        let serialized = serialize_template(&root).expect("table parser serialization");
        assert_eq!(
            serialized.html,
            "<table><colgroup><col><col></colgroup><tbody><tr><td></td></tr><tr><td></td></tr></tbody></table>"
        );
        let paths: Vec<_> = serialized
            .bindings
            .iter()
            .filter_map(|binding| match binding {
                TemplateBinding::Spread { path, .. } => Some(path.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(paths, [vec![0, 0], vec![1, 0, 0], vec![1, 1, 0]]);
    }

    #[test]
    fn rejects_static_children_when_annotation_namespace_is_runtime_selected() {
        let root = element(
            "math",
            Vec::new(),
            vec![node(element(
                "annotation-xml",
                vec![spread(0)],
                vec![node(element("mi", Vec::new(), Vec::new()))],
            ))],
        );
        let diagnostics = serialize_template(&root).expect_err("must fail closed");
        assert!(
            diagnostics
                .as_slice()
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == "FICT-EMIT-NAMESPACE-DYNAMIC")
        );
    }

    #[test]
    fn classifies_standalone_foreign_roots_and_rejects_void_children() {
        assert_eq!(
            serialize_template(&element("circle", Vec::new(), Vec::new()))
                .expect("standalone SVG")
                .namespace,
            DomNamespace::Svg
        );
        assert_eq!(
            serialize_template(&element("mi", Vec::new(), Vec::new()))
                .expect("standalone MathML")
                .namespace,
            DomNamespace::MathMl
        );
        let invalid = element(
            "input",
            Vec::new(),
            vec![JsxChild::Text {
                value: "child".into(),
                origin: test_origin(),
            }],
        );
        let diagnostics = serialize_template(&invalid).expect_err("void child is invalid");
        assert!(
            diagnostics
                .as_slice()
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == "FICT-EMIT-VOID-CHILD")
        );
    }
}
