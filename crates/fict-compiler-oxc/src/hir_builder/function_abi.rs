use std::collections::BTreeSet;

use fict_diagnostics::{Diagnostic, SourceSpan};
use fict_hir::{FunctionId, FunctionKind, HirFunction, HirInstructionKind, TerminatorKind};

use super::{Builder, CallFact, JsxFact, error, is_fict_runtime_source};

pub(super) fn is_component_name(name: Option<&str>) -> bool {
    name.and_then(|name| name.as_bytes().first())
        .is_some_and(u8::is_ascii_uppercase)
}

impl Builder<'_, '_> {
    pub(super) fn classify_component_roles(&mut self, calls: &[CallFact], jsx: &[JsxFact]) {
        let jsx_owners: BTreeSet<_> = jsx.iter().map(|root| root.owner).collect();
        let context_owners: BTreeSet<_> = calls
            .iter()
            .filter(|call| self.call_uses_component_context_primitive(call))
            .map(|call| call.owner)
            .collect();
        for function in &self.function_facts {
            if function.id != FunctionId::new(0)
                && self.functions[function.id.as_usize()].kind == FunctionKind::Plain
                && is_component_name(function.display_name.as_deref())
                && (jsx_owners.contains(&function.id) || context_owners.contains(&function.id))
            {
                self.functions[function.id.as_usize()].kind = FunctionKind::Component;
            }
        }
    }

    fn call_uses_component_context_primitive(&self, call: &CallFact) -> bool {
        if call.hook.is_some() {
            return true;
        }
        let Some(binding) = call.binding else {
            return false;
        };
        if self.macro_bindings.contains_key(&binding) {
            return true;
        }
        let Some(import) = self
            .frontend
            .bindings
            .iter()
            .find(|candidate| self.old_to_new.get(&candidate.id.index()).copied() == Some(binding))
            .and_then(|binding| binding.import.as_ref())
        else {
            return false;
        };
        let fict_hir::ImportedName::Named(imported) = &import.imported else {
            return false;
        };
        is_fict_runtime_source(&import.source)
            && matches!(
                imported.as_str(),
                "$store"
                    | "createEffect"
                    | "createMemo"
                    | "createRenderEffect"
                    | "createSignal"
                    | "createStore"
            )
    }

    pub(super) fn validate_synchronous_function_abi(
        &mut self,
        calls: &[CallFact],
        jsx: &[JsxFact],
    ) {
        let mut diagnostics = Vec::new();
        for function in self.functions.iter().skip(1) {
            let name = self.function_facts[function.id.as_usize()]
                .display_name
                .as_deref()
                .unwrap_or("<anonymous>");
            if function.flags.is_generator
                && matches!(function.kind, FunctionKind::Component | FunctionKind::Hook)
            {
                let (code, role) = match function.kind {
                    FunctionKind::Component => ("FICT-FUNCTION-GENERATOR-COMPONENT", "component"),
                    FunctionKind::Hook => ("FICT-FUNCTION-GENERATOR-HOOK", "hook"),
                    _ => unreachable!("guarded render owner"),
                };
                diagnostics.push(function_error(
                    function,
                    code,
                    "generator functions cannot use the synchronous Fict render or hook ABI",
                    format!("generator {role}: {name}"),
                    "use a normal function or move generator logic into an ordinary helper",
                ));
                continue;
            }
            if function.flags.is_async && function.kind == FunctionKind::Component {
                diagnostics.push(function_error(
                    function,
                    "FICT-FUNCTION-ASYNC-COMPONENT",
                    "async components are not supported by the synchronous Fict render ABI",
                    format!("async component: {name}"),
                    "use a synchronous component or move asynchronous work into an ordinary helper",
                ));
                continue;
            }
            if !function.flags.is_async || function.kind != FunctionKind::Hook {
                continue;
            }
            let Some(await_span) = first_await_boundary(function) else {
                continue;
            };
            let event = calls
                .iter()
                .filter(|call| {
                    call.owner == function.id
                        && call.span.end() > await_span.start()
                        && self.call_uses_component_context_primitive(call)
                })
                .map(|call| call.span)
                .chain(
                    jsx.iter()
                        .filter(|root| {
                            root.owner == function.id && root.span.end() > await_span.start()
                        })
                        .map(|root| root.span),
                )
                .min_by_key(|span| (span.start(), span.end()));
            if let Some(event) = event {
                diagnostics.push(
                    error(
                        "FICT-FUNCTION-ASYNC-HOOK-AFTER-AWAIT",
                        "async hooks cannot create JSX or reactive render hooks after await",
                        event,
                    )
                    .with_note(format!("async hook: {name}"))
                    .with_help("move hook and JSX setup before await or use a non-async helper"),
                );
            }
        }
        self.diagnostics.extend(diagnostics);
    }
}

fn function_error(
    function: &HirFunction,
    code: &'static str,
    message: &'static str,
    note: String,
    help: &'static str,
) -> Diagnostic {
    error(
        code,
        message,
        function
            .origin
            .primary_span
            .unwrap_or_else(|| SourceSpan::empty(0)),
    )
    .with_note(note)
    .with_help(help)
}

fn first_await_boundary(function: &HirFunction) -> Option<SourceSpan> {
    function
        .blocks
        .iter()
        .flat_map(|block| {
            block
                .instructions
                .iter()
                .filter_map(|instruction| {
                    matches!(instruction.kind, HirInstructionKind::Await { .. })
                        .then_some(instruction.origin.primary_span)
                        .flatten()
                })
                .chain(
                    matches!(
                        block.terminator.kind,
                        TerminatorKind::ForOf { r#await: true, .. }
                    )
                    .then_some(block.terminator.origin.primary_span)
                    .flatten(),
                )
        })
        .min_by_key(|span| (span.start(), span.end()))
}
