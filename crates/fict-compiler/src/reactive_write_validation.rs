use std::{
    cell::Cell,
    collections::{BTreeMap, BTreeSet, VecDeque},
};

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use fict_hir::{
    ArrayElement, BindingId, BindingKind, BlockId, ContextValueKind, DeclarationKind, DeleteTarget,
    FunctionId, HirFile, HirFunction, HirInstructionKind, HirParameter, LocalId, LocalKind,
    ObjectEntry, Origin, Place, PlaceBase, Projection, SsaName, StateMethodCallSemantics,
    StateReceiverKind, TerminatorKind, ValueId, ValueKind, classify_state_method_call,
    classify_state_method_result,
};
use fict_reactivity::{
    DependencyBase, DependencySegment, EscapeKind, ReactiveBindingKind, SsaDefinition,
    SsaDefinitionKind, SsaDefinitionLocation,
};

use crate::pass_manager::FunctionPassAnalysis;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum ReadonlyKind {
    CallbackParameter,
    CallbackThisFreshContainer,
    Alias,
    ProjectedAlias,
    Derived,
    FreshContainer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ReadonlySite {
    kind: ReadonlyKind,
    origin: Origin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct WriteLocation {
    function: FunctionId,
    block: BlockId,
    instruction: u32,
    local: LocalId,
}

#[derive(Debug, Clone, Copy)]
struct InstructionLocation {
    block: BlockId,
    instruction: u32,
}

#[derive(Debug)]
struct StateIdentityAnalysis<'a> {
    hir: &'a HirFile,
    analyses: &'a [FunctionPassAnalysis],
    instruction_locations: Vec<Vec<Option<InstructionLocation>>>,
    definition_locations: Vec<BTreeMap<SsaName, SsaDefinitionLocation>>,
    entry_names: Vec<BTreeMap<LocalId, SsaName>>,
    capture_write_bindings: BTreeSet<BindingId>,
    reassigned_bindings: BTreeSet<BindingId>,
    written_globals: BTreeSet<String>,
    value_visits: Cell<usize>,
}

#[derive(Debug, Clone, Copy)]
struct CallbackBindingFacts<'a> {
    capture_writes: &'a BTreeSet<BindingId>,
    reassignments: &'a BTreeSet<BindingId>,
    written_globals: &'a BTreeSet<String>,
}

type CallbackParameterProvenance = (usize, Option<StateReceiverKind>);

#[derive(Debug)]
struct StateCallbackSignature {
    callback_argument_index: usize,
    parameter_provenance: Vec<CallbackParameterProvenance>,
    this_argument_index: Option<usize>,
    return_feedback_parameter_index: Option<usize>,
    return_disposition: CallbackReturnDisposition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CallbackReturnDisposition {
    Discarded,
    Retained,
}

#[derive(Debug, Clone, Copy)]
enum ProvenanceCandidate {
    ScopeFact {
        function: usize,
        fact: usize,
    },
    Definition {
        function: usize,
        definition: usize,
    },
    Phi {
        function: usize,
        phi: usize,
    },
    Callback {
        function: usize,
        block: usize,
        instruction: usize,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct NameTarget {
    function: usize,
    name: SsaName,
}

#[derive(Debug)]
struct NameGraphOutput {
    names: Vec<BTreeSet<SsaName>>,
    reached_targets: BTreeSet<NameTarget>,
    stats: ProvenanceWorkStats,
}

#[derive(Debug, Default)]
struct ProvenanceWorkStats {
    work_items: usize,
    dependency_edges: usize,
    activated_names: usize,
}

#[derive(Debug)]
struct StateProvenanceOutput {
    names: Vec<BTreeSet<SsaName>>,
    readonly_sites: Vec<BTreeMap<SsaName, ReadonlySite>>,
    callback_receiver_bindings: BTreeMap<BindingId, StateReceiverKind>,
    state_this_functions: BTreeSet<FunctionId>,
    fresh_state_this_functions: BTreeSet<FunctionId>,
    unresolved_callbacks: BTreeMap<(FunctionId, BlockId, u32), Origin>,
    stats: ProvenanceWorkStats,
}

struct StateProvenanceSolver<'a> {
    identity: &'a StateIdentityAnalysis<'a>,
    state_bindings: &'a BTreeSet<BindingId>,
    fresh_state_containers: &'a [BTreeSet<SsaName>],
    scope_fact_names: Vec<BTreeSet<SsaName>>,
    names: Vec<BTreeSet<SsaName>>,
    readonly_sites: Vec<BTreeMap<SsaName, ReadonlySite>>,
    active_bindings: BTreeSet<BindingId>,
    callback_receiver_bindings: BTreeMap<BindingId, StateReceiverKind>,
    state_this_functions: BTreeSet<FunctionId>,
    fresh_state_this_functions: BTreeSet<FunctionId>,
    callback_return_feedbacks: BTreeSet<(usize, usize)>,
    unresolved_callbacks: BTreeMap<(FunctionId, BlockId, u32), Origin>,
    candidates: Vec<ProvenanceCandidate>,
    function_candidates: Vec<Vec<usize>>,
    reverse_dependencies: Vec<BTreeMap<SsaName, Vec<usize>>>,
    capture_dependencies: BTreeMap<BindingId, Vec<usize>>,
    pending: VecDeque<usize>,
    queued: Vec<bool>,
    resolved: Vec<bool>,
    stats: ProvenanceWorkStats,
}

#[derive(Debug)]
pub(crate) struct ReactiveWriteValidationOutput {
    pub(crate) diagnostics: DiagnosticBundle,
    pub(crate) provenance_work_items: usize,
    pub(crate) provenance_dependency_edges: usize,
    pub(crate) provenance_value_visits: usize,
}

impl<'a> StateIdentityAnalysis<'a> {
    fn new(hir: &'a HirFile, analyses: &'a [FunctionPassAnalysis]) -> Self {
        let mut instruction_locations = Vec::with_capacity(hir.functions.len());
        let mut definition_locations = Vec::with_capacity(hir.functions.len());
        let mut entry_names = Vec::with_capacity(hir.functions.len());
        let mut capture_write_bindings = BTreeSet::new();
        let mut reassigned_bindings = BTreeSet::new();
        let mut written_globals = BTreeSet::new();
        for (function_index, function) in hir.functions.iter().enumerate() {
            let mut locations = vec![None; function.values.len()];
            for block in &function.blocks {
                for (instruction_index, instruction) in block.instructions.iter().enumerate() {
                    if let Some(result) = instruction.result
                        && let Some(location) = locations.get_mut(result.as_usize())
                    {
                        *location = Some(InstructionLocation {
                            block: block.id,
                            instruction: count_u32(instruction_index),
                        });
                    }
                }
            }
            instruction_locations.push(locations);
            if let Some(analysis) = analyses.get(function_index) {
                for write in &analysis.dependencies.writes {
                    let DependencyBase::Global(global) = write.path.base else {
                        continue;
                    };
                    let Some(base_name) = hir
                        .globals
                        .get(global.as_usize())
                        .map(|global| global.name.as_str())
                    else {
                        continue;
                    };
                    if write.path.segments.is_empty() {
                        written_globals.insert(base_name.to_owned());
                        continue;
                    }
                    if !matches!(base_name, "globalThis" | "global" | "self" | "window") {
                        continue;
                    }
                    let [segment] = write.path.segments.as_slice() else {
                        continue;
                    };
                    let target_name = match segment {
                        DependencySegment::Static { name, .. } => Some(name.clone()),
                        DependencySegment::Dynamic { key, .. } => {
                            let Some(ValueKind::Literal(fict_hir::LiteralValue::String(name))) =
                                function.values.get(key.as_usize()).map(|value| &value.kind)
                            else {
                                continue;
                            };
                            name.to_utf8()
                        }
                        DependencySegment::Index { .. } => None,
                    };
                    let Some(target_name) = target_name else {
                        continue;
                    };
                    written_globals.insert(target_name);
                }
                for definition in &analysis.ssa.definitions {
                    if matches!(
                        definition.kind,
                        SsaDefinitionKind::Entry
                            | SsaDefinitionKind::Parameter
                            | SsaDefinitionKind::Declare
                    ) {
                        continue;
                    }
                    let Some(local) = function.locals.get(definition.name.local.as_usize()) else {
                        continue;
                    };
                    let Some(binding) = local.binding else {
                        continue;
                    };
                    reassigned_bindings.insert(binding);
                    if local.kind == LocalKind::Capture {
                        capture_write_bindings.insert(binding);
                    }
                }
            }
            let definitions = analyses
                .get(function_index)
                .map(|analysis| {
                    analysis
                        .ssa
                        .definitions
                        .iter()
                        .map(|definition| (definition.name, definition.location))
                        .collect::<BTreeMap<_, _>>()
                })
                .unwrap_or_default();
            entry_names.push(
                definitions
                    .iter()
                    .filter_map(|(name, location)| {
                        (*location == SsaDefinitionLocation::Entry).then_some((name.local, *name))
                    })
                    .collect(),
            );
            definition_locations.push(definitions);
        }
        Self {
            hir,
            analyses,
            instruction_locations,
            definition_locations,
            entry_names,
            capture_write_bindings,
            reassigned_bindings,
            written_globals,
            value_visits: Cell::new(0),
        }
    }

    fn instruction_location(
        &self,
        function: FunctionId,
        value: ValueId,
    ) -> Option<InstructionLocation> {
        self.instruction_locations
            .get(function.as_usize())?
            .get(value.as_usize())
            .copied()
            .flatten()
    }

    fn instruction_for_result(
        &self,
        function: &'a HirFunction,
        value: ValueId,
    ) -> Option<&'a fict_hir::HirInstruction> {
        let location = self.instruction_location(function.id, value)?;
        function
            .blocks
            .get(location.block.as_usize())?
            .instructions
            .get(location.instruction as usize)
    }
}

#[derive(Debug, Default)]
struct CallbackResolution {
    functions: BTreeSet<FunctionId>,
    complete: bool,
}

impl CallbackResolution {
    fn known(function: FunctionId) -> Self {
        Self {
            functions: BTreeSet::from([function]),
            complete: true,
        }
    }

    fn safe_non_callback() -> Self {
        Self {
            functions: BTreeSet::new(),
            complete: true,
        }
    }

    fn merge(&mut self, other: Self) {
        self.functions.extend(other.functions);
        self.complete &= other.complete;
    }
}

fn value_provenance_dependencies(
    identity: &StateIdentityAnalysis<'_>,
    function_index: usize,
    value: ValueId,
) -> BTreeSet<SsaName> {
    let mut names = identity
        .analyses
        .get(function_index)
        .and_then(|analysis| {
            analysis
                .dependencies
                .value_dependencies
                .get(value.as_usize())
        })
        .into_iter()
        .flatten()
        .filter_map(|path| match path.base {
            DependencyBase::Ssa(name) => Some(name),
            DependencyBase::Global(_) | DependencyBase::Value(_) => None,
        })
        .collect::<BTreeSet<_>>();
    match identity
        .hir
        .functions
        .get(function_index)
        .and_then(|function| function.values.get(value.as_usize()))
        .map(|value| &value.kind)
    {
        Some(ValueKind::Ssa(name)) => {
            names.insert(*name);
        }
        Some(ValueKind::Parameter(local)) => {
            if let Some(name) = identity.entry_names[function_index].get(local) {
                names.insert(*name);
            }
        }
        _ => {}
    }
    names
}

fn place_provenance_dependencies(
    identity: &StateIdentityAnalysis<'_>,
    function_index: usize,
    place: &Place,
    location: InstructionLocation,
) -> BTreeSet<SsaName> {
    let analysis = &identity.analyses[function_index];
    let function = &identity.hir.functions[function_index];
    match place.base {
        PlaceBase::Local(local) => ssa_name_before(
            analysis,
            WriteLocation {
                function: function.id,
                block: location.block,
                instruction: location.instruction,
                local,
            },
        )
        .into_iter()
        .collect(),
        PlaceBase::Ssa(name) => BTreeSet::from([name]),
        PlaceBase::Value(value) => value_provenance_dependencies(identity, function_index, value),
        PlaceBase::Global(_) => BTreeSet::new(),
    }
}

fn propagate_name_graph(
    hir: &HirFile,
    mut names: Vec<BTreeSet<SsaName>>,
    reverse_dependencies: &[BTreeMap<SsaName, Vec<NameTarget>>],
    capture_dependencies: &BTreeMap<BindingId, Vec<NameTarget>>,
) -> NameGraphOutput {
    let mut stats = ProvenanceWorkStats {
        dependency_edges: reverse_dependencies
            .iter()
            .flat_map(BTreeMap::values)
            .map(Vec::len)
            .chain(capture_dependencies.values().map(Vec::len))
            .sum(),
        ..ProvenanceWorkStats::default()
    };
    let mut active_bindings = provenance_bindings(hir, &names);
    let mut pending = VecDeque::new();
    let mut queued = BTreeSet::new();
    for (function_index, dependencies) in reverse_dependencies.iter().enumerate() {
        for (source, targets) in dependencies {
            if !names[function_index].contains(source) {
                continue;
            }
            for target in targets {
                if queued.insert(*target) {
                    pending.push_back(*target);
                }
            }
        }
    }
    for binding in &active_bindings {
        if let Some(targets) = capture_dependencies.get(binding) {
            for target in targets {
                if queued.insert(*target) {
                    pending.push_back(*target);
                }
            }
        }
    }

    let mut reached_targets = BTreeSet::new();
    while let Some(target) = pending.pop_front() {
        queued.remove(&target);
        stats.work_items = stats.work_items.saturating_add(1);
        reached_targets.insert(target);
        if !names[target.function].insert(target.name) {
            continue;
        }
        stats.activated_names = stats.activated_names.saturating_add(1);
        if let Some(targets) = reverse_dependencies[target.function].get(&target.name) {
            for dependent in targets {
                if queued.insert(*dependent) {
                    pending.push_back(*dependent);
                }
            }
        }
        let Some(binding) = hir.functions[target.function]
            .locals
            .get(target.name.local.as_usize())
            .and_then(|local| local.binding)
        else {
            continue;
        };
        if active_bindings.insert(binding)
            && let Some(targets) = capture_dependencies.get(&binding)
        {
            for dependent in targets {
                if queued.insert(*dependent) {
                    pending.push_back(*dependent);
                }
            }
        }
    }
    NameGraphOutput {
        names,
        reached_targets,
        stats,
    }
}

impl<'a> StateProvenanceSolver<'a> {
    fn new(
        identity: &'a StateIdentityAnalysis<'a>,
        initial_names: Vec<BTreeSet<SsaName>>,
        state_bindings: &'a BTreeSet<BindingId>,
        fresh_state_containers: &'a [BTreeSet<SsaName>],
    ) -> Self {
        let scope_fact_names = identity
            .analyses
            .iter()
            .map(|analysis| {
                analysis
                    .scopes
                    .bindings
                    .iter()
                    .map(|fact| fact.name)
                    .collect()
            })
            .collect::<Vec<_>>();
        let active_bindings = provenance_bindings(identity.hir, &initial_names);
        let function_count = identity.hir.functions.len();
        let mut solver = Self {
            identity,
            state_bindings,
            fresh_state_containers,
            scope_fact_names,
            names: initial_names,
            readonly_sites: vec![BTreeMap::new(); function_count],
            active_bindings,
            callback_receiver_bindings: BTreeMap::new(),
            state_this_functions: BTreeSet::new(),
            fresh_state_this_functions: BTreeSet::new(),
            callback_return_feedbacks: BTreeSet::new(),
            unresolved_callbacks: BTreeMap::new(),
            candidates: Vec::new(),
            function_candidates: vec![Vec::new(); function_count],
            reverse_dependencies: vec![BTreeMap::new(); function_count],
            capture_dependencies: BTreeMap::new(),
            pending: VecDeque::new(),
            queued: Vec::new(),
            resolved: Vec::new(),
            stats: ProvenanceWorkStats::default(),
        };
        solver.build_candidates();
        solver
    }

    fn build_candidates(&mut self) {
        for (function_index, analysis) in self.identity.analyses.iter().enumerate() {
            let function = &self.identity.hir.functions[function_index];
            for (fact_index, fact) in analysis.scopes.bindings.iter().enumerate() {
                let mut dependencies = definition_source_value(function, fact.location)
                    .map(|value| {
                        value_provenance_dependencies(self.identity, function_index, value)
                    })
                    .unwrap_or_default();
                if let Some(phi) = analysis.ssa.phis.iter().find(|phi| phi.target == fact.name) {
                    dependencies.extend(phi.sources.iter().map(|(_, source)| *source));
                }
                self.register_candidate(
                    ProvenanceCandidate::ScopeFact {
                        function: function_index,
                        fact: fact_index,
                    },
                    function_index,
                    dependencies,
                    None,
                );
            }
            for (definition_index, definition) in analysis.ssa.definitions.iter().enumerate() {
                let dependencies = definition_source_value(function, definition.location)
                    .map(|value| {
                        value_provenance_dependencies(self.identity, function_index, value)
                    })
                    .unwrap_or_default();
                let capture_binding = function
                    .locals
                    .get(definition.name.local.as_usize())
                    .filter(|local| local.kind == LocalKind::Capture)
                    .and_then(|local| local.binding);
                self.register_candidate(
                    ProvenanceCandidate::Definition {
                        function: function_index,
                        definition: definition_index,
                    },
                    function_index,
                    dependencies,
                    capture_binding,
                );
            }
            for (phi_index, phi) in analysis.ssa.phis.iter().enumerate() {
                self.register_candidate(
                    ProvenanceCandidate::Phi {
                        function: function_index,
                        phi: phi_index,
                    },
                    function_index,
                    phi.sources.iter().map(|(_, source)| *source).collect(),
                    None,
                );
            }
            for (block_index, block) in function.blocks.iter().enumerate() {
                for (instruction_index, instruction) in block.instructions.iter().enumerate() {
                    let HirInstructionKind::Call(call) = &instruction.kind else {
                        continue;
                    };
                    let Some(place) = call.callee_reference.as_ref() else {
                        continue;
                    };
                    let location = InstructionLocation {
                        block: block.id,
                        instruction: count_u32(instruction_index),
                    };
                    let mut dependencies = place_provenance_dependencies(
                        self.identity,
                        function_index,
                        place,
                        location,
                    );
                    for argument in &call.arguments {
                        dependencies.extend(value_provenance_dependencies(
                            self.identity,
                            function_index,
                            argument.value,
                        ));
                    }
                    self.register_candidate(
                        ProvenanceCandidate::Callback {
                            function: function_index,
                            block: block_index,
                            instruction: instruction_index,
                        },
                        function_index,
                        dependencies,
                        None,
                    );
                }
            }
        }
        self.queued.resize(self.candidates.len(), false);
        self.resolved.resize(self.candidates.len(), false);
        for candidate in 0..self.candidates.len() {
            self.enqueue(candidate);
        }
    }

    fn register_candidate(
        &mut self,
        candidate: ProvenanceCandidate,
        function_index: usize,
        dependencies: BTreeSet<SsaName>,
        capture_binding: Option<BindingId>,
    ) {
        let candidate_index = self.candidates.len();
        self.candidates.push(candidate);
        self.function_candidates[function_index].push(candidate_index);
        for dependency in dependencies {
            self.reverse_dependencies[function_index]
                .entry(dependency)
                .or_default()
                .push(candidate_index);
            self.stats.dependency_edges = self.stats.dependency_edges.saturating_add(1);
        }
        if let Some(binding) = capture_binding {
            self.capture_dependencies
                .entry(binding)
                .or_default()
                .push(candidate_index);
            self.stats.dependency_edges = self.stats.dependency_edges.saturating_add(1);
        }
    }

    fn enqueue(&mut self, candidate: usize) {
        if self.resolved.get(candidate).copied().unwrap_or(false)
            || self.queued.get(candidate).copied().unwrap_or(false)
        {
            return;
        }
        self.queued[candidate] = true;
        self.pending.push_back(candidate);
    }

    fn activate(&mut self, function_index: usize, name: SsaName) {
        if !self.names[function_index].insert(name) {
            return;
        }
        self.stats.activated_names = self.stats.activated_names.saturating_add(1);
        if let Some(dependents) = self.reverse_dependencies[function_index]
            .get(&name)
            .cloned()
        {
            for dependent in dependents {
                self.enqueue(dependent);
            }
        }
        let Some(binding) = self.identity.hir.functions[function_index]
            .locals
            .get(name.local.as_usize())
            .and_then(|local| local.binding)
        else {
            return;
        };
        if self.active_bindings.insert(binding)
            && let Some(dependents) = self.capture_dependencies.get(&binding).cloned()
        {
            for dependent in dependents {
                self.enqueue(dependent);
            }
        }
    }

    fn activate_state_this(&mut self, function: FunctionId, fresh_container: bool) {
        let mut pending = vec![(function, fresh_container)];
        while let Some((function, fresh_container)) = pending.pop() {
            let newly_state_derived = self.state_this_functions.insert(function);
            let tightened = if fresh_container {
                if newly_state_derived {
                    self.fresh_state_this_functions.insert(function);
                }
                false
            } else {
                self.fresh_state_this_functions.remove(&function)
            };
            if !newly_state_derived && !tightened {
                continue;
            }
            if tightened && let Some(sites) = self.readonly_sites.get_mut(function.as_usize()) {
                for site in sites.values_mut() {
                    if site.kind == ReadonlyKind::CallbackThisFreshContainer {
                        site.kind = ReadonlyKind::Alias;
                    }
                }
            }
            if let Some(candidates) = self.function_candidates.get(function.as_usize()).cloned() {
                for candidate in candidates {
                    self.enqueue(candidate);
                }
            }
            pending.extend(
                self.identity
                    .hir
                    .functions
                    .iter()
                    .filter(|candidate| {
                        candidate.parent == function
                            && candidate.id != function
                            && candidate.flags.is_arrow
                    })
                    .map(|candidate| (candidate.id, fresh_container && !tightened)),
            );
        }
    }

    fn process_callback_return_feedbacks(&mut self) -> bool {
        let mut resolved = Vec::new();
        let mut seeds = Vec::new();
        for &(function_index, parameter_index) in &self.callback_return_feedbacks {
            let Some(function) = self.identity.hir.functions.get(function_index) else {
                resolved.push((function_index, parameter_index));
                continue;
            };
            let Some(analysis) = self.identity.analyses.get(function_index) else {
                resolved.push((function_index, parameter_index));
                continue;
            };
            let Some(parameter) = callback_parameter_for_argument(function, parameter_index) else {
                resolved.push((function_index, parameter_index));
                continue;
            };
            let Some(definition) = analysis.ssa.definitions.iter().find(|definition| {
                definition.name.local == parameter.local
                    && definition.location == SsaDefinitionLocation::Entry
            }) else {
                resolved.push((function_index, parameter_index));
                continue;
            };
            if self.names[function_index].contains(&definition.name) {
                resolved.push((function_index, parameter_index));
                continue;
            }

            let mut carries_state = false;
            let mut all_state_returns_are_fresh = true;
            let mut value_memo = BTreeMap::new();
            let mut name_memo = BTreeMap::new();
            for block in &function.blocks {
                let TerminatorKind::Return { value: Some(value) } = block.terminator.kind else {
                    continue;
                };
                if !value_preserves_state_identity(
                    self.identity,
                    function,
                    analysis,
                    value,
                    &self.names[function_index],
                    &self.state_this_functions,
                ) {
                    continue;
                }
                carries_state = true;
                all_state_returns_are_fresh &= value_is_fresh_state_container(
                    self.identity,
                    function_index,
                    value,
                    &mut value_memo,
                    &mut name_memo,
                    &mut BTreeSet::new(),
                    &mut BTreeSet::new(),
                );
            }
            if carries_state {
                seeds.push((
                    function_index,
                    definition.name,
                    definition.location,
                    if parameter.is_rest || all_state_returns_are_fresh {
                        ReadonlyKind::FreshContainer
                    } else {
                        ReadonlyKind::CallbackParameter
                    },
                ));
                resolved.push((function_index, parameter_index));
            }
        }
        for feedback in resolved {
            self.callback_return_feedbacks.remove(&feedback);
        }
        for (function_index, name, location, kind) in seeds {
            let function = &self.identity.hir.functions[function_index];
            record_readonly_site(
                function,
                name,
                location,
                kind,
                self.state_bindings,
                &mut self.readonly_sites[function_index],
            );
            self.activate(function_index, name);
        }
        !self.pending.is_empty()
    }

    fn run(mut self) -> Result<StateProvenanceOutput, DiagnosticBundle> {
        let maximum_work_items = self
            .candidates
            .len()
            .saturating_mul(2)
            .saturating_add(self.stats.dependency_edges)
            .saturating_add(1);
        loop {
            while let Some(candidate_index) = self.pending.pop_front() {
                self.queued[candidate_index] = false;
                if self.resolved[candidate_index] {
                    continue;
                }
                self.stats.work_items = self.stats.work_items.saturating_add(1);
                if self.stats.work_items > maximum_work_items {
                    return Err(DiagnosticBundle::new(vec![internal_error(
                        "FICT-ANALYSIS-FIXED-POINT",
                        "state provenance propagation exceeded its deterministic work limit",
                    )]));
                }
                let resolved = match self.candidates[candidate_index] {
                    ProvenanceCandidate::ScopeFact { function, fact } => {
                        self.process_scope_fact(function, fact)
                    }
                    ProvenanceCandidate::Definition {
                        function,
                        definition,
                    } => self.process_definition(function, definition),
                    ProvenanceCandidate::Phi { function, phi } => self.process_phi(function, phi),
                    ProvenanceCandidate::Callback {
                        function,
                        block,
                        instruction,
                    } => {
                        self.process_callback(function, block, instruction);
                        false
                    }
                };
                self.resolved[candidate_index] = resolved;
            }
            if !self.process_callback_return_feedbacks() {
                break;
            }
        }
        Ok(StateProvenanceOutput {
            names: self.names,
            readonly_sites: self.readonly_sites,
            callback_receiver_bindings: self.callback_receiver_bindings,
            state_this_functions: self.state_this_functions,
            fresh_state_this_functions: self.fresh_state_this_functions,
            unresolved_callbacks: self.unresolved_callbacks,
            stats: self.stats,
        })
    }

    fn process_scope_fact(&mut self, function_index: usize, fact_index: usize) -> bool {
        let analysis = &self.identity.analyses[function_index];
        let function = &self.identity.hir.functions[function_index];
        let fact = &analysis.scopes.bindings[fact_index];
        if self.names[function_index].contains(&fact.name) {
            return true;
        }
        let depends_on_state =
            definition_source_value(function, fact.location).is_some_and(|value| {
                value_preserves_state_identity(
                    self.identity,
                    function,
                    analysis,
                    value,
                    &self.names[function_index],
                    &self.state_this_functions,
                )
            }) || analysis
                .ssa
                .phis
                .iter()
                .find(|phi| phi.target == fact.name)
                .is_some_and(|phi| {
                    phi.sources.iter().any(|(_, source)| {
                        name_resolves_to_set(*source, &self.names[function_index])
                    })
                });
        if depends_on_state {
            self.activate(function_index, fact.name);
        }
        depends_on_state
    }

    fn process_definition(&mut self, function_index: usize, definition_index: usize) -> bool {
        let analysis = &self.identity.analyses[function_index];
        let function = &self.identity.hir.functions[function_index];
        let definition = &analysis.ssa.definitions[definition_index];
        let local_binding = function
            .locals
            .get(definition.name.local.as_usize())
            .and_then(|local| local.binding);
        let state_binding_definition =
            local_binding.is_some_and(|binding| self.state_bindings.contains(&binding));
        let capture_from_outer_scope = function
            .locals
            .get(definition.name.local.as_usize())
            .is_some_and(|local| {
                local.kind == LocalKind::Capture
                    && local
                        .binding
                        .is_some_and(|binding| self.active_bindings.contains(&binding))
            });
        let depends_on_state =
            definition_source_value(function, definition.location).is_some_and(|value| {
                value_preserves_state_identity(
                    self.identity,
                    function,
                    analysis,
                    value,
                    &self.names[function_index],
                    &self.state_this_functions,
                )
            });
        if !state_binding_definition && !capture_from_outer_scope && !depends_on_state {
            return false;
        }
        if !self.scope_fact_names[function_index].contains(&definition.name) {
            let kind = if self.fresh_state_containers[function_index].contains(&definition.name) {
                ReadonlyKind::FreshContainer
            } else {
                definition_source_value(function, definition.location)
                    .and_then(|value| {
                        projected_alias_kind(
                            function,
                            value,
                            &self.readonly_sites[function_index],
                            &self.fresh_state_this_functions,
                            &mut BTreeSet::new(),
                        )
                    })
                    .unwrap_or(ReadonlyKind::Alias)
            };
            record_readonly_site(
                function,
                definition.name,
                definition.location,
                kind,
                self.state_bindings,
                &mut self.readonly_sites[function_index],
            );
        }
        self.activate(function_index, definition.name);
        true
    }

    fn process_phi(&mut self, function_index: usize, phi_index: usize) -> bool {
        let analysis = &self.identity.analyses[function_index];
        let function = &self.identity.hir.functions[function_index];
        let phi = &analysis.ssa.phis[phi_index];
        if !phi
            .sources
            .iter()
            .any(|(_, source)| name_resolves_to_set(*source, &self.names[function_index]))
        {
            return false;
        }
        record_readonly_site(
            function,
            phi.target,
            SsaDefinitionLocation::Phi(phi.block),
            ReadonlyKind::Alias,
            self.state_bindings,
            &mut self.readonly_sites[function_index],
        );
        self.activate(function_index, phi.target);
        true
    }

    fn process_callback(
        &mut self,
        function_index: usize,
        block_index: usize,
        instruction_index: usize,
    ) {
        let analysis = &self.identity.analyses[function_index];
        let function = &self.identity.hir.functions[function_index];
        let block = &function.blocks[block_index];
        let instruction = &block.instructions[instruction_index];
        let HirInstructionKind::Call(call) = &instruction.kind else {
            return;
        };
        let Some(place) = call.callee_reference.as_ref() else {
            return;
        };
        let Some(callback_signatures) = state_callback_signatures(
            self.identity,
            function,
            analysis,
            &self.names[function_index],
            &self.state_this_functions,
            call,
            place,
        ) else {
            return;
        };
        let location = WriteLocation {
            function: function.id,
            block: block.id,
            instruction: count_u32(instruction_index),
            local: LocalId::new(0),
        };
        if !place_depends_on_state(
            self.identity,
            function,
            analysis,
            place,
            location,
            &self.names[function_index],
            &self.state_this_functions,
        ) {
            return;
        }
        let mut seeds = Vec::new();
        for StateCallbackSignature {
            callback_argument_index,
            parameter_provenance,
            this_argument_index,
            return_feedback_parameter_index,
            return_disposition,
        } in callback_signatures
        {
            let Some(callback_argument) = call.arguments.get(callback_argument_index) else {
                continue;
            };
            let resolution = if callback_argument.spread {
                CallbackResolution::default()
            } else {
                resolve_callback_value(
                    self.identity.hir,
                    analysis,
                    function,
                    CallbackBindingFacts {
                        capture_writes: &self.identity.capture_write_bindings,
                        reassignments: &self.identity.reassigned_bindings,
                        written_globals: &self.identity.written_globals,
                    },
                    callback_argument.value,
                    InstructionLocation {
                        block: block.id,
                        instruction: count_u32(instruction_index),
                    },
                )
            };
            if !resolution.complete {
                self.unresolved_callbacks
                    .entry((function.id, block.id, count_u32(instruction_index)))
                    .or_insert(instruction.origin);
            }
            for callback in resolution.functions {
                let callback_index = callback.as_usize();
                let Some(callback_function) = self.identity.hir.functions.get(callback_index)
                else {
                    continue;
                };
                // Invoking a generator callback only creates its iterator. Hosts that discard or
                // coerce that value cannot execute the body later; retained iterators still can.
                if callback_function.flags.is_generator
                    && return_disposition == CallbackReturnDisposition::Discarded
                {
                    continue;
                }
                if !callback_function.flags.is_async
                    && !callback_function.flags.is_generator
                    && let Some(parameter_index) = return_feedback_parameter_index
                {
                    self.callback_return_feedbacks
                        .insert((callback_index, parameter_index));
                }
                if !callback_function.flags.is_arrow
                    && let Some(argument) = this_argument_index
                        .and_then(|index| call.arguments.get(index))
                        .filter(|argument| {
                            value_preserves_state_identity(
                                self.identity,
                                function,
                                analysis,
                                argument.value,
                                &self.names[function_index],
                                &self.state_this_functions,
                            )
                        })
                {
                    let fresh_container = value_is_fresh_state_container(
                        self.identity,
                        function_index,
                        argument.value,
                        &mut BTreeMap::new(),
                        &mut BTreeMap::new(),
                        &mut BTreeSet::new(),
                        &mut BTreeSet::new(),
                    );
                    self.activate_state_this(callback, fresh_container);
                }
                let Some(callback_analysis) = self.identity.analyses.get(callback_index) else {
                    continue;
                };
                for (index, receiver_kind) in &parameter_provenance {
                    let Some(parameter) =
                        callback_parameter_for_argument(callback_function, *index)
                    else {
                        continue;
                    };
                    let Some(definition) =
                        callback_analysis.ssa.definitions.iter().find(|definition| {
                            definition.name.local == parameter.local
                                && definition.location == SsaDefinitionLocation::Entry
                        })
                    else {
                        continue;
                    };
                    let binding = receiver_kind.and_then(|receiver_kind| {
                        callback_function
                            .locals
                            .get(parameter.local.as_usize())
                            .and_then(|local| local.binding)
                            .map(|binding| (binding, receiver_kind))
                    });
                    seeds.push((
                        callback_index,
                        definition.name,
                        definition.location,
                        if parameter.is_rest {
                            ReadonlyKind::FreshContainer
                        } else {
                            ReadonlyKind::CallbackParameter
                        },
                        binding,
                    ));

                    let Some(pattern) = self
                        .identity
                        .hir
                        .syntax_fragments
                        .get(parameter.pattern.as_usize())
                        .and_then(|fragment| fragment.summary.pattern.as_ref())
                    else {
                        continue;
                    };
                    for binding in &pattern.declared_bindings {
                        if parameter.binding == Some(*binding) {
                            continue;
                        }
                        let Some(local) = callback_function.locals.iter().find(|local| {
                            local.binding == Some(*binding)
                                && local.declaration_kind == DeclarationKind::Parameter
                        }) else {
                            continue;
                        };
                        let definition_kind = if local.kind == LocalKind::Parameter {
                            SsaDefinitionKind::Parameter
                        } else {
                            SsaDefinitionKind::Declare
                        };
                        let Some(definition) =
                            callback_analysis.ssa.definitions.iter().find(|definition| {
                                definition.name.local == local.id
                                    && definition.kind == definition_kind
                            })
                        else {
                            continue;
                        };
                        let kind = if parameter.rest_bindings.contains(binding) {
                            ReadonlyKind::FreshContainer
                        } else {
                            ReadonlyKind::CallbackParameter
                        };
                        seeds.push((
                            callback_index,
                            definition.name,
                            definition.location,
                            kind,
                            None,
                        ));
                    }
                }
            }
        }
        for (callback_index, name, location, kind, receiver_binding) in seeds {
            let callback_function = &self.identity.hir.functions[callback_index];
            record_readonly_site(
                callback_function,
                name,
                location,
                kind,
                self.state_bindings,
                &mut self.readonly_sites[callback_index],
            );
            if let Some((binding, receiver_kind)) = receiver_binding {
                self.callback_receiver_bindings
                    .entry(binding)
                    .and_modify(|existing| {
                        if *existing != receiver_kind {
                            *existing = StateReceiverKind::Unknown;
                        }
                    })
                    .or_insert(receiver_kind);
            }
            self.activate(callback_index, name);
        }
    }
}

fn propagate_state_provenance(
    identity: &StateIdentityAnalysis<'_>,
    initial_names: Vec<BTreeSet<SsaName>>,
    state_bindings: &BTreeSet<BindingId>,
    fresh_state_containers: &[BTreeSet<SsaName>],
) -> Result<StateProvenanceOutput, DiagnosticBundle> {
    StateProvenanceSolver::new(
        identity,
        initial_names,
        state_bindings,
        fresh_state_containers,
    )
    .run()
}

fn propagate_pattern_provenance(
    identity: &StateIdentityAnalysis<'_>,
    names: Vec<BTreeSet<SsaName>>,
    readonly_sites: &mut [BTreeMap<SsaName, ReadonlySite>],
) -> (Vec<BTreeSet<SsaName>>, ProvenanceWorkStats) {
    let mut reverse_dependencies = vec![BTreeMap::new(); identity.hir.functions.len()];
    let mut sites = BTreeMap::new();
    for (function_index, analysis) in identity.analyses.iter().enumerate() {
        let function = &identity.hir.functions[function_index];
        for block in &function.blocks {
            for (instruction_index, instruction) in block.instructions.iter().enumerate() {
                let instruction_index = count_u32(instruction_index);
                let mut add_target = |value, target: NameTarget, site: ReadonlySite| {
                    for source in value_provenance_dependencies(identity, function_index, value) {
                        reverse_dependencies[function_index]
                            .entry(source)
                            .or_insert_with(Vec::new)
                            .push(target);
                    }
                    sites.entry(target).or_insert(site);
                };
                match &instruction.kind {
                    HirInstructionKind::Declare {
                        local,
                        initializer: Some(initializer),
                        ..
                    } if is_pattern_binding_declaration(
                        identity.hir,
                        function,
                        *local,
                        *initializer,
                    ) =>
                    {
                        if let Some(name) =
                            definition_at(analysis, block.id, instruction_index, *local)
                        {
                            add_target(
                                *initializer,
                                NameTarget {
                                    function: function_index,
                                    name,
                                },
                                ReadonlySite {
                                    kind: ReadonlyKind::Alias,
                                    origin: function.locals[local.as_usize()].origin,
                                },
                            );
                        }
                    }
                    HirInstructionKind::PatternAssignment { value, writes, .. } => {
                        for write in writes {
                            if let Some(name) =
                                definition_at(analysis, block.id, instruction_index, write.local)
                            {
                                add_target(
                                    *value,
                                    NameTarget {
                                        function: function_index,
                                        name,
                                    },
                                    ReadonlySite {
                                        kind: ReadonlyKind::Alias,
                                        origin: write.origin,
                                    },
                                );
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    let output = propagate_name_graph(identity.hir, names, &reverse_dependencies, &BTreeMap::new());
    for target in &output.reached_targets {
        if let Some(site) = sites.get(target) {
            readonly_sites[target.function].insert(target.name, *site);
        }
    }
    (output.names, output.stats)
}

fn propagate_phi_names(
    hir: &HirFile,
    analyses: &[FunctionPassAnalysis],
    names: Vec<BTreeSet<SsaName>>,
) -> (Vec<BTreeSet<SsaName>>, ProvenanceWorkStats) {
    let mut reverse_dependencies = vec![BTreeMap::new(); hir.functions.len()];
    for (function_index, analysis) in analyses.iter().enumerate() {
        for phi in &analysis.ssa.phis {
            let target = NameTarget {
                function: function_index,
                name: phi.target,
            };
            for (_, source) in &phi.sources {
                reverse_dependencies[function_index]
                    .entry(*source)
                    .or_insert_with(Vec::new)
                    .push(target);
            }
        }
    }
    let output = propagate_name_graph(hir, names, &reverse_dependencies, &BTreeMap::new());
    (output.names, output.stats)
}

struct WriteValidationContext<'a> {
    identity: &'a StateIdentityAnalysis<'a>,
    analyses: &'a [FunctionPassAnalysis],
    state_provenance_names: &'a [BTreeSet<SsaName>],
    state_this_functions: &'a BTreeSet<FunctionId>,
    fresh_state_this_functions: &'a BTreeSet<FunctionId>,
    readonly_sites: &'a [BTreeMap<SsaName, ReadonlySite>],
    readonly_names: &'a [BTreeSet<SsaName>],
    readonly_bindings: &'a BTreeMap<BindingId, ReadonlySite>,
    strict_guarantee: bool,
}

pub(crate) fn validate_reactive_writes(
    hir: &HirFile,
    analyses: &[FunctionPassAnalysis],
    strict_guarantee: bool,
) -> Result<ReactiveWriteValidationOutput, DiagnosticBundle> {
    if analyses.len() != hir.functions.len()
        || analyses
            .iter()
            .enumerate()
            .any(|(index, analysis)| analysis.function.as_usize() != index)
    {
        return Err(DiagnosticBundle::new(vec![internal_error(
            "FICT-PASS-ANALYSIS",
            "reactive write validation requires final analysis for every HIR function in arena order",
        )]));
    }

    let identity = StateIdentityAnalysis::new(hir, analyses);
    let mut initial_state_names = vec![BTreeSet::new(); hir.functions.len()];
    let mut state_bindings = BTreeSet::new();

    for analysis in analyses {
        let function_index = analysis.function.as_usize();
        let Some(function) = hir.functions.get(function_index) else {
            continue;
        };
        for fact in &analysis.scopes.bindings {
            if fact.kind == ReactiveBindingKind::State {
                initial_state_names[function_index].insert(fact.name);
                if let Some(binding) = function
                    .locals
                    .get(fact.name.local.as_usize())
                    .and_then(|local| local.binding)
                {
                    state_bindings.insert(binding);
                }
            }
        }
    }
    let fresh_state_containers = analyze_fresh_state_containers(&identity);
    let propagation = propagate_state_provenance(
        &identity,
        initial_state_names,
        &state_bindings,
        &fresh_state_containers,
    )?;
    let mut state_provenance_names = propagation.names;
    let mut readonly_sites = propagation.readonly_sites;
    let state_callback_receiver_bindings = propagation.callback_receiver_bindings;
    let state_this_functions = propagation.state_this_functions;
    let fresh_state_this_functions = propagation.fresh_state_this_functions;
    let unresolved_state_callbacks = propagation.unresolved_callbacks;
    let mut provenance_stats = propagation.stats;

    for analysis in analyses {
        let function_index = analysis.function.as_usize();
        let function = &hir.functions[function_index];
        for fact in &analysis.scopes.bindings {
            let carries_state_identity =
                state_provenance_names[function_index].contains(&fact.name);
            let derives_from_state = fact.dependencies.iter().any(|path| {
                matches!(path.base, DependencyBase::Ssa(source)
                    if name_resolves_to_set(source, &state_provenance_names[function_index]))
            });
            if !carries_state_identity
                && !(fact.kind == ReactiveBindingKind::Derived && derives_from_state)
            {
                continue;
            }
            if function
                .locals
                .get(fact.name.local.as_usize())
                .and_then(|local| local.binding)
                .is_some_and(|binding| state_bindings.contains(&binding))
            {
                continue;
            }
            let projected_kind =
                definition_source_value(function, fact.location).and_then(|value| {
                    projected_alias_kind(
                        function,
                        value,
                        &readonly_sites[function_index],
                        &fresh_state_this_functions,
                        &mut BTreeSet::new(),
                    )
                });
            let kind = match fact.kind {
                ReactiveBindingKind::Derived
                    if !carries_state_identity
                        && definition_is_readonly_derived_declaration(
                            function,
                            fact.location,
                            fact.name.local,
                        ) =>
                {
                    Some(ReadonlyKind::Derived)
                }
                ReactiveBindingKind::Alias | ReactiveBindingKind::Derived
                    if projected_kind == Some(ReadonlyKind::CallbackThisFreshContainer) =>
                {
                    projected_kind
                }
                ReactiveBindingKind::Alias | ReactiveBindingKind::Derived
                    if fresh_state_containers[function_index].contains(&fact.name) =>
                {
                    Some(ReadonlyKind::FreshContainer)
                }
                ReactiveBindingKind::Alias => Some(ReadonlyKind::Alias),
                ReactiveBindingKind::Derived
                    if definition_is_readonly_derived_declaration(
                        function,
                        fact.location,
                        fact.name.local,
                    ) =>
                {
                    Some(ReadonlyKind::Derived)
                }
                ReactiveBindingKind::State
                | ReactiveBindingKind::Memo
                | ReactiveBindingKind::Store
                | ReactiveBindingKind::Resource
                | ReactiveBindingKind::Selector
                | ReactiveBindingKind::Derived => None,
            };
            if let Some(kind) = kind {
                readonly_sites[function_index].insert(
                    fact.name,
                    ReadonlySite {
                        kind,
                        origin: definition_origin(function, fact.location, fact.name.local),
                    },
                );
            }
        }
    }

    // Binding patterns are retained as adapter-owned syntax values. Recover read-only
    // provenance from their structural dependencies after the regular scope fixed point, then
    // propagate only newly reached SSA names so nested and multi-hop destructuring stays linear.
    let (pattern_names, pattern_stats) =
        propagate_pattern_provenance(&identity, state_provenance_names, &mut readonly_sites);
    state_provenance_names = pattern_names;
    provenance_stats.work_items = provenance_stats
        .work_items
        .saturating_add(pattern_stats.work_items);
    provenance_stats.dependency_edges = provenance_stats
        .dependency_edges
        .saturating_add(pattern_stats.dependency_edges);

    let readonly_names = readonly_sites
        .iter()
        .map(|sites| sites.keys().copied().collect::<BTreeSet<_>>())
        .collect::<Vec<_>>();
    let (readonly_names, readonly_phi_stats) = propagate_phi_names(hir, analyses, readonly_names);
    provenance_stats.work_items = provenance_stats
        .work_items
        .saturating_add(readonly_phi_stats.work_items);
    provenance_stats.dependency_edges = provenance_stats
        .dependency_edges
        .saturating_add(readonly_phi_stats.dependency_edges);
    let (callback_provenance_names, callback_stats) =
        propagate_callback_provenance(&identity, &readonly_sites);
    provenance_stats.work_items = provenance_stats
        .work_items
        .saturating_add(callback_stats.work_items);
    provenance_stats.dependency_edges = provenance_stats
        .dependency_edges
        .saturating_add(callback_stats.dependency_edges);
    let mut readonly_bindings = BTreeMap::new();
    for analysis in analyses {
        let function_index = analysis.function.as_usize();
        let function = &hir.functions[function_index];
        for (name, site) in &readonly_sites[function_index] {
            let Some(local) = function.locals.get(name.local.as_usize()) else {
                continue;
            };
            let Some(binding) = local.binding else {
                continue;
            };
            if state_bindings.contains(&binding) {
                continue;
            }
            readonly_bindings
                .entry(binding)
                .and_modify(|current| select_earlier_site(current, *site))
                .or_insert(*site);
        }
    }
    let validation = WriteValidationContext {
        identity: &identity,
        analyses,
        state_provenance_names: &state_provenance_names,
        state_this_functions: &state_this_functions,
        fresh_state_this_functions: &fresh_state_this_functions,
        readonly_sites: &readonly_sites,
        readonly_names: &readonly_names,
        readonly_bindings: &readonly_bindings,
        strict_guarantee,
    };

    let mut diagnostics = DiagnosticBundle::default();
    for function in &hir.functions {
        for block in &function.blocks {
            for (instruction_index, instruction) in block.instructions.iter().enumerate() {
                let instruction_index = count_u32(instruction_index);
                match &instruction.kind {
                    HirInstructionKind::Write { place, .. }
                    | HirInstructionKind::ReadWrite { place, .. } => {
                        validation.validate_place_write(
                            function,
                            InstructionLocation {
                                block: block.id,
                                instruction: instruction_index,
                            },
                            place,
                            instruction.origin,
                            &mut diagnostics,
                        );
                    }
                    HirInstructionKind::PatternAssignment { writes, .. } => {
                        for write in writes {
                            validation.validate_local_write(
                                function,
                                WriteLocation {
                                    function: function.id,
                                    block: block.id,
                                    instruction: instruction_index,
                                    local: write.local,
                                },
                                write.origin,
                                0,
                                &mut diagnostics,
                            );
                        }
                    }
                    HirInstructionKind::Iteration { targets, .. } => {
                        for local in targets {
                            validation.validate_local_write(
                                function,
                                WriteLocation {
                                    function: function.id,
                                    block: block.id,
                                    instruction: instruction_index,
                                    local: *local,
                                },
                                instruction.origin,
                                0,
                                &mut diagnostics,
                            );
                        }
                    }
                    HirInstructionKind::Delete {
                        target: DeleteTarget::Place(place),
                    } => {
                        validation.validate_place_write(
                            function,
                            InstructionLocation {
                                block: block.id,
                                instruction: instruction_index,
                            },
                            place,
                            instruction.origin,
                            &mut diagnostics,
                        );
                    }
                    HirInstructionKind::Call(call)
                        if state_method_call_may_mutate(function, call) =>
                    {
                        let place = call
                            .callee_reference
                            .as_ref()
                            .expect("guarded method reference");
                        if value_receiver_call_is_proven_safe(function, place) {
                            continue;
                        }
                        validation.validate_place_write(
                            function,
                            InstructionLocation {
                                block: block.id,
                                instruction: instruction_index,
                            },
                            place,
                            instruction.origin,
                            &mut diagnostics,
                        );
                    }
                    _ => {}
                }
            }
        }
    }
    validate_callback_provenance_escapes(
        &identity,
        &callback_provenance_names,
        &state_bindings,
        &state_callback_receiver_bindings,
        strict_guarantee,
        &mut diagnostics,
    );
    diagnose_unresolved_state_callbacks(
        &unresolved_state_callbacks,
        strict_guarantee,
        &mut diagnostics,
    );

    if diagnostics.has_errors() {
        Err(diagnostics)
    } else {
        Ok(ReactiveWriteValidationOutput {
            diagnostics,
            provenance_work_items: provenance_stats.work_items,
            provenance_dependency_edges: provenance_stats.dependency_edges,
            provenance_value_visits: identity.value_visits.get(),
        })
    }
}

impl WriteValidationContext<'_> {
    fn validate_place_write(
        &self,
        function: &HirFunction,
        location: InstructionLocation,
        place: &Place,
        write_origin: Origin,
        diagnostics: &mut DiagnosticBundle,
    ) {
        if let Some(local) = place_root_local(place) {
            self.validate_local_write(
                function,
                WriteLocation {
                    function: function.id,
                    block: location.block,
                    instruction: location.instruction,
                    local,
                },
                write_origin,
                place.projections.len(),
                diagnostics,
            );
            return;
        }
        let PlaceBase::Value(value) = place.base else {
            return;
        };
        let Some(analysis) = self.analyses.get(function.id.as_usize()) else {
            return;
        };
        if place.projections.len() <= 1
            && self.fresh_state_this_functions.contains(&function.id)
            && projected_alias_kind(
                function,
                value,
                &BTreeMap::new(),
                self.fresh_state_this_functions,
                &mut BTreeSet::new(),
            ) == Some(ReadonlyKind::CallbackThisFreshContainer)
        {
            return;
        }
        if !value_preserves_state_identity(
            self.identity,
            function,
            analysis,
            value,
            &self.state_provenance_names[function.id.as_usize()],
            self.state_this_functions,
        ) {
            return;
        }
        let mut diagnostic = Diagnostic::new(
            DiagnosticCode::new("FICT-M").expect("reactive mutation diagnostic literal"),
            if self.strict_guarantee {
                DiagnosticSeverity::Error
            } else {
                DiagnosticSeverity::Warning
            },
            "nested mutation through a state-derived expression cannot preserve fine-grained reactivity",
        )
        .with_help("replace the whole source state value or use $store for nested mutation")
        .with_guarantee_class(GuaranteeClass::Fallback);
        if let Some(primary_span) = write_origin.primary_span {
            diagnostic = diagnostic.with_primary_span(primary_span);
        }
        diagnostics.push(diagnostic);
    }

    fn validate_local_write(
        &self,
        function: &HirFunction,
        location: WriteLocation,
        write_origin: Origin,
        projection_depth: usize,
        diagnostics: &mut DiagnosticBundle,
    ) {
        let Some(local_fact) = function.locals.get(location.local.as_usize()) else {
            return;
        };
        let Some(binding) = local_fact.binding else {
            return;
        };
        let Some(site) =
            self.readonly_site_at(location, binding, local_fact.kind == LocalKind::Capture)
        else {
            return;
        };
        if matches!(
            site.kind,
            ReadonlyKind::CallbackParameter | ReadonlyKind::ProjectedAlias
        ) && projection_depth == 0
        {
            return;
        }
        if matches!(
            site.kind,
            ReadonlyKind::FreshContainer | ReadonlyKind::CallbackThisFreshContainer
        ) && projection_depth <= 1
        {
            return;
        }

        let name = local_fact
            .debug_name
            .as_deref()
            .unwrap_or("reactive binding");
        let primary_span = write_origin
            .primary_span
            .or(local_fact.origin.primary_span)
            .or(site.origin.primary_span);
        let (mut diagnostic, label) = if projection_depth == 0 {
            match site.kind {
                ReadonlyKind::Alias => (
                    validation_error(
                        "FICT-R-ALIAS-WRITE",
                        format!("cannot write to read-only reactive alias `{name}`"),
                    )
                    .with_help(
                        "update the original state binding or assign the new value to a different local",
                    ),
                    "reactive alias is established here",
                ),
                ReadonlyKind::CallbackParameter | ReadonlyKind::ProjectedAlias => {
                    unreachable!("callback and projected alias roots are mutable snapshots")
                }
                ReadonlyKind::Derived => (
                    validation_error(
                        "FICT-R-DERIVED-WRITE",
                        format!(
                            "cannot write to derived value `{name}`; derived values are read-only"
                        ),
                    )
                    .with_help(
                        "update the source state or compute the replacement under a new local binding",
                    ),
                    "derived value is established here",
                ),
                ReadonlyKind::FreshContainer | ReadonlyKind::CallbackThisFreshContainer => {
                    unreachable!("fresh container roots are mutable")
                }
            }
        } else {
            (
                Diagnostic::new(
                    DiagnosticCode::new("FICT-M").expect("reactive mutation diagnostic literal"),
                    if self.strict_guarantee {
                        DiagnosticSeverity::Error
                    } else {
                        DiagnosticSeverity::Warning
                    },
                    format!(
                        "nested mutation through reactive alias `{name}` cannot preserve fine-grained reactivity"
                    ),
                )
                .with_help("replace the whole source state value or use $store for nested mutation")
                .with_guarantee_class(GuaranteeClass::Fallback),
                if matches!(
                    site.kind,
                    ReadonlyKind::FreshContainer | ReadonlyKind::CallbackThisFreshContainer
                ) {
                    "state-derived values are contained here"
                } else {
                    "reactive alias is established here"
                },
            )
        };
        if let Some(primary_span) = primary_span {
            diagnostic = diagnostic.with_primary_span(primary_span);
        }
        if let Some(site_span) = site.origin.primary_span
            && Some(site_span) != primary_span
        {
            diagnostic = diagnostic.with_secondary_label(site_span, label);
        }
        diagnostics.push(diagnostic);
    }

    fn readonly_site_at(
        &self,
        location: WriteLocation,
        binding: BindingId,
        captured: bool,
    ) -> Option<ReadonlySite> {
        if captured {
            return self.readonly_bindings.get(&binding).copied();
        }
        let analysis = self.analyses.get(location.function.as_usize())?;
        let previous = ssa_name_before(analysis, location)?;
        if let Some(site) = self
            .readonly_sites
            .get(location.function.as_usize())
            .and_then(|sites| sites.get(&previous))
        {
            return Some(*site);
        }
        if self
            .readonly_names
            .get(location.function.as_usize())
            .is_some_and(|names| names.contains(&previous))
        {
            return self.readonly_bindings.get(&binding).copied();
        }
        analysis
            .ssa
            .definitions
            .iter()
            .any(|definition| {
                definition.name == previous && definition.location == SsaDefinitionLocation::Entry
            })
            .then(|| self.readonly_bindings.get(&binding).copied())
            .flatten()
    }
}

fn ssa_name_before(analysis: &FunctionPassAnalysis, location: WriteLocation) -> Option<SsaName> {
    let mut current = analysis
        .ssa
        .phis
        .iter()
        .find(|phi| phi.block == location.block && phi.target.local == location.local)
        .map(|phi| phi.target)
        .or_else(|| {
            analysis
                .ssa
                .block_entry
                .get(location.block.as_usize())?
                .get(location.local.as_usize())
                .copied()
                .flatten()
        });
    let mut latest_instruction = None;
    for definition in &analysis.ssa.definitions {
        let SsaDefinitionLocation::Instruction { block, instruction } = definition.location else {
            continue;
        };
        if definition.name.local == location.local
            && block == location.block
            && instruction < location.instruction
            && latest_instruction.is_none_or(|latest| instruction > latest)
        {
            current = Some(definition.name);
            latest_instruction = Some(instruction);
        }
    }
    current
}

fn provenance_bindings(hir: &HirFile, names: &[BTreeSet<SsaName>]) -> BTreeSet<BindingId> {
    names
        .iter()
        .enumerate()
        .flat_map(|(function_index, names)| {
            let function = &hir.functions[function_index];
            names.iter().filter_map(|name| {
                function
                    .locals
                    .get(name.local.as_usize())
                    .and_then(|local| local.binding)
            })
        })
        .collect()
}

fn propagate_callback_provenance(
    identity: &StateIdentityAnalysis<'_>,
    readonly_sites: &[BTreeMap<SsaName, ReadonlySite>],
) -> (Vec<BTreeSet<SsaName>>, ProvenanceWorkStats) {
    let names = readonly_sites
        .iter()
        .map(|sites| {
            sites
                .iter()
                .filter_map(|(name, site)| {
                    (site.kind == ReadonlyKind::CallbackParameter).then_some(*name)
                })
                .collect::<BTreeSet<_>>()
        })
        .collect::<Vec<_>>();
    let mut reverse_dependencies = vec![BTreeMap::new(); identity.hir.functions.len()];
    let mut capture_dependencies = BTreeMap::new();
    for (function_index, analysis) in identity.analyses.iter().enumerate() {
        let function = &identity.hir.functions[function_index];
        for definition in &analysis.ssa.definitions {
            let target = NameTarget {
                function: function_index,
                name: definition.name,
            };
            if let Some(value) = definition_source_value(function, definition.location) {
                for source in value_provenance_dependencies(identity, function_index, value) {
                    reverse_dependencies[function_index]
                        .entry(source)
                        .or_insert_with(Vec::new)
                        .push(target);
                }
            }
            if let Some(binding) = function
                .locals
                .get(definition.name.local.as_usize())
                .filter(|local| local.kind == LocalKind::Capture)
                .and_then(|local| local.binding)
            {
                capture_dependencies
                    .entry(binding)
                    .or_insert_with(Vec::new)
                    .push(target);
            }
        }
        for phi in &analysis.ssa.phis {
            let target = NameTarget {
                function: function_index,
                name: phi.target,
            };
            for (_, source) in &phi.sources {
                reverse_dependencies[function_index]
                    .entry(*source)
                    .or_insert_with(Vec::new)
                    .push(target);
            }
        }
    }
    let output = propagate_name_graph(
        identity.hir,
        names,
        &reverse_dependencies,
        &capture_dependencies,
    );
    (output.names, output.stats)
}

fn validate_callback_provenance_escapes(
    identity: &StateIdentityAnalysis<'_>,
    callback_names: &[BTreeSet<SsaName>],
    state_bindings: &BTreeSet<BindingId>,
    callback_receiver_bindings: &BTreeMap<BindingId, StateReceiverKind>,
    strict_guarantee: bool,
    diagnostics: &mut DiagnosticBundle,
) {
    let mut reported = BTreeSet::new();
    for analysis in identity.analyses {
        let function_index = analysis.function.as_usize();
        let function = &identity.hir.functions[function_index];
        for escape in &analysis.dependencies.escapes {
            if !matches!(
                escape.kind,
                EscapeKind::UnknownCall | EscapeKind::Constructor | EscapeKind::ObservableWrite
            ) {
                continue;
            }
            let DependencyBase::Ssa(source) = escape.path.base else {
                continue;
            };
            if !name_resolves_to_set(source, &callback_names[function_index]) {
                continue;
            }
            let Some(location) = escape.location else {
                continue;
            };
            // Replacing a `$state` root is the supported observable boundary: the setter
            // records the new identity, and subsequent projected writes are still validated
            // against that root. Retaining the same value in an arbitrary object, call, or
            // constructor remains an escape.
            if escape_location_is_direct_state_root_write(function, location, state_bindings) {
                continue;
            }
            if !escape_location_preserves_callback_identity(
                identity,
                function,
                analysis,
                location,
                &callback_names[function_index],
                callback_receiver_bindings,
            ) {
                continue;
            }
            if !reported.insert((analysis.function, location.block, location.instruction)) {
                continue;
            }
            let origin = function
                .blocks
                .get(location.block.as_usize())
                .and_then(|block| block.instructions.get(location.instruction as usize))
                .map(|instruction| instruction.origin)
                .unwrap_or(function.origin);
            let mut diagnostic = Diagnostic::new(
                DiagnosticCode::new("FICT-R002").expect("reactive escape diagnostic literal"),
                if strict_guarantee {
                    DiagnosticSeverity::Error
                } else {
                    DiagnosticSeverity::Warning
                },
                "state-derived callback value escapes to a boundary that may retain or mutate it",
            )
            .with_help(
                "read the required fields inside the callback, or replace the whole source state value",
            )
            .with_guarantee_class(GuaranteeClass::Fallback);
            if let Some(span) = origin.primary_span {
                diagnostic = diagnostic.with_primary_span(span);
            }
            diagnostics.push(diagnostic);
        }
    }
}

fn escape_location_is_direct_state_root_write(
    function: &HirFunction,
    location: fict_reactivity::InstructionLocation,
    state_bindings: &BTreeSet<BindingId>,
) -> bool {
    let Some(HirInstructionKind::Write { place, .. }) = function
        .blocks
        .get(location.block.as_usize())
        .and_then(|block| block.instructions.get(location.instruction as usize))
        .map(|instruction| &instruction.kind)
    else {
        return false;
    };
    if !place.projections.is_empty() {
        return false;
    }
    place_root_local(place)
        .and_then(|local| function.locals.get(local.as_usize()))
        .and_then(|local| local.binding)
        .is_some_and(|binding| state_bindings.contains(&binding))
}

fn call_is_non_retaining_boolean(
    hir: &HirFile,
    function: &HirFunction,
    call: &fict_hir::CallInstruction,
    written_globals: &BTreeSet<String>,
) -> bool {
    let Some(ValueKind::InstructionResult) = function
        .values
        .get(call.callee.as_usize())
        .map(|value| &value.kind)
    else {
        return false;
    };
    let Some(HirInstructionKind::Read { place }) = function
        .instruction_for_result(call.callee)
        .map(|instruction| &instruction.kind)
    else {
        return false;
    };
    known_safe_callback_global_name(hir, function, place, written_globals).as_deref()
        == Some("Boolean")
}

fn callback_receiver_scalar_projection(
    function: &HirFunction,
    place: &Place,
    callback_receiver_bindings: &BTreeMap<BindingId, StateReceiverKind>,
) -> bool {
    let Some(receiver) = place_root_local(place)
        .and_then(|local| function.locals.get(local.as_usize()))
        .and_then(|local| local.binding)
        .and_then(|binding| callback_receiver_bindings.get(&binding))
    else {
        return false;
    };
    let Some(Projection::StaticProperty { name, .. }) = place.projections.first() else {
        return false;
    };
    matches!(
        (receiver, name.as_str()),
        (
            StateReceiverKind::Array | StateReceiverKind::TypedArray | StateReceiverKind::String,
            "length"
        ) | (StateReceiverKind::Map | StateReceiverKind::Set, "size")
    )
}

fn escape_location_preserves_callback_identity(
    identity: &StateIdentityAnalysis<'_>,
    function: &HirFunction,
    analysis: &FunctionPassAnalysis,
    location: fict_reactivity::InstructionLocation,
    callback_names: &BTreeSet<SsaName>,
    callback_receiver_bindings: &BTreeMap<BindingId, StateReceiverKind>,
) -> bool {
    let Some(instruction) = function
        .blocks
        .get(location.block.as_usize())
        .and_then(|block| block.instructions.get(location.instruction as usize))
    else {
        return true;
    };
    let mut visiting = BTreeSet::new();
    let mut preserves = |value| {
        value_may_preserve_callback_identity(
            function,
            analysis,
            value,
            callback_names,
            callback_receiver_bindings,
            &mut visiting,
        )
    };
    match &instruction.kind {
        HirInstructionKind::Call(call) => {
            let known_boolean = call_is_non_retaining_boolean(
                identity.hir,
                function,
                call,
                &identity.written_globals,
            );
            call.arguments.iter().enumerate().any(|(index, argument)| {
                if !preserves(argument.value) {
                    return false;
                }
                let projected =
                    value_is_projected_callback_identity(analysis, argument.value, callback_names);
                let known_non_retaining = known_boolean && !argument.spread;
                !known_non_retaining
                    && !local_call_argument_is_non_retaining(
                        identity,
                        function,
                        analysis,
                        call,
                        InstructionLocation {
                            block: location.block,
                            instruction: location.instruction,
                        },
                        index,
                        projected,
                    )
            })
        }
        HirInstructionKind::New { arguments, .. } => {
            arguments.iter().any(|argument| preserves(argument.value))
        }
        HirInstructionKind::Write { value, .. }
        | HirInstructionKind::PatternAssignment { value, .. } => preserves(*value),
        _ => true,
    }
}

fn local_call_argument_is_non_retaining(
    identity: &StateIdentityAnalysis<'_>,
    caller: &HirFunction,
    caller_analysis: &FunctionPassAnalysis,
    call: &fict_hir::CallInstruction,
    use_location: InstructionLocation,
    argument_index: usize,
    allow_identity_return: bool,
) -> bool {
    if call
        .arguments
        .iter()
        .take(argument_index + 1)
        .any(|argument| argument.spread)
    {
        return false;
    }
    let Some(callee) = resolved_local_callee(identity, caller, caller_analysis, call, use_location)
    else {
        return false;
    };
    let Some(parameter) = callee.parameters.get(argument_index) else {
        return false;
    };
    let Some(analysis) = identity.analyses.get(callee.id.as_usize()) else {
        return false;
    };
    let Some(entry) = analysis.ssa.definitions.iter().find_map(|definition| {
        (definition.name.local == parameter.local
            && definition.location == SsaDefinitionLocation::Entry)
            .then_some(definition.name)
    }) else {
        return false;
    };
    let mutates_identity = analysis.dependencies.writes.iter().any(|write| {
        matches!(write.path.base, DependencyBase::Ssa(source) if source == entry)
            && !write.path.segments.is_empty()
    });
    let escapes_identity = analysis.dependencies.escapes.iter().any(|escape| {
        if !matches!(escape.path.base, DependencyBase::Ssa(source) if source == entry) {
            return false;
        }
        match escape.kind {
            // Returning a projected callback value from a known local helper does not itself
            // retain or mutate that value. The caller-side identity analysis propagates the
            // result so a later projected write or unknown boundary is still rejected. Keep
            // whole callback parameters conservative for accumulator-style callback flows.
            EscapeKind::Return => escape.path.segments.is_empty() && !allow_identity_return,
            EscapeKind::SyntaxFragment => !escape.location.is_some_and(|location| {
                syntax_fragment_escape_is_non_retaining(identity.hir, callee, location)
            }),
            _ => true,
        }
    });
    !mutates_identity && !escapes_identity
}

fn value_is_projected_callback_identity(
    analysis: &FunctionPassAnalysis,
    value: ValueId,
    callback_names: &BTreeSet<SsaName>,
) -> bool {
    let mut saw_projection = false;
    for path in analysis
        .dependencies
        .value_dependencies
        .get(value.as_usize())
        .into_iter()
        .flatten()
    {
        let DependencyBase::Ssa(source) = path.base else {
            continue;
        };
        if !name_resolves_to_set(source, callback_names) {
            continue;
        }
        if path.segments.is_empty() {
            return false;
        }
        saw_projection = true;
    }
    saw_projection
}

fn syntax_fragment_escape_is_non_retaining(
    hir: &HirFile,
    function: &HirFunction,
    location: fict_reactivity::InstructionLocation,
) -> bool {
    let Some(block) = function.blocks.get(location.block.as_usize()) else {
        return false;
    };
    let Some(instruction) = block.instructions.get(location.instruction as usize) else {
        return false;
    };
    let HirInstructionKind::SyntaxFragment { fragment, inputs } = &instruction.kind else {
        return false;
    };
    if inputs.len() != 1 {
        return false;
    }
    if hir
        .syntax_fragments
        .get(fragment.as_usize())
        .is_some_and(|fragment| !fragment.summary.has_side_effects)
    {
        return true;
    }
    matches!(
        block.terminator.kind,
        TerminatorKind::Return {
            value: Some(value)
        } if value == inputs[0]
    )
}

fn value_may_preserve_callback_identity(
    function: &HirFunction,
    analysis: &FunctionPassAnalysis,
    value: ValueId,
    callback_names: &BTreeSet<SsaName>,
    callback_receiver_bindings: &BTreeMap<BindingId, StateReceiverKind>,
    visiting: &mut BTreeSet<ValueId>,
) -> bool {
    if !visiting.insert(value) {
        return false;
    }
    let result = match function
        .values
        .get(value.as_usize())
        .map(|value| &value.kind)
    {
        Some(ValueKind::Ssa(name)) => name_resolves_to_set(*name, callback_names),
        Some(ValueKind::Parameter(local)) => callback_names
            .iter()
            .any(|candidate| candidate.local == *local),
        Some(ValueKind::Literal(_) | ValueKind::Function(_)) => false,
        Some(ValueKind::SyntaxFragment(_)) | None => {
            value_depends_on_reactive(analysis, value, callback_names)
        }
        Some(ValueKind::InstructionResult) => {
            let Some(instruction) = function.instruction_for_result(value) else {
                visiting.remove(&value);
                return value_depends_on_reactive(analysis, value, callback_names);
            };
            match &instruction.kind {
                HirInstructionKind::Read { place } => match place.base {
                    _ if callback_receiver_scalar_projection(
                        function,
                        place,
                        callback_receiver_bindings,
                    ) =>
                    {
                        false
                    }
                    PlaceBase::Local(local) => callback_names
                        .iter()
                        .any(|candidate| candidate.local == local),
                    PlaceBase::Ssa(name) => name_resolves_to_set(name, callback_names),
                    PlaceBase::Value(base) => value_may_preserve_callback_identity(
                        function,
                        analysis,
                        base,
                        callback_names,
                        callback_receiver_bindings,
                        visiting,
                    ),
                    PlaceBase::Global(_) => false,
                },
                HirInstructionKind::Write { value, .. }
                | HirInstructionKind::PatternAssignment { value, .. } => {
                    value_may_preserve_callback_identity(
                        function,
                        analysis,
                        *value,
                        callback_names,
                        callback_receiver_bindings,
                        visiting,
                    )
                }
                HirInstructionKind::Conditional {
                    consequent,
                    alternate,
                    ..
                } => {
                    value_may_preserve_callback_identity(
                        function,
                        analysis,
                        *consequent,
                        callback_names,
                        callback_receiver_bindings,
                        visiting,
                    ) || value_may_preserve_callback_identity(
                        function,
                        analysis,
                        *alternate,
                        callback_names,
                        callback_receiver_bindings,
                        visiting,
                    )
                }
                HirInstructionKind::Sequence { values } => values.last().is_some_and(|value| {
                    value_may_preserve_callback_identity(
                        function,
                        analysis,
                        *value,
                        callback_names,
                        callback_receiver_bindings,
                        visiting,
                    )
                }),
                HirInstructionKind::Binary {
                    operator:
                        fict_hir::BinaryOperator::LogicalAnd
                        | fict_hir::BinaryOperator::LogicalOr
                        | fict_hir::BinaryOperator::NullishCoalescing,
                    left,
                    right,
                } => {
                    value_may_preserve_callback_identity(
                        function,
                        analysis,
                        *left,
                        callback_names,
                        callback_receiver_bindings,
                        visiting,
                    ) || value_may_preserve_callback_identity(
                        function,
                        analysis,
                        *right,
                        callback_names,
                        callback_receiver_bindings,
                        visiting,
                    )
                }
                HirInstructionKind::Binary { .. }
                | HirInstructionKind::Unary { .. }
                | HirInstructionKind::TemplateLiteral { .. }
                | HirInstructionKind::Literal(_)
                | HirInstructionKind::UnresolvedTypeof { .. }
                | HirInstructionKind::Context { .. } => false,
                _ => value_depends_on_reactive(analysis, value, callback_names),
            }
        }
    };
    visiting.remove(&value);
    result
}

fn definition_source_value(
    function: &HirFunction,
    location: SsaDefinitionLocation,
) -> Option<ValueId> {
    let SsaDefinitionLocation::Instruction { block, instruction } = location else {
        return None;
    };
    let instruction = function
        .blocks
        .get(block.as_usize())?
        .instructions
        .get(instruction as usize)?;
    match &instruction.kind {
        HirInstructionKind::Declare {
            initializer: Some(value),
            ..
        }
        | HirInstructionKind::Write { value, .. }
        | HirInstructionKind::PatternAssignment { value, .. } => Some(*value),
        HirInstructionKind::Iteration { source, .. } => Some(*source),
        _ => None,
    }
}

fn projected_alias_kind(
    function: &HirFunction,
    value: ValueId,
    sites: &BTreeMap<SsaName, ReadonlySite>,
    fresh_state_this_functions: &BTreeSet<FunctionId>,
    visiting: &mut BTreeSet<ValueId>,
) -> Option<ReadonlyKind> {
    if !visiting.insert(value) {
        return None;
    }
    let kind = match function
        .values
        .get(value.as_usize())
        .map(|value| &value.kind)
    {
        Some(ValueKind::Ssa(name)) => sites.get(name).and_then(|site| {
            matches!(
                site.kind,
                ReadonlyKind::ProjectedAlias
                    | ReadonlyKind::FreshContainer
                    | ReadonlyKind::CallbackThisFreshContainer
            )
            .then_some(site.kind)
        }),
        Some(ValueKind::InstructionResult) => {
            function
                .instruction_for_result(value)
                .and_then(|instruction| match &instruction.kind {
                    HirInstructionKind::Context {
                        kind: ContextValueKind::This,
                    } if fresh_state_this_functions.contains(&function.id) => {
                        Some(ReadonlyKind::CallbackThisFreshContainer)
                    }
                    HirInstructionKind::Read { place } if !place.projections.is_empty() => {
                        Some(ReadonlyKind::ProjectedAlias)
                    }
                    HirInstructionKind::Read {
                        place:
                            Place {
                                base: PlaceBase::Ssa(name),
                                ..
                            },
                    } => sites.get(name).and_then(|site| {
                        matches!(
                            site.kind,
                            ReadonlyKind::ProjectedAlias
                                | ReadonlyKind::FreshContainer
                                | ReadonlyKind::CallbackThisFreshContainer
                        )
                        .then_some(site.kind)
                    }),
                    HirInstructionKind::Read {
                        place:
                            Place {
                                base: PlaceBase::Value(base),
                                ..
                            },
                    } => projected_alias_kind(
                        function,
                        *base,
                        sites,
                        fresh_state_this_functions,
                        visiting,
                    ),
                    HirInstructionKind::Declare {
                        initializer: Some(initializer),
                        ..
                    }
                    | HirInstructionKind::Write {
                        value: initializer, ..
                    }
                    | HirInstructionKind::PatternAssignment {
                        value: initializer, ..
                    }
                    | HirInstructionKind::Await { value: initializer }
                    | HirInstructionKind::Yield {
                        value: Some(initializer),
                        ..
                    } => projected_alias_kind(
                        function,
                        *initializer,
                        sites,
                        fresh_state_this_functions,
                        visiting,
                    ),
                    HirInstructionKind::Call(call) if call.callee_reference.is_some() => {
                        Some(ReadonlyKind::ProjectedAlias)
                    }
                    HirInstructionKind::Sequence { values } => values.last().and_then(|value| {
                        projected_alias_kind(
                            function,
                            *value,
                            sites,
                            fresh_state_this_functions,
                            visiting,
                        )
                    }),
                    HirInstructionKind::Conditional {
                        consequent,
                        alternate,
                        ..
                    } => {
                        let consequent = projected_alias_kind(
                            function,
                            *consequent,
                            sites,
                            fresh_state_this_functions,
                            visiting,
                        );
                        let alternate = projected_alias_kind(
                            function,
                            *alternate,
                            sites,
                            fresh_state_this_functions,
                            visiting,
                        );
                        (consequent == alternate).then_some(consequent).flatten()
                    }
                    HirInstructionKind::SyntaxFragment { inputs, .. } if inputs.len() == 1 => {
                        projected_alias_kind(
                            function,
                            inputs[0],
                            sites,
                            fresh_state_this_functions,
                            visiting,
                        )
                    }
                    _ => None,
                })
        }
        _ => None,
    };
    visiting.remove(&value);
    kind
}

fn record_readonly_site(
    function: &HirFunction,
    name: SsaName,
    location: SsaDefinitionLocation,
    kind: ReadonlyKind,
    state_bindings: &BTreeSet<BindingId>,
    sites: &mut BTreeMap<SsaName, ReadonlySite>,
) {
    let Some(binding) = function
        .locals
        .get(name.local.as_usize())
        .and_then(|local| local.binding)
    else {
        return;
    };
    if state_bindings.contains(&binding) {
        return;
    }
    sites.entry(name).or_insert(ReadonlySite {
        kind,
        origin: definition_origin(function, location, name.local),
    });
}

fn callback_parameter_for_argument(
    function: &HirFunction,
    argument_index: usize,
) -> Option<&HirParameter> {
    function.parameters.get(argument_index).or_else(|| {
        function
            .parameters
            .last()
            .filter(|parameter| parameter.is_rest)
    })
}

fn state_callback_signatures(
    identity: &StateIdentityAnalysis<'_>,
    function: &HirFunction,
    analysis: &FunctionPassAnalysis,
    state_names: &BTreeSet<SsaName>,
    state_this_functions: &BTreeSet<FunctionId>,
    call: &fict_hir::CallInstruction,
    place: &Place,
) -> Option<Vec<StateCallbackSignature>> {
    let name = state_method_name(function, place)?;
    match (call.state_receiver_kind, name.as_str()) {
        (StateReceiverKind::Array, "sort" | "toSorted") => Some(vec![StateCallbackSignature {
            callback_argument_index: 0,
            parameter_provenance: vec![(0, None), (1, None)],
            this_argument_index: None,
            return_feedback_parameter_index: None,
            return_disposition: CallbackReturnDisposition::Discarded,
        }]),
        (
            StateReceiverKind::Array,
            "every" | "filter" | "find" | "findIndex" | "findLast" | "findLastIndex" | "forEach"
            | "some",
        ) => Some(vec![StateCallbackSignature {
            callback_argument_index: 0,
            parameter_provenance: vec![(0, None), (2, Some(StateReceiverKind::Array))],
            this_argument_index: Some(1),
            return_feedback_parameter_index: None,
            return_disposition: CallbackReturnDisposition::Discarded,
        }]),
        (StateReceiverKind::Array, "flatMap" | "map") => Some(vec![StateCallbackSignature {
            callback_argument_index: 0,
            parameter_provenance: vec![(0, None), (2, Some(StateReceiverKind::Array))],
            this_argument_index: Some(1),
            return_feedback_parameter_index: None,
            return_disposition: CallbackReturnDisposition::Retained,
        }]),
        (
            StateReceiverKind::TypedArray,
            "every" | "filter" | "find" | "findIndex" | "findLast" | "findLastIndex" | "flatMap"
            | "forEach" | "map" | "some",
        ) => Some(vec![StateCallbackSignature {
            callback_argument_index: 0,
            parameter_provenance: vec![(2, Some(StateReceiverKind::TypedArray))],
            this_argument_index: Some(1),
            return_feedback_parameter_index: None,
            return_disposition: CallbackReturnDisposition::Discarded,
        }]),
        (StateReceiverKind::Array, "reduce" | "reduceRight") => {
            let accumulator_depends_on_state = call.arguments.get(1).is_none_or(|argument| {
                argument.spread
                    || value_preserves_state_identity(
                        identity,
                        function,
                        analysis,
                        argument.value,
                        state_names,
                        state_this_functions,
                    )
            });
            let mut indices = vec![(1, None), (3, Some(StateReceiverKind::Array))];
            if accumulator_depends_on_state {
                indices.insert(0, (0, None));
            }
            Some(vec![StateCallbackSignature {
                callback_argument_index: 0,
                parameter_provenance: indices,
                this_argument_index: None,
                return_feedback_parameter_index: Some(0),
                return_disposition: CallbackReturnDisposition::Retained,
            }])
        }
        (StateReceiverKind::TypedArray, "reduce" | "reduceRight") => {
            let mut indices = vec![(3, Some(StateReceiverKind::TypedArray))];
            if call.arguments.get(1).is_some_and(|argument| {
                argument.spread
                    || value_preserves_state_identity(
                        identity,
                        function,
                        analysis,
                        argument.value,
                        state_names,
                        state_this_functions,
                    )
            }) {
                indices.insert(0, (0, None));
            }
            Some(vec![StateCallbackSignature {
                callback_argument_index: 0,
                parameter_provenance: indices,
                this_argument_index: None,
                return_feedback_parameter_index: Some(0),
                return_disposition: CallbackReturnDisposition::Retained,
            }])
        }
        (receiver @ (StateReceiverKind::Map | StateReceiverKind::Set), "forEach") => {
            Some(vec![StateCallbackSignature {
                callback_argument_index: 0,
                parameter_provenance: vec![(0, None), (1, None), (2, Some(receiver))],
                this_argument_index: Some(1),
                return_feedback_parameter_index: None,
                return_disposition: CallbackReturnDisposition::Discarded,
            }])
        }
        (StateReceiverKind::Promise, "then") => Some(vec![
            StateCallbackSignature {
                callback_argument_index: 0,
                parameter_provenance: vec![(0, None)],
                this_argument_index: None,
                return_feedback_parameter_index: None,
                return_disposition: CallbackReturnDisposition::Retained,
            },
            StateCallbackSignature {
                callback_argument_index: 1,
                parameter_provenance: vec![(0, None)],
                this_argument_index: None,
                return_feedback_parameter_index: None,
                return_disposition: CallbackReturnDisposition::Retained,
            },
        ]),
        (StateReceiverKind::Promise, "catch") => Some(vec![StateCallbackSignature {
            callback_argument_index: 0,
            parameter_provenance: vec![(0, None)],
            this_argument_index: None,
            return_feedback_parameter_index: None,
            return_disposition: CallbackReturnDisposition::Retained,
        }]),
        _ => None,
    }
}

fn place_depends_on_state(
    identity: &StateIdentityAnalysis<'_>,
    function: &HirFunction,
    analysis: &FunctionPassAnalysis,
    place: &Place,
    location: WriteLocation,
    state_names: &BTreeSet<SsaName>,
    state_this_functions: &BTreeSet<FunctionId>,
) -> bool {
    match place.base {
        PlaceBase::Local(local) => ssa_name_before(analysis, WriteLocation { local, ..location })
            .is_some_and(|name| name_resolves_to_set(name, state_names)),
        PlaceBase::Ssa(name) => name_resolves_to_set(name, state_names),
        PlaceBase::Value(value) => value_preserves_state_identity_in(
            identity,
            function,
            analysis,
            value,
            state_names,
            state_this_functions,
            &mut BTreeSet::new(),
        ),
        PlaceBase::Global(_) => false,
    }
}

fn resolve_callback_value(
    hir: &HirFile,
    analysis: &FunctionPassAnalysis,
    function: &HirFunction,
    binding_facts: CallbackBindingFacts<'_>,
    value: ValueId,
    use_location: InstructionLocation,
) -> CallbackResolution {
    resolve_callback_value_inner(
        hir,
        analysis,
        function,
        binding_facts,
        value,
        use_location,
        &mut BTreeSet::new(),
        &mut BTreeSet::new(),
    )
}

fn known_safe_callback_global_name(
    hir: &HirFile,
    function: &HirFunction,
    place: &Place,
    written_globals: &BTreeSet<String>,
) -> Option<String> {
    let PlaceBase::Global(global) = place.base else {
        return None;
    };
    let base_name = hir.globals.get(global.as_usize())?.name.as_str();
    let name = match place.projections.as_slice() {
        [] => base_name.to_owned(),
        [projection] if matches!(base_name, "globalThis" | "global" | "self" | "window") => {
            match projection {
                Projection::StaticProperty { name, .. } => name.clone(),
                Projection::ComputedProperty { key, .. } => {
                    let ValueKind::Literal(fict_hir::LiteralValue::String(name)) = function
                        .values
                        .get(key.as_usize())
                        .map(|value| &value.kind)?
                    else {
                        return None;
                    };
                    name.to_utf8()?
                }
                Projection::Index { .. } => return None,
            }
        }
        _ => return None,
    };
    (!written_globals.contains(base_name)
        && !written_globals.contains(&name)
        && matches!(name.as_str(), "Boolean" | "undefined"))
    .then_some(name)
}

#[allow(clippy::too_many_arguments)]
fn resolve_callback_value_inner(
    hir: &HirFile,
    analysis: &FunctionPassAnalysis,
    function: &HirFunction,
    binding_facts: CallbackBindingFacts<'_>,
    value: ValueId,
    use_location: InstructionLocation,
    visiting_values: &mut BTreeSet<ValueId>,
    visiting_names: &mut BTreeSet<SsaName>,
) -> CallbackResolution {
    if !visiting_values.insert(value) {
        return CallbackResolution::default();
    }
    let resolution = match function
        .values
        .get(value.as_usize())
        .map(|value| &value.kind)
    {
        Some(ValueKind::Function(callback)) => CallbackResolution::known(*callback),
        Some(ValueKind::Ssa(name)) => resolve_callback_ssa(
            hir,
            analysis,
            function,
            binding_facts,
            *name,
            use_location,
            visiting_values,
            visiting_names,
        ),
        Some(ValueKind::Literal(_)) => CallbackResolution::safe_non_callback(),
        Some(ValueKind::Parameter(_)) | Some(ValueKind::SyntaxFragment(_)) | None => {
            CallbackResolution::default()
        }
        Some(ValueKind::InstructionResult) => {
            let Some(instruction) = function.instruction_for_result(value) else {
                visiting_values.remove(&value);
                return CallbackResolution::default();
            };
            let definition_location =
                instruction_location_for_result(function, value).unwrap_or(use_location);
            match &instruction.kind {
                HirInstructionKind::Function { function } => CallbackResolution::known(*function),
                HirInstructionKind::Read { place } => {
                    if known_safe_callback_global_name(
                        hir,
                        function,
                        place,
                        binding_facts.written_globals,
                    )
                    .is_some()
                    {
                        visiting_values.remove(&value);
                        return CallbackResolution::safe_non_callback();
                    }
                    if !place.projections.is_empty() {
                        visiting_values.remove(&value);
                        return CallbackResolution::default();
                    }
                    match place.base {
                        PlaceBase::Local(local) => {
                            let name = ssa_name_before(
                                analysis,
                                WriteLocation {
                                    function: function.id,
                                    block: definition_location.block,
                                    instruction: definition_location.instruction,
                                    local,
                                },
                            );
                            name.map_or_else(CallbackResolution::default, |name| {
                                resolve_callback_ssa(
                                    hir,
                                    analysis,
                                    function,
                                    binding_facts,
                                    name,
                                    definition_location,
                                    visiting_values,
                                    visiting_names,
                                )
                            })
                        }
                        PlaceBase::Ssa(name) => resolve_callback_ssa(
                            hir,
                            analysis,
                            function,
                            binding_facts,
                            name,
                            definition_location,
                            visiting_values,
                            visiting_names,
                        ),
                        PlaceBase::Value(base) => resolve_callback_value_inner(
                            hir,
                            analysis,
                            function,
                            binding_facts,
                            base,
                            definition_location,
                            visiting_values,
                            visiting_names,
                        ),
                        PlaceBase::Global(_) => CallbackResolution::default(),
                    }
                }
                HirInstructionKind::Write { value, .. }
                | HirInstructionKind::PatternAssignment { value, .. } => {
                    resolve_callback_value_inner(
                        hir,
                        analysis,
                        function,
                        binding_facts,
                        *value,
                        definition_location,
                        visiting_values,
                        visiting_names,
                    )
                }
                HirInstructionKind::Phi { sources, .. } => {
                    let mut resolution = CallbackResolution::safe_non_callback();
                    for (_, source) in sources {
                        resolution.merge(resolve_callback_ssa(
                            hir,
                            analysis,
                            function,
                            binding_facts,
                            *source,
                            definition_location,
                            visiting_values,
                            visiting_names,
                        ));
                    }
                    resolution
                }
                HirInstructionKind::Conditional {
                    consequent,
                    alternate,
                    ..
                } => {
                    let mut resolution = resolve_callback_value_inner(
                        hir,
                        analysis,
                        function,
                        binding_facts,
                        *consequent,
                        definition_location,
                        visiting_values,
                        visiting_names,
                    );
                    resolution.merge(resolve_callback_value_inner(
                        hir,
                        analysis,
                        function,
                        binding_facts,
                        *alternate,
                        definition_location,
                        visiting_values,
                        visiting_names,
                    ));
                    resolution
                }
                HirInstructionKind::Sequence { values } => {
                    values
                        .last()
                        .map_or_else(CallbackResolution::safe_non_callback, |value| {
                            resolve_callback_value_inner(
                                hir,
                                analysis,
                                function,
                                binding_facts,
                                *value,
                                definition_location,
                                visiting_values,
                                visiting_names,
                            )
                        })
                }
                HirInstructionKind::Binary {
                    operator:
                        fict_hir::BinaryOperator::LogicalAnd
                        | fict_hir::BinaryOperator::LogicalOr
                        | fict_hir::BinaryOperator::NullishCoalescing,
                    left,
                    right,
                } => {
                    let mut resolution = resolve_callback_value_inner(
                        hir,
                        analysis,
                        function,
                        binding_facts,
                        *left,
                        definition_location,
                        visiting_values,
                        visiting_names,
                    );
                    resolution.merge(resolve_callback_value_inner(
                        hir,
                        analysis,
                        function,
                        binding_facts,
                        *right,
                        definition_location,
                        visiting_values,
                        visiting_names,
                    ));
                    resolution
                }
                HirInstructionKind::Call(call) => {
                    let producers = resolve_callback_value_inner(
                        hir,
                        analysis,
                        function,
                        binding_facts,
                        call.callee,
                        definition_location,
                        visiting_values,
                        visiting_names,
                    );
                    let mut resolution = CallbackResolution {
                        functions: BTreeSet::new(),
                        complete: producers.complete,
                    };
                    for producer in producers.functions {
                        resolution.merge(resolve_direct_callback_producer(
                            hir,
                            producer,
                            binding_facts.written_globals,
                        ));
                    }
                    resolution
                }
                HirInstructionKind::Literal(_)
                | HirInstructionKind::Array { .. }
                | HirInstructionKind::Object { .. }
                | HirInstructionKind::Unary { .. }
                | HirInstructionKind::Binary { .. }
                | HirInstructionKind::TemplateLiteral { .. }
                | HirInstructionKind::UnresolvedTypeof { .. }
                | HirInstructionKind::Context { .. } => CallbackResolution::safe_non_callback(),
                _ => CallbackResolution::default(),
            }
        }
    };
    visiting_values.remove(&value);
    resolution
}

fn definition_is_uninitialized_local(
    function: &HirFunction,
    definition: &SsaDefinition,
    binding_facts: CallbackBindingFacts<'_>,
) -> bool {
    if definition.kind != SsaDefinitionKind::Declare {
        return false;
    }
    let Some(local) = function.locals.get(definition.name.local.as_usize()) else {
        return false;
    };
    local.kind == LocalKind::User
        && matches!(
            local.declaration_kind,
            DeclarationKind::Var | DeclarationKind::Let
        )
        && local
            .binding
            .is_some_and(|binding| !binding_facts.capture_writes.contains(&binding))
}

fn callback_binding_has_untracked_writes(
    function: &HirFunction,
    name: SsaName,
    binding_facts: CallbackBindingFacts<'_>,
) -> bool {
    let Some(local) = function.locals.get(name.local.as_usize()) else {
        return true;
    };
    let Some(binding) = local.binding else {
        return false;
    };
    match local.kind {
        LocalKind::Capture => binding_facts.reassignments.contains(&binding),
        LocalKind::User | LocalKind::Parameter => binding_facts.capture_writes.contains(&binding),
        LocalKind::Temporary => false,
    }
}

#[allow(clippy::too_many_arguments)]
fn resolve_callback_ssa(
    hir: &HirFile,
    analysis: &FunctionPassAnalysis,
    function: &HirFunction,
    binding_facts: CallbackBindingFacts<'_>,
    name: SsaName,
    use_location: InstructionLocation,
    visiting_values: &mut BTreeSet<ValueId>,
    visiting_names: &mut BTreeSet<SsaName>,
) -> CallbackResolution {
    if callback_binding_has_untracked_writes(function, name, binding_facts) {
        return CallbackResolution::default();
    }
    if !visiting_names.insert(name) {
        return CallbackResolution::default();
    }
    let resolution = if let Some(phi) = analysis.ssa.phis.iter().find(|phi| phi.target == name) {
        let mut resolution = CallbackResolution::safe_non_callback();
        for (_, source) in &phi.sources {
            resolution.merge(resolve_callback_ssa(
                hir,
                analysis,
                function,
                binding_facts,
                *source,
                InstructionLocation {
                    block: phi.block,
                    instruction: 0,
                },
                visiting_values,
                visiting_names,
            ));
        }
        resolution
    } else if let Some(definition) = analysis
        .ssa
        .definitions
        .iter()
        .find(|definition| definition.name == name)
    {
        if matches!(
            definition.kind,
            SsaDefinitionKind::PatternAssignment | SsaDefinitionKind::Iteration
        ) {
            CallbackResolution::default()
        } else if let Some(value) = definition_source_value(function, definition.location) {
            resolve_callback_value_inner(
                hir,
                analysis,
                function,
                binding_facts,
                value,
                definition_instruction_location(definition.location).unwrap_or(use_location),
                visiting_values,
                visiting_names,
            )
        } else if let Some(callback) =
            callback_function_for_local(hir, function, binding_facts, name.local)
        {
            CallbackResolution::known(callback)
        } else if definition_is_uninitialized_local(function, definition, binding_facts) {
            CallbackResolution::safe_non_callback()
        } else {
            CallbackResolution::default()
        }
    } else {
        CallbackResolution::default()
    };
    visiting_names.remove(&name);
    resolution
}

fn resolve_direct_callback_producer(
    hir: &HirFile,
    producer: FunctionId,
    written_globals: &BTreeSet<String>,
) -> CallbackResolution {
    let Some(function) = hir.functions.get(producer.as_usize()) else {
        return CallbackResolution::default();
    };
    let mut resolution = CallbackResolution::safe_non_callback();
    let mut saw_return = false;
    for block in &function.blocks {
        let TerminatorKind::Return { value } = &block.terminator.kind else {
            continue;
        };
        saw_return = true;
        resolution.merge(
            value.map_or_else(CallbackResolution::safe_non_callback, |value| {
                resolve_direct_callback_result(
                    hir,
                    function,
                    value,
                    written_globals,
                    &mut BTreeSet::new(),
                )
            }),
        );
    }
    if saw_return {
        resolution
    } else {
        CallbackResolution::safe_non_callback()
    }
}

fn resolve_direct_callback_result(
    hir: &HirFile,
    function: &HirFunction,
    value: ValueId,
    written_globals: &BTreeSet<String>,
    visiting: &mut BTreeSet<ValueId>,
) -> CallbackResolution {
    if !visiting.insert(value) {
        return CallbackResolution::default();
    }
    let resolution = match function
        .values
        .get(value.as_usize())
        .map(|value| &value.kind)
    {
        Some(ValueKind::Function(callback)) => CallbackResolution::known(*callback),
        Some(ValueKind::Literal(_)) => CallbackResolution::safe_non_callback(),
        Some(ValueKind::InstructionResult) => {
            let Some(instruction) = function.instruction_for_result(value) else {
                visiting.remove(&value);
                return CallbackResolution::default();
            };
            match &instruction.kind {
                HirInstructionKind::Function { function } => CallbackResolution::known(*function),
                HirInstructionKind::Conditional {
                    consequent,
                    alternate,
                    ..
                } => {
                    let mut resolution = resolve_direct_callback_result(
                        hir,
                        function,
                        *consequent,
                        written_globals,
                        visiting,
                    );
                    resolution.merge(resolve_direct_callback_result(
                        hir,
                        function,
                        *alternate,
                        written_globals,
                        visiting,
                    ));
                    resolution
                }
                HirInstructionKind::Sequence { values } => {
                    values
                        .last()
                        .map_or_else(CallbackResolution::safe_non_callback, |value| {
                            resolve_direct_callback_result(
                                hir,
                                function,
                                *value,
                                written_globals,
                                visiting,
                            )
                        })
                }
                HirInstructionKind::Read { place }
                    if known_safe_callback_global_name(hir, function, place, written_globals)
                        .is_some() =>
                {
                    CallbackResolution::safe_non_callback()
                }
                HirInstructionKind::Literal(_) => CallbackResolution::safe_non_callback(),
                _ => CallbackResolution::default(),
            }
        }
        Some(ValueKind::Ssa(_) | ValueKind::Parameter(_) | ValueKind::SyntaxFragment(_)) | None => {
            CallbackResolution::default()
        }
    };
    visiting.remove(&value);
    resolution
}

fn callback_function_for_local(
    hir: &HirFile,
    function: &HirFunction,
    binding_facts: CallbackBindingFacts<'_>,
    local: LocalId,
) -> Option<FunctionId> {
    let local = function.locals.get(local.as_usize())?;
    let binding = local.binding?;
    let binding_kind = hir.bindings.get(binding.as_usize())?.kind;
    let stable_binding = if local.kind == LocalKind::Capture {
        !binding_facts.reassignments.contains(&binding)
    } else {
        matches!(binding_kind, BindingKind::Const | BindingKind::Function)
    };
    if !stable_binding {
        return None;
    }
    let mut candidates = hir
        .functions
        .iter()
        .filter(|candidate| candidate.binding == Some(binding));
    let callback = candidates.next()?.id;
    candidates.next().is_none().then_some(callback)
}

fn instruction_location_for_result(
    function: &HirFunction,
    value: ValueId,
) -> Option<InstructionLocation> {
    function.blocks.iter().find_map(|block| {
        block
            .instructions
            .iter()
            .position(|instruction| instruction.result == Some(value))
            .map(|instruction| InstructionLocation {
                block: block.id,
                instruction: count_u32(instruction),
            })
    })
}

fn definition_instruction_location(location: SsaDefinitionLocation) -> Option<InstructionLocation> {
    let SsaDefinitionLocation::Instruction { block, instruction } = location else {
        return None;
    };
    Some(InstructionLocation { block, instruction })
}

fn diagnose_unresolved_state_callbacks(
    callbacks: &BTreeMap<(FunctionId, BlockId, u32), Origin>,
    strict_guarantee: bool,
    diagnostics: &mut DiagnosticBundle,
) {
    for origin in callbacks.values() {
        let mut diagnostic = Diagnostic::new(
            DiagnosticCode::new("FICT-R002").expect("reactive escape diagnostic literal"),
            if strict_guarantee {
                DiagnosticSeverity::Error
            } else {
                DiagnosticSeverity::Warning
            },
            "state collection callback cannot be proven not to retain or mutate state-derived values",
        )
        .with_help("use an analyzable local callback, or read scalar fields before the boundary")
        .with_guarantee_class(GuaranteeClass::Fallback);
        if let Some(span) = origin.primary_span {
            diagnostic = diagnostic.with_primary_span(span);
        }
        diagnostics.push(diagnostic);
    }
}

fn value_preserves_state_identity(
    identity: &StateIdentityAnalysis<'_>,
    function: &HirFunction,
    analysis: &FunctionPassAnalysis,
    value: ValueId,
    state_names: &BTreeSet<SsaName>,
    state_this_functions: &BTreeSet<FunctionId>,
) -> bool {
    value_preserves_state_identity_in(
        identity,
        function,
        analysis,
        value,
        state_names,
        state_this_functions,
        &mut BTreeSet::new(),
    )
}

fn value_preserves_state_identity_in(
    identity: &StateIdentityAnalysis<'_>,
    function: &HirFunction,
    analysis: &FunctionPassAnalysis,
    value: ValueId,
    state_names: &BTreeSet<SsaName>,
    state_this_functions: &BTreeSet<FunctionId>,
    visiting: &mut BTreeSet<(FunctionId, ValueId)>,
) -> bool {
    identity
        .value_visits
        .set(identity.value_visits.get().saturating_add(1));
    let visit_key = (function.id, value);
    if !visiting.insert(visit_key) {
        return false;
    }
    let result = match function
        .values
        .get(value.as_usize())
        .map(|value| &value.kind)
    {
        Some(ValueKind::Ssa(name)) => name_resolves_to_set(*name, state_names),
        Some(ValueKind::Parameter(local)) => state_names
            .iter()
            .any(|candidate| candidate.local == *local),
        Some(ValueKind::Literal(_) | ValueKind::Function(_)) => false,
        Some(ValueKind::SyntaxFragment(_)) => {
            value_depends_on_reactive(analysis, value, state_names)
        }
        Some(ValueKind::InstructionResult) => {
            let Some(instruction) = identity.instruction_for_result(function, value) else {
                visiting.remove(&visit_key);
                return false;
            };
            let location = identity.instruction_location(function.id, value);
            match &instruction.kind {
                HirInstructionKind::Context {
                    kind: ContextValueKind::This,
                } => state_this_functions.contains(&function.id),
                HirInstructionKind::Declare {
                    initializer: Some(initializer),
                    ..
                } => value_preserves_state_identity_in(
                    identity,
                    function,
                    analysis,
                    *initializer,
                    state_names,
                    state_this_functions,
                    visiting,
                ),
                HirInstructionKind::Read { place } => {
                    let base_preserves = place_preserves_state_identity(
                        identity,
                        function,
                        analysis,
                        place,
                        location,
                        state_names,
                        state_this_functions,
                        visiting,
                    );
                    base_preserves
                        || (!place.projections.is_empty()
                            && value_depends_on_reactive(analysis, value, state_names))
                }
                HirInstructionKind::Write { value, .. }
                | HirInstructionKind::PatternAssignment { value, .. }
                | HirInstructionKind::Await { value }
                | HirInstructionKind::Yield {
                    value: Some(value), ..
                } => value_preserves_state_identity_in(
                    identity,
                    function,
                    analysis,
                    *value,
                    state_names,
                    state_this_functions,
                    visiting,
                ),
                HirInstructionKind::Conditional {
                    consequent,
                    alternate,
                    ..
                } => {
                    value_preserves_state_identity_in(
                        identity,
                        function,
                        analysis,
                        *consequent,
                        state_names,
                        state_this_functions,
                        visiting,
                    ) || value_preserves_state_identity_in(
                        identity,
                        function,
                        analysis,
                        *alternate,
                        state_names,
                        state_this_functions,
                        visiting,
                    )
                }
                HirInstructionKind::Sequence { values } => values.last().is_some_and(|value| {
                    value_preserves_state_identity_in(
                        identity,
                        function,
                        analysis,
                        *value,
                        state_names,
                        state_this_functions,
                        visiting,
                    )
                }),
                HirInstructionKind::Binary {
                    operator:
                        fict_hir::BinaryOperator::LogicalAnd
                        | fict_hir::BinaryOperator::LogicalOr
                        | fict_hir::BinaryOperator::NullishCoalescing,
                    left,
                    right,
                } => {
                    value_preserves_state_identity_in(
                        identity,
                        function,
                        analysis,
                        *left,
                        state_names,
                        state_this_functions,
                        visiting,
                    ) || value_preserves_state_identity_in(
                        identity,
                        function,
                        analysis,
                        *right,
                        state_names,
                        state_this_functions,
                        visiting,
                    )
                }
                HirInstructionKind::Call(call) => {
                    if let Some(place) = call.callee_reference.as_ref() {
                        let receiver_preserves = place_preserves_state_identity(
                            identity,
                            function,
                            analysis,
                            place,
                            location,
                            state_names,
                            state_this_functions,
                            visiting,
                        );
                        let Some(method) = state_method_name(function, place) else {
                            visiting.remove(&visit_key);
                            return receiver_preserves;
                        };
                        if state_method_returns_fresh_container(call.state_receiver_kind, &method) {
                            receiver_preserves
                        } else {
                            receiver_preserves
                                || value_depends_on_reactive(analysis, value, state_names)
                        }
                    } else {
                        local_call_returns_state_identity(
                            identity,
                            function,
                            analysis,
                            call,
                            location,
                            state_names,
                            state_this_functions,
                            visiting,
                        )
                    }
                }
                HirInstructionKind::Phi { sources, .. } => sources
                    .iter()
                    .any(|(_, source)| name_resolves_to_set(*source, state_names)),
                HirInstructionKind::SyntaxFragment { inputs, .. } if inputs.len() == 1 => {
                    value_preserves_state_identity_in(
                        identity,
                        function,
                        analysis,
                        inputs[0],
                        state_names,
                        state_this_functions,
                        visiting,
                    )
                }
                HirInstructionKind::Array { elements } => elements.iter().any(|element| {
                    let value = match element {
                        ArrayElement::Value(value) | ArrayElement::Spread { value, .. } => *value,
                        ArrayElement::Hole(_) => return false,
                    };
                    value_preserves_state_identity_in(
                        identity,
                        function,
                        analysis,
                        value,
                        state_names,
                        state_this_functions,
                        visiting,
                    )
                }),
                HirInstructionKind::Object { entries } => entries.iter().any(|entry| {
                    let value = match entry {
                        ObjectEntry::Property { value, .. } | ObjectEntry::Spread { value, .. } => {
                            *value
                        }
                    };
                    value_preserves_state_identity_in(
                        identity,
                        function,
                        analysis,
                        value,
                        state_names,
                        state_this_functions,
                        visiting,
                    )
                }),
                HirInstructionKind::Declare {
                    initializer: None, ..
                }
                | HirInstructionKind::ReadWrite { .. }
                | HirInstructionKind::Iteration { .. }
                | HirInstructionKind::Literal(_)
                | HirInstructionKind::UnresolvedTypeof { .. }
                | HirInstructionKind::Context { .. }
                | HirInstructionKind::Delete { .. }
                | HirInstructionKind::Unary { .. }
                | HirInstructionKind::Binary { .. }
                | HirInstructionKind::TemplateLiteral { .. }
                | HirInstructionKind::TaggedTemplate { .. }
                | HirInstructionKind::DynamicImport { .. }
                | HirInstructionKind::New { .. }
                | HirInstructionKind::Function { .. }
                | HirInstructionKind::Jsx { .. }
                | HirInstructionKind::Yield { value: None, .. }
                | HirInstructionKind::SyntaxFragment { .. }
                | HirInstructionKind::Debugger => false,
            }
        }
        None => false,
    };
    visiting.remove(&visit_key);
    result
}

#[allow(clippy::too_many_arguments)]
fn place_preserves_state_identity(
    identity: &StateIdentityAnalysis<'_>,
    function: &HirFunction,
    analysis: &FunctionPassAnalysis,
    place: &Place,
    location: Option<InstructionLocation>,
    state_names: &BTreeSet<SsaName>,
    state_this_functions: &BTreeSet<FunctionId>,
    visiting: &mut BTreeSet<(FunctionId, ValueId)>,
) -> bool {
    match place.base {
        PlaceBase::Local(local) => location
            .and_then(|location| {
                ssa_name_before(
                    analysis,
                    WriteLocation {
                        function: function.id,
                        block: location.block,
                        instruction: location.instruction,
                        local,
                    },
                )
            })
            .is_some_and(|name| name_resolves_to_set(name, state_names)),
        PlaceBase::Ssa(name) => name_resolves_to_set(name, state_names),
        PlaceBase::Value(value) => value_preserves_state_identity_in(
            identity,
            function,
            analysis,
            value,
            state_names,
            state_this_functions,
            visiting,
        ),
        PlaceBase::Global(_) => false,
    }
}

#[allow(clippy::too_many_arguments)]
fn local_call_returns_state_identity(
    identity: &StateIdentityAnalysis<'_>,
    caller: &HirFunction,
    caller_analysis: &FunctionPassAnalysis,
    call: &fict_hir::CallInstruction,
    call_location: Option<InstructionLocation>,
    caller_state_names: &BTreeSet<SsaName>,
    state_this_functions: &BTreeSet<FunctionId>,
    visiting: &mut BTreeSet<(FunctionId, ValueId)>,
) -> bool {
    let Some(call_location) = call_location else {
        return false;
    };
    let Some(callee) =
        resolved_local_callee(identity, caller, caller_analysis, call, call_location)
    else {
        return false;
    };
    let Some(callee_analysis) = identity.analyses.get(callee.id.as_usize()) else {
        return false;
    };
    if call.arguments.iter().any(|argument| argument.spread) {
        return false;
    }

    let mut callee_state_names = BTreeSet::new();
    for (parameter, argument) in callee.parameters.iter().zip(&call.arguments) {
        if !value_preserves_state_identity_in(
            identity,
            caller,
            caller_analysis,
            argument.value,
            caller_state_names,
            state_this_functions,
            visiting,
        ) {
            continue;
        }
        if let Some(entry) = identity.entry_names[callee.id.as_usize()].get(&parameter.local) {
            callee_state_names.insert(*entry);
        }
    }
    if callee_state_names.is_empty() {
        return false;
    }

    callee.blocks.iter().any(|block| {
        let TerminatorKind::Return { value: Some(value) } = block.terminator.kind else {
            return false;
        };
        value_preserves_state_identity_in(
            identity,
            callee,
            callee_analysis,
            value,
            &callee_state_names,
            state_this_functions,
            visiting,
        )
    })
}

fn resolved_local_callee<'a>(
    identity: &'a StateIdentityAnalysis<'a>,
    caller: &HirFunction,
    caller_analysis: &FunctionPassAnalysis,
    call: &fict_hir::CallInstruction,
    use_location: InstructionLocation,
) -> Option<&'a HirFunction> {
    let resolution = resolve_callback_value(
        identity.hir,
        caller_analysis,
        caller,
        CallbackBindingFacts {
            capture_writes: &identity.capture_write_bindings,
            reassignments: &identity.reassigned_bindings,
            written_globals: &identity.written_globals,
        },
        call.callee,
        use_location,
    );
    if !resolution.complete || resolution.functions.len() != 1 {
        return None;
    }
    identity
        .hir
        .functions
        .get(resolution.functions.into_iter().next()?.as_usize())
}

fn value_depends_on_reactive(
    analysis: &FunctionPassAnalysis,
    value: ValueId,
    reactive_names: &BTreeSet<SsaName>,
) -> bool {
    analysis
        .dependencies
        .value_dependencies
        .get(value.as_usize())
        .into_iter()
        .flatten()
        .any(|path| {
            let DependencyBase::Ssa(source) = path.base else {
                return false;
            };
            name_resolves_to_set(source, reactive_names)
        })
}

fn name_resolves_to_set(name: SsaName, names: &BTreeSet<SsaName>) -> bool {
    names.contains(&name)
}

fn is_pattern_binding_declaration(
    hir: &HirFile,
    function: &HirFunction,
    local: LocalId,
    initializer: ValueId,
) -> bool {
    let Some(binding) = function
        .locals
        .get(local.as_usize())
        .and_then(|local| local.binding)
    else {
        return false;
    };
    let Some(ValueKind::SyntaxFragment(fragment)) = function
        .values
        .get(initializer.as_usize())
        .map(|value| &value.kind)
    else {
        return false;
    };
    hir.syntax_fragments
        .get(fragment.as_usize())
        .and_then(|fragment| fragment.summary.pattern.as_ref())
        .is_some_and(|pattern| pattern.declared_bindings.contains(&binding))
}

fn definition_at(
    analysis: &FunctionPassAnalysis,
    block: BlockId,
    instruction: u32,
    local: LocalId,
) -> Option<SsaName> {
    analysis
        .ssa
        .definitions
        .iter()
        .find(|definition| {
            definition.name.local == local
                && definition.location == SsaDefinitionLocation::Instruction { block, instruction }
        })
        .map(|definition| definition.name)
}

fn definition_origin(
    function: &HirFunction,
    location: SsaDefinitionLocation,
    local: LocalId,
) -> Origin {
    match location {
        SsaDefinitionLocation::Instruction { block, instruction } => function
            .blocks
            .get(block.as_usize())
            .and_then(|block| block.instructions.get(instruction as usize))
            .map(|instruction| instruction.origin),
        SsaDefinitionLocation::Entry | SsaDefinitionLocation::Phi(_) => None,
    }
    .or_else(|| {
        function
            .locals
            .get(local.as_usize())
            .map(|local| local.origin)
    })
    .unwrap_or_else(|| Origin::generated(None, fict_hir::GeneratedOrigin::Bookkeeping))
}

fn definition_is_readonly_derived_declaration(
    function: &HirFunction,
    location: SsaDefinitionLocation,
    local: LocalId,
) -> bool {
    let SsaDefinitionLocation::Instruction { block, instruction } = location else {
        return false;
    };
    function
        .blocks
        .get(block.as_usize())
        .and_then(|block| block.instructions.get(instruction as usize))
        .is_some_and(|instruction| {
            matches!(
                instruction.kind,
                HirInstructionKind::Declare {
                    local: declared,
                    declaration_kind: DeclarationKind::Const,
                    ..
                } if declared == local
            )
        })
}

fn analyze_fresh_state_containers(identity: &StateIdentityAnalysis<'_>) -> Vec<BTreeSet<SsaName>> {
    identity
        .analyses
        .iter()
        .enumerate()
        .map(|(function_index, analysis)| {
            let mut value_memo = BTreeMap::new();
            let mut name_memo = BTreeMap::new();
            let mut fresh = BTreeSet::new();
            for definition in &analysis.ssa.definitions {
                let Some(value) = definition_source_value(
                    &identity.hir.functions[function_index],
                    definition.location,
                ) else {
                    continue;
                };
                if value_is_fresh_state_container(
                    identity,
                    function_index,
                    value,
                    &mut value_memo,
                    &mut name_memo,
                    &mut BTreeSet::new(),
                    &mut BTreeSet::new(),
                ) {
                    fresh.insert(definition.name);
                }
            }
            fresh
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn value_is_fresh_state_container(
    identity: &StateIdentityAnalysis<'_>,
    function_index: usize,
    value: ValueId,
    value_memo: &mut BTreeMap<ValueId, bool>,
    name_memo: &mut BTreeMap<SsaName, bool>,
    visiting_values: &mut BTreeSet<ValueId>,
    visiting_names: &mut BTreeSet<SsaName>,
) -> bool {
    if let Some(result) = value_memo.get(&value) {
        return *result;
    }
    if !visiting_values.insert(value) {
        return false;
    }
    let function = &identity.hir.functions[function_index];
    let result = match function
        .values
        .get(value.as_usize())
        .map(|value| &value.kind)
    {
        Some(ValueKind::Ssa(name)) => name_is_fresh_state_container(
            identity,
            function_index,
            *name,
            value_memo,
            name_memo,
            visiting_values,
            visiting_names,
        ),
        Some(ValueKind::InstructionResult) => identity
            .instruction_for_result(function, value)
            .is_some_and(|instruction| match &instruction.kind {
                HirInstructionKind::Array { .. } | HirInstructionKind::Object { .. } => true,
                HirInstructionKind::Read { place } if place.projections.is_empty() => {
                    match place.base {
                        PlaceBase::Ssa(name) => name_is_fresh_state_container(
                            identity,
                            function_index,
                            name,
                            value_memo,
                            name_memo,
                            visiting_values,
                            visiting_names,
                        ),
                        PlaceBase::Local(local) => identity.analyses[function_index]
                            .dependencies
                            .value_dependencies
                            .get(value.as_usize())
                            .into_iter()
                            .flatten()
                            .find_map(|path| match path.base {
                                DependencyBase::Ssa(name)
                                    if name.local == local && path.segments.is_empty() =>
                                {
                                    Some(name)
                                }
                                DependencyBase::Ssa(_)
                                | DependencyBase::Global(_)
                                | DependencyBase::Value(_) => None,
                            })
                            .is_some_and(|name| {
                                name_is_fresh_state_container(
                                    identity,
                                    function_index,
                                    name,
                                    value_memo,
                                    name_memo,
                                    visiting_values,
                                    visiting_names,
                                )
                            }),
                        PlaceBase::Value(base) => value_is_fresh_state_container(
                            identity,
                            function_index,
                            base,
                            value_memo,
                            name_memo,
                            visiting_values,
                            visiting_names,
                        ),
                        PlaceBase::Global(_) => false,
                    }
                }
                HirInstructionKind::Declare {
                    initializer: Some(initializer),
                    ..
                } => value_is_fresh_state_container(
                    identity,
                    function_index,
                    *initializer,
                    value_memo,
                    name_memo,
                    visiting_values,
                    visiting_names,
                ),
                HirInstructionKind::Call(call) => call
                    .callee_reference
                    .as_ref()
                    .and_then(|place| state_method_name(function, place))
                    .is_some_and(|method| {
                        state_method_returns_fresh_container(call.state_receiver_kind, &method)
                    }),
                _ => false,
            }),
        _ => false,
    };
    visiting_values.remove(&value);
    value_memo.insert(value, result);
    result
}

#[allow(clippy::too_many_arguments)]
fn name_is_fresh_state_container(
    identity: &StateIdentityAnalysis<'_>,
    function_index: usize,
    name: SsaName,
    value_memo: &mut BTreeMap<ValueId, bool>,
    name_memo: &mut BTreeMap<SsaName, bool>,
    visiting_values: &mut BTreeSet<ValueId>,
    visiting_names: &mut BTreeSet<SsaName>,
) -> bool {
    if let Some(result) = name_memo.get(&name) {
        return *result;
    }
    if !visiting_names.insert(name) {
        return false;
    }
    let function = &identity.hir.functions[function_index];
    let result = identity.definition_locations[function_index]
        .get(&name)
        .and_then(|location| definition_source_value(function, *location))
        .is_some_and(|source| {
            value_is_fresh_state_container(
                identity,
                function_index,
                source,
                value_memo,
                name_memo,
                visiting_values,
                visiting_names,
            )
        });
    visiting_names.remove(&name);
    name_memo.insert(name, result);
    result
}

fn select_earlier_site(current: &mut ReadonlySite, candidate: ReadonlySite) {
    let current_start = current
        .origin
        .primary_span
        .map_or(u32::MAX, SourceSpan::start);
    let candidate_start = candidate
        .origin
        .primary_span
        .map_or(u32::MAX, SourceSpan::start);
    if candidate_start < current_start {
        *current = candidate;
    }
}

fn place_root_local(place: &Place) -> Option<LocalId> {
    match place.base {
        PlaceBase::Local(local) => Some(local),
        PlaceBase::Ssa(name) => Some(name.local),
        PlaceBase::Global(_) | PlaceBase::Value(_) => None,
    }
}

fn state_method_call_may_mutate(function: &HirFunction, call: &fict_hir::CallInstruction) -> bool {
    let Some(place) = call.callee_reference.as_ref() else {
        return false;
    };
    state_method_name(function, place).is_none_or(|name| {
        classify_state_method_call(call.state_receiver_kind, &name)
            != StateMethodCallSemantics::ReadOnlyReceiver
    })
}

fn state_method_returns_fresh_container(receiver: StateReceiverKind, method: &str) -> bool {
    match receiver {
        StateReceiverKind::Array => matches!(
            method,
            "concat"
                | "filter"
                | "flat"
                | "flatMap"
                | "map"
                | "slice"
                | "toReversed"
                | "toSorted"
                | "toSpliced"
                | "with"
        ),
        StateReceiverKind::TypedArray => matches!(
            method,
            "filter" | "map" | "slice" | "toReversed" | "toSorted" | "with"
        ),
        StateReceiverKind::Set => matches!(
            method,
            "difference" | "intersection" | "symmetricDifference" | "union"
        ),
        StateReceiverKind::Function => method == "bind",
        StateReceiverKind::Promise => matches!(method, "catch" | "finally" | "then"),
        StateReceiverKind::String => {
            classify_state_method_result(receiver, method) == StateReceiverKind::String
        }
        StateReceiverKind::Number => method == "valueOf",
        StateReceiverKind::Unknown
        | StateReceiverKind::DataView
        | StateReceiverKind::Date
        | StateReceiverKind::Map
        | StateReceiverKind::WeakMap
        | StateReceiverKind::WeakSet => false,
    }
}

fn value_receiver_call_is_proven_safe(function: &HirFunction, place: &Place) -> bool {
    let PlaceBase::Value(receiver) = place.base else {
        return false;
    };
    let Some(name) = state_method_name(function, place) else {
        // Calling a projected value such as `state.map(fn)[0]()` does not itself mutate the
        // temporary container. Any mutation in an inline callback is validated in that body.
        return true;
    };
    let receiver = state_derived_result_receiver(function, receiver);
    classify_state_method_call(receiver, &name) == StateMethodCallSemantics::ReadOnlyReceiver
}

fn state_derived_result_receiver(function: &HirFunction, value: ValueId) -> StateReceiverKind {
    state_derived_result_receiver_inner(function, value, &mut BTreeSet::new())
}

fn state_derived_result_receiver_inner(
    function: &HirFunction,
    value: ValueId,
    visiting: &mut BTreeSet<ValueId>,
) -> StateReceiverKind {
    if !visiting.insert(value) {
        return StateReceiverKind::Unknown;
    }
    let Some(instruction) = function.instruction_for_result(value) else {
        return StateReceiverKind::Unknown;
    };
    let call = match &instruction.kind {
        HirInstructionKind::Array { .. } => return StateReceiverKind::Array,
        HirInstructionKind::Literal(fict_hir::LiteralValue::String(_)) => {
            return StateReceiverKind::String;
        }
        HirInstructionKind::Literal(fict_hir::LiteralValue::Number(_)) => {
            return StateReceiverKind::Number;
        }
        HirInstructionKind::Call(call) => call,
        _ => return StateReceiverKind::Unknown,
    };
    let Some(place) = call.callee_reference.as_ref() else {
        return StateReceiverKind::Unknown;
    };
    let Some(name) = state_method_name(function, place) else {
        return StateReceiverKind::Unknown;
    };
    let receiver = if call.state_receiver_kind == StateReceiverKind::Unknown
        && let PlaceBase::Value(receiver) = place.base
    {
        state_derived_result_receiver_inner(function, receiver, visiting)
    } else {
        call.state_receiver_kind
    };
    classify_state_method_result(receiver, &name)
}

fn state_method_name(function: &HirFunction, place: &Place) -> Option<String> {
    match place.projections.last()? {
        Projection::StaticProperty { name, .. } => Some(name.clone()),
        Projection::ComputedProperty { key, .. } => {
            let ValueKind::Literal(fict_hir::LiteralValue::String(name)) = function
                .values
                .get(key.as_usize())
                .map(|value| &value.kind)?
            else {
                return None;
            };
            name.to_utf8()
        }
        Projection::Index { .. } => None,
    }
}

fn validation_error(code: &'static str, message: impl Into<String>) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("reactive write diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(GuaranteeClass::Unsupported)
}

fn internal_error(code: &'static str, message: impl Into<String>) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("reactive write diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(GuaranteeClass::Internal)
}

fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
