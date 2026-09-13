//! Resolve runtime contracts through intact import identities, never local names.

use super::*;
use crate::FrontendBinding;
use fict_hir::{ImportBinding, ImportedName};

pub(super) struct RuntimeImports(BTreeMap<SymbolId, ImportBinding>);

impl RuntimeImports {
    pub(super) fn new(bindings: &[FrontendBinding]) -> Self {
        Self(
            bindings
                .iter()
                .filter(|binding| binding.is_runtime)
                .filter_map(|binding| {
                    Some((
                        SymbolId::from_usize(binding.id.as_usize()),
                        binding.import.clone()?,
                    ))
                })
                .collect(),
        )
    }

    pub(super) fn resolve(
        &self,
        scoping: &Scoping,
        aliases: &StaticHookAliases,
        callee: &Expression<'_>,
    ) -> Option<(&str, String)> {
        let raw = static_alias_source_path(scoping, callee)?;
        let path = aliases.resolve(&raw);
        let import = self.0.get(&path.binding_root()?)?;
        // ESM namespace exports cannot be overwritten by calling a method on the
        // namespace. Unknown-call analysis may conservatively invalidate the
        // receiver, but it cannot change a Fict export or an immutable alias of it.
        // An ordinary object property holding that function remains mutable.
        let frozen_namespace_reference = matches!(import.imported, ImportedName::Namespace)
            && raw.binding_root().is_some_and(|root| {
                !scoping.symbol_is_mutated(root)
                    && (raw.properties.is_empty()
                        || aliases.resolve(&StaticAliasPath::root(root))
                            == StaticAliasPath::root(path.binding_root().unwrap()))
            });
        if path.element_wildcard
            || (!frozen_namespace_reference
                && (!aliases.path_is_intact(&raw) || !aliases.path_is_intact(&path)))
        {
            return None;
        }

        let name = match (&import.imported, path.properties.as_slice()) {
            (ImportedName::Named(name), []) => name,
            (ImportedName::Namespace, [name]) => name,
            _ => return None,
        };
        Some((&import.source, name.clone()))
    }

    pub(super) fn host(
        &self,
        scoping: &Scoping,
        aliases: &StaticHookAliases,
        callee: &Expression<'_>,
    ) -> Option<RuntimeCallbackHost> {
        let (source, name) = self.resolve(scoping, aliases, callee)?;
        if !matches!(
            source,
            "fict"
                | "fict/advanced"
                | "fict/internal"
                | "@fictjs/runtime"
                | "@fictjs/runtime/advanced"
                | "@fictjs/runtime/internal"
        ) {
            return None;
        }
        match name.as_str() {
            "createAsyncMemo" => Some(RuntimeCallbackHost::AsyncComputation),
            "createSelector" => Some(RuntimeCallbackHost::Selector),
            "render" | "hydrate" => Some(RuntimeCallbackHost::Render),
            "untrack" => Some(RuntimeCallbackHost::Snapshot),
            "createEffect" | "createMemo" | "createRenderEffect" => {
                Some(RuntimeCallbackHost::Computation)
            }
            "batch" | "startTransition" | "runInScope" => Some(RuntimeCallbackHost::Managed),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum RuntimeCallbackHost {
    Snapshot,
    Managed,
    Computation,
    AsyncComputation,
    Render,
    Selector,
}

impl ReactiveEscapeCollector<'_, '_, '_> {
    pub(super) fn runtime_callbacks_are_synchronous(
        &self,
        arguments: &[EscapeArgument<'_, '_>],
    ) -> bool {
        arguments.iter().all(|argument| {
            self.callback_captures(*argument).is_empty()
                || (!argument.spread
                    && self
                        .callback_timing(argument.expression)
                        .is_some_and(|timing| !timing.may_suspend && !timing.may_return_iterator))
        })
    }

    pub(super) fn selector_source_is_owned(&self, source: EscapeArgument<'_, '_>) -> bool {
        if source.spread {
            return false;
        }
        self.direct_state_symbol(source).is_some()
            || self
                .callback_timing(source.expression)
                .is_some_and(|timing| !timing.may_suspend && !timing.may_return_iterator)
    }

    pub(super) fn selector_callbacks_are_owned(
        &self,
        arguments: &[EscapeArgument<'_, '_>],
    ) -> bool {
        if !arguments
            .first()
            .is_some_and(|source| self.selector_source_is_owned(*source))
        {
            return false;
        }
        // The source owns a tracked computation. Equality runs only when the source
        // changes or a key is read; an independent reactive capture has no such guarantee.
        arguments.iter().skip(1).all(|argument| {
            !argument.spread
                && self.reactive_references(*argument).is_empty()
                && self.callback_captures(*argument).is_empty()
        })
    }
}
