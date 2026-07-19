use std::collections::{BTreeMap, BTreeSet};

use fict_compiler_oxc::{FictReturnShape, FrontendSummary, ReactiveValueKind};
use fict_diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use fict_hir::{
    ArrayElement, BinaryOperator, BindingId, CallHost, DeclarationKind, FictMacroKind, FunctionId,
    FunctionKind, HirFile, HirFunction, HirInstructionKind, ImportedHookReturn, ImportedName,
    ImportedReactiveKind, ImportedReactiveProperty, LiteralValue, ModuleExport, ModuleLocalExport,
    ModulePlan, ObjectEntry, ObjectPropertyKind, PlaceBase, Projection, PropertyKey,
    ReactiveCallKind, TerminatorKind, ValueId,
};
use fict_metadata::{
    HookReturnInfo, MetadataResolutionStatus, ModuleReactiveMetadata, ReactiveExportKind,
    ResolvedMetadataInput,
};
use fict_reactivity::{DependencyBase, ReactiveBindingKind};

use crate::{CorePassOutput, FunctionPassAnalysis};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MetadataGeneration {
    pub metadata: ModuleReactiveMetadata,
    pub local_hook_returns: BTreeMap<BindingId, ImportedHookReturn>,
    pub dependencies: Vec<String>,
    pub unresolved_requests: Vec<String>,
    pub incomplete: bool,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Default)]
struct LocalMetadataFacts {
    exports: BTreeMap<BindingId, ReactiveExportKind>,
    hooks: BTreeMap<BindingId, HookReturnInfo>,
    namespaces: BTreeMap<BindingId, ModuleReactiveMetadata>,
    diagnostics: Vec<Diagnostic>,
}

struct MetadataBuilder<'snapshot> {
    metadata: ModuleReactiveMetadata,
    explicit_names: BTreeSet<String>,
    star_names: BTreeSet<String>,
    dependencies: BTreeSet<String>,
    unresolved_requests: BTreeSet<String>,
    incomplete: bool,
    snapshot: BTreeMap<&'snapshot str, &'snapshot ResolvedMetadataInput>,
}

impl<'snapshot> MetadataBuilder<'snapshot> {
    fn new(snapshot: &'snapshot [ResolvedMetadataInput]) -> Self {
        Self {
            metadata: ModuleReactiveMetadata::new(),
            explicit_names: BTreeSet::new(),
            star_names: BTreeSet::new(),
            dependencies: BTreeSet::new(),
            unresolved_requests: BTreeSet::new(),
            incomplete: false,
            snapshot: snapshot
                .iter()
                .map(|entry| (entry.request.as_str(), entry))
                .collect(),
        }
    }

    fn finish(self) -> MetadataGeneration {
        MetadataGeneration {
            metadata: self.metadata,
            local_hook_returns: BTreeMap::new(),
            dependencies: self.dependencies.into_iter().collect(),
            unresolved_requests: self.unresolved_requests.into_iter().collect(),
            incomplete: self.incomplete,
            diagnostics: Vec::new(),
        }
    }

    fn mark_explicit(&mut self, exported: &str) {
        self.explicit_names.insert(exported.to_owned());
        self.metadata.exports.remove(exported);
        self.metadata.hooks.remove(exported);
        self.metadata.namespaces.remove(exported);
    }

    fn add_local(
        &mut self,
        exported: &str,
        kind: Option<ReactiveExportKind>,
        hook: Option<&HookReturnInfo>,
        namespace: Option<&ModuleReactiveMetadata>,
    ) {
        self.mark_explicit(exported);
        if let Some(kind) = kind {
            self.metadata.exports.insert(exported.to_owned(), kind);
        }
        if let Some(hook) = hook {
            self.metadata
                .hooks
                .insert(exported.to_owned(), hook.clone());
        }
        if let Some(namespace) = namespace {
            self.metadata
                .namespaces
                .insert(exported.to_owned(), namespace.clone());
        }
    }

    fn add_re_export(&mut self, exported: &str, source: &str, imported: &ImportedName) {
        self.mark_explicit(exported);
        let Some(metadata) = self.resolve_export(source) else {
            return;
        };
        if matches!(imported, ImportedName::Namespace) {
            self.metadata
                .namespaces
                .insert(exported.to_owned(), metadata.clone());
            return;
        }
        let imported = imported_key(imported);
        if let Some(kind) = metadata.exports.get(imported).copied() {
            self.metadata.exports.insert(exported.to_owned(), kind);
        }
        if let Some(hook) = metadata.hooks.get(imported).cloned() {
            self.metadata.hooks.insert(exported.to_owned(), hook);
        }
        if let Some(namespace) = metadata.namespaces.get(imported).cloned() {
            self.metadata
                .namespaces
                .insert(exported.to_owned(), namespace);
        }
    }

    fn add_star(&mut self, source: &str) {
        let Some(metadata) = self.resolve_export(source) else {
            return;
        };
        let mut names = BTreeSet::new();
        names.extend(metadata.exports.keys().cloned());
        names.extend(metadata.hooks.keys().cloned());
        names.extend(metadata.namespaces.keys().cloned());
        for exported in names {
            if exported == "default" || self.explicit_names.contains(&exported) {
                continue;
            }
            if !self.star_names.insert(exported.clone()) {
                self.metadata.exports.remove(&exported);
                self.metadata.hooks.remove(&exported);
                self.metadata.namespaces.remove(&exported);
                continue;
            }
            if let Some(kind) = metadata.exports.get(&exported).copied() {
                self.metadata.exports.insert(exported.clone(), kind);
            }
            if let Some(hook) = metadata.hooks.get(&exported).cloned() {
                self.metadata.hooks.insert(exported.clone(), hook);
            }
            if let Some(namespace) = metadata.namespaces.get(&exported).cloned() {
                self.metadata.namespaces.insert(exported, namespace);
            }
        }
    }

    fn resolve(&mut self, request: &str) -> Option<ModuleReactiveMetadata> {
        let Some(entry) = self.snapshot.get(request).copied() else {
            self.unresolved_requests.insert(request.to_owned());
            return None;
        };
        if let Some(resolved_id) = &entry.resolved_id {
            self.dependencies.insert(resolved_id.clone());
        }
        match entry.status {
            MetadataResolutionStatus::Resolved => entry.metadata.clone(),
            MetadataResolutionStatus::IncompleteCycle => {
                self.incomplete = true;
                self.unresolved_requests.insert(request.to_owned());
                None
            }
            MetadataResolutionStatus::Opaque | MetadataResolutionStatus::Missing => None,
        }
    }

    fn resolve_export(&mut self, request: &str) -> Option<ModuleReactiveMetadata> {
        let metadata = self.resolve(request);
        if metadata.is_none() {
            self.incomplete = true;
            self.unresolved_requests.insert(request.to_owned());
        }
        metadata
    }
}

pub(crate) fn generate_module_metadata(
    core: &CorePassOutput,
    module_plan: &ModulePlan,
    frontend: &FrontendSummary,
    snapshot: &[ResolvedMetadataInput],
) -> MetadataGeneration {
    let local = collect_local_facts(core, frontend);
    let root = &core.hir.functions[core.hir.root_function.as_usize()];
    let mut builder = MetadataBuilder::new(snapshot);

    for import in core
        .hir
        .bindings
        .iter()
        .filter_map(|binding| binding.import.as_ref())
        .filter(|import| {
            import.reactive.is_some()
                || !import.reactive_members.is_empty()
                || import.hook_return.is_some()
                || !import.hook_members.is_empty()
        })
    {
        let _ = builder.resolve(&import.source);
    }

    for export in &module_plan.exports {
        match export {
            ModuleExport::Local {
                exported,
                target,
                origin,
            } => match target {
                ModuleLocalExport::Binding(binding) => {
                    let imported_namespace = core
                        .hir
                        .bindings
                        .get(binding.as_usize())
                        .and_then(|binding| binding.import.as_ref())
                        .filter(|import| import.imported == ImportedName::Namespace)
                        .and_then(|import| builder.resolve(&import.source));
                    let namespace = local
                        .namespaces
                        .get(binding)
                        .cloned()
                        .or(imported_namespace);
                    builder.add_local(
                        exported,
                        local.exports.get(binding).copied(),
                        local.hooks.get(binding),
                        namespace.as_ref(),
                    );
                }
                ModuleLocalExport::DefaultExpression => builder.add_local(
                    exported,
                    classify_default_expression(&core.hir, root, *origin),
                    None,
                    None,
                ),
            },
            ModuleExport::ReExport {
                exported,
                source,
                imported,
                ..
            } => builder.add_re_export(exported, source, imported),
            ModuleExport::Star { source, .. } => builder.add_star(source),
        }
    }

    let mut generation = builder.finish();
    generation.local_hook_returns = local
        .hooks
        .iter()
        .map(|(binding, hook)| (*binding, imported_hook_return(hook)))
        .collect();
    generation.diagnostics = local.diagnostics;
    generation
}

pub(crate) fn infer_local_hook_returns(
    core: &CorePassOutput,
    frontend: &FrontendSummary,
) -> BTreeMap<BindingId, ImportedHookReturn> {
    collect_local_facts(core, frontend)
        .hooks
        .iter()
        .map(|(binding, hook)| (*binding, imported_hook_return(hook)))
        .collect()
}

fn imported_hook_return(info: &HookReturnInfo) -> ImportedHookReturn {
    ImportedHookReturn {
        direct_accessor: info.direct_accessor.as_ref().map(imported_reactive_kind),
        object_properties: info
            .object_props
            .iter()
            .map(|(key, kind)| ImportedReactiveProperty {
                key: key.clone(),
                kind: imported_reactive_kind(kind),
            })
            .collect(),
        array_properties: info
            .array_props
            .iter()
            .map(|(key, kind)| ImportedReactiveProperty {
                key: key.clone(),
                kind: imported_reactive_kind(kind),
            })
            .collect(),
    }
}

const fn imported_reactive_kind(kind: &ReactiveExportKind) -> ImportedReactiveKind {
    match kind {
        ReactiveExportKind::Signal => ImportedReactiveKind::Signal,
        ReactiveExportKind::Memo => ImportedReactiveKind::Memo,
        ReactiveExportKind::Store => ImportedReactiveKind::Store,
    }
}

fn collect_local_facts(core: &CorePassOutput, frontend: &FrontendSummary) -> LocalMetadataFacts {
    let mut facts = LocalMetadataFacts::default();
    let root = &core.hir.functions[core.hir.root_function.as_usize()];
    let Some(analysis) = function_analysis(core, core.hir.root_function) else {
        return facts;
    };
    let mut local_kinds = BTreeMap::new();
    for local in &root.locals {
        if let Some(kind) = classify_local(analysis, local.id)
            .or_else(|| classify_local_initializer(&core.hir, root, local.id, &mut BTreeSet::new()))
        {
            local_kinds.insert(local.id, kind);
        }
    }
    for _ in 0..=analysis.aliases.edges.len() {
        let previous = local_kinds.clone();
        for edge in &analysis.aliases.edges {
            if edge.alias.local == edge.source.local || local_kinds.contains_key(&edge.alias.local)
            {
                continue;
            }
            if previous.contains_key(&edge.source.local) {
                local_kinds.insert(edge.alias.local, ReactiveExportKind::Memo);
            }
        }
        if local_kinds == previous {
            break;
        }
    }
    for local in &root.locals {
        if let (Some(binding), Some(kind)) = (local.binding, local_kinds.get(&local.id).copied()) {
            facts.exports.insert(binding, kind);
        }
    }

    let reassigned = reassigned_bindings(&core.hir);
    let annotated_hooks: BTreeMap<_, _> = core
        .hir
        .functions
        .iter()
        .filter_map(|function| {
            let binding = function.binding?;
            if reassigned.contains(&binding) {
                return None;
            }
            Some((binding, hook_annotation(frontend, function)?))
        })
        .collect();
    let mut hooks = annotated_hooks.clone();
    for _ in 0..=core.hir.functions.len() {
        let mut next = annotated_hooks.clone();
        for function in &core.hir.functions {
            let Some(binding) = function.binding else {
                continue;
            };
            if annotated_hooks.contains_key(&binding) || reassigned.contains(&binding) {
                continue;
            }
            let Some(analysis) = function_analysis(core, function.id) else {
                continue;
            };
            let inference =
                infer_hook_return(&core.hir, function, analysis, &facts.exports, &hooks);
            if let Some(info) = inference.safe_info()
                && !hook_info_is_empty(info)
            {
                next.insert(binding, info.clone());
            }
        }
        if next == hooks {
            break;
        }
        hooks = next;
    }
    facts.hooks = hooks;
    for function in &core.hir.functions {
        let Some(binding) = function.binding else {
            continue;
        };
        if annotated_hooks.contains_key(&binding) || reassigned.contains(&binding) {
            continue;
        }
        let Some(analysis) = function_analysis(core, function.id) else {
            continue;
        };
        if let HookReturnInference::Conflict { slots, span, .. } =
            infer_hook_return(&core.hir, function, analysis, &facts.exports, &facts.hooks)
        {
            facts.diagnostics.push(hook_conflict_diagnostic(
                &core.hir, function, binding, &slots, span,
            ));
        }
    }
    facts.namespaces = collect_local_namespaces(frontend, &facts.exports, &facts.hooks);
    facts
}

fn reassigned_bindings(file: &HirFile) -> BTreeSet<BindingId> {
    file.functions
        .iter()
        .flat_map(|function| {
            function
                .blocks
                .iter()
                .flat_map(|block| &block.instructions)
                .flat_map(|instruction| match &instruction.kind {
                    HirInstructionKind::Write { place, .. }
                    | HirInstructionKind::ReadWrite { place, .. }
                        if place.projections.is_empty() =>
                    {
                        match place.base {
                            PlaceBase::Local(local) => vec![local],
                            PlaceBase::Ssa(name) => vec![name.local],
                            PlaceBase::Global(_) | PlaceBase::Value(_) => Vec::new(),
                        }
                    }
                    HirInstructionKind::Iteration { targets, .. } => targets.clone(),
                    HirInstructionKind::PatternAssignment { writes, .. } => {
                        writes.iter().map(|write| write.local).collect()
                    }
                    _ => Vec::new(),
                })
                .filter_map(|local| function.locals.get(local.as_usize())?.binding)
        })
        .collect()
}

fn collect_local_namespaces(
    frontend: &FrontendSummary,
    exports: &BTreeMap<BindingId, ReactiveExportKind>,
    hooks: &BTreeMap<BindingId, HookReturnInfo>,
) -> BTreeMap<BindingId, ModuleReactiveMetadata> {
    let mut members: BTreeMap<BindingId, Vec<_>> = BTreeMap::new();
    for member in &frontend.namespace_exports {
        members.entry(member.namespace).or_default().push(member);
    }
    let mut namespaces = BTreeMap::new();
    for namespace in members.keys().copied() {
        let metadata =
            build_local_namespace(namespace, &members, exports, hooks, &mut BTreeSet::new());
        if metadata_has_content(&metadata) {
            namespaces.insert(namespace, metadata);
        }
    }
    namespaces
}

fn build_local_namespace(
    namespace: BindingId,
    members: &BTreeMap<BindingId, Vec<&fict_compiler_oxc::FrontendNamespaceExport>>,
    exports: &BTreeMap<BindingId, ReactiveExportKind>,
    hooks: &BTreeMap<BindingId, HookReturnInfo>,
    visiting: &mut BTreeSet<BindingId>,
) -> ModuleReactiveMetadata {
    if !visiting.insert(namespace) {
        return ModuleReactiveMetadata::new();
    }
    let mut metadata = ModuleReactiveMetadata::new();
    for member in members.get(&namespace).into_iter().flatten() {
        if members.contains_key(&member.target) {
            let nested = build_local_namespace(member.target, members, exports, hooks, visiting);
            if metadata_has_content(&nested) {
                metadata.namespaces.insert(member.exported.clone(), nested);
            }
            continue;
        }
        if let Some(kind) = exports.get(&member.target).copied() {
            metadata.exports.insert(member.exported.clone(), kind);
        }
        if let Some(hook) = hooks.get(&member.target).cloned() {
            metadata.hooks.insert(member.exported.clone(), hook);
        }
    }
    visiting.remove(&namespace);
    metadata
}

fn metadata_has_content(metadata: &ModuleReactiveMetadata) -> bool {
    !metadata.exports.is_empty() || !metadata.hooks.is_empty() || !metadata.namespaces.is_empty()
}

fn classify_local(
    analysis: &FunctionPassAnalysis,
    local: fict_hir::LocalId,
) -> Option<ReactiveExportKind> {
    let kinds: BTreeSet<_> = analysis
        .scopes
        .bindings
        .iter()
        .filter(|fact| fact.name.local == local)
        .map(|fact| fact.kind)
        .collect();
    if kinds.contains(&ReactiveBindingKind::State) {
        Some(ReactiveExportKind::Signal)
    } else if kinds.contains(&ReactiveBindingKind::Store) {
        Some(ReactiveExportKind::Store)
    } else if kinds.iter().any(|kind| {
        matches!(
            kind,
            ReactiveBindingKind::Memo | ReactiveBindingKind::Alias | ReactiveBindingKind::Derived
        )
    }) {
        Some(ReactiveExportKind::Memo)
    } else {
        None
    }
}

fn classify_default_expression(
    file: &HirFile,
    function: &HirFunction,
    origin: fict_hir::Origin,
) -> Option<ReactiveExportKind> {
    function.blocks.iter().find_map(|block| {
        block.instructions.iter().find_map(|instruction| {
            (instruction.origin.primary_span == origin.primary_span)
                .then(|| match &instruction.kind {
                    HirInstructionKind::Call(call) => {
                        classify_call_with_import(file, function, call)
                    }
                    _ => None,
                })
                .flatten()
        })
    })
}

fn classify_call(call: &fict_hir::CallInstruction) -> Option<ReactiveExportKind> {
    match (call.macro_kind, call.reactive_kind) {
        (Some(FictMacroKind::State), _) => Some(ReactiveExportKind::Signal),
        (Some(FictMacroKind::Memo), _) => Some(ReactiveExportKind::Memo),
        (_, Some(ReactiveCallKind::Memo)) => Some(ReactiveExportKind::Memo),
        (_, Some(ReactiveCallKind::Store)) => Some(ReactiveExportKind::Store),
        _ => None,
    }
}

fn classify_local_initializer(
    file: &HirFile,
    function: &HirFunction,
    local: fict_hir::LocalId,
    visited: &mut BTreeSet<ValueId>,
) -> Option<ReactiveExportKind> {
    let initializer = function.blocks.iter().find_map(|block| {
        block
            .instructions
            .iter()
            .find_map(|instruction| match instruction.kind {
                HirInstructionKind::Declare {
                    local: candidate,
                    initializer,
                    ..
                } if candidate == local => initializer,
                _ => None,
            })
    })?;
    classify_creator_value(file, function, initializer, visited)
}

fn classify_creator_value(
    file: &HirFile,
    function: &HirFunction,
    value: ValueId,
    visited: &mut BTreeSet<ValueId>,
) -> Option<ReactiveExportKind> {
    if !visited.insert(value) {
        return None;
    }
    let instruction = defining_instruction(function, value)?;
    match &instruction.kind {
        HirInstructionKind::Call(call) => classify_call_with_import(file, function, call),
        HirInstructionKind::Sequence { values } => values
            .last()
            .and_then(|value| classify_creator_value(file, function, *value, visited)),
        HirInstructionKind::Conditional {
            consequent,
            alternate,
            ..
        } => {
            let consequent = classify_creator_value(file, function, *consequent, visited)?;
            let alternate = classify_creator_value(file, function, *alternate, visited)?;
            (consequent == alternate).then_some(consequent)
        }
        _ => None,
    }
}

fn classify_call_with_import(
    file: &HirFile,
    function: &HirFunction,
    call: &fict_hir::CallInstruction,
) -> Option<ReactiveExportKind> {
    if let Some(kind) = classify_call(call) {
        return Some(kind);
    }
    let binding = match call.host {
        CallHost::Binding(binding) => binding,
        CallHost::ReactiveScope(host) => host.callee?,
        CallHost::Function(_) | CallHost::Unknown => return None,
    };
    let import = file.bindings.get(binding.as_usize())?.import.as_ref()?;
    let hook = match call.callee_reference.as_ref() {
        Some(reference) if !reference.projections.is_empty() => {
            import.resolve_hook_member(&reference.projections)
        }
        Some(_) | None => import.hook_return.as_ref(),
    };
    if let Some(kind) = hook.and_then(|hook| hook.direct_accessor) {
        return Some(imported_reactive_export_kind(kind));
    }
    let imported = match &import.imported {
        ImportedName::Named(imported) => imported.as_str(),
        ImportedName::Namespace | ImportedName::ImportEquals => {
            namespace_call_member(function, call, binding)?
        }
        ImportedName::Default => return None,
    };
    runtime_creator_kind(&import.source, imported)
}

const fn imported_reactive_export_kind(kind: ImportedReactiveKind) -> ReactiveExportKind {
    match kind {
        ImportedReactiveKind::Signal => ReactiveExportKind::Signal,
        ImportedReactiveKind::Memo => ReactiveExportKind::Memo,
        ImportedReactiveKind::Store => ReactiveExportKind::Store,
    }
}

fn namespace_call_member<'function>(
    function: &'function HirFunction,
    call: &'function fict_hir::CallInstruction,
    expected_binding: BindingId,
) -> Option<&'function str> {
    let reference = call.callee_reference.as_ref()?;
    let local = match reference.base {
        PlaceBase::Local(local) => local,
        PlaceBase::Ssa(name) => name.local,
        PlaceBase::Global(_) | PlaceBase::Value(_) => return None,
    };
    if function.locals.get(local.as_usize())?.binding? != expected_binding {
        return None;
    }
    match reference.projections.last()? {
        Projection::StaticProperty { name, .. } => Some(name),
        Projection::ComputedProperty { .. } | Projection::Index { .. } => None,
    }
}

fn runtime_creator_kind(source: &str, imported: &str) -> Option<ReactiveExportKind> {
    let runtime_source = matches!(
        source,
        "fict"
            | "fict/advanced"
            | "fict/internal"
            | "fict/plus"
            | "fict/slim"
            | "@fictjs/runtime"
            | "@fictjs/runtime/advanced"
            | "@fictjs/runtime/internal"
    );
    if !runtime_source {
        return None;
    }
    match imported {
        "createSignal" => Some(ReactiveExportKind::Signal),
        "createMemo" | "$memo" => Some(ReactiveExportKind::Memo),
        "$store" => Some(ReactiveExportKind::Store),
        "createStore" if !matches!(source, "fict/internal" | "@fictjs/runtime/internal") => {
            Some(ReactiveExportKind::Store)
        }
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HookSlotShape {
    Plain,
    Accessor(ReactiveExportKind),
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum HookBranchShape {
    Direct(HookSlotShape),
    Object(BTreeMap<String, HookSlotShape>),
    Array(BTreeMap<String, HookSlotShape>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum HookReturnInference {
    None,
    Consistent(HookReturnInfo),
    Conflict {
        safe: HookReturnInfo,
        slots: Vec<String>,
        span: Option<SourceSpan>,
    },
}

impl HookReturnInference {
    fn safe_info(&self) -> Option<&HookReturnInfo> {
        let info = match self {
            Self::None => return None,
            Self::Consistent(info) | Self::Conflict { safe: info, .. } => info,
        };
        (!hook_info_is_empty(info)).then_some(info)
    }
}

fn infer_hook_return(
    file: &HirFile,
    function: &HirFunction,
    analysis: &FunctionPassAnalysis,
    known_bindings: &BTreeMap<BindingId, ReactiveExportKind>,
    known_hooks: &BTreeMap<BindingId, HookReturnInfo>,
) -> HookReturnInference {
    if function.kind != FunctionKind::Hook {
        return HookReturnInference::None;
    }
    let mut branches = Vec::new();
    let mut first_return_span = None;
    for block in &function.blocks {
        if !analysis
            .ssa
            .cfg
            .reachable
            .get(block.id.as_usize())
            .copied()
            .unwrap_or(false)
        {
            continue;
        }
        let TerminatorKind::Return { value } = block.terminator.kind else {
            continue;
        };
        first_return_span = first_return_span.or(block.terminator.origin.primary_span);
        match value {
            Some(value) => collect_hook_branch_shapes(
                file,
                function,
                analysis,
                known_bindings,
                known_hooks,
                value,
                &mut BTreeSet::new(),
                &mut branches,
            ),
            None => branches.push(HookBranchShape::Direct(HookSlotShape::Plain)),
        }
    }
    summarize_hook_branches(&branches, first_return_span)
}

#[allow(clippy::too_many_arguments)]
fn collect_hook_branch_shapes(
    file: &HirFile,
    function: &HirFunction,
    analysis: &FunctionPassAnalysis,
    known_bindings: &BTreeMap<BindingId, ReactiveExportKind>,
    known_hooks: &BTreeMap<BindingId, HookReturnInfo>,
    value: ValueId,
    visiting: &mut BTreeSet<ValueId>,
    branches: &mut Vec<HookBranchShape>,
) {
    if !visiting.insert(value) {
        branches.push(HookBranchShape::Direct(HookSlotShape::Plain));
        return;
    }
    if let Some(initializer) = stable_read_initializer(function, value) {
        collect_hook_branch_shapes(
            file,
            function,
            analysis,
            known_bindings,
            known_hooks,
            initializer,
            visiting,
            branches,
        );
        visiting.remove(&value);
        return;
    }
    let Some(instruction) = defining_instruction(function, value) else {
        branches.push(HookBranchShape::Direct(HookSlotShape::Plain));
        visiting.remove(&value);
        return;
    };
    match &instruction.kind {
        HirInstructionKind::Conditional {
            consequent,
            alternate,
            ..
        } => {
            collect_hook_branch_shapes(
                file,
                function,
                analysis,
                known_bindings,
                known_hooks,
                *consequent,
                visiting,
                branches,
            );
            collect_hook_branch_shapes(
                file,
                function,
                analysis,
                known_bindings,
                known_hooks,
                *alternate,
                visiting,
                branches,
            );
        }
        HirInstructionKind::Sequence { values } => {
            if let Some(value) = values.last() {
                collect_hook_branch_shapes(
                    file,
                    function,
                    analysis,
                    known_bindings,
                    known_hooks,
                    *value,
                    visiting,
                    branches,
                );
            } else {
                branches.push(HookBranchShape::Direct(HookSlotShape::Plain));
            }
        }
        HirInstructionKind::Call(call) => {
            if let Some(info) = hook_info_for_call(file, function, call, known_hooks) {
                branches.push(hook_branch_from_info(&info));
            } else {
                branches.push(HookBranchShape::Direct(hook_slot_for_value(
                    file,
                    function,
                    analysis,
                    known_bindings,
                    known_hooks,
                    value,
                    &mut BTreeSet::new(),
                )));
            }
        }
        HirInstructionKind::Object { entries } => {
            let mut properties = BTreeMap::new();
            for entry in entries {
                let ObjectEntry::Property {
                    key,
                    value,
                    kind: ObjectPropertyKind::Init,
                    prototype_setter: false,
                    ..
                } = entry
                else {
                    continue;
                };
                let key = match key {
                    PropertyKey::Static(key) => key.clone(),
                    PropertyKey::Index(index) => index.to_string(),
                    PropertyKey::Computed(_) => continue,
                };
                properties.insert(
                    key,
                    hook_slot_for_value(
                        file,
                        function,
                        analysis,
                        known_bindings,
                        known_hooks,
                        *value,
                        &mut BTreeSet::new(),
                    ),
                );
            }
            branches.push(HookBranchShape::Object(properties));
        }
        HirInstructionKind::Array { elements } => {
            let mut properties = BTreeMap::new();
            for (index, element) in elements.iter().enumerate() {
                let ArrayElement::Value(value) = element else {
                    continue;
                };
                properties.insert(
                    index.to_string(),
                    hook_slot_for_value(
                        file,
                        function,
                        analysis,
                        known_bindings,
                        known_hooks,
                        *value,
                        &mut BTreeSet::new(),
                    ),
                );
            }
            branches.push(HookBranchShape::Array(properties));
        }
        _ => branches.push(HookBranchShape::Direct(hook_slot_for_value(
            file,
            function,
            analysis,
            known_bindings,
            known_hooks,
            value,
            &mut BTreeSet::new(),
        ))),
    }
    visiting.remove(&value);
}

#[allow(clippy::too_many_arguments)]
fn hook_slot_for_value(
    file: &HirFile,
    function: &HirFunction,
    analysis: &FunctionPassAnalysis,
    known_bindings: &BTreeMap<BindingId, ReactiveExportKind>,
    known_hooks: &BTreeMap<BindingId, HookReturnInfo>,
    value: ValueId,
    visiting: &mut BTreeSet<ValueId>,
) -> HookSlotShape {
    if !visiting.insert(value) {
        return HookSlotShape::Plain;
    }
    if let Some(initializer) = stable_read_initializer(function, value) {
        let shape = hook_slot_for_value(
            file,
            function,
            analysis,
            known_bindings,
            known_hooks,
            initializer,
            visiting,
        );
        visiting.remove(&value);
        return shape;
    }
    let shape = match defining_instruction(function, value).map(|instruction| &instruction.kind) {
        Some(HirInstructionKind::Conditional {
            consequent,
            alternate,
            ..
        }) => merge_hook_slots(
            hook_slot_for_value(
                file,
                function,
                analysis,
                known_bindings,
                known_hooks,
                *consequent,
                visiting,
            ),
            hook_slot_for_value(
                file,
                function,
                analysis,
                known_bindings,
                known_hooks,
                *alternate,
                visiting,
            ),
        ),
        Some(HirInstructionKind::Sequence { values }) => {
            values.last().map_or(HookSlotShape::Plain, |value| {
                hook_slot_for_value(
                    file,
                    function,
                    analysis,
                    known_bindings,
                    known_hooks,
                    *value,
                    visiting,
                )
            })
        }
        Some(HirInstructionKind::Binary {
            operator:
                operator @ (BinaryOperator::LogicalAnd
                | BinaryOperator::LogicalOr
                | BinaryOperator::NullishCoalescing),
            left,
            right,
        }) => {
            let left_slot = hook_slot_for_value(
                file,
                function,
                analysis,
                known_bindings,
                known_hooks,
                *left,
                visiting,
            );
            let right_slot = hook_slot_for_value(
                file,
                function,
                analysis,
                known_bindings,
                known_hooks,
                *right,
                visiting,
            );
            match operator {
                BinaryOperator::LogicalAnd => match known_truthiness(function, *left, left_slot) {
                    Some(true) => right_slot,
                    Some(false) => left_slot,
                    None => merge_hook_slots(left_slot, right_slot),
                },
                BinaryOperator::LogicalOr => match known_truthiness(function, *left, left_slot) {
                    Some(true) => left_slot,
                    Some(false) => right_slot,
                    None => merge_hook_slots(left_slot, right_slot),
                },
                BinaryOperator::NullishCoalescing => {
                    match known_nullish(function, *left, left_slot) {
                        Some(true) => right_slot,
                        Some(false) => left_slot,
                        None => merge_hook_slots(left_slot, right_slot),
                    }
                }
                _ => unreachable!("matched logical operator"),
            }
        }
        Some(HirInstructionKind::Call(call)) => {
            hook_info_for_call(file, function, call, known_hooks)
                .and_then(|info| info.direct_accessor)
                .or_else(|| {
                    classify_value(
                        file,
                        function,
                        analysis,
                        known_bindings,
                        value,
                        &mut BTreeSet::new(),
                    )
                })
                .map_or(HookSlotShape::Plain, HookSlotShape::Accessor)
        }
        _ => classify_value(
            file,
            function,
            analysis,
            known_bindings,
            value,
            &mut BTreeSet::new(),
        )
        .map_or(HookSlotShape::Plain, HookSlotShape::Accessor),
    };
    visiting.remove(&value);
    shape
}

fn merge_hook_slots(left: HookSlotShape, right: HookSlotShape) -> HookSlotShape {
    if left == right {
        left
    } else {
        HookSlotShape::Conflict
    }
}

fn known_truthiness(function: &HirFunction, value: ValueId, slot: HookSlotShape) -> Option<bool> {
    if matches!(slot, HookSlotShape::Accessor(_)) {
        return Some(true);
    }
    static_truthiness(function, value, &mut BTreeSet::new())
}

fn static_truthiness(
    function: &HirFunction,
    value: ValueId,
    visiting: &mut BTreeSet<ValueId>,
) -> Option<bool> {
    if !visiting.insert(value) {
        return None;
    }
    if let Some(initializer) = stable_read_initializer(function, value) {
        let result = static_truthiness(function, initializer, visiting);
        visiting.remove(&value);
        return result;
    }
    let result = match &defining_instruction(function, value)?.kind {
        HirInstructionKind::Literal(literal) => match literal {
            LiteralValue::Null | LiteralValue::Undefined => Some(false),
            LiteralValue::Boolean(value) => Some(*value),
            LiteralValue::Number(value) => {
                let value = value.to_f64();
                Some(value != 0.0 && !value.is_nan())
            }
            LiteralValue::BigInt(value) => {
                Some(!value.trim_start_matches(['-', '+', '0']).is_empty())
            }
            LiteralValue::String(value) => Some(!value.is_empty()),
            LiteralValue::RegExp { .. } => Some(true),
        },
        HirInstructionKind::Array { .. }
        | HirInstructionKind::Object { .. }
        | HirInstructionKind::Function { .. } => Some(true),
        HirInstructionKind::Sequence { values } => values
            .last()
            .and_then(|value| static_truthiness(function, *value, visiting)),
        HirInstructionKind::Conditional {
            consequent,
            alternate,
            ..
        } => {
            let consequent = static_truthiness(function, *consequent, visiting)?;
            let alternate = static_truthiness(function, *alternate, visiting)?;
            (consequent == alternate).then_some(consequent)
        }
        _ => None,
    };
    visiting.remove(&value);
    result
}

fn known_nullish(function: &HirFunction, value: ValueId, slot: HookSlotShape) -> Option<bool> {
    if matches!(slot, HookSlotShape::Accessor(_)) {
        return Some(false);
    }
    static_nullish(function, value, &mut BTreeSet::new())
}

fn static_nullish(
    function: &HirFunction,
    value: ValueId,
    visiting: &mut BTreeSet<ValueId>,
) -> Option<bool> {
    if !visiting.insert(value) {
        return None;
    }
    if let Some(initializer) = stable_read_initializer(function, value) {
        let result = static_nullish(function, initializer, visiting);
        visiting.remove(&value);
        return result;
    }
    let result = match &defining_instruction(function, value)?.kind {
        HirInstructionKind::Literal(LiteralValue::Null | LiteralValue::Undefined) => Some(true),
        HirInstructionKind::Literal(_)
        | HirInstructionKind::Array { .. }
        | HirInstructionKind::Object { .. }
        | HirInstructionKind::Function { .. } => Some(false),
        HirInstructionKind::Sequence { values } => values
            .last()
            .and_then(|value| static_nullish(function, *value, visiting)),
        HirInstructionKind::Conditional {
            consequent,
            alternate,
            ..
        } => {
            let consequent = static_nullish(function, *consequent, visiting)?;
            let alternate = static_nullish(function, *alternate, visiting)?;
            (consequent == alternate).then_some(consequent)
        }
        _ => None,
    };
    visiting.remove(&value);
    result
}

fn stable_read_initializer(function: &HirFunction, value: ValueId) -> Option<ValueId> {
    let HirInstructionKind::Read { place } = &defining_instruction(function, value)?.kind else {
        return None;
    };
    if !place.projections.is_empty() {
        return None;
    }
    if let PlaceBase::Value(value) = place.base {
        return Some(value);
    }
    let local = match place.base {
        PlaceBase::Local(local) => local,
        PlaceBase::Ssa(name) => name.local,
        PlaceBase::Global(_) | PlaceBase::Value(_) => return None,
    };
    if function.locals.get(local.as_usize())?.declaration_kind != DeclarationKind::Const {
        return None;
    }
    function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find_map(|instruction| match instruction.kind {
            HirInstructionKind::Declare {
                local: declared,
                initializer,
                ..
            } if declared == local => initializer,
            _ => None,
        })
}

fn hook_branch_from_info(info: &HookReturnInfo) -> HookBranchShape {
    if let Some(kind) = info.direct_accessor {
        return HookBranchShape::Direct(HookSlotShape::Accessor(kind));
    }
    if !info.object_props.is_empty() {
        return HookBranchShape::Object(
            info.object_props
                .iter()
                .map(|(key, kind)| (key.clone(), HookSlotShape::Accessor(*kind)))
                .collect(),
        );
    }
    if !info.array_props.is_empty() {
        return HookBranchShape::Array(
            info.array_props
                .iter()
                .map(|(key, kind)| (key.clone(), HookSlotShape::Accessor(*kind)))
                .collect(),
        );
    }
    HookBranchShape::Direct(HookSlotShape::Plain)
}

fn summarize_hook_branches(
    branches: &[HookBranchShape],
    span: Option<SourceSpan>,
) -> HookReturnInference {
    if branches.is_empty() {
        return HookReturnInference::None;
    }
    let mut info = HookReturnInfo::default();
    let mut conflicts = Vec::new();

    let direct_relevant = branches.iter().any(|branch| {
        matches!(
            branch,
            HookBranchShape::Direct(HookSlotShape::Accessor(_) | HookSlotShape::Conflict)
        )
    });
    if direct_relevant {
        match consistent_hook_slot(branches.iter().map(|branch| match branch {
            HookBranchShape::Direct(slot) => *slot,
            HookBranchShape::Object(_) | HookBranchShape::Array(_) => HookSlotShape::Plain,
        })) {
            Ok(Some(kind)) => info.direct_accessor = Some(kind),
            Ok(None) => {}
            Err(()) => conflicts.push("the return value".to_owned()),
        }
    }

    let object_keys: BTreeSet<_> = branches
        .iter()
        .filter_map(|branch| match branch {
            HookBranchShape::Object(properties) => Some(properties),
            HookBranchShape::Direct(_) | HookBranchShape::Array(_) => None,
        })
        .flat_map(|properties| properties.iter())
        .filter_map(|(key, slot)| {
            matches!(slot, HookSlotShape::Accessor(_) | HookSlotShape::Conflict)
                .then_some(key.clone())
        })
        .collect();
    for key in object_keys {
        match consistent_hook_slot(branches.iter().map(|branch| {
            match branch {
                HookBranchShape::Object(properties) => properties
                    .get(&key)
                    .copied()
                    .unwrap_or(HookSlotShape::Plain),
                HookBranchShape::Direct(_) | HookBranchShape::Array(_) => HookSlotShape::Plain,
            }
        })) {
            Ok(Some(kind)) => {
                info.object_props.insert(key, kind);
            }
            Ok(None) => {}
            Err(()) => conflicts.push(format!("{key:?}")),
        }
    }

    let array_keys: BTreeSet<_> = branches
        .iter()
        .filter_map(|branch| match branch {
            HookBranchShape::Array(properties) => Some(properties),
            HookBranchShape::Direct(_) | HookBranchShape::Object(_) => None,
        })
        .flat_map(|properties| properties.iter())
        .filter_map(|(key, slot)| {
            matches!(slot, HookSlotShape::Accessor(_) | HookSlotShape::Conflict)
                .then_some(key.clone())
        })
        .collect();
    for key in array_keys {
        match consistent_hook_slot(branches.iter().map(|branch| {
            match branch {
                HookBranchShape::Array(properties) => properties
                    .get(&key)
                    .copied()
                    .unwrap_or(HookSlotShape::Plain),
                HookBranchShape::Direct(_) | HookBranchShape::Object(_) => HookSlotShape::Plain,
            }
        })) {
            Ok(Some(kind)) => {
                info.array_props.insert(key, kind);
            }
            Ok(None) => {}
            Err(()) => conflicts.push(format!("[{key}]")),
        }
    }

    if conflicts.is_empty() {
        if hook_info_is_empty(&info) {
            HookReturnInference::None
        } else {
            HookReturnInference::Consistent(info)
        }
    } else {
        HookReturnInference::Conflict {
            safe: info,
            slots: conflicts,
            span,
        }
    }
}

fn consistent_hook_slot(
    slots: impl IntoIterator<Item = HookSlotShape>,
) -> Result<Option<ReactiveExportKind>, ()> {
    let mut accessor = None;
    let mut saw_plain = false;
    for slot in slots {
        match slot {
            HookSlotShape::Plain => saw_plain = true,
            HookSlotShape::Accessor(kind) => {
                if accessor.is_some_and(|current| current != kind) {
                    return Err(());
                }
                accessor = Some(kind);
            }
            HookSlotShape::Conflict => return Err(()),
        }
    }
    if accessor.is_some() && saw_plain {
        Err(())
    } else {
        Ok(accessor)
    }
}

fn hook_info_for_call(
    file: &HirFile,
    _function: &HirFunction,
    call: &fict_hir::CallInstruction,
    known_hooks: &BTreeMap<BindingId, HookReturnInfo>,
) -> Option<HookReturnInfo> {
    let binding = match call.host {
        CallHost::Function(function) => file.functions.get(function.as_usize())?.binding?,
        CallHost::Binding(binding) => binding,
        CallHost::ReactiveScope(host) => host.callee?,
        CallHost::Unknown => return None,
    };
    if let Some(info) = known_hooks.get(&binding) {
        return Some(info.clone());
    }
    let import = file.bindings.get(binding.as_usize())?.import.as_ref()?;
    let hook = match call.callee_reference.as_ref() {
        Some(reference) if !reference.projections.is_empty() => {
            import.resolve_hook_member(&reference.projections)
        }
        Some(_) | None => import.hook_return.as_ref(),
    }?;
    Some(hook_info_from_imported(hook))
}

fn hook_info_from_imported(hook: &ImportedHookReturn) -> HookReturnInfo {
    HookReturnInfo {
        direct_accessor: hook.direct_accessor.map(imported_reactive_export_kind),
        object_props: hook
            .object_properties
            .iter()
            .map(|property| {
                (
                    property.key.clone(),
                    imported_reactive_export_kind(property.kind),
                )
            })
            .collect(),
        array_props: hook
            .array_properties
            .iter()
            .map(|property| {
                (
                    property.key.clone(),
                    imported_reactive_export_kind(property.kind),
                )
            })
            .collect(),
    }
}

fn classify_value(
    file: &HirFile,
    function: &HirFunction,
    analysis: &FunctionPassAnalysis,
    known_bindings: &BTreeMap<BindingId, ReactiveExportKind>,
    value: ValueId,
    visited: &mut BTreeSet<ValueId>,
) -> Option<ReactiveExportKind> {
    if !visited.insert(value) {
        return None;
    }
    let instruction = defining_instruction(function, value)?;
    if let HirInstructionKind::Read { place } = &instruction.kind
        && place.projections.is_empty()
        && let Some(local) = match place.base {
            PlaceBase::Local(local) => Some(local),
            PlaceBase::Ssa(name) => Some(name.local),
            PlaceBase::Global(_) | PlaceBase::Value(_) => None,
        }
        && let Some(kind) = function
            .locals
            .get(local.as_usize())
            .and_then(|local| local.binding)
            .and_then(|binding| known_bindings.get(&binding).copied())
    {
        return Some(kind);
    }
    if let Some([path]) = analysis
        .dependencies
        .value_dependencies
        .get(value.as_usize())
        .map(Vec::as_slice)
        && path.segments.is_empty()
        && let DependencyBase::Ssa(name) = path.base
        && matches!(&instruction.kind, HirInstructionKind::Read { .. })
        && let Some(kind) = analysis
            .scopes
            .bindings
            .iter()
            .find(|fact| fact.name == name)
            .and_then(|fact| reactive_binding_kind(fact.kind))
    {
        return Some(kind);
    }
    match &instruction.kind {
        HirInstructionKind::Call(call) => classify_call_with_import(file, function, call),
        HirInstructionKind::Sequence { values } => values.last().and_then(|value| {
            classify_value(file, function, analysis, known_bindings, *value, visited)
        }),
        HirInstructionKind::Conditional {
            consequent,
            alternate,
            ..
        } => {
            let consequent = classify_value(
                file,
                function,
                analysis,
                known_bindings,
                *consequent,
                visited,
            )?;
            let alternate = classify_value(
                file,
                function,
                analysis,
                known_bindings,
                *alternate,
                visited,
            )?;
            (consequent == alternate).then_some(consequent)
        }
        _ => None,
    }
}

fn defining_instruction(
    function: &HirFunction,
    value: ValueId,
) -> Option<&fict_hir::HirInstruction> {
    function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find(|instruction| instruction.result == Some(value))
}

fn reactive_binding_kind(kind: ReactiveBindingKind) -> Option<ReactiveExportKind> {
    match kind {
        ReactiveBindingKind::State => Some(ReactiveExportKind::Signal),
        ReactiveBindingKind::Store => Some(ReactiveExportKind::Store),
        ReactiveBindingKind::Memo | ReactiveBindingKind::Alias | ReactiveBindingKind::Derived => {
            Some(ReactiveExportKind::Memo)
        }
        ReactiveBindingKind::Resource | ReactiveBindingKind::Selector => None,
    }
}

fn function_analysis(core: &CorePassOutput, function: FunctionId) -> Option<&FunctionPassAnalysis> {
    core.functions
        .iter()
        .find(|analysis| analysis.function == function)
}

fn hook_annotation(frontend: &FrontendSummary, function: &HirFunction) -> Option<HookReturnInfo> {
    function
        .origin
        .primary_span
        .and_then(|span| {
            frontend
                .source_facts
                .fict_returns
                .iter()
                .find(|annotation| annotation.attached_to == span.start())
        })
        .and_then(|annotation| annotation.shape.as_ref())
        .map(hook_info_from_annotation)
}

fn hook_conflict_diagnostic(
    file: &HirFile,
    function: &HirFunction,
    binding: BindingId,
    slots: &[String],
    span: Option<SourceSpan>,
) -> Diagnostic {
    let hook_name = file
        .bindings
        .get(binding.as_usize())
        .map_or("<anonymous hook>", |binding| binding.display_name.as_str());
    let mut diagnostic = Diagnostic::new(
        DiagnosticCode::new("FICT-H002").expect("hook conflict diagnostic literal"),
        DiagnosticSeverity::Warning,
        format!(
            "Hook {hook_name:?} returns {} with an inconsistent shape across branches; each slot must consistently be a plain value or the same reactive accessor kind",
            slots.join(", ")
        ),
    )
    .with_help(
        "return a plain value from every branch or return the same signal, memo, or store shape from every branch",
    )
    .with_guarantee_class(GuaranteeClass::Fallback);
    if let Some(primary) = span.or(function.origin.primary_span) {
        diagnostic = diagnostic.with_primary_span(primary);
    }
    if let Some(declaration) = function.origin.primary_span
        && Some(declaration) != span
    {
        diagnostic = diagnostic.with_secondary_label(declaration, "hook declared here");
    }
    diagnostic
}

fn hook_info_from_annotation(shape: &FictReturnShape) -> HookReturnInfo {
    match shape {
        FictReturnShape::Direct(kind) => HookReturnInfo {
            direct_accessor: Some(reactive_value_kind(*kind)),
            ..HookReturnInfo::default()
        },
        FictReturnShape::Object(properties) => HookReturnInfo {
            object_props: properties
                .iter()
                .map(|(name, kind)| (name.clone(), reactive_value_kind(*kind)))
                .collect(),
            ..HookReturnInfo::default()
        },
        FictReturnShape::Array(properties) => HookReturnInfo {
            array_props: properties
                .iter()
                .map(|(index, kind)| (index.to_string(), reactive_value_kind(*kind)))
                .collect(),
            ..HookReturnInfo::default()
        },
    }
}

fn reactive_value_kind(kind: ReactiveValueKind) -> ReactiveExportKind {
    match kind {
        ReactiveValueKind::Signal => ReactiveExportKind::Signal,
        ReactiveValueKind::Memo => ReactiveExportKind::Memo,
        ReactiveValueKind::Store => ReactiveExportKind::Store,
    }
}

fn hook_info_is_empty(info: &HookReturnInfo) -> bool {
    info.object_props.is_empty() && info.array_props.is_empty() && info.direct_accessor.is_none()
}

fn imported_key(imported: &ImportedName) -> &str {
    match imported {
        ImportedName::Default | ImportedName::ImportEquals => "default",
        ImportedName::Named(name) => name,
        ImportedName::Namespace => "*",
    }
}
