use super::{BTreeMap, BTreeSet, StaticAliasPath, VecDeque};

// Pure root aliases cannot change a suffix. Their historical possibilities are ordinary graph
// reachability, so cloning the complete traversal history at every edge is unnecessary. Keep
// projected and wildcard rules on the general resolver, where traversal history is semantic.
pub(super) fn resolve_roots(
    aliases: &BTreeMap<StaticAliasPath, BTreeSet<StaticAliasPath>>,
    original: &StaticAliasPath,
    allow_exact_alias: bool,
) -> Option<BTreeSet<StaticAliasPath>> {
    let root_only = |path: &StaticAliasPath| path.properties.is_empty() && !path.element_wildcard;
    if aliases.keys().any(|target| !root_only(target)) {
        return None;
    }
    let original = original.clone().canonicalized();
    if !allow_exact_alias && original.properties.is_empty() {
        return Some(BTreeSet::from([original]));
    }
    let mut root = original.clone();
    root.properties.clear();
    root.element_wildcard = false;
    let mut pending = VecDeque::from([root]);
    let mut roots = BTreeSet::new();
    while let Some(root) = pending.pop_front() {
        if !roots.insert(root.clone()) {
            continue;
        }
        for source in aliases.get(&root).into_iter().flatten() {
            if !root_only(source)
                || (!original.properties.is_empty() && source.is_global_object_root())
            {
                return None;
            }
            if !roots.contains(source) {
                pending.push_back(source.clone());
            }
        }
    }
    Some(
        roots
            .into_iter()
            .map(|mut root| {
                root.properties.clone_from(&original.properties);
                root.element_wildcard = original.element_wildcard;
                root
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hir_builder::resolve_historical_alias_paths_general;

    fn root(index: usize) -> StaticAliasPath {
        StaticAliasPath::unresolved_global(format!("alias{index}"))
    }

    #[test]
    fn root_graph_matches_path_sensitive_resolution_for_cycles_and_suffixes() {
        for edges in 0_u32..256 {
            let aliases = (0..4)
                .map(|index| {
                    let sources = (0..2)
                        .filter(|offset| edges & (1 << (index * 2 + offset)) != 0)
                        .map(|offset| root((index + offset + 1) % 4))
                        .collect();
                    (root(index), sources)
                })
                .collect();
            for original in [
                root(0),
                root(0).with_property("value".into()),
                root(0).with_element_wildcard(),
            ] {
                for exact in [false, true] {
                    assert_eq!(
                        resolve_roots(&aliases, &original, exact).unwrap(),
                        resolve_historical_alias_paths_general(&aliases, &original, exact)
                    );
                }
            }
        }
    }

    #[test]
    fn projected_and_wildcard_aliases_use_the_general_resolver() {
        for (target, source) in [
            (root(0).with_property("value".into()), root(1)),
            (root(0), root(1).with_property("value".into())),
            (root(0).with_element_wildcard(), root(1)),
            (root(0), root(1).with_element_wildcard()),
        ] {
            let aliases = BTreeMap::from([(target, BTreeSet::from([source]))]);
            assert!(resolve_roots(&aliases, &root(0), true).is_none());
        }
    }

    #[test]
    fn global_object_canonicalization_keeps_path_sensitive_traversal() {
        let global_object = StaticAliasPath::unresolved_global("globalThis".into());
        let global_array = StaticAliasPath::unresolved_global("Array".into());
        let aliases = BTreeMap::from([
            (root(0), BTreeSet::from([global_object])),
            (global_array.clone(), BTreeSet::from([root(1)])),
        ]);
        let original = root(0).with_property("Array".into());
        assert!(resolve_roots(&aliases, &original, true).is_none());
        assert_eq!(
            resolve_historical_alias_paths_general(&aliases, &original, true),
            BTreeSet::from([original, global_array, root(1)])
        );
    }
}
