use std::collections::{BTreeMap, BTreeSet};

use fict_compiler_oxc::{HirBuildOptions, OxcCompileOptions, OxcTypeScriptOptions, build_hir};
use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use fict_hir::{FictMacroKind, FunctionKind, HirFile, HirFunction, HirInstructionKind, SsaName};
use fict_reactivity::{DependencyBase, DependencyPath, DependencySegment, ReactiveRegion};
use serde::{Deserialize, Serialize};

use crate::control_flow_diagnostics::reactive_control_flow_diagnostics;
use crate::diagnostic_policy::{apply_diagnostic_policy, configured_diagnostic_severity};
use crate::pipeline::{oxc_language, oxc_module_kind};
use crate::{
    AnalyzeRequest, AnalyzeVerbosity, CompileRequestError, CompilerOptions, CorePassOptions,
    FunctionPassAnalysis, NormalizedAnalyzeRequest, run_core_passes,
};

/// Severity shape preserved by the existing TypeScript tooling API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnalyzeDiagnosticSeverity {
    /// Analysis or compilation cannot proceed for this source shape.
    Error,
    /// Actionable compiler warning.
    Warning,
    /// Informational compiler finding.
    Info,
    /// Editor hint retained for compatibility with tooling consumers.
    Hint,
}

/// Structured diagnostic with editor-ready, one-based source coordinates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeDiagnostic {
    /// Stable compiler diagnostic code.
    pub code: String,
    /// Human-readable diagnostic message.
    pub message: String,
    /// Effective severity after compiler policy is applied.
    pub severity: AnalyzeDiagnosticSeverity,
    /// One-based start line.
    pub line: u32,
    /// One-based UTF-16 start column.
    pub column: u32,
    /// One-based end line when a source span is available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    /// One-based UTF-16 end column when a source span is available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u32>,
}

/// Line-level trace marker category used by the Playground and VS Code extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TraceMarkerKind {
    /// Executes once when the component or hook is initialized.
    Once,
    /// Re-evaluates when tracked dependencies change.
    Reactive,
    /// Executes as an effect boundary.
    Effect,
}

/// One compiler decision attached to a source line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceMarker {
    /// Marker category.
    pub kind: TraceMarkerKind,
    /// Concise editor-facing explanation.
    pub label: String,
    /// Stable dependency names when the marker belongs to a reactive region.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deps: Option<Vec<String>>,
    /// Function-local region identity when applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region_id: Option<u32>,
}

/// Trace markers grouped by one-based source line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineTrace {
    /// One-based source line.
    pub line: u32,
    /// Ordered, de-duplicated compiler decisions.
    pub markers: Vec<TraceMarker>,
}

/// Serializable recursive reactive-region description.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionInfo {
    /// Function-local stable region identity.
    pub id: u32,
    /// One-based source start line.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    /// Zero-based UTF-16 source start column, matching the legacy region shape.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_column: Option<u32>,
    /// One-based source end line.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    /// Zero-based UTF-16 source end column, matching the legacy region shape.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u32>,
    /// External tracked inputs read by this region.
    pub dependencies: Vec<String>,
    /// Tracked definitions produced by this region.
    pub declarations: Vec<String>,
    /// Whether a tracked value controls a branch, switch, or loop.
    pub has_control_flow: bool,
    /// Whether this region produces tracked definitions.
    pub has_reactive_writes: bool,
    /// Nested regions in deterministic order.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<RegionInfo>,
}

/// Analysis for one source component, hook, or reactive callback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentAnalysis {
    /// Display name retained only for tooling presentation.
    pub name: String,
    /// One-based function start line.
    pub start_line: u32,
    /// One-based function end line.
    pub end_line: u32,
    /// Line-level execution trace.
    pub trace: Vec<LineTrace>,
    /// Recursive reactive regions when requested.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub regions: Option<Vec<RegionInfo>>,
}

/// Existing public tooling result shape, now produced by the Rust/OXC pipeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeResult {
    /// Physical source identity.
    pub file_name: String,
    /// Source-order component and hook analyses.
    pub components: Vec<ComponentAnalysis>,
    /// Structured compiler diagnostics.
    pub diagnostics: Vec<AnalyzeDiagnostic>,
}

impl AnalyzeResult {
    fn empty(file_name: impl Into<String>) -> Self {
        Self {
            file_name: file_name.into(),
            components: Vec::new(),
            diagnostics: Vec::new(),
        }
    }
}

/// Analyze one source file without filesystem, bundler, or JavaScript callbacks.
#[must_use]
pub fn analyze(request: AnalyzeRequest) -> AnalyzeResult {
    let fallback_name = request.filename.clone();
    match request.normalize() {
        Ok(request) => analyze_normalized(request),
        Err(error) => analyze_request_error_result(fallback_name, error),
    }
}

/// Construct a compatible result for malformed public input whose filename could not be read.
#[must_use]
pub fn invalid_analyze_request_result(message: impl Into<String>) -> AnalyzeResult {
    invalid_analyze_request_result_for("<unknown>", "FICT-REQUEST", message)
}

fn analyze_request_error_result(
    file_name: impl Into<String>,
    error: CompileRequestError,
) -> AnalyzeResult {
    invalid_analyze_request_result_for(file_name, error.diagnostic_code(), error.to_string())
}

/// Construct the result returned when the N-API panic boundary contains a native panic.
#[must_use]
pub fn internal_analyze_error_result() -> AnalyzeResult {
    let mut result = AnalyzeResult::empty("<unknown>");
    result.diagnostics.push(AnalyzeDiagnostic {
        code: "FICT-I001".to_owned(),
        message: "the native compiler encountered an internal error".to_owned(),
        severity: AnalyzeDiagnosticSeverity::Error,
        line: 1,
        column: 1,
        end_line: None,
        end_column: None,
    });
    result
}

fn invalid_analyze_request_result_for(
    file_name: impl Into<String>,
    code: &'static str,
    message: impl Into<String>,
) -> AnalyzeResult {
    let mut result = AnalyzeResult::empty(file_name);
    result.diagnostics.push(AnalyzeDiagnostic {
        code: code.to_owned(),
        message: message.into(),
        severity: AnalyzeDiagnosticSeverity::Error,
        line: 1,
        column: 1,
        end_line: None,
        end_column: None,
    });
    result
}

fn analyze_normalized(request: NormalizedAnalyzeRequest) -> AnalyzeResult {
    let mut result = AnalyzeResult::empty(request.filename.clone());
    let source_index = SourceIndex::new(&request.code);
    let oxc_options = OxcCompileOptions {
        language: oxc_language(request.language),
        module_kind: oxc_module_kind(request.module_kind),
        typescript: OxcTypeScriptOptions {
            allow_namespaces: request.compiler_options.typescript.allow_namespaces,
            only_remove_type_imports: request.compiler_options.typescript.only_remove_type_imports,
            optimize_const_enums: request.compiler_options.typescript.optimize_const_enums,
            optimize_enums: request.compiler_options.typescript.optimize_enums,
            rewrite_import_extensions: request
                .compiler_options
                .typescript
                .rewrite_import_extensions,
            remove_class_fields_without_initializer: request
                .compiler_options
                .typescript
                .remove_class_fields_without_initializer,
        },
        sourcemap: false,
    };
    let build = build_hir(
        &request.code,
        oxc_options,
        &HirBuildOptions {
            reactive_scopes: request.compiler_options.reactive_scopes.clone(),
            strict_guarantee: request.compiler_options.strict_guarantee,
            reactive_creation_control_flow_severity: configured_diagnostic_severity(
                &request.compiler_options.warning_levels,
                "FICT-R004",
                DiagnosticSeverity::Error,
            ),
            resolved_metadata: Vec::new(),
        },
    );
    let mut diagnostics = build.diagnostics;
    let Some(hir) = build.hir else {
        if diagnostics.is_empty() {
            diagnostics.push(internal_diagnostic(
                "FICT-I003",
                "the OXC frontend returned no HIR without a diagnostic",
            ));
        }
        result.diagnostics = normalize_diagnostics(
            diagnostics,
            &request.compiler_options,
            &source_index,
            request.include_diagnostics,
        );
        return result;
    };

    if request.compiler_options.strict_guarantee
        && let Some(suppression) = build
            .frontend
            .as_ref()
            .and_then(|frontend| frontend.source_facts.suppressions.first())
    {
        diagnostics.push(
            Diagnostic::new(
                diagnostic_code("FICT-STRICT-SUPPRESSION"),
                DiagnosticSeverity::Error,
                "strictGuarantee does not allow fict-ignore suppression comments",
            )
            .with_primary_span(suppression.comment_span)
            .with_help("remove suppressions to keep fail-closed guarantees")
            .with_guarantee_class(GuaranteeClass::Unsupported),
        );
    }

    let core = match run_core_passes(
        &hir,
        CorePassOptions {
            // Tooling traces source execution before optimizer compaction so source spans and
            // declarations remain inspectable and deterministic.
            optimize: false,
            ..CorePassOptions::default()
        },
    ) {
        Ok(core) => core,
        Err(findings) => {
            diagnostics.extend(findings.into_sorted());
            result.diagnostics = normalize_diagnostics(
                diagnostics,
                &request.compiler_options,
                &source_index,
                request.include_diagnostics,
            );
            return result;
        }
    };
    diagnostics.extend(reactive_control_flow_diagnostics(&core));

    result.components = core
        .hir
        .functions
        .iter()
        .filter(|function| function.id != core.hir.root_function)
        .filter_map(|function| {
            let analysis = core.functions.get(function.id.as_usize())?;
            analyze_function(
                &core.hir,
                function,
                analysis,
                &source_index,
                request.include_regions,
                request.verbosity,
            )
        })
        .collect();
    result.components.sort_by_key(|component| {
        (
            component.start_line,
            component.end_line,
            component.name.clone(),
        )
    });
    result.diagnostics = normalize_diagnostics(
        diagnostics,
        &request.compiler_options,
        &source_index,
        request.include_diagnostics,
    );
    result
}

fn analyze_function(
    file: &HirFile,
    function: &HirFunction,
    analysis: &FunctionPassAnalysis,
    source_index: &SourceIndex<'_>,
    include_regions: bool,
    verbosity: AnalyzeVerbosity,
) -> Option<ComponentAnalysis> {
    if !is_tooling_function(function) {
        return None;
    }
    let function_span = function_span(function)?;
    let start = source_index.location(function_span.start());
    let end = source_index.location(function_span.end());
    let name = function
        .binding
        .and_then(|binding| file.bindings.get(binding.as_usize()))
        .map_or_else(
            || "<anonymous>".to_owned(),
            |binding| binding.display_name.clone(),
        );
    let mut markers: BTreeMap<u32, Vec<TraceMarker>> = BTreeMap::new();
    push_marker(
        &mut markers,
        start.line,
        TraceMarker {
            kind: TraceMarkerKind::Once,
            label: "Component setup runs on mount".to_owned(),
            deps: None,
            region_id: None,
        },
    );

    for block in &function.blocks {
        for instruction in &block.instructions {
            let Some(span) = instruction.origin.primary_span else {
                continue;
            };
            let line = source_index.location(span.start()).line;
            match &instruction.kind {
                HirInstructionKind::Call(call) => match call.macro_kind {
                    Some(FictMacroKind::State) => push_marker(
                        &mut markers,
                        line,
                        TraceMarker {
                            kind: TraceMarkerKind::Once,
                            label: "Signal initialization runs once".to_owned(),
                            deps: None,
                            region_id: None,
                        },
                    ),
                    Some(FictMacroKind::Effect) => push_marker(
                        &mut markers,
                        line,
                        TraceMarker {
                            kind: TraceMarkerKind::Effect,
                            label: "Effect callback executes reactively".to_owned(),
                            deps: None,
                            region_id: None,
                        },
                    ),
                    Some(FictMacroKind::Memo) => push_marker(
                        &mut markers,
                        line,
                        TraceMarker {
                            kind: TraceMarkerKind::Reactive,
                            label: "Memo recomputes when tracked dependencies change".to_owned(),
                            deps: None,
                            region_id: None,
                        },
                    ),
                    None => {}
                },
                HirInstructionKind::Jsx { .. } if verbosity == AnalyzeVerbosity::Verbose => {
                    push_marker(
                        &mut markers,
                        line,
                        TraceMarker {
                            kind: TraceMarkerKind::Once,
                            label: "JSX expression runs during setup only".to_owned(),
                            deps: None,
                            region_id: None,
                        },
                    );
                }
                _ => {}
            }
        }
    }

    for region in &analysis.regions.regions {
        let span = region_span(function, region);
        let dependencies = region_dependencies(file, function, region);
        if let Some(span) = span {
            let line = source_index.location(span.start()).line;
            push_marker(
                &mut markers,
                line,
                TraceMarker {
                    kind: TraceMarkerKind::Reactive,
                    label: "Reactive region reruns when tracked dependencies change".to_owned(),
                    deps: (!dependencies.is_empty()).then_some(dependencies.clone()),
                    region_id: Some(region.id.index()),
                },
            );
        }
        for range in &region.ranges {
            let Some(block) = function.blocks.get(range.block.as_usize()) else {
                continue;
            };
            let start_index = range.start as usize;
            let end_index = (range.end as usize).min(block.instructions.len());
            for instruction in block
                .instructions
                .get(start_index..end_index)
                .into_iter()
                .flatten()
            {
                if !matches!(instruction.kind, HirInstructionKind::Jsx { .. }) {
                    continue;
                }
                let Some(span) = instruction.origin.primary_span else {
                    continue;
                };
                push_marker(
                    &mut markers,
                    source_index.location(span.start()).line,
                    TraceMarker {
                        kind: TraceMarkerKind::Reactive,
                        label: "JSX expression updates with reactive values".to_owned(),
                        deps: (!dependencies.is_empty()).then_some(dependencies.clone()),
                        region_id: Some(region.id.index()),
                    },
                );
            }
        }
    }

    let regions = include_regions.then(|| {
        analysis
            .regions
            .top_level_regions
            .iter()
            .filter_map(|region| {
                region_info(
                    file,
                    function,
                    &analysis.regions.regions,
                    region.as_usize(),
                    source_index,
                    &mut BTreeSet::new(),
                )
            })
            .collect()
    });

    Some(ComponentAnalysis {
        name,
        start_line: start.line,
        end_line: end.line,
        trace: markers
            .into_iter()
            .map(|(line, markers)| LineTrace { line, markers })
            .collect(),
        regions,
    })
}

fn is_tooling_function(function: &HirFunction) -> bool {
    matches!(
        function.kind,
        FunctionKind::Component | FunctionKind::Hook | FunctionKind::ReactiveScope
    ) || function.blocks.iter().any(|block| {
        block.instructions.iter().any(|instruction| {
            matches!(instruction.kind, HirInstructionKind::Jsx { .. })
                || matches!(
                    &instruction.kind,
                    HirInstructionKind::Call(call) if call.macro_kind.is_some()
                )
        })
    })
}

fn function_span(function: &HirFunction) -> Option<SourceSpan> {
    let mut span = function.origin.primary_span;
    for block in &function.blocks {
        merge_span(&mut span, block.origin.primary_span);
        merge_span(&mut span, block.terminator.origin.primary_span);
        for instruction in &block.instructions {
            merge_span(&mut span, instruction.origin.primary_span);
        }
    }
    span
}

fn region_info(
    file: &HirFile,
    function: &HirFunction,
    regions: &[ReactiveRegion],
    region_index: usize,
    source_index: &SourceIndex<'_>,
    visiting: &mut BTreeSet<usize>,
) -> Option<RegionInfo> {
    if !visiting.insert(region_index) {
        return None;
    }
    let region = regions.get(region_index)?;
    let span = region_span(function, region);
    let (start_line, start_column, end_line, end_column) =
        span.map_or((None, None, None, None), |span| {
            let start = source_index.location(span.start());
            let end = source_index.location(span.end());
            (
                Some(start.line),
                Some(start.column),
                Some(end.line),
                Some(end.column),
            )
        });
    let mut declarations: Vec<_> = region
        .outputs
        .iter()
        .map(|name| ssa_name(function, *name))
        .collect();
    declarations.sort();
    declarations.dedup();
    let children = region
        .children
        .iter()
        .filter_map(|child| {
            region_info(
                file,
                function,
                regions,
                child.as_usize(),
                source_index,
                visiting,
            )
        })
        .collect();
    visiting.remove(&region_index);
    Some(RegionInfo {
        id: region.id.index(),
        start_line,
        start_column,
        end_line,
        end_column,
        dependencies: region_dependencies(file, function, region),
        has_reactive_writes: !declarations.is_empty(),
        declarations,
        has_control_flow: region.has_control_flow,
        children,
    })
}

fn region_span(function: &HirFunction, region: &ReactiveRegion) -> Option<SourceSpan> {
    let mut span = None;
    for range in &region.ranges {
        let Some(block) = function.blocks.get(range.block.as_usize()) else {
            continue;
        };
        let start = range.start as usize;
        let end = (range.end as usize).min(block.instructions.len());
        for instruction in block.instructions.get(start..end).into_iter().flatten() {
            merge_span(&mut span, instruction.origin.primary_span);
            if let Some(result) = instruction.result
                && let Some(value) = function.values.get(result.as_usize())
            {
                merge_span(&mut span, value.origin.primary_span);
            }
        }
    }
    for block_id in &region.blocks {
        if let Some(block) = function.blocks.get(block_id.as_usize()) {
            merge_span(&mut span, block.terminator.origin.primary_span);
        }
    }
    span
}

fn merge_span(target: &mut Option<SourceSpan>, candidate: Option<SourceSpan>) {
    let Some(candidate) = candidate else {
        return;
    };
    *target = Some(match *target {
        Some(current) => SourceSpan::new(
            current.start().min(candidate.start()),
            current.end().max(candidate.end()),
        )
        .expect("merged source span is ordered"),
        None => candidate,
    });
}

fn region_dependencies(
    file: &HirFile,
    function: &HirFunction,
    region: &ReactiveRegion,
) -> Vec<String> {
    let mut dependencies: Vec<_> = region
        .inputs
        .iter()
        .map(|path| dependency_name(file, function, path))
        .collect();
    dependencies.sort();
    dependencies.dedup();
    dependencies
}

fn dependency_name(file: &HirFile, function: &HirFunction, path: &DependencyPath) -> String {
    let mut output = match path.base {
        DependencyBase::Ssa(name) => ssa_name(function, name),
        DependencyBase::Global(global) => file.globals.get(global.as_usize()).map_or_else(
            || format!("<global:{}>", global.index()),
            |item| item.name.clone(),
        ),
        DependencyBase::Value(value) => format!("<value:{}>", value.index()),
    };
    for segment in &path.segments {
        match segment {
            DependencySegment::Static { name, .. } => {
                output.push('.');
                output.push_str(name);
            }
            DependencySegment::Index { index, .. } => {
                output.push('[');
                output.push_str(&index.to_string());
                output.push(']');
            }
            DependencySegment::Dynamic { .. } => output.push_str("[*]"),
        }
    }
    output
}

fn ssa_name(function: &HirFunction, name: SsaName) -> String {
    function
        .locals
        .get(name.local.as_usize())
        .and_then(|local| local.debug_name.clone())
        .unwrap_or_else(|| format!("<local:{}>", name.local.index()))
}

fn push_marker(markers: &mut BTreeMap<u32, Vec<TraceMarker>>, line: u32, marker: TraceMarker) {
    let line_markers = markers.entry(line).or_default();
    if !line_markers.contains(&marker) {
        line_markers.push(marker);
    }
}

fn normalize_diagnostics(
    mut diagnostics: Vec<Diagnostic>,
    options: &CompilerOptions,
    source_index: &SourceIndex<'_>,
    include: bool,
) -> Vec<AnalyzeDiagnostic> {
    if !include {
        return Vec::new();
    }
    apply_diagnostic_policy(options, &mut diagnostics);
    DiagnosticBundle::new(diagnostics)
        .into_sorted()
        .into_iter()
        .map(|diagnostic| {
            let (line, column, end_line, end_column) =
                diagnostic.primary_span.map_or((1, 1, None, None), |span| {
                    let start = source_index.location(span.start());
                    let end = source_index.location(span.end());
                    (
                        start.line,
                        start.column.saturating_add(1),
                        Some(end.line),
                        Some(end.column.saturating_add(1)),
                    )
                });
            AnalyzeDiagnostic {
                code: diagnostic.code.to_string(),
                message: diagnostic.message,
                severity: match diagnostic.severity {
                    DiagnosticSeverity::Error => AnalyzeDiagnosticSeverity::Error,
                    DiagnosticSeverity::Warning => AnalyzeDiagnosticSeverity::Warning,
                    DiagnosticSeverity::Info => AnalyzeDiagnosticSeverity::Info,
                },
                line,
                column,
                end_line,
                end_column,
            }
        })
        .collect()
}

fn internal_diagnostic(code: &'static str, message: &'static str) -> Diagnostic {
    Diagnostic::new(diagnostic_code(code), DiagnosticSeverity::Error, message)
        .with_guarantee_class(GuaranteeClass::Internal)
}

fn diagnostic_code(code: &'static str) -> DiagnosticCode {
    DiagnosticCode::new(code).expect("analysis diagnostic literals must be valid")
}

#[derive(Debug, Clone, Copy)]
struct SourceLocation {
    line: u32,
    column: u32,
}

struct SourceIndex<'source> {
    source: &'source str,
    line_starts: Vec<usize>,
}

impl<'source> SourceIndex<'source> {
    fn new(source: &'source str) -> Self {
        let mut line_starts = vec![0];
        line_starts.extend(
            source
                .bytes()
                .enumerate()
                .filter_map(|(index, byte)| (byte == b'\n').then_some(index + 1)),
        );
        Self {
            source,
            line_starts,
        }
    }

    fn location(&self, byte_offset: u32) -> SourceLocation {
        let mut offset = (byte_offset as usize).min(self.source.len());
        while offset > 0 && !self.source.is_char_boundary(offset) {
            offset -= 1;
        }
        let line_index = self
            .line_starts
            .partition_point(|line_start| *line_start <= offset)
            .saturating_sub(1);
        let line_start = self.line_starts[line_index];
        let utf16_column = self.source[line_start..offset].encode_utf16().count();
        SourceLocation {
            line: u32::try_from(line_index.saturating_add(1)).unwrap_or(u32::MAX),
            column: u32::try_from(utf16_column).unwrap_or(u32::MAX),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AnalyzeDiagnosticSeverity, TraceMarkerKind, analyze};
    use crate::{AnalyzeOptions, AnalyzeRequest, AnalyzeVerbosity, COMPILER_PROTOCOL_VERSION};

    fn request(code: &str, filename: &str) -> AnalyzeRequest {
        AnalyzeRequest {
            protocol_version: COMPILER_PROTOCOL_VERSION,
            code: code.to_owned(),
            filename: filename.to_owned(),
            module_id: None,
            language: None,
            module_kind: None,
            options: AnalyzeOptions {
                verbosity: AnalyzeVerbosity::Verbose,
                ..AnalyzeOptions::default()
            },
        }
    }

    #[test]
    fn returns_compatible_components_trace_regions_and_diagnostics() {
        let result = analyze(request(
            r#"
                import { $effect, $state } from 'fict';
                export function Counter() {
                    let count = $state(0);
                    const doubled = count * 2;
                    $effect(() => { count; });
                    return <button>{doubled}</button>;
                }
            "#,
            "counter.tsx",
        ));

        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
        let counter = result
            .components
            .iter()
            .find(|component| component.name == "Counter")
            .expect("Counter analysis");
        assert!(counter.start_line <= counter.end_line);
        assert!(
            counter
                .regions
                .as_ref()
                .is_some_and(|regions| !regions.is_empty())
        );
        let kinds: Vec<_> = counter
            .trace
            .iter()
            .flat_map(|line| line.markers.iter().map(|marker| marker.kind))
            .collect();
        assert!(kinds.contains(&TraceMarkerKind::Once));
        assert!(kinds.contains(&TraceMarkerKind::Effect));
        assert!(kinds.contains(&TraceMarkerKind::Reactive));
    }

    #[test]
    fn converts_utf8_spans_to_one_based_utf16_editor_locations() {
        let result = analyze(request("const emoji = '😀';\nexport const =", "broken.ts"));
        let diagnostic = result.diagnostics.first().expect("parser diagnostic");
        assert_eq!(diagnostic.severity, AnalyzeDiagnosticSeverity::Error);
        assert_eq!(diagnostic.code, "FICT-PARSE");
        assert_eq!(diagnostic.line, 2);
        assert!(diagnostic.column > 1);
    }

    #[test]
    fn malformed_requests_and_hidden_diagnostics_preserve_result_shape() {
        let mut malformed = request("", "virtual:entry");
        malformed.protocol_version += 1;
        let malformed = analyze(malformed);
        assert_eq!(malformed.file_name, "virtual:entry");
        assert_eq!(malformed.diagnostics[0].code, "FICT-REQUEST");

        let mut hidden = request("export const =", "broken.ts");
        hidden.options.include_diagnostics = false;
        let hidden = analyze(hidden);
        assert!(hidden.components.is_empty());
        assert!(hidden.diagnostics.is_empty());
    }

    #[test]
    fn accepts_disabled_derived_memo_inlining_through_the_analysis_protocol() {
        let mut input = request("export const value = 1", "options.ts");
        input.options.compiler_options.inline_derived_memos = false;
        let result = analyze(input);
        assert!(result.components.is_empty());
        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    }
}
