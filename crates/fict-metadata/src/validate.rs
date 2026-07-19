use std::{error::Error, fmt};

use crate::{
    MAX_METADATA_NAMESPACE_DEPTH, MODULE_REACTIVE_METADATA_VERSION, MetadataResolutionStatus,
    ModuleReactiveMetadata,
};

const MAX_SAFE_JAVASCRIPT_INTEGER: u64 = 9_007_199_254_740_991;

/// Fail-closed validation error for metadata and graph snapshots.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MetadataValidationError {
    /// Metadata declares a schema version this compiler cannot consume.
    UnsupportedVersion {
        /// Object path in the metadata tree.
        path: String,
        /// Rejected version.
        version: u32,
    },
    /// Namespace nesting exceeded the compiler resource budget.
    NamespaceDepthExceeded {
        /// Object path at the budget boundary.
        path: String,
        /// Configured maximum.
        maximum: usize,
    },
    /// Hook array property is not a canonical JavaScript safe-integer index.
    InvalidArrayIndex {
        /// Object path of the hook.
        path: String,
        /// Rejected property key.
        index: String,
    },
    /// Import request is empty.
    EmptyRequest,
    /// Cache fingerprint is empty.
    EmptyFingerprint {
        /// Import request associated with the fingerprint.
        request: String,
    },
    /// A present resolved identity is empty.
    EmptyResolvedId {
        /// Import request associated with the identity.
        request: String,
    },
    /// Status requires a resolved identity.
    MissingResolvedId {
        /// Import request.
        request: String,
        /// Resolution status.
        status: MetadataResolutionStatus,
    },
    /// Status requires module metadata.
    MissingMetadata {
        /// Import request.
        request: String,
        /// Resolution status.
        status: MetadataResolutionStatus,
    },
    /// Status forbids module metadata.
    UnexpectedMetadata {
        /// Import request.
        request: String,
        /// Resolution status.
        status: MetadataResolutionStatus,
    },
}

impl fmt::Display for MetadataValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedVersion { path, version } => write!(
                formatter,
                "metadata at {path} uses unsupported version {version}; expected {MODULE_REACTIVE_METADATA_VERSION}"
            ),
            Self::NamespaceDepthExceeded { path, maximum } => write!(
                formatter,
                "metadata namespace depth at {path} exceeds maximum {maximum}"
            ),
            Self::InvalidArrayIndex { path, index } => {
                write!(
                    formatter,
                    "metadata hook at {path} has invalid array index {index:?}"
                )
            }
            Self::EmptyRequest => formatter.write_str("metadata request must not be empty"),
            Self::EmptyFingerprint { request } => {
                write!(
                    formatter,
                    "metadata request {request:?} has an empty fingerprint"
                )
            }
            Self::EmptyResolvedId { request } => {
                write!(
                    formatter,
                    "metadata request {request:?} has an empty resolved id"
                )
            }
            Self::MissingResolvedId { request, status } => write!(
                formatter,
                "metadata request {request:?} with status {status:?} requires a resolved id"
            ),
            Self::MissingMetadata { request, status } => write!(
                formatter,
                "metadata request {request:?} with status {status:?} requires metadata"
            ),
            Self::UnexpectedMetadata { request, status } => write!(
                formatter,
                "metadata request {request:?} with status {status:?} must not include metadata"
            ),
        }
    }
}

impl Error for MetadataValidationError {}

pub(crate) fn validate_module_metadata(
    root: &ModuleReactiveMetadata,
) -> Result<(), MetadataValidationError> {
    let mut stack = vec![("$".to_owned(), root, 0_usize)];

    while let Some((path, metadata, depth)) = stack.pop() {
        if metadata.version != MODULE_REACTIVE_METADATA_VERSION {
            return Err(MetadataValidationError::UnsupportedVersion {
                path,
                version: metadata.version,
            });
        }

        for (hook_name, hook) in &metadata.hooks {
            let hook_path = format!("{path}.hooks[{hook_name:?}]");
            for index in hook.array_props.keys() {
                if !is_canonical_array_index(index) {
                    return Err(MetadataValidationError::InvalidArrayIndex {
                        path: hook_path,
                        index: index.clone(),
                    });
                }
            }
        }

        if depth >= MAX_METADATA_NAMESPACE_DEPTH && !metadata.namespaces.is_empty() {
            return Err(MetadataValidationError::NamespaceDepthExceeded {
                path,
                maximum: MAX_METADATA_NAMESPACE_DEPTH,
            });
        }

        for (namespace_name, namespace) in metadata.namespaces.iter().rev() {
            stack.push((
                format!("{path}.namespaces[{namespace_name:?}]"),
                namespace,
                depth + 1,
            ));
        }
    }

    Ok(())
}

fn is_canonical_array_index(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || (bytes[0] == b'0' && bytes.len() != 1) {
        return false;
    }
    if !bytes.iter().all(u8::is_ascii_digit) {
        return false;
    }
    value
        .parse::<u64>()
        .is_ok_and(|index| index <= MAX_SAFE_JAVASCRIPT_INTEGER)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::MetadataValidationError;
    use crate::{
        HookReturnInfo, MAX_METADATA_NAMESPACE_DEPTH, MODULE_REACTIVE_METADATA_VERSION,
        ModuleReactiveMetadata, ReactiveExportKind,
    };

    fn metadata_at_namespace_depth(depth: usize) -> ModuleReactiveMetadata {
        let mut metadata = ModuleReactiveMetadata::new();
        for level in 0..depth {
            metadata = ModuleReactiveMetadata {
                namespaces: BTreeMap::from([(format!("level{level}"), metadata)]),
                ..ModuleReactiveMetadata::new()
            };
        }
        metadata
    }

    #[test]
    fn emits_deterministic_metadata_and_requires_the_versioned_schema() {
        let mut metadata = ModuleReactiveMetadata::new();
        metadata
            .exports
            .insert("zeta".to_owned(), ReactiveExportKind::Memo);
        metadata
            .exports
            .insert("__proto__".to_owned(), ReactiveExportKind::Signal);
        metadata
            .exports
            .insert("alpha".to_owned(), ReactiveExportKind::Store);

        let serialized = serde_json::to_string(&metadata).expect("serialize metadata");
        assert_eq!(
            serialized,
            r#"{"version":1,"exports":{"__proto__":"signal","alpha":"store","zeta":"memo"}}"#
        );
        assert_eq!(metadata.validate(), Ok(()));

        for invalid in [
            json!({ "exports": {} }),
            json!({
                "version": null,
                "exports": {}
            }),
            json!({
                "version": 1,
                "exports": {},
                "legacy": true
            }),
            json!({
                "version": 1,
                "exports": {},
                "hooks": { "useValue": { "unknown": true } }
            }),
        ] {
            assert!(serde_json::from_value::<ModuleReactiveMetadata>(invalid).is_err());
        }
    }

    #[test]
    fn rejects_unsupported_versions_and_noncanonical_array_indices() {
        let mut metadata = ModuleReactiveMetadata::new();
        metadata.version = MODULE_REACTIVE_METADATA_VERSION + 1;
        assert!(matches!(
            metadata.validate(),
            Err(MetadataValidationError::UnsupportedVersion { .. })
        ));

        metadata.version = MODULE_REACTIVE_METADATA_VERSION;
        metadata.hooks.insert(
            "useTuple".to_owned(),
            HookReturnInfo {
                array_props: BTreeMap::from([("01".to_owned(), ReactiveExportKind::Signal)]),
                ..HookReturnInfo::default()
            },
        );
        assert!(matches!(
            metadata.validate(),
            Err(MetadataValidationError::InvalidArrayIndex { .. })
        ));
    }

    #[test]
    fn enforces_namespace_depth_boundaries_iteratively() {
        assert_eq!(MAX_METADATA_NAMESPACE_DEPTH, 32);

        for depth in [31, 32] {
            assert_eq!(metadata_at_namespace_depth(depth).validate(), Ok(()));
        }

        for depth in [33, 63, 64, 65] {
            assert!(matches!(
                metadata_at_namespace_depth(depth).validate(),
                Err(MetadataValidationError::NamespaceDepthExceeded { .. })
            ));
        }
    }
}
