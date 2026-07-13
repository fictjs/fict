use std::collections::BTreeSet;

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_hir::HirFile;
use fict_reactivity::RegionAnalysis;
use fict_reactivity::{analyze_cfg, verify_structurized_cfg};

use crate::{
    CleanupOwner, DomNamespace, EmitOperation, EmitProgram, EmitValueRef, RuntimeHelper,
    RuntimeHelperStability, verify_runtime_abi,
};

/// Verify EmitIR helper, slot/temp, region/template, cleanup, and rejection invariants.
pub fn verify_emit_program(
    hir: &HirFile,
    analyses: &[RegionAnalysis],
    program: &EmitProgram,
) -> Result<(), DiagnosticBundle> {
    let mut diagnostics = DiagnosticBundle::default();
    if verify_runtime_abi().is_err() {
        diagnostics.push(emit_error(
            "FICT-EMIT-ABI",
            "runtime ABI registry is inconsistent",
        ));
    }
    if program.strict_rejected
        && (!program.imports.is_empty()
            || program
                .functions
                .iter()
                .any(|function| !function.operations.is_empty()))
    {
        diagnostics.push(emit_error(
            "FICT-EMIT-REJECTED",
            "strict-rejected modules cannot contain partial output",
        ));
    }
    if program.functions.len() != hir.functions.len()
        || analyses.len() != hir.functions.len()
        || program
            .functions
            .iter()
            .enumerate()
            .any(|(index, function)| function.source.as_usize() != index)
    {
        diagnostics.push(emit_error(
            "FICT-EMIT-FUNCTION",
            "EmitIR functions must match the HIR function arena",
        ));
    }
    verify_module_plan(hir, program, &mut diagnostics);
    verify_imports(program, &mut diagnostics);
    let import_names: BTreeSet<_> = program
        .imports
        .iter()
        .map(|intent| intent.local.as_str())
        .collect();
    let source_names: BTreeSet<_> = hir
        .bindings
        .iter()
        .map(|binding| binding.display_name.as_str())
        .chain(hir.functions.iter().flat_map(|function| {
            function
                .locals
                .iter()
                .filter_map(|local| local.debug_name.as_deref())
        }))
        .collect();
    if import_names.iter().any(|name| source_names.contains(name)) {
        diagnostics.push(emit_error(
            "FICT-EMIT-IMPORT-COLLISION",
            "generated runtime import locals must not collide with any source binding",
        ));
    }
    for function in &program.functions {
        let Some(hir_function) = hir.functions.get(function.source.as_usize()) else {
            continue;
        };
        let analysis = analyses.get(function.source.as_usize());
        for (index, slot) in function.slots.iter().enumerate() {
            if slot.id.as_usize() != index
                || slot.control_path.windows(2).any(|pair| pair[0] >= pair[1])
            {
                diagnostics.push(emit_error(
                    "FICT-EMIT-SLOT",
                    "reactive slots must be dense with canonical control paths",
                ));
            }
            if let crate::ReactiveSlotStorage::Captured { owner } = slot.storage {
                let capture_valid = owner != function.source
                    && slot.binding.is_some()
                    && program
                        .functions
                        .get(owner.as_usize())
                        .is_some_and(|owner| {
                            owner.slots.iter().any(|candidate| {
                                candidate.storage == crate::ReactiveSlotStorage::Owned
                                    && candidate.binding == slot.binding
                                    && candidate.kind == slot.kind
                            })
                        });
                if !capture_valid {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-CAPTURE",
                        "captured reactive slots must reference an owned slot with the same binding and kind",
                    ));
                }
            }
        }
        let mut temporary_names = BTreeSet::new();
        for (index, temporary) in function.temporaries.iter().enumerate() {
            if temporary.id.as_usize() != index
                || !valid_identifier(&temporary.name)
                || !temporary_names.insert(temporary.name.as_str())
                || import_names.contains(temporary.name.as_str())
                || source_names.contains(temporary.name.as_str())
            {
                diagnostics.push(emit_error(
                    "FICT-EMIT-TEMP",
                    "temporaries must be dense, unique identifiers without import collisions",
                ));
            }
        }
        let needs_context = function
            .operations
            .iter()
            .filter_map(EmitOperation::helper)
            .any(is_scoped_helper);
        match &function.context {
            Some(context)
                if !needs_context
                    || context.helper != RuntimeHelper::UseContext
                    || context.origin != hir_function.origin
                    || !valid_identifier(&context.local)
                    || import_names.contains(context.local.as_str())
                    || source_names.contains(context.local.as_str())
                    || temporary_names.contains(context.local.as_str()) =>
            {
                diagnostics.push(emit_error(
                    "FICT-EMIT-CONTEXT",
                    "function context must be collision-free and exactly match scoped helper use",
                ));
            }
            None if needs_context => diagnostics.push(emit_error(
                "FICT-EMIT-CONTEXT",
                "scoped runtime helpers require a function context plan",
            )),
            Some(_) | None => {}
        }
        if function.regions.windows(2).any(|pair| pair[0] >= pair[1])
            || function.regions.iter().any(|region| {
                analysis.is_none_or(|analysis| analysis.regions.get(region.as_usize()).is_none())
            })
            || analysis.is_some_and(|analysis| function.regions != analysis.top_level_regions)
        {
            diagnostics.push(emit_error(
                "FICT-EMIT-REGION",
                "function regions must be sorted known analysis regions",
            ));
        }
        match analyze_cfg(hir_function)
            .and_then(|cfg| verify_structurized_cfg(hir_function, &cfg, &function.control_flow))
        {
            Ok(()) => {}
            Err(bundle) => {
                for diagnostic in bundle.as_slice() {
                    diagnostics.push(diagnostic.clone());
                }
            }
        }
        verify_operations(hir, hir_function, function, analysis, &mut diagnostics);
    }
    if diagnostics.is_empty() {
        Ok(())
    } else {
        Err(diagnostics)
    }
}

fn verify_imports(program: &EmitProgram, diagnostics: &mut DiagnosticBundle) {
    let used: BTreeSet<_> = program
        .functions
        .iter()
        .flat_map(|function| {
            function
                .operations
                .iter()
                .flat_map(|operation| operation.helper_slots().into_iter().flatten())
                .chain(function.context.iter().map(|context| context.helper))
        })
        .collect();
    let imported: BTreeSet<_> = program.imports.iter().map(|intent| intent.helper).collect();
    if imported != used
        || imported.len() != program.imports.len()
        || program
            .imports
            .windows(2)
            .any(|pair| pair[0].helper >= pair[1].helper)
    {
        diagnostics.push(emit_error(
            "FICT-EMIT-IMPORTS",
            "runtime imports must exactly match used helpers in ABI order",
        ));
    }
    let mut names = BTreeSet::new();
    for intent in &program.imports {
        let spec = intent.helper.spec();
        if !valid_identifier(&intent.local) || !names.insert(intent.local.as_str()) {
            diagnostics.push(emit_error(
                "FICT-EMIT-IMPORT-NAME",
                "runtime import locals must be unique valid identifiers",
            ));
        }
        if intent.imported != spec.export
            || intent.module_request != spec.module_request(program.runtime_family)
            || !program.module.reserved_names.contains(&intent.local)
        {
            diagnostics.push(emit_error(
                "FICT-EMIT-IMPORT-ABI",
                "runtime import source/export must match its ABI family and reserve its local",
            ));
        }
        if !program.preview && intent.helper.spec().stability == RuntimeHelperStability::Preview {
            diagnostics.push(emit_error(
                "FICT-EMIT-PREVIEW",
                "Core EmitIR cannot import a Preview-only helper",
            ));
        }
    }
}

fn verify_module_plan(hir: &HirFile, program: &EmitProgram, diagnostics: &mut DiagnosticBundle) {
    if program
        .module
        .reserved_names
        .windows(2)
        .any(|pair| pair[0] >= pair[1])
        || program.module.reserved_names.iter().any(String::is_empty)
    {
        diagnostics.push(emit_error(
            "FICT-EMIT-MODULE-NAMES",
            "module reserved names must be non-empty, sorted, and unique",
        ));
    }
    let expected_fragment = hir
        .functions
        .get(hir.root_function.as_usize())
        .and_then(|function| {
            function
                .blocks
                .iter()
                .flat_map(|block| &block.instructions)
                .rev()
                .find_map(|instruction| match instruction.kind {
                    fict_hir::HirInstructionKind::SyntaxFragment { fragment, .. }
                        if instruction.result.is_none() =>
                    {
                        Some(fragment)
                    }
                    _ => None,
                })
        });
    if program.module.source_fragment != expected_fragment
        || program.module.source_fragment.is_some_and(|fragment| {
            hir.syntax_fragments
                .get(fragment.as_usize())
                .is_none_or(|fragment| fragment.kind != fict_hir::SyntaxFragmentKind::Statement)
        })
    {
        diagnostics.push(emit_error(
            "FICT-EMIT-MODULE-SOURCE",
            "module plan must preserve the root adapter-owned statement fragment",
        ));
    }
    let required_names = hir
        .bindings
        .iter()
        .map(|binding| binding.display_name.as_str())
        .chain(hir.functions.iter().flat_map(|function| {
            function
                .locals
                .iter()
                .filter_map(|local| local.debug_name.as_deref())
        }))
        .chain(program.functions.iter().flat_map(|function| {
            function
                .temporaries
                .iter()
                .map(|temporary| temporary.name.as_str())
                .chain(
                    function
                        .context
                        .iter()
                        .map(|context| context.local.as_str()),
                )
                .chain(
                    function
                        .operations
                        .iter()
                        .filter_map(|operation| match operation {
                            EmitOperation::DeclareTemplate { local, .. } => Some(local.as_str()),
                            _ => None,
                        }),
                )
        }));
    if required_names.into_iter().any(|name| {
        !program
            .module
            .reserved_names
            .iter()
            .any(|item| item == name)
    }) {
        diagnostics.push(emit_error(
            "FICT-EMIT-MODULE-NAMES",
            "module name plan must reserve every source binding and generated temporary",
        ));
    }
}

fn is_scoped_helper(helper: RuntimeHelper) -> bool {
    matches!(
        helper,
        RuntimeHelper::UseSignal | RuntimeHelper::UseMemo | RuntimeHelper::UseEffect
    )
}

fn verify_operations(
    hir: &HirFile,
    hir_function: &fict_hir::HirFunction,
    function: &crate::EmitFunction,
    analysis: Option<&RegionAnalysis>,
    diagnostics: &mut DiagnosticBundle,
) {
    let mut defined = BTreeSet::new();
    let mut templates = BTreeSet::new();
    for operation in &function.operations {
        verify_helper_semantics(function, operation, diagnostics);
        operation.visit_values(|value| {
            let valid = match value {
                EmitValueRef::Hir(value) => hir_function.values.get(value.as_usize()).is_some(),
                EmitValueRef::Ssa(name) => hir_function.locals.get(name.local.as_usize()).is_some(),
                EmitValueRef::Slot(slot) => function.slots.get(slot.as_usize()).is_some(),
                EmitValueRef::Temporary(temporary) => defined.contains(temporary),
                EmitValueRef::Literal(_) => true,
                EmitValueRef::Function(function) => {
                    hir.functions.get(function.as_usize()).is_some()
                }
                EmitValueRef::Binding(binding) => hir.bindings.get(binding.as_usize()).is_some(),
            };
            if !valid {
                diagnostics.push(emit_error(
                    "FICT-EMIT-VALUE",
                    "value references an unknown or not-yet-defined arena entry",
                ));
            }
        });
        operation.visit_temporary_uses(|temporary| {
            if !defined.contains(&temporary) {
                diagnostics.push(emit_error(
                    "FICT-EMIT-TEMP-USE",
                    "temporary must be defined before use",
                ));
            }
        });
        if let Some(temporary) = operation.defined_temporary()
            && (!defined.insert(temporary)
                || function.temporaries.get(temporary.as_usize()).is_none())
        {
            diagnostics.push(emit_error(
                "FICT-EMIT-TEMP-DEF",
                "temporary must be declared and defined exactly once",
            ));
        }
        match operation {
            EmitOperation::PreserveHir {
                block, instruction, ..
            } => {
                if hir_function
                    .blocks
                    .get(block.as_usize())
                    .and_then(|block| block.instructions.get(*instruction as usize))
                    .is_none()
                {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-HIR",
                        "preserved HIR location is invalid",
                    ));
                }
            }
            EmitOperation::CreateReactive {
                slot,
                source_result,
                ..
            }
            | EmitOperation::ReadReactive {
                slot,
                source_result,
                ..
            } => {
                verify_slot(function, *slot, diagnostics);
                verify_source_result(hir_function, *source_result, diagnostics);
            }
            EmitOperation::TrackRuntimeReactive {
                slot,
                source_result,
                local,
                cleanup,
                ..
            } => {
                verify_slot(function, *slot, diagnostics);
                verify_source_result(hir_function, *source_result, diagnostics);
                verify_cleanup(function, analysis, *cleanup, diagnostics);
                verify_runtime_reactive_site(
                    hir_function,
                    function,
                    *slot,
                    *source_result,
                    *local,
                    diagnostics,
                );
            }
            EmitOperation::WriteReactive { slot, .. }
            | EmitOperation::UpdateReactive {
                slot,
                source_result: None,
                ..
            } => {
                verify_slot(function, *slot, diagnostics);
            }
            EmitOperation::UpdateReactive {
                slot,
                source_result: Some(source_result),
                ..
            } => {
                verify_slot(function, *slot, diagnostics);
                verify_source_result(hir_function, *source_result, diagnostics);
            }
            EmitOperation::RegisterEffect {
                slot,
                source_result,
                cleanup,
                ..
            } => {
                verify_slot(function, *slot, diagnostics);
                if let Some(source_result) = source_result {
                    verify_source_result(hir_function, *source_result, diagnostics);
                }
                verify_cleanup(function, analysis, *cleanup, diagnostics);
            }
            EmitOperation::CreateVNode {
                template,
                source_result,
                fragment_helper,
                ..
            } => {
                verify_source_result(hir_function, *source_result, diagnostics);
                let template = hir.templates.get(template.as_usize());
                if template.is_none_or(|item| item.owner != function.source) {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-VNODE",
                        "VNode operation must reference a JSX template owned by its function",
                    ));
                }
                if template.is_some_and(|template| {
                    template.contains_fragment
                        != (*fragment_helper == Some(RuntimeHelper::Fragment))
                }) {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-VNODE-FRAGMENT",
                        "VNode operation fragment helper must match its JSX template",
                    ));
                }
            }
            EmitOperation::DeclareTemplate {
                template,
                local,
                html,
                namespace,
                ..
            } => {
                if !valid_identifier(local)
                    || html.is_empty()
                    || *namespace == DomNamespace::Parent
                    || hir
                        .templates
                        .get(template.as_usize())
                        .is_none_or(|item| item.owner != function.source)
                    || !templates.insert(*template)
                {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-TEMPLATE",
                        "template declarations must be non-empty, unique, owned, and concrete",
                    ));
                }
            }
            EmitOperation::CloneTemplate {
                template,
                source_result,
                ..
            } => {
                verify_source_result(hir_function, *source_result, diagnostics);
                if !templates.contains(template) {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-TEMPLATE-ORDER",
                        "template must be declared before cloning",
                    ));
                }
            }
            EmitOperation::CreateElement {
                namespace: DomNamespace::Parent,
                helper,
                ..
            } if *helper != RuntimeHelper::CreateElementInParentNamespace => {
                diagnostics.push(emit_error(
                    "FICT-EMIT-NAMESPACE",
                    "parent-derived namespace requires its dedicated helper",
                ));
            }
            EmitOperation::InvokeComponent {
                component,
                props,
                children,
                ..
            } => {
                let target_valid = match component {
                    crate::ComponentTarget::Binding(binding) => {
                        hir.bindings.get(binding.as_usize()).is_some()
                    }
                    crate::ComponentTarget::Member { root, properties } => {
                        hir.bindings.get(root.as_usize()).is_some()
                            && !properties.is_empty()
                            && properties.iter().all(|property| !property.is_empty())
                    }
                    crate::ComponentTarget::Dynamic(_) => true,
                };
                if !target_valid
                    || props.iter().any(|prop| {
                        matches!(
                            prop,
                            crate::ComponentProp::Named { name, .. }
                                | crate::ComponentProp::Node { name, .. }
                                if name.is_empty()
                        )
                    })
                    || props.iter().any(|prop| {
                        matches!(
                            prop,
                            crate::ComponentProp::Node { origin, .. }
                                if origin.primary_span.is_none()
                        )
                    })
                    || children.iter().any(|child| {
                        matches!(
                            child,
                            crate::ComponentChild::Node(origin) if origin.primary_span.is_none()
                        )
                    })
                {
                    diagnostics.push(emit_error(
                        "FICT-EMIT-COMPONENT",
                        "component target and prop names must retain valid semantic identity",
                    ));
                }
            }
            EmitOperation::BindEvent { cleanup, .. }
            | EmitOperation::BindRef { cleanup, .. }
            | EmitOperation::Conditional { cleanup, .. } => {
                verify_cleanup(function, analysis, *cleanup, diagnostics);
            }
            EmitOperation::KeyedList {
                source_result,
                cleanup,
                ..
            } => {
                verify_source_result(hir_function, *source_result, diagnostics);
                verify_cleanup(function, analysis, *cleanup, diagnostics);
            }
            _ => {}
        }
    }
}

fn verify_source_result(
    function: &fict_hir::HirFunction,
    value: fict_hir::ValueId,
    diagnostics: &mut DiagnosticBundle,
) {
    if function.values.get(value.as_usize()).is_none() {
        diagnostics.push(emit_error(
            "FICT-EMIT-SOURCE-RESULT",
            "lowered operation references a missing source HIR result",
        ));
    }
}

fn verify_helper_semantics(
    function: &crate::EmitFunction,
    operation: &EmitOperation,
    diagnostics: &mut DiagnosticBundle,
) {
    let valid = match operation {
        EmitOperation::CreateReactive { slot, helper, .. } => {
            function.slots.get(slot.as_usize()).is_some_and(|slot| {
                slot.storage == crate::ReactiveSlotStorage::Owned
                    && match slot.kind {
                        crate::ReactiveSlotKind::Signal => {
                            matches!(helper, RuntimeHelper::Signal | RuntimeHelper::UseSignal)
                        }
                        crate::ReactiveSlotKind::Memo => {
                            matches!(helper, RuntimeHelper::Memo | RuntimeHelper::UseMemo)
                        }
                        crate::ReactiveSlotKind::Selector => {
                            *helper == RuntimeHelper::CreateSelector
                        }
                        crate::ReactiveSlotKind::Effect
                        | crate::ReactiveSlotKind::Context
                        | crate::ReactiveSlotKind::Store
                        | crate::ReactiveSlotKind::Resource => false,
                    }
            })
        }
        EmitOperation::RegisterEffect { helper, .. } => {
            matches!(helper, RuntimeHelper::Effect | RuntimeHelper::UseEffect)
        }
        EmitOperation::DeclareTemplate { helper, .. } => *helper == RuntimeHelper::Template,
        EmitOperation::CreateElement {
            namespace, helper, ..
        } => match namespace {
            DomNamespace::Html => *helper == RuntimeHelper::CreateElement,
            DomNamespace::Svg
            | DomNamespace::MathMl
            | DomNamespace::MathMlTextIntegration
            | DomNamespace::MathMlAnnotationXml => {
                *helper == RuntimeHelper::CreateElementInNamespace
            }
            DomNamespace::Parent => *helper == RuntimeHelper::CreateElementInParentNamespace,
        },
        EmitOperation::BindDom {
            kind,
            reactive,
            helper,
            ..
        } => match (kind, reactive) {
            (crate::DomBindingKind::Text, true) => *helper == RuntimeHelper::BindText,
            (crate::DomBindingKind::Text, false) => *helper == RuntimeHelper::SetText,
            (crate::DomBindingKind::TextContent, true) => *helper == RuntimeHelper::BindTextContent,
            (crate::DomBindingKind::TextContent, false) => *helper == RuntimeHelper::SetTextContent,
            (crate::DomBindingKind::Attribute(_), true) => *helper == RuntimeHelper::BindAttribute,
            (crate::DomBindingKind::Attribute(_), false) => *helper == RuntimeHelper::SetAttr,
            (crate::DomBindingKind::Property(_), true) => *helper == RuntimeHelper::BindProperty,
            (crate::DomBindingKind::Property(_), false) => *helper == RuntimeHelper::SetProp,
            (crate::DomBindingKind::Class, true) => *helper == RuntimeHelper::BindClass,
            (crate::DomBindingKind::Class, false) => *helper == RuntimeHelper::SetClass,
            (crate::DomBindingKind::Style, true) => *helper == RuntimeHelper::BindStyle,
            (crate::DomBindingKind::Style, false) => *helper == RuntimeHelper::SetStyle,
            (crate::DomBindingKind::Spread, _) => *helper == RuntimeHelper::Spread,
        },
        EmitOperation::ApplyProps {
            operation, helper, ..
        } => match operation {
            crate::PropsOperation::Getter { .. } => *helper == RuntimeHelper::PropGetter,
            crate::PropsOperation::Rest { .. } => {
                matches!(helper, RuntimeHelper::PropsRest | RuntimeHelper::ObjectRest)
            }
            crate::PropsOperation::Merge(_) => *helper == RuntimeHelper::MergeProps,
            crate::PropsOperation::Spread { .. } => *helper == RuntimeHelper::Spread,
            crate::PropsOperation::Keyed(_) => *helper == RuntimeHelper::Keyed,
        },
        EmitOperation::BindEvent {
            delegated,
            helper,
            cleanup_helper,
            ..
        } => {
            if *delegated {
                *helper == RuntimeHelper::AddEventListener && cleanup_helper.is_none()
            } else {
                *helper == RuntimeHelper::BindEvent
                    && *cleanup_helper == Some(RuntimeHelper::OnDestroy)
            }
        }
        EmitOperation::BindRef { helper, .. } => *helper == RuntimeHelper::BindRef,
        EmitOperation::Insert {
            namespace,
            helper,
            create_helper,
            fragment_helper,
            ..
        } => {
            *helper == RuntimeHelper::Insert
                && fragment_helper.is_none_or(|helper| helper == RuntimeHelper::Fragment)
                && match namespace {
                    DomNamespace::Html => *create_helper == RuntimeHelper::CreateElement,
                    DomNamespace::Svg
                    | DomNamespace::MathMl
                    | DomNamespace::MathMlTextIntegration
                    | DomNamespace::MathMlAnnotationXml => {
                        *create_helper == RuntimeHelper::CreateElementInNamespace
                    }
                    DomNamespace::Parent => {
                        *create_helper == RuntimeHelper::CreateElementInParentNamespace
                    }
                }
        }
        EmitOperation::Conditional {
            namespace,
            helper,
            create_helper,
            cleanup_helper,
            fragment_helper,
            ..
        } => {
            *helper == RuntimeHelper::Conditional
                && *cleanup_helper == RuntimeHelper::OnDestroy
                && fragment_helper.is_none_or(|helper| helper == RuntimeHelper::Fragment)
                && match namespace {
                    DomNamespace::Html => *create_helper == RuntimeHelper::CreateElement,
                    DomNamespace::Svg
                    | DomNamespace::MathMl
                    | DomNamespace::MathMlTextIntegration
                    | DomNamespace::MathMlAnnotationXml => {
                        *create_helper == RuntimeHelper::CreateElementInNamespace
                    }
                    DomNamespace::Parent => {
                        *create_helper == RuntimeHelper::CreateElementInParentNamespace
                    }
                }
        }
        EmitOperation::KeyedList { helper, .. } => *helper == RuntimeHelper::KeyedList,
        EmitOperation::ReadReactive { helper, .. } => {
            helper.is_none_or(|helper| helper == RuntimeHelper::ReactiveGetter)
        }
        EmitOperation::CreateVNode {
            fragment_helper, ..
        } => fragment_helper.is_none_or(|helper| helper == RuntimeHelper::Fragment),
        EmitOperation::ResolveElement { helper, path, .. } => {
            *helper == RuntimeHelper::ResolvePath && !path.is_empty()
        }
        EmitOperation::InvokeComponent {
            props,
            children,
            prop_helper,
            children_helper,
            merge_helper,
            non_reactive_helper,
            fragment_helper,
            ..
        } => {
            let needs_prop = props
                .iter()
                .any(|prop| matches!(prop, crate::ComponentProp::Named { getter: true, .. }));
            let needs_merge = props
                .iter()
                .any(|prop| matches!(prop, crate::ComponentProp::Spread(_)));
            let needs_children = children
                .iter()
                .any(|child| matches!(child, crate::ComponentChild::Value { getter: true, .. }));
            let needs_non_reactive = props.iter().any(|prop| {
                matches!(
                    prop,
                    crate::ComponentProp::Named {
                        non_reactive: true,
                        ..
                    }
                )
            }) || children.iter().any(|child| {
                matches!(
                    child,
                    crate::ComponentChild::Value {
                        non_reactive: true,
                        ..
                    }
                )
            });
            let wrappers_exclusive = props.iter().all(|prop| {
                !matches!(
                    prop,
                    crate::ComponentProp::Named {
                        getter: true,
                        non_reactive: true,
                        ..
                    }
                )
            }) && children.iter().all(|child| {
                !matches!(
                    child,
                    crate::ComponentChild::Value {
                        getter: true,
                        non_reactive: true,
                        ..
                    }
                )
            });
            wrappers_exclusive
                && *prop_helper == needs_prop.then_some(RuntimeHelper::PropGetter)
                && *children_helper == needs_children.then_some(RuntimeHelper::Prop)
                && *merge_helper == needs_merge.then_some(RuntimeHelper::MergeProps)
                && *non_reactive_helper == needs_non_reactive.then_some(RuntimeHelper::NonReactive)
                && fragment_helper.is_none_or(|helper| helper == RuntimeHelper::Fragment)
        }
        EmitOperation::PreserveHir { .. }
        | EmitOperation::TrackRuntimeReactive { .. }
        | EmitOperation::WriteReactive { .. }
        | EmitOperation::UpdateReactive { .. }
        | EmitOperation::Evaluate { .. }
        | EmitOperation::CloneTemplate { .. }
        | EmitOperation::Return { .. } => true,
    };
    if !valid {
        diagnostics.push(emit_error(
            "FICT-EMIT-HELPER",
            "operation uses a runtime helper incompatible with its semantics",
        ));
    }
}

fn verify_runtime_reactive_site(
    hir_function: &fict_hir::HirFunction,
    function: &crate::EmitFunction,
    slot: crate::EmitSlotId,
    source_result: fict_hir::ValueId,
    local: Option<fict_hir::LocalId>,
    diagnostics: &mut DiagnosticBundle,
) {
    let source_kind = hir_function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find_map(|instruction| {
            (instruction.result == Some(source_result)).then_some(match &instruction.kind {
                fict_hir::HirInstructionKind::Call(call) => call.reactive_kind,
                _ => None,
            })
        })
        .flatten();
    let expected = match source_kind {
        Some(fict_hir::ReactiveCallKind::Store) => crate::ReactiveSlotKind::Store,
        Some(fict_hir::ReactiveCallKind::Resource) => crate::ReactiveSlotKind::Resource,
        Some(fict_hir::ReactiveCallKind::Selector) => crate::ReactiveSlotKind::Selector,
        None => {
            diagnostics.push(emit_error(
                "FICT-EMIT-RUNTIME-REACTIVE",
                "tracked runtime reactive slot must originate from a classified HIR call",
            ));
            return;
        }
    };
    if function
        .slots
        .get(slot.as_usize())
        .is_none_or(|actual| actual.kind != expected)
    {
        diagnostics.push(emit_error(
            "FICT-EMIT-RUNTIME-REACTIVE",
            "runtime reactive call kind must match its EmitIR slot kind",
        ));
    }
    if let Some(local) = local
        && (hir_function.locals.get(local.as_usize()).is_none()
            || !hir_function.blocks.iter().any(|block| {
                block.instructions.iter().any(|instruction| {
                    matches!(
                        instruction.kind,
                        fict_hir::HirInstructionKind::Declare {
                            local: declared,
                            initializer: Some(initializer),
                            ..
                        } if declared == local && initializer == source_result
                    )
                })
            }))
    {
        diagnostics.push(emit_error(
            "FICT-EMIT-RUNTIME-REACTIVE",
            "runtime reactive local must be declared from the classified call result",
        ));
    }
}

fn verify_slot(
    function: &crate::EmitFunction,
    slot: crate::EmitSlotId,
    diagnostics: &mut DiagnosticBundle,
) {
    if function.slots.get(slot.as_usize()).is_none() {
        diagnostics.push(emit_error(
            "FICT-EMIT-SLOT-USE",
            "operation references an unknown slot",
        ));
    }
}

fn verify_cleanup(
    function: &crate::EmitFunction,
    analysis: Option<&RegionAnalysis>,
    cleanup: CleanupOwner,
    diagnostics: &mut DiagnosticBundle,
) {
    let valid = match cleanup {
        CleanupOwner::Slot(slot) => function.slots.get(slot.as_usize()).is_some(),
        CleanupOwner::Region(region) => {
            analysis.is_some_and(|analysis| analysis.regions.get(region.as_usize()).is_some())
        }
        CleanupOwner::Function => true,
    };
    if !valid {
        diagnostics.push(emit_error("FICT-EMIT-CLEANUP", "cleanup owner is unknown"));
    }
}

fn valid_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    (first == b'$' || first == b'_' || first.is_ascii_alphabetic())
        && bytes.all(|byte| byte == b'$' || byte == b'_' || byte.is_ascii_alphanumeric())
}

fn emit_error(code: &'static str, message: impl Into<String>) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("EmitIR diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(GuaranteeClass::Internal)
}
