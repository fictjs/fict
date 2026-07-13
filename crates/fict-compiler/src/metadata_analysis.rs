use std::collections::{BTreeMap, BTreeSet};

use fict_compiler_oxc::{FictReturnShape, FrontendSummary, ReactiveValueKind};
use fict_hir::{
    ArrayElement, BindingId, CallHost, FictMacroKind, FunctionId, FunctionKind, HirFile,
    HirFunction, HirInstructionKind, ImportedName, ModuleExport, ModuleLocalExport, ModulePlan,
    ObjectEntry, ObjectPropertyKind, PlaceBase, Projection, PropertyKey, ReactiveCallKind,
    TerminatorKind, ValueId,
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
    pub dependencies: Vec<String>,
    pub unresolved_requests: Vec<String>,
    pub incomplete: bool,
}

#[derive(Debug, Default)]
struct LocalMetadataFacts {
    exports: BTreeMap<BindingId, ReactiveExportKind>,
    hooks: BTreeMap<BindingId, HookReturnInfo>,
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
            dependencies: self.dependencies.into_iter().collect(),
            unresolved_requests: self.unresolved_requests.into_iter().collect(),
            incomplete: self.incomplete,
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
        let Some(metadata) = self.resolve(source) else {
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
        let Some(metadata) = self.resolve(source) else {
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
                    let namespace = core
                        .hir
                        .bindings
                        .get(binding.as_usize())
                        .and_then(|binding| binding.import.as_ref())
                        .filter(|import| import.imported == ImportedName::Namespace)
                        .and_then(|import| builder.resolve(&import.source));
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

    builder.finish()
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

    for function in &core.hir.functions {
        let Some(binding) = function.binding else {
            continue;
        };
        let annotation = function
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
            .map(hook_info_from_annotation);
        let inferred = function_analysis(core, function.id)
            .and_then(|analysis| infer_hook_return(function, analysis));
        if let Some(info) = annotation.or(inferred)
            && !hook_info_is_empty(&info)
        {
            facts.hooks.insert(binding, info);
        }
    }
    facts
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
        CallHost::ReactiveScope(host) => host.callee,
        CallHost::Function(_) | CallHost::Unknown => return None,
    };
    let import = file.bindings.get(binding.as_usize())?.import.as_ref()?;
    let imported = match &import.imported {
        ImportedName::Named(imported) => imported.as_str(),
        ImportedName::Namespace => namespace_call_member(function, call, binding)?,
        ImportedName::Default => return None,
    };
    runtime_creator_kind(&import.source, imported)
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

fn infer_hook_return(
    function: &HirFunction,
    analysis: &FunctionPassAnalysis,
) -> Option<HookReturnInfo> {
    if function.kind != FunctionKind::Hook {
        return None;
    }
    let mut infos = function.blocks.iter().filter_map(|block| {
        let TerminatorKind::Return { value: Some(value) } = block.terminator.kind else {
            return None;
        };
        hook_info_for_value(function, analysis, value)
    });
    let first = infos.next()?;
    infos.all(|info| info == first).then_some(first)
}

fn hook_info_for_value(
    function: &HirFunction,
    analysis: &FunctionPassAnalysis,
    value: ValueId,
) -> Option<HookReturnInfo> {
    if let Some(kind) = classify_value(function, analysis, value, &mut BTreeSet::new()) {
        return Some(HookReturnInfo {
            direct_accessor: Some(kind),
            ..HookReturnInfo::default()
        });
    }
    let instruction = defining_instruction(function, value)?;
    match &instruction.kind {
        HirInstructionKind::Object { entries } => {
            let mut object_props = BTreeMap::new();
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
                if let Some(kind) = classify_value(function, analysis, *value, &mut BTreeSet::new())
                {
                    object_props.insert(key, kind);
                }
            }
            (!object_props.is_empty()).then_some(HookReturnInfo {
                object_props,
                ..HookReturnInfo::default()
            })
        }
        HirInstructionKind::Array { elements } => {
            let mut array_props = BTreeMap::new();
            for (index, element) in elements.iter().enumerate() {
                let ArrayElement::Value(value) = element else {
                    continue;
                };
                if let Some(kind) = classify_value(function, analysis, *value, &mut BTreeSet::new())
                {
                    array_props.insert(index.to_string(), kind);
                }
            }
            (!array_props.is_empty()).then_some(HookReturnInfo {
                array_props,
                ..HookReturnInfo::default()
            })
        }
        _ => None,
    }
}

fn classify_value(
    function: &HirFunction,
    analysis: &FunctionPassAnalysis,
    value: ValueId,
    visited: &mut BTreeSet<ValueId>,
) -> Option<ReactiveExportKind> {
    if !visited.insert(value) {
        return None;
    }
    if let Some([path]) = analysis
        .dependencies
        .value_dependencies
        .get(value.as_usize())
        .map(Vec::as_slice)
        && path.segments.is_empty()
        && let DependencyBase::Ssa(name) = path.base
        && let Some(kind) = analysis
            .scopes
            .bindings
            .iter()
            .find(|fact| fact.name == name)
            .and_then(|fact| reactive_binding_kind(fact.kind))
    {
        return Some(kind);
    }
    let instruction = defining_instruction(function, value)?;
    match &instruction.kind {
        HirInstructionKind::Call(call) => classify_call(call),
        HirInstructionKind::Sequence { values } => values
            .last()
            .and_then(|value| classify_value(function, analysis, *value, visited)),
        HirInstructionKind::Conditional {
            consequent,
            alternate,
            ..
        } => {
            let consequent = classify_value(function, analysis, *consequent, visited)?;
            let alternate = classify_value(function, analysis, *alternate, visited)?;
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
        ImportedName::Default => "default",
        ImportedName::Named(name) => name,
        ImportedName::Namespace => "*",
    }
}
