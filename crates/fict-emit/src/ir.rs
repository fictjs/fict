use fict_hir::{
    BindingId, BlockId, CompoundAssignmentOperator, FunctionId, LiteralValue, LocalId, Origin,
    Projection, RegionId, SsaName, SyntaxFragmentId, TemplateId, UpdateOperator, ValueId,
};

use crate::{RuntimeFamily, RuntimeHelper};
use fict_reactivity::StructurizeAnalysis;

macro_rules! emit_id {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(u32);

        impl $name {
            #[must_use]
            pub const fn new(index: u32) -> Self {
                Self(index)
            }
            #[must_use]
            pub const fn index(self) -> u32 {
                self.0
            }
            #[must_use]
            pub const fn as_usize(self) -> usize {
                self.0 as usize
            }
        }
    };
}

emit_id!(EmitSlotId);
emit_id!(EmitTemporaryId);

/// Runtime import requested by generated output.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RuntimeImportIntent {
    pub helper: RuntimeHelper,
    pub module_request: String,
    pub imported: String,
    pub local: String,
}

/// Preserved module syntax and names reserved before generated imports/temporaries are allocated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitModulePlan {
    /// Adapter-owned full module/script body. Synthetic unit fixtures may omit it.
    pub source_fragment: Option<SyntaxFragmentId>,
    /// Sorted unique source and generated module names.
    pub reserved_names: Vec<String>,
}

/// Function-local generated temporary declaration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitTemporary {
    pub id: EmitTemporaryId,
    pub name: String,
    pub origin: Origin,
}

/// Value consumed by EmitIR operations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmitValueRef {
    Hir(ValueId),
    Ssa(SsaName),
    Slot(EmitSlotId),
    Temporary(EmitTemporaryId),
    Literal(LiteralValue),
    Function(FunctionId),
    Binding(BindingId),
}

/// Reactive runtime slot category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ReactiveSlotKind {
    Signal,
    Memo,
    Effect,
    Context,
    Store,
    Resource,
    Selector,
}

/// Whether a reactive slot is created by this function or captured from an outer function.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ReactiveSlotStorage {
    /// The function contains the reactive creator operation.
    Owned,
    /// The function closes over a reactive binding created by another HIR function.
    Captured { owner: FunctionId },
}

/// One direct reactive identifier target inside an object or array assignment pattern.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReactivePatternTarget {
    pub slot: EmitSlotId,
    pub local: LocalId,
    pub origin: Origin,
}

/// One control-flow arm used to prove hook slot stability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EmitControlArm {
    pub block: BlockId,
    pub arm: u16,
}

/// Stable reactive allocation within a function.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReactiveSlot {
    pub id: EmitSlotId,
    pub kind: ReactiveSlotKind,
    pub storage: ReactiveSlotStorage,
    pub binding: Option<BindingId>,
    pub control_path: Vec<EmitControlArm>,
    pub origin: Origin,
}

/// DOM creation/binding namespace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DomNamespace {
    Html,
    Svg,
    MathMl,
    /// Children of MathML text integration points; runtime tag choice decides HTML vs MathML.
    MathMlTextIntegration,
    /// Children of non-HTML MathML `annotation-xml`; only nested `svg` switches namespace.
    MathMlAnnotationXml,
    /// Resolve from the live parent after a runtime `annotation-xml` encoding decision.
    Parent,
}

/// DOM binding behavior.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DomBindingKind {
    Text,
    TextContent,
    Attribute(String),
    Property(String),
    Class,
    Style,
    Spread,
}

/// Owner responsible for disposing event/ref/list/effect resources.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CleanupOwner {
    Slot(EmitSlotId),
    Region(RegionId),
    Function,
}

/// Props transformation operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PropsOperation {
    Getter {
        name: String,
        value: EmitValueRef,
    },
    Rest {
        source: EmitValueRef,
        excluded: Vec<String>,
    },
    Merge(Vec<EmitValueRef>),
    Spread {
        source: EmitValueRef,
        namespace: DomNamespace,
        skip_children: bool,
        excluded: Vec<String>,
    },
    Keyed(EmitValueRef),
}

/// Binding-aware component callee.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComponentTarget {
    Binding(BindingId),
    Member {
        root: BindingId,
        properties: Vec<String>,
    },
    Dynamic(EmitValueRef),
}

/// Named or spread component prop in source order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComponentProp {
    Named {
        name: String,
        value: EmitValueRef,
        getter: bool,
        non_reactive: bool,
        reactive_function: bool,
    },
    Node {
        name: String,
        origin: Origin,
    },
    Spread {
        value: EmitValueRef,
        getter: bool,
    },
}

/// Scalar or recursively-authored JSX child passed to a component.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComponentChild {
    Value {
        value: EmitValueRef,
        getter: bool,
        non_reactive: bool,
    },
    Node(Origin),
}

/// Source conditional shape represented by a fine-grained binding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConditionalKind {
    Ternary,
    LogicalAnd,
}

/// Verified operation between HIR analysis and output AST construction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmitOperation {
    PreserveHir {
        block: BlockId,
        instruction: u32,
        origin: Origin,
    },
    CreateReactive {
        slot: EmitSlotId,
        source_result: ValueId,
        local: Option<LocalId>,
        initializer: Option<EmitValueRef>,
        helper: RuntimeHelper,
        origin: Origin,
    },
    /// Associate a preserved runtime call (`$store`, `resource`, `createSelector`) with a stable
    /// compiler slot without replacing the executable call.
    TrackRuntimeReactive {
        slot: EmitSlotId,
        source_result: ValueId,
        local: Option<LocalId>,
        cleanup: CleanupOwner,
        origin: Origin,
    },
    ReadReactive {
        slot: EmitSlotId,
        source_result: ValueId,
        projections: Vec<Projection>,
        target: EmitTemporaryId,
        helper: Option<RuntimeHelper>,
        origin: Origin,
    },
    RegisterEffect {
        slot: EmitSlotId,
        source_result: Option<ValueId>,
        callback: EmitValueRef,
        helper: RuntimeHelper,
        cleanup: CleanupOwner,
        origin: Origin,
    },
    WriteReactive {
        slot: EmitSlotId,
        source_result: Option<ValueId>,
        projections: Vec<Projection>,
        value: EmitValueRef,
        target: Option<EmitTemporaryId>,
        origin: Origin,
    },
    /// Rewrite selected direct targets of a retained assignment pattern into reactive setters.
    WriteReactivePattern {
        source_result: ValueId,
        value: EmitValueRef,
        targets: Vec<ReactivePatternTarget>,
        origin: Origin,
    },
    UpdateReactive {
        slot: EmitSlotId,
        source_result: Option<ValueId>,
        projections: Vec<Projection>,
        compound: Option<CompoundAssignmentOperator>,
        value: Option<EmitValueRef>,
        update: Option<UpdateOperator>,
        prefix: bool,
        target: Option<EmitTemporaryId>,
        origin: Origin,
    },
    /// Materialize one complete JSX root as a Fict VNode fallback.
    CreateVNode {
        template: TemplateId,
        source_result: ValueId,
        fragment_helper: Option<RuntimeHelper>,
        origin: Origin,
    },
    DeclareTemplate {
        template: TemplateId,
        local: String,
        html: String,
        namespace: DomNamespace,
        helper: RuntimeHelper,
        origin: Origin,
    },
    CloneTemplate {
        template: TemplateId,
        source_result: ValueId,
        target: EmitTemporaryId,
        origin: Origin,
    },
    ResolveElement {
        root: EmitTemporaryId,
        path: Vec<u32>,
        target: EmitTemporaryId,
        helper: RuntimeHelper,
        origin: Origin,
    },
    InvokeComponent {
        target: EmitTemporaryId,
        component: ComponentTarget,
        props: Vec<ComponentProp>,
        children: Vec<ComponentChild>,
        prop_helper: Option<RuntimeHelper>,
        children_helper: Option<RuntimeHelper>,
        merge_helper: Option<RuntimeHelper>,
        non_reactive_helper: Option<RuntimeHelper>,
        reactive_function_helper: Option<RuntimeHelper>,
        fragment_helper: Option<RuntimeHelper>,
        origin: Origin,
    },
    CreateElement {
        target: EmitTemporaryId,
        tag: EmitValueRef,
        namespace: DomNamespace,
        helper: RuntimeHelper,
        origin: Origin,
    },
    BindDom {
        element: EmitTemporaryId,
        kind: DomBindingKind,
        value: EmitValueRef,
        reactive: bool,
        helper: RuntimeHelper,
        origin: Origin,
    },
    ApplyProps {
        target: EmitTemporaryId,
        operation: PropsOperation,
        helper: RuntimeHelper,
        origin: Origin,
    },
    BindEvent {
        element: EmitTemporaryId,
        event: String,
        handler: EmitValueRef,
        delegated: bool,
        helper: RuntimeHelper,
        cleanup_helper: Option<RuntimeHelper>,
        cleanup: CleanupOwner,
        origin: Origin,
    },
    BindRef {
        element: EmitTemporaryId,
        reference: EmitValueRef,
        helper: RuntimeHelper,
        cleanup: CleanupOwner,
        origin: Origin,
    },
    /// Evaluate a source expression for its observable effects without exposing its value.
    Evaluate { value: EmitValueRef, origin: Origin },
    Insert {
        parent: EmitTemporaryId,
        value: EmitValueRef,
        before: Option<EmitTemporaryId>,
        namespace: DomNamespace,
        helper: RuntimeHelper,
        create_helper: RuntimeHelper,
        fragment_helper: Option<RuntimeHelper>,
        origin: Origin,
    },
    Conditional {
        target: EmitTemporaryId,
        source: EmitValueRef,
        kind: ConditionalKind,
        parent: EmitTemporaryId,
        start: EmitTemporaryId,
        end: EmitTemporaryId,
        namespace: DomNamespace,
        helper: RuntimeHelper,
        create_helper: RuntimeHelper,
        cleanup_helper: RuntimeHelper,
        fragment_helper: Option<RuntimeHelper>,
        cleanup: CleanupOwner,
        origin: Origin,
    },
    /// Materialize a binding-aware keyed `.map()` child between template-owned markers.
    KeyedChild {
        target: EmitTemporaryId,
        source_result: ValueId,
        items: Origin,
        optional: bool,
        key: Option<Origin>,
        key_source: Option<Origin>,
        key_alias_initializer: Option<Origin>,
        render: FunctionId,
        render_key: String,
        item_references: Vec<Origin>,
        index_references: Vec<Origin>,
        needs_index: bool,
        parent: EmitTemporaryId,
        start: EmitTemporaryId,
        end: EmitTemporaryId,
        namespace: DomNamespace,
        helper: RuntimeHelper,
        cleanup_helper: RuntimeHelper,
        cleanup: CleanupOwner,
        origin: Origin,
    },
    KeyedList {
        target: EmitTemporaryId,
        source_result: ValueId,
        items: EmitValueRef,
        key: Option<FunctionId>,
        render: FunctionId,
        helper: RuntimeHelper,
        cleanup: CleanupOwner,
        origin: Origin,
    },
    Return {
        value: Option<EmitValueRef>,
        origin: Origin,
    },
}

impl EmitOperation {
    #[must_use]
    pub const fn helper(&self) -> Option<RuntimeHelper> {
        match self {
            Self::CreateReactive { helper, .. }
            | Self::RegisterEffect { helper, .. }
            | Self::DeclareTemplate { helper, .. }
            | Self::CreateElement { helper, .. }
            | Self::BindDom { helper, .. }
            | Self::ApplyProps { helper, .. }
            | Self::BindEvent { helper, .. }
            | Self::BindRef { helper, .. }
            | Self::Insert { helper, .. }
            | Self::Conditional { helper, .. }
            | Self::KeyedChild { helper, .. }
            | Self::KeyedList { helper, .. }
            | Self::ResolveElement { helper, .. } => Some(*helper),
            Self::ReadReactive { helper, .. }
            | Self::CreateVNode {
                fragment_helper: helper,
                ..
            } => *helper,
            Self::InvokeComponent {
                prop_helper,
                children_helper,
                merge_helper,
                non_reactive_helper,
                reactive_function_helper,
                fragment_helper,
                ..
            } => match prop_helper {
                Some(helper) => Some(*helper),
                None => match children_helper {
                    Some(helper) => Some(*helper),
                    None => match merge_helper {
                        Some(helper) => Some(*helper),
                        None => match non_reactive_helper {
                            Some(helper) => Some(*helper),
                            None => match reactive_function_helper {
                                Some(helper) => Some(*helper),
                                None => *fragment_helper,
                            },
                        },
                    },
                },
            },
            Self::PreserveHir { .. }
            | Self::TrackRuntimeReactive { .. }
            | Self::WriteReactive { .. }
            | Self::WriteReactivePattern { .. }
            | Self::UpdateReactive { .. }
            | Self::Evaluate { .. }
            | Self::CloneTemplate { .. }
            | Self::Return { .. } => None,
        }
    }

    #[must_use]
    pub const fn auxiliary_helper(&self) -> Option<RuntimeHelper> {
        match self {
            Self::Insert { create_helper, .. } => Some(*create_helper),
            Self::BindEvent { cleanup_helper, .. } => *cleanup_helper,
            Self::Conditional { create_helper, .. } => Some(*create_helper),
            Self::KeyedChild { cleanup_helper, .. } => Some(*cleanup_helper),
            Self::InvokeComponent {
                prop_helper: Some(_),
                fragment_helper,
                ..
            } => *fragment_helper,
            _ => None,
        }
    }

    #[must_use]
    pub const fn tertiary_helper(&self) -> Option<RuntimeHelper> {
        match self {
            Self::Conditional { cleanup_helper, .. } => Some(*cleanup_helper),
            Self::Insert {
                fragment_helper, ..
            } => *fragment_helper,
            _ => None,
        }
    }

    #[must_use]
    pub const fn quaternary_helper(&self) -> Option<RuntimeHelper> {
        match self {
            Self::Conditional {
                fragment_helper, ..
            } => *fragment_helper,
            _ => None,
        }
    }

    #[must_use]
    pub const fn helper_slots(&self) -> [Option<RuntimeHelper>; 8] {
        match self {
            Self::InvokeComponent {
                prop_helper,
                children_helper,
                merge_helper,
                non_reactive_helper,
                reactive_function_helper,
                fragment_helper,
                ..
            } => [
                *prop_helper,
                *children_helper,
                *merge_helper,
                *non_reactive_helper,
                *reactive_function_helper,
                *fragment_helper,
                None,
                None,
            ],
            Self::Conditional {
                helper,
                create_helper,
                cleanup_helper,
                fragment_helper,
                ..
            } => [
                Some(*helper),
                Some(*create_helper),
                Some(*cleanup_helper),
                *fragment_helper,
                None,
                None,
                None,
                None,
            ],
            _ => [
                self.helper(),
                self.auxiliary_helper(),
                self.tertiary_helper(),
                self.quaternary_helper(),
                None,
                None,
                None,
                None,
            ],
        }
    }

    #[must_use]
    pub const fn defined_temporary(&self) -> Option<EmitTemporaryId> {
        match self {
            Self::ReadReactive { target, .. }
            | Self::CloneTemplate { target, .. }
            | Self::ResolveElement { target, .. }
            | Self::InvokeComponent { target, .. }
            | Self::CreateElement { target, .. }
            | Self::Conditional { target, .. }
            | Self::KeyedChild { target, .. }
            | Self::KeyedList { target, .. } => Some(*target),
            Self::UpdateReactive {
                target: Some(target),
                ..
            } => Some(*target),
            Self::WriteReactive {
                target: Some(target),
                ..
            } => Some(*target),
            _ => None,
        }
    }

    pub fn visit_values(&self, mut visit: impl FnMut(&EmitValueRef)) {
        match self {
            Self::CreateReactive { initializer, .. } => initializer.iter().for_each(&mut visit),
            Self::RegisterEffect { callback, .. } => visit(callback),
            Self::WriteReactive { value, .. } => visit(value),
            Self::WriteReactivePattern { value, .. } => visit(value),
            Self::UpdateReactive { value, .. } => value.iter().for_each(visit),
            Self::CreateElement { tag, .. }
            | Self::BindDom { value: tag, .. }
            | Self::BindRef { reference: tag, .. }
            | Self::Evaluate { value: tag, .. }
            | Self::Insert { value: tag, .. }
            | Self::Conditional { source: tag, .. }
            | Self::KeyedList { items: tag, .. } => visit(tag),
            Self::ApplyProps { operation, .. } => match operation {
                PropsOperation::Getter { value, .. } | PropsOperation::Keyed(value) => visit(value),
                PropsOperation::Rest { source, .. } | PropsOperation::Spread { source, .. } => {
                    visit(source)
                }
                PropsOperation::Merge(values) => values.iter().for_each(visit),
            },
            Self::BindEvent { handler, .. } => visit(handler),
            Self::InvokeComponent {
                component,
                props,
                children,
                ..
            } => {
                if let ComponentTarget::Dynamic(value) = component {
                    visit(value);
                }
                for prop in props {
                    match prop {
                        ComponentProp::Named { value, .. }
                        | ComponentProp::Spread { value, .. } => visit(value),
                        ComponentProp::Node { .. } => {}
                    }
                }
                for child in children {
                    if let ComponentChild::Value { value, .. } = child {
                        visit(value);
                    }
                }
            }
            Self::Return { value, .. } => value.iter().for_each(visit),
            Self::PreserveHir { .. }
            | Self::TrackRuntimeReactive { .. }
            | Self::ReadReactive { .. }
            | Self::CreateVNode { .. }
            | Self::DeclareTemplate { .. }
            | Self::CloneTemplate { .. }
            | Self::KeyedChild { .. }
            | Self::ResolveElement { .. } => {}
        }
    }

    pub fn visit_temporary_uses(&self, mut visit: impl FnMut(EmitTemporaryId)) {
        match self {
            Self::BindDom { element, .. }
            | Self::BindEvent { element, .. }
            | Self::BindRef { element, .. } => visit(*element),
            Self::ApplyProps { target, .. } => visit(*target),
            Self::ResolveElement { root, .. } => visit(*root),
            Self::Insert { parent, before, .. } => {
                visit(*parent);
                before.iter().copied().for_each(visit);
            }
            Self::Conditional {
                parent, start, end, ..
            } => {
                visit(*parent);
                visit(*start);
                visit(*end);
            }
            Self::KeyedChild {
                parent, start, end, ..
            } => {
                visit(*parent);
                visit(*start);
                visit(*end);
            }
            _ => {}
        }
    }
}

/// Emit plan for one HIR function.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitContext {
    /// Collision-free function-local context binding.
    pub local: String,
    /// Runtime helper used to resolve the active render context.
    pub helper: RuntimeHelper,
    /// Source function whose body receives the declaration.
    pub origin: Origin,
}

/// One component prop destructured into a reactive local accessor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitPropBinding {
    pub path: Vec<String>,
    pub local: String,
    pub mode: EmitPropMode,
    pub checks: Vec<EmitPropCheck>,
    pub references: Vec<Origin>,
    pub default_value: Option<Origin>,
    pub default_local: Option<String>,
    pub origin: Origin,
}

/// Runtime representation selected for a destructured component prop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmitPropMode {
    Accessor,
    Value,
    Mutable,
}

/// Eager nested-object check emitted before a prop binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitPropCheck {
    pub path: Vec<String>,
    pub local: String,
    pub origin: Origin,
}

/// Whole-object default applied before individual prop accessors are created.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitPropsDefault {
    pub input: String,
    pub value: Origin,
}

/// Top-level reactive props-rest declaration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitPropsRest {
    pub local: String,
    pub excluded: Vec<String>,
    pub helper: RuntimeHelper,
    pub origin: Origin,
}

/// Function-entry plan for a binding-aware object props parameter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitPropsPlan {
    pub parameter: Origin,
    pub source: String,
    pub default: Option<EmitPropsDefault>,
    pub bindings: Vec<EmitPropBinding>,
    pub rest: Option<EmitPropsRest>,
    pub helper: Option<RuntimeHelper>,
}

/// Emit plan for one HIR function.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitFunction {
    pub source: FunctionId,
    pub context: Option<EmitContext>,
    pub props: Option<EmitPropsPlan>,
    pub slots: Vec<ReactiveSlot>,
    pub temporaries: Vec<EmitTemporary>,
    pub regions: Vec<RegionId>,
    pub control_flow: StructurizeAnalysis,
    pub operations: Vec<EmitOperation>,
}

/// Complete OXC-independent output plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitProgram {
    pub runtime_family: RuntimeFamily,
    pub preview: bool,
    pub strict_rejected: bool,
    pub module: EmitModulePlan,
    pub imports: Vec<RuntimeImportIntent>,
    pub functions: Vec<EmitFunction>,
}
