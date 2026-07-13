#![forbid(unsafe_code)]

//! OXC-independent EmitIR and verified runtime-helper intent for Fict output.

mod ir;
mod lower;
mod runtime_abi;
mod verify;

pub use ir::{
    CleanupOwner, ComponentProp, ComponentTarget, DomBindingKind, DomNamespace, EmitControlArm,
    EmitFunction, EmitOperation, EmitProgram, EmitSlotId, EmitTemporary, EmitTemporaryId,
    EmitValueRef, PropsOperation, ReactiveSlot, ReactiveSlotKind, RuntimeImportIntent,
};
pub use lower::{NoJsxLoweringOptions, lower_core, lower_no_jsx};

pub use runtime_abi::{
    ALL_RUNTIME_HELPERS, DELEGATED_EVENTS, FICT_INTERNAL_MODULE, FICT_LIST_MODULE,
    RUNTIME_ABI_VERSION, RUNTIME_HELPER_SPECS, RuntimeFamily, RuntimeHelper, RuntimeHelperModule,
    RuntimeHelperSpec, RuntimeHelperStability, STANDALONE_INTERNAL_MODULE, STANDALONE_LIST_MODULE,
    verify_runtime_abi,
};
pub use verify::verify_emit_program;
