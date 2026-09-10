use super::{BTreeMap, BTreeSet, ExecutionStateCollector, StaticAliasPath, VecDeque};

// Every read needs one supported alternative; an owning callable alternative needs all of its
// targets. Greatest fixed points start with all eligible paths; least fixed points start empty.
// Reverse dependencies only revisit paths whose support can change.
#[derive(Default)]
pub(super) struct PathRead {
    pub(super) alternatives: Vec<Vec<StaticAliasPath>>,
}

pub(super) type PathRules = BTreeMap<StaticAliasPath, Vec<PathRead>>;

pub(super) struct PathSolution {
    pub(super) paths: BTreeSet<StaticAliasPath>,
    #[cfg(test)]
    checks: usize,
}

pub(super) fn solve_paths(
    paths: BTreeSet<StaticAliasPath>,
    rules: &PathRules,
    greatest: bool,
) -> PathSolution {
    let mut dependents = BTreeMap::<_, BTreeSet<_>>::new();
    for (path, reads) in rules {
        for dependency in reads.iter().flat_map(|read| &read.alternatives).flatten() {
            dependents.entry(dependency).or_default().insert(path);
        }
    }
    let mut queued = rules
        .keys()
        .filter(|path| !greatest || paths.contains(*path))
        .collect::<BTreeSet<_>>();
    let mut pending = VecDeque::from_iter(queued.iter().copied());
    let mut solution = PathSolution {
        paths,
        #[cfg(test)]
        checks: 0,
    };
    while let Some(path) = pending.pop_front() {
        queued.remove(path);
        #[cfg(test)]
        {
            solution.checks += 1;
        }
        if rules[path].iter().all(|read| {
            read.alternatives.iter().any(|alternative| {
                alternative
                    .iter()
                    .all(|dependency| solution.paths.contains(dependency))
            })
        }) == greatest
        {
            continue;
        }
        if greatest {
            solution.paths.remove(path);
        } else {
            solution.paths.insert(path.clone());
        }
        for dependent in dependents.get(path).into_iter().flatten() {
            if solution.paths.contains(*dependent) == greatest && queued.insert(*dependent) {
                pending.push_back(*dependent);
            }
        }
    }
    solution
}

impl ExecutionStateCollector<'_> {
    pub(super) fn merely_observed_paths(
        &self,
        candidates: &BTreeSet<StaticAliasPath>,
        forced_executed_targets: &BTreeSet<StaticAliasPath>,
        trusted_forwardings: &[bool],
        trusted_retained_reads: &[bool],
    ) -> BTreeSet<StaticAliasPath> {
        let paths = candidates
            .iter()
            .filter(|path| path.binding_root().is_some())
            .chain(&self.explicitly_merely_observed_callable_paths)
            .filter(|path| !forced_executed_targets.contains(*path))
            .cloned()
            .collect();
        let mut observations_by_span = BTreeMap::<_, Vec<_>>::new();
        for (path, spans) in &self.merely_observed_value_reads {
            for span in spans {
                observations_by_span.entry(*span).or_default().push(path);
            }
        }
        let mut forwardings_by_span = BTreeMap::<_, Vec<_>>::new();
        for (read, trusted) in self
            .forwarded_callable_reads
            .iter()
            .zip(trusted_forwardings)
        {
            if *trusted {
                forwardings_by_span
                    .entry(read.source_span)
                    .or_default()
                    .push(read);
            }
        }
        let mut retained_by_span = BTreeMap::<_, Vec<_>>::new();
        for (read, trusted) in self
            .retained_callable_reads
            .iter()
            .zip(trusted_retained_reads)
        {
            if *trusted {
                retained_by_span
                    .entry(read.source_span)
                    .or_default()
                    .push(read);
            }
        }
        let mut rules = PathRules::new();
        for path in candidates {
            let Some(root) = path.binding_root() else {
                continue;
            };
            let reads = rules.entry(path.clone()).or_default();
            for span in self
                .binding_reads
                .get(&root)
                .into_iter()
                .flatten()
                .chain(self.direct_callable_reads.get(path).into_iter().flatten())
            {
                if observations_by_span
                    .get(span)
                    .into_iter()
                    .flatten()
                    .any(|observed| observed.starts_with(path) || path.starts_with(observed))
                {
                    continue;
                }
                let mut read = PathRead::default();
                for forwarding in forwardings_by_span.get(span).into_iter().flatten() {
                    if let Some(target) = Self::replace_callable_path_prefix(
                        path,
                        &forwarding.source,
                        &forwarding.target,
                    ) {
                        read.alternatives.push(vec![target]);
                    }
                }
                for forwarding in retained_by_span.get(span).into_iter().flatten() {
                    if forwarding.source.starts_with(path) {
                        read.alternatives.push(vec![forwarding.target.clone()]);
                    }
                }
                for owner in self
                    .read_callable_owner_spans
                    .get(span)
                    .into_iter()
                    .flatten()
                {
                    if let Some(targets) = self.callable_targets_by_span.get(owner)
                        && !targets.is_empty()
                    {
                        read.alternatives.push(targets.iter().cloned().collect());
                    }
                }
                reads.push(read);
            }
        }
        solve_paths(paths, &rules, true).paths
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(index: usize) -> StaticAliasPath {
        StaticAliasPath::unresolved_global(format!("candidate{index:04}"))
    }

    #[test]
    fn alias_chain_fixed_points_have_linear_work_in_both_orders() {
        const LENGTH: usize = 1_200;
        for reverse in [false, true] {
            let paths = (0..LENGTH).map(path).collect();
            let rules = (0..LENGTH)
                .map(|index| {
                    let target = if reverse {
                        index.checked_sub(1)
                    } else {
                        (index + 1 < LENGTH).then_some(index + 1)
                    };
                    (
                        path(index),
                        vec![PathRead {
                            alternatives: target
                                .into_iter()
                                .map(|index| vec![path(index)])
                                .collect(),
                        }],
                    )
                })
                .collect();
            let solution = solve_paths(paths, &rules, true);
            assert!(solution.paths.is_empty());
            assert!(solution.checks <= 2 * LENGTH, "{} checks", solution.checks);
            let mut rules = rules;
            rules.insert(path(if reverse { 0 } else { LENGTH - 1 }), Vec::new());
            let solution = solve_paths(BTreeSet::new(), &rules, false);
            assert_eq!(solution.paths.len(), LENGTH);
            assert!(solution.checks <= 2 * LENGTH, "{} checks", solution.checks);
        }
    }

    #[test]
    fn worklist_matches_rejection_fixed_point_with_cycles_and_alternative_owners() {
        let mut seed = 17_u64;
        let mut next = || {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            usize::try_from(seed >> 32).unwrap()
        };
        for _ in 0..200 {
            let initial = (0..12)
                .filter(|_| next() % 5 != 0)
                .map(path)
                .collect::<BTreeSet<_>>();
            let mut rules = PathRules::new();
            for index in 0..10 {
                let mut reads = Vec::new();
                for _ in 0..next() % 3 {
                    let mut alternatives = Vec::new();
                    for _ in 0..next() % 3 {
                        alternatives.push((0..1 + next() % 3).map(|_| path(next() % 12)).collect());
                    }
                    reads.push(PathRead { alternatives });
                }
                rules.insert(path(index), reads);
            }
            let mut expected = initial.clone();
            loop {
                let rejected = rules
                    .iter()
                    .filter(|(path, reads)| {
                        expected.contains(*path)
                            && !reads.iter().all(|read| {
                                read.alternatives.iter().any(|targets| {
                                    targets.iter().all(|target| expected.contains(target))
                                })
                            })
                    })
                    .map(|(path, _)| path.clone())
                    .collect::<Vec<_>>();
                if rejected.is_empty() {
                    break;
                }
                for path in rejected {
                    expected.remove(&path);
                }
            }
            assert_eq!(solve_paths(initial, &rules, true).paths, expected);
            let mut expected = BTreeSet::new();
            loop {
                let additions = rules
                    .iter()
                    .filter(|(path, reads)| {
                        !expected.contains(*path)
                            && reads.iter().all(|read| {
                                read.alternatives.iter().any(|targets| {
                                    targets.iter().all(|target| expected.contains(target))
                                })
                            })
                    })
                    .map(|(path, _)| path.clone())
                    .collect::<Vec<_>>();
                if additions.is_empty() {
                    break;
                }
                expected.extend(additions);
            }
            assert_eq!(solve_paths(BTreeSet::new(), &rules, false).paths, expected);
        }
    }
}
