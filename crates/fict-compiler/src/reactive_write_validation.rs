use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use fict_hir::{
    BindingId, BlockId, DeclarationKind, DeleteTarget, FunctionId, HirFile, HirFunction,
    HirInstructionKind, LocalId, LocalKind, Origin, Place, PlaceBase, Projection, SsaName,
    StateMethodCallSemantics, ValueId, ValueKind, classify_state_method_call,
};
use fict_reactivity::{DependencyBase, ReactiveBindingKind, SsaDefinitionLocation};

use crate::pass_manager::FunctionPassAnalysis;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum ReadonlyKind {
    Alias,
    Derived,
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

struct WriteValidationContext<'a> {
    analyses: &'a [FunctionPassAnalysis],
    readonly_names: &'a [BTreeSet<SsaName>],
    readonly_bindings: &'a BTreeMap<BindingId, ReadonlySite>,
    strict_guarantee: bool,
}

pub(crate) fn validate_reactive_writes(
    hir: &HirFile,
    analyses: &[FunctionPassAnalysis],
    strict_guarantee: bool,
) -> Result<DiagnosticBundle, DiagnosticBundle> {
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

    let mut state_provenance_names = vec![BTreeSet::new(); hir.functions.len()];
    let mut readonly_sites = vec![BTreeMap::new(); hir.functions.len()];
    let mut state_bindings = BTreeSet::new();

    for analysis in analyses {
        let function_index = analysis.function.as_usize();
        let Some(function) = hir.functions.get(function_index) else {
            continue;
        };
        for fact in &analysis.scopes.bindings {
            if fact.kind == ReactiveBindingKind::State {
                state_provenance_names[function_index].insert(fact.name);
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

    // Component parameters and other reactive inputs remain mutable snapshots when copied into
    // a local. Only definitions transitively rooted in state carry this read-only contract.
    loop {
        let previous = state_provenance_names.clone();
        let mut changed = false;
        for analysis in analyses {
            let function_index = analysis.function.as_usize();
            for fact in &analysis.scopes.bindings {
                let depends_on_state = fact.dependencies.iter().any(|path| {
                    matches!(path.base, DependencyBase::Ssa(source)
                        if name_resolves_to_set(source, &previous[function_index]))
                }) || analysis
                    .ssa
                    .phis
                    .iter()
                    .find(|phi| phi.target == fact.name)
                    .is_some_and(|phi| {
                        phi.sources.iter().any(|(_, source)| {
                            name_resolves_to_set(*source, &previous[function_index])
                        })
                    });
                if depends_on_state {
                    changed |= state_provenance_names[function_index].insert(fact.name);
                }
            }
        }
        if !changed {
            break;
        }
    }

    for analysis in analyses {
        let function_index = analysis.function.as_usize();
        let function = &hir.functions[function_index];
        for fact in &analysis.scopes.bindings {
            if !state_provenance_names[function_index].contains(&fact.name) {
                continue;
            }
            let kind = match fact.kind {
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
    // iterate so nested and multi-hop destructuring remains binding-aware.
    loop {
        let previous = state_provenance_names.clone();
        let mut changed = false;
        for analysis in analyses {
            let function_index = analysis.function.as_usize();
            let function = &hir.functions[function_index];
            for block in &function.blocks {
                for (instruction_index, instruction) in block.instructions.iter().enumerate() {
                    let instruction_index = count_u32(instruction_index);
                    match &instruction.kind {
                        HirInstructionKind::Declare {
                            local,
                            initializer: Some(initializer),
                            ..
                        } if is_pattern_binding_declaration(
                            hir,
                            function,
                            *local,
                            *initializer,
                        ) && value_depends_on_reactive(
                            analysis,
                            *initializer,
                            &previous[function_index],
                        ) =>
                        {
                            if let Some(name) =
                                definition_at(analysis, block.id, instruction_index, *local)
                            {
                                changed |= state_provenance_names[function_index].insert(name);
                                readonly_sites[function_index].insert(
                                    name,
                                    ReadonlySite {
                                        kind: ReadonlyKind::Alias,
                                        origin: function.locals[local.as_usize()].origin,
                                    },
                                );
                            }
                        }
                        HirInstructionKind::PatternAssignment { value, writes, .. }
                            if value_depends_on_reactive(
                                analysis,
                                *value,
                                &previous[function_index],
                            ) =>
                        {
                            for write in writes {
                                if let Some(name) = definition_at(
                                    analysis,
                                    block.id,
                                    instruction_index,
                                    write.local,
                                ) {
                                    changed |= state_provenance_names[function_index].insert(name);
                                    readonly_sites[function_index].insert(
                                        name,
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
        if !changed {
            break;
        }
    }

    let mut readonly_names = readonly_sites
        .iter()
        .map(|sites| sites.keys().copied().collect::<BTreeSet<_>>())
        .collect::<Vec<_>>();
    loop {
        let mut changed = false;
        for analysis in analyses {
            let names = &mut readonly_names[analysis.function.as_usize()];
            for phi in &analysis.ssa.phis {
                if phi.sources.iter().any(|(_, source)| names.contains(source)) {
                    changed |= names.insert(phi.target);
                }
            }
        }
        if !changed {
            break;
        }
    }
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
        analyses,
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
                        if let Some(local) = place_root_local(place) {
                            validation.validate_local_write(
                                function,
                                WriteLocation {
                                    function: function.id,
                                    block: block.id,
                                    instruction: instruction_index,
                                    local,
                                },
                                instruction.origin,
                                place.projections.is_empty(),
                                &mut diagnostics,
                            );
                        }
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
                                true,
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
                                true,
                                &mut diagnostics,
                            );
                        }
                    }
                    HirInstructionKind::Delete {
                        target: DeleteTarget::Place(place),
                    } => {
                        if let Some(local) = place_root_local(place) {
                            validation.validate_local_write(
                                function,
                                WriteLocation {
                                    function: function.id,
                                    block: block.id,
                                    instruction: instruction_index,
                                    local,
                                },
                                instruction.origin,
                                false,
                                &mut diagnostics,
                            );
                        }
                    }
                    HirInstructionKind::Call(call)
                        if call
                            .callee_reference
                            .as_ref()
                            .is_some_and(state_method_call_may_mutate) =>
                    {
                        let place = call
                            .callee_reference
                            .as_ref()
                            .expect("guarded method reference");
                        if let Some(local) = place_root_local(place) {
                            validation.validate_local_write(
                                function,
                                WriteLocation {
                                    function: function.id,
                                    block: block.id,
                                    instruction: instruction_index,
                                    local,
                                },
                                instruction.origin,
                                false,
                                &mut diagnostics,
                            );
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    if diagnostics.has_errors() {
        Err(diagnostics)
    } else {
        Ok(diagnostics)
    }
}

impl WriteValidationContext<'_> {
    fn validate_local_write(
        &self,
        function: &HirFunction,
        location: WriteLocation,
        write_origin: Origin,
        direct_write: bool,
        diagnostics: &mut DiagnosticBundle,
    ) {
        let Some(local_fact) = function.locals.get(location.local.as_usize()) else {
            return;
        };
        let Some(binding) = local_fact.binding else {
            return;
        };
        let Some(site) = self.readonly_bindings.get(&binding).copied() else {
            return;
        };
        if !self.binding_is_readonly_at(location, binding, local_fact.kind == LocalKind::Capture) {
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
        let (mut diagnostic, label) = if direct_write {
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
                "reactive alias is established here",
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

    fn binding_is_readonly_at(
        &self,
        location: WriteLocation,
        binding: BindingId,
        captured: bool,
    ) -> bool {
        if captured {
            return true;
        }
        let Some(analysis) = self.analyses.get(location.function.as_usize()) else {
            return false;
        };
        let Some(previous) = ssa_name_before(analysis, location) else {
            return false;
        };
        if self
            .readonly_names
            .get(location.function.as_usize())
            .is_some_and(|names| names.contains(&previous))
        {
            return true;
        }
        self.readonly_bindings.contains_key(&binding)
            && analysis.ssa.definitions.iter().any(|definition| {
                definition.name == previous && definition.location == SsaDefinitionLocation::Entry
            })
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
    names.contains(&name) || names.iter().any(|candidate| candidate.local == name.local)
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

fn select_earlier_site(current: &mut ReadonlySite, candidate: ReadonlySite) {
    let current_start = current
        .origin
        .primary_span
        .map_or(u32::MAX, SourceSpan::start);
    let candidate_start = candidate
        .origin
        .primary_span
        .map_or(u32::MAX, SourceSpan::start);
    if candidate_start < current_start
        || (candidate_start == current_start && candidate.kind < current.kind)
    {
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

fn state_method_call_may_mutate(place: &Place) -> bool {
    let Some(method) = place.projections.last() else {
        return false;
    };
    !matches!(
        method,
        Projection::StaticProperty { name, .. }
            if classify_state_method_call(name) == StateMethodCallSemantics::ReadOnlyReceiver
    )
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
