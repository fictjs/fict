use serde::{Deserialize, Deserializer, Serialize};

use crate::{MetadataValidationError, ModuleReactiveMetadata};

/// Authoritative resolution state supplied by the JavaScript module-graph host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MetadataResolutionStatus {
    /// Resolution and metadata are complete and authoritative.
    Resolved,
    /// Resolution succeeded, but the target intentionally exposes no Fict metadata.
    Opaque,
    /// The graph host authoritatively could not resolve metadata.
    Missing,
    /// A bounded SCC fixed point has not yet converged.
    IncompleteCycle,
}

/// Serializable metadata snapshot entry; no resolver callback crosses N-API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedMetadataInput {
    /// Import/re-export specifier requested by the source module.
    pub request: String,
    /// Bundler-authoritative module identity, absent only for a missing request.
    #[serde(deserialize_with = "deserialize_required_option")]
    pub resolved_id: Option<String>,
    /// Resolution state.
    pub status: MetadataResolutionStatus,
    /// Complete or partial metadata, depending on `status`.
    #[serde(deserialize_with = "deserialize_required_option")]
    pub metadata: Option<ModuleReactiveMetadata>,
    /// Host-owned content/dependency fingerprint used in compiler cache keys.
    pub fingerprint: String,
}

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

impl ResolvedMetadataInput {
    /// Validate status-dependent fields and nested metadata.
    pub fn validate(&self) -> Result<(), MetadataValidationError> {
        if self.request.trim().is_empty() {
            return Err(MetadataValidationError::EmptyRequest);
        }
        if self.fingerprint.trim().is_empty() {
            return Err(MetadataValidationError::EmptyFingerprint {
                request: self.request.clone(),
            });
        }
        if self
            .resolved_id
            .as_ref()
            .is_some_and(|resolved_id| resolved_id.trim().is_empty())
        {
            return Err(MetadataValidationError::EmptyResolvedId {
                request: self.request.clone(),
            });
        }

        match self.status {
            MetadataResolutionStatus::Resolved => {
                self.require_resolved_id()?;
                let metadata = self.metadata.as_ref().ok_or_else(|| {
                    MetadataValidationError::MissingMetadata {
                        request: self.request.clone(),
                        status: self.status,
                    }
                })?;
                metadata.validate()?;
            }
            MetadataResolutionStatus::Opaque | MetadataResolutionStatus::Missing => {
                if self.status == MetadataResolutionStatus::Opaque {
                    self.require_resolved_id()?;
                }
                if self.metadata.is_some() {
                    return Err(MetadataValidationError::UnexpectedMetadata {
                        request: self.request.clone(),
                        status: self.status,
                    });
                }
            }
            MetadataResolutionStatus::IncompleteCycle => {
                self.require_resolved_id()?;
                if let Some(metadata) = &self.metadata {
                    metadata.validate()?;
                }
            }
        }

        Ok(())
    }

    fn require_resolved_id(&self) -> Result<&str, MetadataValidationError> {
        self.resolved_id
            .as_deref()
            .ok_or_else(|| MetadataValidationError::MissingResolvedId {
                request: self.request.clone(),
                status: self.status,
            })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{MetadataResolutionStatus, ResolvedMetadataInput};
    use crate::{MetadataValidationError, ModuleReactiveMetadata};

    fn input(status: MetadataResolutionStatus) -> ResolvedMetadataInput {
        ResolvedMetadataInput {
            request: "./counter".to_owned(),
            resolved_id: Some("/src/counter.tsx?client".to_owned()),
            status,
            metadata: None,
            fingerprint: "sha256:counter".to_owned(),
        }
    }

    #[test]
    fn validates_all_resolution_states() {
        let mut resolved = input(MetadataResolutionStatus::Resolved);
        resolved.metadata = Some(ModuleReactiveMetadata::new());
        assert_eq!(resolved.validate(), Ok(()));

        assert_eq!(input(MetadataResolutionStatus::Opaque).validate(), Ok(()));

        let mut missing = input(MetadataResolutionStatus::Missing);
        missing.resolved_id = None;
        assert_eq!(missing.validate(), Ok(()));

        let mut incomplete = input(MetadataResolutionStatus::IncompleteCycle);
        incomplete.metadata = Some(ModuleReactiveMetadata::new());
        assert_eq!(incomplete.validate(), Ok(()));
        assert_eq!(
            serde_json::to_value(&incomplete).expect("serialize resolved metadata"),
            json!({
                "request": "./counter",
                "resolvedId": "/src/counter.tsx?client",
                "status": "incompleteCycle",
                "metadata": { "version": 1, "exports": {} },
                "fingerprint": "sha256:counter"
            })
        );
    }

    #[test]
    fn rejects_inconsistent_status_payloads_without_panicking() {
        let mut resolved = input(MetadataResolutionStatus::Resolved);
        assert!(matches!(
            resolved.validate(),
            Err(MetadataValidationError::MissingMetadata { .. })
        ));

        resolved.status = MetadataResolutionStatus::Opaque;
        resolved.metadata = Some(ModuleReactiveMetadata::new());
        assert!(matches!(
            resolved.validate(),
            Err(MetadataValidationError::UnexpectedMetadata { .. })
        ));

        resolved.metadata = None;
        resolved.resolved_id = None;
        assert!(matches!(
            resolved.validate(),
            Err(MetadataValidationError::MissingResolvedId { .. })
        ));
    }

    #[test]
    fn requires_nullable_protocol_fields_to_be_present() {
        let missing_resolved_id = json!({
            "request": "package",
            "status": "missing",
            "metadata": null,
            "fingerprint": "missing:package"
        });
        assert!(serde_json::from_value::<ResolvedMetadataInput>(missing_resolved_id).is_err());

        let missing_metadata = json!({
            "request": "package",
            "resolvedId": null,
            "status": "missing",
            "fingerprint": "missing:package"
        });
        assert!(serde_json::from_value::<ResolvedMetadataInput>(missing_metadata).is_err());
    }
}
