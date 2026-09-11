use std::collections::{BTreeMap, BTreeSet};

use super::{
    StaticAliasPath, StaticAliasRoot, dynamic_property_alias_remainder,
    element_wildcard_alias_remainder,
};

// Alias paths are ordered by root before projections. Wildcard rules require an
// equal root, so preserve their original tie order while visiting only that root.
fn aliases_with_root<'a>(
    aliases: &'a BTreeMap<StaticAliasPath, StaticAliasPath>,
    root: &'a StaticAliasRoot,
) -> impl Iterator<Item = (&'a StaticAliasPath, &'a StaticAliasPath)> {
    let first = StaticAliasPath {
        root: root.clone(),
        properties: Vec::new(),
        element_wildcard: false,
    };
    aliases
        .range(first..)
        .take_while(move |(path, _)| &path.root == root)
}

pub(super) fn resolve_static_alias_path(
    aliases: &BTreeMap<StaticAliasPath, StaticAliasPath>,
    original: &StaticAliasPath,
) -> StaticAliasPath {
    resolve_static_alias_path_with_mode(aliases, original, true)
}

pub(super) fn resolve_static_alias_slot_path(
    aliases: &BTreeMap<StaticAliasPath, StaticAliasPath>,
    original: &StaticAliasPath,
) -> StaticAliasPath {
    resolve_static_alias_path_with_mode(aliases, original, false)
}

fn resolve_static_alias_path_with_mode(
    aliases: &BTreeMap<StaticAliasPath, StaticAliasPath>,
    original: &StaticAliasPath,
    allow_exact_alias: bool,
) -> StaticAliasPath {
    resolve_static_alias_path_chain_with_mode(aliases, original, allow_exact_alias)
        .into_iter()
        .last()
        .expect("an alias resolution chain always contains its original path")
}

pub(super) fn resolve_static_alias_path_chain(
    aliases: &BTreeMap<StaticAliasPath, StaticAliasPath>,
    original: &StaticAliasPath,
) -> Vec<StaticAliasPath> {
    resolve_static_alias_path_chain_with_mode(aliases, original, true)
}

fn resolve_static_alias_path_chain_with_mode(
    aliases: &BTreeMap<StaticAliasPath, StaticAliasPath>,
    original: &StaticAliasPath,
    allow_exact_alias: bool,
) -> Vec<StaticAliasPath> {
    let mut current = original.clone().canonicalized();
    let mut visited = BTreeSet::new();
    visited.insert(current.clone());
    let mut chain = vec![current.clone()];

    while visited.len() <= aliases.len() {
        let max_length = allow_exact_alias
            .then_some(current.properties.len())
            .or_else(|| current.properties.len().checked_sub(1));
        let replacement = max_length
            .and_then(|max_length| {
                (0..=max_length).rev().find_map(|length| {
                    let prefix = StaticAliasPath {
                        root: current.root.clone(),
                        properties: current.properties[..length].to_vec(),
                        element_wildcard: false,
                    };
                    aliases.get(&prefix).map(|source| {
                        let mut resolved = source.clone();
                        resolved
                            .properties
                            .extend_from_slice(&current.properties[length..]);
                        resolved.element_wildcard |= current.element_wildcard;
                        resolved.canonicalized()
                    })
                })
            })
            .or_else(|| {
                aliases_with_root(aliases, &current.root)
                    .filter_map(|(target, source)| {
                        let remaining =
                            element_wildcard_alias_remainder(target, &current, allow_exact_alias)?;
                        let mut resolved = source.clone();
                        resolved.properties.extend_from_slice(remaining);
                        Some((target.properties.len(), resolved.canonicalized()))
                    })
                    .max_by_key(|(length, _)| *length)
                    .map(|(_, resolved)| resolved)
            })
            .or_else(|| {
                aliases_with_root(aliases, &current.root)
                    .filter_map(|(target, source)| {
                        let remaining =
                            dynamic_property_alias_remainder(target, &current, allow_exact_alias)?;
                        let mut resolved = source.clone();
                        resolved.properties.extend_from_slice(remaining);
                        Some((target.properties.len(), resolved.canonicalized()))
                    })
                    .max_by_key(|(length, _)| *length)
                    .map(|(_, resolved)| resolved)
            });
        let Some(replacement) = replacement else {
            break;
        };
        if !visited.insert(replacement.clone()) {
            break;
        }
        current = replacement;
        chain.push(current.clone());
    }

    chain
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc::syntax::symbol::SymbolId;

    #[test]
    fn indexed_wildcards_preserve_full_scan_resolution_and_cycle_order() {
        let roots = [
            StaticAliasRoot::Binding(SymbolId::new(0)),
            StaticAliasRoot::Binding(SymbolId::new(1)),
            StaticAliasRoot::UnresolvedGlobal("globalThis".into()),
            StaticAliasRoot::UnresolvedGlobal("Math".into()),
            StaticAliasRoot::DynamicThis { start: 0, end: 10 },
        ];
        let projections: &[&[&str]] = &[
            &[],
            &["x"],
            &["0"],
            &["01"],
            &["0", "x"],
            &["Math", "x"],
            &["<computed-data-property>"],
            &["<computed-data-property>", "x"],
            &["x", "<computed-method-property>"],
            &["<computed-auto-accessor-property>"],
        ];
        let mut paths = Vec::new();
        for root in roots {
            for properties in projections {
                for element_wildcard in [false, true] {
                    paths.push(StaticAliasPath {
                        root: root.clone(),
                        properties: properties.iter().map(|p| (*p).to_owned()).collect(),
                        element_wildcard,
                    });
                }
            }
        }
        let mut seed = 0x5eed_u64;
        for _ in 0..48 {
            let mut aliases = BTreeMap::new();
            for _ in 0..40 {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                let target = paths[(seed >> 32) as usize % paths.len()].clone();
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                let source = paths[(seed >> 32) as usize % paths.len()].clone();
                aliases.insert(target, source);
            }
            for path in &paths {
                for allow_exact in [false, true] {
                    let expected = reference_chain(&aliases, path, allow_exact);
                    assert_eq!(
                        resolve_static_alias_path_chain_with_mode(&aliases, path, allow_exact),
                        expected,
                        "{path:?}/{allow_exact}"
                    );
                    assert_eq!(
                        resolve_static_alias_path_with_mode(&aliases, path, allow_exact),
                        *expected.last().unwrap()
                    );
                }
            }
        }
    }

    fn reference_chain(
        aliases: &BTreeMap<StaticAliasPath, StaticAliasPath>,
        original: &StaticAliasPath,
        allow_exact_alias: bool,
    ) -> Vec<StaticAliasPath> {
        let mut current = original.clone().canonicalized();
        let mut visited = BTreeSet::new();
        visited.insert(current.clone());
        let mut chain = vec![current.clone()];

        while visited.len() <= aliases.len() {
            let max_length = allow_exact_alias
                .then_some(current.properties.len())
                .or_else(|| current.properties.len().checked_sub(1));
            let replacement = max_length
                .and_then(|max_length| {
                    (0..=max_length).rev().find_map(|length| {
                        let prefix = StaticAliasPath {
                            root: current.root.clone(),
                            properties: current.properties[..length].to_vec(),
                            element_wildcard: false,
                        };
                        aliases.get(&prefix).map(|source| {
                            let mut resolved = source.clone();
                            resolved
                                .properties
                                .extend_from_slice(&current.properties[length..]);
                            resolved.element_wildcard |= current.element_wildcard;
                            resolved.canonicalized()
                        })
                    })
                })
                .or_else(|| {
                    aliases
                        .iter()
                        .filter_map(|(target, source)| {
                            let remaining = element_wildcard_alias_remainder(
                                target,
                                &current,
                                allow_exact_alias,
                            )?;
                            let mut resolved = source.clone();
                            resolved.properties.extend_from_slice(remaining);
                            Some((target.properties.len(), resolved.canonicalized()))
                        })
                        .max_by_key(|(length, _)| *length)
                        .map(|(_, resolved)| resolved)
                })
                .or_else(|| {
                    aliases
                        .iter()
                        .filter_map(|(target, source)| {
                            let remaining = dynamic_property_alias_remainder(
                                target,
                                &current,
                                allow_exact_alias,
                            )?;
                            let mut resolved = source.clone();
                            resolved.properties.extend_from_slice(remaining);
                            Some((target.properties.len(), resolved.canonicalized()))
                        })
                        .max_by_key(|(length, _)| *length)
                        .map(|(_, resolved)| resolved)
                });
            let Some(replacement) = replacement else {
                break;
            };
            if !visited.insert(replacement.clone()) {
                break;
            }
            current = replacement;
            chain.push(current.clone());
        }

        chain
    }
}
