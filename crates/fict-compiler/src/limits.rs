use std::io::{self, Write};

use fict_compiler_oxc::HirAnalysisBudgets;
use fict_hir::HirFile;
use serde::{Deserialize, Serialize};

const MIB: u64 = 1024 * 1024;
const MIN_OUTPUT_BYTES: u64 = 4 * 1024;

/// Per-request resource ceilings enforced by every public compiler pipeline.
///
/// Hosts may lower these values for a workload, but the native boundary rejects values above the
/// built-in hard ceilings. Deadlines, cancellation, queueing, and process isolation remain host
/// responsibilities because they cannot be implemented reliably by a synchronous compiler core.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct RequestLimits {
    /// Maximum UTF-8 bytes accepted before parsing.
    pub max_source_bytes: u64,
    /// Maximum JSON bytes for the complete decoded request.
    pub max_request_bytes: u64,
    /// Maximum JSON bytes for an input or aggregate generated source-map payload.
    pub max_source_map_bytes: u64,
    /// Maximum JSON bytes for the resolved metadata snapshot.
    pub max_metadata_bytes: u64,
    /// Maximum semantic AST nodes accepted before HIR construction.
    pub max_ast_nodes: u64,
    /// Maximum semantic scopes accepted before HIR construction.
    pub max_scopes: u64,
    /// Maximum semantic symbols accepted before HIR construction.
    pub max_symbols: u64,
    /// Maximum aggregate HIR arena nodes accepted before compiler passes.
    pub max_hir_nodes: u64,
    /// Maximum integration or result diagnostics retained by one request.
    pub max_diagnostics: u64,
    /// Maximum JSON bytes returned by the native boundary.
    pub max_output_bytes: u64,
}

impl Default for RequestLimits {
    fn default() -> Self {
        Self {
            max_source_bytes: 16 * MIB,
            max_request_bytes: 64 * MIB,
            max_source_map_bytes: 32 * MIB,
            max_metadata_bytes: 16 * MIB,
            max_ast_nodes: 1_000_000,
            max_scopes: 250_000,
            max_symbols: 500_000,
            max_hir_nodes: 2_000_000,
            max_diagnostics: 2_048,
            max_output_bytes: 64 * MIB,
        }
    }
}

impl RequestLimits {
    pub(crate) fn is_default(&self) -> bool {
        *self == Self::default()
    }

    pub(crate) fn validate_configuration(&self) -> Result<(), RequestLimitViolation> {
        self.validate_setting("maxSourceBytes", self.max_source_bytes, 1, 64 * MIB)?;
        self.validate_setting("maxRequestBytes", self.max_request_bytes, 1, 256 * MIB)?;
        self.validate_setting("maxSourceMapBytes", self.max_source_map_bytes, 1, 128 * MIB)?;
        self.validate_setting("maxMetadataBytes", self.max_metadata_bytes, 1, 64 * MIB)?;
        self.validate_setting("maxAstNodes", self.max_ast_nodes, 1, 8_000_000)?;
        self.validate_setting("maxScopes", self.max_scopes, 1, 1_000_000)?;
        self.validate_setting("maxSymbols", self.max_symbols, 1, 2_000_000)?;
        self.validate_setting("maxHirNodes", self.max_hir_nodes, 1, 8_000_000)?;
        self.validate_setting("maxDiagnostics", self.max_diagnostics, 1, 16_384)?;
        self.validate_setting(
            "maxOutputBytes",
            self.max_output_bytes,
            MIN_OUTPUT_BYTES,
            256 * MIB,
        )
    }

    pub(crate) fn check_source(&self, source: &str) -> Result<(), RequestLimitViolation> {
        check_count(
            "source bytes",
            "maxSourceBytes",
            usize_to_u64(source.len()),
            self.max_source_bytes,
        )
    }

    pub(crate) fn check_request<T: Serialize>(
        &self,
        request: &T,
    ) -> Result<(), RequestLimitViolation> {
        check_serialized(
            "request payload",
            "maxRequestBytes",
            request,
            self.max_request_bytes,
        )
    }

    pub(crate) fn check_source_map<T: Serialize>(
        &self,
        map: &T,
    ) -> Result<(), RequestLimitViolation> {
        check_serialized(
            "source-map payload",
            "maxSourceMapBytes",
            map,
            self.max_source_map_bytes,
        )
    }

    pub(crate) fn check_metadata<T: Serialize>(
        &self,
        metadata: &T,
    ) -> Result<(), RequestLimitViolation> {
        check_serialized(
            "metadata snapshot",
            "maxMetadataBytes",
            metadata,
            self.max_metadata_bytes,
        )
    }

    pub(crate) fn check_hir(&self, hir: &HirFile) -> Result<(), RequestLimitViolation> {
        check_count(
            "HIR nodes",
            "maxHirNodes",
            hir_node_count(hir),
            self.max_hir_nodes,
        )
    }

    pub(crate) fn hir_analysis_budgets(&self) -> HirAnalysisBudgets {
        HirAnalysisBudgets {
            max_frontend_nodes: bounded_u32(self.max_ast_nodes),
            max_frontend_scopes: bounded_u32(self.max_scopes),
            max_frontend_symbols: bounded_u32(self.max_symbols),
            ..HirAnalysisBudgets::default()
        }
    }

    pub(crate) fn check_diagnostics(&self, count: usize) -> Result<(), RequestLimitViolation> {
        check_count(
            "diagnostic count",
            "maxDiagnostics",
            usize_to_u64(count),
            self.max_diagnostics,
        )
    }

    pub(crate) fn check_output<T: Serialize>(
        &self,
        result: &T,
    ) -> Result<(), RequestLimitViolation> {
        check_serialized(
            "result payload",
            "maxOutputBytes",
            result,
            self.max_output_bytes,
        )
    }

    fn validate_setting(
        &self,
        name: &'static str,
        value: u64,
        minimum: u64,
        maximum: u64,
    ) -> Result<(), RequestLimitViolation> {
        if (minimum..=maximum).contains(&value) {
            Ok(())
        } else {
            Err(RequestLimitViolation::InvalidConfiguration {
                name,
                value,
                minimum,
                maximum,
            })
        }
    }
}

#[derive(Debug)]
pub(crate) enum RequestLimitViolation {
    InvalidConfiguration {
        name: &'static str,
        value: u64,
        minimum: u64,
        maximum: u64,
    },
    Exceeded {
        resource: &'static str,
        setting: &'static str,
        observed: u64,
        limit: u64,
    },
    Serialization {
        resource: &'static str,
        message: String,
    },
}

impl std::fmt::Display for RequestLimitViolation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfiguration {
                name,
                value,
                minimum,
                maximum,
            } => write!(
                formatter,
                "request limit {name}={value} is outside the supported range {minimum}..={maximum}"
            ),
            Self::Exceeded {
                resource,
                setting,
                observed,
                limit,
            } => write!(
                formatter,
                "{resource} exceeds {setting}: observed at least {observed}, limit {limit}"
            ),
            Self::Serialization { resource, message } => {
                write!(formatter, "cannot measure {resource}: {message}")
            }
        }
    }
}

fn check_count(
    resource: &'static str,
    setting: &'static str,
    observed: u64,
    limit: u64,
) -> Result<(), RequestLimitViolation> {
    if observed <= limit {
        Ok(())
    } else {
        Err(RequestLimitViolation::Exceeded {
            resource,
            setting,
            observed,
            limit,
        })
    }
}

fn check_serialized<T: Serialize>(
    resource: &'static str,
    setting: &'static str,
    value: &T,
    limit: u64,
) -> Result<(), RequestLimitViolation> {
    let mut writer = BoundedSizeWriter::new(limit);
    match serde_json::to_writer(&mut writer, value) {
        Ok(()) => Ok(()),
        Err(_error) if writer.exceeded => Err(RequestLimitViolation::Exceeded {
            resource,
            setting,
            observed: writer.written,
            limit,
        }),
        Err(error) => Err(RequestLimitViolation::Serialization {
            resource,
            message: error.to_string(),
        }),
    }
}

fn hir_node_count(hir: &HirFile) -> u64 {
    let mut count = 1_u64
        .saturating_add(usize_to_u64(hir.scopes.len()))
        .saturating_add(usize_to_u64(hir.bindings.len()))
        .saturating_add(usize_to_u64(hir.globals.len()))
        .saturating_add(usize_to_u64(hir.authored_free_names.len()))
        .saturating_add(usize_to_u64(hir.templates.len()))
        .saturating_add(usize_to_u64(hir.syntax_fragments.len()));
    for function in &hir.functions {
        count = count
            .saturating_add(1)
            .saturating_add(usize_to_u64(function.parameters.len()))
            .saturating_add(usize_to_u64(function.locals.len()))
            .saturating_add(usize_to_u64(function.values.len()))
            .saturating_add(usize_to_u64(function.regions.len()))
            .saturating_add(usize_to_u64(function.effect_statements.len()));
        for block in &function.blocks {
            count = count
                .saturating_add(1)
                .saturating_add(usize_to_u64(block.instructions.len()))
                .saturating_add(
                    block
                        .source_hint
                        .as_ref()
                        .map_or(0, |hint| usize_to_u64(hint.switch_cases.len())),
                );
        }
    }
    count
}

const fn usize_to_u64(value: usize) -> u64 {
    if usize::BITS > u64::BITS && value > u64::MAX as usize {
        u64::MAX
    } else {
        value as u64
    }
}

const fn bounded_u32(value: u64) -> u32 {
    if value > u32::MAX as u64 {
        u32::MAX
    } else {
        value as u32
    }
}

struct BoundedSizeWriter {
    written: u64,
    limit: u64,
    exceeded: bool,
}

impl BoundedSizeWriter {
    const fn new(limit: u64) -> Self {
        Self {
            written: 0,
            limit,
            exceeded: false,
        }
    }
}

impl Write for BoundedSizeWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.written = self.written.saturating_add(usize_to_u64(bytes.len()));
        if self.written > self.limit {
            self.exceeded = true;
            return Err(io::Error::other("serialized size limit exceeded"));
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde::Serialize;
    use serde_json::json;

    use super::{RequestLimitViolation, RequestLimits};

    #[derive(Serialize)]
    struct Payload<'a> {
        value: &'a str,
    }

    #[test]
    fn bounded_serializer_stops_without_materializing_the_payload() {
        let limits = RequestLimits {
            max_request_bytes: 8,
            ..RequestLimits::default()
        };
        let error = limits
            .check_request(&Payload {
                value: "0123456789",
            })
            .expect_err("payload must exceed the configured request limit");
        assert!(matches!(error, RequestLimitViolation::Exceeded { .. }));
    }

    #[test]
    fn hard_ceilings_cannot_be_disabled_by_the_caller() {
        let limits = RequestLimits {
            max_source_bytes: u64::MAX,
            ..RequestLimits::default()
        };
        assert!(matches!(
            limits.validate_configuration(),
            Err(RequestLimitViolation::InvalidConfiguration {
                name: "maxSourceBytes",
                ..
            })
        ));
    }

    #[test]
    fn partial_json_limits_inherit_every_unspecified_default() {
        let defaults = RequestLimits::default();
        let limits: RequestLimits = serde_json::from_value(json!({
            "maxSourceBytes": 1024
        }))
        .expect("deserialize partial limits");
        assert_eq!(limits.max_source_bytes, 1024);
        assert_eq!(limits.max_request_bytes, defaults.max_request_bytes);
        assert_eq!(limits.max_ast_nodes, defaults.max_ast_nodes);
        assert_eq!(limits.max_output_bytes, defaults.max_output_bytes);
    }
}
