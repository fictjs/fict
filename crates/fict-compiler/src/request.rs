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
    /// Apply the opt-in authored algebraic folding profile.
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
    /// Include source labels for reactive runtime DevTools registrations.
    pub dev: bool,
    /// Emit a source map.
    pub sourcemap: bool,
    /// Return a structured explanation artifact.
    pub explain: bool,
    /// Lower supported reactive control-flow returns through lazy runtime branches.
    pub lazy_conditional: bool,
    /// Cache repeated signal/accessor reads within safe synchronous callback blocks.
    pub getter_cache: bool,
    /// Emit fine-grained DOM operations.
    pub fine_grained_dom: bool,
    /// Run the Fict optimizer.
    pub optimize: bool,
    /// Optimizer safety policy; `full` enables additional authored algebraic folding.
    pub optimize_level: OptimizeLevel,
    /// Inline eligible single-use derived memos with user-authored names.
    pub inline_derived_memos: bool,
    /// Escalate documented control-flow fallback diagnostics.
    pub strict_reactivity: bool,
    /// Fail closed for non-guaranteed reactivity.
    pub strict_guarantee: bool,
    /// Global/code-specific warning escalation.
    pub warnings_as_errors: WarningsAsErrors,
    /// Per-code/prefix warning policy.
    pub warning_levels: BTreeMap<String, WarningLevel>,
    /// Direct identifier or static-member hosts whose first callback is a reactive scope.
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
    /// Stable, host-owned identity embedded in Preview QRLs instead of a physical path.
    #[serde(default)]
    pub public_module_id: Option<String>,
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

/// Serializable parse-only request used by module-graph hosts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ScanRequest {
    /// Protocol version; defaults to the current version when omitted.
    #[serde(default = "protocol_version")]
    pub protocol_version: u32,
    /// Complete source text.
    pub code: String,
    /// Physical identity used for diagnostics and language inference.
    pub filename: String,
    /// Complete graph identity. Query and fragment suffixes are preserved.
    #[serde(default)]
    pub module_id: Option<String>,
    /// Explicit grammar, or infer from a recognized filename extension.
    #[serde(default)]
    pub language: Option<SourceLanguage>,
    /// Explicit module grammar, or infer from the filename.
    #[serde(default)]
    pub module_kind: Option<ModuleKind>,
}

/// Trace density requested by editor and playground analysis hosts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnalyzeVerbosity {
    /// Report only compiler decisions that affect reactive behavior.
    #[default]
    Minimal,
    /// Also report source operations that execute once during setup.
    Verbose,
}

const fn default_true() -> bool {
    true
}

/// Serializable controls for the native tooling analysis pipeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct AnalyzeOptions {
    /// Include the recursive reactive-region tree for every component or hook.
    #[serde(default = "default_true")]
    pub include_regions: bool,
    /// Include compiler diagnostics normalized to line and column locations.
    #[serde(default = "default_true")]
    pub include_diagnostics: bool,
    /// Requested trace density.
    pub verbosity: AnalyzeVerbosity,
    /// Pure compiler policy and frontend options used during analysis.
    pub compiler_options: CompilerOptions,
}

impl Default for AnalyzeOptions {
    fn default() -> Self {
        Self {
            include_regions: true,
            include_diagnostics: true,
            verbosity: AnalyzeVerbosity::Minimal,
            compiler_options: CompilerOptions::default(),
        }
    }
}

/// Public serializable request accepted by native analysis entrypoints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AnalyzeRequest {
    /// Protocol version; defaults to the current version when omitted.
    #[serde(default = "protocol_version")]
    pub protocol_version: u32,
    /// Complete source text.
    pub code: String,
    /// Physical identity used for diagnostics and source-language inference.
    pub filename: String,
    /// Optional complete graph identity; query and fragment suffixes are preserved.
    #[serde(default)]
    pub module_id: Option<String>,
    /// Explicit grammar, or infer from a recognized filename extension.
    #[serde(default)]
    pub language: Option<SourceLanguage>,
    /// Explicit module grammar, or infer from the filename.
    #[serde(default)]
    pub module_kind: Option<ModuleKind>,
    /// Bundler-authoritative resolved metadata snapshot.
    #[serde(default)]
    pub metadata: Vec<ResolvedMetadataInput>,
    /// Diagnostics supplied by an official integration before analysis.
    #[serde(default)]
    pub integration_diagnostics: Vec<Diagnostic>,
    /// Tooling and compiler analysis controls.
    #[serde(default)]
    pub options: AnalyzeOptions,
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
        if let Some(public_module_id) = &self.public_module_id {
            validate_identity("publicModuleId", public_module_id, false)?;
        }

        let source_mode_name = source_mode_filename(&self.filename);
        let language = self
            .language
            .or_else(|| infer_language(source_mode_name))
            .ok_or_else(|| CompileRequestError::CannotInferLanguage(self.filename.clone()))?;
        let module_kind = self
            .module_kind
            .unwrap_or_else(|| infer_module_kind(source_mode_name));
        let module_id = self.module_id.unwrap_or_else(|| self.filename.clone());
        let filename = self.filename;

        if let Some(source_map) = &self.input_source_map {
            source_map
                .validate_for_generated_source(&filename)
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
            public_module_id: self.public_module_id,
            language,
            module_kind,
            input_source_map: self.input_source_map,
            options: self.options,
            metadata: self.metadata,
            integration_diagnostics: self.integration_diagnostics,
        })
    }
}

impl ScanRequest {
    /// Validate and make all inferred identities/source modes explicit.
    pub fn normalize(self) -> Result<NormalizedScanRequest, CompileRequestError> {
        if self.protocol_version != COMPILER_PROTOCOL_VERSION {
            return Err(CompileRequestError::UnsupportedProtocolVersion(
                self.protocol_version,
            ));
        }
        validate_identity("filename", &self.filename, false)?;
        if let Some(module_id) = &self.module_id {
            validate_identity("moduleId", module_id, false)?;
        }

        let source_mode_name = source_mode_filename(&self.filename);
        let language = self
            .language
            .or_else(|| infer_language(source_mode_name))
            .ok_or_else(|| CompileRequestError::CannotInferLanguage(self.filename.clone()))?;
        let module_kind = self
            .module_kind
            .unwrap_or_else(|| infer_module_kind(source_mode_name));

        Ok(NormalizedScanRequest {
            protocol_version: self.protocol_version,
            code: self.code,
            filename: self.filename.clone(),
            module_id: self.module_id.unwrap_or(self.filename),
            language,
            module_kind,
        })
    }
}

impl AnalyzeRequest {
    /// Validate the public request through the same identity and compiler-option contract as a
    /// compilation, while retaining tooling-only controls separately.
    pub fn normalize(self) -> Result<NormalizedAnalyzeRequest, CompileRequestError> {
        let normalized = CompileRequest {
            protocol_version: self.protocol_version,
            code: self.code,
            filename: self.filename,
            module_id: self.module_id,
            public_module_id: None,
            language: self.language,
            module_kind: self.module_kind,
            input_source_map: None,
            options: self.options.compiler_options,
            metadata: self.metadata,
            integration_diagnostics: self.integration_diagnostics,
        }
        .normalize()?;

        Ok(NormalizedAnalyzeRequest {
            protocol_version: normalized.protocol_version,
            code: normalized.code,
            filename: normalized.filename,
            module_id: normalized.module_id,
            language: normalized.language,
            module_kind: normalized.module_kind,
            include_regions: self.options.include_regions,
            include_diagnostics: self.options.include_diagnostics,
            verbosity: self.options.verbosity,
            compiler_options: normalized.options,
            metadata: normalized.metadata,
            integration_diagnostics: normalized.integration_diagnostics,
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
    /// Optional stable identity supplied by the graph host for Preview output.
    pub public_module_id: Option<String>,
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

/// Fully validated scan request consumed by the OXC adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedScanRequest {
    /// Validated protocol version.
    pub protocol_version: u32,
    /// Source text.
    pub code: String,
    /// Physical diagnostic identity preserved verbatim, including query/fragment delimiters.
    pub filename: String,
    /// Complete graph identity with query/fragment preserved.
    pub module_id: String,
    /// Explicit source grammar.
    pub language: SourceLanguage,
    /// Explicit module grammar.
    pub module_kind: ModuleKind,
}

/// Fully validated analysis request consumed by the native tooling pipeline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedAnalyzeRequest {
    /// Validated protocol version.
    pub protocol_version: u32,
    /// Source text.
    pub code: String,
    /// Physical diagnostic identity preserved verbatim, including query/fragment delimiters.
    pub filename: String,
    /// Complete graph identity with query and fragment preserved.
    pub module_id: String,
    /// Explicit source grammar.
    pub language: SourceLanguage,
    /// Explicit module grammar.
    pub module_kind: ModuleKind,
    /// Whether recursive regions are included.
    pub include_regions: bool,
    /// Whether compiler diagnostics are included.
    pub include_diagnostics: bool,
    /// Trace density.
    pub verbosity: AnalyzeVerbosity,
    /// Validated pure compiler policy/options.
    pub compiler_options: CompilerOptions,
    /// Validated metadata snapshot shared with compilation.
    pub metadata: Vec<ResolvedMetadataInput>,
    /// Integration-owned diagnostics shared with compilation.
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

impl CompileRequestError {
    pub(crate) const fn diagnostic_code(&self) -> &'static str {
        "FICT-REQUEST"
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

fn source_mode_filename(filename: &str) -> &str {
    let query = module_query_start(filename);
    let fragment = filename.find('#').unwrap_or(filename.len());
    if has_uri_scheme(filename) {
        return &filename[..query.min(fragment)];
    }
    if is_windows_path(filename) && query < filename.len() {
        return &filename[..query];
    }
    // `filename` is the physical source identity; a literal POSIX `?` or `#` can therefore
    // precede its real extension. Only interpret a delimiter as a bundler suffix when the
    // complete filename does not already provide an unambiguous source mode.
    if infer_language(filename).is_some() {
        return filename;
    }
    &filename[..query.min(fragment)]
}

fn module_query_start(filename: &str) -> usize {
    let search_start = if filename.starts_with(r"\\?\") || filename.starts_with("//?/") {
        4
    } else {
        0
    };
    filename[search_start..]
        .find('?')
        .map_or(filename.len(), |index| search_start + index)
}

fn is_windows_path(filename: &str) -> bool {
    let bytes = filename.as_bytes();
    filename.starts_with("\\\\") || (bytes.get(1) == Some(&b':') && bytes[0].is_ascii_alphabetic())
}

fn has_uri_scheme(filename: &str) -> bool {
    let Some(separator) = filename.find(':') else {
        return false;
    };
    is_uri_scheme(&filename[..separator])
        && (!is_windows_path(filename) || filename[separator + 1..].starts_with("//"))
}

fn is_uri_scheme(candidate: &str) -> bool {
    candidate
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphabetic)
        && candidate
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
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

    use super::{
        AnalyzeRequest, CompileRequest, CompileRequestError, CompilerOptions, ModuleKind,
        ScanRequest, SourceLanguage,
    };
    use crate::{COMPILER_PROTOCOL_VERSION, WarningLevel, compile};

    fn request(filename: &str) -> CompileRequest {
        CompileRequest {
            protocol_version: COMPILER_PROTOCOL_VERSION,
            code: "export const value = 1".to_owned(),
            filename: filename.to_owned(),
            module_id: None,
            public_module_id: None,
            language: None,
            module_kind: None,
            input_source_map: None,
            options: CompilerOptions::default(),
            metadata: Vec::new(),
            integration_diagnostics: Vec::new(),
        }
    }

    #[test]
    fn strict_guarantee_rejects_r004_warning_overrides_during_normalization() {
        for level in [WarningLevel::Warn, WarningLevel::Off] {
            let mut input = request("strict-r004.tsx");
            input
                .options
                .warning_levels
                .insert("FICT-R004".into(), level);

            assert!(matches!(
                input.normalize(),
                Err(CompileRequestError::StrictGuaranteeWarningDowngrade {
                    pattern,
                    level: rejected,
                }) if pattern == "FICT-R004" && rejected == level
            ));
        }
    }

    #[test]
    fn infers_language_and_preserves_complete_module_identity() {
        let mut input = request("/src/view.tsx");
        input.module_id = Some("/@id/view.tsx?worker#client".to_owned());
        input.public_module_id = Some("fict:module:m0123456789abcdef".to_owned());
        let normalized = input.normalize().expect("normalize request");

        assert_eq!(normalized.language, SourceLanguage::TypeScriptJsx);
        assert_eq!(normalized.module_kind, ModuleKind::Module);
        assert_eq!(normalized.filename, "/src/view.tsx");
        assert_eq!(normalized.module_id, "/@id/view.tsx?worker#client");
        assert_eq!(
            normalized.public_module_id.as_deref(),
            Some("fict:module:m0123456789abcdef")
        );
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
    fn scan_normalization_preserves_separate_physical_and_graph_identities() {
        let normalized = ScanRequest {
            protocol_version: COMPILER_PROTOCOL_VERSION,
            code: "import './dep'".into(),
            filename: "/src/module.ts".into(),
            module_id: Some("/@id/module.ts?worker#client".into()),
            language: None,
            module_kind: None,
        }
        .normalize()
        .expect("normalize scan request");

        assert_eq!(normalized.filename, "/src/module.ts");
        assert_eq!(normalized.module_id, "/@id/module.ts?worker#client");
        assert_eq!(normalized.language, SourceLanguage::TypeScript);
        assert_eq!(normalized.module_kind, ModuleKind::Module);
    }

    #[test]
    fn complete_physical_filename_extension_wins_over_delimiter_prefixes() {
        for filename in ["/src/view.ts?lang.tsx", "/src/view.ts#lang.tsx"] {
            let compile = request(filename).normalize().expect("normalize compile");
            assert_eq!(
                compile.language,
                SourceLanguage::TypeScriptJsx,
                "{filename}"
            );
            assert_eq!(compile.module_kind, ModuleKind::Module, "{filename}");

            let scan: ScanRequest = serde_json::from_value(json!({
                "code": "export const value: number = 1",
                "filename": filename,
            }))
            .expect("deserialize scan request");
            let scan = scan.normalize().expect("normalize scan");
            assert_eq!(scan.language, SourceLanguage::TypeScriptJsx, "{filename}");
            assert_eq!(scan.module_kind, ModuleKind::Module, "{filename}");

            let analyze: AnalyzeRequest = serde_json::from_value(json!({
                "code": "export const value: number = 1",
                "filename": filename,
            }))
            .expect("deserialize analysis request");
            let analyze = analyze.normalize().expect("normalize analysis");
            assert_eq!(
                analyze.language,
                SourceLanguage::TypeScriptJsx,
                "{filename}"
            );
            assert_eq!(analyze.module_kind, ModuleKind::Module, "{filename}");
        }

        for normalized in [
            request("/src/legacy.cts?lang.tsx")
                .normalize()
                .map(|request| (request.language, request.module_kind)),
            serde_json::from_value::<ScanRequest>(json!({
                "code": "export = 1",
                "filename": "/src/legacy.cts?lang.tsx",
            }))
            .expect("deserialize scan request")
            .normalize()
            .map(|request| (request.language, request.module_kind)),
            serde_json::from_value::<AnalyzeRequest>(json!({
                "code": "export = 1",
                "filename": "/src/legacy.cts?lang.tsx",
            }))
            .expect("deserialize analysis request")
            .normalize()
            .map(|request| (request.language, request.module_kind)),
        ] {
            assert_eq!(
                normalized.expect("normalize physical TSX request"),
                (SourceLanguage::TypeScriptJsx, ModuleKind::Module)
            );
        }

        let normalized = request("/src/legacy.cjs?view.mjs")
            .normalize()
            .expect("normalize physical MJS request");
        assert_eq!(normalized.language, SourceLanguage::JavaScript);
        assert_eq!(normalized.module_kind, ModuleKind::Module);
    }

    #[test]
    fn strips_module_suffixes_when_the_complete_filename_has_no_source_extension() {
        for filename in ["/src/view.tsx?worker", "/src/view.cts#server"] {
            let normalized = request(filename).normalize().expect("normalize request");
            let expected = if filename.contains(".cts") {
                (SourceLanguage::TypeScript, ModuleKind::CommonJs)
            } else {
                (SourceLanguage::TypeScriptJsx, ModuleKind::Module)
            };
            assert_eq!(
                (normalized.language, normalized.module_kind),
                expected,
                "{filename}"
            );
        }
    }

    #[test]
    fn strips_windows_and_uri_suffixes_across_public_requests() {
        for filename in [
            r"C:\src\legacy.cts?lang.tsx",
            r"\\?\C:\src\legacy.cts?lang.tsx",
            "virtual:legacy.cts?lang.tsx",
            "x://project/src/legacy.cts#lang.tsx",
            "webpack://project/src/legacy.cts#lang.tsx",
        ] {
            for normalized in [
                request(filename)
                    .normalize()
                    .map(|request| (request.language, request.module_kind)),
                serde_json::from_value::<ScanRequest>(json!({
                    "code": "export = 1",
                    "filename": filename,
                }))
                .expect("deserialize scan request")
                .normalize()
                .map(|request| (request.language, request.module_kind)),
                serde_json::from_value::<AnalyzeRequest>(json!({
                    "code": "export = 1",
                    "filename": filename,
                }))
                .expect("deserialize analysis request")
                .normalize()
                .map(|request| (request.language, request.module_kind)),
            ] {
                assert_eq!(
                    normalized.expect("normalize suffixed request"),
                    (SourceLanguage::TypeScript, ModuleKind::CommonJs),
                    "{filename}"
                );
            }
        }

        let literal_fragment = request(r"C:\src\legacy#view.tsx")
            .normalize()
            .expect("normalize Windows fragment filename");
        assert_eq!(literal_fragment.language, SourceLanguage::TypeScriptJsx);
        assert_eq!(literal_fragment.module_kind, ModuleKind::Module);
    }

    #[test]
    fn preserves_posix_filename_delimiters_across_public_requests() {
        for filename in ["/tmp/a#b.tsx", "/tmp/a?b.tsx"] {
            let normalized = request(filename).normalize().expect("normalize compile");
            assert_eq!(normalized.filename, filename);
            assert_eq!(normalized.module_id, filename);
            assert_eq!(normalized.language, SourceLanguage::TypeScriptJsx);
        }

        let scan: ScanRequest = serde_json::from_value(json!({
            "code": "import './dep'",
            "filename": "/tmp/a?b.tsx",
            "moduleId": "/@id/a%3Fb.tsx?worker#client"
        }))
        .expect("deserialize scan request");
        let normalized = scan.normalize().expect("normalize scan");
        assert_eq!(normalized.filename, "/tmp/a?b.tsx");
        assert_eq!(normalized.module_id, "/@id/a%3Fb.tsx?worker#client");
        assert_eq!(normalized.language, SourceLanguage::TypeScriptJsx);

        let analyze: AnalyzeRequest = serde_json::from_value(json!({
            "code": "export const view = <div />",
            "filename": "/tmp/a#b.tsx",
            "moduleId": "/@id/a%23b.tsx?worker#client"
        }))
        .expect("deserialize analysis request");
        let normalized = analyze.normalize().expect("normalize analysis");
        assert_eq!(normalized.filename, "/tmp/a#b.tsx");
        assert_eq!(normalized.module_id, "/@id/a%23b.tsx?worker#client");
        assert_eq!(normalized.language, SourceLanguage::TypeScriptJsx);
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
    fn accepts_both_inline_derived_memo_modes() {
        let mut payload = json!({
            "code": "export const value = 1",
            "filename": "options.ts",
            "options": {}
        });
        payload["options"]["inlineDerivedMemos"] = json!(false);
        let request = serde_json::from_value(payload).expect("deserialize option request");
        let result = compile(request);
        assert!(!result.has_errors(), "{result:?}");
        assert!(
            result.code.contains("export const value = 1"),
            "{}",
            result.code
        );
    }

    #[test]
    fn analysis_normalization_validates_and_preserves_graph_host_inputs() {
        let payload = json!({
            "code": "import { count } from './dep'",
            "filename": "consumer.ts",
            "metadata": [{
                "request": "./dep",
                "resolvedId": "/src/dep.ts",
                "status": "resolved",
                "metadata": {
                    "version": 1,
                    "exports": { "count": "signal" }
                },
                "fingerprint": "sha256:dep"
            }],
            "integrationDiagnostics": [{
                "code": "FICT-R006",
                "severity": "warning",
                "message": "integration warning",
                "primarySpan": null,
                "secondaryLabels": [],
                "help": null,
                "notes": [],
                "guaranteeClass": "advisory"
            }]
        });
        let input: AnalyzeRequest =
            serde_json::from_value(payload.clone()).expect("deserialize analysis request");
        let normalized = input.normalize().expect("normalize analysis request");
        assert_eq!(normalized.metadata.len(), 1);
        assert_eq!(normalized.metadata[0].request, "./dep");
        assert_eq!(normalized.integration_diagnostics.len(), 1);
        assert_eq!(
            normalized.integration_diagnostics[0].code.as_str(),
            "FICT-R006"
        );

        let mut duplicate = payload;
        duplicate["metadata"] = json!([
            duplicate["metadata"][0].clone(),
            duplicate["metadata"][0].clone()
        ]);
        let duplicate: AnalyzeRequest =
            serde_json::from_value(duplicate).expect("deserialize duplicate metadata request");
        assert!(matches!(
            duplicate.normalize(),
            Err(CompileRequestError::DuplicateMetadataRequest(request)) if request == "./dep"
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
