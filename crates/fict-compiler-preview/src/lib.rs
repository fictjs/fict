#![forbid(unsafe_code)]

//! Optional resumability and handler-artifact passes outside the stable Core pipeline.

use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_emit::{
    EmitOperation, EmitPreviewComponent, EmitPreviewHandler, EmitPreviewLexicalCapture,
    EmitPreviewModuleCapture, EmitPreviewPlan, EmitPreviewPropCapture, EmitProgram, EmitValueRef,
    ReactiveSlotStorage, RuntimeHelper, RuntimeImportIntent,
};
use fict_hir::{
    BindingId, BindingKind, FunctionId, FunctionKind, HirFile, HirInstructionKind, JsxAttribute,
    JsxAttributeValue, JsxChild, JsxElementName, JsxNode, LocalKind, Origin, PlaceBase, ValueId,
    ValueKind,
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
pub fn attach_preview_plan(
    hir: &HirFile,
    emit: &mut EmitProgram,
    options: &PreviewOptions,
) -> Result<(), DiagnosticBundle> {
    let mut diagnostics = Vec::new();
    let mut reserved: BTreeSet<String> = emit.module.reserved_names.iter().cloned().collect();
    let mut handler_index = 0_u32;
    let mut dependency_index = 0_u32;
    let mut handlers = Vec::new();

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
                && handler_function.is_some_and(|function| {
                    handler_node_count(hir, function) >= options.auto_extract_threshold
                });
            if !candidate.explicit && !automatically_selected {
                continue;
            }

            let captures = handler_function
                .and_then(|function| hir.functions.get(function.as_usize()))
                .map(captured_bindings)
                .unwrap_or_default();
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
                            hir.bindings[binding.as_usize()].display_name.clone(),
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
            let props_parameter = owner
                .parameters
                .first()
                .and_then(|parameter| parameter.binding)
                .filter(|binding| captures.contains(binding));

            let mut lexical_captures = Vec::new();
            let mut prop_captures = Vec::new();
            let mut module_captures = Vec::new();
            let mut unsupported = Vec::new();
            for binding in captures {
                let Some(binding_info) = hir.bindings.get(binding.as_usize()) else {
                    continue;
                };
                if let Some(local) = slot_bindings.get(&binding) {
                    lexical_captures.push(EmitPreviewLexicalCapture {
                        binding,
                        local: local.clone(),
                    });
                    continue;
                }
                if let Some(prop) = prop_bindings.get(&binding) {
                    prop_captures.push(EmitPreviewPropCapture {
                        binding,
                        local: prop.local.clone(),
                        path: prop.path.clone(),
                        default_value: prop.default_value,
                    });
                    continue;
                }
                if props_parameter == Some(binding) {
                    continue;
                }
                if is_stable_module_binding(hir, binding) {
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

            if !unsupported.is_empty() {
                if candidate.explicit {
                    unsupported.sort();
                    diagnostics.push(
                        preview_error(
                            "FICT-PREVIEW-CAPTURE",
                            format!(
                                "resumable handler captures non-serializable locals: {}",
                                unsupported.join(", ")
                            ),
                        )
                        .with_primary_span(handler_origin)
                        .with_help("use signals, serializable props, or stable module bindings; otherwise remove the `$` suffix"),
                    );
                }
                continue;
            }

            lexical_captures.sort_by_key(|capture| capture.binding);
            prop_captures.sort_by_key(|capture| capture.binding);
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
                source_export_name,
                module_specifier: format!("fict:compiler-artifact:{artifact_id}"),
                artifact_id,
                lexical_captures,
                prop_captures,
                props_object_local: props_parameter
                    .map(|binding| hir.bindings[binding.as_usize()].display_name.clone()),
                module_captures,
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
    if handlers
        .iter()
        .any(|handler| handler.props_object_local.is_some() || !handler.prop_captures.is_empty())
    {
        helpers.insert(RuntimeHelper::GetScopeProps);
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
    Ok(())
}

#[derive(Debug, Clone)]
struct PreviewEventCandidate {
    event: String,
    handler: EmitValueRef,
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
                    let Some((event, explicit)) = preview_event_name(name) else {
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
        if let JsxChild::Node(node) = child {
            collect_template_event_candidates(owner, node, candidates, seen);
        }
    }
}

fn preview_event_name(name: &str) -> Option<(String, bool)> {
    let (name, explicit) = name
        .strip_suffix('$')
        .map_or((name, false), |name| (name, true));
    if let Some(event) = name.strip_prefix("on:") {
        return (!event.is_empty()).then(|| (event.to_ascii_lowercase(), explicit));
    }
    let event = name.strip_prefix("on")?;
    event
        .chars()
        .next()
        .is_some_and(char::is_uppercase)
        .then(|| (event.to_ascii_lowercase(), explicit))
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

fn captured_bindings(function: &fict_hir::HirFunction) -> BTreeSet<BindingId> {
    function
        .locals
        .iter()
        .filter(|local| local.kind == LocalKind::Capture)
        .filter_map(|local| local.binding)
        .collect()
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

fn preview_error(code: &'static str, message: impl Into<String>) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("Preview diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(GuaranteeClass::Unsupported)
}
