use fict_diagnostics::{Diagnostic, DiagnosticCode, GuaranteeClass};
use fict_hir::{FictMacroKind, FunctionKind, ReactiveCallKind, ReactiveScopeKind};

use crate::FrontendSummary;

use super::{Builder, CallFact, error};

pub(super) fn unsupported_macro_diagnostics(frontend: &FrontendSummary) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    for call in &frontend.macro_calls {
        if call.optional {
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
    pub(super) fn apply_call_classification(&mut self, calls: &[CallFact]) {
        for call in calls {
            let Some(binding) = call.binding else {
                continue;
            };
            let callback_kind = if self.configured_bindings.contains(&binding) {
                Some(ReactiveScopeKind::Configured)
            } else {
                match self.macro_bindings.get(&binding) {
                    Some(FictMacroKind::Effect) => Some(ReactiveScopeKind::EffectCallback),
                    Some(FictMacroKind::Memo) => Some(ReactiveScopeKind::MemoCallback),
                    Some(FictMacroKind::State) | None => None,
                }
            };
            if let (Some(kind), Some(callback)) = (callback_kind, call.callback) {
                self.functions[callback.as_usize()].kind = FunctionKind::ReactiveScope;
                self.reactive_functions.insert(callback, kind);
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
                            .with_help("use $store or createSignal for module-level shared state"),
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
                        || (!call.immediate_effect_statement && !call.immediate_default_export)
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
            if call.reactive_kind != Some(ReactiveCallKind::Selector)
                || !call.conditional_or_loop
                || call.inside_jsx
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
                    "move createSelector outside the control-flow branch or wrap it in createScope/runInScope",
                )
                .with_guarantee_class(GuaranteeClass::Fallback),
            );
        }
    }
}
