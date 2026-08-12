use std::collections::{BTreeMap, BTreeSet};

use fict_compiler_oxc::{HirBuildOptions, OxcCompileOptions, OxcTypeScriptOptions, build_hir};
use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceIndex,
    SourceSpan,
};
use fict_emit::{NoJsxLoweringOptions, lower_core_with_hook_returns};
use fict_hir::{FictMacroKind, FunctionKind, HirFile, HirFunction, HirInstructionKind, SsaName};
use fict_reactivity::{DependencyBase, DependencyPath, DependencySegment, ReactiveRegion};
use serde::{Deserialize, Serialize};

use crate::control_flow_diagnostics::reactive_control_flow_diagnostics;
use crate::diagnostic_policy::{
    apply_diagnostic_policy, apply_diagnostic_suppressions, configured_diagnostic_severity,
};
use crate::effect_diagnostics::suppress_region_backed_effect_advisories;
use crate::metadata_analysis::infer_local_hook_returns;
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
            resolved_metadata: request.metadata.clone(),
            analysis_budgets: Default::default(),
        },
    );
    let suppressions = build
        .frontend
        .as_ref()
        .map(|frontend| frontend.source_facts.suppressions.clone())
        .unwrap_or_default();
    let mut diagnostics = request.integration_diagnostics;
    diagnostics.extend(build.diagnostics);
    if build
        .frontend
        .as_ref()
        .is_some_and(|frontend| frontend.program_compiler_disabled())
    {
        result.diagnostics = normalize_diagnostics(
            diagnostics,
            &request.compiler_options,
            &source_index,
            &suppressions,
            request.include_diagnostics,
        );
        return result;
    }
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
            &suppressions,
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
            strict_guarantee: request.compiler_options.strict_guarantee,
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
                &suppressions,
                request.include_diagnostics,
            );
            return result;
        }
    };
    diagnostics.extend(core.diagnostics.iter().cloned());
    let local_hook_returns = build
        .frontend
        .as_ref()
        .map(|frontend| infer_local_hook_returns(&core, frontend))
        .unwrap_or_default();
    let regions: Vec<_> = core
        .functions
        .iter()
        .map(|analysis| analysis.regions.clone())
        .collect();
    let cycles: Vec<_> = core
        .functions
        .iter()
        .map(|analysis| analysis.cycles.clone())
        .collect();
    let scopes: Vec<_> = core
        .functions
        .iter()
        .map(|analysis| analysis.scopes.clone())
        .collect();
    let emit = build.frontend.as_ref().and_then(|frontend| {
        match lower_core_with_hook_returns(
            &core.hir,
            &regions,
            &cycles,
            Some(&scopes),
            &local_hook_returns,
            NoJsxLoweringOptions {
                runtime_family: frontend.runtime_family,
                dev: request.compiler_options.dev,
                lazy_conditional: request.compiler_options.lazy_conditional,
                getter_cache: request.compiler_options.getter_cache,
                full_optimization: false,
                optimize: false,
                inline_derived_memos: request.compiler_options.inline_derived_memos,
                strict_guarantee: request.compiler_options.strict_guarantee,
                preview: request
                    .compiler_options
                    .preview
                    .as_ref()
                    .is_some_and(|preview| preview.resumable),
                fine_grained_dom: request.compiler_options.fine_grained_dom,
            },
        ) {
            Ok(emit) => Some(emit),
            Err(findings) => {
                diagnostics.extend(findings.into_sorted());
                None
            }
        }
    });
    diagnostics.extend(reactive_control_flow_diagnostics(
        &core,
        &local_hook_returns,
        emit.as_ref(),
    ));
    suppress_region_backed_effect_advisories(&mut diagnostics, Some(&core.hir), emit.as_ref());

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
        &suppressions,
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
            label: tooling_function_setup_label(function.kind).to_owned(),
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

const fn tooling_function_setup_label(kind: FunctionKind) -> &'static str {
    match kind {
        FunctionKind::Module => "Module setup runs on evaluation",
        FunctionKind::Plain => "Function body runs when called",
        FunctionKind::Component => "Component setup runs on mount",
        FunctionKind::Hook => "Hook body runs when called",
        FunctionKind::ReactiveScope => "Reactive scope callback runs when invoked",
    }
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
    if let Some(span) = function.origin.primary_span {
        return Some(span);
    }

    let mut span = None;
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
    suppressions: &[fict_compiler_oxc::FrontendSuppression],
    include: bool,
) -> Vec<AnalyzeDiagnostic> {
    if !include {
        return Vec::new();
    }
    apply_diagnostic_suppressions(source_index.source(), suppressions, &mut diagnostics);
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use fict_diagnostics::{
        Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
    };
    use fict_metadata::{
        HookReturnInfo, MetadataResolutionStatus, ModuleReactiveMetadata, ReactiveExportKind,
        ResolvedMetadataInput,
    };

    use super::{
        AnalyzeDiagnosticSeverity, TraceMarkerKind, analyze, tooling_function_setup_label,
    };
    use crate::{
        AnalyzeOptions, AnalyzeRequest, AnalyzeVerbosity, COMPILER_PROTOCOL_VERSION,
        CompileRequest, WarningsAsErrors, compile,
    };
    use fict_hir::FunctionKind;

    fn request(code: &str, filename: &str) -> AnalyzeRequest {
        AnalyzeRequest {
            protocol_version: COMPILER_PROTOCOL_VERSION,
            code: code.to_owned(),
            filename: filename.to_owned(),
            module_id: None,
            language: None,
            module_kind: None,
            metadata: Vec::new(),
            integration_diagnostics: Vec::new(),
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
    fn keeps_component_locations_inside_the_authored_function_span() {
        let result = analyze(request(
            concat!(
                "import { $effect, $state } from 'fict';\n",
                "\n",
                "export function Counter() {\n",
                "  const count = $state(0);\n",
                "  $effect(() => { count; });\n",
                "  return <button>{count}</button>;\n",
                "}\n",
            ),
            "counter-location.tsx",
        ));

        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
        let counter = result
            .components
            .iter()
            .find(|component| component.name == "Counter")
            .expect("Counter analysis");
        assert_eq!((counter.start_line, counter.end_line), (3, 7));
        assert_eq!(counter.trace.first().map(|trace| trace.line), Some(3));
    }

    #[test]
    fn labels_tooling_functions_by_execution_kind() {
        assert_eq!(
            tooling_function_setup_label(FunctionKind::Module),
            "Module setup runs on evaluation"
        );
        assert_eq!(
            tooling_function_setup_label(FunctionKind::Plain),
            "Function body runs when called"
        );
        assert_eq!(
            tooling_function_setup_label(FunctionKind::Component),
            "Component setup runs on mount"
        );
        assert_eq!(
            tooling_function_setup_label(FunctionKind::Hook),
            "Hook body runs when called"
        );
        assert_eq!(
            tooling_function_setup_label(FunctionKind::ReactiveScope),
            "Reactive scope callback runs when invoked"
        );

        let mut input = request(
            r#"
                import { $state } from 'fict';
                export function App() {
                    const count = $state(0);
                    return <div>{count}</div>;
                }
                export function useCounter() {
                    const count = $state(0);
                    return count;
                }
                renderHook(() => {
                    const count = $state(0);
                    return count;
                });
            "#,
            "function-kinds.tsx",
        );
        input.options.compiler_options.reactive_scopes = vec!["renderHook".into()];
        let result = analyze(input);
        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);

        let setup_label = |name: &str| {
            result
                .components
                .iter()
                .find(|component| component.name == name)
                .and_then(|component| component.trace.first())
                .and_then(|trace| trace.markers.first())
                .map(|marker| marker.label.as_str())
        };
        assert_eq!(setup_label("App"), Some("Component setup runs on mount"));
        assert_eq!(
            setup_label("useCounter"),
            Some("Hook body runs when called")
        );
        assert!(result.components.iter().any(|component| {
            component.trace.iter().any(|trace| {
                trace
                    .markers
                    .iter()
                    .any(|marker| marker.label == "Reactive scope callback runs when invoked")
            })
        }));
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
    fn indexes_every_ecmascript_line_terminator_for_traces_and_diagnostics() {
        let source = concat!(
            "import { $state } from 'fict';\r",
            "export function useCounter() {\u{2028}",
            "  let count = $state(0);\u{2029}",
            "  return count;\r\n",
            "}",
        );
        let result = analyze(request(source, "mixed-lines.ts"));
        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
        let hook = result
            .components
            .iter()
            .find(|component| component.name == "useCounter")
            .expect("hook analysis");
        assert_eq!(hook.end_line, 5);
        assert!(
            hook.trace.iter().any(|trace| {
                trace.line == 3
                    && trace
                        .markers
                        .iter()
                        .any(|marker| marker.label == "Signal initialization runs once")
            }),
            "{:?}",
            hook.trace
        );

        let broken = analyze(request(
            "const emoji = '😀';\rconst ok = 1;\u{2028}export const =",
            "broken.ts",
        ));
        let diagnostic = broken.diagnostics.first().expect("parser diagnostic");
        assert_eq!(diagnostic.line, 3);
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

    #[test]
    fn reports_late_inferred_hook_accessor_control_flow_like_compilation() {
        let source = r#"
            import { $state } from 'fict';
            function useBucket() {
                const count = $state(1);
                return { count };
            }
            export function App() {
                const bucket = useBucket();
                let label = 'off';
                if (bucket.count) label = 'on';
                return <span>{label}</span>;
            }
        "#;
        let analyzed = analyze(request(source, "late-hook-control-flow.tsx"));
        let finding = analyzed
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == "FICT-R006")
            .expect("analysis control-flow diagnostic");
        assert_eq!(finding.severity, AnalyzeDiagnosticSeverity::Error);
        assert!(finding.line > 0);
        assert!(finding.column > 0);

        let compiled = compile(CompileRequest {
            protocol_version: COMPILER_PROTOCOL_VERSION,
            code: source.to_owned(),
            filename: "late-hook-control-flow.tsx".to_owned(),
            module_id: None,
            public_module_id: None,
            language: None,
            module_kind: None,
            input_source_map: None,
            options: Default::default(),
            metadata: Vec::new(),
            integration_diagnostics: Vec::new(),
        });
        assert!(compiled.has_errors());
        assert!(compiled.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R006"
                && diagnostic.severity == DiagnosticSeverity::Error
        }));
    }

    #[test]
    fn derives_r006_suppression_from_the_same_emit_capability_as_compilation() {
        let source = "import { $state } from 'fict'; export function App() { const count = $state(0); if (count > 0) return <strong>on</strong>; return <span>off</span>; }";
        let supported = analyze(request(source, "supported-conditional.tsx"));
        assert!(
            supported
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code != "FICT-R006"),
            "{:?}",
            supported.diagnostics
        );

        let mut disabled_request = request(source, "disabled-conditional.tsx");
        disabled_request.options.compiler_options.lazy_conditional = false;
        let disabled = analyze(disabled_request);
        assert!(disabled.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "FICT-R006"
                && diagnostic.severity == AnalyzeDiagnosticSeverity::Error
        }));
    }

    #[test]
    fn suppresses_region_backed_effect_advisories_from_verified_emit_ir() {
        let mut input = request(
            r#"
                import { $effect, $state } from 'fict';
                export function useProbe() {
                    let count = $state(0);
                    let label = 'none';
                    if (count > 0) label = 'many';
                    $effect(() => console.log(label));
                    return { set: (value: number) => { count = value; } };
                }
            "#,
            "region-effect.ts",
        );
        input.options.compiler_options.warnings_as_errors = WarningsAsErrors::Boolean(true);

        let result = analyze(input);

        assert!(
            result
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code != "FICT-E001"),
            "{:?}",
            result.diagnostics
        );
        assert!(
            result
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.severity != AnalyzeDiagnosticSeverity::Error),
            "{:?}",
            result.diagnostics
        );
    }

    #[test]
    fn shares_resolved_import_metadata_with_compilation() {
        let source = r#"
            import { count } from './dep';
            import { useCounter } from './hooks';
            export function App() {
                const api = useCounter();
                return <div>{count}{api.count}</div>;
            }
        "#;
        let metadata = vec![
            ResolvedMetadataInput {
                request: "./dep".into(),
                resolved_id: Some("/src/dep.ts".into()),
                status: MetadataResolutionStatus::Resolved,
                metadata: Some(ModuleReactiveMetadata {
                    exports: BTreeMap::from([("count".into(), ReactiveExportKind::Signal)]),
                    ..ModuleReactiveMetadata::new()
                }),
                fingerprint: "sha256:dep".into(),
            },
            ResolvedMetadataInput {
                request: "./hooks".into(),
                resolved_id: Some("/src/hooks.ts".into()),
                status: MetadataResolutionStatus::Resolved,
                metadata: Some(ModuleReactiveMetadata {
                    hooks: BTreeMap::from([(
                        "useCounter".into(),
                        HookReturnInfo {
                            object_props: BTreeMap::from([(
                                "count".into(),
                                ReactiveExportKind::Signal,
                            )]),
                            ..HookReturnInfo::default()
                        },
                    )]),
                    ..ModuleReactiveMetadata::new()
                }),
                fingerprint: "sha256:hooks".into(),
            },
        ];
        let mut analyze_request = request(source, "consumer.tsx");
        analyze_request.metadata = metadata.clone();
        let compile_result = compile(CompileRequest {
            protocol_version: COMPILER_PROTOCOL_VERSION,
            code: source.into(),
            filename: "consumer.tsx".into(),
            module_id: None,
            public_module_id: None,
            language: None,
            module_kind: None,
            input_source_map: None,
            options: analyze_request.options.compiler_options.clone(),
            metadata,
            integration_diagnostics: Vec::new(),
        });
        let analyze_result = analyze(analyze_request);

        assert!(
            !compile_result.has_errors(),
            "{:?}",
            compile_result.diagnostics
        );
        assert!(
            compile_result.code.contains("count()"),
            "{}",
            compile_result.code
        );
        assert!(
            compile_result.code.contains("api.count()"),
            "{}",
            compile_result.code
        );
        assert!(
            analyze_result.diagnostics.is_empty(),
            "{:?}",
            analyze_result.diagnostics
        );
        let app = analyze_result
            .components
            .iter()
            .find(|component| component.name == "App")
            .expect("App analysis");
        let dependencies: Vec<_> = app
            .trace
            .iter()
            .flat_map(|line| &line.markers)
            .flat_map(|marker| marker.deps.iter().flatten())
            .collect();
        assert!(dependencies.iter().any(|dependency| *dependency == "count"));
        assert!(
            dependencies
                .iter()
                .any(|dependency| dependency.as_str() == "api.count")
        );
    }

    #[test]
    fn includes_integration_diagnostics_in_analysis_policy() {
        let mut input = request(
            "export function App() { return <div />; }",
            "integration.tsx",
        );
        input.options.compiler_options.strict_guarantee = false;
        input.integration_diagnostics.push(
            Diagnostic::new(
                DiagnosticCode::new("FICT-R006").expect("diagnostic code"),
                DiagnosticSeverity::Warning,
                "integration warning",
            )
            .with_primary_span(SourceSpan::empty(0))
            .with_guarantee_class(GuaranteeClass::Advisory),
        );

        let result = analyze(input);

        assert!(
            result
                .components
                .iter()
                .any(|component| component.name == "App")
        );
        assert!(result.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "FICT-R006"
                && diagnostic.message == "integration warning"
                && diagnostic.severity == AnalyzeDiagnosticSeverity::Warning
                && diagnostic.line == 1
                && diagnostic.column == 1
        }));
    }

    #[test]
    fn program_compiler_disable_returns_an_empty_analysis_without_internal_errors() {
        let result = analyze(request(
            concat!(
                "'use fict-compiler-disable';\n",
                "import { $state } from 'fict';\n",
                "export function App() { const count = $state(0); return <div>{count}</div>; }",
            ),
            "disabled.tsx",
        ));

        assert!(result.components.is_empty());
        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    }

    #[test]
    fn applies_source_suppressions_before_analysis_warning_escalation() {
        let mut input = request(
            concat!(
                "import { $memo } from 'fict';\n",
                "// fict-ignore-next-line FICT-M\u{2029}",
                "const value = $memo(() => { console.log('side'); });",
            ),
            "suppressed.ts",
        );
        input.options.compiler_options.strict_guarantee = false;
        input.options.compiler_options.warnings_as_errors = WarningsAsErrors::Boolean(true);

        let result = analyze(input);

        assert!(
            result
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code != "FICT-M003"),
            "{:?}",
            result.diagnostics
        );
    }
}
