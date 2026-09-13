use fict_diagnostics::{Diagnostic, DiagnosticCode, GuaranteeClass};
use fict_hir::{FictMacroKind, FunctionKind, ReactiveScopeKind};

use crate::FrontendSummary;

use super::{Builder, CallFact, error};

pub(super) fn unsupported_macro_diagnostics(frontend: &FrontendSummary) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    for call in &frontend.macro_calls {
        if call.binding.is_none() {
            diagnostics.push(
                error(
                    "FICT-HIR-MACRO-UNBOUND",
                    "an unresolved Fict compiler macro would remain as a runtime call",
                    call.callee_span,
                )
                .with_help("import this compiler macro by name from 'fict'"),
            );
        } else if call.optional {
            diagnostics.push(
                error(
                    "FICT-HIR-MACRO-OPTIONAL",
                    "Fict compiler macros cannot be invoked through optional-call syntax",
                    call.call_span,
                )
                .with_help("invoke the imported macro directly"),
            );
        }
    }
    for value_use in &frontend.macro_value_uses {
        diagnostics.push(
            error(
                "FICT-HIR-MACRO-VALUE",
                "a Fict compiler macro import cannot escape as a runtime value",
                value_use.span,
            )
            .with_help("call the macro directly at its use site"),
        );
    }
    for call in &frontend.namespace_macro_calls {
        if call.kind == FictMacroKind::Memo {
            continue;
        }
        diagnostics.push(
            error(
                "FICT-HIR-MACRO-NAMESPACE",
                "Fict compiler macros must use a named import, not a namespace member",
                call.call_span,
            )
            .with_help("replace the namespace access with a named macro import"),
        );
    }
    diagnostics
}

impl Builder<'_, '_> {
    pub(super) fn call_reactive_scope_kind(&self, call: &CallFact) -> Option<ReactiveScopeKind> {
        if call.configured_reactive_scope {
            return Some(ReactiveScopeKind::Configured);
        }
        let binding = call.binding?;
        match self.macro_bindings.get(&binding) {
            Some(FictMacroKind::Effect) => Some(ReactiveScopeKind::EffectCallback),
            Some(FictMacroKind::Memo) => Some(ReactiveScopeKind::MemoCallback),
            Some(FictMacroKind::State) => None,
            Some(FictMacroKind::Async) => Some(ReactiveScopeKind::AsyncCallback),
            None => call
                .runtime_creation_kind
                .and_then(|kind| kind.scope_kind()),
        }
    }

    pub(super) fn apply_call_classification(&mut self, calls: &[CallFact]) {
        for call in calls {
            if let (Some(kind), Some(callback)) =
                (self.call_reactive_scope_kind(call), call.callback)
            {
                self.functions[callback.as_usize()].kind =
                    if kind == ReactiveScopeKind::AsyncCallback {
                        FunctionKind::RuntimeScope
                    } else {
                        FunctionKind::ReactiveScope
                    };
                self.reactive_functions.insert(callback, kind);
            }
        }
        for fact in self.function_facts.iter().skip(1) {
            if self.functions[fact.id.as_usize()].kind != FunctionKind::ReactiveScope
                || self.reactive_functions.get(&fact.id) == Some(&ReactiveScopeKind::Configured)
            {
                continue;
            }
            let mut parent = fact.parent;
            while parent != fict_hir::FunctionId::new(0) {
                if self.functions[parent.as_usize()].kind == FunctionKind::RuntimeScope {
                    self.functions[fact.id.as_usize()].kind = FunctionKind::RuntimeScope;
                    break;
                }
                parent = self.function_facts[parent.as_usize()].parent;
            }
        }
    }

    pub(super) fn validate_macro_placement(&mut self, calls: &[CallFact]) {
        for call in calls {
            let Some(macro_kind) = call
                .binding
                .and_then(|binding| self.macro_bindings.get(&binding).copied())
            else {
                continue;
            };
            match macro_kind {
                FictMacroKind::State => {
                    match call.direct_variable {
                        None => {
                            self.diagnostics.push(
                                error(
                                    "FICT-PLACEMENT-STATE-TARGET",
                                    "$state() must be assigned directly to a variable",
                                    call.span,
                                )
                                .with_help("use `let value = $state(initialValue)`"),
                            );
                            continue;
                        }
                        Some(false) => {
                            self.diagnostics.push(
                                error(
                                    "FICT-PLACEMENT-STATE-DESTRUCTURE",
                                    "destructuring a $state() result is not supported",
                                    call.span,
                                )
                                .with_help("assign the state to one identifier, then destructure a read-only alias"),
                            );
                            continue;
                        }
                        Some(true) => {}
                    }
                    if self.is_placement_nested(call.owner) {
                        self.diagnostics.push(
                            error(
                                "FICT-PLACEMENT-STATE-NESTED",
                                "$state() cannot be declared inside nested functions",
                                call.span,
                            )
                            .with_help("move the state declaration to the component top level or extract a hook"),
                        );
                        continue;
                    }
                    if !self.is_reactive_owner(call.owner, false) {
                        self.diagnostics.push(
                            error(
                                "FICT-PLACEMENT-STATE-OWNER",
                                "$state() must be declared inside a component or hook function body",
                                call.span,
                            )
                            .with_help(
                                "move this state into a directly declared component or hook; use $store or createSignal only for module-level shared state",
                            ),
                        );
                        continue;
                    }
                    if !call.immediate_statement || call.conditional_or_loop {
                        self.diagnostics.push(
                            error(
                                "FICT-PLACEMENT-STATE-CONTROL",
                                "$state() cannot be declared inside loops, conditionals, or nested blocks",
                                call.span,
                            )
                            .with_help("move the state declaration to the component or hook top level"),
                        );
                    }
                }
                FictMacroKind::Effect => {
                    if self.is_placement_nested(call.owner) {
                        self.diagnostics.push(
                            error(
                                "FICT-PLACEMENT-EFFECT-NESTED",
                                "$effect() cannot be called inside nested functions",
                                call.span,
                            )
                            .with_help(
                                "move the effect to the component top level or extract a hook",
                            ),
                        );
                        continue;
                    }
                    if !self.is_reactive_owner(call.owner, true) {
                        self.diagnostics.push(
                            error(
                                "FICT-PLACEMENT-EFFECT-OWNER",
                                "$effect() must be called inside a component or hook, or at module top level",
                                call.span,
                            ),
                        );
                        continue;
                    }
                    if call.conditional_or_loop
                        || ((!call.immediate_statement || call.effect_statement != Some(call.span))
                            && !call.immediate_default_export)
                    {
                        self.diagnostics.push(
                            error(
                                "FICT-PLACEMENT-EFFECT-CONTROL",
                                "$effect() cannot be called inside loops, conditionals, or nested blocks",
                                call.span,
                            )
                            .with_help("move the effect registration to the reactive owner top level"),
                        );
                    }
                }
                FictMacroKind::Async => {
                    if call.arguments.len() != 1 {
                        self.diagnostics.push(error(
                            "FICT-ASYNC-ARGUMENTS",
                            "$async() requires exactly one producer callback",
                            call.span,
                        ).with_help("pass options to the async helper inside the producer, or use createAsyncMemo for manual runtime options"));
                    }
                    let producer = call
                        .callback
                        .and_then(|id| self.functions.get(id.as_usize()));
                    if !producer.is_some_and(|function| {
                        !function.flags.is_async && !function.flags.is_generator
                    }) {
                        self.diagnostics.push(error(
                            "FICT-ASYNC-PRODUCER",
                            "$async() requires a statically known synchronous producer",
                            call.span,
                        ).with_help("capture reactive inputs synchronously and return a Promise or AsyncIterable from an ordinary async helper; await/yield continuations do not track reactive reads"));
                    }
                    if call.direct_variable != Some(true) {
                        self.diagnostics.push(
                            error(
                                "FICT-PLACEMENT-ASYNC-TARGET",
                                "$async() must be assigned directly to one identifier",
                                call.span,
                            )
                            .with_help(
                                "use `const value = $async(context => fetchValue(context.signal))`",
                            ),
                        );
                    }
                    if call.direct_variable_binding.is_some_and(|binding| {
                        self.functions[call.owner.as_usize()]
                            .locals
                            .iter()
                            .any(|local| {
                                local.binding == Some(binding)
                                    && local.declaration_kind != fict_hir::DeclarationKind::Const
                            })
                    }) {
                        self.diagnostics.push(error(
                            "FICT-PLACEMENT-ASYNC-CONST",
                            "$async() requires a const binding because its result is read-only",
                            call.span,
                        ).with_help("use `const value = $async(...)` and change the producer inputs to refresh it"));
                    }
                    if !self.is_reactive_owner(call.owner, true)
                        || self.is_placement_nested(call.owner)
                    {
                        self.diagnostics.push(error(
                            "FICT-PLACEMENT-ASYNC-OWNER",
                            "$async() must be declared at the top level of a component, hook, or module",
                            call.span,
                        ).with_help("extract a hook, or use createAsyncMemo inside an explicitly owned runtime scope"));
                    }
                    if !call.immediate_statement || call.conditional_or_loop {
                        self.diagnostics.push(error(
                            "FICT-PLACEMENT-ASYNC-CONTROL",
                            "$async() cannot be declared inside loops, conditionals, or nested blocks",
                            call.span,
                        ).with_help("move async node creation to the reactive owner top level"));
                    }
                }
                FictMacroKind::Memo => {
                    if call.conditional_or_loop {
                        self.diagnostics.push(
                            error(
                                "FICT-PLACEMENT-MEMO-CONTROL",
                                "$memo() cannot be called inside loops, conditionals, or nested blocks",
                                call.span,
                            )
                            .with_help("move the memo creation to the component or module top level"),
                        );
                    }
                }
            }
        }
    }

    pub(super) fn validate_runtime_reactive_placement(&mut self, calls: &[CallFact]) {
        for call in calls {
            if self.functions[call.owner.as_usize()].kind == FunctionKind::RuntimeScope
                && matches!(
                    call.reactive_kind,
                    Some(
                        fict_hir::ReactiveCallKind::AsyncMemo
                            | fict_hir::ReactiveCallKind::Resource
                    )
                )
            {
                self.diagnostics.push(error(
                    "FICT-ASYNC-NESTED",
                    "an async generation cannot create a new async dependency and resume by replaying its construction",
                    call.span,
                ).with_help("create the async node or Resource outside the producer, then read it from the producer; return composed Promises or AsyncIterables for a single transport"));
                continue;
            }
            if call.runtime_creation_kind.is_none() || !call.conditional_or_loop || call.inside_jsx
            {
                continue;
            }
            self.diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::new("FICT-R004").expect("diagnostic literal"),
                    self.reactive_creation_control_flow_severity,
                    "Reactive creation inside non-JSX control flow may not auto-dispose in complex paths.",
                )
                .with_primary_span(call.span)
                .with_help(
                    "move the reactive creation outside the control-flow branch or wrap it in createScope/runInScope",
                )
                .with_guarantee_class(GuaranteeClass::Fallback),
            );
        }
    }
}
