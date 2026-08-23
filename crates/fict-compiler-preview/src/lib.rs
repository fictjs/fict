#![forbid(unsafe_code)]

//! Optional resumability and handler-artifact passes outside the stable Core pipeline.

use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_emit::{
    DELEGATED_EVENTS, EmitOperation, EmitPreviewComponent, EmitPreviewHandler,
    EmitPreviewLexicalCapture, EmitPreviewLocalHandler, EmitPreviewModuleCapture, EmitPreviewPlan,
    EmitPreviewPropCapture, EmitPreviewPropRestCapture, EmitProgram, EmitPropBinding, EmitValueRef,
    EventOptions, ReactiveSlotKind, ReactiveSlotStorage, RuntimeHelper, RuntimeImportIntent,
    parse_event_attribute,
};
use fict_hir::{
    BindingId, BindingKind, ContextValueKind, DeclarationKind, FunctionId, FunctionKind, HirFile,
    HirInstructionKind, JsxAttribute, JsxAttributeValue, JsxChild, JsxElementName, JsxNode,
    LocalKind, Origin, PlaceBase, ValueId, ValueKind,
};

/// Host-independent Preview controls consumed after stable Core lowering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewOptions {
    pub source_module_id: String,
    pub auto_extract_handlers: bool,
    pub auto_extract_threshold: u32,
    pub public_module_id: Option<String>,
}

/// Attach deterministic resumable handler/component plans to verified Core EmitIR.
///
/// This pass owns no frontend AST. OXC consumes the structured origins and identities later.
/// Returns non-fatal findings on success; the caller's diagnostic policy may
/// escalate fallback findings after the plan is attached. Fatal diagnostics
/// abort the plan immediately.
pub fn attach_preview_plan(
    hir: &HirFile,
    emit: &mut EmitProgram,
    options: &PreviewOptions,
) -> Result<Vec<Diagnostic>, DiagnosticBundle> {
    let mut diagnostics = Vec::new();
    let mut advisories = Vec::new();
    let mut reserved: BTreeSet<String> = emit.module.reserved_names.iter().cloned().collect();
    let mut handler_index = 0_u32;
    let mut dependency_index = 0_u32;
    let mut handlers = Vec::new();
    let signal_owners: BTreeMap<_, _> = emit
        .functions
        .iter()
        .flat_map(|function| {
            function.slots.iter().filter_map(move |slot| {
                (slot.kind == ReactiveSlotKind::Signal
                    && slot.storage == ReactiveSlotStorage::Owned)
                    .then_some(slot.binding)
                    .flatten()
                    .map(|binding| (binding, function.source))
            })
        })
        .collect();
    let keyed_render_parameters = keyed_render_parameter_bindings(hir, emit);

    for owner_emit in &emit.functions {
        let Some(owner) = hir.functions.get(owner_emit.source.as_usize()) else {
            continue;
        };
        for candidate in preview_event_candidates(hir, owner_emit) {
            let Some(handler_origin) = candidate.origin.primary_span else {
                continue;
            };
            let handler_function = resolve_handler_function(hir, owner, &candidate.handler);
            let automatically_selected = options.auto_extract_handlers
                && should_auto_extract_handler(
                    hir,
                    owner,
                    &candidate.handler,
                    candidate.origin,
                    handler_function,
                    options.auto_extract_threshold,
                );
            if !candidate.explicit && !automatically_selected {
                continue;
            }

            macro_rules! reject_handler {
                ($diagnostic:expr) => {{
                    let diagnostic = $diagnostic;
                    if candidate.explicit {
                        diagnostics.push(diagnostic);
                    } else {
                        advisories
                            .push(preview_eager_fallback_warning(diagnostic, &candidate.event));
                    }
                    continue;
                }};
            }

            if !candidate.options.is_empty() {
                reject_handler!(
                    preview_error(
                        "FICT-PREVIEW-EVENT-OPTIONS",
                        format!(
                            "resumable event handler on:{} does not support event options ({})",
                            candidate.event,
                            event_option_labels(candidate.options).join(", ")
                        ),
                    )
                    .with_primary_span(handler_origin)
                    .with_help("remove the `$` suffix or the event modifier")
                );
            }
            if !DELEGATED_EVENTS.contains(&candidate.event.as_str()) {
                reject_handler!(
                    preview_error(
                        "FICT-PREVIEW-EVENT-LOADER",
                        format!(
                            "resumable event handler on:{} is not observed by the default loader",
                            candidate.event
                        ),
                    )
                    .with_primary_span(handler_origin)
                    .with_help(
                        "remove the `$` suffix or configure the loader to observe this event",
                    )
                );
            }

            if handler_is_member_read(owner, &candidate.handler) {
                reject_handler!(
                    preview_error(
                        "FICT-PREVIEW-HANDLER",
                        "resumable handlers cannot use member-expression handler values because the member read must run during render",
                    )
                    .with_primary_span(handler_origin)
                    .with_help(
                        "store the handler in a stable function binding, or remove the `$` suffix",
                    )
                );
            }

            let suspension_contexts =
                handler_expression_suspensions(hir, owner, candidate.origin, handler_function);
            if !suspension_contexts.is_empty() {
                reject_handler!(
                    preview_error(
                        "FICT-PREVIEW-CONTEXT",
                        format!(
                            "resumable handler factory expression cannot move suspension context into an isolated artifact: {}",
                            suspension_contexts.join(", ")
                        ),
                    )
                    .with_primary_span(handler_origin)
                    .with_help(
                        "wrap the suspended work in an async or generator event handler, or remove the `$` suffix",
                    )
                );
            }

            let direct_handler_binding = handler_binding(owner, &candidate.handler);
            let module_handler_binding =
                direct_handler_binding.filter(|binding| binding_is_module_scoped(hir, *binding));
            if module_handler_binding
                .is_some_and(|binding| !is_stable_module_handler_binding(hir, binding))
            {
                let name = module_handler_binding
                    .and_then(|binding| hir.bindings.get(binding.as_usize()))
                    .map_or("<unknown>", |binding| binding.display_name.as_str());
                reject_handler!(
                    preview_error(
                        "FICT-PREVIEW-HANDLER",
                        format!(
                            "resumable handlers cannot use mutable module handler identifier `{name}`"
                        ),
                    )
                    .with_primary_span(handler_origin)
                    .with_help(
                        "use a module const/function/class binding, or remove the `$` suffix",
                    )
                );
            }

            let local_handler_binding =
                direct_handler_binding.filter(|binding| module_handler_binding != Some(*binding));
            let local_handler = local_handler_binding.and_then(|binding| {
                let binding_info = hir.bindings.get(binding.as_usize())?;
                let function =
                    handler_function.and_then(|function| hir.functions.get(function.as_usize()))?;
                (matches!(
                    binding_info.kind,
                    BindingKind::Const | BindingKind::Function
                ) && function.binding == Some(binding)
                    && !local_function_has_runtime_mutation(hir, owner, binding))
                .then(|| EmitPreviewLocalHandler {
                    binding,
                    local: binding_info.display_name.clone(),
                    function: function.id,
                    definition_origin: function.origin,
                })
            });
            if local_handler_binding.is_some() && local_handler.is_none() {
                let name = local_handler_binding
                    .and_then(|binding| hir.bindings.get(binding.as_usize()))
                    .map_or("<unknown>", |binding| binding.display_name.as_str());
                reject_handler!(
                    preview_error(
                        "FICT-PREVIEW-HANDLER",
                        format!(
                            "resumable handlers cannot use mutable or aliased local handler identifier `{name}`"
                        ),
                    )
                    .with_primary_span(handler_origin)
                    .with_help(
                        "use a local const initialized directly with a function, a function declaration, or remove the `$` suffix",
                    )
                );
            }

            let context_captures = handler_context_captures(
                hir,
                owner,
                &candidate.handler,
                candidate.origin,
                handler_function,
            );
            if !context_captures.is_empty() {
                reject_handler!(
                    preview_error(
                        "FICT-PREVIEW-CONTEXT",
                        format!(
                            "resumable handler captures lexical execution context: {}",
                            context_captures
                                .iter()
                                .map(|kind| context_value_label(*kind))
                                .collect::<Vec<_>>()
                                .join(", ")
                        ),
                    )
                    .with_primary_span(handler_origin)
                    .with_help(
                        "use an ordinary function with its own dynamic context, or remove the `$` suffix",
                    )
                );
            }

            let mut captures = handler_captured_bindings(
                hir,
                owner,
                &candidate.handler,
                candidate.origin,
                handler_function,
            );
            let (local_functions, local_function_contexts) = expand_local_function_dependencies(
                hir,
                owner,
                local_handler.as_ref().map(|handler| handler.binding),
                &mut captures,
            );
            if !local_function_contexts.is_empty() {
                reject_handler!(
                    preview_error(
                        "FICT-PREVIEW-CONTEXT",
                        format!(
                            "resumable handler function dependencies capture lexical execution context: {}",
                            local_function_contexts.join(", ")
                        ),
                    )
                    .with_primary_span(handler_origin)
                    .with_help(
                        "use ordinary helper functions with their own dynamic context, or remove the `$` suffix",
                    )
                );
            }
            let keyed_alias_captures: Vec<_> = captures
                .intersection(&keyed_render_parameters)
                .filter_map(|binding| hir.bindings.get(binding.as_usize()))
                .map(|binding| binding.display_name.as_str())
                .collect();
            if !keyed_alias_captures.is_empty() {
                reject_handler!(
                    preview_error(
                        "FICT-PREVIEW-CAPTURE",
                        format!(
                            "resumable handler captures values that cannot be restored: non-serializable locals: {}",
                            keyed_alias_captures.join(", ")
                        ),
                    )
                    .with_primary_span(handler_origin)
                    .with_help(
                        "keyed-list item and index aliases exist only while rendering an item; remove the `$` suffix to keep the handler eager",
                    )
                );
            }
            let local_function_bindings: BTreeSet<_> = local_functions
                .iter()
                .map(|function| function.binding)
                .collect();
            let non_serializable_signals = non_serializable_signal_bindings(owner, owner_emit);
            let slot_bindings: BTreeMap<_, _> = owner_emit
                .slots
                .iter()
                .filter(|slot| {
                    !matches!(
                        slot.storage,
                        ReactiveSlotStorage::Imported { .. }
                            | ReactiveSlotStorage::HookReturn { .. }
                    )
                })
                .filter_map(|slot| {
                    slot.binding.map(|binding| {
                        (
                            binding,
                            (
                                hir.bindings[binding.as_usize()].display_name.clone(),
                                slot.storage,
                            ),
                        )
                    })
                })
                .collect();
            let prop_bindings: BTreeMap<_, _> = owner_emit
                .props
                .iter()
                .flat_map(|props| &props.bindings)
                .map(|prop| (prop.binding, prop))
                .collect();
            expand_prop_default_dependencies(&prop_bindings, &mut captures);
            let props_parameter_binding = owner
                .parameters
                .first()
                .and_then(|parameter| parameter.binding);
            let function_prop_calls = handler_prop_calls(
                hir,
                owner,
                handler_function,
                &local_functions,
                candidate.origin,
                props_parameter_binding,
                &prop_bindings,
            );
            if !function_prop_calls.is_empty() {
                reject_handler!(
                    preview_error(
                        "FICT-PREVIEW-PROP-CALL",
                        format!(
                            "resumable handlers cannot call function props: {}",
                            function_prop_calls.join(", ")
                        ),
                    )
                    .with_primary_span(handler_origin)
                    .with_help(
                        "dispatch through a serializable signal or keep this handler eager by removing the `$` suffix",
                    )
                );
            }
            let prop_rest_binding = owner_emit
                .props
                .as_ref()
                .and_then(|props| props.rest.as_ref())
                .map(|rest| (rest.binding, rest));
            let props_parameter =
                props_parameter_binding.filter(|binding| captures.contains(binding));

            let mut lexical_captures = Vec::new();
            let mut prop_captures = Vec::new();
            let mut prop_rest_captures = Vec::new();
            let mut module_captures = Vec::new();
            if let Some(binding) = module_handler_binding {
                let binding_info = &hir.bindings[binding.as_usize()];
                let source_export_name =
                    allocate_indexed(&mut reserved, "__fict_dep_", &mut dependency_index);
                module_captures.push(EmitPreviewModuleCapture {
                    binding,
                    local: binding_info.display_name.clone(),
                    source_export_name,
                });
            }
            let mut unsupported = Vec::new();
            let mut unsafe_signals = Vec::new();
            let mut outer_signals = Vec::new();
            for binding in captures {
                let Some(binding_info) = hir.bindings.get(binding.as_usize()) else {
                    continue;
                };
                if local_handler
                    .as_ref()
                    .is_some_and(|handler| handler.binding == binding)
                    || local_function_bindings.contains(&binding)
                {
                    continue;
                }
                if let Some((local, storage)) = slot_bindings.get(&binding) {
                    if matches!(storage, ReactiveSlotStorage::Captured { .. }) {
                        outer_signals.push(local.clone());
                        continue;
                    }
                    if non_serializable_signals.contains(&binding) {
                        unsafe_signals.push(local.clone());
                        continue;
                    }
                    lexical_captures.push(EmitPreviewLexicalCapture {
                        binding,
                        local: local.clone(),
                    });
                    continue;
                }
                if signal_owners
                    .get(&binding)
                    .is_some_and(|owner| *owner != owner_emit.source)
                {
                    outer_signals.push(binding_info.display_name.clone());
                    continue;
                }
                if let Some(prop) = prop_bindings.get(&binding) {
                    prop_captures.push(EmitPreviewPropCapture {
                        binding,
                        local: prop.local.clone(),
                        path: prop.path.clone(),
                        mode: prop.mode,
                        default_value: prop.default_value,
                    });
                    continue;
                }
                if let Some((_, rest)) =
                    prop_rest_binding.filter(|(candidate, _)| *candidate == binding)
                {
                    prop_rest_captures.push(EmitPreviewPropRestCapture {
                        binding,
                        local: rest.local.clone(),
                        excluded: rest.excluded.clone(),
                    });
                    continue;
                }
                if props_parameter == Some(binding) {
                    continue;
                }
                if is_stable_module_binding(hir, binding) {
                    if module_captures
                        .iter()
                        .any(|capture| capture.binding == binding)
                    {
                        continue;
                    }
                    let source_export_name =
                        allocate_indexed(&mut reserved, "__fict_dep_", &mut dependency_index);
                    module_captures.push(EmitPreviewModuleCapture {
                        binding,
                        local: binding_info.display_name.clone(),
                        source_export_name,
                    });
                    continue;
                }
                unsupported.push(binding_info.display_name.clone());
            }

            if !unsupported.is_empty() || !unsafe_signals.is_empty() || !outer_signals.is_empty() {
                unsupported.sort();
                unsafe_signals.sort();
                outer_signals.sort();
                let mut details = Vec::new();
                if !unsupported.is_empty() {
                    details.push(format!(
                        "non-serializable locals: {}",
                        unsupported.join(", ")
                    ));
                }
                if !unsafe_signals.is_empty() {
                    details.push(format!("signals: {}", unsafe_signals.join(", ")));
                }
                if !outer_signals.is_empty() {
                    details.push(format!("outer signals: {}", outer_signals.join(", ")));
                }
                reject_handler!(
                    preview_error(
                        "FICT-PREVIEW-CAPTURE",
                        format!(
                            "resumable handler captures values that cannot be restored: {}",
                            details.join("; ")
                        ),
                    )
                    .with_primary_span(handler_origin)
                    .with_help("use only component-owned serializable signals, serializable props, or stable module bindings; otherwise remove the `$` suffix")
                );
            }

            lexical_captures.sort_by_key(|capture| capture.binding);
            prop_captures.sort_by_key(|capture| capture.binding);
            prop_rest_captures.sort_by_key(|capture| capture.binding);
            module_captures.sort_by_key(|capture| capture.binding);
            let source_export_name =
                allocate_indexed(&mut reserved, "__fict_e", &mut handler_index);
            let artifact_id = format!("handler-{}", handlers.len());
            handlers.push(EmitPreviewHandler {
                owner: owner_emit.source,
                handler_function,
                handler_origin: candidate.origin,
                event: candidate.event,
                explicit: candidate.explicit,
                prevent_default: handler_function
                    .is_some_and(|function| function_may_prevent_default(hir, function)),
                source_export_name,
                module_specifier: format!("fict:compiler-artifact:{artifact_id}"),
                artifact_id,
                lexical_captures,
                prop_captures,
                prop_rest_captures,
                props_object_local: props_parameter
                    .map(|binding| hir.bindings[binding.as_usize()].display_name.clone()),
                module_captures,
                local_handler,
                local_functions,
            });
        }
    }

    if !diagnostics.is_empty() {
        return Err(DiagnosticBundle::new(diagnostics));
    }

    let mut resume_index = 0_u32;
    let mut components = Vec::new();
    for function in &hir.functions {
        if function.kind != FunctionKind::Component {
            continue;
        }
        let Some(binding) = function.binding else {
            continue;
        };
        let Some(binding) = hir.bindings.get(binding.as_usize()) else {
            continue;
        };
        if !hir
            .scopes
            .get(binding.scope.as_usize())
            .is_some_and(|scope| scope.kind == fict_hir::ScopeKind::Module)
        {
            continue;
        }
        let metadata_local = allocate_name(
            &mut reserved,
            &format!("__fict_meta_{}", binding.display_name),
        );
        components.push(EmitPreviewComponent {
            function: function.id,
            name: binding.display_name.clone(),
            resume_export_name: allocate_indexed(&mut reserved, "__fict_r", &mut resume_index),
            metadata_local,
            origin: function.origin,
        });
    }

    let mut helpers = BTreeSet::new();
    if !handlers.is_empty() || !components.is_empty() {
        helpers.insert(RuntimeHelper::Qrl);
    }
    if handlers
        .iter()
        .any(|handler| !handler.lexical_captures.is_empty())
    {
        helpers.insert(RuntimeHelper::UseLexicalScope);
    }
    if handlers.iter().any(|handler| {
        handler.props_object_local.is_some()
            || !handler.prop_captures.is_empty()
            || !handler.prop_rest_captures.is_empty()
    }) {
        helpers.insert(RuntimeHelper::GetScopeProps);
    }
    if handlers
        .iter()
        .any(|handler| !handler.prop_rest_captures.is_empty())
    {
        helpers.insert(RuntimeHelper::PropsRest);
    }
    if !components.is_empty() {
        helpers.extend([
            RuntimeHelper::GetSSRScope,
            RuntimeHelper::EnsureScope,
            RuntimeHelper::PrepareContext,
            RuntimeHelper::PushContext,
            RuntimeHelper::PopContext,
            RuntimeHelper::HydrateComponent,
            RuntimeHelper::SetComponentMeta,
            RuntimeHelper::RegisterResume,
        ]);
    }
    let helpers: Vec<_> = helpers.into_iter().collect();
    for helper in &helpers {
        ensure_runtime_import(emit, &mut reserved, *helper);
    }
    emit.imports.sort_by_key(|intent| intent.helper);
    emit.module.reserved_names = reserved.into_iter().collect();
    emit.preview = true;
    emit.preview_plan = Some(EmitPreviewPlan {
        source_module_id: options.source_module_id.clone(),
        public_module_id: options.public_module_id.clone(),
        helpers,
        handlers,
        components,
    });
    Ok(advisories)
}

fn keyed_render_parameter_bindings(hir: &HirFile, emit: &EmitProgram) -> BTreeSet<BindingId> {
    emit.functions
        .iter()
        .flat_map(|function| &function.operations)
        .filter_map(|operation| match operation {
            EmitOperation::KeyedChild { render, .. } | EmitOperation::KeyedList { render, .. } => {
                Some(*render)
            }
            _ => None,
        })
        .filter_map(|render| hir.functions.get(render.as_usize()))
        .flat_map(|render| &render.locals)
        .filter(|local| local.declaration_kind == DeclarationKind::Parameter)
        .filter_map(|local| local.binding)
        .collect()
}

#[derive(Debug, Clone)]
struct PreviewEventCandidate {
    event: String,
    handler: EmitValueRef,
    options: EventOptions,
    explicit: bool,
    origin: Origin,
}

fn preview_event_candidates(
    hir: &HirFile,
    owner_emit: &fict_emit::EmitFunction,
) -> Vec<PreviewEventCandidate> {
    let mut candidates = Vec::new();
    let mut seen = BTreeSet::new();
    for operation in &owner_emit.operations {
        let EmitOperation::BindEvent {
            event,
            handler,
            options,
            resumable_explicit,
            origin,
            ..
        } = operation
        else {
            continue;
        };
        push_event_candidate(
            &mut candidates,
            &mut seen,
            PreviewEventCandidate {
                event: event.clone(),
                handler: handler.clone(),
                options: *options,
                explicit: *resumable_explicit,
                origin: *origin,
            },
        );
    }
    let Some(owner) = hir.functions.get(owner_emit.source.as_usize()) else {
        return candidates;
    };
    for template in hir
        .templates
        .iter()
        .filter(|template| template.owner == owner_emit.source)
    {
        collect_template_event_candidates(owner, &template.root, &mut candidates, &mut seen);
    }
    candidates.sort_by_key(|candidate| {
        candidate
            .origin
            .primary_span
            .map_or((u32::MAX, u32::MAX), |span| (span.start(), span.end()))
    });
    candidates
}

fn push_event_candidate(
    candidates: &mut Vec<PreviewEventCandidate>,
    seen: &mut BTreeSet<(u32, u32, String)>,
    candidate: PreviewEventCandidate,
) {
    let Some(span) = candidate.origin.primary_span else {
        return;
    };
    if seen.insert((span.start(), span.end(), candidate.event.clone())) {
        candidates.push(candidate);
    }
}

fn collect_template_event_candidates(
    owner: &fict_hir::HirFunction,
    node: &JsxNode,
    candidates: &mut Vec<PreviewEventCandidate>,
    seen: &mut BTreeSet<(u32, u32, String)>,
) {
    let children = match node {
        JsxNode::Element(element) => {
            if matches!(element.name, JsxElementName::Intrinsic(_)) {
                for attribute in &element.attributes {
                    let JsxAttribute::Named { name, value, .. } = attribute else {
                        continue;
                    };
                    let Some((event, explicit, options)) = parse_event_attribute(name) else {
                        continue;
                    };
                    let JsxAttributeValue::Expression { value, .. } = value else {
                        continue;
                    };
                    let Some(origin) = owner.values.get(value.as_usize()).map(|value| value.origin)
                    else {
                        continue;
                    };
                    push_event_candidate(
                        candidates,
                        seen,
                        PreviewEventCandidate {
                            event,
                            handler: EmitValueRef::Hir(*value),
                            options,
                            explicit,
                            origin,
                        },
                    );
                }
            }
            for attribute in &element.attributes {
                if let JsxAttribute::Named {
                    value: JsxAttributeValue::Node(node),
                    ..
                } = attribute
                {
                    collect_template_event_candidates(owner, node, candidates, seen);
                }
            }
            &element.children
        }
        JsxNode::Fragment { children, .. } => children,
    };
    for child in children {
        match child {
            JsxChild::Node(node) => {
                collect_template_event_candidates(owner, node, candidates, seen);
            }
            JsxChild::Expression { embedded_nodes, .. } => {
                for node in embedded_nodes {
                    collect_template_event_candidates(owner, node, candidates, seen);
                }
            }
            JsxChild::Text { .. } | JsxChild::Spread { .. } => {}
        }
    }
}

fn event_option_labels(options: EventOptions) -> Vec<&'static str> {
    let mut labels = Vec::new();
    if options.capture {
        labels.push("capture");
    }
    if options.passive {
        labels.push("passive");
    }
    if options.once {
        labels.push("once");
    }
    labels
}

fn resolve_handler_function(
    hir: &HirFile,
    owner: &fict_hir::HirFunction,
    handler: &EmitValueRef,
) -> Option<FunctionId> {
    let EmitValueRef::Hir(value) = handler else {
        return None;
    };
    resolve_value_function(hir, owner, *value, &mut BTreeSet::new()).or_else(|| {
        let span = owner.values.get(value.as_usize())?.origin.primary_span?;
        hir.functions
            .iter()
            .filter(|candidate| candidate.id != owner.id)
            .find(|candidate| {
                candidate.origin.primary_span.is_some_and(|candidate_span| {
                    candidate_span.start() == span.start() && candidate_span.end() == span.end()
                })
            })
            .map(|candidate| candidate.id)
    })
}

fn resolve_value_function(
    hir: &HirFile,
    function: &fict_hir::HirFunction,
    value: ValueId,
    visited: &mut BTreeSet<ValueId>,
) -> Option<FunctionId> {
    if !visited.insert(value) {
        return None;
    }
    if let ValueKind::Function(nested) = function.values.get(value.as_usize())?.kind {
        return Some(nested);
    }
    let instruction = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find(|instruction| instruction.result == Some(value))?;
    if matches!(instruction.kind, HirInstructionKind::SyntaxFragment { .. }) {
        let origin = function.values.get(value.as_usize())?.origin.primary_span?;
        for candidate in function
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .rev()
            .filter_map(|candidate| candidate.result.map(|result| (candidate, result)))
            .filter(|(candidate, result)| {
                *result != value && candidate.origin.primary_span == Some(origin)
            })
        {
            if let Some(resolved) = resolve_value_function(hir, function, candidate.1, visited) {
                return Some(resolved);
            }
        }
        return None;
    }
    let HirInstructionKind::Read { place } = &instruction.kind else {
        return None;
    };
    if !place.projections.is_empty() {
        return None;
    }
    let local = match place.base {
        PlaceBase::Local(local) => local,
        PlaceBase::Ssa(name) => name.local,
        PlaceBase::Global(_) | PlaceBase::Value(_) => return None,
    };
    for declaration in function.blocks.iter().flat_map(|block| &block.instructions) {
        let HirInstructionKind::Declare {
            local: declared,
            initializer: Some(initializer),
            ..
        } = declaration.kind
        else {
            continue;
        };
        if declared == local {
            return resolve_value_function(hir, function, initializer, visited);
        }
    }
    let binding = function.locals.get(local.as_usize())?.binding?;
    hir.functions
        .iter()
        .find(|candidate| candidate.binding == Some(binding))
        .map(|candidate| candidate.id)
}

fn handler_node_count(hir: &HirFile, function: FunctionId) -> u32 {
    hir.functions
        .get(function.as_usize())
        .map(|function| {
            function
                .blocks
                .iter()
                .map(|block| block.instructions.len().saturating_add(1))
                .sum::<usize>()
        })
        .and_then(|count| u32::try_from(count).ok())
        .unwrap_or(u32::MAX)
}

fn should_auto_extract_handler(
    hir: &HirFile,
    owner: &fict_hir::HirFunction,
    handler: &EmitValueRef,
    origin: Origin,
    handler_function: Option<FunctionId>,
    threshold: u32,
) -> bool {
    if stable_bare_handler_binding(hir, owner, handler, handler_function) {
        return true;
    }
    if let Some(function) = handler_function {
        return function_has_auto_extract_trigger(hir, function)
            || handler_node_count(hir, function) >= threshold;
    }
    handler_expression_node_count(owner, origin) >= threshold
}

fn stable_bare_handler_binding(
    hir: &HirFile,
    owner: &fict_hir::HirFunction,
    handler: &EmitValueRef,
    handler_function: Option<FunctionId>,
) -> bool {
    let Some(binding_id) = handler_binding(owner, handler) else {
        return false;
    };
    if binding_is_module_scoped(hir, binding_id) {
        return is_stable_module_handler_binding(hir, binding_id);
    }
    let Some(function) =
        handler_function.and_then(|function| hir.functions.get(function.as_usize()))
    else {
        return false;
    };
    hir.bindings
        .get(binding_id.as_usize())
        .is_some_and(|binding| matches!(binding.kind, BindingKind::Const | BindingKind::Function))
        && function.binding == Some(binding_id)
        && function.parent == owner.id
        && !local_function_has_runtime_mutation(hir, owner, binding_id)
}

fn function_has_auto_extract_trigger(hir: &HirFile, root: FunctionId) -> bool {
    let mut visited = BTreeSet::new();
    let mut stack = vec![root];
    while let Some(function_id) = stack.pop() {
        if !visited.insert(function_id) {
            continue;
        }
        let Some(function) = hir.functions.get(function_id.as_usize()) else {
            continue;
        };
        if function.flags.is_async {
            return true;
        }
        stack.extend(
            hir.functions
                .iter()
                .filter(|child| child.parent == function_id)
                .map(|child| child.id),
        );
        if function
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .any(|instruction| match &instruction.kind {
                HirInstructionKind::Await { .. }
                | HirInstructionKind::DynamicImport { .. }
                | HirInstructionKind::New { .. }
                | HirInstructionKind::TaggedTemplate { .. } => true,
                HirInstructionKind::Call(call) => call_is_external(hir, function, call),
                _ => false,
            })
        {
            return true;
        }
    }
    false
}

fn call_is_external(
    hir: &HirFile,
    function: &fict_hir::HirFunction,
    call: &fict_hir::CallInstruction,
) -> bool {
    if call
        .callee_reference
        .as_ref()
        .is_some_and(|place| !place.projections.is_empty())
    {
        return true;
    }
    match call.host {
        fict_hir::CallHost::Binding(_) | fict_hir::CallHost::ReactiveScope(_) => true,
        fict_hir::CallHost::Function(_) => false,
        fict_hir::CallHost::Unknown => {
            if matches!(
                function
                    .values
                    .get(call.callee.as_usize())
                    .map(|value| &value.kind),
                Some(ValueKind::Function(_))
            ) {
                return false;
            }
            !value_global_name(hir, function, call.callee, &mut BTreeSet::new()).is_some_and(
                |name| matches!(name, "console" | "Math" | "JSON" | "Object" | "Array"),
            )
        }
    }
}

fn value_global_name<'hir>(
    hir: &'hir HirFile,
    function: &fict_hir::HirFunction,
    value: ValueId,
    visited: &mut BTreeSet<ValueId>,
) -> Option<&'hir str> {
    if !visited.insert(value) {
        return None;
    }
    let instruction = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find(|instruction| instruction.result == Some(value))?;
    match &instruction.kind {
        HirInstructionKind::Read { place } if place.projections.is_empty() => {
            let PlaceBase::Global(global) = place.base else {
                return None;
            };
            hir.globals
                .get(global.as_usize())
                .map(|global| global.name.as_str())
        }
        HirInstructionKind::SyntaxFragment { inputs, .. } => inputs
            .iter()
            .find_map(|input| value_global_name(hir, function, *input, visited)),
        _ => None,
    }
}

fn handler_expression_node_count(function: &fict_hir::HirFunction, origin: Origin) -> u32 {
    let Some(span) = origin.primary_span else {
        return 0;
    };
    let count = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .filter(|instruction| {
            instruction
                .origin
                .primary_span
                .is_some_and(|candidate| span_contains(span, candidate))
        })
        .count()
        .saturating_add(1);
    u32::try_from(count).unwrap_or(u32::MAX)
}

fn function_may_prevent_default(hir: &HirFile, root: FunctionId) -> bool {
    let Some(root_function) = hir.functions.get(root.as_usize()) else {
        return false;
    };
    let Some(event_parameter) = root_function
        .parameters
        .first()
        .and_then(|parameter| parameter.binding)
    else {
        return false;
    };
    let mut visited = BTreeSet::new();
    let mut stack = vec![root];
    while let Some(function_id) = stack.pop() {
        if !visited.insert(function_id) {
            continue;
        }
        let Some(function) = hir.functions.get(function_id.as_usize()) else {
            continue;
        };
        stack.extend(
            hir.functions
                .iter()
                .filter(|child| child.parent == function_id)
                .map(|child| child.id),
        );
        if function
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .filter_map(|instruction| match &instruction.kind {
                HirInstructionKind::Call(call) => call.callee_reference.as_ref(),
                _ => None,
            })
            .any(|callee| {
                place_binding(function, callee) == Some(event_parameter)
                    && match callee.projections.as_slice() {
                        [fict_hir::Projection::StaticProperty { name, .. }] => {
                            name == "preventDefault"
                        }
                        [fict_hir::Projection::ComputedProperty { key, .. }] => {
                            value_is_string(function, *key, "preventDefault")
                        }
                        [fict_hir::Projection::Index { .. }] | [] | [_, _, ..] => false,
                    }
            })
        {
            return true;
        }
    }
    false
}

fn value_is_string(function: &fict_hir::HirFunction, value: ValueId, expected: &str) -> bool {
    function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find(|instruction| instruction.result == Some(value))
        .is_some_and(|instruction| {
            matches!(
                &instruction.kind,
                HirInstructionKind::Literal(fict_hir::LiteralValue::String(value))
                    if value.to_utf8().as_deref() == Some(expected)
            )
        })
}

fn handler_is_member_read(function: &fict_hir::HirFunction, handler: &EmitValueRef) -> bool {
    let EmitValueRef::Hir(value) = handler else {
        return false;
    };
    value_is_member_read(function, *value, &mut BTreeSet::new())
}

fn handler_binding(function: &fict_hir::HirFunction, handler: &EmitValueRef) -> Option<BindingId> {
    let EmitValueRef::Hir(value) = handler else {
        return None;
    };
    value_read_binding(function, *value, &mut BTreeSet::new())
}

fn value_read_binding(
    function: &fict_hir::HirFunction,
    value: ValueId,
    visited: &mut BTreeSet<ValueId>,
) -> Option<BindingId> {
    if !visited.insert(value) {
        return None;
    }
    let instruction = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find(|instruction| instruction.result == Some(value))?;
    match &instruction.kind {
        HirInstructionKind::Read { place } if place.projections.is_empty() => {
            let local = match place.base {
                PlaceBase::Local(local) => local,
                PlaceBase::Ssa(name) => name.local,
                PlaceBase::Global(_) | PlaceBase::Value(_) => return None,
            };
            function.locals.get(local.as_usize())?.binding
        }
        HirInstructionKind::SyntaxFragment { .. } => {
            let origin = function.values.get(value.as_usize())?.origin.primary_span?;
            function
                .blocks
                .iter()
                .flat_map(|block| &block.instructions)
                .rev()
                .filter_map(|candidate| candidate.result.map(|result| (candidate, result)))
                .filter(|(candidate, result)| {
                    *result != value && candidate.origin.primary_span == Some(origin)
                })
                .find_map(|(_, result)| value_read_binding(function, result, visited))
        }
        _ => None,
    }
}

fn value_is_member_read(
    function: &fict_hir::HirFunction,
    value: ValueId,
    visited: &mut BTreeSet<ValueId>,
) -> bool {
    if !visited.insert(value) {
        return false;
    }
    let Some(instruction) = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find(|instruction| instruction.result == Some(value))
    else {
        return false;
    };
    match &instruction.kind {
        HirInstructionKind::Read { place } => !place.projections.is_empty(),
        HirInstructionKind::SyntaxFragment { .. } => {
            let Some(origin) = function
                .values
                .get(value.as_usize())
                .and_then(|value| value.origin.primary_span)
            else {
                return false;
            };
            function
                .blocks
                .iter()
                .flat_map(|block| &block.instructions)
                .rev()
                .filter_map(|candidate| candidate.result.map(|result| (candidate, result)))
                .filter(|(candidate, result)| {
                    *result != value && candidate.origin.primary_span == Some(origin)
                })
                .any(|(_, result)| value_is_member_read(function, result, visited))
        }
        _ => false,
    }
}

fn handler_context_captures(
    hir: &HirFile,
    owner: &fict_hir::HirFunction,
    handler: &EmitValueRef,
    origin: Origin,
    handler_function: Option<FunctionId>,
) -> BTreeSet<ContextValueKind> {
    if let Some(handler_function) = handler_function {
        let Some(function) = hir.functions.get(handler_function.as_usize()) else {
            return BTreeSet::new();
        };
        if !function.flags.is_arrow {
            return BTreeSet::new();
        }
        return arrow_context_captures(hir, handler_function);
    }

    let EmitValueRef::Hir(_) = handler else {
        return BTreeSet::new();
    };
    let Some(handler_span) = origin.primary_span else {
        return BTreeSet::new();
    };
    let mut captures = contexts_in_span(owner, handler_span);
    for child in hir.functions.iter().filter(|function| {
        function.parent == owner.id
            && function.flags.is_arrow
            && function.origin.primary_span.is_some_and(|span| {
                handler_span.start() <= span.start() && span.end() <= handler_span.end()
            })
    }) {
        captures.extend(arrow_context_captures(hir, child.id));
    }
    captures
}

fn handler_expression_suspensions(
    hir: &HirFile,
    owner: &fict_hir::HirFunction,
    origin: Origin,
    handler_function: Option<FunctionId>,
) -> Vec<&'static str> {
    if handler_function.is_some() {
        return Vec::new();
    }
    let Some(span) = origin.primary_span else {
        return Vec::new();
    };
    let mut suspensions = BTreeSet::new();
    for instruction in owner
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .filter(|instruction| {
            instruction
                .origin
                .primary_span
                .is_some_and(|candidate| span_contains(span, candidate))
        })
    {
        match &instruction.kind {
            HirInstructionKind::Await { .. } => {
                suspensions.insert("await");
            }
            HirInstructionKind::Yield { .. } => {
                suspensions.insert("yield");
            }
            HirInstructionKind::SyntaxFragment { fragment, .. } => {
                if let Some(fragment) = hir.syntax_fragments.get(fragment.as_usize()) {
                    if fragment.summary.contains_await {
                        suspensions.insert("await");
                    }
                    if fragment.summary.contains_yield {
                        suspensions.insert("yield");
                    }
                }
            }
            _ => {}
        }
    }
    suspensions.into_iter().collect()
}

fn arrow_context_captures(hir: &HirFile, root: FunctionId) -> BTreeSet<ContextValueKind> {
    let mut captures = BTreeSet::new();
    let mut stack = vec![root];
    while let Some(function_id) = stack.pop() {
        let Some(function) = hir.functions.get(function_id.as_usize()) else {
            continue;
        };
        captures.extend(contexts_in_function(function));
        stack.extend(
            hir.functions
                .iter()
                .filter(|child| child.parent == function_id && child.flags.is_arrow)
                .map(|child| child.id),
        );
    }
    captures
}

fn contexts_in_span(
    function: &fict_hir::HirFunction,
    span: fict_hir::SourceSpan,
) -> BTreeSet<ContextValueKind> {
    function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .filter(|instruction| {
            instruction.origin.primary_span.is_some_and(|candidate| {
                span.start() <= candidate.start() && candidate.end() <= span.end()
            })
        })
        .filter_map(context_instruction_kind)
        .collect()
}

fn contexts_in_function(function: &fict_hir::HirFunction) -> BTreeSet<ContextValueKind> {
    function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .filter_map(context_instruction_kind)
        .collect()
}

fn context_instruction_kind(instruction: &fict_hir::HirInstruction) -> Option<ContextValueKind> {
    let HirInstructionKind::Context { kind } = instruction.kind else {
        return None;
    };
    matches!(
        kind,
        ContextValueKind::This | ContextValueKind::Arguments | ContextValueKind::NewTarget
    )
    .then_some(kind)
}

const fn context_value_label(kind: ContextValueKind) -> &'static str {
    match kind {
        ContextValueKind::This => "this",
        ContextValueKind::Arguments => "arguments",
        ContextValueKind::NewTarget => "new.target",
        ContextValueKind::ImportMeta => "import.meta",
    }
}

fn captured_bindings(function: &fict_hir::HirFunction) -> BTreeSet<BindingId> {
    function
        .locals
        .iter()
        .filter(|local| local.kind == LocalKind::Capture)
        .filter_map(|local| local.binding)
        .collect()
}

fn handler_captured_bindings(
    hir: &HirFile,
    owner: &fict_hir::HirFunction,
    handler: &EmitValueRef,
    origin: Origin,
    handler_function: Option<FunctionId>,
) -> BTreeSet<BindingId> {
    let mut collector = HandlerBindingCollector {
        hir,
        owner,
        bindings: BTreeSet::new(),
        visited_values: BTreeSet::new(),
        visited_functions: BTreeSet::new(),
        owned_spans: origin.primary_span.into_iter().collect(),
    };
    match handler {
        EmitValueRef::Hir(value) => collector.value(*value),
        EmitValueRef::Ssa(name) => collector.local(name.local),
        EmitValueRef::Function(function) => collector.function(*function),
        EmitValueRef::Binding(binding) => {
            collector.bindings.insert(*binding);
        }
        EmitValueRef::Slot(_)
        | EmitValueRef::Temporary(_)
        | EmitValueRef::Literal(_)
        | EmitValueRef::Text(_) => {}
    }
    if let Some(function) = handler_function {
        collector.function(function);
    }
    collector.bindings.retain(|binding| {
        let declaration = hir
            .bindings
            .get(binding.as_usize())
            .and_then(|binding| binding.origin.primary_span);
        declaration.is_none_or(|declaration| {
            !collector
                .owned_spans
                .iter()
                .any(|span| span_contains(*span, declaration))
        })
    });
    collector.bindings
}

fn expand_local_function_dependencies(
    hir: &HirFile,
    owner: &fict_hir::HirFunction,
    direct_handler: Option<BindingId>,
    captures: &mut BTreeSet<BindingId>,
) -> (Vec<EmitPreviewLocalHandler>, Vec<String>) {
    let mut functions = Vec::new();
    let mut contexts = Vec::new();
    let mut visited = BTreeSet::new();
    let mut pending: Vec<_> = captures.iter().copied().collect();
    while let Some(binding) = pending.pop() {
        if !visited.insert(binding)
            || direct_handler == Some(binding)
            || binding_is_module_scoped(hir, binding)
        {
            continue;
        }
        let candidates: Vec<_> = hir
            .functions
            .iter()
            .filter(|function| function.parent == owner.id && function.binding == Some(binding))
            .collect();
        let [function] = candidates.as_slice() else {
            continue;
        };
        let Some(binding_info) = hir.bindings.get(binding.as_usize()) else {
            continue;
        };
        if !matches!(
            binding_info.kind,
            BindingKind::Const | BindingKind::Function
        ) || local_function_has_runtime_mutation(hir, owner, binding)
        {
            continue;
        }

        if function.flags.is_arrow {
            contexts.extend(
                arrow_context_captures(hir, function.id)
                    .into_iter()
                    .map(|context| {
                        format!(
                            "{} -> {}",
                            binding_info.display_name,
                            context_value_label(context)
                        )
                    }),
            );
        }
        functions.push(EmitPreviewLocalHandler {
            binding,
            local: binding_info.display_name.clone(),
            function: function.id,
            definition_origin: function.origin,
        });
        let dependencies = handler_captured_bindings(
            hir,
            owner,
            &EmitValueRef::Function(function.id),
            function.origin,
            Some(function.id),
        );
        for dependency in dependencies {
            if captures.insert(dependency) {
                pending.push(dependency);
            }
        }
    }
    functions.sort_by_key(|function| function.binding);
    contexts.sort();
    contexts.dedup();
    (functions, contexts)
}

struct HandlerBindingCollector<'hir> {
    hir: &'hir HirFile,
    owner: &'hir fict_hir::HirFunction,
    bindings: BTreeSet<BindingId>,
    visited_values: BTreeSet<ValueId>,
    visited_functions: BTreeSet<FunctionId>,
    owned_spans: Vec<fict_hir::SourceSpan>,
}

impl HandlerBindingCollector<'_> {
    fn value(&mut self, value: ValueId) {
        if !self.visited_values.insert(value) {
            return;
        }
        if let Some(ValueKind::Function(function)) = self
            .owner
            .values
            .get(value.as_usize())
            .map(|value| &value.kind)
        {
            self.function(*function);
        }
        let instruction = self
            .owner
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .find(|instruction| instruction.result == Some(value))
            .cloned();
        let Some(instruction) = instruction else {
            return;
        };
        match instruction.kind {
            HirInstructionKind::Declare { initializer, .. } => {
                if let Some(initializer) = initializer {
                    self.value(initializer);
                }
            }
            HirInstructionKind::Read { place } => self.place(&place),
            HirInstructionKind::Write { place, value } => {
                self.place(&place);
                self.value(value);
            }
            HirInstructionKind::ReadWrite { place, value, .. } => {
                self.place(&place);
                if let Some(value) = value {
                    self.value(value);
                }
            }
            HirInstructionKind::Iteration {
                source,
                pattern,
                targets,
                ..
            } => {
                self.value(source);
                self.fragment(pattern);
                for target in targets {
                    self.local(target);
                }
            }
            HirInstructionKind::PatternAssignment {
                value,
                pattern,
                writes,
                projected_writes,
            } => {
                self.value(value);
                self.fragment(pattern);
                for write in writes {
                    self.local(write.local);
                }
                projected_writes
                    .iter()
                    .for_each(|write| self.place(&write.0));
            }
            HirInstructionKind::Delete { target } => match target {
                fict_hir::DeleteTarget::Place(place) => self.place(&place),
                fict_hir::DeleteTarget::Value(value) => self.value(value),
                fict_hir::DeleteTarget::UnresolvedIdentifier(_) => {}
            },
            HirInstructionKind::Unary { argument, .. } => self.value(argument),
            HirInstructionKind::Binary { left, right, .. } => {
                self.value(left);
                self.value(right);
            }
            HirInstructionKind::Conditional {
                test,
                consequent,
                alternate,
            } => {
                self.value(test);
                self.value(consequent);
                self.value(alternate);
            }
            HirInstructionKind::Sequence { values } => {
                for value in values {
                    self.value(value);
                }
            }
            HirInstructionKind::TemplateLiteral { expressions, .. } => {
                for expression in expressions {
                    self.value(expression);
                }
            }
            HirInstructionKind::TaggedTemplate {
                tag,
                tag_reference,
                substitutions,
                host,
                ..
            } => {
                self.value(tag);
                if let Some(reference) = tag_reference {
                    self.place(&reference);
                }
                for substitution in substitutions {
                    self.value(substitution);
                }
                self.call_host(host);
            }
            HirInstructionKind::DynamicImport {
                specifier, options, ..
            } => {
                self.value(specifier);
                if let Some(options) = options {
                    self.value(options);
                }
            }
            HirInstructionKind::Call(call) => {
                self.value(call.callee);
                if let Some(reference) = &call.callee_reference {
                    self.place(reference);
                }
                for argument in call.arguments {
                    self.value(argument.value);
                }
                self.call_host(call.host);
            }
            HirInstructionKind::New { callee, arguments } => {
                self.value(callee);
                for argument in arguments {
                    self.value(argument.value);
                }
            }
            HirInstructionKind::Array { elements } => {
                for element in elements {
                    match element {
                        fict_hir::ArrayElement::Hole(_) => {}
                        fict_hir::ArrayElement::Value(value)
                        | fict_hir::ArrayElement::Spread { value, .. } => self.value(value),
                    }
                }
            }
            HirInstructionKind::Object { entries } => {
                for entry in entries {
                    match entry {
                        fict_hir::ObjectEntry::Property { key, value, .. } => {
                            if let fict_hir::PropertyKey::Computed(key) = key {
                                self.value(key);
                            }
                            self.value(value);
                        }
                        fict_hir::ObjectEntry::Spread { value, .. } => self.value(value),
                    }
                }
            }
            HirInstructionKind::Function { function } => self.function(function),
            HirInstructionKind::Await { value } => self.value(value),
            HirInstructionKind::Yield { value, .. } => {
                if let Some(value) = value {
                    self.value(value);
                }
            }
            HirInstructionKind::Phi { target, sources } => {
                self.local(target.local);
                for (_, source) in sources {
                    self.local(source.local);
                }
            }
            HirInstructionKind::SyntaxFragment { fragment, inputs } => {
                self.fragment(fragment);
                for input in inputs {
                    self.value(input);
                }
            }
            HirInstructionKind::Literal(_)
            | HirInstructionKind::UnresolvedTypeof { .. }
            | HirInstructionKind::Context { .. }
            | HirInstructionKind::Jsx { .. }
            | HirInstructionKind::Debugger => {}
        }
    }

    fn place(&mut self, place: &fict_hir::Place) {
        match place.base {
            PlaceBase::Local(local) => self.local(local),
            PlaceBase::Ssa(name) => self.local(name.local),
            PlaceBase::Value(value) => self.value(value),
            PlaceBase::Global(_) => {}
        }
        for projection in &place.projections {
            if let fict_hir::Projection::ComputedProperty { key, .. } = projection {
                self.value(*key);
            }
        }
    }

    fn local(&mut self, local: fict_hir::LocalId) {
        if let Some(binding) = self
            .owner
            .locals
            .get(local.as_usize())
            .and_then(|local| local.binding)
        {
            self.bindings.insert(binding);
        }
    }

    fn fragment(&mut self, fragment: fict_hir::SyntaxFragmentId) {
        if let Some(fragment) = self.hir.syntax_fragments.get(fragment.as_usize()) {
            self.bindings
                .extend(fragment.summary.referenced_bindings.iter().copied());
        }
    }

    fn call_host(&mut self, host: fict_hir::CallHost) {
        match host {
            fict_hir::CallHost::Binding(binding) => {
                self.bindings.insert(binding);
            }
            fict_hir::CallHost::Function(function) => self.function(function),
            fict_hir::CallHost::ReactiveScope(host) => {
                self.bindings.extend(host.callee);
            }
            fict_hir::CallHost::Unknown => {}
        }
    }

    fn function(&mut self, function: FunctionId) {
        if !self.visited_functions.insert(function) {
            return;
        }
        let Some(function_info) = self.hir.functions.get(function.as_usize()) else {
            return;
        };
        if let Some(span) = function_info.origin.primary_span {
            self.owned_spans.push(span);
        }
        self.bindings.extend(captured_bindings(function_info));
        let children: Vec<_> = self
            .hir
            .functions
            .iter()
            .filter(|child| child.parent == function)
            .map(|child| child.id)
            .collect();
        for child in children {
            self.function(child);
        }
    }
}

fn handler_prop_calls(
    hir: &HirFile,
    owner: &fict_hir::HirFunction,
    handler_function: Option<FunctionId>,
    local_functions: &[EmitPreviewLocalHandler],
    origin: Origin,
    props_parameter: Option<BindingId>,
    props: &BTreeMap<BindingId, &EmitPropBinding>,
) -> Vec<String> {
    let mut calls = BTreeSet::new();
    let handler_span = origin.primary_span;
    collect_prop_calls_in_function(hir, owner, handler_span, props_parameter, props, &mut calls);
    let mut visited = BTreeSet::new();
    let mut stack: Vec<_> = handler_function.into_iter().collect();
    stack.extend(local_functions.iter().map(|function| function.function));
    if let Some(handler_span) = handler_span {
        stack.extend(
            hir.functions
                .iter()
                .filter(|function| {
                    function.id != owner.id
                        && function
                            .origin
                            .primary_span
                            .is_some_and(|span| span_contains(handler_span, span))
                })
                .map(|function| function.id),
        );
    }
    while let Some(function_id) = stack.pop() {
        if !visited.insert(function_id) {
            continue;
        }
        let Some(function) = hir.functions.get(function_id.as_usize()) else {
            continue;
        };
        stack.extend(
            hir.functions
                .iter()
                .filter(|child| child.parent == function_id)
                .map(|child| child.id),
        );
        collect_prop_calls_in_function(hir, function, None, props_parameter, props, &mut calls);
    }
    calls.into_iter().collect()
}

fn collect_prop_calls_in_function(
    hir: &HirFile,
    function: &fict_hir::HirFunction,
    within: Option<fict_hir::SourceSpan>,
    props_parameter: Option<BindingId>,
    props: &BTreeMap<BindingId, &EmitPropBinding>,
    calls: &mut BTreeSet<String>,
) {
    for call in function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .filter_map(|instruction| match &instruction.kind {
            HirInstructionKind::Call(call) => Some((instruction, call)),
            _ => None,
        })
        .filter(|(instruction, _)| {
            within.is_none_or(|within| {
                instruction
                    .origin
                    .primary_span
                    .is_some_and(|span| span_contains(within, span))
            })
        })
        .map(|(_, call)| call)
    {
        if let Some(place) = &call.callee_reference
            && let Some(label) = prop_call_label(function, place, props_parameter, props)
        {
            calls.insert(label);
            continue;
        }
        let binding = match call.host {
            fict_hir::CallHost::Binding(binding) => Some(binding),
            fict_hir::CallHost::Unknown
            | fict_hir::CallHost::Function(_)
            | fict_hir::CallHost::ReactiveScope(_) => None,
        };
        if let Some(binding) = binding {
            if props_parameter == Some(binding) {
                calls.insert(hir.bindings.get(binding.as_usize()).map_or_else(
                    || "props".to_owned(),
                    |binding| binding.display_name.clone(),
                ));
            } else if let Some(prop) = props.get(&binding) {
                calls.insert(prop.local.clone());
            }
        }
    }
}

const fn span_contains(outer: fict_hir::SourceSpan, inner: fict_hir::SourceSpan) -> bool {
    outer.start() <= inner.start() && inner.end() <= outer.end()
}

fn prop_call_label(
    function: &fict_hir::HirFunction,
    place: &fict_hir::Place,
    props_parameter: Option<BindingId>,
    props: &BTreeMap<BindingId, &EmitPropBinding>,
) -> Option<String> {
    let binding = place_binding(function, place)?;
    let mut label = if props_parameter == Some(binding) {
        function
            .locals
            .iter()
            .find(|local| local.binding == Some(binding))
            .and_then(|local| local.debug_name.clone())
            .unwrap_or_else(|| "props".to_owned())
    } else {
        props.get(&binding)?.local.clone()
    };
    for projection in &place.projections {
        match projection {
            fict_hir::Projection::StaticProperty { name, .. } => {
                label.push('.');
                label.push_str(name);
            }
            fict_hir::Projection::Index { index, .. } => {
                label.push('[');
                label.push_str(&index.to_string());
                label.push(']');
            }
            fict_hir::Projection::ComputedProperty { .. } => label.push_str("[computed]"),
        }
    }
    Some(label)
}

fn expand_prop_default_dependencies(
    props: &BTreeMap<BindingId, &EmitPropBinding>,
    captures: &mut BTreeSet<BindingId>,
) {
    let mut queue: Vec<_> = captures.iter().copied().collect();
    let mut visited = BTreeSet::new();
    while let Some(binding) = queue.pop() {
        if !visited.insert(binding) {
            continue;
        }
        let Some(prop) = props
            .get(&binding)
            .filter(|prop| prop.default_value.is_some())
        else {
            continue;
        };
        for dependency in prop.default_dependencies.iter().copied() {
            if captures.insert(dependency) {
                queue.push(dependency);
            }
        }
    }
}

fn non_serializable_signal_bindings(
    function: &fict_hir::HirFunction,
    emit: &fict_emit::EmitFunction,
) -> BTreeSet<BindingId> {
    let mut bindings = BTreeSet::new();
    for operation in &emit.operations {
        let candidate = match operation {
            EmitOperation::CreateReactive {
                slot,
                initializer: Some(value),
                ..
            } => Some((*slot, value)),
            EmitOperation::WriteReactive {
                slot,
                projections,
                value,
                ..
            } if projections.is_empty() => Some((*slot, value)),
            EmitOperation::UpdateReactive {
                slot,
                projections,
                value: Some(value),
                ..
            } if projections.is_empty() => Some((*slot, value)),
            _ => None,
        };
        let Some((slot_id, value)) = candidate else {
            continue;
        };
        let Some(slot) = emit.slots.get(slot_id.as_usize()) else {
            continue;
        };
        if slot.kind == ReactiveSlotKind::Signal
            && emit_value_contains_function(function, value, &mut BTreeSet::new())
            && let Some(binding) = slot.binding
        {
            bindings.insert(binding);
        }
    }
    let signal_bindings: BTreeSet<_> = emit
        .slots
        .iter()
        .filter(|slot| slot.kind == ReactiveSlotKind::Signal)
        .filter_map(|slot| slot.binding)
        .collect();
    for call in function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .filter_map(|instruction| match &instruction.kind {
            HirInstructionKind::Call(call) => Some(call),
            _ => None,
        })
    {
        let fict_hir::CallHost::Binding(binding) = call.host else {
            continue;
        };
        let Some(argument) = call.arguments.first() else {
            continue;
        };
        if signal_bindings.contains(&binding)
            && hir_value_contains_function(function, argument.value, &mut BTreeSet::new())
        {
            bindings.insert(binding);
        }
    }
    bindings
}

fn emit_value_contains_function(
    function: &fict_hir::HirFunction,
    value: &EmitValueRef,
    visited: &mut BTreeSet<ValueId>,
) -> bool {
    match value {
        EmitValueRef::Function(_) => true,
        EmitValueRef::Hir(value) => hir_value_contains_function(function, *value, visited),
        EmitValueRef::Ssa(_)
        | EmitValueRef::Slot(_)
        | EmitValueRef::Temporary(_)
        | EmitValueRef::Literal(_)
        | EmitValueRef::Binding(_)
        | EmitValueRef::Text(_) => false,
    }
}

fn hir_value_contains_function(
    function: &fict_hir::HirFunction,
    value: ValueId,
    visited: &mut BTreeSet<ValueId>,
) -> bool {
    if !visited.insert(value) {
        return false;
    }
    if matches!(
        function
            .values
            .get(value.as_usize())
            .map(|value| &value.kind),
        Some(ValueKind::Function(_))
    ) {
        return true;
    }
    let Some(instruction) = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find(|instruction| instruction.result == Some(value))
    else {
        return false;
    };
    match &instruction.kind {
        HirInstructionKind::Array { elements } => elements.iter().any(|element| match element {
            fict_hir::ArrayElement::Hole(_) => false,
            fict_hir::ArrayElement::Value(value) | fict_hir::ArrayElement::Spread { value, .. } => {
                hir_value_contains_function(function, *value, visited)
            }
        }),
        HirInstructionKind::Object { entries } => entries.iter().any(|entry| match entry {
            fict_hir::ObjectEntry::Property { value, kind, .. } => {
                *kind != fict_hir::ObjectPropertyKind::Init
                    || hir_value_contains_function(function, *value, visited)
            }
            fict_hir::ObjectEntry::Spread { value, .. } => {
                hir_value_contains_function(function, *value, visited)
            }
        }),
        HirInstructionKind::SyntaxFragment { .. } => {
            let Some(origin) = function
                .values
                .get(value.as_usize())
                .and_then(|value| value.origin.primary_span)
            else {
                return false;
            };
            function
                .blocks
                .iter()
                .flat_map(|block| &block.instructions)
                .filter_map(|candidate| candidate.result.map(|result| (candidate, result)))
                .filter(|(candidate, result)| {
                    *result != value && candidate.origin.primary_span == Some(origin)
                })
                .any(|(_, result)| hir_value_contains_function(function, result, visited))
        }
        _ => false,
    }
}

fn is_stable_module_binding(hir: &HirFile, binding: BindingId) -> bool {
    let Some(binding) = hir.bindings.get(binding.as_usize()) else {
        return false;
    };
    if !matches!(
        binding.kind,
        BindingKind::Const | BindingKind::Function | BindingKind::Class | BindingKind::Import
    ) {
        return false;
    }
    hir.scopes
        .get(binding.scope.as_usize())
        .is_some_and(|scope| scope.kind == fict_hir::ScopeKind::Module)
}

fn binding_is_module_scoped(hir: &HirFile, binding: BindingId) -> bool {
    hir.bindings
        .get(binding.as_usize())
        .and_then(|binding| hir.scopes.get(binding.scope.as_usize()))
        .is_some_and(|scope| scope.kind == fict_hir::ScopeKind::Module)
}

fn local_function_has_runtime_mutation(
    hir: &HirFile,
    owner: &fict_hir::HirFunction,
    binding: BindingId,
) -> bool {
    let alias_sources = stable_binding_aliases(hir, owner);
    let mut aliases = BTreeSet::from([binding]);
    let mut changed = true;
    while changed {
        changed = false;
        for (alias, source) in &alias_sources {
            if aliases.contains(source) && aliases.insert(*alias) {
                changed = true;
            }
        }
    }
    hir.functions.iter().any(|function| {
        function
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .any(|instruction| instruction_mutates_bindings(hir, function, instruction, &aliases))
    })
}

fn stable_binding_aliases(
    hir: &HirFile,
    function: &fict_hir::HirFunction,
) -> BTreeMap<BindingId, BindingId> {
    let mut candidates: BTreeMap<BindingId, BTreeSet<BindingId>> = BTreeMap::new();
    for instruction in function.blocks.iter().flat_map(|block| &block.instructions) {
        let HirInstructionKind::Declare {
            local,
            initializer: Some(initializer),
            ..
        } = &instruction.kind
        else {
            continue;
        };
        let Some(alias) = function
            .locals
            .get(local.as_usize())
            .and_then(|local| local.binding)
        else {
            continue;
        };
        let Some(source) = value_read_binding(function, *initializer, &mut BTreeSet::new()) else {
            continue;
        };
        if alias != source && !binding_has_direct_runtime_write(hir, alias) {
            candidates.entry(alias).or_default().insert(source);
        }
    }
    candidates
        .into_iter()
        .filter_map(|(alias, sources)| {
            if sources.len() != 1 {
                return None;
            }
            Some((alias, *sources.first().expect("one stable alias source")))
        })
        .collect()
}

fn binding_has_direct_runtime_write(hir: &HirFile, binding: BindingId) -> bool {
    hir.functions.iter().any(|function| {
        function
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .any(|instruction| match &instruction.kind {
                HirInstructionKind::Write { place, .. }
                | HirInstructionKind::ReadWrite { place, .. }
                    if place.projections.is_empty() =>
                {
                    place_binding(function, place) == Some(binding)
                }
                HirInstructionKind::Iteration { targets, .. } => targets.iter().any(|local| {
                    function
                        .locals
                        .get(local.as_usize())
                        .and_then(|local| local.binding)
                        == Some(binding)
                }),
                HirInstructionKind::PatternAssignment { writes, .. } => {
                    writes.iter().any(|write| {
                        function
                            .locals
                            .get(write.local.as_usize())
                            .and_then(|local| local.binding)
                            == Some(binding)
                    })
                }
                _ => false,
            })
    })
}

fn instruction_mutates_bindings(
    hir: &HirFile,
    function: &fict_hir::HirFunction,
    instruction: &fict_hir::HirInstruction,
    bindings: &BTreeSet<BindingId>,
) -> bool {
    match &instruction.kind {
        HirInstructionKind::Write { place, .. } | HirInstructionKind::ReadWrite { place, .. } => {
            place_binding(function, place).is_some_and(|binding| bindings.contains(&binding))
        }
        HirInstructionKind::Delete {
            target: fict_hir::DeleteTarget::Place(place),
        } => place_binding(function, place).is_some_and(|binding| bindings.contains(&binding)),
        HirInstructionKind::Iteration { targets, .. } => targets.iter().any(|local| {
            function
                .locals
                .get(local.as_usize())
                .and_then(|local| local.binding)
                .is_some_and(|binding| bindings.contains(&binding))
        }),
        HirInstructionKind::PatternAssignment { writes, .. } => writes.iter().any(|write| {
            function
                .locals
                .get(write.local.as_usize())
                .and_then(|local| local.binding)
                .is_some_and(|binding| bindings.contains(&binding))
        }),
        HirInstructionKind::Call(call) => object_mutation_target(hir, function, call)
            .is_some_and(|binding| bindings.contains(&binding)),
        _ => false,
    }
}

fn object_mutation_target(
    hir: &HirFile,
    function: &fict_hir::HirFunction,
    call: &fict_hir::CallInstruction,
) -> Option<BindingId> {
    let callee = call.callee_reference.as_ref()?;
    let PlaceBase::Global(global) = callee.base else {
        return None;
    };
    if hir.globals.get(global.as_usize())?.name != "Object" {
        return None;
    }
    let mutating = match callee.projections.as_slice() {
        [fict_hir::Projection::StaticProperty { name, .. }] => {
            matches!(name.as_str(), "assign" | "defineProperty")
        }
        [fict_hir::Projection::ComputedProperty { key, .. }] => {
            value_is_string(function, *key, "assign")
                || value_is_string(function, *key, "defineProperty")
        }
        [fict_hir::Projection::Index { .. }] | [] | [_, _, ..] => false,
    };
    if !mutating {
        return None;
    }
    let target = call.arguments.first()?.value;
    value_root_binding(function, target, &mut BTreeSet::new())
}

fn value_root_binding(
    function: &fict_hir::HirFunction,
    value: ValueId,
    visited: &mut BTreeSet<ValueId>,
) -> Option<BindingId> {
    if !visited.insert(value) {
        return None;
    }
    let instruction = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find(|instruction| instruction.result == Some(value))?;
    match &instruction.kind {
        HirInstructionKind::Read { place } => place_binding(function, place),
        HirInstructionKind::SyntaxFragment { inputs, .. } => inputs
            .iter()
            .find_map(|input| value_root_binding(function, *input, visited)),
        _ => None,
    }
}

fn place_binding(function: &fict_hir::HirFunction, place: &fict_hir::Place) -> Option<BindingId> {
    let local = match place.base {
        PlaceBase::Local(local) => local,
        PlaceBase::Ssa(name) => name.local,
        PlaceBase::Global(_) | PlaceBase::Value(_) => return None,
    };
    function.locals.get(local.as_usize())?.binding
}

fn is_stable_module_handler_binding(hir: &HirFile, binding: BindingId) -> bool {
    let Some(binding) = hir.bindings.get(binding.as_usize()) else {
        return false;
    };
    matches!(
        binding.kind,
        BindingKind::Const | BindingKind::Function | BindingKind::Class
    ) && hir
        .scopes
        .get(binding.scope.as_usize())
        .is_some_and(|scope| scope.kind == fict_hir::ScopeKind::Module)
}

fn allocate_indexed(reserved: &mut BTreeSet<String>, prefix: &str, next: &mut u32) -> String {
    loop {
        let candidate = format!("{prefix}{}", *next);
        *next = next.saturating_add(1);
        if reserved.insert(candidate.clone()) {
            return candidate;
        }
    }
}

fn allocate_name(reserved: &mut BTreeSet<String>, preferred: &str) -> String {
    if reserved.insert(preferred.to_owned()) {
        return preferred.to_owned();
    }
    let mut index = 1_u32;
    loop {
        let candidate = format!("{preferred}_{index}");
        index = index.saturating_add(1);
        if reserved.insert(candidate.clone()) {
            return candidate;
        }
    }
}

fn ensure_runtime_import(
    emit: &mut EmitProgram,
    reserved: &mut BTreeSet<String>,
    helper: RuntimeHelper,
) {
    if emit.imports.iter().any(|intent| intent.helper == helper) {
        return;
    }
    let spec = helper.spec();
    emit.imports.push(RuntimeImportIntent {
        helper,
        module_request: spec.module_request(emit.runtime_family).to_owned(),
        imported: spec.export.to_owned(),
        local: allocate_name(reserved, spec.preferred_local),
    });
}

/// Convert an explicit-handler rejection into the equivalent auto fallback.
fn preview_eager_fallback_warning(mut diagnostic: Diagnostic, event: &str) -> Diagnostic {
    let code = match diagnostic.code.as_str() {
        "FICT-PREVIEW-EVENT-OPTIONS" => "FICT-PREVIEW-EAGER-EVENT-OPTIONS",
        "FICT-PREVIEW-EVENT-LOADER" => "FICT-PREVIEW-EAGER-EVENT-LOADER",
        "FICT-PREVIEW-HANDLER" => "FICT-PREVIEW-EAGER-HANDLER",
        "FICT-PREVIEW-CONTEXT" => "FICT-PREVIEW-EAGER-CONTEXT",
        "FICT-PREVIEW-CAPTURE" => "FICT-PREVIEW-EAGER-CAPTURE",
        "FICT-PREVIEW-PROP-CALL" => "FICT-PREVIEW-EAGER-PROP-CALL",
        code => unreachable!("unsupported Preview fallback diagnostic: {code}"),
    };
    diagnostic.code = DiagnosticCode::new(code).expect("Preview fallback diagnostic");
    diagnostic.severity = DiagnosticSeverity::Warning;
    diagnostic.message = format!(
        "resumable output keeps on:{event} eager because {}; the control stays inert until its component scope resumes",
        diagnostic.message
    );
    diagnostic.help = Some(
        "make the handler fully resumable, or disable resumable output for this module".to_owned(),
    );
    diagnostic.guarantee_class = GuaranteeClass::Fallback;
    diagnostic
}

fn preview_error(code: &'static str, message: impl Into<String>) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("Preview diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(GuaranteeClass::Unsupported)
}
