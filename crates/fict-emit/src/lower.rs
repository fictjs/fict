use crate::{
    CleanupOwner, ComponentChild, ComponentProp, ComponentTarget, ConditionalKind,
    DELEGATED_EVENTS, DomBindingKind, DomNamespace, DomTextSegment, EmitContext, EmitFunction,
    EmitModulePlan, EmitOperation, EmitProgram, EmitPropBinding, EmitPropCheck, EmitPropMode,
    EmitPropsDefault, EmitPropsPlan, EmitPropsRest, EmitSlotId, EmitTemporary, EmitTemporaryId,
    EmitValueRef, EventOptions, PropsOperation, ReactivePatternTarget, ReactiveSlot,
    ReactiveSlotKind, ReactiveSlotStorage, RuntimeFamily, RuntimeHelper, RuntimeImportIntent,
    name_allocator::NameAllocator, verify_emit_program,
};
use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_hir::{
    ArrayElement, BindingId, BlockId, CallHost, DeleteTarget, FictMacroKind, FunctionId,
    FunctionKind, HirFile, HirFunction, HirInstruction, HirInstructionKind,
    ImportedHookPropertyMatch, ImportedHookReturn, ImportedName, ImportedReactiveKind,
    JsxAttribute, JsxAttributeValue, JsxChild, JsxElementName, JsxExpressionKind,
    JsxListExpression, JsxListReceiver, JsxNode, LocalId, LocalKind, ObjectEntry,
    ObjectPropertyKind, Origin, PlaceBase, ReactiveCallKind, TemplateId, TerminatorKind, ValueId,
    ValueKind,
};
use fict_reactivity::{
    ReactiveBindingKind, ReactiveCycleAnalysis, ReactiveScopeAnalysis, RegionAnalysis,
    SsaDefinitionLocation, analyze_cfg, structurize_cfg,
};
use std::collections::{BTreeMap, BTreeSet};
/// Phase-1 Core lowering configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoJsxLoweringOptions {
    /// Runtime package/import family.
    pub runtime_family: RuntimeFamily,
    /// Reject non-guaranteed control-flow fallback; derived SCCs are always rejected.
    pub strict_guarantee: bool,
    /// Allow Preview ABI helpers (none are emitted by this phase).
    pub preview: bool,
    /// Emit fine-grained DOM operations instead of the complete VNode fallback.
    pub fine_grained_dom: bool,
}
impl Default for NoJsxLoweringOptions {
    fn default() -> Self {
        Self {
            runtime_family: RuntimeFamily::Fict,
            strict_guarantee: true,
            preview: false,
            fine_grained_dom: true,
        }
    }
}
#[derive(Debug, Clone, Copy)]
struct ReactiveSite {
    result: ValueId,
    local: Option<LocalId>,
    kind: ReactiveSiteKind,
    slot: EmitSlotId,
}
#[derive(Debug, Clone, Copy)]
struct HookReturnSite {
    result: ValueId,
    local: Option<LocalId>,
    import: BindingId,
    kind: ReactiveSlotKind,
    origin: Origin,
    slot: EmitSlotId,
}
#[derive(Debug, Clone, Copy)]
struct HookMemberSite {
    call: ValueId,
    local: Option<LocalId>,
    import: BindingId,
    property: ImportedHookPropertyMatch,
    kind: ReactiveSlotKind,
    origin: Origin,
    slot: EmitSlotId,
}
#[derive(Debug, Clone)]
struct StructuredHookRootSite {
    owner: FunctionId,
    local: LocalId,
    binding: BindingId,
    call: ValueId,
    import: BindingId,
    shape: ImportedHookReturn,
    origin: Origin,
}
#[derive(Debug, Clone, Copy)]
struct CapturedHookMemberSite {
    local: LocalId,
    binding: BindingId,
    owner: FunctionId,
    call: ValueId,
    import: BindingId,
    property: ImportedHookPropertyMatch,
    kind: ReactiveSlotKind,
    origin: Origin,
    slot: EmitSlotId,
}
#[derive(Debug, Clone, Copy)]
struct ReactiveBindingSite {
    owner: FunctionId,
    binding: BindingId,
    kind: ReactiveSlotKind,
    origin: Origin,
}
#[derive(Debug, Clone, Copy)]
struct CrossFunctionFacts<'a> {
    captured_write_bindings: &'a BTreeSet<BindingId>,
    reactive_bindings: &'a BTreeMap<BindingId, ReactiveBindingSite>,
    structured_hook_roots: &'a BTreeMap<BindingId, StructuredHookRootSite>,
    structured_hook_members: &'a BTreeMap<(BindingId, ImportedHookPropertyMatch), Origin>,
    list_item_bindings: &'a BTreeSet<BindingId>,
    jsx_getter_bindings: &'a BTreeSet<BindingId>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReactiveSiteKind {
    Macro(FictMacroKind),
    Runtime(ReactiveCallKind),
}
/// Lower state/memo/effect and reactive reads/writes while preserving ordinary HIR.
pub fn lower_no_jsx(
    hir: &HirFile,
    regions: &[RegionAnalysis],
    cycles: &[ReactiveCycleAnalysis],
    scopes: Option<&[ReactiveScopeAnalysis]>,
    options: NoJsxLoweringOptions,
) -> Result<EmitProgram, DiagnosticBundle> {
    lower_program(hir, regions, cycles, scopes, options, false)
}
/// Lower Core intrinsic JSX in addition to no-JSX reactivity.
pub fn lower_core(
    hir: &HirFile,
    regions: &[RegionAnalysis],
    cycles: &[ReactiveCycleAnalysis],
    scopes: Option<&[ReactiveScopeAnalysis]>,
    options: NoJsxLoweringOptions,
) -> Result<EmitProgram, DiagnosticBundle> {
    lower_program(hir, regions, cycles, scopes, options, true)
}
fn lower_program(
    hir: &HirFile,
    regions: &[RegionAnalysis],
    cycles: &[ReactiveCycleAnalysis],
    scopes: Option<&[ReactiveScopeAnalysis]>,
    options: NoJsxLoweringOptions,
    allow_jsx: bool,
) -> Result<EmitProgram, DiagnosticBundle> {
    if regions.len() != hir.functions.len()
        || cycles.len() != hir.functions.len()
        || scopes.is_some_and(|scopes| scopes.len() != hir.functions.len())
    {
        return Err(DiagnosticBundle::new(vec![lower_error(
            "FICT-EMIT-ANALYSIS",
            "lowering requires final region, cycle, and supplied scope analysis for every function",
            GuaranteeClass::Internal,
        )]));
    }
    if let Some(cycle) = cycles.iter().flat_map(|analysis| &analysis.cycles).next() {
        return Err(DiagnosticBundle::new(vec![lower_error(
            "FICT-R-CYCLE",
            format!(
                "detected cyclic derived dependency across {} binding(s)",
                cycle.nodes.len()
            ),
            GuaranteeClass::Unsupported,
        )]));
    }
    let captured_write_bindings = collect_captured_write_bindings(hir);
    let reactive_bindings = collect_reactive_binding_sites(hir, scopes, &captured_write_bindings)?;
    let structured_hook_roots = collect_structured_hook_root_sites(hir)?;
    let structured_hook_members = collect_structured_hook_member_uses(hir, &structured_hook_roots);
    let list_item_bindings = hir.jsx_list_item_bindings();
    let mut jsx_getter_bindings = list_item_bindings.clone();
    jsx_getter_bindings.extend(reactive_bindings.keys().copied());
    for (function, analysis) in hir.functions.iter().zip(scopes.into_iter().flatten()) {
        jsx_getter_bindings.extend(
            analysis
                .bindings
                .iter()
                .filter_map(|fact| function.locals[fact.name.local.as_usize()].binding),
        );
    }
    let facts = CrossFunctionFacts {
        captured_write_bindings: &captured_write_bindings,
        reactive_bindings: &reactive_bindings,
        structured_hook_roots: &structured_hook_roots,
        structured_hook_members: &structured_hook_members,
        list_item_bindings: &list_item_bindings,
        jsx_getter_bindings: &jsx_getter_bindings,
    };
    let mut functions = Vec::with_capacity(hir.functions.len());
    for (function_index, function) in hir.functions.iter().enumerate() {
        if !allow_jsx
            && let Some(instruction) = function
                .blocks
                .iter()
                .flat_map(|block| &block.instructions)
                .find(|instruction| matches!(instruction.kind, HirInstructionKind::Jsx { .. }))
        {
            let mut diagnostic = lower_error(
                "FICT-EMIT-JSX-STAGE",
                "JSX reached the no-JSX lowering phase",
                GuaranteeClass::Internal,
            );
            diagnostic.primary_span = instruction.origin.primary_span;
            return Err(DiagnosticBundle::new(vec![diagnostic]));
        }
        functions.push(lower_function(
            hir,
            FunctionId::new(count_u32(function_index)),
            &regions[function_index],
            scopes.map(|scopes| &scopes[function_index]),
            &facts,
            allow_jsx,
            options.fine_grained_dom,
        )?);
    }
    let helpers: BTreeSet<_> = functions
        .iter()
        .flat_map(|function| {
            function
                .operations
                .iter()
                .flat_map(|operation| operation.helper_slots().into_iter().flatten())
                .chain(function.context.iter().map(|context| context.helper))
                .chain(function.props.iter().filter_map(|props| props.helper))
                .chain(
                    function
                        .props
                        .iter()
                        .filter_map(|props| props.rest.as_ref().map(|rest| rest.helper)),
                )
        })
        .collect();
    if options.strict_guarantee
        && functions
            .iter()
            .any(|function| function.control_flow.fallback.is_some())
    {
        return Err(DiagnosticBundle::new(vec![lower_error(
            "FICT-R-CONTROL-FALLBACK",
            "irreducible control flow requires state-machine fallback",
            GuaranteeClass::Fallback,
        )]));
    }
    let source_names = hir
        .bindings
        .iter()
        .map(|binding| binding.display_name.clone())
        .chain(hir.functions.iter().flat_map(|function| {
            function
                .locals
                .iter()
                .filter_map(|local| local.debug_name.clone())
        }))
        .chain(
            functions
                .iter()
                .flat_map(|function| function.temporaries.iter().map(|temp| temp.name.clone())),
        )
        .chain(functions.iter().flat_map(|function| {
            function
                .operations
                .iter()
                .filter_map(|operation| match operation {
                    EmitOperation::DeclareTemplate { local, .. } => Some(local.clone()),
                    EmitOperation::KeyedChild { render_key, .. } => Some(render_key.clone()),
                    _ => None,
                })
        }))
        .chain(functions.iter().filter_map(|function| {
            function
                .context
                .as_ref()
                .map(|context| context.local.clone())
        }))
        .chain(
            functions
                .iter()
                .filter_map(|function| function.props.as_ref().map(|props| props.source.clone())),
        )
        .chain(functions.iter().flat_map(|function| {
            function.props.iter().flat_map(|props| {
                props
                    .bindings
                    .iter()
                    .filter_map(|binding| binding.default_local.clone())
            })
        }))
        .chain(functions.iter().filter_map(|function| {
            function
                .props
                .as_ref()
                .and_then(|props| props.default.as_ref())
                .map(|default| default.input.clone())
        }))
        .chain(functions.iter().flat_map(|function| {
            function.props.iter().flat_map(|props| {
                props
                    .bindings
                    .iter()
                    .flat_map(|binding| binding.checks.iter().map(|check| check.local.clone()))
            })
        }));
    let mut module_names = NameAllocator::new(source_names);
    let imports = helpers
        .into_iter()
        .map(|helper| {
            let spec = helper.spec();
            RuntimeImportIntent {
                helper,
                module_request: spec.module_request(options.runtime_family).to_owned(),
                imported: spec.export.to_owned(),
                local: module_names.allocate(spec.preferred_local),
            }
        })
        .collect();
    let program = EmitProgram {
        runtime_family: options.runtime_family,
        preview: options.preview,
        preview_plan: None,
        strict_rejected: false,
        module: EmitModulePlan {
            source_fragment: module_source_fragment(hir),
            reserved_names: module_names.names(),
        },
        imports,
        functions,
    };
    verify_emit_program(hir, regions, &program)?;
    Ok(program)
}
fn module_source_fragment(hir: &HirFile) -> Option<fict_hir::SyntaxFragmentId> {
    hir.functions
        .get(hir.root_function.as_usize())?
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .rev()
        .find_map(|instruction| match instruction.kind {
            HirInstructionKind::SyntaxFragment { fragment, .. } if instruction.result.is_none() => {
                Some(fragment)
            }
            _ => None,
        })
}
fn declaration_initializer(
    function: &HirFunction,
    instruction: &HirInstruction,
) -> Option<(ValueId, LocalId)> {
    match &instruction.kind {
        HirInstructionKind::Declare {
            local,
            initializer: Some(value),
            ..
        } => Some((*value, *local)),
        HirInstructionKind::Write { place, value } if place.projections.is_empty() => {
            let PlaceBase::Local(local) = &place.base else {
                return None;
            };
            let storage = function.locals.get(local.as_usize())?;
            if storage.declaration_kind != fict_hir::DeclarationKind::Var {
                return None;
            }
            let write = instruction.origin.primary_span?;
            let declaration = storage.origin.primary_span?;
            (write.start() <= declaration.start() && declaration.end() <= write.end())
                .then_some((*value, *local))
        }
        _ => None,
    }
}
fn derived_declarations(
    hir: &HirFile,
    function: &HirFunction,
    scopes: Option<&ReactiveScopeAnalysis>,
    captured_write_bindings: &BTreeSet<BindingId>,
) -> Vec<(ValueId, LocalId, Origin)> {
    use HirInstructionKind as K;
    use ReactiveBindingKind::{Alias, Derived};
    let Some(scopes) = scopes else {
        return Vec::new();
    };
    if !matches!(
        function.kind,
        FunctionKind::Component | FunctionKind::Hook | FunctionKind::ReactiveScope
    ) {
        return Vec::new();
    }
    let reassigned = reassigned_locals(function);
    let mut declarations = BTreeMap::new();
    for (local, site) in scopes.bindings.iter().filter_map(|fact| {
        let local = &function.locals[fact.name.local.as_usize()];
        if !matches!(fact.kind, Alias | Derived)
            || reassigned.contains(&fact.name.local)
            || local
                .binding
                .is_some_and(|binding| captured_write_bindings.contains(&binding))
        {
            return None;
        }
        let SsaDefinitionLocation::Instruction { block, instruction } = fact.location else {
            return None;
        };
        let source = &function.blocks[block.as_usize()].instructions[instruction as usize];
        let (result, local) = declaration_initializer(function, source)?;
        if function
            .instruction_for_result(result)
            .is_some_and(|instruction| {
                matches!(
                    instruction.kind,
                    K::Write { .. }
                        | K::ReadWrite { .. }
                        | K::PatternAssignment { .. }
                        | K::Iteration { .. }
                        | K::Delete { .. }
                        | K::Await { .. }
                        | K::Yield { .. }
                ) || matches!(
                    instruction.kind,
                    K::SyntaxFragment { fragment, .. }
                        if hir.syntax_fragments
                            .get(fragment.as_usize())
                            .and_then(|fragment| fragment.summary.pattern.as_ref())
                            .is_some_and(|pattern| pattern.has_defaults)
                )
            })
        {
            return None;
        }
        let origin = function.values[result.as_usize()].origin;
        (local == fact.name.local && origin.primary_span.is_some())
            .then_some((local, (result, local, origin)))
    }) {
        declarations
            .entry(local)
            .and_modify(|site| *site = None)
            .or_insert(Some(site));
    }
    declarations.into_values().flatten().collect()
}
fn insert_reactive_binding_site(
    sites: &mut BTreeMap<BindingId, ReactiveBindingSite>,
    site: ReactiveBindingSite,
) -> Result<(), DiagnosticBundle> {
    if sites.insert(site.binding, site).is_some() {
        return Err(DiagnosticBundle::new(vec![lower_error(
            "FICT-EMIT-REACTIVE-BINDING",
            "one semantic binding cannot own multiple reactive creation sites",
            GuaranteeClass::Internal,
        )]));
    }
    Ok(())
}
fn collect_reactive_binding_sites(
    hir: &HirFile,
    scopes: Option<&[ReactiveScopeAnalysis]>,
    captured_write_bindings: &BTreeSet<BindingId>,
) -> Result<BTreeMap<BindingId, ReactiveBindingSite>, DiagnosticBundle> {
    let mut sites = BTreeMap::new();
    for (function_index, function) in hir.functions.iter().enumerate() {
        let owner = FunctionId::new(count_u32(function_index));
        let declarations: BTreeMap<_, _> = function
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .filter_map(|instruction| {
                let (initializer, local) = declaration_initializer(function, instruction)?;
                function.locals[local.as_usize()]
                    .binding
                    .map(|binding| (initializer, binding))
            })
            .collect();
        for instruction in function.blocks.iter().flat_map(|block| &block.instructions) {
            let HirInstructionKind::Call(call) = &instruction.kind else {
                continue;
            };
            let slot_kind = match (call.macro_kind, call.reactive_kind) {
                (Some(FictMacroKind::State), _) => ReactiveSlotKind::Signal,
                (Some(FictMacroKind::Memo), _) => ReactiveSlotKind::Memo,
                (Some(FictMacroKind::Effect), _) => continue,
                (None, Some(ReactiveCallKind::Memo)) => ReactiveSlotKind::Memo,
                (None, Some(ReactiveCallKind::Store)) => ReactiveSlotKind::Store,
                (None, Some(ReactiveCallKind::Resource)) => ReactiveSlotKind::Resource,
                (None, Some(ReactiveCallKind::Selector)) => ReactiveSlotKind::Selector,
                (None, None) => match imported_hook_direct(hir, call).map(|(_, kind)| kind) {
                    Some(ImportedReactiveKind::Signal) => ReactiveSlotKind::Signal,
                    Some(ImportedReactiveKind::Memo) => ReactiveSlotKind::Memo,
                    Some(ImportedReactiveKind::Store) | None => continue,
                },
            };
            let Some(binding) = instruction
                .result
                .and_then(|result| declarations.get(&result).copied())
            else {
                continue;
            };
            insert_reactive_binding_site(
                &mut sites,
                ReactiveBindingSite {
                    owner,
                    binding,
                    kind: slot_kind,
                    origin: instruction.origin,
                },
            )?;
        }
        if let Some(scopes) = scopes {
            for (_, local, origin) in derived_declarations(
                hir,
                function,
                Some(&scopes[function_index]),
                captured_write_bindings,
            ) {
                let Some(binding) = function.locals[local.as_usize()].binding else {
                    continue;
                };
                insert_reactive_binding_site(
                    &mut sites,
                    ReactiveBindingSite {
                        owner,
                        binding,
                        kind: ReactiveSlotKind::Memo,
                        origin,
                    },
                )?;
            }
        }
    }
    Ok(sites)
}
fn collect_structured_hook_root_sites(
    hir: &HirFile,
) -> Result<BTreeMap<BindingId, StructuredHookRootSite>, DiagnosticBundle> {
    let mut sites = BTreeMap::new();
    for (function_index, function) in hir.functions.iter().enumerate() {
        let owner = FunctionId::new(count_u32(function_index));
        let declarations: BTreeMap<_, _> = function
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .filter_map(|instruction| declaration_initializer(function, instruction))
            .collect();
        let reassigned = reassigned_locals(function);
        for instruction in function.blocks.iter().flat_map(|block| &block.instructions) {
            let HirInstructionKind::Call(call) = &instruction.kind else {
                continue;
            };
            let Some(result) = instruction.result else {
                continue;
            };
            let Some((import, shape)) = imported_hook_return(hir, call) else {
                continue;
            };
            if shape.direct_accessor.is_some()
                || (shape.object_properties.is_empty() && shape.array_properties.is_empty())
            {
                continue;
            }
            let Some(local) = declarations.get(&result).copied() else {
                continue;
            };
            if reassigned.contains(&local) {
                continue;
            }
            let Some(binding) = function
                .locals
                .get(local.as_usize())
                .and_then(|local| local.binding)
            else {
                continue;
            };
            if sites
                .insert(
                    binding,
                    StructuredHookRootSite {
                        owner,
                        local,
                        binding,
                        call: result,
                        import,
                        shape: shape.clone(),
                        origin: instruction.origin,
                    },
                )
                .is_some()
            {
                return Err(DiagnosticBundle::new(vec![lower_error(
                    "FICT-EMIT-HOOK-ROOT",
                    "one semantic binding cannot own multiple structured hook return sites",
                    GuaranteeClass::Internal,
                )]));
            }
        }
    }
    Ok(sites)
}
fn collect_structured_hook_member_uses(
    hir: &HirFile,
    roots: &BTreeMap<BindingId, StructuredHookRootSite>,
) -> BTreeMap<(BindingId, ImportedHookPropertyMatch), Origin> {
    let mut uses = BTreeMap::new();
    for function in &hir.functions {
        for instruction in function.blocks.iter().flat_map(|block| &block.instructions) {
            let HirInstructionKind::Read { place } = &instruction.kind else {
                continue;
            };
            let Some((_, root, property)) =
                structured_hook_member_by_binding(function, roots, place)
            else {
                continue;
            };
            if matches!(
                property.kind,
                ImportedReactiveKind::Signal | ImportedReactiveKind::Memo
            ) {
                uses.entry((root.binding, property))
                    .or_insert(instruction.origin);
            }
        }
    }
    uses
}
fn lower_function(
    hir: &HirFile,
    function_id: FunctionId,
    regions: &RegionAnalysis,
    scopes: Option<&ReactiveScopeAnalysis>,
    facts: &CrossFunctionFacts<'_>,
    allow_jsx: bool,
    fine_grained_dom: bool,
) -> Result<EmitFunction, DiagnosticBundle> {
    let CrossFunctionFacts {
        captured_write_bindings,
        reactive_bindings,
        structured_hook_roots,
        structured_hook_members,
        list_item_bindings,
        jsx_getter_bindings,
    } = *facts;
    let function = &hir.functions[function_id.as_usize()];
    let declarations_by_value: BTreeMap<_, _> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .filter_map(|instruction| declaration_initializer(function, instruction))
        .collect();
    let mut sites = Vec::new();
    for block in &function.blocks {
        for instruction in &block.instructions {
            let HirInstructionKind::Call(call) = &instruction.kind else {
                continue;
            };
            let Some(kind) = call
                .macro_kind
                .map(ReactiveSiteKind::Macro)
                .or_else(|| call.reactive_kind.map(ReactiveSiteKind::Runtime))
            else {
                continue;
            };
            let Some(result) = instruction.result else {
                return Err(DiagnosticBundle::new(vec![lower_error(
                    "FICT-EMIT-REACTIVE-RESULT",
                    "reactive creation call has no HIR result",
                    GuaranteeClass::Internal,
                )]));
            };
            sites.push(ReactiveSite {
                result,
                local: declarations_by_value.get(&result).copied(),
                kind,
                slot: EmitSlotId::new(count_u32(sites.len())),
            });
        }
    }
    let mut next_slot = sites.len();
    let mut allocate_slot = || {
        let slot = EmitSlotId::new(count_u32(next_slot));
        next_slot = next_slot.saturating_add(1);
        slot
    };
    let site_by_result: BTreeMap<_, _> = sites.iter().map(|site| (site.result, *site)).collect();
    let macro_results: BTreeSet<_> = sites
        .iter()
        .filter_map(|site| matches!(site.kind, ReactiveSiteKind::Macro(_)).then_some(site.result))
        .collect();
    let keyed_results: BTreeSet<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .filter_map(|instruction| {
            let HirInstructionKind::Call(call) = &instruction.kind else {
                return None;
            };
            is_runtime_helper_call(hir, call, RuntimeHelper::KeyedList)
                .then_some(instruction.result)
                .flatten()
        })
        .collect();
    let imported_hook_calls: BTreeMap<_, _> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .filter_map(|instruction| {
            let result = instruction.result?;
            let HirInstructionKind::Call(call) = &instruction.kind else {
                return None;
            };
            imported_hook_return(hir, call)
                .map(|(import, shape)| (result, (import, shape.clone(), instruction.origin)))
        })
        .collect();
    let reassigned_hook_roots = reassigned_locals(function);
    let structured_hook_locals: BTreeMap<_, _> = declarations_by_value
        .iter()
        .filter_map(|(value, local)| {
            let (_, shape, _) = imported_hook_calls.get(value)?;
            (shape.direct_accessor.is_none() && !reassigned_hook_roots.contains(local))
                .then_some((*local, *value))
        })
        .collect();
    let hook_return_sites: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .filter_map(|instruction| {
            let HirInstructionKind::Call(call) = &instruction.kind else {
                return None;
            };
            let result = instruction.result?;
            let (binding, kind) = imported_hook_direct(hir, call)?;
            let kind = match kind {
                ImportedReactiveKind::Signal => ReactiveSlotKind::Signal,
                ImportedReactiveKind::Memo => ReactiveSlotKind::Memo,
                ImportedReactiveKind::Store => return None,
            };
            Some((
                result,
                declarations_by_value.get(&result).copied(),
                binding,
                kind,
                instruction.origin,
            ))
        })
        .map(|(result, local, import, kind, origin)| HookReturnSite {
            result,
            local,
            import,
            kind,
            origin,
            slot: allocate_slot(),
        })
        .collect();
    let hook_return_by_result: BTreeMap<_, _> = hook_return_sites
        .iter()
        .map(|site| (site.result, *site))
        .collect();
    let mut hook_member_uses = BTreeMap::new();
    for (binding, property) in structured_hook_members.keys() {
        let Some(root) = structured_hook_roots
            .get(binding)
            .filter(|root| root.owner == function_id)
        else {
            continue;
        };
        hook_member_uses.entry((root.call, *property)).or_insert((
            Some(root.local),
            root.import,
            root.origin,
        ));
    }
    for instruction in function.blocks.iter().flat_map(|block| &block.instructions) {
        let HirInstructionKind::Read { place } = &instruction.kind else {
            continue;
        };
        let Some((call, local, import, property)) =
            imported_hook_member(&imported_hook_calls, &structured_hook_locals, place)
        else {
            continue;
        };
        if !matches!(
            property.kind,
            ImportedReactiveKind::Signal | ImportedReactiveKind::Memo
        ) {
            continue;
        }
        hook_member_uses
            .entry((call, property))
            .or_insert((local, import, instruction.origin));
    }
    let hook_member_sites: Vec<_> = hook_member_uses
        .into_iter()
        .map(
            |((call, property), (local, import, origin))| HookMemberSite {
                call,
                local,
                import,
                property,
                kind: match property.kind {
                    ImportedReactiveKind::Signal => ReactiveSlotKind::Signal,
                    ImportedReactiveKind::Memo => ReactiveSlotKind::Memo,
                    ImportedReactiveKind::Store => unreachable!("stores are not accessor slots"),
                },
                origin,
                slot: allocate_slot(),
            },
        )
        .collect();
    let hook_member_slots: BTreeMap<_, _> = hook_member_sites
        .iter()
        .map(|site| ((site.call, site.property), site.slot))
        .collect();
    let mut captured_hook_member_uses = BTreeMap::new();
    for instruction in function.blocks.iter().flat_map(|block| &block.instructions) {
        let HirInstructionKind::Read { place } = &instruction.kind else {
            continue;
        };
        let Some((local, root, property)) =
            structured_hook_member_by_binding(function, structured_hook_roots, place)
        else {
            continue;
        };
        if root.owner == function_id
            || !matches!(
                property.kind,
                ImportedReactiveKind::Signal | ImportedReactiveKind::Memo
            )
        {
            continue;
        }
        captured_hook_member_uses
            .entry((local, property))
            .or_insert((
                root.binding,
                root.owner,
                root.call,
                root.import,
                instruction.origin,
            ));
    }
    let captured_hook_member_sites: Vec<_> = captured_hook_member_uses
        .into_iter()
        .map(
            |((local, property), (binding, owner, call, import, origin))| CapturedHookMemberSite {
                local,
                binding,
                owner,
                call,
                import,
                property,
                kind: match property.kind {
                    ImportedReactiveKind::Signal => ReactiveSlotKind::Signal,
                    ImportedReactiveKind::Memo => ReactiveSlotKind::Memo,
                    ImportedReactiveKind::Store => {
                        unreachable!("stores are not captured accessor slots")
                    }
                },
                origin,
                slot: allocate_slot(),
            },
        )
        .collect();
    let captured_hook_member_slots: BTreeMap<_, _> = captured_hook_member_sites
        .iter()
        .map(|site| ((site.local, site.property), site.slot))
        .collect();
    let captured_sites: Vec<_> = function
        .locals
        .iter()
        .filter(|local| local.kind == fict_hir::LocalKind::Capture)
        .filter_map(|local| {
            let binding = local.binding?;
            let site = reactive_bindings.get(&binding).copied()?;
            (site.owner != function_id).then_some((local.id, site))
        })
        .map(|(local, site)| (local, site, allocate_slot()))
        .collect();
    let imported_sites: Vec<_> = function
        .locals
        .iter()
        .filter_map(|local| {
            let binding = local.binding?;
            let kind = hir
                .bindings
                .get(binding.as_usize())?
                .import
                .as_ref()?
                .reactive?;
            Some((
                local.id,
                binding,
                match kind {
                    ImportedReactiveKind::Signal => ReactiveSlotKind::Signal,
                    ImportedReactiveKind::Memo => ReactiveSlotKind::Memo,
                    ImportedReactiveKind::Store => ReactiveSlotKind::Store,
                },
                local.origin,
            ))
        })
        .map(|(local, binding, kind, origin)| (local, binding, kind, origin, allocate_slot()))
        .collect();
    let mut imported_member_uses = BTreeMap::new();
    for instruction in function.blocks.iter().flat_map(|block| &block.instructions) {
        let HirInstructionKind::Read { place } = &instruction.kind else {
            continue;
        };
        let Some((local, binding, resolved)) = imported_reactive_member(hir, function, place)
        else {
            continue;
        };
        imported_member_uses
            .entry((local, resolved.member_index))
            .or_insert((
                binding,
                match resolved.kind {
                    ImportedReactiveKind::Signal => ReactiveSlotKind::Signal,
                    ImportedReactiveKind::Memo => ReactiveSlotKind::Memo,
                    ImportedReactiveKind::Store => ReactiveSlotKind::Store,
                },
                resolved.accessor_depth,
                instruction.origin,
            ));
    }
    let imported_member_sites: Vec<_> = imported_member_uses
        .into_iter()
        .map(
            |((local, member_index), (binding, kind, accessor_depth, origin))| {
                (
                    local,
                    member_index,
                    binding,
                    kind,
                    accessor_depth,
                    origin,
                    allocate_slot(),
                )
            },
        )
        .collect();
    let derived_start = sites.len();
    let owned_reactive_locals: BTreeSet<_> = sites.iter().filter_map(|site| site.local).collect();
    sites.extend(
        derived_declarations(hir, function, scopes, captured_write_bindings)
            .into_iter()
            .filter(|(_, local, _)| !owned_reactive_locals.contains(local))
            .map(|(result, local, _)| ReactiveSite {
                result,
                local: Some(local),
                kind: ReactiveSiteKind::Macro(FictMacroKind::Memo),
                slot: allocate_slot(),
            }),
    );
    let imported_member_slots: BTreeMap<_, _> = imported_member_sites
        .iter()
        .map(|(local, member_index, _, kind, accessor_depth, _, slot)| {
            ((*local, *member_index), (*slot, *kind, *accessor_depth))
        })
        .collect();
    let mut slot_by_local: BTreeMap<_, _> = sites
        .iter()
        .filter_map(|site| {
            matches!(
                site.kind,
                ReactiveSiteKind::Macro(FictMacroKind::State | FictMacroKind::Memo)
            )
            .then_some(site.local)
            .flatten()
            .map(|local| (local, site.slot))
        })
        .collect();
    slot_by_local.extend(
        hook_return_sites
            .iter()
            .filter_map(|site| site.local.map(|local| (local, site.slot))),
    );
    slot_by_local.extend(
        captured_sites
            .iter()
            .filter(|(_, site, _)| {
                matches!(site.kind, ReactiveSlotKind::Signal | ReactiveSlotKind::Memo)
            })
            .map(|(local, _, slot)| (*local, *slot)),
    );
    slot_by_local.extend(
        imported_sites
            .iter()
            .filter(|(_, _, kind, _, _)| {
                matches!(kind, ReactiveSlotKind::Signal | ReactiveSlotKind::Memo)
            })
            .map(|(local, _, _, _, slot)| (*local, *slot)),
    );
    let mut slots: Vec<_> = sites
        .iter()
        .map(|site| ReactiveSlot {
            id: site.slot,
            kind: match site.kind {
                ReactiveSiteKind::Macro(FictMacroKind::State) => ReactiveSlotKind::Signal,
                ReactiveSiteKind::Macro(FictMacroKind::Memo) => ReactiveSlotKind::Memo,
                ReactiveSiteKind::Macro(FictMacroKind::Effect) => ReactiveSlotKind::Effect,
                ReactiveSiteKind::Runtime(ReactiveCallKind::Memo) => ReactiveSlotKind::Memo,
                ReactiveSiteKind::Runtime(ReactiveCallKind::Store) => ReactiveSlotKind::Store,
                ReactiveSiteKind::Runtime(ReactiveCallKind::Resource) => ReactiveSlotKind::Resource,
                ReactiveSiteKind::Runtime(ReactiveCallKind::Selector) => ReactiveSlotKind::Selector,
            },
            storage: ReactiveSlotStorage::Owned,
            binding: site
                .local
                .and_then(|local| function.locals.get(local.as_usize()))
                .and_then(|local| local.binding),
            control_path: Vec::new(),
            origin: reactive_site_origin(function, site.result),
        })
        .collect();
    slots.extend(hook_return_sites.iter().map(|site| {
        ReactiveSlot {
            id: site.slot,
            kind: site.kind,
            storage: ReactiveSlotStorage::HookReturn {
                call: site.result,
                import: site.import,
                property: None,
            },
            binding: site
                .local
                .and_then(|local| function.locals.get(local.as_usize()))
                .and_then(|local| local.binding),
            control_path: Vec::new(),
            origin: site.origin,
        }
    }));
    slots.extend(hook_member_sites.iter().map(|site| {
        ReactiveSlot {
            id: site.slot,
            kind: site.kind,
            storage: ReactiveSlotStorage::HookReturn {
                call: site.call,
                import: site.import,
                property: Some(site.property),
            },
            binding: site
                .local
                .and_then(|local| function.locals.get(local.as_usize()))
                .and_then(|local| local.binding),
            control_path: Vec::new(),
            origin: site.origin,
        }
    }));
    slots.extend(captured_hook_member_sites.iter().map(|site| ReactiveSlot {
        id: site.slot,
        kind: site.kind,
        storage: ReactiveSlotStorage::CapturedHookReturn {
            owner: site.owner,
            call: site.call,
            import: site.import,
            property: site.property,
        },
        binding: Some(site.binding),
        control_path: Vec::new(),
        origin: site.origin,
    }));
    slots.extend(captured_sites.iter().map(|(_, site, slot)| ReactiveSlot {
        id: *slot,
        kind: site.kind,
        storage: ReactiveSlotStorage::Captured { owner: site.owner },
        binding: Some(site.binding),
        control_path: Vec::new(),
        origin: site.origin,
    }));
    slots.extend(
        imported_sites
            .iter()
            .map(|(_, binding, kind, origin, slot)| ReactiveSlot {
                id: *slot,
                kind: *kind,
                storage: ReactiveSlotStorage::Imported { member: None },
                binding: Some(*binding),
                control_path: Vec::new(),
                origin: *origin,
            }),
    );
    slots.extend(imported_member_sites.iter().map(
        |(_, member_index, binding, kind, _, origin, slot)| ReactiveSlot {
            id: *slot,
            kind: *kind,
            storage: ReactiveSlotStorage::Imported {
                member: Some(count_u32(*member_index)),
            },
            binding: Some(*binding),
            control_path: Vec::new(),
            origin: *origin,
        },
    ));
    slots.sort_unstable_by_key(|slot| slot.id);
    let mut temporary_names = NameAllocator::new(
        hir.bindings
            .iter()
            .map(|binding| binding.display_name.clone())
            .chain(
                function
                    .locals
                    .iter()
                    .filter_map(|local| local.debug_name.clone()),
            ),
    );
    let props = lower_component_props_plan(hir, function, &mut temporary_names)?;
    let mut temporaries = Vec::new();
    let mut value_temporaries = BTreeMap::new();
    let mut operations: Vec<_> = sites[derived_start..]
        .iter()
        .map(|site| EmitOperation::CreateDerived {
            slot: site.slot,
            source_result: site.result,
            helper: (!function.flags.no_memo)
                .then(|| creation_helper(function.kind, FictMacroKind::Memo)),
            origin: reactive_site_origin(function, site.result),
        })
        .collect();
    let hook_return_accessor_reads = hook_return_accessor_reads(function);
    let mut declared_templates = BTreeSet::new();
    let cleanup = regions
        .top_level_regions
        .first()
        .copied()
        .map_or(CleanupOwner::Function, CleanupOwner::Region);
    for block in &function.blocks {
        for (instruction_index, instruction) in block.instructions.iter().enumerate() {
            if let Some(site) = instruction
                .result
                .and_then(|result| hook_return_by_result.get(&result).copied())
            {
                preserve(&mut operations, block.id, instruction_index, instruction);
                if site.local.is_none() && !hook_return_accessor_reads.contains(&site.result) {
                    let target = allocate_temporary(
                        &mut temporaries,
                        &mut temporary_names,
                        format!("__fict_v{}", site.result.index()),
                        instruction.origin,
                    );
                    value_temporaries.insert(site.result, target);
                    operations.push(EmitOperation::ReadReactive {
                        slot: site.slot,
                        source_result: site.result,
                        projections: Vec::new(),
                        accessor_depth: 0,
                        target,
                        helper: None,
                        origin: instruction.origin,
                    });
                }
                continue;
            }
            if let HirInstructionKind::Call(call) = &instruction.kind
                && let Some(site) = instruction
                    .result
                    .and_then(|result| site_by_result.get(&result).copied())
            {
                let result = instruction.result.expect("reactive result validated");
                match site.kind {
                    ReactiveSiteKind::Macro(FictMacroKind::State | FictMacroKind::Memo) => {
                        operations.push(EmitOperation::CreateReactive {
                            slot: site.slot,
                            source_result: result,
                            local: site.local,
                            name: site.local.and_then(|local| {
                                function.locals[local.as_usize()].debug_name.clone()
                            }),
                            initializer: call
                                .arguments
                                .first()
                                .map(|argument| lower_value(argument.value, &value_temporaries)),
                            helper: creation_helper(
                                function.kind,
                                call.macro_kind.expect("macro site"),
                            ),
                            origin: instruction.origin,
                        });
                    }
                    ReactiveSiteKind::Macro(FictMacroKind::Effect) => {
                        let Some(callback) = call.arguments.first() else {
                            return Err(DiagnosticBundle::new(vec![lower_error(
                                "FICT-EMIT-EFFECT-CALLBACK",
                                "effect macro has no callback input",
                                GuaranteeClass::Internal,
                            )]));
                        };
                        operations.push(EmitOperation::RegisterEffect {
                            slot: site.slot,
                            source_result: Some(result),
                            callback: lower_value(callback.value, &value_temporaries),
                            helper: effect_helper(function.kind),
                            cleanup: CleanupOwner::Slot(site.slot),
                            origin: instruction.origin,
                        });
                    }
                    ReactiveSiteKind::Runtime(_) => {
                        operations.push(EmitOperation::TrackRuntimeReactive {
                            slot: site.slot,
                            source_result: result,
                            local: site.local,
                            cleanup: CleanupOwner::Slot(site.slot),
                            origin: instruction.origin,
                        });
                        preserve(&mut operations, block.id, instruction_index, instruction);
                    }
                }
                continue;
            }
            if let HirInstructionKind::Call(call) = &instruction.kind
                && instruction
                    .result
                    .is_some_and(|result| keyed_results.contains(&result))
            {
                let result = instruction.result.expect("keyed result selected");
                if call.arguments.len() < 3 {
                    return Err(DiagnosticBundle::new(vec![lower_error(
                        "FICT-EMIT-KEYED-ARGS",
                        "createKeyedList requires items, key, and render inputs",
                        GuaranteeClass::Unsupported,
                    )]));
                }
                let key = function_value(function, call.arguments[1].value).ok_or_else(|| {
                    DiagnosticBundle::new(vec![lower_error(
                        "FICT-EMIT-KEYED-KEY",
                        "keyed list key input must be a statically known function",
                        GuaranteeClass::Unsupported,
                    )])
                })?;
                let render =
                    function_value(function, call.arguments[2].value).ok_or_else(|| {
                        DiagnosticBundle::new(vec![lower_error(
                            "FICT-EMIT-KEYED-RENDER",
                            "keyed list render input must be a statically known function",
                            GuaranteeClass::Unsupported,
                        )])
                    })?;
                let target = allocate_temporary(
                    &mut temporaries,
                    &mut temporary_names,
                    format!("__fict_list{}", result.index()),
                    instruction.origin,
                );
                value_temporaries.insert(result, target);
                operations.push(EmitOperation::KeyedList {
                    target,
                    source_result: result,
                    items: lower_value(call.arguments[0].value, &value_temporaries),
                    key: Some(key),
                    render,
                    helper: RuntimeHelper::KeyedList,
                    cleanup,
                    origin: instruction.origin,
                });
                continue;
            }
            if let HirInstructionKind::Declare {
                initializer: Some(initializer),
                ..
            } = instruction.kind
                && (macro_results.contains(&initializer) || keyed_results.contains(&initializer))
            {
                continue;
            }
            if matches!(instruction.kind, HirInstructionKind::Write { .. })
                && declaration_initializer(function, instruction).is_some_and(|(initializer, _)| {
                    site_by_result.contains_key(&initializer)
                        || keyed_results.contains(&initializer)
                })
            {
                continue;
            }
            match &instruction.kind {
                HirInstructionKind::Read { place } => {
                    if instruction
                        .result
                        .is_some_and(|result| hook_return_accessor_reads.contains(&result))
                    {
                        preserve(&mut operations, block.id, instruction_index, instruction);
                        continue;
                    }
                    let direct_slot = place_local(place.base)
                        .and_then(|local| slot_by_local.get(&local).copied())
                        .map(|slot| (slot, 0_usize));
                    let member_slot = imported_reactive_member(hir, function, place).and_then(
                        |(local, _, resolved)| {
                            imported_member_slots
                                .get(&(local, resolved.member_index))
                                .filter(|(_, kind, _)| {
                                    matches!(
                                        kind,
                                        ReactiveSlotKind::Signal | ReactiveSlotKind::Memo
                                    )
                                })
                                .map(|(slot, _, accessor_depth)| (*slot, *accessor_depth))
                        },
                    );
                    let hook_member_slot =
                        imported_hook_member(&imported_hook_calls, &structured_hook_locals, place)
                            .and_then(|(call, _, _, property)| {
                                hook_member_slots
                                    .get(&(call, property))
                                    .copied()
                                    .map(|slot| (slot, 1_usize))
                            });
                    let captured_hook_member_slot =
                        structured_hook_member_by_binding(function, structured_hook_roots, place)
                            .filter(|(_, root, _)| root.owner != function_id)
                            .and_then(|(local, _, property)| {
                                captured_hook_member_slots
                                    .get(&(local, property))
                                    .copied()
                                    .map(|slot| (slot, 1_usize))
                            });
                    let Some((slot, accessor_depth)) = direct_slot
                        .or(member_slot)
                        .or(hook_member_slot)
                        .or(captured_hook_member_slot)
                    else {
                        preserve(&mut operations, block.id, instruction_index, instruction);
                        continue;
                    };
                    let Ok(accessor_depth) = u16::try_from(accessor_depth) else {
                        return Err(DiagnosticBundle::new(vec![lower_error(
                            "FICT-EMIT-IMPORTED-DEPTH",
                            "imported reactive member depth exceeds the EmitIR limit",
                            GuaranteeClass::Internal,
                        )]));
                    };
                    let Some(result) = instruction.result else {
                        return Err(DiagnosticBundle::new(vec![lower_error(
                            "FICT-EMIT-READ-RESULT",
                            "reactive read has no HIR result",
                            GuaranteeClass::Internal,
                        )]));
                    };
                    let target = allocate_temporary(
                        &mut temporaries,
                        &mut temporary_names,
                        format!("__fict_v{}", result.index()),
                        instruction.origin,
                    );
                    value_temporaries.insert(result, target);
                    operations.push(EmitOperation::ReadReactive {
                        slot,
                        source_result: result,
                        projections: place.projections.clone(),
                        accessor_depth,
                        target,
                        helper: None,
                        origin: instruction.origin,
                    });
                }
                HirInstructionKind::Write { place, value } => {
                    reject_imported_hook_member_mutation(
                        &imported_hook_calls,
                        &structured_hook_locals,
                        place,
                    )?;
                    reject_captured_hook_member_mutation(
                        function,
                        function_id,
                        structured_hook_roots,
                        place,
                    )?;
                    let Some(slot) = place_local(place.base)
                        .and_then(|local| slot_by_local.get(&local).copied())
                    else {
                        preserve(&mut operations, block.id, instruction_index, instruction);
                        continue;
                    };
                    ensure_writable_hook_return(&slots, slot)?;
                    let value = lower_value(*value, &value_temporaries);
                    let target = instruction.result.map(|result| {
                        let target = allocate_temporary(
                            &mut temporaries,
                            &mut temporary_names,
                            format!("__fict_v{}", result.index()),
                            instruction.origin,
                        );
                        value_temporaries.insert(result, target);
                        target
                    });
                    operations.push(EmitOperation::WriteReactive {
                        slot,
                        source_result: instruction.result,
                        projections: place.projections.clone(),
                        value,
                        target,
                        origin: instruction.origin,
                    });
                }
                HirInstructionKind::ReadWrite {
                    place,
                    compound,
                    value,
                    update,
                    prefix,
                } => {
                    reject_imported_hook_member_mutation(
                        &imported_hook_calls,
                        &structured_hook_locals,
                        place,
                    )?;
                    reject_captured_hook_member_mutation(
                        function,
                        function_id,
                        structured_hook_roots,
                        place,
                    )?;
                    let Some(slot) = place_local(place.base)
                        .and_then(|local| slot_by_local.get(&local).copied())
                    else {
                        preserve(&mut operations, block.id, instruction_index, instruction);
                        continue;
                    };
                    ensure_writable_hook_return(&slots, slot)?;
                    let target = instruction.result.map(|result| {
                        let target = allocate_temporary(
                            &mut temporaries,
                            &mut temporary_names,
                            format!("__fict_v{}", result.index()),
                            instruction.origin,
                        );
                        value_temporaries.insert(result, target);
                        target
                    });
                    operations.push(EmitOperation::UpdateReactive {
                        slot,
                        source_result: instruction.result,
                        projections: place.projections.clone(),
                        compound: *compound,
                        value: value.map(|value| lower_value(value, &value_temporaries)),
                        update: *update,
                        prefix: *prefix,
                        target,
                        origin: instruction.origin,
                    });
                }
                HirInstructionKind::Delete {
                    target: DeleteTarget::Place(place),
                } if !place.projections.is_empty() => {
                    reject_imported_hook_member_mutation(
                        &imported_hook_calls,
                        &structured_hook_locals,
                        place,
                    )?;
                    reject_captured_hook_member_mutation(
                        function,
                        function_id,
                        structured_hook_roots,
                        place,
                    )?;
                    let Some(slot) = place_local(place.base)
                        .and_then(|local| slot_by_local.get(&local).copied())
                    else {
                        preserve(&mut operations, block.id, instruction_index, instruction);
                        continue;
                    };
                    ensure_writable_hook_return(&slots, slot)?;
                    let Some(source_result) = instruction.result else {
                        return Err(DiagnosticBundle::new(vec![lower_error(
                            "FICT-EMIT-DELETE-RESULT",
                            "reactive property deletion has no HIR result",
                            GuaranteeClass::Internal,
                        )]));
                    };
                    let target = allocate_temporary(
                        &mut temporaries,
                        &mut temporary_names,
                        format!("__fict_v{}", source_result.index()),
                        instruction.origin,
                    );
                    value_temporaries.insert(source_result, target);
                    operations.push(EmitOperation::DeleteReactive {
                        slot,
                        source_result,
                        projections: place.projections.clone(),
                        target,
                        origin: instruction.origin,
                    });
                }
                HirInstructionKind::PatternAssignment { value, writes, .. } => {
                    let targets: Vec<_> = writes
                        .iter()
                        .filter_map(|write| {
                            slot_by_local.get(&write.local).copied().map(|slot| {
                                ReactivePatternTarget {
                                    slot,
                                    local: write.local,
                                    origin: write.origin,
                                }
                            })
                        })
                        .collect();
                    if targets.is_empty() {
                        preserve(&mut operations, block.id, instruction_index, instruction);
                        continue;
                    }
                    for target in &targets {
                        ensure_writable_hook_return(&slots, target.slot)?;
                    }
                    let Some(source_result) = instruction.result else {
                        return Err(DiagnosticBundle::new(vec![lower_error(
                            "FICT-EMIT-PATTERN-RESULT",
                            "reactive pattern assignment has no HIR result",
                            GuaranteeClass::Internal,
                        )]));
                    };
                    operations.push(EmitOperation::WriteReactivePattern {
                        source_result,
                        value: lower_value(*value, &value_temporaries),
                        targets,
                        origin: instruction.origin,
                    });
                }
                HirInstructionKind::Jsx { template } if allow_jsx => {
                    if fine_grained_dom && !jsx_contains_direct_yield(function, instruction) {
                        lower_jsx_instruction(
                            hir,
                            function_id,
                            *template,
                            instruction,
                            &mut declared_templates,
                            &mut temporaries,
                            &mut temporary_names,
                            &mut value_temporaries,
                            &mut operations,
                            cleanup,
                            reactive_bindings,
                            list_item_bindings,
                            jsx_getter_bindings,
                        )?;
                    } else {
                        let Some(source_result) = instruction.result else {
                            return Err(DiagnosticBundle::new(vec![lower_error(
                                "FICT-EMIT-VNODE-RESULT",
                                "VNode JSX lowering requires a source result",
                                GuaranteeClass::Internal,
                            )]));
                        };
                        operations.push(EmitOperation::CreateVNode {
                            template: *template,
                            source_result,
                            fragment_helper: hir.templates[template.as_usize()]
                                .contains_fragment
                                .then_some(RuntimeHelper::Fragment),
                            origin: instruction.origin,
                        });
                    }
                }
                _ => preserve(&mut operations, block.id, instruction_index, instruction),
            }
        }
        match &block.terminator.kind {
            TerminatorKind::Return { value } => operations.push(EmitOperation::Return {
                value: value.map(|value| lower_value(value, &value_temporaries)),
                origin: block.terminator.origin,
            }),
            TerminatorKind::Throw { .. }
            | TerminatorKind::Goto { .. }
            | TerminatorKind::Branch { .. }
            | TerminatorKind::ForIn { .. }
            | TerminatorKind::ForOf { .. }
            | TerminatorKind::Switch { .. }
            | TerminatorKind::Try { .. }
            | TerminatorKind::Unreachable => {}
        }
    }
    let control_flow = structurize_cfg(function, &analyze_cfg(function)?)?;
    crate::conditional_return::lower_conditional_returns(
        function,
        &control_flow,
        &mut temporaries,
        &mut temporary_names,
        &mut operations,
    );
    let context = operations
        .iter()
        .filter_map(EmitOperation::helper)
        .any(is_scoped_helper)
        .then(|| EmitContext {
            local: temporary_names.allocate("__fictCtx"),
            helper: RuntimeHelper::UseContext,
            origin: function.origin,
        });
    Ok(EmitFunction {
        source: function_id,
        context,
        props,
        slots,
        temporaries,
        regions: regions.top_level_regions.clone(),
        control_flow,
        operations,
    })
}
fn jsx_contains_direct_yield(function: &HirFunction, jsx: &HirInstruction) -> bool {
    if !function.flags.is_generator {
        return false;
    }
    let Some(jsx_span) = jsx.origin.primary_span else {
        return true;
    };
    function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .any(|instruction| {
            matches!(instruction.kind, HirInstructionKind::Yield { .. })
                && instruction.origin.primary_span.is_some_and(|yield_span| {
                    jsx_span.start() <= yield_span.start() && yield_span.end() <= jsx_span.end()
                })
        })
}
fn lower_component_props_plan(
    hir: &HirFile,
    function: &HirFunction,
    names: &mut NameAllocator,
) -> Result<Option<EmitPropsPlan>, DiagnosticBundle> {
    if function.kind != FunctionKind::Component {
        return Ok(None);
    }
    let Some(parameter) = function.parameters.first() else {
        return Ok(None);
    };
    let Some(properties) = &parameter.object_properties else {
        return Ok(None);
    };
    let mut bindings = Vec::with_capacity(properties.len());
    for property in properties {
        let Some(binding) = hir.bindings.get(property.binding.as_usize()) else {
            return Err(DiagnosticBundle::new(vec![lower_error(
                "FICT-EMIT-PROPS-BINDING",
                "component props plan references an unknown binding",
                GuaranteeClass::Internal,
            )]));
        };
        bindings.push(EmitPropBinding {
            binding: property.binding,
            path: property.path.clone(),
            local: binding.display_name.clone(),
            mode: match property.mode {
                fict_hir::HirObjectParameterMode::Accessor => EmitPropMode::Accessor,
                fict_hir::HirObjectParameterMode::Value => EmitPropMode::Value,
                fict_hir::HirObjectParameterMode::Mutable => EmitPropMode::Mutable,
            },
            checks: property
                .checks
                .iter()
                .map(|check| EmitPropCheck {
                    path: check.path.clone(),
                    local: names.allocate("__fictPropObject"),
                    origin: check.origin,
                })
                .collect(),
            references: property.references.clone(),
            default_value: property.default_value,
            default_dependencies: property.default_dependencies.clone(),
            default_local: property
                .default_value
                .map(|_| names.allocate("__fictPropDefault")),
            origin: property.origin,
        });
    }
    let source = names.allocate("__fictProps");
    let default = parameter.default_value.map(|value| EmitPropsDefault {
        input: names.allocate("__fictPropsParam"),
        value,
    });
    let rest = if let Some(rest) = &parameter.object_rest {
        let Some(binding) = hir.bindings.get(rest.binding.as_usize()) else {
            return Err(DiagnosticBundle::new(vec![lower_error(
                "FICT-EMIT-PROPS-REST-BINDING",
                "component props rest plan references an unknown binding",
                GuaranteeClass::Internal,
            )]));
        };
        Some(EmitPropsRest {
            binding: rest.binding,
            local: binding.display_name.clone(),
            excluded: rest.excluded.clone(),
            helper: RuntimeHelper::PropsRest,
            origin: rest.origin,
        })
    } else {
        None
    };
    let helper = bindings
        .iter()
        .any(|binding| binding.mode == EmitPropMode::Accessor)
        .then_some(RuntimeHelper::Prop);
    Ok(Some(EmitPropsPlan {
        parameter: parameter.origin,
        source,
        default,
        bindings,
        rest,
        helper,
    }))
}
fn is_scoped_helper(helper: RuntimeHelper) -> bool {
    matches!(
        helper,
        RuntimeHelper::UseSignal | RuntimeHelper::UseMemo | RuntimeHelper::UseEffect
    )
}
#[derive(Debug)]
enum TemplateBinding {
    Attribute {
        path: Vec<u32>,
        name: String,
        value: ValueId,
    },
    StaticAttribute {
        path: Vec<u32>,
        name: String,
        value: fict_hir::LiteralValue,
        origin: Origin,
    },
    Evaluate {
        value: ValueId,
    },
    Spread {
        path: Vec<u32>,
        value: ValueId,
        namespace: DomNamespace,
        skip_children: bool,
    },
    Child {
        parent_path: Vec<u32>,
        marker_path: Vec<u32>,
        value: ValueId,
        contains_fragment: bool,
        namespace: DomNamespace,
    },
    NodeChild {
        parent_path: Vec<u32>,
        marker_path: Vec<u32>,
        origin: Origin,
        component: bool,
        contains_fragment: bool,
        namespace: DomNamespace,
    },
    TextContent {
        path: Vec<u32>,
        segments: Vec<TemplateTextSegment>,
    },
    Conditional {
        parent_path: Vec<u32>,
        start_path: Vec<u32>,
        end_path: Vec<u32>,
        value: ValueId,
        kind: ConditionalKind,
        contains_fragment: bool,
        namespace: DomNamespace,
    },
    KeyedList {
        parent_path: Vec<u32>,
        start_path: Vec<u32>,
        end_path: Vec<u32>,
        value: ValueId,
        list: JsxListExpression,
        namespace: DomNamespace,
    },
    Event {
        path: Vec<u32>,
        event: String,
        handler: ValueId,
        options: EventOptions,
        resumable_explicit: bool,
    },
    Ref {
        path: Vec<u32>,
        reference: ValueId,
    },
}
#[derive(Debug)]
enum TemplateTextSegment {
    Literal(String),
    Value(ValueId),
    Node(Origin),
}
#[derive(Debug)]
struct SerializedTemplate {
    html: String,
    namespace: DomNamespace,
    force_fragment: bool,
    bindings: Vec<TemplateBinding>,
}
#[allow(clippy::too_many_arguments)]
fn lower_jsx_instruction(
    hir: &HirFile,
    function_id: FunctionId,
    template_id: TemplateId,
    instruction: &HirInstruction,
    declared_templates: &mut BTreeSet<TemplateId>,
    temporaries: &mut Vec<EmitTemporary>,
    temporary_names: &mut NameAllocator,
    value_temporaries: &mut BTreeMap<ValueId, EmitTemporaryId>,
    operations: &mut Vec<EmitOperation>,
    cleanup: CleanupOwner,
    reactive_bindings: &BTreeMap<BindingId, ReactiveBindingSite>,
    list_item_bindings: &BTreeSet<BindingId>,
    jsx_getter_bindings: &BTreeSet<BindingId>,
) -> Result<(), DiagnosticBundle> {
    let Some(template) = hir.templates.get(template_id.as_usize()) else {
        return Err(DiagnosticBundle::new(vec![lower_error(
            "FICT-EMIT-TEMPLATE",
            "JSX instruction references a missing template",
            GuaranteeClass::Internal,
        )]));
    };
    if template.owner != function_id {
        return Err(DiagnosticBundle::new(vec![lower_error(
            "FICT-EMIT-TEMPLATE-OWNER",
            "JSX template belongs to another function value arena",
            GuaranteeClass::Internal,
        )]));
    }
    let Some(result) = instruction.result else {
        return Err(DiagnosticBundle::new(vec![lower_error(
            "FICT-EMIT-JSX-RESULT",
            "JSX instruction has no HIR result",
            GuaranteeClass::Internal,
        )]));
    };
    let root_is_component = matches!(
        &template.root,
        JsxNode::Element(element) if !matches!(element.name, JsxElementName::Intrinsic(_))
    );
    let mut component_targets = BTreeMap::new();
    register_component_nodes(
        hir,
        function_id,
        &template.root,
        root_is_component.then_some(result),
        temporaries,
        temporary_names,
        value_temporaries,
        operations,
        &mut component_targets,
        jsx_getter_bindings,
    )?;
    if root_is_component {
        return Ok(());
    }
    let trusted_lists =
        trusted_jsx_list_values(&template.root, reactive_bindings, list_item_bindings);
    let serialized = serialize_template_with_lists(&template.root, &trusted_lists)?;
    if declared_templates.insert(template_id) {
        let preferred = format!("__fict_tmpl{}", template_id.index());
        let local = temporary_names.allocate(&preferred);
        operations.push(EmitOperation::DeclareTemplate {
            template: template_id,
            local: local.clone(),
            html: serialized.html,
            namespace: serialized.namespace,
            force_fragment: serialized.force_fragment,
            helper: RuntimeHelper::Template,
            origin: template.origin,
        });
    }
    let root = allocate_temporary(
        temporaries,
        temporary_names,
        format!("__fict_jsx{}", result.index()),
        instruction.origin,
    );
    value_temporaries.insert(result, root);
    operations.push(EmitOperation::CloneTemplate {
        template: template_id,
        source_result: result,
        target: root,
        namespace_helper: matches!(&template.root, JsxNode::Element(_))
            .then_some(RuntimeHelper::ElementNamespaceMatches),
        reactive_helper: matches!(&template.root, JsxNode::Element(_))
            .then_some(RuntimeHelper::ReactiveGetter),
        fragment_helper: template
            .contains_fragment
            .then_some(RuntimeHelper::Fragment),
        origin: instruction.origin,
    });
    let mut resolved = BTreeMap::new();
    for binding in serialized.bindings {
        match binding {
            TemplateBinding::Attribute { path, name, value } => {
                let origin = hir.functions[function_id.as_usize()].values[value.as_usize()].origin;
                let element = resolved_element(
                    root,
                    path,
                    &mut resolved,
                    temporaries,
                    temporary_names,
                    operations,
                    origin,
                );
                let reactive = !matches!(
                    hir.functions[function_id.as_usize()].values[value.as_usize()].kind,
                    ValueKind::Literal(_)
                );
                let kind = dom_binding_kind(&name);
                let helper = dom_binding_helper(&kind, reactive);
                operations.push(EmitOperation::BindDom {
                    element,
                    kind,
                    value: lower_value(value, value_temporaries),
                    reactive,
                    helper,
                    origin,
                });
            }
            TemplateBinding::StaticAttribute {
                path,
                name,
                value,
                origin,
            } => {
                let element = resolved_element(
                    root,
                    path,
                    &mut resolved,
                    temporaries,
                    temporary_names,
                    operations,
                    origin,
                );
                let kind = dom_binding_kind(&name);
                let helper = dom_binding_helper(&kind, false);
                operations.push(EmitOperation::BindDom {
                    element,
                    kind,
                    value: EmitValueRef::Literal(value),
                    reactive: false,
                    helper,
                    origin,
                });
            }
            TemplateBinding::Evaluate { value } => {
                let origin = hir.functions[function_id.as_usize()].values[value.as_usize()].origin;
                operations.push(EmitOperation::Evaluate {
                    value: lower_value(value, value_temporaries),
                    origin,
                });
            }
            TemplateBinding::TextContent { path, segments } => {
                let reactive = segments
                    .iter()
                    .any(|segment| !matches!(segment, TemplateTextSegment::Literal(_)));
                let origin = segments
                    .iter()
                    .find_map(|segment| match segment {
                        TemplateTextSegment::Literal(_) => None,
                        TemplateTextSegment::Value(value) => Some(
                            hir.functions[function_id.as_usize()].values[value.as_usize()].origin,
                        ),
                        TemplateTextSegment::Node(origin) => Some(*origin),
                    })
                    .unwrap_or(template.origin);
                let element = resolved_element(
                    root,
                    path,
                    &mut resolved,
                    temporaries,
                    temporary_names,
                    operations,
                    origin,
                );
                let segments = segments
                    .into_iter()
                    .map(|segment| match segment {
                        TemplateTextSegment::Literal(value) => DomTextSegment::Literal(value),
                        TemplateTextSegment::Value(value) => DomTextSegment::Source {
                            value: Some(value),
                            origin: hir.functions[function_id.as_usize()].values[value.as_usize()]
                                .origin,
                        },
                        TemplateTextSegment::Node(origin) => DomTextSegment::Source {
                            value: None,
                            origin,
                        },
                    })
                    .collect();
                let kind = DomBindingKind::TextContent;
                operations.push(EmitOperation::BindDom {
                    element,
                    helper: dom_binding_helper(&kind, reactive),
                    kind,
                    value: EmitValueRef::Text(segments),
                    reactive,
                    origin,
                });
            }
            TemplateBinding::Spread {
                path,
                value,
                namespace,
                skip_children,
            } => {
                let origin = hir.functions[function_id.as_usize()].values[value.as_usize()].origin;
                let element = resolved_element(
                    root,
                    path,
                    &mut resolved,
                    temporaries,
                    temporary_names,
                    operations,
                    origin,
                );
                operations.push(EmitOperation::ApplyProps {
                    target: element,
                    operation: PropsOperation::Spread {
                        source: lower_value(value, value_temporaries),
                        namespace,
                        skip_children,
                        excluded: Vec::new(),
                    },
                    helper: RuntimeHelper::Spread,
                    origin,
                });
            }
            TemplateBinding::Child {
                parent_path,
                marker_path,
                value,
                contains_fragment,
                namespace,
            } => {
                let origin = hir.functions[function_id.as_usize()].values[value.as_usize()].origin;
                let parent = resolved_element(
                    root,
                    parent_path,
                    &mut resolved,
                    temporaries,
                    temporary_names,
                    operations,
                    origin,
                );
                let marker = resolved_element(
                    root,
                    marker_path,
                    &mut resolved,
                    temporaries,
                    temporary_names,
                    operations,
                    origin,
                );
                operations.push(EmitOperation::Insert {
                    parent,
                    value: Some(lower_value(value, value_temporaries)),
                    before: Some(marker),
                    namespace,
                    helper: RuntimeHelper::Insert,
                    create_helper: create_element_helper(namespace),
                    fragment_helper: contains_fragment.then_some(RuntimeHelper::Fragment),
                    origin,
                });
            }
            TemplateBinding::NodeChild {
                parent_path,
                marker_path,
                origin,
                component,
                contains_fragment,
                namespace,
            } => {
                let Some(span) = origin.primary_span else {
                    return Err(DiagnosticBundle::new(vec![lower_error(
                        "FICT-EMIT-COMPONENT-ORIGIN",
                        "nested component JSX requires a source origin",
                        GuaranteeClass::Internal,
                    )]));
                };
                let target = if component {
                    Some(
                        component_targets
                            .get(&(span.start(), span.end()))
                            .copied()
                            .ok_or_else(|| {
                                DiagnosticBundle::new(vec![lower_error(
                                    "FICT-EMIT-COMPONENT-PLAN",
                                    "nested component JSX has no recursive component plan",
                                    GuaranteeClass::Internal,
                                )])
                            })?,
                    )
                } else {
                    None
                };
                let parent = resolved_element(
                    root,
                    parent_path,
                    &mut resolved,
                    temporaries,
                    temporary_names,
                    operations,
                    origin,
                );
                let marker = resolved_element(
                    root,
                    marker_path,
                    &mut resolved,
                    temporaries,
                    temporary_names,
                    operations,
                    origin,
                );
                operations.push(EmitOperation::Insert {
                    parent,
                    value: target.map(EmitValueRef::Temporary),
                    before: Some(marker),
                    namespace,
                    helper: RuntimeHelper::Insert,
                    create_helper: create_element_helper(namespace),
                    fragment_helper: (target.is_none() && contains_fragment)
                        .then_some(RuntimeHelper::Fragment),
                    origin,
                });
            }
            TemplateBinding::Conditional {
                parent_path,
                start_path,
                end_path,
                value,
                kind,
                contains_fragment,
                namespace,
            } => {
                let origin = hir.functions[function_id.as_usize()].values[value.as_usize()].origin;
                let parent = resolved_element(
                    root,
                    parent_path,
                    &mut resolved,
                    temporaries,
                    temporary_names,
                    operations,
                    origin,
                );
                let start = resolved_element(
                    root,
                    start_path,
                    &mut resolved,
                    temporaries,
                    temporary_names,
                    operations,
                    origin,
                );
                let end = resolved_element(
                    root,
                    end_path,
                    &mut resolved,
                    temporaries,
                    temporary_names,
                    operations,
                    origin,
                );
                let target = allocate_temporary(
                    temporaries,
                    temporary_names,
                    format!("__fict_cond{}", value.index()),
                    origin,
                );
                operations.push(EmitOperation::Conditional {
                    target,
                    source: lower_value(value, value_temporaries),
                    kind,
                    parent,
                    start,
                    end,
                    namespace,
                    helper: RuntimeHelper::Conditional,
                    create_helper: create_element_helper(namespace),
                    cleanup_helper: RuntimeHelper::OnDestroy,
                    fragment_helper: contains_fragment.then_some(RuntimeHelper::Fragment),
                    cleanup,
                    origin,
                });
            }
            TemplateBinding::KeyedList {
                parent_path,
                start_path,
                end_path,
                value,
                list,
                namespace,
            } => {
                let origin = hir.functions[function_id.as_usize()].values[value.as_usize()].origin;
                let parent = resolved_element(
                    root,
                    parent_path,
                    &mut resolved,
                    temporaries,
                    temporary_names,
                    operations,
                    origin,
                );
                let start = resolved_element(
                    root,
                    start_path,
                    &mut resolved,
                    temporaries,
                    temporary_names,
                    operations,
                    origin,
                );
                let end = resolved_element(
                    root,
                    end_path,
                    &mut resolved,
                    temporaries,
                    temporary_names,
                    operations,
                    origin,
                );
                let target = allocate_temporary(
                    temporaries,
                    temporary_names,
                    format!("__fict_list{}", value.index()),
                    origin,
                );
                let render_key = temporary_names.allocate("__fict_key");
                operations.push(EmitOperation::KeyedChild {
                    target,
                    source_result: value,
                    items: list.items,
                    optional: list.optional,
                    key: list.key,
                    key_source: list.key_source,
                    key_alias_initializer: list.key_alias_initializer,
                    render: list.callback,
                    render_key,
                    item_references: list.item_references,
                    index_references: list.index_references,
                    needs_index: list.needs_index,
                    parent,
                    start,
                    end,
                    namespace,
                    helper: RuntimeHelper::KeyedList,
                    cleanup_helper: RuntimeHelper::OnDestroy,
                    cleanup,
                    origin,
                });
            }
            TemplateBinding::Event {
                path,
                event,
                handler,
                options,
                resumable_explicit,
            } => {
                let origin =
                    hir.functions[function_id.as_usize()].values[handler.as_usize()].origin;
                let element = resolved_element(
                    root,
                    path,
                    &mut resolved,
                    temporaries,
                    temporary_names,
                    operations,
                    origin,
                );
                let delegated = options.is_empty() && DELEGATED_EVENTS.contains(&event.as_str());
                operations.push(EmitOperation::BindEvent {
                    element,
                    event,
                    handler: lower_value(handler, value_temporaries),
                    options,
                    resumable_explicit,
                    delegated,
                    helper: if delegated {
                        RuntimeHelper::AddEventListener
                    } else {
                        RuntimeHelper::BindEvent
                    },
                    cleanup_helper: (!delegated).then_some(RuntimeHelper::OnDestroy),
                    cleanup,
                    origin,
                });
            }
            TemplateBinding::Ref { path, reference } => {
                let origin =
                    hir.functions[function_id.as_usize()].values[reference.as_usize()].origin;
                let element = resolved_element(
                    root,
                    path,
                    &mut resolved,
                    temporaries,
                    temporary_names,
                    operations,
                    origin,
                );
                operations.push(EmitOperation::BindRef {
                    element,
                    reference: lower_value(reference, value_temporaries),
                    helper: RuntimeHelper::BindRef,
                    cleanup,
                    origin,
                });
            }
        }
    }
    Ok(())
}
#[allow(clippy::too_many_arguments)]
fn register_component_nodes(
    hir: &HirFile,
    function_id: FunctionId,
    node: &JsxNode,
    root_result: Option<ValueId>,
    temporaries: &mut Vec<EmitTemporary>,
    temporary_names: &mut NameAllocator,
    value_temporaries: &mut BTreeMap<ValueId, EmitTemporaryId>,
    operations: &mut Vec<EmitOperation>,
    component_targets: &mut BTreeMap<(u32, u32), EmitTemporaryId>,
    jsx_getter_bindings: &BTreeSet<BindingId>,
) -> Result<(), DiagnosticBundle> {
    match node {
        JsxNode::Element(element) => {
            if !matches!(element.name, JsxElementName::Intrinsic(_)) {
                let target = lower_component_operation(
                    hir,
                    function_id,
                    element,
                    root_result,
                    temporaries,
                    temporary_names,
                    value_temporaries,
                    operations,
                    jsx_getter_bindings,
                )?;
                let Some(span) = element.origin.primary_span else {
                    return Err(DiagnosticBundle::new(vec![lower_error(
                        "FICT-EMIT-COMPONENT-ORIGIN",
                        "component JSX requires a source origin",
                        GuaranteeClass::Internal,
                    )]));
                };
                if component_targets
                    .insert((span.start(), span.end()), target)
                    .is_some()
                {
                    return Err(DiagnosticBundle::new(vec![lower_error(
                        "FICT-EMIT-COMPONENT-ORIGIN",
                        "component JSX source origins must be unique",
                        GuaranteeClass::Internal,
                    )]));
                }
            } else if root_result.is_some() {
                return Err(DiagnosticBundle::new(vec![lower_error(
                    "FICT-EMIT-COMPONENT-ROOT",
                    "only a component JSX root can own the component result",
                    GuaranteeClass::Internal,
                )]));
            }
            for attribute in &element.attributes {
                if let JsxAttribute::Named {
                    value: JsxAttributeValue::Node(node),
                    ..
                } = attribute
                {
                    register_component_nodes(
                        hir,
                        function_id,
                        node,
                        None,
                        temporaries,
                        temporary_names,
                        value_temporaries,
                        operations,
                        component_targets,
                        jsx_getter_bindings,
                    )?;
                }
            }
            for child in &element.children {
                if let JsxChild::Node(node) = child {
                    register_component_nodes(
                        hir,
                        function_id,
                        node,
                        None,
                        temporaries,
                        temporary_names,
                        value_temporaries,
                        operations,
                        component_targets,
                        jsx_getter_bindings,
                    )?;
                }
            }
        }
        JsxNode::Fragment { children, .. } => {
            if root_result.is_some() {
                return Err(DiagnosticBundle::new(vec![lower_error(
                    "FICT-EMIT-COMPONENT-ROOT",
                    "a fragment root cannot own a component result",
                    GuaranteeClass::Internal,
                )]));
            }
            for child in children {
                if let JsxChild::Node(node) = child {
                    register_component_nodes(
                        hir,
                        function_id,
                        node,
                        None,
                        temporaries,
                        temporary_names,
                        value_temporaries,
                        operations,
                        component_targets,
                        jsx_getter_bindings,
                    )?;
                }
            }
        }
    }
    Ok(())
}
fn jsx_value_needs_getter(
    hir: &HirFile,
    function: &HirFunction,
    value: ValueId,
    bindings: &BTreeSet<BindingId>,
) -> bool {
    let ValueKind::SyntaxFragment(fragment) = function.values[value.as_usize()].kind else {
        return false;
    };
    hir.syntax_fragments[fragment.as_usize()]
        .summary
        .referenced_bindings
        .iter()
        .any(|binding| bindings.contains(binding))
}
#[allow(clippy::too_many_arguments)]
fn lower_component_operation(
    hir: &HirFile,
    function_id: FunctionId,
    element: &fict_hir::JsxElement,
    source_result: Option<ValueId>,
    temporaries: &mut Vec<EmitTemporary>,
    temporary_names: &mut NameAllocator,
    value_temporaries: &mut BTreeMap<ValueId, EmitTemporaryId>,
    operations: &mut Vec<EmitOperation>,
    jsx_getter_bindings: &BTreeSet<BindingId>,
) -> Result<EmitTemporaryId, DiagnosticBundle> {
    let function = &hir.functions[function_id.as_usize()];
    let resettable_boundary = is_runtime_resettable_boundary(hir, &element.name);
    let component = match &element.name {
        JsxElementName::Component(binding) => ComponentTarget::Binding(*binding),
        JsxElementName::Member { root, properties } => ComponentTarget::Member {
            root: *root,
            properties: properties.clone(),
        },
        JsxElementName::Dynamic(value) => {
            ComponentTarget::Dynamic(lower_value(*value, value_temporaries))
        }
        JsxElementName::Intrinsic(_) => unreachable!("intrinsic handled by template lowering"),
    };
    let mut props = Vec::new();
    for attribute in &element.attributes {
        match attribute {
            JsxAttribute::Named { name, value, .. } => {
                let (value, mut getter, mut non_reactive) = match value {
                    JsxAttributeValue::ImplicitTrue => (
                        EmitValueRef::Literal(fict_hir::LiteralValue::Boolean(true)),
                        false,
                        false,
                    ),
                    JsxAttributeValue::Text(value) => (
                        EmitValueRef::Literal(fict_hir::LiteralValue::String(value.clone().into())),
                        false,
                        false,
                    ),
                    JsxAttributeValue::Expression {
                        value,
                        function_like,
                        ..
                    } => (
                        lower_value(*value, value_temporaries),
                        !function_like
                            && jsx_value_needs_getter(hir, function, *value, jsx_getter_bindings),
                        *function_like,
                    ),
                    JsxAttributeValue::Node(node) => {
                        props.push(ComponentProp::Node {
                            name: name.clone(),
                            origin: node.origin(),
                        });
                        continue;
                    }
                };
                if name == "key" {
                    getter = false;
                    non_reactive = false;
                }
                let reactive_function = resettable_boundary && name == "resetKeys" && non_reactive;
                if reactive_function {
                    getter = false;
                    non_reactive = false;
                }
                props.push(ComponentProp::Named {
                    name: name.clone(),
                    value,
                    getter,
                    non_reactive,
                    reactive_function,
                });
            }
            JsxAttribute::Spread { value, getter, .. } => {
                props.push(ComponentProp::Spread {
                    value: lower_value(*value, value_temporaries),
                    getter: *getter
                        || jsx_value_needs_getter(hir, function, *value, jsx_getter_bindings),
                });
            }
        }
    }
    let mut children = Vec::new();
    for child in &element.children {
        let child = match child {
            JsxChild::Text { value, .. } => ComponentChild::Value {
                value: EmitValueRef::Literal(fict_hir::LiteralValue::String(value.clone().into())),
                getter: false,
                non_reactive: false,
            },
            JsxChild::Expression {
                value,
                function_like,
                ..
            } => ComponentChild::Value {
                value: lower_value(*value, value_temporaries),
                getter: !function_like
                    && jsx_value_needs_getter(hir, function, *value, jsx_getter_bindings),
                non_reactive: *function_like,
            },
            JsxChild::Spread { value, .. } => ComponentChild::Value {
                value: lower_value(*value, value_temporaries),
                getter: jsx_value_needs_getter(hir, function, *value, jsx_getter_bindings),
                non_reactive: false,
            },
            JsxChild::Node(node) => ComponentChild::Node(node.origin()),
        };
        children.push(child);
    }
    let preferred = source_result.map_or_else(
        || "__fict_component".to_owned(),
        |result| format!("__fict_component{}", result.index()),
    );
    let target = allocate_temporary(temporaries, temporary_names, preferred, element.origin);
    if let Some(result) = source_result {
        value_temporaries.insert(result, target);
    }
    operations.push(EmitOperation::InvokeComponent {
        target,
        component,
        prop_helper: props
            .iter()
            .any(|prop| {
                matches!(
                    prop,
                    ComponentProp::Named { getter: true, .. }
                        | ComponentProp::Spread { getter: true, .. }
                )
            })
            .then_some(RuntimeHelper::PropGetter),
        children_helper: children
            .iter()
            .any(|child| matches!(child, ComponentChild::Value { getter: true, .. }))
            .then_some(RuntimeHelper::Prop),
        merge_helper: props
            .iter()
            .any(|prop| matches!(prop, ComponentProp::Spread { .. }))
            .then_some(RuntimeHelper::MergeProps),
        non_reactive_helper: (props.iter().any(|prop| {
            matches!(
                prop,
                ComponentProp::Named {
                    non_reactive: true,
                    ..
                }
            )
        }) || children.iter().any(|child| {
            matches!(
                child,
                ComponentChild::Value {
                    non_reactive: true,
                    ..
                }
            )
        }))
        .then_some(RuntimeHelper::NonReactive),
        reactive_function_helper: props
            .iter()
            .any(|prop| {
                matches!(
                    prop,
                    ComponentProp::Named {
                        reactive_function: true,
                        ..
                    }
                )
            })
            .then_some(RuntimeHelper::ReactiveGetter),
        fragment_helper: element
            .contains_fragment()
            .then_some(RuntimeHelper::Fragment),
        props,
        children,
        origin: element.origin,
    });
    Ok(target)
}
fn is_runtime_resettable_boundary(hir: &HirFile, name: &JsxElementName) -> bool {
    match name {
        JsxElementName::Component(binding) => hir
            .bindings
            .get(binding.as_usize())
            .and_then(|binding| binding.import.as_ref())
            .is_some_and(|import| {
                matches!(import.source.as_str(), "fict" | "@fictjs/runtime")
                    && matches!(
                        &import.imported,
                        ImportedName::Named(name)
                            if matches!(name.as_str(), "ErrorBoundary" | "Suspense")
                    )
            }),
        JsxElementName::Member { root, properties } => hir
            .bindings
            .get(root.as_usize())
            .and_then(|binding| binding.import.as_ref())
            .is_some_and(|import| {
                matches!(import.source.as_str(), "fict" | "@fictjs/runtime")
                    && matches!(
                        import.imported,
                        ImportedName::Namespace | ImportedName::ImportEquals
                    )
                    && matches!(properties.as_slice(), [name] if matches!(name.as_str(), "ErrorBoundary" | "Suspense"))
            }),
        JsxElementName::Intrinsic(_) | JsxElementName::Dynamic(_) => false,
    }
}
fn trusted_jsx_list_values(
    root: &JsxNode,
    reactive: &BTreeMap<BindingId, ReactiveBindingSite>,
    items: &BTreeSet<BindingId>,
) -> BTreeSet<ValueId> {
    enum Item<'a> {
        Node(&'a JsxNode),
        Child(&'a JsxChild),
    }
    let mut trusted = BTreeSet::new();
    let mut stack = vec![Item::Node(root)];
    while let Some(item) = stack.pop() {
        match item {
            Item::Node(JsxNode::Element(element)) => {
                for attribute in &element.attributes {
                    if let JsxAttribute::Named {
                        value: JsxAttributeValue::Node(node),
                        ..
                    } = attribute
                    {
                        stack.push(Item::Node(node));
                    }
                }
                stack.extend(element.children.iter().map(Item::Child));
            }
            Item::Node(JsxNode::Fragment { children, .. }) => {
                stack.extend(children.iter().map(Item::Child));
            }
            Item::Child(JsxChild::Expression {
                value,
                list,
                embedded_nodes,
                ..
            }) => {
                if matches!(list, Some(list) if trusted_receiver(list.receiver, reactive, items)) {
                    trusted.insert(*value);
                }
                stack.extend(embedded_nodes.iter().map(Item::Node));
            }
            Item::Child(JsxChild::Node(node)) => stack.push(Item::Node(node)),
            Item::Child(JsxChild::Text { .. } | JsxChild::Spread { .. }) => {}
        }
    }
    trusted
}
fn trusted_receiver(
    receiver: JsxListReceiver,
    reactive: &BTreeMap<BindingId, ReactiveBindingSite>,
    items: &BTreeSet<BindingId>,
) -> bool {
    match receiver {
        JsxListReceiver::ArrayLiteral => true,
        JsxListReceiver::Binding {
            known_array: true, ..
        } => true,
        JsxListReceiver::Binding { root, .. } if items.contains(&root) => true,
        JsxListReceiver::Binding {
            root,
            projected: false,
            known_array: false,
        } => reactive.get(&root).is_some_and(|site| {
            matches!(site.kind, ReactiveSlotKind::Signal | ReactiveSlotKind::Memo)
        }),
        JsxListReceiver::Binding {
            root,
            projected: true,
            known_array: false,
        } => reactive
            .get(&root)
            .is_some_and(|site| site.kind == ReactiveSlotKind::Store),
    }
}
#[cfg(test)]
fn serialize_template(root: &JsxNode) -> Result<SerializedTemplate, DiagnosticBundle> {
    serialize_template_with_lists(root, &BTreeSet::new())
}
fn serialize_template_with_lists(
    root: &JsxNode,
    trusted_lists: &BTreeSet<ValueId>,
) -> Result<SerializedTemplate, DiagnosticBundle> {
    let namespace = match root {
        JsxNode::Element(element) => match &element.name {
            JsxElementName::Intrinsic(name) => resolve_element_namespace(name, None, true),
            _ => DomNamespace::Html,
        },
        JsxNode::Fragment { .. } => DomNamespace::Html,
    };
    let mut html = String::new();
    let mut bindings = Vec::new();
    serialize_node(
        root,
        None,
        true,
        &mut Vec::new(),
        &mut html,
        &mut bindings,
        trusted_lists,
    )?;
    if html.is_empty() {
        html.push_str("<!---->");
    }
    Ok(SerializedTemplate {
        html,
        namespace,
        force_fragment: matches!(root, JsxNode::Fragment { .. }),
        bindings,
    })
}
fn serialize_node(
    node: &JsxNode,
    parent_namespace: Option<DomNamespace>,
    allow_standalone: bool,
    path: &mut Vec<u32>,
    html: &mut String,
    bindings: &mut Vec<TemplateBinding>,
    trusted_lists: &BTreeSet<ValueId>,
) -> Result<u32, DiagnosticBundle> {
    match node {
        JsxNode::Fragment { children, .. } => serialize_children(
            children,
            path,
            html,
            bindings,
            None,
            parent_namespace.unwrap_or(DomNamespace::Html),
            parent_namespace.unwrap_or(DomNamespace::Html),
            trusted_lists,
        ),
        JsxNode::Element(element) => {
            let JsxElementName::Intrinsic(tag) = &element.name else {
                return Err(DiagnosticBundle::new(vec![lower_error(
                    "FICT-EMIT-COMPONENT-STAGE",
                    "component/dynamic JSX requires the component lowering phase",
                    GuaranteeClass::Unsupported,
                )]));
            };
            let element_namespace =
                resolve_element_namespace(tag, parent_namespace, allow_standalone);
            let child_namespace =
                resolve_child_namespace(tag, element_namespace, &element.attributes);
            let has_authored_children = element.children.iter().any(renderable_child);
            let children_attribute = element.attributes.iter().rev().find_map(|attribute| {
                let JsxAttribute::Named {
                    name,
                    value,
                    origin,
                } = attribute
                else {
                    return None;
                };
                (name == "children").then(|| (value.clone(), *origin))
            });
            let last_encoding = (element_namespace == DomNamespace::MathMl
                && tag.eq_ignore_ascii_case("annotation-xml"))
            .then(|| {
                element.attributes.iter().rposition(|attribute| {
                    matches!(attribute, JsxAttribute::Named { name, .. } if name.eq_ignore_ascii_case("encoding"))
                })
            })
            .flatten();
            if !valid_markup_name(tag) {
                return Err(DiagnosticBundle::new(vec![lower_error(
                    "FICT-EMIT-TAG",
                    "intrinsic JSX tag contains unsafe markup characters",
                    GuaranteeClass::Unsupported,
                )]));
            }
            html.push('<');
            html.push_str(tag);
            let mut seen_spread = false;
            for (attribute_index, attribute) in element.attributes.iter().enumerate() {
                match attribute {
                    JsxAttribute::Named {
                        name,
                        value,
                        origin,
                    } => {
                        let name = normalize_attribute_name(tag, name, element_namespace);
                        if !valid_markup_name(&name) {
                            return Err(DiagnosticBundle::new(vec![lower_error(
                                "FICT-EMIT-ATTRIBUTE",
                                "JSX attribute contains unsafe markup characters",
                                GuaranteeClass::Unsupported,
                            )]));
                        }
                        if name == "key" {
                            if let JsxAttributeValue::Expression { value, .. } = value {
                                bindings.push(TemplateBinding::Evaluate { value: *value });
                            }
                            continue;
                        }
                        if name == "children" {
                            continue;
                        }
                        if name == "encoding"
                            && last_encoding.is_some_and(|index| index != attribute_index)
                        {
                            if let JsxAttributeValue::Expression { value, .. } = value {
                                bindings.push(TemplateBinding::Evaluate { value: *value });
                            }
                            continue;
                        }
                        match value {
                            JsxAttributeValue::ImplicitTrue => {
                                if seen_spread {
                                    bindings.push(TemplateBinding::StaticAttribute {
                                        path: path.clone(),
                                        name,
                                        value: fict_hir::LiteralValue::Boolean(true),
                                        origin: *origin,
                                    });
                                } else {
                                    html.push(' ');
                                    html.push_str(&name);
                                }
                            }
                            JsxAttributeValue::Text(value) => {
                                if seen_spread {
                                    bindings.push(TemplateBinding::StaticAttribute {
                                        path: path.clone(),
                                        name,
                                        value: fict_hir::LiteralValue::String(value.clone().into()),
                                        origin: *origin,
                                    });
                                } else {
                                    html.push(' ');
                                    html.push_str(&name);
                                    html.push_str("=\"");
                                    escape_attribute(value, html);
                                    html.push('"');
                                }
                            }
                            JsxAttributeValue::Expression { value, .. } => {
                                if name == "ref" {
                                    bindings.push(TemplateBinding::Ref {
                                        path: path.clone(),
                                        reference: *value,
                                    });
                                } else if let Some((event, resumable_explicit, options)) =
                                    parse_event_attribute(&name)
                                {
                                    bindings.push(TemplateBinding::Event {
                                        path: path.clone(),
                                        event,
                                        handler: *value,
                                        options,
                                        resumable_explicit,
                                    });
                                } else {
                                    bindings.push(TemplateBinding::Attribute {
                                        path: path.clone(),
                                        name,
                                        value: *value,
                                    });
                                }
                            }
                            JsxAttributeValue::Node(_) => {
                                return Err(DiagnosticBundle::new(vec![lower_error(
                                    "FICT-EMIT-ATTRIBUTE-NODE",
                                    "JSX node-valued attributes require component lowering",
                                    GuaranteeClass::Unsupported,
                                )]));
                            }
                        }
                    }
                    JsxAttribute::Spread { value, .. } => {
                        seen_spread = true;
                        bindings.push(TemplateBinding::Spread {
                            path: path.clone(),
                            value: *value,
                            namespace: element_namespace,
                            skip_children: has_authored_children || children_attribute.is_some(),
                        });
                    }
                }
            }
            html.push('>');
            let attribute_child = (!has_authored_children)
                .then(|| children_attribute.as_ref().and_then(attribute_as_child))
                .flatten();
            let selected_children = if has_authored_children {
                element.children.as_slice()
            } else {
                attribute_child.as_slice()
            };
            if is_html_void_element(tag, element_namespace) {
                if selected_children.iter().any(renderable_child) {
                    return Err(DiagnosticBundle::new(vec![lower_error(
                        "FICT-EMIT-VOID-CHILD",
                        "HTML void elements cannot contain JSX children",
                        GuaranteeClass::Unsupported,
                    )]));
                }
            } else {
                let bind_text_content = binds_element_text_content(tag, element_namespace)
                    && (children_attribute.is_some()
                        || selected_children
                            .iter()
                            .any(|child| !matches!(child, JsxChild::Text { .. })));
                if bind_text_content {
                    let segments = text_content_segments(selected_children);
                    if !segments.is_empty() {
                        bindings.push(TemplateBinding::TextContent {
                            path: path.clone(),
                            segments,
                        });
                    }
                } else {
                    serialize_children(
                        selected_children,
                        path,
                        html,
                        bindings,
                        Some(tag),
                        element_namespace,
                        child_namespace,
                        trusted_lists,
                    )?;
                }
                html.push_str("</");
                html.push_str(tag);
                html.push('>');
            }
            Ok(1)
        }
    }
}
fn attribute_as_child((value, origin): &(JsxAttributeValue, Origin)) -> Option<JsxChild> {
    match value {
        JsxAttributeValue::ImplicitTrue => None,
        JsxAttributeValue::Text(value) => Some(JsxChild::Text {
            value: value.clone(),
            origin: *origin,
        }),
        JsxAttributeValue::Expression {
            value,
            function_like,
            contains_fragment,
        } => Some(JsxChild::Expression {
            value: *value,
            kind: JsxExpressionKind::Value,
            contains_fragment: *contains_fragment,
            function_like: *function_like,
            list: None,
            embedded_nodes: Vec::new(),
            origin: *origin,
        }),
        JsxAttributeValue::Node(node) => Some(JsxChild::Node(node.clone())),
    }
}
fn binds_element_text_content(tag: &str, namespace: DomNamespace) -> bool {
    namespace == DomNamespace::Html
        && matches!(
            tag.to_ascii_lowercase().as_str(),
            "script" | "style" | "title"
        )
}
fn text_content_segments(children: &[JsxChild]) -> Vec<TemplateTextSegment> {
    children
        .iter()
        .map(|child| match child {
            JsxChild::Text { value, .. } => TemplateTextSegment::Literal(value.clone()),
            JsxChild::Expression { value, .. } | JsxChild::Spread { value, .. } => {
                TemplateTextSegment::Value(*value)
            }
            JsxChild::Node(node) => TemplateTextSegment::Node(node.origin()),
        })
        .collect()
}
#[allow(clippy::too_many_arguments)]
fn serialize_children(
    children: &[JsxChild],
    parent_path: &mut Vec<u32>,
    html: &mut String,
    bindings: &mut Vec<TemplateBinding>,
    parent_tag: Option<&str>,
    parent_element_namespace: DomNamespace,
    child_namespace: DomNamespace,
    trusted_lists: &BTreeSet<ValueId>,
) -> Result<u32, DiagnosticBundle> {
    let mut child_index = 0_u32;
    let mut source_index = 0_usize;
    let mut previous_static_text = false;
    while source_index < children.len() {
        let child = &children[source_index];
        match child {
            JsxChild::Text { value, .. } => {
                if !value.is_empty() {
                    push_static_child_text(parent_tag, parent_element_namespace, value, html)?;
                    if !previous_static_text {
                        child_index += 1;
                    }
                    previous_static_text = true;
                }
            }
            JsxChild::Expression {
                value,
                kind,
                contains_fragment,
                ..
            } if matches!(
                kind,
                JsxExpressionKind::Conditional | JsxExpressionKind::LogicalAnd
            ) =>
            {
                previous_static_text = false;
                html.push_str("<!----><!---->");
                let mut start_path = parent_path.clone();
                start_path.push(child_index);
                let mut end_path = parent_path.clone();
                end_path.push(child_index + 1);
                bindings.push(TemplateBinding::Conditional {
                    parent_path: parent_path.clone(),
                    start_path,
                    end_path,
                    value: *value,
                    kind: match kind {
                        JsxExpressionKind::Conditional => ConditionalKind::Ternary,
                        JsxExpressionKind::LogicalAnd => ConditionalKind::LogicalAnd,
                        JsxExpressionKind::Value => unreachable!(),
                    },
                    contains_fragment: *contains_fragment,
                    namespace: child_namespace,
                });
                child_index += 2;
            }
            JsxChild::Expression {
                value,
                list: Some(list),
                ..
            } if trusted_lists.contains(value) => {
                previous_static_text = false;
                html.push_str("<!----><!---->");
                let mut start_path = parent_path.clone();
                start_path.push(child_index);
                let mut end_path = parent_path.clone();
                end_path.push(child_index + 1);
                bindings.push(TemplateBinding::KeyedList {
                    parent_path: parent_path.clone(),
                    start_path,
                    end_path,
                    value: *value,
                    list: list.clone(),
                    namespace: child_namespace,
                });
                child_index += 2;
            }
            JsxChild::Expression { value, .. } | JsxChild::Spread { value, .. } => {
                previous_static_text = false;
                html.push_str("<!---->");
                let mut marker_path = parent_path.clone();
                marker_path.push(child_index);
                bindings.push(TemplateBinding::Child {
                    parent_path: parent_path.clone(),
                    marker_path,
                    value: *value,
                    contains_fragment: matches!(
                        child,
                        JsxChild::Expression {
                            contains_fragment: true,
                            ..
                        }
                    ),
                    namespace: child_namespace,
                });
                child_index += 1;
            }
            JsxChild::Node(node) => {
                previous_static_text = false;
                let component = matches!(node.as_ref(), JsxNode::Element(element) if !matches!(element.name, JsxElementName::Intrinsic(_)));
                let runtime_node = child_namespace == DomNamespace::Parent || component;
                if runtime_node {
                    html.push_str("<!---->");
                    let mut marker_path = parent_path.clone();
                    marker_path.push(child_index);
                    bindings.push(TemplateBinding::NodeChild {
                        parent_path: parent_path.clone(),
                        marker_path,
                        origin: node.origin(),
                        component,
                        contains_fragment: node.contains_fragment(),
                        namespace: child_namespace,
                    });
                    child_index += 1;
                    source_index += 1;
                    continue;
                }
                if is_implicit_table_child(parent_tag, parent_element_namespace, child, "tr") {
                    parent_path.push(child_index);
                    html.push_str("<tbody>");
                    let mut row_index = 0_u32;
                    while source_index < children.len()
                        && is_implicit_table_child(
                            parent_tag,
                            parent_element_namespace,
                            &children[source_index],
                            "tr",
                        )
                    {
                        let JsxChild::Node(row) = &children[source_index] else {
                            unreachable!("table child predicate requires a JSX node")
                        };
                        parent_path.push(row_index);
                        serialize_node(
                            row,
                            Some(child_namespace),
                            false,
                            parent_path,
                            html,
                            bindings,
                            trusted_lists,
                        )?;
                        parent_path.pop();
                        row_index += 1;
                        source_index += 1;
                    }
                    html.push_str("</tbody>");
                    parent_path.pop();
                    child_index += 1;
                    continue;
                }
                if is_implicit_table_child(parent_tag, parent_element_namespace, child, "col") {
                    parent_path.push(child_index);
                    html.push_str("<colgroup>");
                    let mut column_index = 0_u32;
                    while source_index < children.len()
                        && is_implicit_table_child(
                            parent_tag,
                            parent_element_namespace,
                            &children[source_index],
                            "col",
                        )
                    {
                        let JsxChild::Node(column) = &children[source_index] else {
                            unreachable!("table child predicate requires a JSX node")
                        };
                        parent_path.push(column_index);
                        serialize_node(
                            column,
                            Some(child_namespace),
                            false,
                            parent_path,
                            html,
                            bindings,
                            trusted_lists,
                        )?;
                        parent_path.pop();
                        column_index += 1;
                        source_index += 1;
                    }
                    html.push_str("</colgroup>");
                    parent_path.pop();
                    child_index += 1;
                    continue;
                }
                parent_path.push(child_index);
                let node_count = serialize_node(
                    node,
                    Some(child_namespace),
                    false,
                    parent_path,
                    html,
                    bindings,
                    trusted_lists,
                )?;
                parent_path.pop();
                child_index += node_count;
            }
        }
        source_index += 1;
    }
    Ok(child_index)
}
fn push_static_child_text(
    parent_tag: Option<&str>,
    namespace: DomNamespace,
    value: &str,
    html: &mut String,
) -> Result<(), DiagnosticBundle> {
    let raw_tag = parent_tag.filter(|tag| {
        namespace == DomNamespace::Html
            && matches!(tag.to_ascii_lowercase().as_str(), "script" | "style")
    });
    if let Some(tag) = raw_tag {
        if value
            .to_ascii_lowercase()
            .contains(&format!("</{}", tag.to_ascii_lowercase()))
        {
            return Err(DiagnosticBundle::new(vec![lower_error(
                "FICT-EMIT-RAWTEXT",
                "static raw-text content cannot contain its closing tag",
                GuaranteeClass::Unsupported,
            )]));
        }
        html.push_str(value);
    } else {
        escape_text(value, html);
    }
    Ok(())
}
fn resolve_element_namespace(
    tag: &str,
    parent: Option<DomNamespace>,
    allow_standalone: bool,
) -> DomNamespace {
    let tag = tag.to_ascii_lowercase();
    match parent {
        None | Some(DomNamespace::Html) => {
            if tag == "svg" {
                DomNamespace::Svg
            } else if tag == "math" {
                DomNamespace::MathMl
            } else if parent.is_none() && allow_standalone && is_standalone_svg_tag(&tag) {
                DomNamespace::Svg
            } else if parent.is_none() && allow_standalone && is_standalone_mathml_tag(&tag) {
                DomNamespace::MathMl
            } else {
                DomNamespace::Html
            }
        }
        Some(DomNamespace::Svg) => DomNamespace::Svg,
        Some(DomNamespace::MathMl) => DomNamespace::MathMl,
        Some(DomNamespace::MathMlTextIntegration) => {
            if tag == "svg" {
                DomNamespace::Svg
            } else if tag == "math" || matches!(tag.as_str(), "mglyph" | "malignmark") {
                DomNamespace::MathMl
            } else {
                DomNamespace::Html
            }
        }
        Some(DomNamespace::MathMlAnnotationXml) => {
            if tag == "svg" {
                DomNamespace::Svg
            } else {
                DomNamespace::MathMl
            }
        }
        Some(DomNamespace::Parent) => DomNamespace::Parent,
    }
}
fn resolve_child_namespace(
    tag: &str,
    element_namespace: DomNamespace,
    attributes: &[JsxAttribute],
) -> DomNamespace {
    let tag = tag.to_ascii_lowercase();
    if element_namespace == DomNamespace::Svg
        && matches!(tag.as_str(), "foreignobject" | "title" | "desc")
    {
        return DomNamespace::Html;
    }
    if element_namespace == DomNamespace::MathMl && tag == "annotation-xml" {
        return match annotation_xml_encoding(attributes) {
            AnnotationXmlEncoding::Html => DomNamespace::Html,
            AnnotationXmlEncoding::Other => DomNamespace::MathMlAnnotationXml,
            AnnotationXmlEncoding::Dynamic => DomNamespace::Parent,
        };
    }
    if element_namespace == DomNamespace::MathMl
        && matches!(tag.as_str(), "mi" | "mo" | "mn" | "ms" | "mtext")
    {
        return DomNamespace::MathMlTextIntegration;
    }
    element_namespace
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AnnotationXmlEncoding {
    Html,
    Other,
    Dynamic,
}
fn annotation_xml_encoding(attributes: &[JsxAttribute]) -> AnnotationXmlEncoding {
    let mut encoding = AnnotationXmlEncoding::Other;
    for attribute in attributes {
        match attribute {
            JsxAttribute::Spread { .. } => encoding = AnnotationXmlEncoding::Dynamic,
            JsxAttribute::Named { name, value, .. } if name.eq_ignore_ascii_case("encoding") => {
                encoding = match value {
                    JsxAttributeValue::Text(value)
                        if matches!(
                            value.to_ascii_lowercase().as_str(),
                            "text/html" | "application/xhtml+xml"
                        ) =>
                    {
                        AnnotationXmlEncoding::Html
                    }
                    JsxAttributeValue::Expression { .. } | JsxAttributeValue::Node(_) => {
                        AnnotationXmlEncoding::Dynamic
                    }
                    JsxAttributeValue::ImplicitTrue | JsxAttributeValue::Text(_) => {
                        AnnotationXmlEncoding::Other
                    }
                };
            }
            JsxAttribute::Named { .. } => {}
        }
    }
    encoding
}
fn normalize_attribute_name(tag: &str, name: &str, namespace: DomNamespace) -> String {
    if tag.eq_ignore_ascii_case("annotation-xml") && name.eq_ignore_ascii_case("encoding") {
        return "encoding".to_owned();
    }
    match name {
        "className" => return "class".to_owned(),
        "htmlFor" => return "for".to_owned(),
        _ => {}
    }
    if namespace != DomNamespace::Svg {
        return name.to_owned();
    }
    match name {
        "xmlnsXlink" => "xmlns:xlink",
        "strokeWidth" => "stroke-width",
        "strokeLinecap" => "stroke-linecap",
        "strokeLinejoin" => "stroke-linejoin",
        "strokeDasharray" => "stroke-dasharray",
        "strokeDashoffset" => "stroke-dashoffset",
        "strokeOpacity" => "stroke-opacity",
        "fillOpacity" => "fill-opacity",
        "fillRule" => "fill-rule",
        "clipRule" => "clip-rule",
        "transformOrigin" => "transform-origin",
        "clipPath" => "clip-path",
        "textAnchor" => "text-anchor",
        "dominantBaseline" => "dominant-baseline",
        "fontSize" => "font-size",
        "fontFamily" => "font-family",
        "fontWeight" => "font-weight",
        "xlinkHref" => "xlink:href",
        "stopColor" => "stop-color",
        "stopOpacity" => "stop-opacity",
        "markerStart" => "marker-start",
        "markerMid" => "marker-mid",
        "markerEnd" => "marker-end",
        "vectorEffect" => "vector-effect",
        _ => name,
    }
    .to_owned()
}
fn is_implicit_table_child(
    parent_tag: Option<&str>,
    parent_namespace: DomNamespace,
    child: &JsxChild,
    expected: &str,
) -> bool {
    if parent_namespace != DomNamespace::Html
        || !parent_tag.is_some_and(|tag| tag.eq_ignore_ascii_case("table"))
    {
        return false;
    }
    matches!(
        child,
        JsxChild::Node(node)
            if matches!(
                node.as_ref(),
                JsxNode::Element(element)
                    if matches!(&element.name, JsxElementName::Intrinsic(tag) if tag.eq_ignore_ascii_case(expected))
            )
    )
}
fn renderable_child(child: &JsxChild) -> bool {
    !matches!(child, JsxChild::Text { value, .. } if value.is_empty())
}
fn is_html_void_element(tag: &str, namespace: DomNamespace) -> bool {
    namespace == DomNamespace::Html
        && matches!(
            tag.to_ascii_lowercase().as_str(),
            "area"
                | "base"
                | "br"
                | "col"
                | "embed"
                | "hr"
                | "img"
                | "input"
                | "link"
                | "meta"
                | "param"
                | "source"
                | "track"
                | "wbr"
        )
}
fn is_standalone_svg_tag(tag: &str) -> bool {
    matches!(
        tag,
        "animate"
            | "animatemotion"
            | "animatetransform"
            | "circle"
            | "clippath"
            | "defs"
            | "desc"
            | "ellipse"
            | "feblend"
            | "fecolormatrix"
            | "fecomponenttransfer"
            | "fecomposite"
            | "feconvolvematrix"
            | "fediffuselighting"
            | "fedisplacementmap"
            | "fedistantlight"
            | "fedropshadow"
            | "feflood"
            | "fefunca"
            | "fefuncb"
            | "fefuncg"
            | "fefuncr"
            | "fegaussianblur"
            | "feimage"
            | "femerge"
            | "femergenode"
            | "femorphology"
            | "feoffset"
            | "fepointlight"
            | "fespecularlighting"
            | "fespotlight"
            | "fetile"
            | "feturbulence"
            | "filter"
            | "g"
            | "image"
            | "line"
            | "lineargradient"
            | "marker"
            | "mask"
            | "metadata"
            | "mpath"
            | "path"
            | "pattern"
            | "polygon"
            | "polyline"
            | "radialgradient"
            | "rect"
            | "set"
            | "stop"
            | "switch"
            | "symbol"
            | "text"
            | "textpath"
            | "tspan"
            | "use"
            | "view"
    )
}
fn is_standalone_mathml_tag(tag: &str) -> bool {
    matches!(
        tag,
        "mi" | "mo"
            | "mn"
            | "ms"
            | "mtext"
            | "annotation"
            | "maction"
            | "maligngroup"
            | "malignmark"
            | "menclose"
            | "merror"
            | "mfenced"
            | "mfrac"
            | "mglyph"
            | "mlabeledtr"
            | "mlongdiv"
            | "mmultiscripts"
            | "mover"
            | "mpadded"
            | "mphantom"
            | "mroot"
            | "mrow"
            | "msgroup"
            | "msline"
            | "mspace"
            | "msqrt"
            | "msrow"
            | "mstack"
            | "mstyle"
            | "msub"
            | "msubsup"
            | "msup"
            | "mtable"
            | "mtd"
            | "mtr"
            | "munder"
            | "munderover"
            | "semantics"
    )
}
fn resolved_element(
    root: EmitTemporaryId,
    path: Vec<u32>,
    resolved: &mut BTreeMap<Vec<u32>, EmitTemporaryId>,
    temporaries: &mut Vec<EmitTemporary>,
    temporary_names: &mut NameAllocator,
    operations: &mut Vec<EmitOperation>,
    origin: Origin,
) -> EmitTemporaryId {
    if path.is_empty() {
        return root;
    }
    if let Some(temporary) = resolved.get(&path) {
        return *temporary;
    }
    let target = allocate_temporary(
        temporaries,
        temporary_names,
        format!("__fict_node{}", temporaries.len()),
        origin,
    );
    operations.push(EmitOperation::ResolveElement {
        root,
        path: path.clone(),
        target,
        helper: RuntimeHelper::ResolvePath,
        origin,
    });
    resolved.insert(path, target);
    target
}
fn dom_binding_kind(name: &str) -> DomBindingKind {
    match name {
        "class" | "className" => DomBindingKind::Class,
        "style" => DomBindingKind::Style,
        "value" | "checked" | "selected" | "textContent" | "innerHTML" => {
            DomBindingKind::Property(name.to_owned())
        }
        _ => DomBindingKind::Attribute(name.to_owned()),
    }
}
fn create_element_helper(namespace: DomNamespace) -> RuntimeHelper {
    match namespace {
        DomNamespace::Html => RuntimeHelper::CreateElement,
        DomNamespace::Svg
        | DomNamespace::MathMl
        | DomNamespace::MathMlTextIntegration
        | DomNamespace::MathMlAnnotationXml => RuntimeHelper::CreateElementInNamespace,
        DomNamespace::Parent => RuntimeHelper::CreateElementInParentNamespace,
    }
}
fn dom_binding_helper(kind: &DomBindingKind, reactive: bool) -> RuntimeHelper {
    match (kind, reactive) {
        (DomBindingKind::Text, true) => RuntimeHelper::BindText,
        (DomBindingKind::Text, false) => RuntimeHelper::SetText,
        (DomBindingKind::TextContent, true) => RuntimeHelper::BindTextContent,
        (DomBindingKind::TextContent, false) => RuntimeHelper::SetTextContent,
        (DomBindingKind::Attribute(_), true) => RuntimeHelper::BindAttribute,
        (DomBindingKind::Attribute(_), false) => RuntimeHelper::SetAttr,
        (DomBindingKind::Property(_), true) => RuntimeHelper::BindProperty,
        (DomBindingKind::Property(_), false) => RuntimeHelper::SetProp,
        (DomBindingKind::Class, true) => RuntimeHelper::BindClass,
        (DomBindingKind::Class, false) => RuntimeHelper::SetClass,
        (DomBindingKind::Style, true) => RuntimeHelper::BindStyle,
        (DomBindingKind::Style, false) => RuntimeHelper::SetStyle,
        (DomBindingKind::Spread, _) => RuntimeHelper::Spread,
    }
}
fn escape_text(value: &str, output: &mut String) {
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            _ => output.push(character),
        }
    }
}
fn escape_attribute(value: &str, output: &mut String) {
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '"' => output.push_str("&quot;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            _ => output.push(character),
        }
    }
}
fn valid_markup_name(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.' | b'$')
        })
}
pub fn parse_event_attribute(attribute: &str) -> Option<(String, bool, EventOptions)> {
    let (attribute, resumable_explicit) = match attribute.strip_suffix('$') {
        Some(attribute) => (attribute, true),
        None => (attribute, false),
    };
    if let Some(event) = attribute.strip_prefix("oncapture:") {
        return (!event.is_empty()).then_some((
            event.to_ascii_lowercase(),
            resumable_explicit,
            EventOptions {
                capture: true,
                ..EventOptions::default()
            },
        ));
    }
    if let Some(event) = attribute.strip_prefix("on:") {
        return (!event.is_empty()).then_some((
            event.to_ascii_lowercase(),
            resumable_explicit,
            EventOptions::default(),
        ));
    }
    let mut event = attribute.strip_prefix("on")?.to_owned();
    if !event.chars().next().is_some_and(char::is_uppercase) {
        return None;
    }
    let mut options = EventOptions::default();
    if let Some((known, suffix)) = ["GotPointerCapture", "LostPointerCapture"]
        .into_iter()
        .find_map(|known| event.strip_prefix(known).map(|suffix| (known, suffix)))
        && let Some(parsed) = parse_event_modifier_suffixes(suffix)
    {
        event = known.to_owned();
        options = parsed;
    } else {
        loop {
            if let Some(base) = event.strip_suffix("Capture") {
                event = base.to_owned();
                options.capture = true;
                continue;
            }
            if let Some(base) = event.strip_suffix("Passive") {
                event = base.to_owned();
                options.passive = true;
                continue;
            }
            if let Some(base) = event.strip_suffix("Once") {
                event = base.to_owned();
                options.once = true;
                continue;
            }
            break;
        }
    }
    (!event.is_empty()).then(|| (event.to_ascii_lowercase(), resumable_explicit, options))
}
fn parse_event_modifier_suffixes(mut suffix: &str) -> Option<EventOptions> {
    let mut options = EventOptions::default();
    while !suffix.is_empty() {
        if let Some(rest) = suffix.strip_prefix("Capture") {
            options.capture = true;
            suffix = rest;
        } else if let Some(rest) = suffix.strip_prefix("Passive") {
            options.passive = true;
            suffix = rest;
        } else {
            let rest = suffix.strip_prefix("Once")?;
            options.once = true;
            suffix = rest;
        }
    }
    Some(options)
}
fn creation_helper(kind: FunctionKind, macro_kind: FictMacroKind) -> RuntimeHelper {
    let scoped = matches!(
        kind,
        FunctionKind::Component | FunctionKind::Hook | FunctionKind::ReactiveScope
    );
    match (macro_kind, scoped) {
        (FictMacroKind::State, false) => RuntimeHelper::Signal,
        (FictMacroKind::State, true) => RuntimeHelper::UseSignal,
        (FictMacroKind::Memo, false) => RuntimeHelper::Memo,
        (FictMacroKind::Memo, true) => RuntimeHelper::UseMemo,
        (FictMacroKind::Effect, _) => unreachable!("effect has a dedicated helper"),
    }
}
fn is_runtime_helper_call(
    hir: &HirFile,
    call: &fict_hir::CallInstruction,
    helper: RuntimeHelper,
) -> bool {
    let CallHost::Binding(binding) = call.host else {
        return false;
    };
    let Some(import) = hir
        .bindings
        .get(binding.as_usize())
        .and_then(|binding| binding.import.as_ref())
    else {
        return false;
    };
    let ImportedName::Named(name) = &import.imported else {
        return false;
    };
    let spec = helper.spec();
    name == spec.export
        && [RuntimeFamily::Fict, RuntimeFamily::Runtime]
            .into_iter()
            .any(|family| import.source == spec.module_request(family))
}
fn function_value(function: &HirFunction, value: ValueId) -> Option<FunctionId> {
    match function.values.get(value.as_usize())?.kind {
        ValueKind::Function(function) => Some(function),
        _ => None,
    }
}
fn hook_return_accessor_reads(function: &HirFunction) -> BTreeSet<ValueId> {
    if function.kind != FunctionKind::Hook {
        return BTreeSet::new();
    }
    let mut visited = BTreeSet::new();
    let mut reads = BTreeSet::new();
    for value in function.blocks.iter().filter_map(|block| {
        let TerminatorKind::Return { value: Some(value) } = block.terminator.kind else {
            return None;
        };
        Some(value)
    }) {
        collect_hook_return_accessor_reads(function, value, &mut visited, &mut reads);
    }
    reads
}
fn collect_hook_return_accessor_reads(
    function: &HirFunction,
    value: ValueId,
    visited: &mut BTreeSet<ValueId>,
    reads: &mut BTreeSet<ValueId>,
) {
    if !visited.insert(value) {
        return;
    }
    let Some(instruction) = function.instruction_for_result(value) else {
        return;
    };
    match &instruction.kind {
        HirInstructionKind::Read { .. } | HirInstructionKind::Call(_) => {
            reads.insert(value);
        }
        HirInstructionKind::Object { entries } => {
            for entry in entries {
                let ObjectEntry::Property {
                    value,
                    kind: ObjectPropertyKind::Init,
                    prototype_setter: false,
                    ..
                } = entry
                else {
                    continue;
                };
                collect_hook_return_accessor_reads(function, *value, visited, reads);
            }
        }
        HirInstructionKind::Array { elements } => {
            for element in elements {
                let ArrayElement::Value(value) = element else {
                    continue;
                };
                collect_hook_return_accessor_reads(function, *value, visited, reads);
            }
        }
        HirInstructionKind::Conditional {
            consequent,
            alternate,
            ..
        } => {
            collect_hook_return_accessor_reads(function, *consequent, visited, reads);
            collect_hook_return_accessor_reads(function, *alternate, visited, reads);
        }
        HirInstructionKind::Sequence { values } => {
            for value in values {
                collect_hook_return_accessor_reads(function, *value, visited, reads);
            }
        }
        _ => {}
    }
}
fn effect_helper(kind: FunctionKind) -> RuntimeHelper {
    if matches!(
        kind,
        FunctionKind::Component | FunctionKind::Hook | FunctionKind::ReactiveScope
    ) {
        RuntimeHelper::UseEffect
    } else {
        RuntimeHelper::Effect
    }
}
fn place_local(base: PlaceBase) -> Option<LocalId> {
    match base {
        PlaceBase::Local(local) => Some(local),
        PlaceBase::Ssa(name) => Some(name.local),
        PlaceBase::Global(_) | PlaceBase::Value(_) => None,
    }
}
fn reassigned_locals(function: &HirFunction) -> BTreeSet<LocalId> {
    function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .flat_map(|instruction| match &instruction.kind {
            HirInstructionKind::Write { place, .. }
            | HirInstructionKind::ReadWrite { place, .. }
                if place.projections.is_empty() =>
            {
                place_local(place.base).into_iter().collect()
            }
            HirInstructionKind::PatternAssignment { writes, .. } => {
                writes.iter().map(|write| write.local).collect()
            }
            _ => Vec::new(),
        })
        .collect()
}
fn collect_captured_write_bindings(hir: &HirFile) -> BTreeSet<BindingId> {
    hir.functions
        .iter()
        .flat_map(|function| {
            let reassigned = reassigned_locals(function);
            function.locals.iter().filter_map(move |local| {
                (local.kind == LocalKind::Capture && reassigned.contains(&local.id))
                    .then_some(local.binding)
                    .flatten()
            })
        })
        .collect()
}
fn structured_hook_member_by_binding<'a>(
    function: &HirFunction,
    roots: &'a BTreeMap<BindingId, StructuredHookRootSite>,
    place: &fict_hir::Place,
) -> Option<(
    LocalId,
    &'a StructuredHookRootSite,
    ImportedHookPropertyMatch,
)> {
    let local = place_local(place.base)?;
    let binding = function.locals.get(local.as_usize())?.binding?;
    let root = roots.get(&binding)?;
    let property = root.shape.resolve_property(place.projections.first()?)?;
    Some((local, root, property))
}
fn imported_reactive_member(
    hir: &HirFile,
    function: &HirFunction,
    place: &fict_hir::Place,
) -> Option<(LocalId, BindingId, fict_hir::ImportedReactiveMemberMatch)> {
    let local = place_local(place.base)?;
    let binding = function.locals.get(local.as_usize())?.binding?;
    let resolved = hir
        .bindings
        .get(binding.as_usize())?
        .import
        .as_ref()?
        .resolve_reactive_member(&place.projections)?;
    Some((local, binding, resolved))
}
fn imported_hook_direct(
    hir: &HirFile,
    call: &fict_hir::CallInstruction,
) -> Option<(BindingId, ImportedReactiveKind)> {
    let (binding, shape) = imported_hook_return(hir, call)?;
    let kind = shape.direct_accessor?;
    Some((binding, kind))
}
fn imported_hook_return<'a>(
    hir: &'a HirFile,
    call: &fict_hir::CallInstruction,
) -> Option<(BindingId, &'a ImportedHookReturn)> {
    let CallHost::Binding(binding) = call.host else {
        return None;
    };
    let import = hir.bindings.get(binding.as_usize())?.import.as_ref()?;
    let shape = match call.callee_reference.as_ref() {
        Some(place) if !place.projections.is_empty() => {
            import.resolve_hook_member(&place.projections)?
        }
        Some(_) | None => import.hook_return.as_ref()?,
    };
    Some((binding, shape))
}
fn imported_hook_member(
    calls: &BTreeMap<ValueId, (BindingId, ImportedHookReturn, Origin)>,
    locals: &BTreeMap<LocalId, ValueId>,
    place: &fict_hir::Place,
) -> Option<(
    ValueId,
    Option<LocalId>,
    BindingId,
    ImportedHookPropertyMatch,
)> {
    let (call, local) = match place.base {
        PlaceBase::Value(value) => (value, None),
        PlaceBase::Local(local) => (*locals.get(&local)?, Some(local)),
        PlaceBase::Ssa(name) => (*locals.get(&name.local)?, Some(name.local)),
        PlaceBase::Global(_) => return None,
    };
    let (import, shape, _) = calls.get(&call)?;
    if shape.direct_accessor.is_some() {
        return None;
    }
    let property = shape.resolve_property(place.projections.first()?)?;
    Some((call, local, *import, property))
}
fn reject_imported_hook_member_mutation(
    calls: &BTreeMap<ValueId, (BindingId, ImportedHookReturn, Origin)>,
    locals: &BTreeMap<LocalId, ValueId>,
    place: &fict_hir::Place,
) -> Result<(), DiagnosticBundle> {
    let Some((_, _, _, property)) = imported_hook_member(calls, locals, place) else {
        return Ok(());
    };
    reject_hook_property_mutation(property, place)
}
fn reject_captured_hook_member_mutation(
    function: &HirFunction,
    function_id: FunctionId,
    roots: &BTreeMap<BindingId, StructuredHookRootSite>,
    place: &fict_hir::Place,
) -> Result<(), DiagnosticBundle> {
    let Some((_, root, property)) = structured_hook_member_by_binding(function, roots, place)
    else {
        return Ok(());
    };
    if root.owner == function_id {
        return Ok(());
    }
    reject_hook_property_mutation(property, place)
}
fn reject_hook_property_mutation(
    property: ImportedHookPropertyMatch,
    place: &fict_hir::Place,
) -> Result<(), DiagnosticBundle> {
    match property.kind {
        ImportedReactiveKind::Store => Ok(()),
        ImportedReactiveKind::Memo if place.projections.len() == 1 => {
            Err(DiagnosticBundle::new(vec![lower_error(
                "FICT-METADATA-READONLY",
                "cannot assign to a memo accessor returned by an imported hook",
                GuaranteeClass::Unsupported,
            )]))
        }
        ImportedReactiveKind::Signal | ImportedReactiveKind::Memo => {
            Err(DiagnosticBundle::new(vec![lower_error(
                "FICT-M",
                "mutating an imported hook return accessor member is not yet guaranteed",
                GuaranteeClass::Fallback,
            )]))
        }
    }
}
fn ensure_writable_hook_return(
    slots: &[ReactiveSlot],
    slot: EmitSlotId,
) -> Result<(), DiagnosticBundle> {
    if slots.get(slot.as_usize()).is_some_and(|slot| {
        slot.kind == ReactiveSlotKind::Memo
            && matches!(slot.storage, ReactiveSlotStorage::HookReturn { .. })
    }) {
        return Err(DiagnosticBundle::new(vec![lower_error(
            "FICT-METADATA-READONLY",
            "cannot assign to a memo accessor returned by an imported hook",
            GuaranteeClass::Unsupported,
        )]));
    }
    Ok(())
}
fn lower_value(value: ValueId, temporaries: &BTreeMap<ValueId, EmitTemporaryId>) -> EmitValueRef {
    temporaries
        .get(&value)
        .copied()
        .map_or(EmitValueRef::Hir(value), EmitValueRef::Temporary)
}
fn allocate_temporary(
    temporaries: &mut Vec<EmitTemporary>,
    names: &mut NameAllocator,
    preferred: String,
    origin: Origin,
) -> EmitTemporaryId {
    let id = EmitTemporaryId::new(count_u32(temporaries.len()));
    let name = names.allocate(&preferred);
    temporaries.push(EmitTemporary { id, name, origin });
    id
}
fn preserve(
    operations: &mut Vec<EmitOperation>,
    block: BlockId,
    instruction: usize,
    hir: &HirInstruction,
) {
    operations.push(EmitOperation::PreserveHir {
        block,
        instruction: count_u32(instruction),
        origin: hir.origin,
    });
}
fn reactive_site_origin(function: &HirFunction, result: ValueId) -> Origin {
    function
        .instruction_for_result(result)
        .map_or(function.origin, |instruction| instruction.origin)
}
fn lower_error(
    code: &'static str,
    message: impl Into<String>,
    guarantee: GuaranteeClass,
) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("lowering diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(guarantee)
}
fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
#[cfg(test)]
mod namespace_tests;
