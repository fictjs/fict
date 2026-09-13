//! Observe authored bindings and the verified EmitIR plan without changing either.

use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::SourceSpan;
use fict_emit::{CleanupOwner, EmitOperation, EmitProgram, ReactiveSlotStorage};
use fict_hir::BindingId;
use oxc::{
    ast::ast::{
        ArrowFunctionExpression, BindingIdentifier, Function, IdentifierReference, Program,
    },
    ast_visit::{Visit, walk},
    span::Span,
    syntax::scope::ScopeFlags,
};

use super::{
    DerivedCreationRewrite, SemanticIdentities, jsx_derived_inline::JsxInlineReads,
    operation_origin,
};
use crate::reactive_graph::{
    GraphBinding, GraphCleanup, GraphDecision, GraphFunction, GraphOperation, GraphReference,
    GraphSlot, OxcReactiveGraph,
};

pub(super) fn prepare(
    program: &Program<'_>,
    identities: &SemanticIdentities,
    emit: &EmitProgram,
) -> OxcReactiveGraph {
    let bindings = emit
        .functions
        .iter()
        .flat_map(|function| &function.slots)
        .filter_map(|slot| slot.binding)
        .map(|binding| {
            (
                binding,
                GraphBinding {
                    id: binding.index(),
                    name: String::new(),
                    declaration: None,
                    references: Vec::new(),
                },
            )
        })
        .collect();
    let mut source = SourceCollector {
        identities,
        bindings,
        owner: None,
    };
    source.visit_program(program);
    let mut operations = Vec::new();
    let functions = emit
        .functions
        .iter()
        .map(|function| {
            let slots: BTreeMap<_, _> = function.slots.iter().map(|slot| (slot.id, slot)).collect();
            for (index, operation) in function.operations.iter().enumerate() {
                if operation.helper().is_none()
                    && !matches!(
                        operation,
                        EmitOperation::CreateDerived { .. }
                            | EmitOperation::TrackRuntimeReactive { .. }
                            | EmitOperation::ReadReactive { .. }
                    )
                {
                    continue;
                }
                let slot = match operation {
                    EmitOperation::CreateReactive { slot, .. }
                    | EmitOperation::CreateDerived { slot, .. }
                    | EmitOperation::TrackRuntimeReactive { slot, .. }
                    | EmitOperation::ReadReactive { slot, .. }
                    | EmitOperation::RegisterEffect { slot, .. } => Some(*slot),
                    _ => None,
                };
                let binding = slot
                    .and_then(|id| slots.get(&id))
                    .and_then(|slot| slot.binding)
                    .map(BindingId::index);
                operations.push(GraphOperation {
                    id: operations.len() as u32,
                    function: function.source.index(),
                    index: index as u32,
                    kind: operation_kind(operation).to_owned(),
                    slot: slot.map(|id| id.index()),
                    binding,
                    helper: operation
                        .helper()
                        .map(|helper| helper.spec().key.to_owned()),
                    span: operation_origin(operation).primary_span,
                    purpose: operation_purpose(operation).to_owned(),
                    cleanup: operation_cleanup(operation).map(|cleanup| match cleanup {
                        CleanupOwner::Function => GraphCleanup {
                            kind: "function".to_owned(),
                            id: function.source.index(),
                        },
                        CleanupOwner::Slot(slot) => GraphCleanup {
                            kind: "slot".to_owned(),
                            id: slot.index(),
                        },
                        CleanupOwner::Region(region) => GraphCleanup {
                            kind: "region".to_owned(),
                            id: region.index(),
                        },
                    }),
                });
            }
            GraphFunction {
                id: function.source.index(),
                kind: format!("{:?}", function.kind),
                span: function.origin.primary_span,
                context_helper: function
                    .context
                    .as_ref()
                    .map(|context| context.helper.spec().key.to_owned()),
                regions: function.regions.iter().map(|id| id.index()).collect(),
                slots: function
                    .slots
                    .iter()
                    .map(|slot| GraphSlot {
                        id: slot.id.index(),
                        binding: slot.binding.map(BindingId::index),
                        kind: format!("{:?}", slot.kind),
                        storage: match slot.storage {
                            ReactiveSlotStorage::Owned => "owned",
                            ReactiveSlotStorage::Alias { .. } => "alias",
                            ReactiveSlotStorage::Captured { .. } => "captured",
                            ReactiveSlotStorage::CapturedHookReturn { .. } => {
                                "captured-hook-return"
                            }
                            ReactiveSlotStorage::Imported { .. } => "imported",
                            ReactiveSlotStorage::HookReturn { .. } => "hook-return",
                        }
                        .to_owned(),
                        owner: match slot.storage {
                            ReactiveSlotStorage::Owned => Some(function.source.index()),
                            ReactiveSlotStorage::Captured { owner }
                            | ReactiveSlotStorage::CapturedHookReturn { owner, .. } => {
                                Some(owner.index())
                            }
                            _ => None,
                        },
                    })
                    .collect(),
            }
        })
        .collect();
    OxcReactiveGraph {
        version: 1,
        scope: "main-module".to_owned(),
        bindings: source.bindings.into_values().collect(),
        functions,
        operations,
        decisions: Vec::new(),
        calls: Vec::new(),
        owners: Vec::new(),
        counters: BTreeMap::new(),
        source_anchors_verified: false,
        fusion: "not-attempted:no-general-fusion-pass".to_owned(),
    }
}

pub(super) fn decisions(
    trace: &mut OxcReactiveGraph,
    emit: &EmitProgram,
    creations: &BTreeMap<BindingId, DerivedCreationRewrite>,
    inlined: &BTreeSet<BindingId>,
    eliminated: &BTreeSet<BindingId>,
    jsx_reads: &JsxInlineReads,
) {
    let jsx: BTreeSet<_> = jsx_reads.values().map(|read| read.binding).collect();
    for binding in &trace.bindings {
        let id = BindingId::new(binding.id);
        let Some(creation) = creations.get(&id) else {
            continue;
        };
        let (action, reason) = if eliminated.contains(&id) {
            ("eliminate", "unused-total-scalar-derived")
        } else if inlined.contains(&id) {
            (
                "inline",
                if jsx.contains(&id) {
                    "single-scalar-jsx-consumer"
                } else {
                    "same-owner-single-accessor-read"
                },
            )
        } else if creation.rewrite.local.is_none() {
            ("accessor", "uncached-derived-policy")
        } else if !emit.optimize {
            ("retain", "optimizer-disabled")
        } else if emit.preview {
            ("retain", "preview-lifetime")
        } else if !(if binding.name.starts_with("__") {
            creation.inline_compiler_names
        } else {
            creation.inline_user_names
        }) {
            ("retain", "name-inline-policy-disabled")
        } else if binding.references.is_empty() {
            ("retain", "unused-memo-proof-not-established")
        } else if binding.references.len() > 1 {
            ("retain", "multiple-authored-references")
        } else {
            ("retain", "movement-or-lifetime-proof-not-established")
        };
        trace.decisions.push(GraphDecision {
            binding: binding.id,
            action: action.to_owned(),
            reason: reason.to_owned(),
        });
    }
    // Explicit and manually-created slots do not enter the implicit memo inliner.
    let implicit: BTreeSet<_> = creations.keys().map(|id| id.index()).collect();
    let mut explicit = BTreeSet::new();
    for operation in &trace.operations {
        if let Some(binding) = operation.binding
            && !implicit.contains(&binding)
            && matches!(
                operation.kind.as_str(),
                "create-reactive" | "track-runtime-reactive"
            )
            && explicit.insert(binding)
        {
            trace.decisions.push(GraphDecision {
                binding,
                action: "preserve".to_owned(),
                reason: if operation.kind == "track-runtime-reactive" {
                    "runtime-owned-creation"
                } else {
                    "authored-reactive-creation"
                }
                .to_owned(),
            });
        }
    }
    trace.decisions.sort_by_key(|decision| decision.binding);
}

fn operation_kind(operation: &EmitOperation) -> &'static str {
    match operation {
        EmitOperation::CreateReactive { .. } => "create-reactive",
        EmitOperation::CreateDerived { .. } => "create-derived",
        EmitOperation::TrackRuntimeReactive { .. } => "track-runtime-reactive",
        EmitOperation::ReadReactive { .. } => "read-reactive",
        EmitOperation::RegisterEffect { .. } => "register-effect",
        EmitOperation::RegisterReactiveStatementEffect { .. } => "statement-effect",
        EmitOperation::CreateVNode { .. } => "vnode",
        EmitOperation::DeclareTemplate { .. } => "template",
        EmitOperation::CloneTemplate { .. } => "clone-template",
        EmitOperation::ResolveElement { .. } => "resolve-element",
        EmitOperation::InvokeComponent { .. } => "component",
        EmitOperation::BindDom { .. } => "bind-dom",
        EmitOperation::ApplyProps { .. } => "apply-props",
        EmitOperation::BindEvent { .. } => "bind-event",
        EmitOperation::BindRef { .. } => "bind-ref",
        EmitOperation::Insert { .. } => "insert",
        EmitOperation::Conditional { .. } => "conditional",
        EmitOperation::ConditionalReturn { .. } => "conditional-return",
        EmitOperation::ControlFlowRegion { .. } => "control-flow-region",
        EmitOperation::KeyedChild { .. } => "keyed-child",
        EmitOperation::KeyedList { .. } => "keyed-list",
        _ => "non-allocating-operation",
    }
}

fn operation_purpose(operation: &EmitOperation) -> &'static str {
    match operation {
        EmitOperation::CreateDerived { .. } => "implicit-derived-caching-policy",
        EmitOperation::CreateReactive { .. } => "authored-reactive-creation",
        EmitOperation::RegisterEffect { .. } => "explicit-effect-order-and-cleanup",
        EmitOperation::RegisterReactiveStatementEffect { .. } => "tracked-statement-reexecution",
        EmitOperation::ControlFlowRegion { .. } => "shared-control-flow-reexecution",
        EmitOperation::Conditional { .. } | EmitOperation::ConditionalReturn { .. } => {
            "branch-identity-and-lifetime"
        }
        EmitOperation::KeyedChild { .. } | EmitOperation::KeyedList { .. } => {
            "keyed-row-identity-and-lifetime"
        }
        EmitOperation::BindDom { .. } => "dom-binding-updates",
        EmitOperation::BindEvent { .. } => "event-handler-lifetime",
        EmitOperation::BindRef { .. } => "ref-attachment-and-cleanup",
        _ => "runtime-operation-contract",
    }
}

fn operation_cleanup(operation: &EmitOperation) -> Option<CleanupOwner> {
    match operation {
        EmitOperation::TrackRuntimeReactive { cleanup, .. }
        | EmitOperation::RegisterEffect { cleanup, .. }
        | EmitOperation::BindEvent { cleanup, .. }
        | EmitOperation::BindRef { cleanup, .. }
        | EmitOperation::Conditional { cleanup, .. }
        | EmitOperation::KeyedChild { cleanup, .. }
        | EmitOperation::KeyedList { cleanup, .. } => Some(*cleanup),
        _ => None,
    }
}

struct SourceCollector<'plan> {
    identities: &'plan SemanticIdentities,
    bindings: BTreeMap<BindingId, GraphBinding>,
    owner: Option<SourceSpan>,
}

impl<'a> Visit<'a> for SourceCollector<'_> {
    fn visit_binding_identifier(&mut self, identifier: &BindingIdentifier<'a>) {
        if let Some(binding) = identifier
            .symbol_id
            .get()
            .and_then(|symbol| self.identities.binding_for_symbol(symbol))
            && let Some(record) = self.bindings.get_mut(&binding)
        {
            record.name = identifier.name.to_string();
            record.declaration = span(identifier.span);
        }
    }

    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        if let Some(binding) = self.identities.binding_for_reference(identifier)
            && let Some(record) = self.bindings.get_mut(&binding)
            && let Some(span) = span(identifier.span)
        {
            record.references.push(GraphReference {
                span,
                owner: self.owner,
                write: self.identities.reference_is_write(identifier),
            });
        }
    }

    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        let previous = self.owner;
        self.owner = span(function.span);
        walk::walk_function(self, function, flags);
        self.owner = previous;
    }

    fn visit_arrow_function_expression(&mut self, function: &ArrowFunctionExpression<'a>) {
        let previous = self.owner;
        self.owner = span(function.span);
        walk::walk_arrow_function_expression(self, function);
        self.owner = previous;
    }
}

pub(super) fn span(span: Span) -> Option<SourceSpan> {
    (span.start < span.end)
        .then(|| SourceSpan::new(span.start, span.end).expect("ordered AST span"))
}
