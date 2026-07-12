use serde::{Deserialize, Serialize};

/// Standard non-indexed Source Map v3 payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawSourceMap {
    /// Source Map specification version; only v3 is accepted.
    pub version: u8,
    /// Optional generated filename.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// Optional root prepended by source-map consumers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_root: Option<String>,
    /// Original source identities.
    pub sources: Vec<String>,
    /// Optional source bodies aligned with `sources`; null entries are allowed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources_content: Option<Vec<Option<String>>>,
    /// Original symbol names referenced by mappings.
    #[serde(default)]
    pub names: Vec<String>,
    /// Base64-VLQ mappings.
    pub mappings: String,
    /// Optional source indices ignored by supported debuggers.
    #[serde(
        default,
        rename = "x_google_ignoreList",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub ignore_list: Vec<u32>,
}

impl RawSourceMap {
    /// Validate cross-field Source Map v3 invariants without resolving files.
    pub fn validate(&self) -> Result<(), SourceMapValidationError> {
        if self.version != 3 {
            return Err(SourceMapValidationError::UnsupportedVersion(self.version));
        }
        if let Some(contents) = &self.sources_content
            && contents.len() != self.sources.len()
        {
            return Err(SourceMapValidationError::SourcesContentLength {
                sources: self.sources.len(),
                sources_content: contents.len(),
            });
        }
        for &index in &self.ignore_list {
            let index = usize::try_from(index)
                .map_err(|_| SourceMapValidationError::InvalidIgnoreIndex(index))?;
            if index >= self.sources.len() {
                return Err(SourceMapValidationError::InvalidIgnoreIndex(
                    u32::try_from(index).unwrap_or(u32::MAX),
                ));
            }
        }
        Ok(())
    }
}

/// Fail-closed validation error for an input or output source map.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceMapValidationError {
    /// Only Source Map v3 is supported.
    UnsupportedVersion(u8),
    /// `sourcesContent` must align exactly with `sources` when present.
    SourcesContentLength {
        /// Number of source identities.
        sources: usize,
        /// Number of source bodies/null placeholders.
        sources_content: usize,
    },
    /// Ignore-list entry does not refer to a source.
    InvalidIgnoreIndex(u32),
}

impl std::fmt::Display for SourceMapValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedVersion(version) => {
                write!(
                    formatter,
                    "unsupported source map version {version}; expected 3"
                )
            }
            Self::SourcesContentLength {
                sources,
                sources_content,
            } => write!(
                formatter,
                "source map has {sources} sources but {sources_content} sourcesContent entries"
            ),
            Self::InvalidIgnoreIndex(index) => {
                write!(
                    formatter,
                    "source map ignore-list index {index} is out of bounds"
                )
            }
        }
    }
}

impl std::error::Error for SourceMapValidationError {}

#[cfg(test)]
mod tests {
    use super::{RawSourceMap, SourceMapValidationError};

    fn source_map() -> RawSourceMap {
        RawSourceMap {
            version: 3,
            file: Some("output.js".to_owned()),
            source_root: None,
            sources: vec!["input.tsx".to_owned()],
            sources_content: Some(vec![Some("export const value = 1".to_owned())]),
            names: Vec::new(),
            mappings: "AAAA".to_owned(),
            ignore_list: Vec::new(),
        }
    }

    #[test]
    fn validates_source_map_cross_field_lengths() {
        assert_eq!(source_map().validate(), Ok(()));

        let mut map = source_map();
        map.sources_content = Some(Vec::new());
        assert!(matches!(
            map.validate(),
            Err(SourceMapValidationError::SourcesContentLength { .. })
        ));

        let mut map = source_map();
        map.ignore_list.push(1);
        assert_eq!(
            map.validate(),
            Err(SourceMapValidationError::InvalidIgnoreIndex(1))
        );
    }
}
