//! Preserve immutable manual accessor identities without allocating another memo.

use super::{
    BTreeMap, BindingId, HirFile, ImportedHookReturn, ImportedReactiveKind, ReactiveBindingSite,
    ReactiveSlotKind, declaration_initializer,
};

pub(super) fn collect_async_alias_sites(
    hir: &HirFile,
    local_hook_returns: &BTreeMap<BindingId, ImportedHookReturn>,
    sites: &mut BTreeMap<BindingId, ReactiveBindingSite>,
) {
    for function in &hir.functions {
        for instruction in function.blocks.iter().flat_map(|block| &block.instructions) {
            let Some((initializer, local)) = declaration_initializer(function, instruction) else {
                continue;
            };
            let local = &function.locals[local.as_usize()];
            let Some(binding) = local.binding else {
                continue;
            };
            if local.declaration_kind != fict_hir::DeclarationKind::Const
                || sites.contains_key(&binding)
                || fict_hir::async_value_kind(
                    hir,
                    function.id,
                    initializer,
                    Some(local_hook_returns),
                ) != Some(ImportedReactiveKind::AsyncAccessor)
            {
                continue;
            }
            sites.insert(
                binding,
                ReactiveBindingSite {
                    owner: function.id,
                    binding,
                    kind: ReactiveSlotKind::AsyncAccessor,
                    call_value: false,
                    alias_initializer: Some(initializer),
                    origin: instruction.origin,
                },
            );
        }
    }
}
