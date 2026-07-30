use fict_compiler_oxc::{compose_source_map_json, validate_source_map_json};
use serde::{Deserialize, Serialize};

/// Standard non-indexed Source Map v3 payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
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
        let json = serde_json::to_string(self).map_err(|error| {
            SourceMapValidationError::InvalidMappings(format!(
                "cannot serialize source map: {error}"
            ))
        })?;
        validate_source_map_json(&json).map_err(SourceMapValidationError::InvalidMappings)?;
        Ok(())
    }

    /// Validate that this upstream map can be composed with output generated from `source`.
    pub(crate) fn validate_for_generated_source(
        &self,
        source: &str,
    ) -> Result<(), SourceMapValidationError> {
        self.validate()?;
        let generated = Self {
            version: 3,
            file: None,
            source_root: None,
            sources: vec![source.to_owned()],
            sources_content: None,
            names: Vec::new(),
            mappings: "AAAA".to_owned(),
            ignore_list: Vec::new(),
        };
        compose_source_maps(&generated, self)
            .map(|_| ())
            .map_err(
                |message| SourceMapValidationError::IncompatibleGeneratedSource {
                    source: source.to_owned(),
                    message,
                },
            )
    }
}

pub(crate) fn compose_source_maps(
    generated: &RawSourceMap,
    input: &RawSourceMap,
) -> Result<RawSourceMap, String> {
    let generated_json = serde_json::to_string(generated)
        .map_err(|error| format!("cannot serialize generated source map: {error}"))?;
    let input_json = serde_json::to_string(input)
        .map_err(|error| format!("cannot serialize input source map: {error}"))?;
    let composed_json = compose_source_map_json(&generated_json, &input_json)?;
    serde_json::from_str(&composed_json)
        .map_err(|error| format!("cannot encode composed source map: {error}"))
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
    /// Base64-VLQ mappings are malformed or refer outside the declared tables.
    InvalidMappings(String),
    /// The map's generated-file identity cannot be composed with this request source.
    IncompatibleGeneratedSource {
        /// Physical source identity supplied to the compiler.
        source: String,
        /// Composition failure reported by the source-map engine.
        message: String,
    },
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
            Self::InvalidMappings(message) => formatter.write_str(message),
            Self::IncompatibleGeneratedSource { source, message } => write!(
                formatter,
                "source map cannot compose with generated source {source:?}: {message}"
            ),
        }
    }
}

impl std::error::Error for SourceMapValidationError {}

#[cfg(test)]
mod tests {
    use oxc_sourcemap::{SourceMap as OxcSourceMap, SourceMapBuilder};

    use super::{RawSourceMap, SourceMapValidationError, compose_source_maps};

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

        let mut map = source_map();
        map.mappings = "!".to_owned();
        assert!(matches!(
            map.validate(),
            Err(SourceMapValidationError::InvalidMappings(_))
        ));
    }

    #[test]
    fn validates_the_upstream_generated_file_identity() {
        assert_eq!(
            source_map().validate_for_generated_source("output.js"),
            Ok(())
        );

        let error = source_map()
            .validate_for_generated_source("different.js")
            .expect_err("mismatched generated file must be rejected as request input");
        assert!(matches!(
            error,
            SourceMapValidationError::IncompatibleGeneratedSource { .. }
        ));

        let mut anonymous = source_map();
        anonymous.file = None;
        assert_eq!(
            anonymous.validate_for_generated_source("different.js"),
            Ok(())
        );
    }

    #[test]
    fn rejects_indexed_source_map_sections_instead_of_ignoring_them() {
        let mut hybrid = serde_json::to_value(source_map()).expect("source map value");
        hybrid
            .as_object_mut()
            .expect("source map object")
            .insert("sections".to_owned(), serde_json::json!([]));
        let error = serde_json::from_value::<RawSourceMap>(hybrid)
            .expect_err("indexed source map sections must be flattened by the host");
        assert!(
            error.to_string().contains("unknown field `sections`"),
            "{error}"
        );
    }

    #[test]
    fn composes_generated_positions_through_the_input_map() {
        let mut input_builder = SourceMapBuilder::default();
        input_builder.set_file("intermediate.js");
        let input_source = input_builder
            .set_source_and_content("original.tsx", "export const originalName = <button />");
        let input_name = input_builder.add_name("originalName");
        input_builder.add_token(1, 4, 9, 2, Some(input_source), Some(input_name));
        let mut input: RawSourceMap =
            serde_json::from_str(&input_builder.into_sourcemap().to_json_string())
                .expect("input source map");
        input.source_root = Some("../src".to_owned());
        input.ignore_list = vec![0];

        let mut generated_builder = SourceMapBuilder::default();
        generated_builder.set_file("output.js");
        let generated_source =
            generated_builder.set_source_and_content("intermediate.js", "generated");
        let generated_name = generated_builder.add_name("generatedName");
        // Column zero intentionally precedes the first input segment so composition must clamp
        // to that segment instead of dropping the mapping.
        generated_builder.add_token(3, 7, 1, 0, Some(generated_source), Some(generated_name));
        let generated: RawSourceMap =
            serde_json::from_str(&generated_builder.into_sourcemap().to_json_string())
                .expect("generated source map");

        let composed = compose_source_maps(&generated, &input).expect("composed source map");

        assert_eq!(composed.file.as_deref(), Some("output.js"));
        assert_eq!(composed.source_root.as_deref(), Some("../src"));
        assert_eq!(composed.sources, ["original.tsx"]);
        assert_eq!(
            composed.sources_content,
            Some(vec![Some(
                "export const originalName = <button />".to_owned()
            )])
        );
        assert_eq!(composed.ignore_list, [0]);
        let json = serde_json::to_string(&composed).expect("serialized composed map");
        let decoded = OxcSourceMap::from_json_string(&json).expect("decoded composed map");
        let table = decoded.generate_lookup_table();
        let token = decoded
            .lookup_source_view_token(&table, 3, 7)
            .expect("composed token");
        assert_eq!(token.get_source(), Some("original.tsx"));
        assert_eq!((token.get_src_line(), token.get_src_col()), (9, 2));
        assert_eq!(token.get_name(), Some("originalName"));
    }
}
