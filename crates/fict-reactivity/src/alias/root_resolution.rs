use std::collections::{BTreeMap, BTreeSet};

use fict_hir::SsaName;

use super::resolve_root;

// Cache only terminating paths in this immutable parent snapshot. Phi updates
// and the next compression sweep receive a fresh cache. Cyclic paths retain the
// existing bounded-walk result, including its deterministic step limit.
pub(super) fn compressed_parents(parents: &BTreeMap<SsaName, SsaName>) -> Vec<(SsaName, SsaName)> {
    let mut roots = BTreeMap::new();
    parents
        .iter()
        .map(|(alias, source)| (*alias, cached_root(*source, parents, &mut roots)))
        .collect()
}

fn cached_root(
    start: SsaName,
    parents: &BTreeMap<SsaName, SsaName>,
    roots: &mut BTreeMap<SsaName, SsaName>,
) -> SsaName {
    let mut current = start;
    let mut path = BTreeSet::new();
    let root = loop {
        if let Some(root) = roots.get(&current) {
            break *root;
        }
        if !path.insert(current) {
            return resolve_root(start, parents);
        }
        let Some(parent) = parents.get(&current).copied() else {
            break current;
        };
        if parent == current {
            break current;
        }
        current = parent;
    };
    roots.extend(path.into_iter().map(|name| (name, root)));
    root
}

#[cfg(test)]
mod tests {
    use super::*;
    use fict_hir::{LocalId, SsaVersion};

    fn name(index: u32) -> SsaName {
        SsaName::new(LocalId::new(index), SsaVersion::new(0))
    }

    #[test]
    fn cached_roots_match_bounded_walk_for_all_small_parent_graphs() {
        // Every four-node graph, including absent edges, self edges, cycles,
        // paths into cycles, and reverse-ordered terminating paths.
        for graph in 0..625_u32 {
            let mut encoded = graph;
            let mut parents = BTreeMap::new();
            for node in 0..4 {
                let source = encoded % 5;
                encoded /= 5;
                if source < 4 {
                    parents.insert(name(node), name(source));
                }
            }
            let expected: Vec<_> = parents
                .iter()
                .map(|(alias, source)| (*alias, resolve_root(*source, &parents)))
                .collect();
            assert_eq!(compressed_parents(&parents), expected, "graph {graph}");
        }
    }

    #[test]
    fn compresses_long_forward_and_reverse_chains() {
        for reverse in [false, true] {
            let parents: BTreeMap<_, _> = (0..1200)
                .map(|index| {
                    if reverse {
                        (name(index), name(index + 1))
                    } else {
                        (name(index + 1), name(index))
                    }
                })
                .collect();
            let root = name(if reverse { 1200 } else { 0 });
            assert!(
                compressed_parents(&parents)
                    .iter()
                    .all(|(_, source)| *source == root)
            );
        }
    }
}
