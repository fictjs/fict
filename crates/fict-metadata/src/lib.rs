#![forbid(unsafe_code)]

//! Serializable module-reactivity metadata schema, analysis, and validation.

mod resolved;
mod schema;
mod validate;

pub use resolved::{MetadataResolutionStatus, ResolvedMetadataInput};
pub use schema::{
    HookReturnInfo, MODULE_REACTIVE_METADATA_VERSION, ModuleReactiveMetadata, ReactiveExportKind,
};
pub use validate::{MAX_METADATA_NAMESPACE_DEPTH, MetadataValidationError};
