use fict_hir::{
    BindingId, BlockId, FunctionId, LiteralValue, Origin, RegionId, SsaName, TemplateId, ValueId,
};

use crate::{RuntimeFamily, RuntimeHelper};

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
    pub local: String,
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
        initializer: Option<EmitValueRef>,
        helper: RuntimeHelper,
        origin: Origin,
    },
    ReadReactive {
        slot: EmitSlotId,
        target: EmitTemporaryId,
        helper: Option<RuntimeHelper>,
        origin: Origin,
    },
    RegisterEffect {
        slot: EmitSlotId,
        callback: EmitValueRef,
        helper: RuntimeHelper,
        cleanup: CleanupOwner,
        origin: Origin,
    },
    DeclareTemplate {
        template: TemplateId,
        html: String,
        namespace: DomNamespace,
        helper: RuntimeHelper,
        origin: Origin,
    },
    CloneTemplate {
        template: TemplateId,
        target: EmitTemporaryId,
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
    Insert {
        parent: EmitTemporaryId,
        value: EmitValueRef,
        before: Option<EmitTemporaryId>,
        helper: RuntimeHelper,
        origin: Origin,
    },
    Conditional {
        target: EmitTemporaryId,
        test: EmitValueRef,
        consequent: FunctionId,
        alternate: Option<FunctionId>,
        helper: RuntimeHelper,
        cleanup: CleanupOwner,
        origin: Origin,
    },
    KeyedList {
        target: EmitTemporaryId,
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
            | Self::KeyedList { helper, .. } => Some(*helper),
            Self::ReadReactive { helper, .. } => *helper,
            Self::PreserveHir { .. } | Self::CloneTemplate { .. } | Self::Return { .. } => None,
        }
    }

    #[must_use]
    pub const fn defined_temporary(&self) -> Option<EmitTemporaryId> {
        match self {
            Self::ReadReactive { target, .. }
            | Self::CloneTemplate { target, .. }
            | Self::CreateElement { target, .. }
            | Self::Conditional { target, .. }
            | Self::KeyedList { target, .. } => Some(*target),
            _ => None,
        }
    }

    pub fn visit_values(&self, mut visit: impl FnMut(&EmitValueRef)) {
        match self {
            Self::CreateReactive { initializer, .. } => initializer.iter().for_each(&mut visit),
            Self::RegisterEffect { callback, .. } => visit(callback),
            Self::CreateElement { tag, .. }
            | Self::BindDom { value: tag, .. }
            | Self::BindRef { reference: tag, .. }
            | Self::Insert { value: tag, .. }
            | Self::Conditional { test: tag, .. }
            | Self::KeyedList { items: tag, .. } => visit(tag),
            Self::ApplyProps { operation, .. } => match operation {
                PropsOperation::Getter { value, .. } | PropsOperation::Keyed(value) => visit(value),
                PropsOperation::Rest { source, .. } | PropsOperation::Spread { source, .. } => {
                    visit(source)
                }
                PropsOperation::Merge(values) => values.iter().for_each(visit),
            },
            Self::BindEvent { handler, .. } => visit(handler),
            Self::Return { value, .. } => value.iter().for_each(visit),
            Self::PreserveHir { .. }
            | Self::ReadReactive { .. }
            | Self::DeclareTemplate { .. }
            | Self::CloneTemplate { .. } => {}
        }
    }

    pub fn visit_temporary_uses(&self, mut visit: impl FnMut(EmitTemporaryId)) {
        match self {
            Self::BindDom { element, .. }
            | Self::BindEvent { element, .. }
            | Self::BindRef { element, .. } => visit(*element),
            Self::ApplyProps { target, .. } => visit(*target),
            Self::Insert { parent, before, .. } => {
                visit(*parent);
                before.iter().copied().for_each(visit);
            }
            _ => {}
        }
    }
}

/// Emit plan for one HIR function.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitFunction {
    pub source: FunctionId,
    pub slots: Vec<ReactiveSlot>,
    pub temporaries: Vec<EmitTemporary>,
    pub regions: Vec<RegionId>,
    pub operations: Vec<EmitOperation>,
}

/// Complete OXC-independent output plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitProgram {
    pub runtime_family: RuntimeFamily,
    pub preview: bool,
    pub strict_rejected: bool,
    pub imports: Vec<RuntimeImportIntent>,
    pub functions: Vec<EmitFunction>,
}
