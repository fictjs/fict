use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::Diagnostic;
use fict_metadata::{MetadataValidationError, ResolvedMetadataInput};
use serde::{Deserialize, Serialize};

use crate::{
    COMPILER_PROTOCOL_VERSION, RawSourceMap, SourceMapValidationError,
    diagnostic_policy::strict_guarantee_pattern_overlaps,
};

const DEFAULT_AUTO_EXTRACT_THRESHOLD: u32 = 3;

const fn protocol_version() -> u32 {
    COMPILER_PROTOCOL_VERSION
}

/// JavaScript/TypeScript grammar selected after request normalization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceLanguage {
    /// JavaScript without JSX.
    #[serde(rename = "js")]
    JavaScript,
    /// JavaScript with JSX.
    #[serde(rename = "jsx")]
    JavaScriptJsx,
    /// TypeScript without JSX.
    #[serde(rename = "ts")]
    TypeScript,
    /// TypeScript with JSX.
    #[serde(rename = "tsx")]
    TypeScriptJsx,
}

/// Module grammar and output intent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModuleKind {
    /// ECMAScript module.
    Module,
    /// Classic script.
    Script,
    /// CommonJS, including CTS top-level return and export assignment.
    CommonJs,
    /// Infer module/script from syntax in the OXC adapter.
    Unambiguous,
}

/// Optimizer safety level preserved from the TypeScript compiler.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OptimizeLevel {
    /// Preserve conservative JavaScript semantics.
    #[default]
    Safe,
    /// Permit explicitly approved algebraic rewrites.
    Full,
}

/// Per-code diagnostic policy override.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WarningLevel {
    /// Suppress a non-guarantee diagnostic.
    Off,
    /// Emit a warning.
    Warn,
    /// Escalate to an error.
    Error,
}

/// Serializable equivalent of `boolean | string[]` warning escalation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum WarningsAsErrors {
    /// `true` escalates every warning; `false` disables global escalation.
    Boolean(bool),
    /// Diagnostic codes/prefix patterns to escalate.
    Codes(Vec<String>),
}

impl Default for WarningsAsErrors {
    fn default() -> Self {
        Self::Boolean(false)
    }
}

/// TypeScript compatibility controls carried as pure request data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct CompilerTypeScriptOptions {
    /// Enable runtime namespace lowering.
    pub allow_namespaces: bool,
    /// Preserve value imports unless explicitly marked type-only.
    pub only_remove_type_imports: bool,
    /// Inline const enum values where semantics permit.
    pub optimize_const_enums: bool,
    /// Inline regular enum members where semantics permit.
    pub optimize_enums: bool,
    /// Rewrite relative TypeScript module extensions.
    pub rewrite_import_extensions: bool,
    /// Remove uninitialized class fields in assignment-semantics compatibility mode.
    pub remove_class_fields_without_initializer: bool,
}

impl Default for CompilerTypeScriptOptions {
    fn default() -> Self {
        Self {
            allow_namespaces: true,
            only_remove_type_imports: false,
            optimize_const_enums: false,
            optimize_enums: false,
            rewrite_import_extensions: false,
            remove_class_fields_without_initializer: false,
        }
    }
}

/// Default-off Preview options carried as data but implemented in the optional crate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct CompilerPreviewOptions {
    /// Emit resumable output and handler artifacts.
    pub resumable: bool,
    /// Extract eligible event handlers without an explicit `$` suffix.
    pub auto_extract_handlers: bool,
    /// Minimum handler AST-node count for automatic extraction.
    pub auto_extract_threshold: u32,
}

impl Default for CompilerPreviewOptions {
    fn default() -> Self {
        Self {
            resumable: false,
            auto_extract_handlers: true,
            auto_extract_threshold: DEFAULT_AUTO_EXTRACT_THRESHOLD,
        }
    }
}

/// Serializable compiler options; callbacks, resolvers, filesystem, and TS programs are absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct CompilerOptions {
    /// Enable development diagnostics/output.
    pub dev: bool,
    /// Emit a source map.
    pub sourcemap: bool,
    /// Return a structured explanation artifact.
    pub explain: bool,
    /// Enable lazy conditional-derived evaluation.
    pub lazy_conditional: bool,
    /// Cache repeated getter reads within a synchronous region.
    pub getter_cache: bool,
    /// Emit fine-grained DOM operations.
    pub fine_grained_dom: bool,
    /// Run the Fict optimizer.
    pub optimize: bool,
    /// Optimizer safety policy.
    pub optimize_level: OptimizeLevel,
    /// Inline safe single-use derived values.
    pub inline_derived_memos: bool,
    /// Escalate documented control-flow fallback diagnostics.
    pub strict_reactivity: bool,
    /// Fail closed for non-guaranteed reactivity.
    pub strict_guarantee: bool,
    /// Global/code-specific warning escalation.
    pub warnings_as_errors: WarningsAsErrors,
    /// Per-code/prefix warning policy.
    pub warning_levels: BTreeMap<String, WarningLevel>,
    /// Direct-call functions whose first callback is a reactive scope.
    pub reactive_scopes: Vec<String>,
    /// TypeScript lowering compatibility controls.
    pub typescript: CompilerTypeScriptOptions,
    /// Optional Preview configuration, kept out of the stable pass graph by feature gating.
    pub preview: Option<CompilerPreviewOptions>,
}

impl Default for CompilerOptions {
    fn default() -> Self {
        Self {
            dev: false,
            sourcemap: false,
            explain: false,
            lazy_conditional: true,
            getter_cache: true,
            fine_grained_dom: true,
            optimize: true,
            optimize_level: OptimizeLevel::Safe,
            inline_derived_memos: true,
            strict_reactivity: false,
            strict_guarantee: true,
            warnings_as_errors: WarningsAsErrors::default(),
            warning_levels: BTreeMap::new(),
            reactive_scopes: Vec::new(),
            typescript: CompilerTypeScriptOptions::default(),
            preview: None,
        }
    }
}

/// Public serializable request accepted by sync and async compiler entrypoints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CompileRequest {
    /// Protocol version; defaults to the current version when omitted.
    #[serde(default = "protocol_version")]
    pub protocol_version: u32,
    /// Complete source text.
    pub code: String,
    /// Physical/source-map identity used for diagnostics and language inference.
    pub filename: String,
    /// Bundler identity. Query and fragment suffixes are semantically significant.
    #[serde(default)]
    pub module_id: Option<String>,
    /// Explicit grammar, or infer from a recognized filename extension.
    #[serde(default)]
    pub language: Option<SourceLanguage>,
    /// Explicit module grammar, or infer from `.mjs/.mts/.cjs/.cts` and default to ESM.
    #[serde(default)]
    pub module_kind: Option<ModuleKind>,
    /// Optional upstream map to compose with generated mappings.
    #[serde(default)]
    pub input_source_map: Option<RawSourceMap>,
    /// Pure compiler options.
    #[serde(default)]
    pub options: CompilerOptions,
    /// Bundler-authoritative resolved metadata snapshot.
    #[serde(default)]
    pub metadata: Vec<ResolvedMetadataInput>,
    /// Diagnostics supplied by an official integration before traversal.
    #[serde(default)]
    pub integration_diagnostics: Vec<Diagnostic>,
}

impl CompileRequest {
    /// Validate and make all inferred identities/source modes explicit.
    pub fn normalize(self) -> Result<NormalizedCompileRequest, CompileRequestError> {
        if self.protocol_version != COMPILER_PROTOCOL_VERSION {
            return Err(CompileRequestError::UnsupportedProtocolVersion(
                self.protocol_version,
            ));
        }
        validate_identity("filename", &self.filename, false)?;
        if let Some(module_id) = &self.module_id {
            validate_identity("moduleId", module_id, false)?;
        }

        let physical_name = strip_query_and_fragment(&self.filename);
        validate_identity("filename", physical_name, false)?;
        let language = self
            .language
            .or_else(|| infer_language(physical_name))
            .ok_or_else(|| CompileRequestError::CannotInferLanguage(self.filename.clone()))?;
        let module_kind = self
            .module_kind
            .unwrap_or_else(|| infer_module_kind(physical_name));
        let module_id = self.module_id.unwrap_or_else(|| self.filename.clone());
        let filename = physical_name.to_owned();

        if let Some(source_map) = &self.input_source_map {
            source_map
                .validate()
                .map_err(CompileRequestError::InvalidSourceMap)?;
        }

        if let Some(preview) = &self.options.preview
            && preview.auto_extract_handlers
            && preview.auto_extract_threshold == 0
        {
            return Err(CompileRequestError::InvalidPreviewThreshold);
        }

        if self.options.strict_guarantee
            && let Some((pattern, level)) =
                self.options.warning_levels.iter().find(|(pattern, level)| {
                    **level != WarningLevel::Error && strict_guarantee_pattern_overlaps(pattern)
                })
        {
            return Err(CompileRequestError::StrictGuaranteeWarningDowngrade {
                pattern: pattern.clone(),
                level: *level,
            });
        }

        let mut requests = BTreeSet::new();
        for (index, metadata) in self.metadata.iter().enumerate() {
            metadata
                .validate()
                .map_err(|source| CompileRequestError::InvalidMetadata { index, source })?;
            if !requests.insert(metadata.request.clone()) {
                return Err(CompileRequestError::DuplicateMetadataRequest(
                    metadata.request.clone(),
                ));
            }
        }

        Ok(NormalizedCompileRequest {
            protocol_version: self.protocol_version,
            code: self.code,
            filename,
            module_id,
            language,
            module_kind,
            input_source_map: self.input_source_map,
            options: self.options,
            metadata: self.metadata,
            integration_diagnostics: self.integration_diagnostics,
        })
    }
}

/// Fully validated request consumed by native compiler passes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedCompileRequest {
    /// Validated protocol version.
    pub protocol_version: u32,
    /// Source text.
    pub code: String,
    /// Diagnostic/source-map identity.
    pub filename: String,
    /// Complete graph/cache identity with query/fragment preserved.
    pub module_id: String,
    /// Explicit source grammar.
    pub language: SourceLanguage,
    /// Explicit module grammar.
    pub module_kind: ModuleKind,
    /// Validated optional input map.
    pub input_source_map: Option<RawSourceMap>,
    /// Serializable compiler options.
    pub options: CompilerOptions,
    /// Validated metadata snapshot.
    pub metadata: Vec<ResolvedMetadataInput>,
    /// Integration-owned diagnostics.
    pub integration_diagnostics: Vec<Diagnostic>,
}

/// Fail-closed request normalization error.
#[derive(Debug)]
pub enum CompileRequestError {
    /// Request belongs to an incompatible protocol.
    UnsupportedProtocolVersion(u32),
    /// Required or optional identity is empty.
    EmptyIdentity(&'static str),
    /// Identity contains a NUL byte and cannot be safely propagated.
    IdentityContainsNull(&'static str),
    /// Filename has no supported extension and language was not explicit.
    CannotInferLanguage(String),
    /// Input map violates Source Map v3 invariants.
    InvalidSourceMap(SourceMapValidationError),
    /// Metadata entry is malformed.
    InvalidMetadata {
        /// Index in the request snapshot.
        index: usize,
        /// Metadata validation failure.
        source: MetadataValidationError,
    },
    /// More than one snapshot entry claims the same request specifier.
    DuplicateMetadataRequest(String),
    /// Automatic Preview extraction cannot use a zero-node threshold.
    InvalidPreviewThreshold,
    /// Fail-closed diagnostics cannot be disabled or downgraded.
    StrictGuaranteeWarningDowngrade {
        /// Exact code or numeric-prefix pattern.
        pattern: String,
        /// Rejected severity override.
        level: WarningLevel,
    },
}

impl std::fmt::Display for CompileRequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedProtocolVersion(version) => write!(
                formatter,
                "unsupported compiler protocol version {version}; expected {COMPILER_PROTOCOL_VERSION}"
            ),
            Self::EmptyIdentity(field) => write!(formatter, "{field} must not be empty"),
            Self::IdentityContainsNull(field) => {
                write!(formatter, "{field} must not contain a NUL byte")
            }
            Self::CannotInferLanguage(filename) => write!(
                formatter,
                "cannot infer source language from {filename:?}; provide language explicitly"
            ),
            Self::InvalidSourceMap(source) => {
                write!(formatter, "invalid input source map: {source}")
            }
            Self::InvalidMetadata { index, source } => {
                write!(formatter, "invalid metadata entry {index}: {source}")
            }
            Self::DuplicateMetadataRequest(request) => {
                write!(formatter, "duplicate metadata request {request:?}")
            }
            Self::InvalidPreviewThreshold => {
                formatter.write_str("Preview auto-extract threshold must be greater than zero")
            }
            Self::StrictGuaranteeWarningDowngrade { pattern, level } => write!(
                formatter,
                "strictGuarantee does not allow downgrading {pattern} to \"{}\"",
                warning_level_name(*level)
            ),
        }
    }
}

const fn warning_level_name(level: WarningLevel) -> &'static str {
    match level {
        WarningLevel::Off => "off",
        WarningLevel::Warn => "warn",
        WarningLevel::Error => "error",
    }
}

impl std::error::Error for CompileRequestError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::InvalidSourceMap(source) => Some(source),
            Self::InvalidMetadata { source, .. } => Some(source),
            _ => None,
        }
    }
}

fn validate_identity(
    field: &'static str,
    value: &str,
    allow_empty: bool,
) -> Result<(), CompileRequestError> {
    if !allow_empty && value.trim().is_empty() {
        return Err(CompileRequestError::EmptyIdentity(field));
    }
    if value.contains('\0') {
        return Err(CompileRequestError::IdentityContainsNull(field));
    }
    Ok(())
}

fn strip_query_and_fragment(filename: &str) -> &str {
    let query = filename.find('?').unwrap_or(filename.len());
    let fragment = filename.find('#').unwrap_or(filename.len());
    &filename[..query.min(fragment)]
}

fn infer_language(filename: &str) -> Option<SourceLanguage> {
    let filename = filename.to_ascii_lowercase();
    if filename.ends_with(".tsx") {
        Some(SourceLanguage::TypeScriptJsx)
    } else if filename.ends_with(".ts") || filename.ends_with(".mts") || filename.ends_with(".cts")
    {
        Some(SourceLanguage::TypeScript)
    } else if filename.ends_with(".jsx") {
        Some(SourceLanguage::JavaScriptJsx)
    } else if filename.ends_with(".js") || filename.ends_with(".mjs") || filename.ends_with(".cjs")
    {
        Some(SourceLanguage::JavaScript)
    } else {
        None
    }
}

fn infer_module_kind(filename: &str) -> ModuleKind {
    let filename = filename.to_ascii_lowercase();
    if filename.ends_with(".cjs") || filename.ends_with(".cts") {
        ModuleKind::CommonJs
    } else {
        ModuleKind::Module
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{CompileRequest, CompileRequestError, CompilerOptions, ModuleKind, SourceLanguage};
    use crate::COMPILER_PROTOCOL_VERSION;

    fn request(filename: &str) -> CompileRequest {
        CompileRequest {
            protocol_version: COMPILER_PROTOCOL_VERSION,
            code: "export const value = 1".to_owned(),
            filename: filename.to_owned(),
            module_id: None,
            language: None,
            module_kind: None,
            input_source_map: None,
            options: CompilerOptions::default(),
            metadata: Vec::new(),
            integration_diagnostics: Vec::new(),
        }
    }

    #[test]
    fn infers_language_and_preserves_complete_module_identity() {
        let mut input = request("/src/view.tsx?worker#client");
        input.module_id = Some("/@id/view.tsx?worker#client".to_owned());
        let normalized = input.normalize().expect("normalize request");

        assert_eq!(normalized.language, SourceLanguage::TypeScriptJsx);
        assert_eq!(normalized.module_kind, ModuleKind::Module);
        assert_eq!(normalized.filename, "/src/view.tsx");
        assert_eq!(normalized.module_id, "/@id/view.tsx?worker#client");
    }

    #[test]
    fn recognizes_cts_as_typescript_commonjs() {
        let normalized = request("module.cts")
            .normalize()
            .expect("normalize request");
        assert_eq!(normalized.language, SourceLanguage::TypeScript);
        assert_eq!(normalized.module_kind, ModuleKind::CommonJs);
    }

    #[test]
    fn rejects_unknown_protocols_and_ambiguous_filenames_without_panicking() {
        let mut input = request("virtual:entry");
        input.protocol_version += 1;
        assert!(matches!(
            input.normalize(),
            Err(CompileRequestError::UnsupportedProtocolVersion(_))
        ));

        let input = request("virtual:entry");
        assert!(matches!(
            input.normalize(),
            Err(CompileRequestError::CannotInferLanguage(_))
        ));
    }

    #[test]
    fn deserializes_serializable_defaults_and_rejects_callbacks() {
        let value = json!({
            "code": "const value: number = 1",
            "filename": "value.ts"
        });
        let input: CompileRequest = serde_json::from_value(value).expect("deserialize request");
        assert_eq!(input.protocol_version, COMPILER_PROTOCOL_VERSION);
        assert!(input.options.strict_guarantee);
        assert!(input.options.typescript.allow_namespaces);
        assert!(!input.options.typescript.rewrite_import_extensions);

        let typescript_options = json!({
            "code": "import './value.ts'",
            "filename": "value.ts",
            "options": {
                "typescript": {
                    "rewriteImportExtensions": true,
                    "optimizeConstEnums": true
                }
            }
        });
        let input: CompileRequest =
            serde_json::from_value(typescript_options).expect("TypeScript options");
        assert!(input.options.typescript.rewrite_import_extensions);
        assert!(input.options.typescript.optimize_const_enums);

        let callback_shaped = json!({
            "code": "const value = 1",
            "filename": "value.js",
            "options": { "onWarn": "callback" }
        });
        assert!(serde_json::from_value::<CompileRequest>(callback_shaped).is_err());

        let unknown_typescript_option = json!({
            "code": "const value = 1",
            "filename": "value.ts",
            "options": { "typescript": { "transpileOnly": true } }
        });
        assert!(serde_json::from_value::<CompileRequest>(unknown_typescript_option).is_err());
    }
}
