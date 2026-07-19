use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{MODULE_REACTIVE_METADATA_VERSION, MetadataValidationError};

/// Runtime representation exposed by a module export or hook return.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReactiveExportKind {
    /// Scalar signal accessor.
    Signal,
    /// Derived memo accessor.
    Memo,
    /// Deep reactive store.
    Store,
}

/// Serializable accessor shape returned by a hook.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HookReturnInfo {
    /// Reactive properties returned in an object.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub object_props: BTreeMap<String, ReactiveExportKind>,
    /// Reactive properties returned in a tuple/array, keyed by canonical JS index.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub array_props: BTreeMap<String, ReactiveExportKind>,
    /// Direct accessor returned by the hook.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direct_accessor: Option<ReactiveExportKind>,
}

/// Deterministic module metadata exchanged with JavaScript graph hosts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ModuleReactiveMetadata {
    /// Required schema version.
    pub version: u32,
    /// Reactive values exported by this module.
    pub exports: BTreeMap<String, ReactiveExportKind>,
    /// Reactive return shapes for exported hooks.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub hooks: BTreeMap<String, HookReturnInfo>,
    /// Metadata for exported TypeScript namespaces.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub namespaces: BTreeMap<String, ModuleReactiveMetadata>,
}

impl ModuleReactiveMetadata {
    /// Create canonical metadata for native output.
    #[must_use]
    pub fn new() -> Self {
        Self {
            version: MODULE_REACTIVE_METADATA_VERSION,
            exports: BTreeMap::new(),
            hooks: BTreeMap::new(),
            namespaces: BTreeMap::new(),
        }
    }

    /// Validate version, depth, and hook array-index invariants.
    pub fn validate(&self) -> Result<(), MetadataValidationError> {
        crate::validate::validate_module_metadata(self)
    }
}

impl Default for ModuleReactiveMetadata {
    fn default() -> Self {
        Self::new()
    }
}
