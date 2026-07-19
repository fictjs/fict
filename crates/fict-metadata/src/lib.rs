#![forbid(unsafe_code)]

//! Serializable module-reactivity metadata schema, analysis, and validation.

mod protocol;
mod resolved;
mod schema;
mod validate;

pub use protocol::{MAX_METADATA_NAMESPACE_DEPTH, MODULE_REACTIVE_METADATA_VERSION};
pub use resolved::{MetadataResolutionStatus, ResolvedMetadataInput};
pub use schema::{HookReturnInfo, ModuleReactiveMetadata, ReactiveExportKind};
pub use validate::MetadataValidationError;
