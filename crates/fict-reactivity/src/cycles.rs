use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_hir::{BlockId, HirFunction, LocalId, SsaName, SsaVersion};

use crate::{DependencyBase, DependencyPath, ReactiveScopeAnalysis, SsaDefinitionLocation};

/// Dependency edge between tracked bindings, directed producer to consumer.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ReactiveGraphEdge {
    /// Dependency/producer.
    pub from: SsaName,
    /// Derived consumer.
    pub to: SsaName,
    /// Structural dependency path responsible for the edge.
    pub path: DependencyPath,
}

/// Derived cycle classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ReactiveCycleKind {
    /// One derived binding directly or indirectly references itself.
    SelfReference,
    /// Multiple memo/alias/derived bindings form one SCC.
    MutualDerived,
}

/// Canonical strongly connected component that cannot be topologically evaluated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReactiveCycle {
    /// Cycle category.
    pub kind: ReactiveCycleKind,
    /// Sorted SCC members.
    pub nodes: Vec<SsaName>,
    /// Internal edges forming the deterministic witness subgraph.
    pub edges: Vec<ReactiveGraphEdge>,
    /// CFG blocks containing member definitions.
    pub blocks: Vec<BlockId>,
}

/// Cycle pass statistics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ReactiveCycleStats {
    /// Graph nodes.
    pub nodes: u32,
    /// Dependency edges.
    pub edges: u32,
    /// SCC evaluation groups.
    pub groups: u32,
    /// Cyclic SCCs.
    pub cycles: u32,
    /// Largest cyclic SCC.
    pub largest_cycle: u32,
}

/// Reactive graph, SCC order, and derived-cycle witnesses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReactiveCycleAnalysis {
    /// Sorted dependency graph edges.
    pub edges: Vec<ReactiveGraphEdge>,
    /// SCC groups in producer-before-consumer condensation order.
    pub evaluation_groups: Vec<Vec<SsaName>>,
    /// Cyclic groups only.
    pub cycles: Vec<ReactiveCycle>,
    /// Deterministic pass statistics.
    pub stats: ReactiveCycleStats,
}

/// Build the reactive dependency graph and detect derived SCCs.
pub fn analyze_reactive_cycles(
    function: &HirFunction,
    scopes: &ReactiveScopeAnalysis,
) -> Result<ReactiveCycleAnalysis, DiagnosticBundle> {
    let bindings: BTreeMap<_, _> = scopes
        .bindings
        .iter()
        .map(|binding| (binding.name, binding))
        .collect();
    let mut by_local: BTreeMap<LocalId, Vec<SsaName>> = BTreeMap::new();
    for binding in &scopes.bindings {
        by_local
            .entry(binding.name.local)
            .or_default()
            .push(binding.name);
    }
    let nodes: Vec<_> = bindings.keys().copied().collect();
    let mut edges = BTreeSet::new();
    for binding in &scopes.bindings {
        if binding.kind.breaks_derived_cycle() {
            continue;
        }
        for path in &binding.dependencies {
            let DependencyBase::Ssa(raw_source) = path.base else {
                continue;
            };
            let source = if bindings.contains_key(&raw_source) {
                Some(raw_source)
            } else {
                resolve_local_dependency(raw_source, &by_local, &bindings)
            };
            if let Some(source) = source {
                edges.insert(ReactiveGraphEdge {
                    from: source,
                    to: binding.name,
                    path: path.clone(),
                });
            }
        }
    }
    let edges: Vec<_> = edges.into_iter().collect();
    let forward = adjacency(&nodes, &edges, false);
    let reverse = adjacency(&nodes, &edges, true);
    let finish_order = finish_order(&nodes, &forward);
    let mut components = components(&finish_order, &reverse);
    components.sort_by_key(|component| component[0]);
    let component_by_node: BTreeMap<_, _> = components
        .iter()
        .enumerate()
        .flat_map(|(index, component)| component.iter().copied().map(move |node| (node, index)))
        .collect();
    let evaluation_groups = topological_components(&components, &component_by_node, &edges);
    let mut cycles = Vec::new();
    for component in &components {
        let self_edge = component.len() == 1
            && edges
                .iter()
                .any(|edge| edge.from == component[0] && edge.to == component[0]);
        if component.len() == 1 && !self_edge {
            continue;
        }
        let members: BTreeSet<_> = component.iter().copied().collect();
        let internal_edges = edges
            .iter()
            .filter(|edge| members.contains(&edge.from) && members.contains(&edge.to))
            .cloned()
            .collect();
        let blocks = component
            .iter()
            .filter_map(|name| bindings.get(name))
            .filter_map(|binding| definition_block(binding.location))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        cycles.push(ReactiveCycle {
            kind: if component.len() == 1 {
                ReactiveCycleKind::SelfReference
            } else {
                ReactiveCycleKind::MutualDerived
            },
            nodes: component.clone(),
            edges: internal_edges,
            blocks,
        });
    }
    cycles.sort_by_key(|cycle| cycle.nodes[0]);
    let stats = ReactiveCycleStats {
        nodes: count_u32(nodes.len()),
        edges: count_u32(edges.len()),
        groups: count_u32(evaluation_groups.len()),
        cycles: count_u32(cycles.len()),
        largest_cycle: cycles
            .iter()
            .map(|cycle| count_u32(cycle.nodes.len()))
            .max()
            .unwrap_or(0),
    };
    let analysis = ReactiveCycleAnalysis {
        edges,
        evaluation_groups,
        cycles,
        stats,
    };
    verify_reactive_cycles(function, scopes, &analysis)?;
    Ok(analysis)
}

/// Verify graph references, SCC partition/order, cycle witnesses, and stats.
pub fn verify_reactive_cycles(
    function: &HirFunction,
    scopes: &ReactiveScopeAnalysis,
    analysis: &ReactiveCycleAnalysis,
) -> Result<(), DiagnosticBundle> {
    let mut diagnostics = DiagnosticBundle::default();
    let bindings: BTreeMap<_, _> = scopes
        .bindings
        .iter()
        .map(|binding| (binding.name, binding.kind))
        .collect();
    if analysis.edges.windows(2).any(|pair| pair[0] >= pair[1])
        || analysis
            .edges
            .iter()
            .any(|edge| !bindings.contains_key(&edge.from) || !bindings.contains_key(&edge.to))
    {
        diagnostics.push(cycle_error(
            "FICT-CYCLE-EDGE",
            "reactive graph edges must be sorted, unique, and reference tracked bindings",
        ));
    }
    if analysis.edges.iter().any(|edge| {
        bindings
            .get(&edge.to)
            .is_some_and(|kind| kind.breaks_derived_cycle())
    }) {
        diagnostics.push(cycle_error(
            "FICT-CYCLE-STATEFUL",
            "stateful bindings must break incoming derived dependency cycles",
        ));
    }
    let mut group_by_node = BTreeMap::new();
    for (index, group) in analysis.evaluation_groups.iter().enumerate() {
        if group.is_empty() || group.windows(2).any(|pair| pair[0] >= pair[1]) {
            diagnostics.push(cycle_error(
                "FICT-CYCLE-GROUP",
                "evaluation groups must be non-empty, sorted, and unique",
            ));
        }
        for node in group {
            if group_by_node.insert(*node, index).is_some() || !bindings.contains_key(node) {
                diagnostics.push(cycle_error(
                    "FICT-CYCLE-PARTITION",
                    "evaluation groups must partition tracked bindings exactly once",
                ));
            }
        }
    }
    if group_by_node.len() != bindings.len() {
        diagnostics.push(cycle_error(
            "FICT-CYCLE-PARTITION",
            "evaluation groups must cover every tracked binding",
        ));
    }
    for edge in &analysis.edges {
        if let (Some(from), Some(to)) = (group_by_node.get(&edge.from), group_by_node.get(&edge.to))
            && from != to
            && from > to
        {
            diagnostics.push(cycle_error(
                "FICT-CYCLE-ORDER",
                "evaluation groups must place producers before consumers",
            ));
        }
    }
    for cycle in &analysis.cycles {
        let members: BTreeSet<_> = cycle.nodes.iter().copied().collect();
        if cycle.nodes.is_empty()
            || cycle.nodes.windows(2).any(|pair| pair[0] >= pair[1])
            || (cycle.kind == ReactiveCycleKind::SelfReference && cycle.nodes.len() != 1)
            || (cycle.kind == ReactiveCycleKind::MutualDerived && cycle.nodes.len() < 2)
            || cycle.edges.is_empty()
            || cycle
                .edges
                .iter()
                .any(|edge| !members.contains(&edge.from) || !members.contains(&edge.to))
        {
            diagnostics.push(cycle_error(
                "FICT-CYCLE-WITNESS",
                "cycle witnesses must be canonical internal SCC subgraphs",
            ));
        }
        if cycle
            .blocks
            .iter()
            .any(|block| function.blocks.get(block.as_usize()).is_none())
        {
            diagnostics.push(cycle_error(
                "FICT-CYCLE-BLOCK",
                "cycle witnesses must reference valid CFG blocks",
            ));
        }
    }
    if analysis.stats.nodes != count_u32(bindings.len())
        || analysis.stats.edges != count_u32(analysis.edges.len())
        || analysis.stats.groups != count_u32(analysis.evaluation_groups.len())
        || analysis.stats.cycles != count_u32(analysis.cycles.len())
        || analysis.stats.largest_cycle
            != analysis
                .cycles
                .iter()
                .map(|cycle| count_u32(cycle.nodes.len()))
                .max()
                .unwrap_or(0)
    {
        diagnostics.push(cycle_error(
            "FICT-CYCLE-STATS",
            "reactive cycle stats do not match graph arenas",
        ));
    }
    if diagnostics.is_empty() {
        Ok(())
    } else {
        Err(diagnostics)
    }
}

fn resolve_local_dependency(
    unresolved: SsaName,
    by_local: &BTreeMap<LocalId, Vec<SsaName>>,
    bindings: &BTreeMap<SsaName, &crate::ReactiveBindingFact>,
) -> Option<SsaName> {
    // Version zero is the frontend's entry-name placeholder for a source-level forward reference.
    // A missing non-entry version denotes a specific reaching definition and must never be guessed
    // from another version that happens to share its LocalId.
    if unresolved.version != SsaVersion::INITIAL {
        return None;
    }
    let mut candidates = by_local
        .get(&unresolved.local)?
        .iter()
        .copied()
        .filter(|name| {
            bindings
                .get(name)
                .is_some_and(|binding| !binding.kind.breaks_derived_cycle())
        });
    let candidate = candidates.next()?;
    // Branches and loops may produce multiple tracked definitions for one local. Without explicit
    // def-use provenance, choosing either candidate can manufacture a dependency cycle.
    candidates.next().is_none().then_some(candidate)
}

fn adjacency(
    nodes: &[SsaName],
    edges: &[ReactiveGraphEdge],
    reverse: bool,
) -> BTreeMap<SsaName, Vec<SsaName>> {
    let mut result: BTreeMap<_, BTreeSet<_>> = nodes
        .iter()
        .copied()
        .map(|node| (node, BTreeSet::new()))
        .collect();
    for edge in edges {
        let (from, to) = if reverse {
            (edge.to, edge.from)
        } else {
            (edge.from, edge.to)
        };
        result.entry(from).or_default().insert(to);
    }
    result
        .into_iter()
        .map(|(node, successors)| (node, successors.into_iter().collect()))
        .collect()
}

fn finish_order(nodes: &[SsaName], adjacency: &BTreeMap<SsaName, Vec<SsaName>>) -> Vec<SsaName> {
    let mut visited = BTreeSet::new();
    let mut order = Vec::new();
    for root in nodes {
        if visited.contains(root) {
            continue;
        }
        visited.insert(*root);
        let mut stack = vec![(*root, 0_usize)];
        while let Some((node, next)) = stack.last_mut() {
            let successors = adjacency.get(node).map_or(&[][..], Vec::as_slice);
            if *next < successors.len() {
                let successor = successors[*next];
                *next += 1;
                if visited.insert(successor) {
                    stack.push((successor, 0));
                }
            } else {
                let (node, _) = stack.pop().expect("non-empty SCC traversal");
                order.push(node);
            }
        }
    }
    order
}

fn components(
    finish_order: &[SsaName],
    reverse: &BTreeMap<SsaName, Vec<SsaName>>,
) -> Vec<Vec<SsaName>> {
    let mut visited = BTreeSet::new();
    let mut result = Vec::new();
    for root in finish_order.iter().rev() {
        if !visited.insert(*root) {
            continue;
        }
        let mut component = Vec::new();
        let mut stack = vec![*root];
        while let Some(node) = stack.pop() {
            component.push(node);
            if let Some(successors) = reverse.get(&node) {
                for successor in successors.iter().rev() {
                    if visited.insert(*successor) {
                        stack.push(*successor);
                    }
                }
            }
        }
        component.sort_unstable();
        result.push(component);
    }
    result
}

fn topological_components(
    components: &[Vec<SsaName>],
    component_by_node: &BTreeMap<SsaName, usize>,
    edges: &[ReactiveGraphEdge],
) -> Vec<Vec<SsaName>> {
    let mut outgoing = vec![BTreeSet::new(); components.len()];
    let mut indegree = vec![0_usize; components.len()];
    for edge in edges {
        let from = component_by_node[&edge.from];
        let to = component_by_node[&edge.to];
        if from != to && outgoing[from].insert(to) {
            indegree[to] = indegree[to].saturating_add(1);
        }
    }
    let mut ready: BTreeSet<_> = components
        .iter()
        .enumerate()
        .filter(|(index, _)| indegree[*index] == 0)
        .map(|(index, component)| (component[0], index))
        .collect();
    let mut order = Vec::new();
    while let Some((key, index)) = ready.pop_first() {
        let _ = key;
        order.push(components[index].clone());
        for target in &outgoing[index] {
            indegree[*target] = indegree[*target].saturating_sub(1);
            if indegree[*target] == 0 {
                ready.insert((components[*target][0], *target));
            }
        }
    }
    order
}

fn definition_block(location: SsaDefinitionLocation) -> Option<BlockId> {
    match location {
        SsaDefinitionLocation::Instruction { block, .. } | SsaDefinitionLocation::Phi(block) => {
            Some(block)
        }
        SsaDefinitionLocation::Entry => None,
    }
}

fn cycle_error(code: &'static str, message: impl Into<String>) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("cycle diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(GuaranteeClass::Internal)
}

fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
