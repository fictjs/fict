use std::collections::{BTreeMap, BTreeSet, VecDeque};

use fict_diagnostics::{Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass};
use fict_hir::{
    BlockId, FunctionKind, HirFunction, HirInstruction, HirInstructionKind, LiteralValue,
    ObjectEntry, ObjectPropertyKind, Place, PlaceBase, Projection, PropertyKey, SourceSpan,
    TerminatorKind, UnaryOperator, ValueId,
};

#[derive(Debug, Clone, Default)]
pub(super) struct StorageOriginFacts {
    pub classified_projected_writes: BTreeSet<(u32, u32)>,
    pub external_projected_writes: BTreeSet<(u32, u32)>,
}

type StorageOriginResult<T> = Result<T, Box<Diagnostic>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum StorageOrigin {
    Unreachable,
    Local,
    External,
    Mixed,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Truthiness {
    Unreachable,
    Falsy,
    Truthy,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct AbstractValue {
    origin: StorageOrigin,
    truthiness: Truthiness,
    object: Option<ValueId>,
}

impl AbstractValue {
    const UNREACHABLE: Self = Self {
        origin: StorageOrigin::Unreachable,
        truthiness: Truthiness::Unreachable,
        object: None,
    };
    const LOCAL_FALSY: Self = Self {
        origin: StorageOrigin::Local,
        truthiness: Truthiness::Falsy,
        object: None,
    };
    const LOCAL_TRUTHY: Self = Self {
        origin: StorageOrigin::Local,
        truthiness: Truthiness::Truthy,
        object: None,
    };
    const EXTERNAL_UNKNOWN: Self = Self {
        origin: StorageOrigin::External,
        truthiness: Truthiness::Unknown,
        object: None,
    };
    const UNKNOWN: Self = Self {
        origin: StorageOrigin::Unknown,
        truthiness: Truthiness::Unknown,
        object: None,
    };

    fn join(self, other: Self) -> Self {
        Self {
            origin: join_origin(self.origin, other.origin),
            truthiness: join_truthiness(self.truthiness, other.truthiness),
            object: if self.object == other.object {
                self.object
            } else {
                None
            },
        }
    }
}

type AbstractObject = BTreeMap<String, AbstractValue>;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct FlowState {
    locals: Vec<AbstractValue>,
    values: Vec<AbstractValue>,
    objects: BTreeMap<ValueId, AbstractObject>,
}

#[derive(Debug, Clone, Copy)]
struct FinallyRegion {
    body_span: SourceSpan,
    catch_span: Option<SourceSpan>,
    finally: BlockId,
    continuation: BlockId,
}

#[derive(Debug, Clone, Copy)]
struct ExceptionRegion {
    body_span: SourceSpan,
    catch: Option<BlockId>,
}

#[derive(Debug, Clone)]
struct OptionalArgumentPlan {
    start_index: usize,
    written_locals: BTreeSet<fict_hir::LocalId>,
}

impl FlowState {
    fn entry(function: &HirFunction) -> Self {
        let mut state = Self {
            locals: vec![AbstractValue::UNREACHABLE; function.locals.len()],
            values: vec![AbstractValue::UNREACHABLE; function.values.len()],
            objects: BTreeMap::new(),
        };
        for parameter in &function.parameters {
            state.locals[parameter.local.as_usize()] = AbstractValue::EXTERNAL_UNKNOWN;
        }
        state
    }

    fn local(&self, local: fict_hir::LocalId) -> AbstractValue {
        self.locals
            .get(local.as_usize())
            .copied()
            .unwrap_or(AbstractValue::UNKNOWN)
    }

    fn value(&self, value: fict_hir::ValueId) -> AbstractValue {
        self.values
            .get(value.as_usize())
            .copied()
            .unwrap_or(AbstractValue::UNKNOWN)
    }

    fn set_value(&mut self, value: Option<fict_hir::ValueId>, abstract_value: AbstractValue) {
        if let Some(value) = value
            && let Some(slot) = self.values.get_mut(value.as_usize())
        {
            *slot = abstract_value;
        }
    }

    fn place_base(&self, place: &Place) -> AbstractValue {
        match place.base {
            PlaceBase::Local(local) => self.local(local),
            PlaceBase::Value(value) => self.value(value),
            PlaceBase::Global(_) => AbstractValue::EXTERNAL_UNKNOWN,
            PlaceBase::Ssa(_) => AbstractValue::UNKNOWN,
        }
    }

    fn read_place(&self, place: &Place) -> AbstractValue {
        self.read_projections(self.place_base(place), &place.projections)
    }

    fn read_projections(
        &self,
        mut value: AbstractValue,
        projections: &[Projection],
    ) -> AbstractValue {
        for projection in projections {
            value = match value.origin {
                StorageOrigin::Unreachable => AbstractValue::UNREACHABLE,
                StorageOrigin::External => AbstractValue::EXTERNAL_UNKNOWN,
                StorageOrigin::Mixed => AbstractValue {
                    origin: StorageOrigin::Mixed,
                    truthiness: Truthiness::Unknown,
                    object: None,
                },
                StorageOrigin::Unknown => AbstractValue::UNKNOWN,
                StorageOrigin::Local => value
                    .object
                    .and_then(|object| self.objects.get(&object))
                    .and_then(|object| {
                        abstract_property(projection)
                            .and_then(|property| object.get(&property).copied())
                    })
                    .unwrap_or(AbstractValue::UNKNOWN),
            };
        }
        value
    }

    fn write_receiver(&self, place: &Place) -> AbstractValue {
        let Some((_, receiver)) = place.projections.split_last() else {
            return self.place_base(place);
        };
        self.read_projections(self.place_base(place), receiver)
    }

    fn write_projected_property(&mut self, place: &Place, value: AbstractValue) {
        let Some((property, receiver)) = place.projections.split_last() else {
            return;
        };
        let Some(property) = abstract_property(property) else {
            return;
        };
        let receiver = self.read_projections(self.place_base(place), receiver);
        let Some(object) = receiver.object else {
            return;
        };
        if let Some(object) = self.objects.get_mut(&object) {
            object.insert(property, value);
        }
    }

    fn materialize_object(&self, entries: &[ObjectEntry]) -> AbstractObject {
        let mut object = AbstractObject::default();
        for entry in entries {
            match entry {
                ObjectEntry::Property {
                    key,
                    value,
                    kind,
                    prototype_setter,
                    ..
                } => {
                    if *prototype_setter {
                        continue;
                    }
                    let Some(property) = abstract_property_key(key) else {
                        object.clear();
                        continue;
                    };
                    let value =
                        if matches!(kind, ObjectPropertyKind::Init | ObjectPropertyKind::Method) {
                            self.value(*value)
                        } else {
                            AbstractValue::UNKNOWN
                        };
                    object.insert(property, value);
                }
                ObjectEntry::Spread { .. } => object.clear(),
            }
        }
        object
    }

    fn transfer_instruction(&mut self, instruction: &HirInstruction) {
        let result = match &instruction.kind {
            HirInstructionKind::Declare {
                local, initializer, ..
            } => {
                let value =
                    initializer.map_or(AbstractValue::LOCAL_FALSY, |value| self.value(value));
                if let Some(slot) = self.locals.get_mut(local.as_usize()) {
                    *slot = value;
                }
                None
            }
            HirInstructionKind::Read { place } => Some(self.read_place(place)),
            HirInstructionKind::Write { place, value } => {
                let value = self.value(*value);
                if place.projections.is_empty()
                    && let PlaceBase::Local(local) = place.base
                    && let Some(slot) = self.locals.get_mut(local.as_usize())
                {
                    *slot = value;
                } else {
                    self.write_projected_property(place, value);
                }
                Some(value)
            }
            HirInstructionKind::ReadWrite { place, .. } => {
                let mut value = self.read_place(place);
                value.truthiness = Truthiness::Unknown;
                if place.projections.is_empty()
                    && let PlaceBase::Local(local) = place.base
                    && let Some(slot) = self.locals.get_mut(local.as_usize())
                {
                    *slot = value;
                } else if !place.projections.is_empty() {
                    self.write_projected_property(place, AbstractValue::UNKNOWN);
                }
                Some(value)
            }
            HirInstructionKind::Literal(literal) => Some(literal_value(literal)),
            HirInstructionKind::Object { entries } => {
                instruction
                    .result
                    .map_or(Some(AbstractValue::LOCAL_TRUTHY), |result| {
                        self.objects
                            .insert(result, self.materialize_object(entries));
                        Some(AbstractValue {
                            origin: StorageOrigin::Local,
                            truthiness: Truthiness::Truthy,
                            object: Some(result),
                        })
                    })
            }
            HirInstructionKind::Array { .. } | HirInstructionKind::Function { .. } => {
                Some(AbstractValue::LOCAL_TRUTHY)
            }
            HirInstructionKind::Sequence { values } => {
                values.last().map(|value| self.value(*value))
            }
            HirInstructionKind::Conditional {
                consequent,
                alternate,
                ..
            } => Some(self.value(*consequent).join(self.value(*alternate))),
            HirInstructionKind::Unary {
                operator: UnaryOperator::Not,
                argument,
            } => Some(AbstractValue {
                origin: StorageOrigin::Local,
                truthiness: match self.value(*argument).truthiness {
                    Truthiness::Falsy => Truthiness::Truthy,
                    Truthiness::Truthy => Truthiness::Falsy,
                    Truthiness::Unreachable => Truthiness::Unreachable,
                    Truthiness::Unknown => Truthiness::Unknown,
                },
                object: None,
            }),
            HirInstructionKind::Iteration { targets, .. } => {
                for target in targets {
                    if let Some(slot) = self.locals.get_mut(target.as_usize()) {
                        *slot = AbstractValue::UNKNOWN;
                    }
                }
                None
            }
            HirInstructionKind::PatternAssignment { writes, .. } => {
                for write in writes {
                    if let Some(slot) = self.locals.get_mut(write.local.as_usize()) {
                        *slot = AbstractValue::UNKNOWN;
                    }
                }
                Some(AbstractValue::UNKNOWN)
            }
            // A JavaScript constructor may explicitly return an arbitrary object. Until
            // callable effects prove a constructor's return identity, leave it to the
            // conservative legacy classifier instead of claiming a fresh local object.
            HirInstructionKind::New { .. } => Some(AbstractValue::UNKNOWN),
            _ if instruction.result.is_some() => Some(AbstractValue::UNKNOWN),
            _ => None,
        };
        if let Some(result) = result {
            self.set_value(instruction.result, result);
        }
    }
}

pub(super) fn analyze(
    functions: &[HirFunction],
    max_block_state_visits: u32,
) -> StorageOriginResult<StorageOriginFacts> {
    let mut facts = StorageOriginFacts::default();
    let mut visits = 0_u32;
    for function in functions
        .iter()
        .filter(|function| matches!(function.kind, FunctionKind::Component | FunctionKind::Hook))
    {
        analyze_function(
            function,
            &mut facts,
            &mut visits,
            max_block_state_visits.max(1),
        )?;
    }
    Ok(facts)
}

fn analyze_function(
    function: &HirFunction,
    facts: &mut StorageOriginFacts,
    visits: &mut u32,
    max_visits: u32,
) -> StorageOriginResult<()> {
    let finally_regions = finally_regions(function);
    let exception_regions = exception_regions(function);
    let optional_argument_writes = optional_argument_writes(function);
    let mut entries = vec![BTreeSet::<FlowState>::new(); function.blocks.len()];
    let entry = FlowState::entry(function);
    entries[function.entry.as_usize()].insert(entry.clone());
    let mut pending = VecDeque::from([(function.entry, entry)]);

    while let Some((block_id, mut state)) = pending.pop_front() {
        *visits = visits.saturating_add(1);
        if *visits > max_visits {
            return Err(Box::new(budget_diagnostic(*visits, max_visits)));
        }
        let block = &function.blocks[block_id.as_usize()];
        let mut optional_snapshots = BTreeMap::new();
        for (instruction_index, instruction) in block.instructions.iter().enumerate() {
            for ((plan_block, call_index), plan) in &optional_argument_writes {
                if *plan_block == block_id.as_usize() && plan.start_index == instruction_index {
                    optional_snapshots.insert(*call_index, state.clone());
                }
            }
            state.transfer_instruction(instruction);
            if let Some(plan) =
                optional_argument_writes.get(&(block_id.as_usize(), instruction_index))
                && let Some(skipped) = optional_snapshots.get(&instruction_index)
            {
                for local in &plan.written_locals {
                    state.locals[local.as_usize()] =
                        state.locals[local.as_usize()].join(skipped.locals[local.as_usize()]);
                }
            }
            if instruction.semantics.may_throw
                && let Some(catch) = exception_target(function, &exception_regions, block_id)
            {
                let states = &mut entries[catch.as_usize()];
                if states.insert(state.clone()) {
                    pending.push_back((catch, state.clone()));
                }
            }
        }
        for successor in successors(&block.terminator.kind, &state) {
            let transformed =
                abrupt_finally_region(function, &finally_regions, block_id, successor)
                    .map_or_else(
                        || Ok(vec![state.clone()]),
                        |region| {
                            execute_finally(
                                function,
                                &finally_regions,
                                region,
                                state.clone(),
                                visits,
                                max_visits,
                            )
                        },
                    )?;
            for state in transformed {
                let states = &mut entries[successor.as_usize()];
                if states.insert(state.clone()) {
                    pending.push_back((successor, state));
                }
            }
        }
    }

    let mut projected_writes = BTreeMap::<(u32, u32), [bool; 3]>::new();
    for (block_index, states) in entries.iter().enumerate() {
        let block = &function.blocks[block_index];
        for entry in states {
            let mut state = entry.clone();
            let mut optional_snapshots = BTreeMap::new();
            for (instruction_index, instruction) in block.instructions.iter().enumerate() {
                for ((plan_block, call_index), plan) in &optional_argument_writes {
                    if *plan_block == block_index && plan.start_index == instruction_index {
                        optional_snapshots.insert(*call_index, state.clone());
                    }
                }
                if let HirInstructionKind::Write { place, .. } = &instruction.kind
                    && !place.projections.is_empty()
                    && let Some(span) = instruction.origin.primary_span
                {
                    let key = (span.start(), span.end());
                    let summary = projected_writes.entry(key).or_default();
                    match state.write_receiver(place).origin {
                        StorageOrigin::Local => summary[0] = true,
                        StorageOrigin::External | StorageOrigin::Mixed => summary[1] = true,
                        StorageOrigin::Unknown => summary[2] = true,
                        StorageOrigin::Unreachable => {}
                    }
                }
                state.transfer_instruction(instruction);
                if let Some(plan) = optional_argument_writes.get(&(block_index, instruction_index))
                    && let Some(skipped) = optional_snapshots.get(&instruction_index)
                {
                    for local in &plan.written_locals {
                        state.locals[local.as_usize()] =
                            state.locals[local.as_usize()].join(skipped.locals[local.as_usize()]);
                    }
                }
            }
        }
    }
    for (key, summary) in projected_writes {
        if summary[1] {
            facts.classified_projected_writes.insert(key);
            facts.external_projected_writes.insert(key);
        } else if summary[0] && !summary[2] {
            facts.classified_projected_writes.insert(key);
        }
    }
    Ok(())
}

fn optional_argument_writes(
    function: &HirFunction,
) -> BTreeMap<(usize, usize), OptionalArgumentPlan> {
    let mut definitions = vec![None; function.values.len()];
    for (block_index, block) in function.blocks.iter().enumerate() {
        for (instruction_index, instruction) in block.instructions.iter().enumerate() {
            if let Some(result) = instruction.result {
                definitions[result.as_usize()] =
                    Some((block_index, instruction_index, instruction));
            }
        }
    }
    let mut writes = BTreeMap::new();
    for (block_index, block) in function.blocks.iter().enumerate() {
        for (instruction_index, instruction) in block.instructions.iter().enumerate() {
            let HirInstructionKind::Call(call) = &instruction.kind else {
                continue;
            };
            if !call.optional {
                continue;
            }
            let mut locals = BTreeSet::new();
            let mut seen = BTreeSet::new();
            let mut start_index = instruction_index;
            for argument in &call.arguments {
                collect_argument_writes(
                    argument.value,
                    block_index,
                    &definitions,
                    &mut seen,
                    &mut locals,
                    &mut start_index,
                );
            }
            if !locals.is_empty() {
                writes.insert(
                    (block_index, instruction_index),
                    OptionalArgumentPlan {
                        start_index,
                        written_locals: locals,
                    },
                );
            }
        }
    }
    writes
}

fn collect_argument_writes(
    value: fict_hir::ValueId,
    block_index: usize,
    definitions: &[Option<(usize, usize, &HirInstruction)>],
    seen: &mut BTreeSet<fict_hir::ValueId>,
    locals: &mut BTreeSet<fict_hir::LocalId>,
    start_index: &mut usize,
) {
    if !seen.insert(value) {
        return;
    }
    let Some((definition_block, instruction_index, instruction)) =
        definitions.get(value.as_usize()).copied().flatten()
    else {
        return;
    };
    if definition_block == block_index {
        *start_index = (*start_index).min(instruction_index);
    }
    match &instruction.kind {
        HirInstructionKind::Write {
            place,
            value: written,
        } => {
            if place.projections.is_empty()
                && let PlaceBase::Local(local) = place.base
            {
                locals.insert(local);
            }
            collect_argument_writes(
                *written,
                block_index,
                definitions,
                seen,
                locals,
                start_index,
            );
        }
        HirInstructionKind::Sequence { values } => {
            for value in values {
                collect_argument_writes(
                    *value,
                    block_index,
                    definitions,
                    seen,
                    locals,
                    start_index,
                );
            }
        }
        HirInstructionKind::Conditional {
            test,
            consequent,
            alternate,
        } => {
            for value in [test, consequent, alternate] {
                collect_argument_writes(
                    *value,
                    block_index,
                    definitions,
                    seen,
                    locals,
                    start_index,
                );
            }
        }
        _ => {}
    }
}

fn successors(terminator: &TerminatorKind, state: &FlowState) -> Vec<BlockId> {
    match terminator {
        TerminatorKind::Return { .. }
        | TerminatorKind::Throw { .. }
        | TerminatorKind::Unreachable => Vec::new(),
        TerminatorKind::Goto { target } => vec![*target],
        TerminatorKind::Branch {
            test,
            consequent,
            alternate,
        } => match state.value(*test).truthiness {
            Truthiness::Truthy => vec![*consequent],
            Truthiness::Falsy => vec![*alternate],
            Truthiness::Unreachable => Vec::new(),
            Truthiness::Unknown => vec![*consequent, *alternate],
        },
        TerminatorKind::ForIn { body, exit, .. } | TerminatorKind::ForOf { body, exit, .. } => {
            vec![*body, *exit]
        }
        TerminatorKind::Switch { cases, .. } => cases.iter().map(|case| case.target).collect(),
        TerminatorKind::Try { body, .. } => vec![*body],
    }
}

fn exception_regions(function: &HirFunction) -> Vec<ExceptionRegion> {
    function
        .blocks
        .iter()
        .filter_map(|block| {
            let TerminatorKind::Try { body, catch, .. } = block.terminator.kind else {
                return None;
            };
            Some(ExceptionRegion {
                body_span: function.blocks[body.as_usize()].origin.primary_span?,
                catch,
            })
        })
        .collect()
}

fn exception_target(
    function: &HirFunction,
    regions: &[ExceptionRegion],
    source: BlockId,
) -> Option<BlockId> {
    let source_span = function.blocks[source.as_usize()].origin.primary_span?;
    regions
        .iter()
        .filter(|region| span_contains(region.body_span, source_span))
        .min_by_key(|region| {
            region
                .body_span
                .end()
                .saturating_sub(region.body_span.start())
        })
        .and_then(|region| region.catch)
}

fn finally_regions(function: &HirFunction) -> Vec<FinallyRegion> {
    function
        .blocks
        .iter()
        .filter_map(|block| {
            let TerminatorKind::Try {
                body,
                catch,
                finally: Some(finally),
                continuation,
            } = block.terminator.kind
            else {
                return None;
            };
            Some(FinallyRegion {
                body_span: function.blocks[body.as_usize()].origin.primary_span?,
                catch_span: catch
                    .and_then(|catch| function.blocks[catch.as_usize()].origin.primary_span),
                finally,
                continuation,
            })
        })
        .collect()
}

fn abrupt_finally_region(
    function: &HirFunction,
    regions: &[FinallyRegion],
    source: BlockId,
    target: BlockId,
) -> Option<FinallyRegion> {
    let source_span = function.blocks[source.as_usize()].origin.primary_span?;
    let target_span = function.blocks[target.as_usize()].origin.primary_span;
    regions
        .iter()
        .copied()
        .filter(|region| {
            let source_is_protected = span_contains(region.body_span, source_span)
                || region
                    .catch_span
                    .is_some_and(|catch| span_contains(catch, source_span));
            let target_is_protected = target_span.is_some_and(|target| {
                span_contains(region.body_span, target)
                    || region
                        .catch_span
                        .is_some_and(|catch| span_contains(catch, target))
            });
            source_is_protected && !target_is_protected && target != region.finally
        })
        .min_by_key(|region| {
            region
                .body_span
                .end()
                .saturating_sub(region.body_span.start())
        })
}

fn execute_finally(
    function: &HirFunction,
    regions: &[FinallyRegion],
    region: FinallyRegion,
    entry: FlowState,
    visits: &mut u32,
    max_visits: u32,
) -> StorageOriginResult<Vec<FlowState>> {
    let mut completed = BTreeSet::new();
    let mut seen = BTreeSet::new();
    let mut pending = VecDeque::from([(region.finally, entry)]);
    while let Some((block_id, mut state)) = pending.pop_front() {
        if !seen.insert((block_id, state.clone())) {
            continue;
        }
        *visits = visits.saturating_add(1);
        if *visits > max_visits {
            return Err(Box::new(budget_diagnostic(*visits, max_visits)));
        }
        let block = &function.blocks[block_id.as_usize()];
        for instruction in &block.instructions {
            state.transfer_instruction(instruction);
        }
        for successor in successors(&block.terminator.kind, &state) {
            if successor == region.continuation {
                completed.insert(state.clone());
                continue;
            }
            if let Some(nested) = abrupt_finally_region(function, regions, block_id, successor) {
                for state in
                    execute_finally(function, regions, nested, state.clone(), visits, max_visits)?
                {
                    pending.push_back((successor, state));
                }
            } else {
                pending.push_back((successor, state.clone()));
            }
        }
    }
    Ok(completed.into_iter().collect())
}

fn span_contains(container: SourceSpan, candidate: SourceSpan) -> bool {
    container.start() <= candidate.start() && container.end() >= candidate.end()
}

fn literal_value(literal: &LiteralValue) -> AbstractValue {
    match literal {
        LiteralValue::Null | LiteralValue::Undefined => AbstractValue::LOCAL_FALSY,
        LiteralValue::Boolean(value) => {
            if *value {
                AbstractValue::LOCAL_TRUTHY
            } else {
                AbstractValue::LOCAL_FALSY
            }
        }
        LiteralValue::Number(value) => {
            let value = value.to_f64();
            if value == 0.0 || value.is_nan() {
                AbstractValue::LOCAL_FALSY
            } else {
                AbstractValue::LOCAL_TRUTHY
            }
        }
        LiteralValue::BigInt(value) => {
            if value
                .trim_start_matches('-')
                .trim_start_matches('0')
                .is_empty()
            {
                AbstractValue::LOCAL_FALSY
            } else {
                AbstractValue::LOCAL_TRUTHY
            }
        }
        LiteralValue::String(value) => {
            if value.is_empty() {
                AbstractValue::LOCAL_FALSY
            } else {
                AbstractValue::LOCAL_TRUTHY
            }
        }
        LiteralValue::RegExp { .. } => AbstractValue::LOCAL_TRUTHY,
    }
}

fn abstract_property(projection: &Projection) -> Option<String> {
    match projection {
        Projection::StaticProperty { name, .. } => Some(name.to_string()),
        Projection::Index { index, .. } => Some(index.to_string()),
        Projection::ComputedProperty { .. } => None,
    }
}

fn abstract_property_key(key: &PropertyKey) -> Option<String> {
    match key {
        PropertyKey::Static(name) => Some(name.clone()),
        PropertyKey::Index(index) => Some(index.to_string()),
        PropertyKey::Computed(_) => None,
    }
}

fn join_origin(left: StorageOrigin, right: StorageOrigin) -> StorageOrigin {
    use StorageOrigin::{External, Local, Mixed, Unknown, Unreachable};
    match (left, right) {
        (Unreachable, value) | (value, Unreachable) => value,
        (left, right) if left == right => left,
        (Unknown, _) | (_, Unknown) => Unknown,
        (Mixed, _) | (_, Mixed) | (Local, External) | (External, Local) => Mixed,
        _ => Unknown,
    }
}

fn join_truthiness(left: Truthiness, right: Truthiness) -> Truthiness {
    match (left, right) {
        (Truthiness::Unreachable, value) | (value, Truthiness::Unreachable) => value,
        (left, right) if left == right => left,
        _ => Truthiness::Unknown,
    }
}

fn budget_diagnostic(visits: u32, budget: u32) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new("FICT-PASS-BUDGET").expect("storage origin budget diagnostic literal"),
        DiagnosticSeverity::Error,
        format!(
            "storage origin analysis exceeded its configured worklist budget: {visits}/{budget} block-state visits"
        ),
    )
    .with_guarantee_class(GuaranteeClass::Internal)
}
