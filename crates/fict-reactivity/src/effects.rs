use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_hir::{
    ArrayElement, BlockId, CallHost, FictMacroKind, FunctionId, HirFile, HirFunction,
    HirInstruction, HirInstructionKind, JsxAttribute, JsxAttributeValue, JsxChild, JsxNode,
    LocalId, LocalKind, MutationEffect, ObjectEntry, Place, PlaceBase, Projection, Purity,
    ReactiveCallKind, ReactiveScopeKind, SsaName, SsaVersion, TerminatorKind, ValueId, ValueKind,
};

use crate::{SsaAnalysis, SsaDefinitionLocation, SsaUseKind, SsaUseLocation, verify_ssa};

/// Root identity for a dependency path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DependencyBase {
    /// SSA-versioned local storage.
    Ssa(SsaName),
    /// Evaluated base object without local storage identity.
    Value(ValueId),
}

/// One structural property segment.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DependencySegment {
    /// Static property access.
    Static {
        /// Property spelling.
        name: String,
        /// Optional-chain segment.
        optional: bool,
    },
    /// Canonical non-negative integer index.
    Index {
        /// Index value.
        index: u32,
        /// Optional-chain segment.
        optional: bool,
    },
    /// Runtime-computed property key.
    Dynamic {
        /// Evaluated key value.
        key: ValueId,
        /// Optional-chain segment.
        optional: bool,
    },
}

/// Binding-aware dependency path used by reactivity and invalidation.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DependencyPath {
    /// Structural base identity.
    pub base: DependencyBase,
    /// Projection path in evaluation order.
    pub segments: Vec<DependencySegment>,
}

impl DependencyPath {
    /// Local identity when the path is local/SSA based.
    #[must_use]
    pub const fn local(&self) -> Option<LocalId> {
        match self.base {
            DependencyBase::Ssa(name) => Some(name.local),
            DependencyBase::Value(_) => None,
        }
    }

    /// Whether any property segment is runtime-computed.
    #[must_use]
    pub fn is_dynamic(&self) -> bool {
        self.segments
            .iter()
            .any(|segment| matches!(segment, DependencySegment::Dynamic { .. }))
    }

    /// Whether this is a whole-local dependency.
    #[must_use]
    pub fn is_whole_value(&self) -> bool {
        self.segments.is_empty()
    }
}

/// Stable HIR instruction location.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct InstructionLocation {
    /// Containing block.
    pub block: BlockId,
    /// Zero-based instruction index.
    pub instruction: u32,
}

/// One local/property read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadFact {
    /// Read dependency.
    pub path: DependencyPath,
    /// Read location.
    pub location: InstructionLocation,
    /// Whether the value directly controls a branch/switch.
    pub controls_flow: bool,
}

/// One local/property write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteFact {
    /// Written dependency path.
    pub path: DependencyPath,
    /// Write location.
    pub location: InstructionLocation,
    /// Mutation visibility carried by HIR.
    pub mutation: MutationEffect,
}

/// Why a local dependency leaves its ordinary analysis scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EscapeKind {
    /// Returned from the function.
    Return,
    /// Thrown out of the function.
    Throw,
    /// Passed to an unknown or externally-bound call.
    UnknownCall,
    /// Passed to an unknown constructor.
    Constructor,
    /// Captured by an escaping callback.
    CallbackCapture,
    /// Captured by a known deferred reactive callback.
    DeferredCapture,
    /// Stored into an externally observable/captured place.
    ObservableWrite,
    /// Adapter-owned syntax reports an escape-capable side effect.
    SyntaxFragment,
}

/// One escaping dependency.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EscapeFact {
    /// Escaping path.
    pub path: DependencyPath,
    /// Escape reason.
    pub kind: EscapeKind,
    /// Instruction location, absent for terminator escapes.
    pub location: Option<InstructionLocation>,
}

/// Callback execution/escape classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CallbackDisposition {
    /// Configured or inferred reactive host.
    Reactive(ReactiveScopeKind),
    /// Fict effect callback.
    Effect,
    /// Fict memo callback.
    Memo,
    /// Async resource callback retained by `resource`.
    Resource,
    /// Selector source/equality callback retained by `createSelector`.
    Selector,
    /// Callback passed to a known nested HIR function.
    Internal,
    /// Unknown host may retain/invoke the callback arbitrarily.
    EscapesUnknown,
}

/// Function-valued call argument and its host policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CallbackFact {
    /// Call instruction.
    pub location: InstructionLocation,
    /// Zero-based call argument index.
    pub argument_index: u16,
    /// Nested HIR function.
    pub function: FunctionId,
    /// Host classification.
    pub disposition: CallbackDisposition,
}

/// Optimization barrier category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum BarrierKind {
    /// Local mutation invalidates aliases/member reads.
    LocalMutation,
    /// Observable source/host mutation.
    ObservableMutation,
    /// Mutation behavior is unknown.
    UnknownMutation,
    /// Evaluation may throw and therefore constrains reordering.
    MayThrow,
    /// Call/operation purity is not proven.
    UnknownPurity,
    /// Await/yield/deferred execution boundary.
    DeferredExecution,
    /// Adapter-owned syntax with side effects.
    SyntaxFragment,
    /// Explicit source debugger boundary.
    Debugger,
}

/// One instruction and all reasons it blocks reordering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BarrierFact {
    /// Barrier location.
    pub location: InstructionLocation,
    /// Sorted unique categories.
    pub kinds: Vec<BarrierKind>,
}

/// Deterministic pass statistics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DependencyStats {
    /// Read facts.
    pub reads: u32,
    /// Write facts.
    pub writes: u32,
    /// Escape facts.
    pub escapes: u32,
    /// Function-valued callback arguments.
    pub callbacks: u32,
    /// Barrier instructions.
    pub barriers: u32,
    /// Value-dependency fixed-point sweeps.
    pub fixed_point_iterations: u32,
}

/// Read/write/dependency/escape/callback facts for one function.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DependencyAnalysis {
    /// Reads in source HIR order.
    pub reads: Vec<ReadFact>,
    /// Writes in source HIR order.
    pub writes: Vec<WriteFact>,
    /// Dependencies directly controlling branch/switch decisions.
    pub control_flow_reads: Vec<DependencyPath>,
    /// Escapes in deterministic reason/location/path order.
    pub escapes: Vec<EscapeFact>,
    /// Function-valued arguments and host dispositions.
    pub callbacks: Vec<CallbackFact>,
    /// Evaluation-order barriers.
    pub barriers: Vec<BarrierFact>,
    /// Transitive dependency set for every function value.
    pub value_dependencies: Vec<Vec<DependencyPath>>,
    /// Pass statistics.
    pub stats: DependencyStats,
}

/// Analyze dependencies and observable escape/evaluation boundaries.
pub fn analyze_dependencies(
    file: &HirFile,
    function_id: FunctionId,
    ssa: &SsaAnalysis,
) -> Result<DependencyAnalysis, DiagnosticBundle> {
    let Some(function) = file.functions.get(function_id.as_usize()) else {
        return Err(DiagnosticBundle::new(vec![analysis_error(
            "FICT-ANALYSIS-FUNCTION",
            "dependency analysis function is outside the HIR arena",
        )]));
    };
    verify_ssa(function, ssa)?;

    let use_names = ssa_use_names(ssa);
    let definition_names = ssa_definition_names(ssa);
    let local_by_binding: BTreeMap<_, _> = function
        .locals
        .iter()
        .filter_map(|local| local.binding.map(|binding| (binding, local.id)))
        .collect();
    let mut definitions_by_instruction: BTreeMap<_, Vec<_>> = BTreeMap::new();
    for definition in &ssa.definitions {
        if let SsaDefinitionLocation::Instruction { block, instruction } = definition.location {
            definitions_by_instruction
                .entry((block, instruction))
                .or_default()
                .push((definition.name.local, definition.name));
        }
    }
    let mut direct_dependencies = vec![BTreeSet::new(); function.values.len()];
    let mut input_edges = vec![Vec::new(); function.values.len()];
    let mut fragment_reads: BTreeMap<(BlockId, u32), Vec<DependencyPath>> = BTreeMap::new();
    for block in &function.blocks {
        if !ssa.cfg.reachable[block.id.as_usize()] {
            continue;
        }
        let mut current_versions = ssa.block_entry[block.id.as_usize()].clone();
        for phi in ssa.phis.iter().filter(|phi| phi.block == block.id) {
            current_versions[phi.target.local.as_usize()] = Some(phi.target);
        }
        for (instruction_index, instruction) in block.instructions.iter().enumerate() {
            let fragment = match &instruction.kind {
                HirInstructionKind::SyntaxFragment { fragment, .. }
                | HirInstructionKind::Iteration {
                    pattern: fragment, ..
                } => Some(*fragment),
                _ => None,
            };
            let mut implicit_paths = Vec::new();
            if let Some(fragment) = fragment
                && let Some(fragment) = file.syntax_fragments.get(fragment.as_usize())
            {
                for binding in &fragment.summary.referenced_bindings {
                    let Some(local) = local_by_binding.get(binding) else {
                        continue;
                    };
                    if let Some(name) = current_versions[local.as_usize()] {
                        let path = DependencyPath {
                            base: DependencyBase::Ssa(name),
                            segments: Vec::new(),
                        };
                        if !implicit_paths.contains(&path) {
                            implicit_paths.push(path);
                        }
                    }
                }
            }
            if !implicit_paths.is_empty() {
                fragment_reads.insert(
                    (block.id, count_u32(instruction_index)),
                    implicit_paths.clone(),
                );
            }
            if let Some(result) = instruction.result {
                let result_index = result.as_usize();
                if result_index < function.values.len() {
                    match &instruction.kind {
                        HirInstructionKind::Read { place } => {
                            if let Some(path) = dependency_path(
                                place,
                                block.id,
                                instruction_index,
                                SsaUseKind::Read,
                                &use_names,
                            ) {
                                direct_dependencies[result_index].insert(path);
                            }
                        }
                        HirInstructionKind::Phi { sources, .. } => {
                            direct_dependencies[result_index].extend(sources.iter().map(
                                |(_, source)| DependencyPath {
                                    base: DependencyBase::Ssa(*source),
                                    segments: Vec::new(),
                                },
                            ));
                        }
                        HirInstructionKind::SyntaxFragment { .. } => {
                            direct_dependencies[result_index]
                                .extend(implicit_paths.iter().cloned());
                            input_edges[result_index].extend(instruction_inputs(instruction, file));
                        }
                        _ => {
                            input_edges[result_index].extend(instruction_inputs(instruction, file))
                        }
                    }
                }
            }
            if let Some(definitions) =
                definitions_by_instruction.get(&(block.id, count_u32(instruction_index)))
            {
                for (local, name) in definitions {
                    current_versions[local.as_usize()] = Some(*name);
                }
            }
        }
    }

    let mut value_dependencies = direct_dependencies;
    let maximum_iterations = function.values.len().saturating_add(2);
    let mut iterations = 0_usize;
    loop {
        iterations = iterations.saturating_add(1);
        if iterations > maximum_iterations {
            return Err(DiagnosticBundle::new(vec![analysis_error(
                "FICT-ANALYSIS-FIXED-POINT",
                "value dependency propagation exceeded its deterministic iteration limit",
            )]));
        }
        let previous = value_dependencies.clone();
        let mut changed = false;
        for (result, inputs) in input_edges.iter().enumerate() {
            for input in inputs {
                if let Some(dependencies) = previous.get(input.as_usize()) {
                    let before = value_dependencies[result].len();
                    value_dependencies[result].extend(dependencies.iter().cloned());
                    changed |= before != value_dependencies[result].len();
                }
            }
        }
        if !changed {
            break;
        }
    }

    let mut reads = Vec::new();
    let mut writes = Vec::new();
    let mut escapes = Vec::new();
    let mut callbacks = Vec::new();
    let mut barriers = Vec::new();
    for block in &function.blocks {
        if !ssa.cfg.reachable[block.id.as_usize()] {
            continue;
        }
        for (instruction_index, instruction) in block.instructions.iter().enumerate() {
            let location = InstructionLocation {
                block: block.id,
                instruction: count_u32(instruction_index),
            };
            if let Some(paths) = fragment_reads.get(&(block.id, location.instruction)) {
                reads.extend(paths.iter().cloned().map(|path| ReadFact {
                    path,
                    location,
                    controls_flow: false,
                }));
            }
            match &instruction.kind {
                HirInstructionKind::Declare {
                    local, initializer, ..
                } => {
                    if initializer.is_some()
                        && let Some(name) =
                            definition_names.get(&(block.id, count_u32(instruction_index), *local))
                    {
                        writes.push(WriteFact {
                            path: DependencyPath {
                                base: DependencyBase::Ssa(*name),
                                segments: Vec::new(),
                            },
                            location,
                            mutation: MutationEffect::Local,
                        });
                    }
                }
                HirInstructionKind::Read { place } => {
                    if let Some(path) = dependency_path(
                        place,
                        block.id,
                        instruction_index,
                        SsaUseKind::Read,
                        &use_names,
                    ) {
                        reads.push(ReadFact {
                            path,
                            location,
                            controls_flow: false,
                        });
                    }
                }
                HirInstructionKind::Write { place, value } => {
                    record_write(
                        place,
                        *value,
                        instruction,
                        location,
                        SsaUseKind::ProjectedWriteBase,
                        function,
                        &use_names,
                        &definition_names,
                        &value_dependencies,
                        &mut writes,
                        &mut escapes,
                    );
                }
                HirInstructionKind::ReadWrite { place, .. } => {
                    if let Some(path) = dependency_path(
                        place,
                        block.id,
                        instruction_index,
                        SsaUseKind::ReadWrite,
                        &use_names,
                    ) {
                        reads.push(ReadFact {
                            path: path.clone(),
                            location,
                            controls_flow: false,
                        });
                        writes.push(WriteFact {
                            path: direct_write_path(place, location, &definition_names)
                                .unwrap_or(path),
                            location,
                            mutation: instruction.semantics.mutation,
                        });
                    }
                }
                HirInstructionKind::Iteration {
                    source, targets, ..
                } => {
                    add_value_escapes(
                        *source,
                        EscapeKind::SyntaxFragment,
                        Some(location),
                        &value_dependencies,
                        &mut escapes,
                    );
                    for target in targets {
                        if let Some(name) =
                            definition_names.get(&(block.id, count_u32(instruction_index), *target))
                        {
                            writes.push(WriteFact {
                                path: DependencyPath {
                                    base: DependencyBase::Ssa(*name),
                                    segments: Vec::new(),
                                },
                                location,
                                mutation: MutationEffect::Local,
                            });
                        }
                    }
                }
                HirInstructionKind::Call(call) => {
                    classify_callbacks_and_call_escapes(
                        file,
                        function,
                        call,
                        location,
                        &value_dependencies,
                        &mut callbacks,
                        &mut escapes,
                    );
                }
                HirInstructionKind::New { arguments, .. } => {
                    for argument in arguments {
                        add_value_escapes(
                            argument.value,
                            EscapeKind::Constructor,
                            Some(location),
                            &value_dependencies,
                            &mut escapes,
                        );
                    }
                }
                HirInstructionKind::SyntaxFragment { fragment, inputs }
                    if file
                        .syntax_fragments
                        .get(fragment.as_usize())
                        .is_some_and(|fragment| fragment.summary.has_side_effects) =>
                {
                    for input in inputs {
                        add_value_escapes(
                            *input,
                            EscapeKind::SyntaxFragment,
                            Some(location),
                            &value_dependencies,
                            &mut escapes,
                        );
                    }
                }
                _ => {}
            }
            if let Some(barrier) = barrier_fact(file, instruction, location) {
                barriers.push(barrier);
            }
        }

        match &block.terminator.kind {
            TerminatorKind::Return { value } => {
                if let Some(value) = value {
                    add_value_escapes(
                        *value,
                        EscapeKind::Return,
                        None,
                        &value_dependencies,
                        &mut escapes,
                    );
                }
            }
            TerminatorKind::Throw { value } => add_value_escapes(
                *value,
                EscapeKind::Throw,
                None,
                &value_dependencies,
                &mut escapes,
            ),
            TerminatorKind::Branch { test, .. } => {
                mark_control_dependencies(*test, &value_dependencies, &mut reads)
            }
            TerminatorKind::Switch { discriminant, .. } => {
                mark_control_dependencies(*discriminant, &value_dependencies, &mut reads)
            }
            TerminatorKind::ForIn { object, .. } => {
                mark_control_dependencies(*object, &value_dependencies, &mut reads)
            }
            TerminatorKind::ForOf { iterable, .. } => {
                mark_control_dependencies(*iterable, &value_dependencies, &mut reads)
            }
            TerminatorKind::Goto { .. }
            | TerminatorKind::Try { .. }
            | TerminatorKind::Unreachable => {}
        }
    }

    for callback in &callbacks {
        let kind = match callback.disposition {
            CallbackDisposition::EscapesUnknown => EscapeKind::CallbackCapture,
            CallbackDisposition::Reactive(_)
            | CallbackDisposition::Effect
            | CallbackDisposition::Memo
            | CallbackDisposition::Resource
            | CallbackDisposition::Selector => EscapeKind::DeferredCapture,
            CallbackDisposition::Internal => continue,
        };
        add_callback_capture_escapes(file, function, ssa, *callback, kind, &mut escapes);
    }

    let control_flow_reads: Vec<_> = reads
        .iter()
        .filter(|read| read.controls_flow)
        .map(|read| read.path.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    escapes.sort_by(|left, right| {
        left.location
            .cmp(&right.location)
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| left.path.cmp(&right.path))
    });
    escapes.dedup();
    let value_dependencies: Vec<Vec<_>> = value_dependencies
        .into_iter()
        .map(|dependencies| dependencies.into_iter().collect())
        .collect();
    let stats = DependencyStats {
        reads: count_u32(reads.len()),
        writes: count_u32(writes.len()),
        escapes: count_u32(escapes.len()),
        callbacks: count_u32(callbacks.len()),
        barriers: count_u32(barriers.len()),
        fixed_point_iterations: count_u32(iterations),
    };
    let analysis = DependencyAnalysis {
        reads,
        writes,
        control_flow_reads,
        escapes,
        callbacks,
        barriers,
        value_dependencies,
        stats,
    };
    verify_dependencies(file, function_id, ssa, &analysis)?;
    Ok(analysis)
}

/// Verify dependency arenas, structural paths, callback ownership, and stats.
pub fn verify_dependencies(
    file: &HirFile,
    function_id: FunctionId,
    ssa: &SsaAnalysis,
    analysis: &DependencyAnalysis,
) -> Result<(), DiagnosticBundle> {
    let Some(function) = file.functions.get(function_id.as_usize()) else {
        return Err(DiagnosticBundle::new(vec![analysis_error(
            "FICT-ANALYSIS-FUNCTION",
            "dependency verifier function is outside the HIR arena",
        )]));
    };
    let mut diagnostics = DiagnosticBundle::default();
    if analysis.value_dependencies.len() != function.values.len() {
        diagnostics.push(analysis_error(
            "FICT-ANALYSIS-ARENA",
            "value dependency arena must match the HIR value arena",
        ));
    }
    let definitions: BTreeSet<_> = ssa
        .definitions
        .iter()
        .map(|definition| definition.name)
        .collect();
    for read in &analysis.reads {
        verify_dependency_path(function, &definitions, &read.path, &mut diagnostics);
        verify_location(function, read.location, &mut diagnostics);
    }
    for write in &analysis.writes {
        verify_dependency_path(function, &definitions, &write.path, &mut diagnostics);
        verify_location(function, write.location, &mut diagnostics);
    }
    for path in &analysis.control_flow_reads {
        verify_dependency_path(function, &definitions, path, &mut diagnostics);
        if !analysis
            .reads
            .iter()
            .any(|read| read.controls_flow && read.path == *path)
        {
            diagnostics.push(analysis_error(
                "FICT-ANALYSIS-CONTROL",
                "control-flow dependency has no matching control read",
            ));
        }
    }
    for escape in &analysis.escapes {
        verify_dependency_path(function, &definitions, &escape.path, &mut diagnostics);
        if let Some(location) = escape.location {
            verify_location(function, location, &mut diagnostics);
        }
    }
    for dependencies in &analysis.value_dependencies {
        let mut previous = None;
        for path in dependencies {
            verify_dependency_path(function, &definitions, path, &mut diagnostics);
            if previous.as_ref().is_some_and(|previous| previous >= path) {
                diagnostics.push(analysis_error(
                    "FICT-ANALYSIS-ORDER",
                    "value dependencies must be strictly sorted and unique",
                ));
                break;
            }
            previous = Some(path.clone());
        }
    }
    for callback in &analysis.callbacks {
        verify_location(function, callback.location, &mut diagnostics);
        if callback.function.as_usize() >= file.functions.len() {
            diagnostics.push(analysis_error(
                "FICT-ANALYSIS-CALLBACK",
                "callback function is outside the HIR function arena",
            ));
        }
        let call = function
            .blocks
            .get(callback.location.block.as_usize())
            .and_then(|block| {
                block
                    .instructions
                    .get(callback.location.instruction as usize)
            })
            .and_then(|instruction| match &instruction.kind {
                HirInstructionKind::Call(call) => Some(call),
                _ => None,
            });
        if call.is_none_or(|call| usize::from(callback.argument_index) >= call.arguments.len()) {
            diagnostics.push(analysis_error(
                "FICT-ANALYSIS-CALLBACK",
                "callback fact does not reference a function-valued call argument",
            ));
        } else if call.is_some_and(|call| {
            callback_disposition(call, usize::from(callback.argument_index)) != callback.disposition
        }) {
            diagnostics.push(analysis_error(
                "FICT-ANALYSIS-CALLBACK-KIND",
                "callback disposition must match the binding-resolved call host",
            ));
        }
    }
    for barrier in &analysis.barriers {
        verify_location(function, barrier.location, &mut diagnostics);
        if barrier.kinds.is_empty() || barrier.kinds.windows(2).any(|pair| pair[0] >= pair[1]) {
            diagnostics.push(analysis_error(
                "FICT-ANALYSIS-BARRIER",
                "barrier kinds must be non-empty, sorted, and unique",
            ));
        }
    }
    if analysis.stats.reads != count_u32(analysis.reads.len())
        || analysis.stats.writes != count_u32(analysis.writes.len())
        || analysis.stats.escapes != count_u32(analysis.escapes.len())
        || analysis.stats.callbacks != count_u32(analysis.callbacks.len())
        || analysis.stats.barriers != count_u32(analysis.barriers.len())
    {
        diagnostics.push(analysis_error(
            "FICT-ANALYSIS-STATS",
            "dependency pass stats do not match result arenas",
        ));
    }

    if diagnostics.is_empty() {
        Ok(())
    } else {
        Err(diagnostics)
    }
}

fn verify_dependency_path(
    function: &HirFunction,
    definitions: &BTreeSet<SsaName>,
    path: &DependencyPath,
    diagnostics: &mut DiagnosticBundle,
) {
    match path.base {
        DependencyBase::Ssa(name) => {
            if name.local.as_usize() >= function.locals.len() {
                diagnostics.push(analysis_error(
                    "FICT-ANALYSIS-LOCAL",
                    "dependency path local is outside the function arena",
                ));
            } else if !definitions.contains(&name) {
                diagnostics.push(analysis_error(
                    "FICT-ANALYSIS-SSA",
                    "dependency path references an unknown SSA definition",
                ));
            }
        }
        DependencyBase::Value(value) => {
            if value.as_usize() >= function.values.len() {
                diagnostics.push(analysis_error(
                    "FICT-ANALYSIS-VALUE",
                    "dependency path base value is outside the function arena",
                ));
            }
        }
    }
    for segment in &path.segments {
        if let DependencySegment::Dynamic { key, .. } = segment
            && key.as_usize() >= function.values.len()
        {
            diagnostics.push(analysis_error(
                "FICT-ANALYSIS-VALUE",
                "dynamic dependency key is outside the function value arena",
            ));
        }
    }
}

fn verify_location(
    function: &HirFunction,
    location: InstructionLocation,
    diagnostics: &mut DiagnosticBundle,
) {
    if function
        .blocks
        .get(location.block.as_usize())
        .is_none_or(|block| location.instruction as usize >= block.instructions.len())
    {
        diagnostics.push(analysis_error(
            "FICT-ANALYSIS-LOCATION",
            "analysis fact references an instruction outside the HIR arena",
        ));
    }
}

fn ssa_use_names(ssa: &SsaAnalysis) -> BTreeMap<(BlockId, u32, LocalId, SsaUseKind), SsaName> {
    ssa.uses
        .iter()
        .filter_map(|usage| match usage.location {
            SsaUseLocation::Instruction { block, instruction } => Some((
                (block, instruction, usage.name.local, usage.kind),
                usage.name,
            )),
            SsaUseLocation::PhiEdge { .. } => None,
        })
        .collect()
}

fn ssa_definition_names(ssa: &SsaAnalysis) -> BTreeMap<(BlockId, u32, LocalId), SsaName> {
    ssa.definitions
        .iter()
        .filter_map(|definition| match definition.location {
            SsaDefinitionLocation::Instruction { block, instruction } => {
                Some(((block, instruction, definition.name.local), definition.name))
            }
            SsaDefinitionLocation::Entry | SsaDefinitionLocation::Phi(_) => None,
        })
        .collect()
}

fn dependency_path(
    place: &Place,
    block: BlockId,
    instruction: usize,
    use_kind: SsaUseKind,
    use_names: &BTreeMap<(BlockId, u32, LocalId, SsaUseKind), SsaName>,
) -> Option<DependencyPath> {
    let base = match place.base {
        PlaceBase::Local(local) => DependencyBase::Ssa(
            use_names
                .get(&(block, count_u32(instruction), local, use_kind))
                .copied()
                .unwrap_or_else(|| SsaName::new(local, SsaVersion::INITIAL)),
        ),
        PlaceBase::Ssa(name) => DependencyBase::Ssa(name),
        PlaceBase::Value(value) => DependencyBase::Value(value),
    };
    let segments = place
        .projections
        .iter()
        .map(|projection| match projection {
            Projection::StaticProperty { name, optional } => DependencySegment::Static {
                name: name.clone(),
                optional: *optional,
            },
            Projection::ComputedProperty { key, optional } => DependencySegment::Dynamic {
                key: *key,
                optional: *optional,
            },
            Projection::Index { index, optional } => DependencySegment::Index {
                index: *index,
                optional: *optional,
            },
        })
        .collect();
    Some(DependencyPath { base, segments })
}

#[allow(clippy::too_many_arguments)]
fn record_write(
    place: &Place,
    value: ValueId,
    instruction: &HirInstruction,
    location: InstructionLocation,
    use_kind: SsaUseKind,
    function: &HirFunction,
    use_names: &BTreeMap<(BlockId, u32, LocalId, SsaUseKind), SsaName>,
    definition_names: &BTreeMap<(BlockId, u32, LocalId), SsaName>,
    value_dependencies: &[BTreeSet<DependencyPath>],
    writes: &mut Vec<WriteFact>,
    escapes: &mut Vec<EscapeFact>,
) {
    let path = if place.is_local() {
        let local = match place.base {
            PlaceBase::Local(local) => local,
            PlaceBase::Ssa(name) => name.local,
            PlaceBase::Value(_) => return,
        };
        DependencyPath {
            base: DependencyBase::Ssa(
                definition_names
                    .get(&(location.block, location.instruction, local))
                    .copied()
                    .unwrap_or_else(|| SsaName::new(local, SsaVersion::INITIAL)),
            ),
            segments: Vec::new(),
        }
    } else {
        let Some(path) = dependency_path(
            place,
            location.block,
            location.instruction as usize,
            use_kind,
            use_names,
        ) else {
            return;
        };
        path
    };
    writes.push(WriteFact {
        path: path.clone(),
        location,
        mutation: instruction.semantics.mutation,
    });
    if path.local().is_some_and(|local| {
        function
            .locals
            .get(local.as_usize())
            .is_some_and(|local| local.kind == LocalKind::Capture)
    }) || instruction.semantics.has_observable_mutation()
    {
        add_value_escapes(
            value,
            EscapeKind::ObservableWrite,
            Some(location),
            value_dependencies,
            escapes,
        );
    }
}

fn direct_write_path(
    place: &Place,
    location: InstructionLocation,
    definition_names: &BTreeMap<(BlockId, u32, LocalId), SsaName>,
) -> Option<DependencyPath> {
    if !place.is_local() {
        return None;
    }
    let local = match place.base {
        PlaceBase::Local(local) => local,
        PlaceBase::Ssa(name) => name.local,
        PlaceBase::Value(_) => return None,
    };
    let name = definition_names.get(&(location.block, location.instruction, local))?;
    Some(DependencyPath {
        base: DependencyBase::Ssa(*name),
        segments: Vec::new(),
    })
}

fn classify_callbacks_and_call_escapes(
    file: &HirFile,
    function: &HirFunction,
    call: &fict_hir::CallInstruction,
    location: InstructionLocation,
    value_dependencies: &[BTreeSet<DependencyPath>],
    callbacks: &mut Vec<CallbackFact>,
    escapes: &mut Vec<EscapeFact>,
) {
    for (argument_index, argument) in call.arguments.iter().enumerate() {
        let nested = function
            .values
            .get(argument.value.as_usize())
            .and_then(|value| match value.kind {
                ValueKind::Function(function) => Some(function),
                _ => None,
            });
        if let Some(nested) = nested {
            let disposition = callback_disposition(call, argument_index);
            if file.functions.get(nested.as_usize()).is_some() {
                callbacks.push(CallbackFact {
                    location,
                    argument_index: u16::try_from(argument_index).unwrap_or(u16::MAX),
                    function: nested,
                    disposition,
                });
            }
        } else if matches!(call.host, CallHost::Unknown | CallHost::Binding(_))
            && call.macro_kind.is_none()
        {
            add_value_escapes(
                argument.value,
                EscapeKind::UnknownCall,
                Some(location),
                value_dependencies,
                escapes,
            );
        }
    }
}

fn callback_disposition(
    call: &fict_hir::CallInstruction,
    argument_index: usize,
) -> CallbackDisposition {
    match call.host {
        CallHost::ReactiveScope(host) if usize::from(host.callback_index) == argument_index => {
            CallbackDisposition::Reactive(host.kind)
        }
        CallHost::Function(_) => CallbackDisposition::Internal,
        CallHost::Unknown | CallHost::Binding(_) | CallHost::ReactiveScope(_) => {
            match (call.macro_kind, call.reactive_kind, argument_index) {
                (Some(FictMacroKind::Effect), _, 0) => CallbackDisposition::Effect,
                (Some(FictMacroKind::Memo), _, 0) => CallbackDisposition::Memo,
                (_, Some(ReactiveCallKind::Resource), _) => CallbackDisposition::Resource,
                (_, Some(ReactiveCallKind::Selector), _) => CallbackDisposition::Selector,
                _ => CallbackDisposition::EscapesUnknown,
            }
        }
    }
}

fn add_callback_capture_escapes(
    file: &HirFile,
    owner: &HirFunction,
    ssa: &SsaAnalysis,
    callback: CallbackFact,
    kind: EscapeKind,
    escapes: &mut Vec<EscapeFact>,
) {
    let Some(nested) = file.functions.get(callback.function.as_usize()) else {
        return;
    };
    let owner_by_binding: BTreeMap<_, _> = owner
        .locals
        .iter()
        .filter_map(|local| local.binding.map(|binding| (binding, local.id)))
        .collect();
    for capture in nested
        .locals
        .iter()
        .filter(|local| local.kind == LocalKind::Capture)
    {
        let Some(local) = capture
            .binding
            .and_then(|binding| owner_by_binding.get(&binding).copied())
        else {
            continue;
        };
        let name = ssa_name_at_location(ssa, local, callback.location)
            .unwrap_or_else(|| SsaName::new(local, SsaVersion::INITIAL));
        escapes.push(EscapeFact {
            path: DependencyPath {
                base: DependencyBase::Ssa(name),
                segments: Vec::new(),
            },
            kind,
            location: Some(callback.location),
        });
    }
}

fn ssa_name_at_location(
    ssa: &SsaAnalysis,
    local: LocalId,
    location: InstructionLocation,
) -> Option<SsaName> {
    ssa.definitions
        .iter()
        .filter(|definition| definition.name.local == local)
        .filter(|definition| match definition.location {
            SsaDefinitionLocation::Entry => true,
            SsaDefinitionLocation::Phi(block) => {
                block == location.block || ssa.cfg.dominates(block, location.block)
            }
            SsaDefinitionLocation::Instruction { block, instruction } => {
                if block == location.block {
                    instruction < location.instruction
                } else {
                    ssa.cfg.dominates(block, location.block)
                }
            }
        })
        .map(|definition| definition.name)
        .max_by_key(|name| name.version)
}

fn add_value_escapes(
    value: ValueId,
    kind: EscapeKind,
    location: Option<InstructionLocation>,
    value_dependencies: &[BTreeSet<DependencyPath>],
    escapes: &mut Vec<EscapeFact>,
) {
    if let Some(dependencies) = value_dependencies.get(value.as_usize()) {
        escapes.extend(dependencies.iter().cloned().map(|path| EscapeFact {
            path,
            kind,
            location,
        }));
    }
}

fn barrier_fact(
    file: &HirFile,
    instruction: &HirInstruction,
    location: InstructionLocation,
) -> Option<BarrierFact> {
    let mut kinds = BTreeSet::new();
    match instruction.semantics.mutation {
        MutationEffect::None => {}
        MutationEffect::Local => {
            kinds.insert(BarrierKind::LocalMutation);
        }
        MutationEffect::Observable => {
            kinds.insert(BarrierKind::ObservableMutation);
        }
        MutationEffect::Unknown => {
            kinds.insert(BarrierKind::UnknownMutation);
        }
    }
    if instruction.semantics.may_throw {
        kinds.insert(BarrierKind::MayThrow);
    }
    if instruction.semantics.purity == Purity::Unknown {
        kinds.insert(BarrierKind::UnknownPurity);
    }
    match instruction.kind {
        HirInstructionKind::Await { .. }
        | HirInstructionKind::Yield { .. }
        | HirInstructionKind::Iteration {
            kind: fict_hir::IterationKind::AwaitOf,
            ..
        } => {
            kinds.insert(BarrierKind::DeferredExecution);
        }
        HirInstructionKind::SyntaxFragment { fragment, .. }
            if file
                .syntax_fragments
                .get(fragment.as_usize())
                .is_some_and(|fragment| fragment.summary.has_side_effects) =>
        {
            kinds.insert(BarrierKind::SyntaxFragment);
        }
        HirInstructionKind::Debugger => {
            kinds.insert(BarrierKind::Debugger);
        }
        _ => {}
    }
    (!kinds.is_empty()).then(|| BarrierFact {
        location,
        kinds: kinds.into_iter().collect(),
    })
}

fn instruction_inputs(instruction: &HirInstruction, file: &HirFile) -> Vec<ValueId> {
    match &instruction.kind {
        HirInstructionKind::Declare { initializer, .. } => initializer.iter().copied().collect(),
        HirInstructionKind::Read { place } => projection_values(place),
        HirInstructionKind::Write { value, place } => {
            let mut values = projection_values(place);
            values.push(*value);
            values
        }
        HirInstructionKind::ReadWrite { value, place, .. } => {
            let mut values = projection_values(place);
            values.extend(*value);
            values
        }
        HirInstructionKind::Iteration { source, .. } => vec![*source],
        HirInstructionKind::Literal(_)
        | HirInstructionKind::Function { .. }
        | HirInstructionKind::Debugger => Vec::new(),
        HirInstructionKind::Unary { argument, .. } => vec![*argument],
        HirInstructionKind::Binary { left, right, .. } => vec![*left, *right],
        HirInstructionKind::Call(call) => std::iter::once(call.callee)
            .chain(call.arguments.iter().map(|argument| argument.value))
            .collect(),
        HirInstructionKind::New { callee, arguments } => std::iter::once(*callee)
            .chain(arguments.iter().map(|argument| argument.value))
            .collect(),
        HirInstructionKind::Array { elements } => elements
            .iter()
            .filter_map(|element| match element {
                ArrayElement::Hole(_) => None,
                ArrayElement::Value(value) | ArrayElement::Spread { value, .. } => Some(*value),
            })
            .collect(),
        HirInstructionKind::Object { entries } => entries
            .iter()
            .flat_map(|entry| match entry {
                ObjectEntry::Property { key, value, .. } => {
                    let key = match key {
                        fict_hir::PropertyKey::Computed(key) => Some(*key),
                        fict_hir::PropertyKey::Static(_) | fict_hir::PropertyKey::Index(_) => None,
                    };
                    key.into_iter()
                        .chain(std::iter::once(*value))
                        .collect::<Vec<_>>()
                }
                ObjectEntry::Spread { value, .. } => vec![*value],
            })
            .collect(),
        HirInstructionKind::Jsx { template } => file
            .templates
            .get(template.as_usize())
            .map_or_else(Vec::new, |template| jsx_values(&template.root)),
        HirInstructionKind::Await { value } => vec![*value],
        HirInstructionKind::Yield { value, .. } => value.iter().copied().collect(),
        HirInstructionKind::Phi { .. } => Vec::new(),
        HirInstructionKind::SyntaxFragment { inputs, .. } => inputs.clone(),
    }
}

fn projection_values(place: &Place) -> Vec<ValueId> {
    let mut values = Vec::new();
    if let PlaceBase::Value(value) = place.base {
        values.push(value);
    }
    values.extend(
        place
            .projections
            .iter()
            .filter_map(|projection| match projection {
                Projection::ComputedProperty { key, .. } => Some(*key),
                Projection::StaticProperty { .. } | Projection::Index { .. } => None,
            }),
    );
    values
}

fn jsx_values(root: &JsxNode) -> Vec<ValueId> {
    enum Item<'a> {
        Node(&'a JsxNode),
        Child(&'a JsxChild),
    }
    let mut values = Vec::new();
    let mut stack = vec![Item::Node(root)];
    while let Some(item) = stack.pop() {
        match item {
            Item::Node(JsxNode::Element(element)) => {
                if let fict_hir::JsxElementName::Dynamic(value) = element.name {
                    values.push(value);
                }
                for attribute in &element.attributes {
                    match attribute {
                        JsxAttribute::Named { value, .. } => match value {
                            JsxAttributeValue::Expression { value, .. } => values.push(*value),
                            JsxAttributeValue::Node(node) => stack.push(Item::Node(node)),
                            JsxAttributeValue::ImplicitTrue | JsxAttributeValue::Text(_) => {}
                        },
                        JsxAttribute::Spread { value, .. } => values.push(*value),
                    }
                }
                for child in element.children.iter().rev() {
                    stack.push(Item::Child(child));
                }
            }
            Item::Node(JsxNode::Fragment { children, .. }) => {
                for child in children.iter().rev() {
                    stack.push(Item::Child(child));
                }
            }
            Item::Child(JsxChild::Text { .. }) => {}
            Item::Child(JsxChild::Expression { value, .. })
            | Item::Child(JsxChild::Spread { value, .. }) => values.push(*value),
            Item::Child(JsxChild::Node(node)) => stack.push(Item::Node(node)),
        }
    }
    values
}

fn mark_control_dependencies(
    value: ValueId,
    value_dependencies: &[BTreeSet<DependencyPath>],
    reads: &mut [ReadFact],
) {
    let Some(dependencies) = value_dependencies.get(value.as_usize()) else {
        return;
    };
    for read in reads {
        if dependencies.contains(&read.path) {
            read.controls_flow = true;
        }
    }
}

fn analysis_error(code: &'static str, message: impl Into<String>) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("analysis diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(GuaranteeClass::Internal)
}

fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
