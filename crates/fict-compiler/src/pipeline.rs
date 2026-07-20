use crate::control_flow_diagnostics::reactive_control_flow_diagnostics;
use crate::diagnostic_policy::{
    apply_diagnostic_policy, apply_diagnostic_suppressions, configured_diagnostic_severity,
};
use crate::metadata_analysis::generate_module_metadata;
use crate::result::{INTERNAL_RECOVERY_HELP, failed_result, request_error_result};
use crate::source_map::compose_source_maps;
use crate::{
    CompileRequest, CompileResult, CompilerArtifact, CompilerArtifactKind, CompilerExplainArtifact,
    CompilerExplainEvent, CompilerExplainEventKind, CompilerStats, CorePassOptions,
    HandlerArtifactMetadata, ModuleKind, NormalizedCompileRequest, RawSourceMap, SourceLanguage,
    run_core_passes,
};
use fict_compiler_oxc::{
    FrontendSuppression, HirBuildOptions, OxcCompileOptions, OxcModuleKind, OxcSourceLanguage,
    OxcTypeScriptOptions, analyze_frontend, build_hir, compile_disabled, emit_program,
};
use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_emit::{NoJsxLoweringOptions, lower_core_with_hook_returns};
use fict_hir::{
    FictMacroKind, HirFile, HirInstructionKind, ReactiveCallKind, StructuredSourceKind,
};
use fict_metadata::MetadataResolutionStatus;
use std::mem;
/// Execute the currently connected native pipeline and return a complete result.
#[must_use]
pub fn compile(request: CompileRequest) -> CompileResult {
    match request.normalize() {
        Ok(request) => compile_normalized(request),
        Err(error) => request_error_result(error),
    }
}

/// Construct the generic result returned when the N-API panic boundary fires.
#[must_use]
pub fn internal_error_result() -> CompileResult {
    failed_result(
        "FICT-I001",
        "the native compiler encountered an internal error",
        GuaranteeClass::Internal,
        Some(INTERNAL_RECOVERY_HELP),
    )
}
fn compile_normalized(request: NormalizedCompileRequest) -> CompileResult {
    let mut result = CompileResult::empty();
    result.diagnostics = request.integration_diagnostics.clone();
    #[cfg(not(feature = "preview"))]
    if request
        .options
        .preview
        .as_ref()
        .is_some_and(|preview| preview.resumable)
    {
        result.diagnostics.push(
            diagnostic(
                "FICT-PREVIEW-UNAVAILABLE",
                DiagnosticSeverity::Error,
                "Preview compilation is not connected to the stable native pass graph",
                GuaranteeClass::Unsupported,
            )
            .with_help("omit preview options until the optional Preview crate is enabled"),
        );
    }

    for metadata in &request.metadata {
        if metadata.status == MetadataResolutionStatus::IncompleteCycle {
            result.metadata_incomplete = true;
            result
                .unresolved_metadata_requests
                .push(metadata.request.clone());
        }
    }
    result.unresolved_metadata_requests.sort();
    result.unresolved_metadata_requests.dedup();
    let oxc_options = OxcCompileOptions {
        language: oxc_language(request.language),
        module_kind: oxc_module_kind(request.module_kind),
        typescript: OxcTypeScriptOptions {
            allow_namespaces: request.options.typescript.allow_namespaces,
            only_remove_type_imports: request.options.typescript.only_remove_type_imports,
            optimize_const_enums: request.options.typescript.optimize_const_enums,
            optimize_enums: request.options.typescript.optimize_enums,
            rewrite_import_extensions: request.options.typescript.rewrite_import_extensions,
            remove_class_fields_without_initializer: request
                .options
                .typescript
                .remove_class_fields_without_initializer,
        },
        sourcemap: request.options.sourcemap,
    };
    if !request.options.strict_guarantee
        && result.diagnostics.iter().any(|diagnostic| {
            diagnostic.severity != DiagnosticSeverity::Error && diagnostic.primary_span.is_some()
        })
        && request
            .code
            .as_bytes()
            .windows(b"fict-ignore".len())
            .any(|window| window.eq_ignore_ascii_case(b"fict-ignore"))
        && let Some(frontend) = analyze_frontend(&request.code, oxc_options).summary
    {
        apply_diagnostic_suppressions(
            &request.code,
            &frontend.source_facts.suppressions,
            &mut result.diagnostics,
        );
    }
    finalize_diagnostics(&mut result, &request.options);
    if result.has_errors() {
        attach_explain_if_requested(&mut result, &request, &[], &[]);
        return result;
    }

    let build = build_hir(
        &request.code,
        oxc_options,
        &HirBuildOptions {
            reactive_scopes: request.options.reactive_scopes.clone(),
            strict_guarantee: request.options.strict_guarantee,
            reactive_creation_control_flow_severity: configured_diagnostic_severity(
                &request.options.warning_levels,
                "FICT-R004",
                DiagnosticSeverity::Error,
            ),
            resolved_metadata: request.metadata.clone(),
        },
    );
    result.diagnostics.extend(build.diagnostics);
    if build
        .frontend
        .as_ref()
        .is_some_and(|frontend| frontend.program_compiler_disabled())
    {
        return emit_disabled_result(result, &request, oxc_options);
    }
    let Some(hir) = build.hir else {
        finalize_diagnostics(&mut result, &request.options);
        if !result.has_errors() {
            result.diagnostics.push(diagnostic(
                "FICT-I003",
                DiagnosticSeverity::Error,
                "the OXC frontend returned no HIR without a diagnostic",
                GuaranteeClass::Internal,
            ));
        }
        finalize_diagnostics(&mut result, &request.options);
        attach_explain_if_requested(&mut result, &request, &[], &[]);
        return result;
    };
    let source_events = if request.options.explain {
        source_explain_events(&hir)
    } else {
        Vec::new()
    };
    let Some(frontend) = build.frontend else {
        result.diagnostics.push(diagnostic(
            "FICT-I004",
            DiagnosticSeverity::Error,
            "the OXC frontend returned HIR without its binding summary",
            GuaranteeClass::Internal,
        ));
        finalize_diagnostics(&mut result, &request.options);
        attach_explain_if_requested(&mut result, &request, &source_events, &[]);
        return result;
    };
    let suppressions = frontend.source_facts.suppressions.clone();
    let Some(module_plan) = build.module_plan else {
        result.diagnostics.push(diagnostic(
            "FICT-I005",
            DiagnosticSeverity::Error,
            "the OXC frontend returned HIR without its owned module plan",
            GuaranteeClass::Internal,
        ));
        finalize_diagnostics(&mut result, &request.options);
        attach_explain_if_requested(&mut result, &request, &source_events, &[]);
        return result;
    };
    if request.options.strict_guarantee
        && let Some(suppression) = suppressions.first()
    {
        result.diagnostics.push(
            diagnostic(
                "FICT-STRICT-SUPPRESSION",
                DiagnosticSeverity::Error,
                "strictGuarantee does not allow fict-ignore suppression comments",
                GuaranteeClass::Unsupported,
            )
            .with_primary_span(suppression.comment_span)
            .with_help("remove suppressions to keep fail-closed guarantees"),
        );
    }
    finalize_source_diagnostics(&mut result, &request, &suppressions);
    if result.has_errors() {
        attach_explain_if_requested(&mut result, &request, &source_events, &[]);
        return result;
    }
    let core = match run_core_passes(
        &hir,
        CorePassOptions {
            optimize: request.options.optimize,
            strict_guarantee: request.options.strict_guarantee,
            ..CorePassOptions::default()
        },
    ) {
        Ok(core) => core,
        Err(diagnostics) => {
            result.diagnostics.extend(diagnostics.into_sorted());
            finalize_source_diagnostics(&mut result, &request, &suppressions);
            attach_explain_if_requested(&mut result, &request, &source_events, &[]);
            return result;
        }
    };
    result.diagnostics.extend(core.diagnostics.iter().cloned());
    finalize_source_diagnostics(&mut result, &request, &suppressions);
    if result.has_errors() {
        attach_explain_if_requested(&mut result, &request, &source_events, &[]);
        return result;
    }
    let metadata = generate_module_metadata(&core, &module_plan, &frontend, &request.metadata);
    let local_hook_returns = metadata.local_hook_returns;
    result.module_metadata = metadata.metadata;
    result.metadata_dependencies = metadata.dependencies;
    result
        .unresolved_metadata_requests
        .extend(metadata.unresolved_requests);
    result.unresolved_metadata_requests.sort();
    result.unresolved_metadata_requests.dedup();
    result.metadata_incomplete |= metadata.incomplete;
    result.diagnostics.extend(metadata.diagnostics);
    finalize_source_diagnostics(&mut result, &request, &suppressions);
    if result.has_errors() {
        attach_explain_if_requested(&mut result, &request, &source_events, &[]);
        return result;
    }
    result.stats = Some(CompilerStats {
        stage_durations_ns: core.stats.stage_durations_ns.clone(),
        counters: core.stats.counters.clone(),
    });
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
    let runtime_family = frontend.runtime_family;
    let emit = match lower_core_with_hook_returns(
        &core.hir,
        &regions,
        &cycles,
        Some(&scopes),
        &local_hook_returns,
        NoJsxLoweringOptions {
            runtime_family,
            dev: request.options.dev,
            lazy_conditional: request.options.lazy_conditional,
            getter_cache: request.options.getter_cache,
            full_optimization: request.options.optimize
                && request.options.optimize_level == crate::request::OptimizeLevel::Full,
            optimize: request.options.optimize,
            inline_derived_memos: request.options.inline_derived_memos,
            strict_guarantee: request.options.strict_guarantee,
            preview: request
                .options
                .preview
                .as_ref()
                .is_some_and(|preview| preview.resumable),
            fine_grained_dom: request.options.fine_grained_dom,
        },
    ) {
        Ok(emit) => emit,
        Err(diagnostics) => {
            result.diagnostics.extend(reactive_control_flow_diagnostics(
                &core,
                &local_hook_returns,
                None,
            ));
            result.diagnostics.extend(diagnostics.into_sorted());
            finalize_source_diagnostics(&mut result, &request, &suppressions);
            attach_explain_if_requested(&mut result, &request, &source_events, &[]);
            return result;
        }
    };
    #[allow(unused_mut)]
    let mut emit = emit;
    result.diagnostics.extend(reactive_control_flow_diagnostics(
        &core,
        &local_hook_returns,
        Some(&emit),
    ));
    finalize_source_diagnostics(&mut result, &request, &suppressions);
    if result.has_errors() {
        attach_explain_if_requested(&mut result, &request, &source_events, &[]);
        return result;
    }
    #[cfg(feature = "preview")]
    if let Some(preview) = request
        .options
        .preview
        .as_ref()
        .filter(|preview| preview.resumable)
    {
        if let Err(diagnostics) = fict_compiler_preview::attach_preview_plan(
            &core.hir,
            &mut emit,
            &fict_compiler_preview::PreviewOptions {
                source_module_id: request.module_id.clone(),
                auto_extract_handlers: preview.auto_extract_handlers,
                auto_extract_threshold: preview.auto_extract_threshold,
                public_module_id: request.public_module_id.clone(),
            },
        ) {
            result.diagnostics.extend(diagnostics.into_sorted());
            finalize_source_diagnostics(&mut result, &request, &suppressions);
            attach_explain_if_requested(&mut result, &request, &source_events, &[]);
            return result;
        }
        if let Err(diagnostics) = fict_emit::verify_emit_program(&core.hir, &regions, &emit) {
            result.diagnostics.extend(diagnostics.into_sorted());
            finalize_source_diagnostics(&mut result, &request, &suppressions);
            attach_explain_if_requested(&mut result, &request, &source_events, &[]);
            return result;
        }
    }
    let output = emit_program(&request.code, &request.filename, oxc_options, &emit);
    let helpers = output.runtime_helpers.clone();
    result.diagnostics.extend(output.diagnostics);
    finalize_source_diagnostics(&mut result, &request, &suppressions);

    if !result.has_errors() {
        result.code = output.code;
        if let Some(source_map_json) = output.source_map_json {
            match decode_native_source_map(
                &source_map_json,
                request.input_source_map.as_ref(),
                "main output",
            ) {
                Ok(map) => result.map = Some(map),
                Err(diagnostic) => result.diagnostics.push(*diagnostic),
            }
        }
        for artifact in output.handler_artifacts {
            let map = match artifact.source_map_json.as_deref() {
                Some(source_map_json) => match decode_native_source_map(
                    source_map_json,
                    request.input_source_map.as_ref(),
                    &format!("handler artifact {}", artifact.id),
                ) {
                    Ok(map) => Some(map),
                    Err(diagnostic) => {
                        result.diagnostics.push(*diagnostic);
                        break;
                    }
                },
                None => None,
            };
            result.artifacts.push(CompilerArtifact {
                id: artifact.id,
                kind: CompilerArtifactKind::HandlerModule,
                code: artifact.code,
                map,
                handler: Some(HandlerArtifactMetadata {
                    source_export_name: artifact.source_export_name,
                    artifact_export_name: artifact.artifact_export_name,
                    module_specifier: artifact.module_specifier,
                    source_span: artifact.source_span,
                }),
            });
        }
        let expected_artifacts = emit
            .preview_plan
            .as_ref()
            .map_or(0, |preview| preview.handlers.len());
        if result.artifacts.len() != expected_artifacts {
            result.diagnostics.push(diagnostic(
                "FICT-OXC-PREVIEW-ARTIFACT",
                DiagnosticSeverity::Error,
                "OXC did not emit exactly one structured artifact for every Preview handler",
                GuaranteeClass::Internal,
            ));
        }
        result
            .artifacts
            .sort_by(|left, right| left.id.cmp(&right.id));
    }

    finalize_source_diagnostics(&mut result, &request, &suppressions);
    if result.has_errors() {
        result.code.clear();
        result.map = None;
        result.artifacts.clear();
    }
    attach_explain_if_requested(&mut result, &request, &source_events, &helpers);
    result
}

fn emit_disabled_result(
    mut result: CompileResult,
    request: &NormalizedCompileRequest,
    options: OxcCompileOptions,
) -> CompileResult {
    let output = compile_disabled(&request.code, &request.filename, options);
    result.diagnostics.extend(output.diagnostics);
    finalize_diagnostics(&mut result, &request.options);
    if !result.has_errors() {
        result.code = output.code;
        if let Some(source_map_json) = output.source_map_json {
            match decode_native_source_map(
                &source_map_json,
                request.input_source_map.as_ref(),
                "disabled output",
            ) {
                Ok(map) => result.map = Some(map),
                Err(diagnostic) => result.diagnostics.push(*diagnostic),
            }
        }
    }
    finalize_diagnostics(&mut result, &request.options);
    if result.has_errors() {
        result.code.clear();
        result.map = None;
    }
    attach_explain_if_requested(&mut result, request, &[], &[]);
    result
}

fn decode_native_source_map(
    source_map_json: &str,
    input_source_map: Option<&RawSourceMap>,
    output_name: &str,
) -> Result<RawSourceMap, Box<Diagnostic>> {
    let map = serde_json::from_str::<RawSourceMap>(source_map_json)
        .map_err(|error| error.to_string())
        .and_then(|map| {
            map.validate()
                .map(|()| map)
                .map_err(|error| error.to_string())
        })
        .map_err(|error| {
            Box::new(
                diagnostic(
                    "FICT-I002",
                    DiagnosticSeverity::Error,
                    format!("OXC emitted an invalid source map for {output_name}: {error}"),
                    GuaranteeClass::Internal,
                )
                .with_help("report the source-map fixture; partial output was discarded"),
            )
        })?;
    let map = match input_source_map {
        Some(input) => compose_source_maps(&map, input),
        None => Ok(map),
    }
    .and_then(|map| {
        map.validate()
            .map(|()| map)
            .map_err(|error| error.to_string())
    })
    .map_err(|error| {
        Box::new(
            diagnostic(
                "FICT-SOURCEMAP-COMPOSE",
                DiagnosticSeverity::Error,
                format!("failed to compose the native source map for {output_name}: {error}"),
                GuaranteeClass::Internal,
            )
            .with_help("report the source-map fixture; partial output was discarded"),
        )
    })?;
    Ok(map)
}

pub(crate) fn oxc_language(language: SourceLanguage) -> OxcSourceLanguage {
    match language {
        SourceLanguage::JavaScript => OxcSourceLanguage::JavaScript,
        SourceLanguage::JavaScriptJsx => OxcSourceLanguage::JavaScriptJsx,
        SourceLanguage::TypeScript => OxcSourceLanguage::TypeScript,
        SourceLanguage::TypeScriptJsx => OxcSourceLanguage::TypeScriptJsx,
    }
}

pub(crate) fn oxc_module_kind(module_kind: ModuleKind) -> OxcModuleKind {
    match module_kind {
        ModuleKind::Module => OxcModuleKind::Module,
        ModuleKind::Script => OxcModuleKind::Script,
        ModuleKind::CommonJs => OxcModuleKind::CommonJs,
        ModuleKind::Unambiguous => OxcModuleKind::Unambiguous,
    }
}

fn diagnostic(
    code: &'static str,
    severity: DiagnosticSeverity,
    message: impl Into<String>,
    guarantee_class: GuaranteeClass,
) -> Diagnostic {
    Diagnostic::new(static_code(code), severity, message).with_guarantee_class(guarantee_class)
}

fn static_code(value: &'static str) -> DiagnosticCode {
    DiagnosticCode::new(value).expect("compiler diagnostic literals must be valid")
}

fn finalize_diagnostics(result: &mut CompileResult, options: &crate::CompilerOptions) {
    apply_diagnostic_policy(options, &mut result.diagnostics);
    result.diagnostics = DiagnosticBundle::new(mem::take(&mut result.diagnostics)).into_sorted();
}

fn finalize_source_diagnostics(
    result: &mut CompileResult,
    request: &NormalizedCompileRequest,
    suppressions: &[FrontendSuppression],
) {
    apply_diagnostic_suppressions(&request.code, suppressions, &mut result.diagnostics);
    finalize_diagnostics(result, &request.options);
}

fn attach_explain_if_requested(
    result: &mut CompileResult,
    request: &NormalizedCompileRequest,
    source_events: &[CompilerExplainEvent],
    helpers: &[String],
) {
    if !request.options.explain {
        return;
    }
    result.explain = Some(CompilerExplainArtifact {
        version: 1,
        file_name: request.filename.clone(),
        helpers: helpers.to_vec(),
        diagnostics: result.diagnostics.clone(),
        events: source_events
            .iter()
            .cloned()
            .chain(helpers.iter().map(|helper| CompilerExplainEvent {
                kind: CompilerExplainEventKind::RuntimeHelper,
                message: format!("emits runtime helper {helper}"),
                name: Some(helper.clone()),
                code: None,
                span: None,
            }))
            .chain(
                result
                    .diagnostics
                    .iter()
                    .map(|finding| CompilerExplainEvent {
                        kind: CompilerExplainEventKind::Diagnostic,
                        message: finding.message.clone(),
                        name: None,
                        code: Some(finding.code.to_string()),
                        span: finding.primary_span,
                    }),
            )
            .collect(),
    });
}

fn source_explain_events(hir: &HirFile) -> Vec<CompilerExplainEvent> {
    let mut events = Vec::new();
    for function in &hir.functions {
        for block in &function.blocks {
            if let Some(hint) = &block.source_hint
                && let Some(name) = structured_source_name(&hint.kind)
                && let Some(span) = hint.origin.primary_span
            {
                events.push(CompilerExplainEvent {
                    kind: CompilerExplainEventKind::SourceControlFlow,
                    message: format!("preserves {name} control flow for native reactive analysis"),
                    name: Some(name),
                    code: None,
                    span: Some(span),
                });
            }

            for instruction in &block.instructions {
                let Some(span) = instruction.origin.primary_span else {
                    continue;
                };
                let event = match &instruction.kind {
                    HirInstructionKind::Call(call) => match (call.macro_kind, call.reactive_kind) {
                        (Some(FictMacroKind::State), _) => Some(CompilerExplainEvent {
                            kind: CompilerExplainEventKind::SourceSignal,
                            message: "classifies $state as a source signal".to_owned(),
                            name: Some("$state".to_owned()),
                            code: None,
                            span: Some(span),
                        }),
                        (Some(FictMacroKind::Effect), _) => Some(CompilerExplainEvent {
                            kind: CompilerExplainEventKind::SourceEffect,
                            message: "classifies $effect as a reactive effect".to_owned(),
                            name: Some("$effect".to_owned()),
                            code: None,
                            span: Some(span),
                        }),
                        (Some(FictMacroKind::Memo), _) => Some(CompilerExplainEvent {
                            kind: CompilerExplainEventKind::SourceMemo,
                            message: "classifies $memo as a derived memo".to_owned(),
                            name: Some("$memo".to_owned()),
                            code: None,
                            span: Some(span),
                        }),
                        (None, Some(ReactiveCallKind::Memo)) => Some(CompilerExplainEvent {
                            kind: CompilerExplainEventKind::SourceMemo,
                            message: "classifies createMemo as a derived memo".to_owned(),
                            name: Some("createMemo".to_owned()),
                            code: None,
                            span: Some(span),
                        }),
                        (None, _) => None,
                    },
                    HirInstructionKind::Jsx { .. } => Some(CompilerExplainEvent {
                        kind: CompilerExplainEventKind::SourceJsx,
                        message: "lowers JSX through the native template pipeline".to_owned(),
                        name: None,
                        code: None,
                        span: Some(span),
                    }),
                    _ => None,
                };
                if let Some(event) = event {
                    events.push(event);
                }
            }
        }
    }

    events.sort_by(|left, right| source_event_sort_key(left).cmp(&source_event_sort_key(right)));
    events.dedup_by(|left, right| {
        left.kind == right.kind && left.name == right.name && left.span == right.span
    });
    events
}

fn source_event_sort_key(event: &CompilerExplainEvent) -> (u32, u32, u8, Option<&str>) {
    let (start, end) = event
        .span
        .map_or((u32::MAX, u32::MAX), |span| (span.start(), span.end()));
    let kind = match event.kind {
        CompilerExplainEventKind::SourceSignal => 0,
        CompilerExplainEventKind::SourceEffect => 1,
        CompilerExplainEventKind::SourceMemo => 2,
        CompilerExplainEventKind::SourceJsx => 3,
        CompilerExplainEventKind::SourceControlFlow => 4,
        CompilerExplainEventKind::RuntimeHelper => 5,
        CompilerExplainEventKind::Diagnostic => 6,
    };
    (start, end, kind, event.name.as_deref())
}

fn structured_source_name(kind: &StructuredSourceKind) -> Option<String> {
    match kind {
        StructuredSourceKind::LexicalBlock => None,
        StructuredSourceKind::Conditional => Some("if".to_owned()),
        StructuredSourceKind::Switch => Some("switch".to_owned()),
        StructuredSourceKind::WhileLoop => Some("while".to_owned()),
        StructuredSourceKind::DoWhileLoop => Some("do-while".to_owned()),
        StructuredSourceKind::ForLoop => Some("for".to_owned()),
        StructuredSourceKind::ForOfLoop => Some("for-of".to_owned()),
        StructuredSourceKind::ForAwaitOfLoop => Some("for-await-of".to_owned()),
        StructuredSourceKind::ForInLoop => Some("for-in".to_owned()),
        StructuredSourceKind::Try => Some("try".to_owned()),
        StructuredSourceKind::Catch => Some("catch".to_owned()),
        StructuredSourceKind::Finally => Some("finally".to_owned()),
        StructuredSourceKind::Labeled(label) => Some(format!("label:{label}")),
    }
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

    use super::{compile, internal_error_result};
    use crate::{
        COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerExplainEventKind, CompilerOptions,
        CompilerPreviewOptions, ModuleKind, RawSourceMap, WarningLevel, WarningsAsErrors,
    };

    fn request(code: &str, filename: &str) -> CompileRequest {
        CompileRequest {
            protocol_version: COMPILER_PROTOCOL_VERSION,
            code: code.to_owned(),
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
    fn compiles_empty_plain_javascript_and_plain_typescript() {
        let empty = compile(request("", "empty.js"));
        assert!(!empty.has_errors());
        assert!(empty.code.is_empty());

        let javascript = compile(request("export const value = 1", "value.js"));
        assert!(!javascript.has_errors());
        assert!(javascript.code.contains("export const value = 1"));

        let typescript = compile(request("export const value: number = 1", "value.ts"));
        assert!(!typescript.has_errors());
        assert!(typescript.code.contains("export const value = 1"));
        assert!(!typescript.code.contains(": number"));
    }

    #[test]
    fn honors_program_compiler_disable_before_fict_and_typescript_policy() {
        let result = compile(request(
            concat!(
                "'use fict-compiler';\n",
                "'use fict-compiler-disable';\n",
                "import { $state } from 'fict';\n",
                "export enum Color { Red = 1 }\n",
                "export function App() { const count = $state(0); return <div>{count}</div>; }",
            ),
            "disabled.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.code.contains("use fict-compiler-disable"));
        assert!(result.code.contains("$state(0)"));
        assert!(result.code.contains("<div>{count}</div>"));
        assert!(result.code.contains("export let Color"));
        assert!(!result.code.contains("__fict"));
        assert!(!result.code.contains("template("));
        assert!(result.module_metadata.exports.is_empty());
        assert!(result.module_metadata.hooks.is_empty());
        assert!(result.module_metadata.namespaces.is_empty());
    }

    #[test]
    fn applies_serializable_typescript_lowering_options() {
        let mut input = request(
            "import './setup.ts'; const enum Size { Small = 1 } export const value = Size.Small;",
            "options.ts",
        );
        input.options.typescript.rewrite_import_extensions = true;
        input.options.typescript.optimize_const_enums = true;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.code.contains("./setup.js"));
        assert!(!result.code.contains("Size["));
        assert!(result.code.contains("value = 1"));
    }

    #[test]
    fn rejects_standard_decorators_before_emitting_unrunnable_javascript() {
        let result = compile(request(
            "function sealed(value: unknown) { return value; } @sealed export class Service {}",
            "decorator.ts",
        ));

        assert!(result.has_errors());
        assert!(result.code.is_empty());
        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code.as_str() == "FICT-TS-DECORATOR-STANDARD")
            .unwrap_or_else(|| panic!("{:?}", result.diagnostics));
        assert!(
            diagnostic
                .help
                .as_deref()
                .is_some_and(|help| help.contains("target-compatible transform"))
        );
    }

    #[test]
    fn emits_reactive_tsx_modules_as_commonjs() {
        let mut input = request(
            "import { $state } from 'fict'; export default function App() { let count = $state(0); return <button onClick={() => count++}>{count}</button>; }",
            "component.tsx",
        );
        input.module_kind = Some(ModuleKind::CommonJs);
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result
                .code
                .contains("__fict_cjs_load(require(\"fict/internal\")"),
            "{}",
            result.code
        );
        assert!(result.code.contains("__fictUseSignal"), "{}", result.code);
        assert!(
            result
                .code
                .contains("Object.defineProperty(__fict_cjs_exports, \"default\""),
            "{}",
            result.code
        );
        assert!(!result.code.contains("import {"), "{}", result.code);
        assert!(!result.code.contains("export default"), "{}", result.code);
    }

    #[test]
    fn lowers_derived_values_and_preserves_fragment_roots() {
        #[rustfmt::skip]
        let cases = [
            ("import { $effect, $state } from 'fict'; export function Counter() { let count = $state(2); const doubled = count * 2; $effect(() => doubled); return <div>{doubled}</div>; }", "__fictUseMemo(__fictCtx, () => count() * 2)|() => doubled()|__fictUseEffect(__fictCtx, () => doubled())", ""),
            ("'use no memo'; import { $effect, $state } from 'fict'; export function Counter() { let count = $state(2); const doubled = count * 2; $effect(() => doubled); return <div>{doubled}</div>; }", "() => count() * 2|() => doubled()|__fictUseEffect(__fictCtx, () => doubled())", "__fictUseMemo(__fictCtx, () => count() * 2)"),
            ("import { $effect, $state } from 'fict'; export function Counter() { 'use no memo'; let count = $state(2); const doubled = count * 2; $effect(() => doubled); return <div>{doubled}</div>; }", "() => count() * 2|() => doubled()|__fictUseEffect(__fictCtx, () => doubled())", ""),
            ("export function Label(props) { const text = props.value + '!'; return <span>{text}</span>; }", "__fictUseMemo(__fictCtx, () => props.value + \"!\")|() => text()", ""),
            ("import { createEffect } from '@fictjs/runtime'; export function Routes(props) { const routes = props.routes ?? []; const compiled = routes.map(value => value); const branches = compiled.slice(); const match = branches.slice(0, 1)[0]; const route = match.route; const hasPreload = typeof route.preload === 'function'; createEffect(() => { for (const branch of branches) void branch; void hasPreload; }); return route; }", "() => match().route|const branch of branches()", "__fictUseMemo()("),
            ("import { reactive } from '@fictjs/runtime'; export function App() { const render = () => null; return <>{[reactive(render)]}</>; }", "template(\"<!---->\", void 0, void 0, void 0, true)|insert(__fict_jsx", ""),
        ];
        for (source, expected, rejected) in cases {
            let result = compile(request(source, "lowering.tsx"));
            assert!(!result.has_errors(), "{:?}", result.diagnostics);
            #[rustfmt::skip]
            assert!(expected.split('|').all(|s| result.code.contains(s)), "{}", result.code);
            #[rustfmt::skip]
            assert!(rejected.is_empty() || rejected.split('|').all(|s| !result.code.contains(s)), "{}", result.code);
        }
    }

    #[test]
    fn applies_function_pure_dce_cse_and_mutation_barriers() {
        let source = r#"
            export function probe(value, target) {
                "use pure";
                const unused = sideEffect(value);
                const first = read(value);
                const second = read(value);
                target.value = 2;
                const third = read(value);
                return [first, second, third];
            }
        "#;
        let optimized = compile(request(source, "function-pure.ts"));
        assert!(!optimized.has_errors(), "{:?}", optimized.diagnostics);
        assert!(!optimized.code.contains("sideEffect"), "{}", optimized.code);
        assert_eq!(
            optimized.code.matches("read(value)").count(),
            2,
            "{}",
            optimized.code
        );
        assert!(
            optimized.code.contains("const second = first"),
            "{}",
            optimized.code
        );
        assert!(
            optimized.code.contains("target.value = 2"),
            "{}",
            optimized.code
        );

        let mut disabled_request = request(source, "function-pure-disabled.ts");
        disabled_request.options.optimize = false;
        let disabled = compile(disabled_request);
        assert!(!disabled.has_errors(), "{:?}", disabled.diagnostics);
        assert!(
            disabled.code.contains("sideEffect(value)"),
            "{}",
            disabled.code
        );
        assert_eq!(
            disabled.code.matches("read(value)").count(),
            3,
            "{}",
            disabled.code
        );

        let ordinary = compile(request(
            "export function probe(value) { const unused = sideEffect(value); return 1; }",
            "ordinary-function.ts",
        ));
        assert!(!ordinary.has_errors(), "{:?}", ordinary.diagnostics);
        assert!(
            ordinary.code.contains("sideEffect(value)"),
            "{}",
            ordinary.code
        );

        let no_side_effects = compile(request(
            "/* #__NO_SIDE_EFFECTS__ */ function probe(value) { const unused = sideEffect(value); return 1; } export { probe };",
            "function-no-side-effects.ts",
        ));
        assert!(
            !no_side_effects.has_errors(),
            "{:?}",
            no_side_effects.diagnostics
        );
        assert!(
            !no_side_effects.code.contains("sideEffect"),
            "{}",
            no_side_effects.code
        );

        let destructuring_barrier = compile(request(
            r#"
                export function probe(object, source) {
                    "use pure";
                    const first = object.value;
                    const { value } = source;
                    const second = object.value;
                    return [first, value, second];
                }
            "#,
            "function-pure-destructure.ts",
        ));
        assert!(
            !destructuring_barrier.has_errors(),
            "{:?}",
            destructuring_barrier.diagnostics
        );
        assert_eq!(
            destructuring_barrier.code.matches("object.value").count(),
            2,
            "{}",
            destructuring_barrier.code
        );

        let optional = compile(request(
            r#"
                export function probe(maybe, value) {
                    "use pure";
                    const first = maybe?.(value);
                    const second = maybe?.(value);
                    const firstMember = maybe?.value;
                    const secondMember = maybe?.value;
                    return [first, second, firstMember, secondMember];
                }
            "#,
            "function-pure-optional.ts",
        ));
        assert!(!optional.has_errors(), "{:?}", optional.diagnostics);
        assert!(
            optional.code.contains("const second = first"),
            "{}",
            optional.code
        );
        assert!(
            optional.code.contains("const secondMember = firstMember"),
            "{}",
            optional.code
        );

        let loop_initializer = compile(request(
            r#"
                export function probe() {
                    "use pure";
                    for (let unused = sideEffect(); false;) {}
                    return 1;
                }
            "#,
            "function-pure-for-init.ts",
        ));
        assert!(
            !loop_initializer.has_errors(),
            "{:?}",
            loop_initializer.diagnostics
        );
        assert!(
            loop_initializer.code.contains("sideEffect()"),
            "{}",
            loop_initializer.code
        );
    }

    #[test]
    fn keeps_impure_and_coercive_operations_inside_pure_functions() {
        let coercion = compile(request(
            r#"
                export function probe(value) {
                    "use pure";
                    const stringValue = String(value);
                    const numericValue = +value;
                    const binaryValue = value + 1;
                    const objectCall = read({ value: 1 });
                    const repeatedObjectCall = read({ value: 1 });
                    const spacedString = read("a b");
                    const compactString = read("ab");
                    return [objectCall, repeatedObjectCall, spacedString, compactString];
                }
            "#,
            "function-pure-coercion.ts",
        ));
        assert!(!coercion.has_errors(), "{:?}", coercion.diagnostics);
        for preserved in ["String(value)", "+value", "value + 1"] {
            assert!(
                coercion.code.contains(preserved),
                "{preserved}: {}",
                coercion.code
            );
        }
        assert_eq!(
            coercion.code.matches("read({").count(),
            2,
            "{}",
            coercion.code
        );
        assert!(coercion.code.contains("read(\"a b\")"), "{}", coercion.code);
        assert!(coercion.code.contains("read(\"ab\")"), "{}", coercion.code);

        let effect = compile(request(
            r#"
                import { createEffect } from "@fictjs/runtime";
                export function probe() {
                    "use pure";
                    const unused = createEffect(() => 1);
                    return 1;
                }
            "#,
            "function-pure-effect.ts",
        ));
        assert!(!effect.has_errors(), "{:?}", effect.diagnostics);
        assert!(
            effect.code.contains("createEffect(() => 1)"),
            "{}",
            effect.code
        );

        let memo = compile(request(
            r#"
                import { $memo } from "fict";
                export function probe() {
                    "use pure";
                    const unused = $memo(() => 1);
                    return 1;
                }
            "#,
            "function-pure-memo.ts",
        ));
        assert!(!memo.has_errors(), "{:?}", memo.diagnostics);
        assert!(!memo.code.contains("__fictUseMemo"), "{}", memo.code);
        assert!(!memo.code.contains("__fictUseContext"), "{}", memo.code);
        assert!(!memo.code.contains("fict/internal"), "{}", memo.code);
    }

    #[test]
    fn controls_single_use_derived_memo_inlining() {
        let source = "import { $state } from 'fict'; export function Counter() { let count = $state(2); const doubled = count * 2; return doubled; }";

        let mut enabled_request = request(source, "inline-derived.ts");
        enabled_request.options.explain = true;
        let enabled = compile(enabled_request);
        assert!(!enabled.has_errors(), "{:?}", enabled.diagnostics);
        assert!(
            enabled.code.contains("return count() * 2"),
            "{}",
            enabled.code
        );
        assert!(!enabled.code.contains("__fictUseMemo"), "{}", enabled.code);
        assert!(
            !enabled
                .explain
                .as_ref()
                .expect("inline explanation")
                .helpers
                .iter()
                .any(|helper| helper == "memo"),
            "{:?}",
            enabled.explain
        );

        let mut disabled_request = request(source, "inline-derived.ts");
        disabled_request.options.inline_derived_memos = false;
        let disabled = compile(disabled_request);
        assert!(!disabled.has_errors(), "{:?}", disabled.diagnostics);
        assert!(
            disabled.code.contains("const doubled = __fictUseMemo"),
            "{}",
            disabled.code
        );
        assert!(
            disabled.code.contains("return doubled()"),
            "{}",
            disabled.code
        );

        let generated_source = source.replace("doubled", "__doubled");
        let mut generated_request = request(&generated_source, "inline-generated.ts");
        generated_request.options.inline_derived_memos = false;
        let generated = compile(generated_request);
        assert!(!generated.has_errors(), "{:?}", generated.diagnostics);
        assert!(
            generated.code.contains("return count() * 2"),
            "{}",
            generated.code
        );
        assert!(
            !generated.code.contains("__fictUseMemo"),
            "{}",
            generated.code
        );

        let mut unoptimized_request = request(source, "inline-unoptimized.ts");
        unoptimized_request.options.optimize = false;
        let unoptimized = compile(unoptimized_request);
        assert!(!unoptimized.has_errors(), "{:?}", unoptimized.diagnostics);
        assert!(
            unoptimized.code.contains("const doubled = __fictUseMemo"),
            "{}",
            unoptimized.code
        );

        let hook = compile(request(
            "import { $state } from 'fict'; export function useCounter() { let count = $state(2); const doubled = count * 2; return doubled; }",
            "inline-hook.ts",
        ));
        assert!(!hook.has_errors(), "{:?}", hook.diagnostics);
        assert!(
            hook.code.contains("const doubled = __fictUseMemo"),
            "{}",
            hook.code
        );

        let generated_hook = compile(request(
            "import { $state } from 'fict'; export function useCounter() { let count = $state(2); const __doubled = count * 2; return __doubled; }",
            "inline-generated-hook.ts",
        ));
        assert!(
            !generated_hook.has_errors(),
            "{:?}",
            generated_hook.diagnostics
        );
        assert!(
            generated_hook
                .code
                .contains("const __doubled = __fictUseMemo"),
            "{}",
            generated_hook.code
        );
        let nested = compile(request(
            "import { $state } from 'fict'; export function Counter() { let count = $state(2); const doubled = count * 2; return () => doubled; }",
            "inline-nested.ts",
        ));
        assert!(!nested.has_errors(), "{:?}", nested.diagnostics);
        assert!(
            nested.code.contains("const doubled = __fictUseMemo"),
            "{}",
            nested.code
        );
    }

    #[test]
    fn preserves_derived_snapshots_before_eager_barriers() {
        let mut input = request(
            r#"
                import { $state } from "fict";
                export function Scenario() {
                    const utils = { renderHook: callback => callback() };
                    return utils.renderHook(() => {
                        const count = $state(1);
                        const before = count();
                        count(3);
                        return [before + 0, count() + 0];
                    });
                }
            "#,
            "derived-barrier.tsx",
        );
        input.options.strict_guarantee = false;
        input.options.reactive_scopes = vec!["renderHook".into()];
        let result = compile(input);
        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result.code.contains("const before = count();"),
            "{}",
            result.code
        );
        assert!(result.code.contains("count(3);"), "{}", result.code);
        assert!(
            result.code.contains("return [before + 0, count() + 0]"),
            "{}",
            result.code
        );
        assert!(
            !result.code.contains("const before = __fictUseMemo"),
            "{}",
            result.code
        );
    }

    #[test]
    fn runs_module_effects_through_hir_emit_ir_and_oxc_codegen() {
        let mut input = request(
            "import { $effect, batch } from 'fict'; $effect(() => batch(() => 1)); export { batch };",
            "effect.js",
        );
        input.options.explain = true;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(!result.code.contains("$effect"));
        assert!(result.code.contains("createEffect"));
        assert!(result.code.contains("fict/internal"));
        assert!(result.code.contains("import { batch } from \"fict\""));
        assert!(result.stats.is_some());
        let explain = result.explain.expect("native explanation");
        assert_eq!(explain.helpers, ["effect"]);
        assert!(explain.events.iter().any(|event| {
            event.kind == CompilerExplainEventKind::RuntimeHelper
                && event.name.as_deref() == Some("effect")
        }));
    }

    #[test]
    fn runs_module_memos_and_reads_through_native_codegen() {
        let mut input = request(
            "import { $memo as memo, batch } from 'fict'; const doubled = memo(() => 2); export const result = doubled + doubled; export { batch };",
            "memo.js",
        );
        input.options.explain = true;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(!result.code.contains("$memo"));
        assert!(result.code.contains("createMemo"));
        assert!(result.code.contains("result = doubled() + doubled()"));
        assert!(result.code.contains("import { batch } from \"fict\""));
        assert_eq!(
            result.explain.expect("native explanation").helpers,
            ["memo"]
        );
    }

    #[test]
    fn explains_source_decisions_from_native_hir_in_source_order() {
        let code = r#"
            import { $effect, $memo, $state } from 'fict';
            export function Counter() {
                const count = $state(0);
                const doubled = $memo(() => count * 2);
                $effect(() => { doubled; });
                if (count) {
                    return <button>{doubled}</button>;
                }
                return <span>zero</span>;
            }
        "#;
        let mut input = request(code, "explain-source.tsx");
        input.options.explain = true;
        input.options.strict_guarantee = false;

        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        let explain = result.explain.expect("native explanation");
        let source_events: Vec<_> = explain
            .events
            .iter()
            .filter(|event| {
                !matches!(
                    event.kind,
                    CompilerExplainEventKind::RuntimeHelper | CompilerExplainEventKind::Diagnostic
                )
            })
            .collect();
        for (kind, name) in [
            (CompilerExplainEventKind::SourceSignal, "$state"),
            (CompilerExplainEventKind::SourceMemo, "$memo"),
            (CompilerExplainEventKind::SourceEffect, "$effect"),
            (CompilerExplainEventKind::SourceControlFlow, "if"),
        ] {
            assert!(
                source_events
                    .iter()
                    .any(|event| event.kind == kind && event.name.as_deref() == Some(name)),
                "missing {kind:?} {name}: {source_events:?}"
            );
        }
        assert!(
            source_events
                .iter()
                .any(|event| event.kind == CompilerExplainEventKind::SourceJsx),
            "missing JSX explanation: {source_events:?}"
        );
        assert!(source_events.iter().all(|event| event.span.is_some()));
        assert!(source_events.windows(2).all(|events| {
            events[0].span.expect("source event span").start()
                <= events[1].span.expect("source event span").start()
        }));
    }

    #[test]
    fn explains_binding_resolved_runtime_memo_creators() {
        let code = r#"
            import { createMemo } from 'fict';
            import { createMemo as memo } from '@fictjs/runtime';
            import * as F from 'fict';
            import * as Runtime from '@fictjs/runtime';
            export function App() {
                const direct = createMemo(() => 1);
                const optional = createMemo?.(() => 2);
                const alias = memo?.(() => 3);
                const namespace = F.createMemo?.(() => 4);
                const computed = Runtime['createMemo']?.(() => 5);
                return <div>{direct}{optional}{alias}{namespace}{computed}</div>;
            }
        "#;
        let mut input = request(code, "explain-runtime-memo.tsx");
        input.options.explain = true;
        input.options.strict_guarantee = false;

        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        let explain = result.explain.expect("native explanation");
        let memo_events: Vec<_> = explain
            .events
            .iter()
            .filter(|event| event.kind == CompilerExplainEventKind::SourceMemo)
            .collect();
        assert_eq!(memo_events.len(), 5, "{memo_events:?}");
        assert!(
            memo_events.iter().all(|event| {
                event.name.as_deref() == Some("createMemo") && event.span.is_some()
            })
        );
        assert!(memo_events.windows(2).all(|events| {
            events[0].span.expect("memo span").start() < events[1].span.expect("memo span").start()
        }));
    }

    #[test]
    fn generates_binding_aware_local_reactive_metadata() {
        let result = compile(request(
            r#"
                import { $memo, $store } from 'fict';
                import { createMemo } from '@fictjs/runtime';
                import { createSignal } from 'fict/advanced';
                const count = createSignal(0);
                export const doubled = $memo(() => count * 2);
                export const runtimeDoubled = createMemo(() => count() * 3);
                export const state = $store({ count: 0 });
                export const alias = count;
                export { count as "__proto__" };
                export default count;
            "#,
            "local-metadata.ts",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result.module_metadata.exports,
            BTreeMap::from([
                ("__proto__".into(), ReactiveExportKind::Signal),
                ("alias".into(), ReactiveExportKind::Memo),
                ("default".into(), ReactiveExportKind::Signal),
                ("doubled".into(), ReactiveExportKind::Memo),
                ("runtimeDoubled".into(), ReactiveExportKind::Memo),
                ("state".into(), ReactiveExportKind::Store),
            ])
        );

        let direct = compile(request(
            "import { createSignal } from 'fict/advanced'; export default createSignal(1);",
            "default-metadata.ts",
        ));
        assert!(!direct.has_errors(), "{:?}", direct.diagnostics);
        assert_eq!(
            direct.module_metadata.exports.get("default"),
            Some(&ReactiveExportKind::Signal)
        );
    }

    #[test]
    fn generates_inferred_and_annotated_hook_return_metadata() {
        let result = compile(request(
            r#"
                import { $memo, $state } from 'fict';
                export function useCounter() {
                    const count = $state(0);
                    const doubled = $memo(() => count * 2);
                    return { count, doubled };
                }
                export function useSingle() {
                    const count = $state(0);
                    return { count };
                }
                /** @fictReturn [0: store, 2: 'signal'] */
                function useAnnotated(input) { return input; }
                export { useAnnotated as "__proto__" };
            "#,
            "hook-metadata.ts",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result.module_metadata.hooks.get("useCounter"),
            Some(&HookReturnInfo {
                object_props: BTreeMap::from([
                    ("count".into(), ReactiveExportKind::Signal),
                    ("doubled".into(), ReactiveExportKind::Memo),
                ]),
                ..HookReturnInfo::default()
            })
        );
        assert_eq!(
            result.module_metadata.hooks.get("__proto__"),
            Some(&HookReturnInfo {
                array_props: BTreeMap::from([
                    ("0".into(), ReactiveExportKind::Store),
                    ("2".into(), ReactiveExportKind::Signal),
                ]),
                ..HookReturnInfo::default()
            })
        );
        assert_eq!(
            result.module_metadata.hooks.get("useSingle"),
            Some(&HookReturnInfo {
                object_props: BTreeMap::from([("count".into(), ReactiveExportKind::Signal,)]),
                ..HookReturnInfo::default()
            })
        );
    }

    #[test]
    fn preserves_accessor_identity_in_published_hook_returns() {
        let result = compile(request(
            r#"
                import { $state } from 'fict';
                export function useDirect() {
                    const count = $state(0);
                    return count;
                }
                export function useObject(flag) {
                    const count = $state(0);
                    const alternate = $state(1);
                    return {
                        direct: count,
                        nested: [alternate],
                        conditional: flag ? count : alternate,
                        value: count + 1,
                    };
                }
                export function useArray() {
                    const count = $state(0);
                    return [count];
                }
                export function useDerived() {
                    const count = $state(0);
                    return count + 1;
                }
            "#,
            "hook-return-accessors.ts",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result.module_metadata.hooks.get("useDirect"),
            Some(&HookReturnInfo {
                direct_accessor: Some(ReactiveExportKind::Signal),
                ..HookReturnInfo::default()
            })
        );
        assert_eq!(
            result.module_metadata.hooks.get("useObject"),
            Some(&HookReturnInfo {
                object_props: BTreeMap::from([
                    ("conditional".into(), ReactiveExportKind::Signal),
                    ("direct".into(), ReactiveExportKind::Signal),
                ]),
                ..HookReturnInfo::default()
            })
        );
        assert_eq!(
            result.module_metadata.hooks.get("useArray"),
            Some(&HookReturnInfo {
                array_props: BTreeMap::from([("0".into(), ReactiveExportKind::Signal)]),
                ..HookReturnInfo::default()
            })
        );
        assert!(!result.module_metadata.hooks.contains_key("useDerived"));

        assert!(result.code.contains("return count;"), "{}", result.code);
        assert!(result.code.contains("direct: count"), "{}", result.code);
        assert!(
            result.code.contains("nested: [alternate]"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("flag ? count : alternate"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("value: count() + 1"),
            "{}",
            result.code
        );
        assert!(result.code.contains("return [count];"), "{}", result.code);
        assert!(
            result.code.contains("return count() + 1;"),
            "{}",
            result.code
        );
    }

    #[test]
    fn preserves_accessor_identity_through_const_asserted_hook_returns() {
        let result = compile(request(
            r#"
                import { $state } from 'fict';
                export function useFunctionTuple() {
                    const count = $state(0);
                    const set = () => { count = 1; };
                    return [count, set] as const;
                }
                export const useArrowTuple = () => {
                    const count = $state(0);
                    const set = () => { count = 1; };
                    return [count, set] as const;
                };
            "#,
            "const-asserted-hook-returns.ts",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        let expected = HookReturnInfo {
            array_props: BTreeMap::from([("0".into(), ReactiveExportKind::Signal)]),
            ..HookReturnInfo::default()
        };
        assert_eq!(
            result.module_metadata.hooks.get("useFunctionTuple"),
            Some(&expected)
        );
        assert_eq!(
            result.module_metadata.hooks.get("useArrowTuple"),
            Some(&expected)
        );
        assert_eq!(
            result.code.matches("return [count, set];").count(),
            2,
            "{}",
            result.code
        );
        assert!(!result.code.contains("return [count(),"), "{}", result.code);
    }

    #[test]
    fn propagates_resolved_reexports_and_namespace_metadata() {
        let mut input = request(
            r#"
                export { count as renamed, default as dependencyDefault } from './dep';
                export * as dependencyNamespace from './dep';
                export * from './dep';
            "#,
            "barrel.ts",
        );
        input.metadata.push(ResolvedMetadataInput {
            request: "./dep".into(),
            resolved_id: Some("/src/dep.ts?client".into()),
            status: MetadataResolutionStatus::Resolved,
            metadata: Some(ModuleReactiveMetadata {
                exports: BTreeMap::from([
                    ("count".into(), ReactiveExportKind::Signal),
                    ("default".into(), ReactiveExportKind::Store),
                ]),
                hooks: BTreeMap::from([(
                    "useCount".into(),
                    HookReturnInfo {
                        direct_accessor: Some(ReactiveExportKind::Signal),
                        ..HookReturnInfo::default()
                    },
                )]),
                ..ModuleReactiveMetadata::new()
            }),
            fingerprint: "sha256:dep".into(),
        });

        let result = compile(input);
        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result.module_metadata.exports,
            BTreeMap::from([
                ("count".into(), ReactiveExportKind::Signal),
                ("dependencyDefault".into(), ReactiveExportKind::Store),
                ("renamed".into(), ReactiveExportKind::Signal),
            ])
        );
        assert!(result.module_metadata.hooks.contains_key("useCount"));
        assert_eq!(
            result
                .module_metadata
                .namespaces
                .get("dependencyNamespace")
                .and_then(|metadata| metadata.exports.get("count")),
            Some(&ReactiveExportKind::Signal)
        );
        assert_eq!(result.metadata_dependencies, ["/src/dep.ts?client"]);
        assert!(result.unresolved_metadata_requests.is_empty());
    }

    #[test]
    fn consumes_resolved_metadata_for_direct_import_reads() {
        let mut input = request(
            r#"
                import primary, { count as localCount, doubled, state, plain } from './dep?client';
                import { count as differentRequest } from './dep';
                export function App() {
                    return [primary, localCount, doubled, state.value, plain, differentRequest];
                }
            "#,
            "consumer.jsx",
        );
        input.metadata.push(ResolvedMetadataInput {
            request: "./dep?client".into(),
            resolved_id: Some("/src/dep.ts?client".into()),
            status: MetadataResolutionStatus::Resolved,
            metadata: Some(ModuleReactiveMetadata {
                exports: BTreeMap::from([
                    ("default".into(), ReactiveExportKind::Signal),
                    ("count".into(), ReactiveExportKind::Signal),
                    ("doubled".into(), ReactiveExportKind::Memo),
                    ("state".into(), ReactiveExportKind::Store),
                ]),
                ..ModuleReactiveMetadata::new()
            }),
            fingerprint: "sha256:dep-client".into(),
        });

        let result = compile(input);
        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.code.contains("primary()"), "{}", result.code);
        assert!(result.code.contains("localCount()"), "{}", result.code);
        assert!(result.code.contains("doubled()"), "{}", result.code);
        assert!(result.code.contains("state.value"), "{}", result.code);
        assert!(!result.code.contains("state().value"), "{}", result.code);
        assert!(result.code.contains("plain,"), "{}", result.code);
        assert!(result.code.contains("differentRequest"), "{}", result.code);
        assert!(
            !result.code.contains("differentRequest()"),
            "{}",
            result.code
        );
        assert_eq!(result.metadata_dependencies, ["/src/dep.ts?client"]);
        assert!(result.unresolved_metadata_requests.is_empty());
    }

    #[test]
    fn consumes_direct_accessor_metadata_from_imported_hooks() {
        let mut input = request(
            r#"
                import { useCount, useDouble, useStore, useUnknown } from './hooks?client';
                import { useCount as differentRequest } from './hooks';
                export function App() {
                    const count = useCount();
                    const doubled = useDouble();
                    const state = useStore();
                    const unknown = useUnknown();
                    const explicit = count();
                    const inline = useCount() + 1;
                    const called = useCount()();
                    let writable = useCount();
                    writable = 2;
                    const reader = () => count;
                    const ordinary = differentRequest();
                    return [count, doubled, state.value, unknown, explicit, inline, called, writable, reader, ordinary];
                }
            "#,
            "hook-consumer.jsx",
        );
        let snapshot = || ResolvedMetadataInput {
            request: "./hooks?client".into(),
            resolved_id: Some("/src/hooks.ts?client".into()),
            status: MetadataResolutionStatus::Resolved,
            metadata: Some(ModuleReactiveMetadata {
                hooks: BTreeMap::from([
                    (
                        "useCount".into(),
                        HookReturnInfo {
                            direct_accessor: Some(ReactiveExportKind::Signal),
                            ..HookReturnInfo::default()
                        },
                    ),
                    (
                        "useDouble".into(),
                        HookReturnInfo {
                            direct_accessor: Some(ReactiveExportKind::Memo),
                            ..HookReturnInfo::default()
                        },
                    ),
                    (
                        "useStore".into(),
                        HookReturnInfo {
                            direct_accessor: Some(ReactiveExportKind::Store),
                            ..HookReturnInfo::default()
                        },
                    ),
                ]),
                ..ModuleReactiveMetadata::new()
            }),
            fingerprint: "sha256:hooks-client".into(),
        };
        input.metadata.push(snapshot());

        let result = compile(input);
        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result.code.contains("const count = useCount()"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("const doubled = useDouble()"),
            "{}",
            result.code
        );
        assert!(result.code.contains("count()"), "{}", result.code);
        assert!(result.code.contains("doubled()"), "{}", result.code);
        assert!(result.code.contains("state.value"), "{}", result.code);
        assert!(!result.code.contains("state().value"), "{}", result.code);
        assert!(result.code.contains("unknown"), "{}", result.code);
        assert!(result.code.contains("useCount()() + 1"), "{}", result.code);
        assert!(result.code.contains("useCount()()"), "{}", result.code);
        assert!(!result.code.contains("useCount()()()"), "{}", result.code);
        assert!(
            result.code.contains("writable(__fict_value)"),
            "{}",
            result.code
        );
        assert!(result.code.contains("writable()"), "{}", result.code);
        assert!(result.code.contains("() => count()"), "{}", result.code);
        assert!(
            result.code.contains("const ordinary = differentRequest()"),
            "{}",
            result.code
        );
        assert!(
            !result.code.contains("differentRequest()()"),
            "{}",
            result.code
        );
        assert_eq!(result.metadata_dependencies, ["/src/hooks.ts?client"]);

        let mut readonly = request(
            "import { useDouble } from './hooks?client'; export function App() { let value = useDouble(); value = 2; return value; }",
            "readonly-hook.jsx",
        );
        readonly.metadata.push(snapshot());
        let readonly = compile(readonly);
        assert!(readonly.has_errors());
        assert!(readonly.code.is_empty());
        assert!(readonly.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-METADATA-READONLY"
                && diagnostic.message.contains("returned by a hook")
        }));
    }

    #[test]
    fn consumes_callable_and_member_metadata_from_import_equals() {
        let mut input = request(
            r#"
                import hook = require('./hook');
                export function App() {
                    const direct = hook();
                    const member = hook.useCounter();
                    return direct + member;
                }
            "#,
            "import-equals.cts",
        );
        input.metadata.push(ResolvedMetadataInput {
            request: "./hook".into(),
            resolved_id: Some("/src/hook.cts".into()),
            status: MetadataResolutionStatus::Resolved,
            metadata: Some(ModuleReactiveMetadata {
                hooks: BTreeMap::from([
                    (
                        "default".into(),
                        HookReturnInfo {
                            direct_accessor: Some(ReactiveExportKind::Signal),
                            ..HookReturnInfo::default()
                        },
                    ),
                    (
                        "useCounter".into(),
                        HookReturnInfo {
                            direct_accessor: Some(ReactiveExportKind::Signal),
                            ..HookReturnInfo::default()
                        },
                    ),
                ]),
                ..ModuleReactiveMetadata::new()
            }),
            fingerprint: "sha256:import-equals".into(),
        });

        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result.code.contains("direct() + member()"),
            "{}",
            result.code
        );
        assert!(!result.code.contains("hook()()"), "{}", result.code);
        assert!(
            !result.code.contains("hook.useCounter()()"),
            "{}",
            result.code
        );
    }

    #[test]
    fn fails_closed_for_a_hook_call_with_authoritatively_missing_metadata() {
        let mut input = request(
            "import { useCounter } from 'package'; export function App() { const count = useCounter(); return count * 2; }",
            "missing-hook.ts",
        );
        input.metadata.push(ResolvedMetadataInput {
            request: "package".into(),
            resolved_id: None,
            status: MetadataResolutionStatus::Missing,
            metadata: None,
            fingerprint: "sha256:missing-hook".into(),
        });

        let result = compile(input);

        assert!(result.has_errors());
        assert!(result.code.is_empty());
        assert!(result.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-H003"
                && diagnostic.severity == DiagnosticSeverity::Error
        }));
    }

    #[test]
    fn fails_closed_for_static_hook_aliases_with_authoritatively_missing_metadata() {
        let sources = [
            "import { foo } from './barrel'; const useCount = foo; export function App() { return useCount() * 2; }",
            "import { foo } from './barrel'; const hooks = { useCount: foo }; export function App() { return hooks.useCount() * 2; }",
        ];
        for source in sources {
            let mut input = request(source, "missing-hook-alias.ts");
            input.metadata.push(ResolvedMetadataInput {
                request: "./barrel".into(),
                resolved_id: None,
                status: MetadataResolutionStatus::Missing,
                metadata: None,
                fingerprint: "missing:barrel".into(),
            });

            let result = compile(input);

            assert!(result.has_errors(), "{source}: {:?}", result.diagnostics);
            assert!(result.code.is_empty(), "{source}: {}", result.code);
            assert!(result.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-H003"
                    && diagnostic.severity == DiagnosticSeverity::Error
            }));
        }
    }

    #[test]
    fn warns_for_a_static_hook_alias_when_strict_guarantees_are_disabled() {
        let mut input = request(
            "import { foo } from './barrel'; const useCount = foo; export function App() { return useCount() * 2; }",
            "missing-hook-alias-fallback.ts",
        );
        input.options.strict_guarantee = false;
        input.metadata.push(ResolvedMetadataInput {
            request: "./barrel".into(),
            resolved_id: None,
            status: MetadataResolutionStatus::Missing,
            metadata: None,
            fingerprint: "missing:barrel".into(),
        });

        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(!result.code.is_empty());
        assert!(result.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-H003"
                && diagnostic.severity == DiagnosticSeverity::Warning
        }));
    }

    #[test]
    fn consumes_known_hook_facts_from_incomplete_cycle_metadata() {
        let mut input = request(
            "import { useCounter } from './hooks'; export function App() { const count = useCounter(); return <span>{count}</span>; }",
            "partial-hook.tsx",
        );
        input.metadata.push(ResolvedMetadataInput {
            request: "./hooks".into(),
            resolved_id: Some("/src/hooks.ts".into()),
            status: MetadataResolutionStatus::IncompleteCycle,
            metadata: Some(ModuleReactiveMetadata {
                hooks: BTreeMap::from([(
                    "useCounter".into(),
                    HookReturnInfo {
                        direct_accessor: Some(ReactiveExportKind::Signal),
                        ..HookReturnInfo::default()
                    },
                )]),
                ..ModuleReactiveMetadata::new()
            }),
            fingerprint: "sha256:partial-hook".into(),
        });

        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.metadata_incomplete);
        assert_eq!(result.unresolved_metadata_requests, ["./hooks"]);
        assert!(
            result
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code.as_str() != "FICT-H003"),
            "{:?}",
            result.diagnostics
        );
        assert!(result.code.contains("() => count()"), "{}", result.code);
    }

    #[test]
    fn re_exports_known_facts_from_incomplete_cycle_metadata() {
        let mut input = request(
            "export { useCounter } from './hooks';",
            "partial-re-export.ts",
        );
        input.metadata.push(ResolvedMetadataInput {
            request: "./hooks".into(),
            resolved_id: Some("/src/hooks.ts".into()),
            status: MetadataResolutionStatus::IncompleteCycle,
            metadata: Some(ModuleReactiveMetadata {
                hooks: BTreeMap::from([(
                    "useCounter".into(),
                    HookReturnInfo {
                        direct_accessor: Some(ReactiveExportKind::Signal),
                        ..HookReturnInfo::default()
                    },
                )]),
                ..ModuleReactiveMetadata::new()
            }),
            fingerprint: "sha256:partial-re-export".into(),
        });

        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.metadata_incomplete);
        assert_eq!(result.unresolved_metadata_requests, ["./hooks"]);
        assert_eq!(
            result
                .module_metadata
                .hooks
                .get("useCounter")
                .and_then(|hook| hook.direct_accessor),
            Some(ReactiveExportKind::Signal)
        );
    }

    #[test]
    fn publishes_hook_metadata_from_typescript_export_assignment() {
        let result = compile(request(
            "import { $state } from 'fict'; function useCounter() { const count = $state(2); return count; } export = useCounter;",
            "hook.cts",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result
                .module_metadata
                .hooks
                .get("default")
                .and_then(|hook| hook.direct_accessor),
            Some(ReactiveExportKind::Signal)
        );
    }

    #[test]
    fn treats_an_opaque_star_re_export_as_authoritatively_empty() {
        let mut input = request(
            "import { $state } from 'fict'; export function useCounter() { const count = $state(2); return count; } export * from 'ordinary-package';",
            "hook.ts",
        );
        input.metadata.push(ResolvedMetadataInput {
            request: "ordinary-package".into(),
            resolved_id: Some("package:ordinary-package".into()),
            status: MetadataResolutionStatus::Opaque,
            metadata: None,
            fingerprint: "sha256:opaque-star".into(),
        });

        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(!result.metadata_incomplete);
        assert!(result.unresolved_metadata_requests.is_empty());
        assert_eq!(result.metadata_dependencies, ["package:ordinary-package"]);
        assert!(result.module_metadata.hooks.contains_key("useCounter"));
    }

    #[test]
    fn preserves_an_imported_accessor_forwarded_from_a_hook() {
        let mut input = request(
            "import { useCounter as usePackageCounter } from './hooks'; export function useCounter() { return usePackageCounter(); }",
            "forwarded-hook.ts",
        );
        input.metadata.push(ResolvedMetadataInput {
            request: "./hooks".into(),
            resolved_id: Some("/src/hooks.ts".into()),
            status: MetadataResolutionStatus::Resolved,
            metadata: Some(ModuleReactiveMetadata {
                hooks: BTreeMap::from([(
                    "useCounter".into(),
                    HookReturnInfo {
                        direct_accessor: Some(ReactiveExportKind::Signal),
                        ..HookReturnInfo::default()
                    },
                )]),
                ..ModuleReactiveMetadata::new()
            }),
            fingerprint: "sha256:forwarded-hook".into(),
        });

        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result.code.contains("return usePackageCounter()"),
            "{}",
            result.code
        );
        assert!(
            !result.code.contains("usePackageCounter()()"),
            "{}",
            result.code
        );
        assert_eq!(
            result
                .module_metadata
                .hooks
                .get("useCounter")
                .and_then(|hook| hook.direct_accessor),
            Some(ReactiveExportKind::Signal)
        );
    }

    #[test]
    fn consumes_structured_member_metadata_from_imported_hooks() {
        let snapshot = || ResolvedMetadataInput {
            request: "./hooks?client".into(),
            resolved_id: Some("/src/hooks.ts?client".into()),
            status: MetadataResolutionStatus::Resolved,
            metadata: Some(ModuleReactiveMetadata {
                hooks: BTreeMap::from([
                    (
                        "useCounter".into(),
                        HookReturnInfo {
                            object_props: BTreeMap::from([
                                ("count".into(), ReactiveExportKind::Signal),
                                ("doubled".into(), ReactiveExportKind::Memo),
                            ]),
                            ..HookReturnInfo::default()
                        },
                    ),
                    (
                        "usePair".into(),
                        HookReturnInfo {
                            array_props: BTreeMap::from([
                                ("0".into(), ReactiveExportKind::Signal),
                                ("1".into(), ReactiveExportKind::Memo),
                            ]),
                            ..HookReturnInfo::default()
                        },
                    ),
                    (
                        "useStore".into(),
                        HookReturnInfo {
                            object_props: BTreeMap::from([(
                                "state".into(),
                                ReactiveExportKind::Store,
                            )]),
                            ..HookReturnInfo::default()
                        },
                    ),
                ]),
                ..ModuleReactiveMetadata::new()
            }),
            fingerprint: "sha256:structured-hooks-client".into(),
        };
        let mut input = request(
            r#"
                import { useCounter, usePair, useStore } from './hooks?client';
                export function App(key) {
                    const api = useCounter();
                    const pair = usePair();
                    const storeApi = useStore();
                    let reassigned = useCounter();
                    reassigned = { count: 1 };
                    const explicit = api.count();
                    const derived = api.count === 1;
                    const reader = () => api.count;
                    const tupleReader = () => pair[0];
                    const storeReader = () => storeApi.state.value;
                    const suffixReader = () => api.count.value;
                    const optionalReader = () => api?.count;
                    const explicitReader = () => api.count();
                    const reassignedReader = () => reassigned.count;
                    return [
                        api.count,
                        api["doubled"],
                        pair[0],
                        pair["1"],
                        storeApi.state.value,
                        api[key],
                        useCounter().count,
                        useCounter()["doubled"],
                        api?.count,
                        useCounter()?.count,
                        explicit,
                        derived,
                        reader,
                        tupleReader,
                        storeReader,
                        suffixReader,
                        optionalReader,
                        explicitReader,
                        reassignedReader,
                        reassigned.count,
                    ];
                }
            "#,
            "structured-hook-consumer.jsx",
        );
        input.metadata.push(snapshot());

        let result = compile(input);
        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.code.contains("api.count()"), "{}", result.code);
        assert!(
            result.code.contains("api[\"doubled\"]()"),
            "{}",
            result.code
        );
        assert!(result.code.contains("pair[0]()"), "{}", result.code);
        assert!(result.code.contains("pair[\"1\"]()"), "{}", result.code);
        assert!(
            result.code.contains("storeApi.state.value"),
            "{}",
            result.code
        );
        assert!(!result.code.contains("storeApi.state()"), "{}", result.code);
        assert!(result.code.contains("api[key]"), "{}", result.code);
        assert!(
            result.code.contains("useCounter().count()"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("useCounter()[\"doubled\"]()"),
            "{}",
            result.code
        );
        assert!(!result.code.contains("api.count()()"), "{}", result.code);
        assert!(result.code.contains("() => api.count()"), "{}", result.code);
        assert!(result.code.contains("() => pair[0]()"), "{}", result.code);
        assert!(
            result.code.contains("() => storeApi.state.value"),
            "{}",
            result.code
        );
        assert!(
            !result.code.contains("() => storeApi.state()"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("() => api.count().value"),
            "{}",
            result.code
        );
        assert!(result.code.matches("?.()").count() >= 3, "{}", result.code);
        assert!(
            result.code.contains("() => reassigned.count"),
            "{}",
            result.code
        );
        assert!(
            !result.code.contains("() => reassigned.count()"),
            "{}",
            result.code
        );
        assert!(result.code.contains("reassigned.count"), "{}", result.code);
        assert!(
            !result.code.contains("reassigned.count()"),
            "{}",
            result.code
        );
        assert_eq!(result.metadata_dependencies, ["/src/hooks.ts?client"]);

        let mut signal_write = request(
            "import { useCounter } from './hooks?client'; export function App() { const api = useCounter(); api.count = 2; return api.count; }",
            "structured-hook-signal-write.jsx",
        );
        signal_write.metadata.push(snapshot());
        let signal_write = compile(signal_write);
        assert!(signal_write.has_errors());
        assert!(signal_write.code.is_empty());
        assert!(signal_write.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-M"
                && diagnostic.message.contains("hook return accessor")
        }));

        let mut memo_write = request(
            "import { useCounter } from './hooks?client'; export function App() { const api = useCounter(); api.doubled = 2; return api.doubled; }",
            "structured-hook-memo-write.jsx",
        );
        memo_write.metadata.push(snapshot());
        let memo_write = compile(memo_write);
        assert!(memo_write.has_errors());
        assert!(memo_write.code.is_empty());
        assert!(memo_write.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-METADATA-READONLY"
                && diagnostic.message.contains("returned by a hook")
        }));

        let mut store_write = request(
            "import { useStore } from './hooks?client'; export function App() { const api = useStore(); api.state.value = 2; return api.state.value; }",
            "structured-hook-store-write.jsx",
        );
        store_write.metadata.push(snapshot());
        let store_write = compile(store_write);
        assert!(!store_write.has_errors(), "{:?}", store_write.diagnostics);
        assert!(
            store_write.code.contains("api.state.value = 2"),
            "{}",
            store_write.code
        );

        let mut captured_write = request(
            "import { useCounter } from './hooks?client'; export function App() { const api = useCounter(); const write = () => { api.count = 2; }; return write; }",
            "captured-structured-hook-write.jsx",
        );
        captured_write.metadata.push(snapshot());
        let captured_write = compile(captured_write);
        assert!(captured_write.has_errors());
        assert!(captured_write.code.is_empty());
        assert!(captured_write.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-M"
                && diagnostic.message.contains("hook return accessor")
        }));
    }

    #[test]
    fn consumes_recursive_namespace_hook_metadata() {
        let mut input = request(
            r#"
                import * as hooks from './hooks?client';
                import { group as named } from './hooks?client';
                import * as wrongRequest from './hooks';
                export function App(key) {
                    const count = hooks.useCount();
                    const api = hooks.useCounter();
                    const pair = named.deep.usePair();
                    const reader = () => api.count;
                    const explicit = hooks.useCount()();
                    const dynamic = hooks[key]();
                    const ordinary = wrongRequest.useCount();
                    return [
                        count,
                        api.count,
                        pair[0],
                        hooks.useCounter().count,
                        reader,
                        explicit,
                        dynamic,
                        ordinary,
                    ];
                }
            "#,
            "namespace-hook-consumer.jsx",
        );
        input.metadata.push(ResolvedMetadataInput {
            request: "./hooks?client".into(),
            resolved_id: Some("/src/hooks.ts?client".into()),
            status: MetadataResolutionStatus::Resolved,
            metadata: Some(ModuleReactiveMetadata {
                hooks: BTreeMap::from([
                    (
                        "useCount".into(),
                        HookReturnInfo {
                            direct_accessor: Some(ReactiveExportKind::Signal),
                            ..HookReturnInfo::default()
                        },
                    ),
                    (
                        "useCounter".into(),
                        HookReturnInfo {
                            object_props: BTreeMap::from([(
                                "count".into(),
                                ReactiveExportKind::Signal,
                            )]),
                            ..HookReturnInfo::default()
                        },
                    ),
                ]),
                namespaces: BTreeMap::from([(
                    "group".into(),
                    ModuleReactiveMetadata {
                        namespaces: BTreeMap::from([(
                            "deep".into(),
                            ModuleReactiveMetadata {
                                hooks: BTreeMap::from([(
                                    "usePair".into(),
                                    HookReturnInfo {
                                        array_props: BTreeMap::from([(
                                            "0".into(),
                                            ReactiveExportKind::Memo,
                                        )]),
                                        ..HookReturnInfo::default()
                                    },
                                )]),
                                ..ModuleReactiveMetadata::new()
                            },
                        )]),
                        ..ModuleReactiveMetadata::new()
                    },
                )]),
                ..ModuleReactiveMetadata::new()
            }),
            fingerprint: "sha256:namespace-hooks-client".into(),
        });

        let result = compile(input);
        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.code.contains("count()"), "{}", result.code);
        assert!(result.code.contains("api.count()"), "{}", result.code);
        assert!(result.code.contains("pair[0]()"), "{}", result.code);
        assert!(
            result.code.contains("hooks.useCounter().count()"),
            "{}",
            result.code
        );
        assert!(result.code.contains("() => api.count()"), "{}", result.code);
        assert!(
            result.code.contains("hooks.useCount()()"),
            "{}",
            result.code
        );
        assert!(
            !result.code.contains("hooks.useCount()()()"),
            "{}",
            result.code
        );
        assert!(result.code.contains("hooks[key]()"), "{}", result.code);
        assert!(
            result.code.contains("wrongRequest.useCount()"),
            "{}",
            result.code
        );
        assert!(
            !result.code.contains("wrongRequest.useCount()()"),
            "{}",
            result.code
        );
        assert_eq!(result.metadata_dependencies, ["/src/hooks.ts?client"]);
    }

    #[test]
    fn consumes_recursive_namespace_metadata_for_static_member_reads() {
        let mut input = request(
            r#"
                import * as dep from './dep?client';
                import { group as named } from './dep?client';
                export function App(key) {
                    const called = dep.count();
                    const derived = dep.state.value * 2;
                    return [
                        dep.count,
                        dep["doubled"],
                        dep.group.inner,
                        named.deep.value,
                        dep.group.deep.value.extra,
                        dep.state.value,
                        dep.plain,
                        dep[key],
                        called,
                        derived,
                    ];
                }
            "#,
            "namespace-consumer.jsx",
        );
        input.metadata.push(ResolvedMetadataInput {
            request: "./dep?client".into(),
            resolved_id: Some("/src/dep.ts?client".into()),
            status: MetadataResolutionStatus::Resolved,
            metadata: Some(ModuleReactiveMetadata {
                exports: BTreeMap::from([
                    ("count".into(), ReactiveExportKind::Signal),
                    ("doubled".into(), ReactiveExportKind::Memo),
                    ("state".into(), ReactiveExportKind::Store),
                ]),
                namespaces: BTreeMap::from([(
                    "group".into(),
                    ModuleReactiveMetadata {
                        exports: BTreeMap::from([("inner".into(), ReactiveExportKind::Memo)]),
                        namespaces: BTreeMap::from([(
                            "deep".into(),
                            ModuleReactiveMetadata {
                                exports: BTreeMap::from([(
                                    "value".into(),
                                    ReactiveExportKind::Signal,
                                )]),
                                ..ModuleReactiveMetadata::new()
                            },
                        )]),
                        ..ModuleReactiveMetadata::new()
                    },
                )]),
                ..ModuleReactiveMetadata::new()
            }),
            fingerprint: "sha256:dep-client".into(),
        });

        let result = compile(input);
        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.code.contains("dep.count()"), "{}", result.code);
        assert!(
            result.code.contains("dep[\"doubled\"]()"),
            "{}",
            result.code
        );
        assert!(result.code.contains("dep.group.inner()"), "{}", result.code);
        assert!(
            result.code.contains("named.deep.value()"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("dep.group.deep.value().extra"),
            "{}",
            result.code
        );
        assert!(result.code.contains("dep.state.value"), "{}", result.code);
        assert!(result.code.contains("dep.plain"), "{}", result.code);
        assert!(result.code.contains("dep[key]"), "{}", result.code);
        assert!(!result.code.contains("dep.count()()"), "{}", result.code);
        assert_eq!(result.metadata_dependencies, ["/src/dep.ts?client"]);
    }

    #[test]
    fn enforces_namespace_reactive_member_write_and_delete_policy() {
        let snapshot = || ResolvedMetadataInput {
            request: "./dep".into(),
            resolved_id: Some("/src/dep.ts".into()),
            status: MetadataResolutionStatus::Resolved,
            metadata: Some(ModuleReactiveMetadata {
                exports: BTreeMap::from([
                    ("count".into(), ReactiveExportKind::Signal),
                    ("total".into(), ReactiveExportKind::Memo),
                    ("state".into(), ReactiveExportKind::Store),
                ]),
                ..ModuleReactiveMetadata::new()
            }),
            fingerprint: "sha256:dep".into(),
        };

        let source = r#"
            import * as dep from './dep';
            export function App() {
                dep.count = 2;
                dep.count++;
                const removed = delete dep.count;
                dep.state.value = 3;
                dep.total.value = 4;
                const removedMemo = delete dep.total.value;
                const removedStore = delete dep.state.value;
                return [dep.count, dep.state.value, removed, removedMemo, removedStore];
            }
        "#;
        let mut fallback = request(source, "namespace-write-fallback.js");
        fallback.options.strict_guarantee = false;
        fallback.metadata = vec![snapshot()];
        let fallback = compile(fallback);
        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert!(fallback.code.contains("dep.count = 2"), "{}", fallback.code);
        assert!(fallback.code.contains("dep.count++"), "{}", fallback.code);
        assert!(
            fallback.code.contains("delete dep.count"),
            "{}",
            fallback.code
        );
        assert!(fallback.code.contains("dep.count()"), "{}", fallback.code);
        assert!(
            fallback.code.contains("dep.state.value = 3"),
            "{}",
            fallback.code
        );
        assert!(
            fallback.code.contains("dep.total.value = 4"),
            "{}",
            fallback.code
        );
        assert!(
            fallback.code.contains("delete dep.total.value"),
            "{}",
            fallback.code
        );
        assert!(
            fallback.code.contains("delete dep.state.value"),
            "{}",
            fallback.code
        );
        assert_eq!(
            fallback
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-M")
                .count(),
            5
        );

        let mut strict = request(source, "namespace-write-strict.js");
        strict.metadata = vec![snapshot()];
        let strict = compile(strict);
        assert!(strict.has_errors());
        assert!(strict.code.is_empty());

        for (target, kind) in [("dep.total = 1", "memo"), ("[dep.state] = []", "store")] {
            let mut readonly = request(
                &format!(
                    "import * as dep from './dep'; export function App() {{ {target}; return 1; }}"
                ),
                "namespace-readonly.js",
            );
            readonly.options.strict_guarantee = false;
            readonly.metadata = vec![snapshot()];
            let readonly = compile(readonly);
            assert!(readonly.has_errors());
            assert!(readonly.code.is_empty());
            assert!(readonly.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-METADATA-READONLY"
                    && diagnostic
                        .message
                        .contains(&format!("imported {kind} binding"))
            }));
        }
    }

    #[test]
    fn permits_imported_signal_writes_and_rejects_imported_memo_store_writes() {
        let metadata = |name: &str, kind: ReactiveExportKind| ResolvedMetadataInput {
            request: "./dep".into(),
            resolved_id: Some("/src/dep.ts".into()),
            status: MetadataResolutionStatus::Resolved,
            metadata: Some(ModuleReactiveMetadata {
                exports: BTreeMap::from([(name.into(), kind)]),
                ..ModuleReactiveMetadata::new()
            }),
            fingerprint: format!("sha256:{name}"),
        };

        let mut signal = request(
            "import { count } from './dep'; export function App() { count++; count = 2; return count; }",
            "signal-write.js",
        );
        signal.metadata = vec![metadata("count", ReactiveExportKind::Signal)];
        let signal = compile(signal);
        assert!(!signal.has_errors(), "{:?}", signal.diagnostics);
        assert!(
            signal.code.contains("count(__fict_value)"),
            "{}",
            signal.code
        );
        assert!(!signal.code.contains("count++"), "{}", signal.code);
        assert!(signal.code.contains("return count()"), "{}", signal.code);

        let mut memo = request(
            "import { total } from './dep'; export function App() { total += 1; return total; }",
            "memo-write.js",
        );
        memo.metadata = vec![metadata("total", ReactiveExportKind::Memo)];
        let memo = compile(memo);
        assert!(memo.has_errors());
        assert!(memo.code.is_empty());
        assert!(memo.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-METADATA-READONLY"
                && diagnostic
                    .message
                    .contains("imported memo binding \"total\"")
        }));

        let mut store = request(
            "import { state } from './dep'; export function App() { [state] = []; return state; }",
            "store-write.js",
        );
        store.metadata = vec![metadata("state", ReactiveExportKind::Store)];
        let store = compile(store);
        assert!(store.has_errors());
        assert!(store.code.is_empty());
        assert!(store.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-METADATA-READONLY"
                && diagnostic
                    .message
                    .contains("imported store binding \"state\"")
        }));
    }

    #[test]
    fn removes_ambiguous_star_exports_and_reports_missing_snapshots() {
        let metadata = |request: &str, resolved_id: &str, names: &[(&str, ReactiveExportKind)]| {
            ResolvedMetadataInput {
                request: request.into(),
                resolved_id: Some(resolved_id.into()),
                status: MetadataResolutionStatus::Resolved,
                metadata: Some(ModuleReactiveMetadata {
                    exports: names
                        .iter()
                        .map(|(name, kind)| ((*name).into(), *kind))
                        .collect(),
                    ..ModuleReactiveMetadata::new()
                }),
                fingerprint: format!("sha256:{request}"),
            }
        };
        let mut input = request(
            "export * from './a'; export * from './b'; export { keep } from './a'; export * from './not-scanned';",
            "ambiguous-barrel.ts",
        );
        input.metadata = vec![
            metadata(
                "./a",
                "/src/a.ts",
                &[
                    ("shared", ReactiveExportKind::Signal),
                    ("keep", ReactiveExportKind::Memo),
                    ("onlyA", ReactiveExportKind::Store),
                ],
            ),
            metadata(
                "./b",
                "/src/b.ts",
                &[
                    ("shared", ReactiveExportKind::Memo),
                    ("onlyB", ReactiveExportKind::Signal),
                ],
            ),
        ];

        let result = compile(input);
        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result.module_metadata.exports,
            BTreeMap::from([
                ("keep".into(), ReactiveExportKind::Memo),
                ("onlyA".into(), ReactiveExportKind::Store),
                ("onlyB".into(), ReactiveExportKind::Signal),
            ])
        );
        assert_eq!(result.metadata_dependencies, ["/src/a.ts", "/src/b.ts"]);
        assert_eq!(result.unresolved_metadata_requests, ["./not-scanned"]);
    }

    #[test]
    fn runs_scoped_state_context_reads_writes_and_static_fine_grained_jsx() {
        let state = compile(request(
            "import { $state } from 'fict'; function Component() { const __fictCtx = 'user'; let count = $state(0); const assigned = (count = 2); const before = count++; return [__fictCtx, count, assigned, before]; }",
            "state.js",
        ));
        assert!(!state.has_errors(), "{:?}", state.diagnostics);
        assert!(!state.code.contains("$state"));
        assert!(
            state
                .code
                .contains("const __fictCtx_1 = __fictUseContext()")
        );
        assert!(state.code.contains("name: \"count\""), "{}", state.code);
        assert!(state.code.contains("count(__fict_value)"));
        assert!(state.code.contains("count(__fict_previous + 1)"));
        assert!(state.code.contains("count(),"), "{}", state.code);

        let var_state = compile(request(
            "import { $state } from 'fict'; function Component() { var count = $state(0); return count; }",
            "var-state.js",
        ));
        assert!(!var_state.has_errors(), "{:?}", var_state.diagnostics);
        assert!(!var_state.code.contains("$state"));
        assert!(
            var_state.code.contains("var count = __fictUseSignal("),
            "{}",
            var_state.code
        );
        assert!(
            var_state.code.contains("return count()"),
            "{}",
            var_state.code
        );

        let pattern_default = compile(request(
            "import { $state } from 'fict'; function Component(input) { let count = $state(1); const { value = count, view = <span>{count}</span> } = input; return [value, view]; }",
            "pattern-default.tsx",
        ));
        assert!(
            !pattern_default.has_errors(),
            "{:?}",
            pattern_default.diagnostics
        );
        assert!(
            pattern_default.code.contains("value = count()"),
            "{}",
            pattern_default.code
        );
        assert!(
            !pattern_default.code.contains("view = <span>")
                && pattern_default
                    .code
                    .contains("view = __fictElementNamespaceMatches"),
            "{}",
            pattern_default.code
        );

        let jsx = compile(request(
            "export function Component() { return <button>Save</button>; }",
            "component.jsx",
        ));
        assert!(!jsx.has_errors(), "{:?}", jsx.diagnostics);
        assert!(jsx.code.contains("import { template }"), "{}", jsx.code);
        assert!(
            jsx.code.contains("template(\"<button>Save</button>\")"),
            "{}",
            jsx.code
        );
        assert!(
            jsx.code.contains("return __fictElementNamespaceMatches"),
            "{}",
            jsx.code
        );

        let dynamic = compile(request(
            "export function Component(value) { return <button>{value}</button>; }",
            "dynamic.jsx",
        ));
        assert!(!dynamic.has_errors(), "{:?}", dynamic.diagnostics);
        assert!(dynamic.code.contains("resolvePath("), "{}", dynamic.code);
        assert!(
            dynamic.code.contains("insert(")
                && dynamic.code.contains("() => value")
                && dynamic.code.contains("__fict_node1"),
            "{}",
            dynamic.code
        );
    }

    #[test]
    fn hoists_collision_free_static_svg_mathml_and_fragment_templates() {
        let result = compile(request(
            "const __fict_tmpl0 = 'user'; export function Icon() { return <svg><path d=\"M0 0\" /></svg>; } export function Formula() { return <math><mi>x</mi></math>; } export function Pair() { return <><i>a</i><i>b</i></>; }",
            "static-roots.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result
                .code
                .contains("const __fict_tmpl0_1 = template(\"<svg><path d=\\\"M0 0\\\"></path></svg>\", void 0, true)"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("template(\"<math><mi>x</mi></math>\", void 0, void 0, true)"),
            "{}",
            result.code
        );
        let fragment = "template(\"<i>a</i><i>b</i>\", void 0, void 0, void 0, true)";
        assert!(result.code.contains(fragment), "{}", result.code);
        assert!(!result.code.contains("return <"), "{}", result.code);
    }

    #[test]
    fn emits_nested_fine_grained_dom_attribute_and_property_bindings() {
        let result = compile(request(
            "export function View(props) { return <main><input value={props.value} checked={props.checked} /><p class={props.className} style={props.style} title={props.title}>text</p></main>; }",
            "bindings.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.code.contains("resolvePath("), "{}", result.code);
        assert!(
            result.code.contains("bindProperty(") && result.code.contains("\"value\""),
            "{}",
            result.code
        );
        assert!(result.code.contains("bindClass("), "{}", result.code);
        assert!(result.code.contains("bindStyle("), "{}", result.code);
        assert!(result.code.contains("bindAttribute("), "{}", result.code);
        assert!(result.code.contains("() => props.title"), "{}", result.code);
        assert!(!result.code.contains("return <"), "{}", result.code);
    }

    #[test]
    fn preserves_reactive_reads_inside_fine_grained_dom_bindings() {
        let result = compile(request(
            "import { $state } from 'fict'; export function View() { let count = $state(0); return <div title={count}><span class={count}>value</span></div>; }",
            "reactive-binding.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result.code.matches("() => count()").count() >= 2,
            "{}",
            result.code
        );
        assert!(result.code.contains("bindAttribute("), "{}", result.code);
        assert!(result.code.contains("bindClass("), "{}", result.code);
    }

    #[test]
    fn materializes_authored_jsx_awaits_before_synchronous_dom_getters() {
        let forms = [
            ("attribute", "<div title={await getTitle()}>x</div>"),
            ("spread", "<div {...await getProps()}>x</div>"),
            ("child", "<div>{await getValue()}</div>"),
            (
                "conditional-test",
                "<div>{(await getFlag()) ? 'yes' : 'no'}</div>",
            ),
            (
                "conditional-branch",
                "<div>{flag ? await getYes() : await getNo()}</div>",
            ),
            ("logical-child", "<div>{flag && await getValue()}</div>"),
            ("ref", "<div ref={await getRef()}>x</div>"),
        ];
        for (form, jsx) in forms {
            for context in ["module", "async-function"] {
                for fine_grained_dom in [true, false] {
                    for module_kind in [ModuleKind::Module, ModuleKind::Unambiguous] {
                        let source = if context == "module" {
                            format!("export const node = {jsx};")
                        } else {
                            format!("export async function renderNode() {{ return {jsx}; }}")
                        };
                        let mut input = request(
                            &source,
                            &format!("jsx-await-{form}-{context}-{fine_grained_dom}.tsx"),
                        );
                        input.module_kind = Some(module_kind);
                        input.options.fine_grained_dom = fine_grained_dom;
                        input.options.strict_guarantee = false;
                        let result = compile(input);

                        assert!(
                            !result.has_errors(),
                            "{form}/{context}/{fine_grained_dom}: {:?}",
                            result.diagnostics
                        );
                        assert!(
                            result
                                .diagnostics
                                .iter()
                                .all(|diagnostic| diagnostic.code.as_str()
                                    != "FICT-OXC-EMIT-REPARSE"),
                            "{form}/{context}/{fine_grained_dom}: {:?}",
                            result.diagnostics
                        );
                        assert!(
                            !result.code.contains("() => await"),
                            "{form}/{context}/{fine_grained_dom}: {}",
                            result.code
                        );
                        if fine_grained_dom && form != "ref" {
                            assert!(
                                result.code.contains("const __fict_await_"),
                                "{form}/{context}: {}",
                                result.code
                            );
                            assert!(
                                result.code.contains("await (async () =>"),
                                "{form}/{context}: {}",
                                result.code
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn allocates_collision_free_jsx_await_snapshot_names() {
        let mut authored_name = "__fict_await_0".to_owned();
        let source = loop {
            let source = format!(
                "const {authored_name} = 'authored'; export async function renderNode() {{ return <div title={{await getTitle()}}>x</div>; }}"
            );
            let offset = source.find("await getTitle()").expect("await expression");
            let next = format!("__fict_await_{offset}");
            if next == authored_name {
                break source;
            }
            authored_name = next;
        };
        let mut input = request(&source, "jsx-await-name-collision.tsx");
        input.options.strict_guarantee = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result
                .code
                .contains(&format!("const {authored_name} = \"authored\"")),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains(&format!("const {authored_name}_1 = await getTitle()")),
            "{}",
            result.code
        );
    }

    #[test]
    fn resolves_adjacent_dynamic_child_markers_before_insertion() {
        let result = compile(request(
            "export function View(props) { return <div>{props.first}{props.second}<span>{props.third}</span></div>; }",
            "children.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        let last_resolve = result
            .code
            .rfind("resolvePath(")
            .expect("marker resolution");
        let first_insert = result.code.find("insert(").expect("child insertion");
        assert!(last_resolve < first_insert, "{}", result.code);
        assert_eq!(result.code.matches("insert(").count(), 3, "{}", result.code);
        assert!(
            result.code.contains("() => props.first")
                && result.code.contains("() => props.second")
                && result.code.contains("() => props.third"),
            "{}",
            result.code
        );
        assert!(result.code.contains(", createElement)"), "{}", result.code);
    }

    #[test]
    fn preserves_reactive_reads_inside_dynamic_children() {
        let result = compile(request(
            "import { $state } from 'fict'; export function Counter() { let count = $state(0); return <p>Count: {count}</p>; }",
            "reactive-child.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.code.contains("insert("), "{}", result.code);
        assert!(result.code.contains("() => count()"), "{}", result.code);
    }

    #[test]
    fn supplies_namespace_aware_creators_to_dynamic_children() {
        let result = compile(request(
            "export function Foreign(props) { return <svg>{props.icon}</svg>; } export function Formula(props) { return <math>{props.node}</math>; } export function Annotation(props) { return <math><annotation-xml encoding={props.encoding}>{props.node}</annotation-xml></math>; }",
            "foreign-children.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result
                .code
                .contains("createElementInNamespace(__fict_child, \"svg\")"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("createElementInNamespace(__fict_child, \"mathml\")"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("createElementInParentNamespace(__fict_child"),
            "{}",
            result.code
        );
    }

    #[test]
    fn preserves_authored_fine_grained_spread_and_static_prop_order() {
        let mut input = request(
            "export function View(first, second) { return <div id=\"before\" {...first} class=\"after\" {...second}>child</div>; }",
            "spread-order.tsx",
        );
        input.options.strict_guarantee = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-J003")
                .count(),
            1
        );
        assert!(
            result
                .code
                .contains("template(\"<div id=\\\"before\\\">child</div>\")"),
            "{}",
            result.code
        );
        let first_spread = result.code.find("() => first").expect("first spread");
        let explicit_class = result.code.find("setClass(").expect("explicit class");
        let second_spread = result.code.find("() => second").expect("second spread");
        assert!(
            first_spread < explicit_class && explicit_class < second_spread,
            "{}",
            result.code
        );
        assert_eq!(result.code.matches("spread(").count(), 2, "{}", result.code);
        assert!(
            result
                .code
                .contains(", false, true, [\"class\", \"className\"])"),
            "{}",
            result.code
        );
    }

    #[test]
    fn restores_legacy_dom_binding_targets_and_forced_prefixes() {
        let result = compile(request(
            r#"
                export function Bindings() {
                    return <main>
                        <div dangerouslySetInnerHTML={{ __html: "<b>safe</b>" }} />
                        <textarea defaultValue="seed" />
                        <input defaultChecked indeterminate={true} />
                        <option defaultSelected>choice</option>
                        <audio defaultMuted muted={1} />
                        <select multiple={0}><option>one</option></select>
                        <div innerText="label" classList={{ active: true }} />
                        <div attr:title="forced" bool:data-active={true} prop:textContent="forced text" />
                        <my-widget config={{ ready: true }} some-prop="custom" />
                        <button is="fancy-button" custom-prop="value" />
                    </main>;
                }
            "#,
            "dom-binding-targets.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        for attribute in [
            "dangerouslySetInnerHTML",
            "defaultValue",
            "defaultChecked",
            "defaultSelected",
            "defaultMuted",
            "indeterminate",
            "innerText",
            "multiple",
            "muted",
            "classList",
            "attr:title",
            "bool:data-active",
            "prop:textContent",
            "config",
            "some-prop",
            "custom-prop",
        ] {
            assert!(
                !result.code.contains(&format!("{attribute}=\\\"")),
                "{}",
                result.code
            );
        }
        assert!(
            result.code.contains("\"dangerouslySetInnerHTML\""),
            "{}",
            result.code
        );
        for property in [
            "defaultValue",
            "defaultChecked",
            "defaultSelected",
            "defaultMuted",
            "indeterminate",
            "innerText",
            "multiple",
            "muted",
            "textContent",
            "config",
            "someProp",
            "customProp",
        ] {
            assert!(
                result.code.contains(&format!("\"{property}\"")),
                "{}",
                result.code
            );
        }
        assert!(result.code.contains("bindClass("), "{}", result.code);
        assert!(result.code.contains("setAttr("), "{}", result.code);
        assert!(
            result.code.contains("bindBooleanAttribute("),
            "{}",
            result.code
        );
    }

    #[test]
    fn rejects_dangerously_set_inner_html_with_authored_children() {
        let result = compile(request(
            "export function Invalid() { return <div dangerouslySetInnerHTML={{ __html: '<b>x</b>' }}>child</div>; }",
            "dangerous-html-children.tsx",
        ));

        assert!(result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.code.as_str() == "FICT-J004" }),
            "{:?}",
            result.diagnostics
        );
        assert!(result.code.is_empty());
    }

    #[test]
    fn rejects_jsx_spread_children_at_the_source_boundary() {
        for (name, source) in [
            (
                "intrinsic",
                "export function App(items) { return <div>{...items}</div>; }",
            ),
            (
                "component",
                "function Child() { return null; } export function App(items) { return <Child>{...items}</Child>; }",
            ),
            (
                "fragment",
                "export function App(items) { return <>{...items}</>; }",
            ),
        ] {
            let result = compile(request(source, &format!("jsx-spread-child-{name}.tsx")));
            assert!(result.has_errors(), "{name}: {:?}", result.diagnostics);
            assert!(result.code.is_empty(), "{name}: {}", result.code);
            let diagnostics: Vec<_> = result
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-J005")
                .collect();
            assert_eq!(diagnostics.len(), 1, "{name}: {:?}", result.diagnostics);
            assert_eq!(
                diagnostics[0].message, "JSX spread children are not supported",
                "{name}"
            );
        }
    }

    #[test]
    fn rejects_indirect_compiler_macro_calls_before_import_erasure() {
        for (name, source) in [
            (
                "state-direct-import",
                "import { $state } from 'fict'; export function App() { const value = (0, $state)(1); return value; }",
            ),
            (
                "state-aliased-import",
                "import { $state as state } from 'fict'; export function App() { const value = (0, state)(1); return value; }",
            ),
            (
                "effect-direct-import",
                "import { $effect } from 'fict'; export function App() { (0, $effect)(() => {}); return null; }",
            ),
            (
                "effect-aliased-import",
                "import { $effect as effect } from 'fict'; export function App() { (0, effect)(() => {}); return null; }",
            ),
        ] {
            let result = compile(request(source, &format!("indirect-macro-{name}.tsx")));
            assert!(result.has_errors(), "{name}: {:?}", result.diagnostics);
            assert!(result.code.is_empty(), "{name}: {}", result.code);
            assert!(
                result.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code.as_str() == "FICT-HIR-MACRO-VALUE"
                        && diagnostic.severity == DiagnosticSeverity::Error
                }),
                "{name}: {:?}",
                result.diagnostics
            );
        }

        let direct = compile(request(
            "import { $state, $effect } from 'fict'; export function App() { const value = ($state)(1); ($effect)(() => value); return value; }",
            "parenthesized-direct-macros.tsx",
        ));
        assert!(!direct.has_errors(), "{:?}", direct.diagnostics);
        assert!(direct.code.contains("__fictUseSignal"), "{}", direct.code);
        assert!(direct.code.contains("__fictUseEffect"), "{}", direct.code);

        for (name, import, callee) in [
            ("named", "$memo", "$memo"),
            ("aliased", "$memo as memo", "memo"),
        ] {
            let source = format!(
                "import {{ $state, {import} }} from 'fict'; export function App() {{ const count = $state(1); const doubled = (0, {callee})(() => count * 2); return <span>{{doubled}}</span>; }}"
            );
            let result = compile(request(&source, &format!("sequence-memo-{name}.tsx")));
            assert!(!result.has_errors(), "{name}: {:?}", result.diagnostics);
            assert!(
                result.code.contains("const doubled = (0, ") && result.code.contains("doubled()"),
                "{name}: {}",
                result.code
            );
        }
    }

    #[test]
    fn excludes_forced_and_custom_property_targets_from_earlier_spreads() {
        let mut input = request(
            "export function Widget(first) { return <my-widget {...first} some-prop=\"custom\" prop:textContent=\"text\" bool:data-on />; }",
            "custom-spread-exclusions.tsx",
        );
        input.options.strict_guarantee = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-J003")
                .count(),
            1
        );
        let spread_start = result.code.find("spread(").expect("spread call");
        let spread_end = result.code[spread_start..]
            .find("]);")
            .map(|offset| spread_start + offset + 2)
            .expect("spread exclusion array");
        let spread_call = &result.code[spread_start..spread_end];
        for exclusion in [
            "bool:data-on",
            "bool:dataOn",
            "data-on",
            "prop:textContent",
            "prop:textcontent",
            "some-prop",
            "someProp",
            "textContent",
        ] {
            assert!(
                spread_call.contains(&format!("\"{exclusion}\"")),
                "{spread_call}"
            );
        }
    }

    #[test]
    fn passes_svg_and_mathml_modes_to_fine_grained_spreads() {
        let mut input = request(
            "export function Foreign(svgProps, mathProps) { return <><svg {...svgProps} /><math {...mathProps} /></>; }",
            "spread-namespace.tsx",
        );
        input.options.strict_guarantee = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-J003")
                .count(),
            2
        );
        assert!(
            result.code.contains("() => svgProps, true, false"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("() => mathProps, \"mathml\", false"),
            "{}",
            result.code
        );
    }

    #[test]
    fn emits_delegated_events_refs_and_reactive_handler_mutations() {
        let result = compile(request(
            "import { $state } from 'fict'; let seen; export function Button(handler) { let count = $state(0); return <button onClick={() => count++} onInput={handler} ref={(node) => { seen = node; }}>Save</button>; }",
            "events.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result.code.matches("addEventListener(").count(),
            2,
            "{}",
            result.code
        );
        assert!(
            result.code.contains("\"click\"") && result.code.contains("\"input\""),
            "{}",
            result.code
        );
        assert!(result.code.contains(", handler, true)"), "{}", result.code);
        assert!(
            result.code.contains("count(__fict_previous + 1)"),
            "{}",
            result.code
        );
        assert!(result.code.contains("bindRef("), "{}", result.code);
        assert!(result.code.contains("seen = node"), "{}", result.code);
    }

    #[test]
    fn registers_non_delegated_event_cleanup_with_the_render_owner() {
        let result = compile(request(
            "export function Scroller(handler) { return <div onScroll={handler}>content</div>; }",
            "event-cleanup.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result.code.contains("onDestroy(bindEvent("),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("\"scroll\", handler"),
            "{}",
            result.code
        );
        assert!(!result.code.contains("delegateEvents("), "{}", result.code);
    }

    #[test]
    fn discards_inline_event_returns_without_capturing_handler_identifiers() {
        let result = compile(request(
            "const __fictArgs = () => 42; export function Events() { return <button onClick={() => __fictArgs} onInput={function () { return __fictArgs; }}>run</button>; }",
            "event-returns.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result.code.matches("...__fictArgs_1").count() >= 2,
            "{}",
            result.code
        );
        assert!(
            result.code.contains("(() => __fictArgs)(...__fictArgs_1)"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains(".apply(this, __fictArgs_1)"),
            "{}",
            result.code
        );
    }

    #[test]
    fn emits_flat_component_jsx_with_ordered_props_children_and_key() {
        let result = compile(request(
            "const Card = (_props) => null; const UI = { Card }; export function App(props) { return <Card title={props.title} fixed=\"x\" disabled {...props.extra} middle=\"m\" {...props.tail} last=\"z\" key={props.id}>hello {props.child}</Card>; } export function Member(props) { return <UI.Card value={props.value} />; }",
            "flat-component.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(!result.code.contains("<Card"), "{}", result.code);
        assert!(result.code.contains("type: Card"), "{}", result.code);
        assert!(result.code.contains("type: UI.Card"), "{}", result.code);
        assert!(
            result.code.contains("title: __fictProp(() => props.title)"),
            "{}",
            result.code
        );
        assert!(result.code.contains("fixed: \"x\""), "{}", result.code);
        assert!(result.code.contains("disabled: true"), "{}", result.code);
        assert!(
            result.code.contains("props: mergeProps("),
            "{}",
            result.code
        );
        let title = result.code.find("title:").expect("named prop segment");
        let first_spread = result
            .code
            .find("props.extra")
            .expect("first spread prop segment");
        let middle = result.code.find("middle:").expect("middle prop segment");
        let second_spread = result
            .code
            .find("props.tail")
            .expect("second spread prop segment");
        let last = result.code.find("last:").expect("last prop segment");
        let children = result
            .code
            .find("children:")
            .expect("children prop segment");
        assert!(
            title < first_spread
                && first_spread < middle
                && middle < second_spread
                && second_spread < last
                && last < children,
            "{}",
            result.code
        );
        assert!(
            result.code.contains("children: prop(() => [\"hello "),
            "{}",
            result.code
        );
        assert!(result.code.contains("key: props.id"), "{}", result.code);
        assert!(!result.code.contains("key: __fictProp"), "{}", result.code);
    }

    #[test]
    fn snapshots_non_reactive_component_spreads_before_merging() {
        let result = compile(request(
            "function Child(_props) { return null; } export function App() { const props = Object.create(null); props.value = 1; return <Child {...props} />; }",
            "static-component-spread.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result.code.contains("props: mergeProps({ ...props })"),
            "{}",
            result.code
        );
    }

    #[test]
    fn emits_reactive_component_prop_getters() {
        let mut input = request(
            "import { $state } from 'fict'; const Card = (_props) => null; const handler = makeHandler(); export function App() { let count = $state(0); return <Card value={count} onSelect={handler} />; } export function Router(props) { const owns = !props.history; const history = props.history || makeHistory(); if (owns) history.destroy?.(); return <Card history={history} />; }",
            "reactive-component.tsx",
        );
        input.options.strict_guarantee = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        for snippet in [
            "import { __fictProp",
            "value: __fictProp(() => count())",
            "onSelect: handler",
            "history: __fictProp(() => history())",
        ] {
            assert!(result.code.contains(snippet), "{}", result.code);
        }
        assert!(!result.code.contains("() => handler"), "{}", result.code);
    }

    #[test]
    fn recursively_emits_component_props_children_and_fragments() {
        let result = compile(request(
            "const Shell = (_props) => null; const Item = (_props) => null; export function App(props) { return <Shell header={<Item value={props.header} />}><section><Item value={props.body} /></section><><Item value={props.footer} /></></Shell>; }",
            "recursive-component.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(!result.code.contains("<Shell"), "{}", result.code);
        assert_eq!(
            result.code.matches("type: Item").count(),
            3,
            "{}",
            result.code
        );
        assert!(result.code.contains("type: \"section\""), "{}", result.code);
        assert!(
            result.code.contains("import { Fragment }"),
            "{}",
            result.code
        );
        assert!(result.code.contains("type: Fragment"), "{}", result.code);
        assert!(
            result
                .code
                .contains("value: __fictProp(() => props.footer)"),
            "{}",
            result.code
        );
    }

    #[test]
    fn inserts_nested_components_into_fine_grained_dom_templates() {
        let result = compile(request(
            "const Card = (_props) => null; export function App(props) { return <main><Card value={props.first} /><section>{(<Card value={props.second} />)}</section></main>; }",
            "dom-component-children.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result
                .code
                .contains("template(\"<main><!----><section><!----></section></main>\")"),
            "{}",
            result.code
        );
        assert_eq!(result.code.matches("insert(").count(), 2, "{}", result.code);
        assert_eq!(
            result.code.matches("type: Card").count(),
            4,
            "{}",
            result.code
        );
        assert!(
            result.code.contains("value: __fictProp(() => props.first)")
                && result
                    .code
                    .contains("value: __fictProp(() => props.second)"),
            "{}",
            result.code
        );
    }

    #[test]
    fn materializes_binding_aware_keyed_list_calls() {
        let mut input = request(
            "import { createKeyedList as list } from 'fict/internal/list'; export function App(items) { return list(() => items, (item) => item.id, (item) => <span>{item.name}</span>); }",
            "keyed-list.tsx",
        );
        input.options.strict_guarantee = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result.code.contains("return createKeyedList(() => items"),
            "{}",
            result.code
        );
        assert!(!result.code.contains("return list("), "{}", result.code);
        assert!(
            result.code.contains("template(\"<span><!----></span>\")"),
            "{}",
            result.code
        );
        assert!(result.code.contains("() => item.name"), "{}", result.code);
    }

    #[test]
    fn lowers_jsx_nested_in_dynamic_map_expressions() {
        let result = compile(request(
            "export function List(items) { return <ul>{items.map((item) => <li key={item.id}>{item.name}</li>)}</ul>; } export function Groups(items) { return <div>{items.map((item) => <><b>{item}</b><i /></>)}</div>; }",
            "map-fallback.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(!result.code.contains("<li"), "{}", result.code);
        assert!(!result.code.contains("<b"), "{}", result.code);
        assert_eq!(
            result.code.matches("items.map(").count(),
            4,
            "{}",
            result.code
        );
        assert!(result.code.contains("item.name"), "{}", result.code);
        assert!(result.code.contains("item.id"), "{}", result.code);
        assert!(result.code.contains("type: Fragment"), "{}", result.code);
    }

    #[test]
    fn emits_binding_aware_keyed_map_children() {
        let result = compile(request(
            "import { $state } from 'fict'; export function List() { let items = $state([{ id: 1, name: 'A' }]); return <ul>{items.map((item, index) => <li key={item.id} data-index={index}>{item.name}</li>)}</ul>; }",
            "keyed-map.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.code.contains("createKeyedList("), "{}", result.code);
        assert!(!result.code.contains("items.map("), "{}", result.code);
        assert!(result.code.contains("() => items()"), "{}", result.code);
        assert!(result.code.contains("=> item.id"), "{}", result.code);
        assert!(result.code.contains("() => index()"), "{}", result.code);
        assert!(result.code.contains("() => item().name"), "{}", result.code);
        assert!(result.code.contains(".flush?.()"), "{}", result.code);
        assert!(result.code.contains("onDestroy("), "{}", result.code);
        assert!(result.code.contains(".dispose"), "{}", result.code);
        assert!(!result.code.contains("\"key\""), "{}", result.code);
    }

    #[test]
    fn evaluates_keyed_map_keys_once_and_preserves_shadowing() {
        let result = compile(request(
            "import { $state } from 'fict'; export function List() { let items = $state([{ id: 1, name: 'A' }]); return <ul>{items.map(item => <li key={makeKey(item)}>{item.name}{(() => { const item = { name: 'shadow' }; return item.name; })()}</li>)}</ul>; }",
            "keyed-map-effects.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.code.contains("createKeyedList("), "{}", result.code);
        assert_eq!(
            result.code.matches("makeKey(item)").count(),
            2,
            "{}",
            result.code
        );
        assert!(!result.code.contains("makeKey(item())"), "{}", result.code);
        assert!(result.code.contains("() => item().name"), "{}", result.code);
        assert!(result.code.contains("const item = {"), "{}", result.code);
        assert!(result.code.contains("return item.name"), "{}", result.code);
    }

    #[test]
    fn reuses_runtime_keys_for_keyed_component_maps() {
        let result = compile(request(
            "import { $state } from 'fict'; const Row = (_props) => null; const __fict_key = 'outer'; export function List() { let rows = $state([{ id: 1, name: 'A' }]); return <main>{rows.map(row => <Row key={makeKey(row)} row={row} label={__fict_key} />)}</main>; }",
            "keyed-component-map.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.code.contains("createKeyedList("), "{}", result.code);
        assert!(!result.code.contains("rows.map("), "{}", result.code);
        assert_eq!(
            result.code.matches("makeKey(row)").count(),
            2,
            "{}",
            result.code
        );
        assert!(!result.code.contains("makeKey(row())"), "{}", result.code);
        assert!(result.code.contains("type: Row"), "{}", result.code);
        assert!(result.code.contains("() => row()"), "{}", result.code);
        assert!(result.code.contains("key: __fict_key_"), "{}", result.code);
        assert!(result.code.contains("label: __fict_key"), "{}", result.code);
    }

    #[test]
    fn optimizes_single_return_block_keyed_maps_only() {
        let result = compile(request(
            "import { $state } from 'fict'; export function Direct() { let rows = $state([{ id: 1, name: 'A' }]); return <ul>{rows.map(row => { return <li key={row.id}>{row.name}</li>; })}</ul>; } export function Effectful() { let rows = $state([{ id: 2, name: 'B' }]); return <ul>{rows.map(row => { observe(row); return <li key={row.id}>{row.name}</li>; })}</ul>; }",
            "keyed-block-map.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result.code.matches("createKeyedList(").count(),
            1,
            "{}",
            result.code
        );
        assert_eq!(
            result.code.matches("rows().map(").count(),
            3,
            "{}",
            result.code
        );
        assert!(result.code.contains("observe(row)"), "{}", result.code);
        assert!(result.code.contains("() => row().name"), "{}", result.code);
    }

    #[test]
    fn constifies_single_callback_local_key_aliases() {
        let result = compile(request(
            "import { $state } from 'fict'; export function Aliased() { let rows = $state([{ id: 1, name: 'A' }]); return <ul>{rows.map(row => { const key = makeKey(row); return <li key={key}>{key}:{row.name}</li>; })}</ul>; } export function Mutable() { let rows = $state([{ id: 2 }]); return <ul>{rows.map(row => { let key = row.id; return <li key={key}>{row.id}</li>; })}</ul>; }",
            "keyed-key-alias.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result.code.matches("createKeyedList(").count(),
            1,
            "{}",
            result.code
        );
        assert_eq!(
            result.code.matches("makeKey(row)").count(),
            2,
            "{}",
            result.code
        );
        assert!(!result.code.contains("makeKey(row())"), "{}", result.code);
        assert!(
            result.code.contains("const key = __fict_key"),
            "{}",
            result.code
        );
        assert!(result.code.contains("() => row().name"), "{}", result.code);
        assert_eq!(
            result.code.matches("rows().map(").count(),
            3,
            "{}",
            result.code
        );
        assert!(result.code.contains("let key = row.id"), "{}", result.code);
    }

    #[test]
    fn emits_array_store_and_svg_keyed_map_receivers() {
        let result = compile(request(
            "import { $store } from 'fict'; export function Lists() { const store = $store({ rows: [{ id: 1 }] }); return <main><ul>{store.rows.map(row => <li key={row.id}>{row.id}</li>)}</ul><svg>{[{ id: 2 }].map(row => <circle key={row.id} cx={row.id} />)}</svg></main>; }",
            "keyed-map-receivers.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result.code.matches("createKeyedList(").count(),
            2,
            "{}",
            result.code
        );
        assert!(result.code.contains("store.rows.map("), "{}", result.code);
        assert!(result.code.contains("() => store.rows"), "{}", result.code);
        assert!(result.code.contains("\"html\""), "{}", result.code);
        assert!(result.code.contains("\"svg\""), "{}", result.code);
    }

    #[test]
    fn trusts_only_immutable_local_array_receivers() {
        let result = compile(request(
            "export function Immutable() { const rows = [{ id: 1 }]; return <ul>{rows.map(row => <li key={row.id}>{row.id}</li>)}</ul>; } export function Mutable() { let rows = [{ id: 2 }]; return <ul>{rows.map(row => <li key={row.id}>{row.id}</li>)}</ul>; }",
            "keyed-local-array.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result.code.matches("createKeyedList(").count(),
            1,
            "{}",
            result.code
        );
        assert!(
            result.code.contains("createKeyedList(() => rows"),
            "{}",
            result.code
        );
        assert_eq!(
            result.code.matches("rows.map(").count(),
            3,
            "{}",
            result.code
        );
    }

    #[test]
    fn optimizes_safe_unkeyed_maps_with_index_identity() {
        let mut input = request(
            "import { $state } from 'fict'; export function GeneratedIndex() { let rows = $state([{ name: 'A' }]); return <ul>{rows.map(row => <li>{row.name}</li>)}</ul>; } export function SourceIndex() { const rows = [{ name: 'B' }]; return <ol>{rows.map((row, index) => <li data-index={index}>{row.name}</li>)}</ol>; } export function Untrusted(rows) { return <div>{rows.map(row => <span>{row}</span>)}</div>; } export function Spread() { let rows = $state([{ name: 'C' }]); return <section>{rows.map(row => <i {...row}>{row.name}</i>)}</section>; }",
            "unkeyed-map.tsx",
        );
        input.options.strict_guarantee = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-J003")
                .count(),
            1
        );
        assert_eq!(
            result.code.matches("createKeyedList(").count(),
            2,
            "{}",
            result.code
        );
        assert!(result.code.contains("=> __fict_key"), "{}", result.code);
        assert!(
            result.code.contains("(row, index) => index"),
            "{}",
            result.code
        );
        assert!(result.code.contains("() => row().name"), "{}", result.code);
        assert!(result.code.contains("() => index()"), "{}", result.code);
        assert!(result.code.contains("rows.map((row)"), "{}", result.code);
        assert!(result.code.contains("rows().map((row)"), "{}", result.code);
    }

    #[test]
    fn optimizes_maps_over_trusted_array_method_chains() {
        let result = compile(request(
            "import { $state, $store } from 'fict'; export function StateList() { let rows = $state([{ id: 1, visible: true }]); return <ul>{rows.filter(row => row.visible).map(row => <li key={row.id}>{row.id}</li>)}</ul>; } export function LiteralList() { return <ol>{[1, 2, 3].slice(1).map((value, index) => <li>{index}:{value}</li>)}</ol>; } export function StoreList() { const store = $store({ rows: [{ id: 2 }] }); return <main>{store.rows.toReversed().map(row => <span key={row.id}>{row.id}</span>)}</main>; } export function NestedMap() { const rows = [{ id: 3 }]; return <div>{rows.map(row => ({ ...row })).map(row => <b key={row.id}>{row.id}</b>)}</div>; } export function Fallback(rows) { return <section>{rows.filter(Boolean).map(row => <i key={row.id}>{row.id}</i>)}</section>; } export function Unsupported() { let rows = $state([[{ id: 4 }]]); return <aside>{rows.flat().map(row => <u key={row.id}>{row.id}</u>)}</aside>; }",
            "array-chain-map.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result.code.matches("createKeyedList(").count(),
            4,
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("() => rows().filter((row) => row.visible)"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("].slice(1), (value, index) => index"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("() => store.rows.toReversed()"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("() => rows.map((row) => ({"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("rows.filter(Boolean).map("),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("rows().flat().map("),
            "{}",
            result.code
        );
    }

    #[test]
    fn optimizes_optional_map_members_with_nullish_array_fallbacks() {
        let result = compile(request(
            "import { $state, $store } from 'fict'; export function StateList() { let rows = $state([{ id: 1 }]); return <ul>{rows?.map(row => <li key={row.id}>{row.id}</li>)}</ul>; } export function StoreList() { const store = $store({ rows: [{ id: 2 }] }); return <main>{store.rows?.map((row, index) => <span>{index}:{row.id}</span>)}</main>; } export function OptionalCall() { let rows = $state([{ id: 3 }]); return <aside>{rows.map?.(row => <i key={row.id}>{row.id}</i>)}</aside>; }",
            "optional-map.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result.code.matches("createKeyedList(").count(),
            2,
            "{}",
            result.code
        );
        assert!(
            result.code.contains("createKeyedList(() => rows() ?? []"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("createKeyedList(() => store.rows ?? []"),
            "{}",
            result.code
        );
        assert!(result.code.contains("rows().map?.("), "{}", result.code);
    }

    #[test]
    fn optimizes_context_free_anonymous_function_map_callbacks() {
        let result = compile(request(
            "import { $state } from 'fict'; export function Keyed() { let rows = $state([{ id: 1, name: 'A' }]); return <ul>{rows.map(function (row, index) { return <li key={row.id}>{index}:{row.name}</li>; })}</ul>; } export function Unkeyed() { let rows = $state([{ name: 'B' }]); return <main>{rows.map(function (row) { return <span>{row.name}</span>; })}</main>; } export function Aliased() { let rows = $state([{ id: 2 }]); return <ol>{rows.map(function (row) { const key = row.id; return <li key={key}>{key}</li>; })}</ol>; } export function UsesThis() { let rows = $state([{ id: 3 }]); return <div>{rows.map(function (row) { return <i key={row.id}>{this.label}</i>; })}</div>; } export function UsesArguments() { let rows = $state([{ id: 4 }]); return <section>{rows.map(function (row) { return <b key={row.id}>{arguments.length}</b>; })}</section>; } export function Named() { let rows = $state([{ id: 5 }]); return <aside>{rows.map(function render(row) { return <u key={row.id}>{row.id}</u>; })}</aside>; }",
            "function-map.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result.code.matches("createKeyedList(").count(),
            3,
            "{}",
            result.code
        );
        assert!(result.code.contains("() => row().name"), "{}", result.code);
        assert!(result.code.contains("() => index()"), "{}", result.code);
        assert!(
            result.code.contains("const key = __fict_key"),
            "{}",
            result.code
        );
        assert!(result.code.contains("function(row)"), "{}", result.code);
        assert!(
            result.code.contains("function render(row)"),
            "{}",
            result.code
        );
        assert!(result.code.contains("this.label"), "{}", result.code);
        assert!(result.code.contains("arguments.length"), "{}", result.code);
    }

    #[test]
    fn optimizes_nested_keyed_lists_and_preserves_outer_item_reads() {
        let result = compile(request(
            "import { $state } from 'fict'; export function Tree() { let groups = $state([{ id: 1, items: [{ id: 2, tags: [{ id: 3, name: 'A' }] }] }]); return <main>{groups.map(group => <section key={group.id}>{group.items.map(item => <article key={item.id}>{item.tags.map((tag, index) => <i key={tag.id}>{group.id}:{item.id}:{index}:{tag.name}</i>)}</article>)}</section>)}</main>; }",
            "nested-keyed-map.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result.code.matches("createKeyedList(").count(),
            4,
            "{}",
            result.code
        );
        assert!(
            result.code.contains("createKeyedList(() => groups()"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("createKeyedList(() => group().items"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("createKeyedList(() => item().tags"),
            "{}",
            result.code
        );
        assert!(result.code.contains("() => group().id"), "{}", result.code);
        assert!(result.code.contains("() => item().id"), "{}", result.code);
        assert!(result.code.contains("() => index()"), "{}", result.code);
        assert!(result.code.contains("() => tag().name"), "{}", result.code);
    }

    #[test]
    fn lowers_simple_component_object_props_to_reactive_accessors() {
        let mut input = request(
            "import { $state } from 'fict'; function Child({ value: renamed, label = String(renamed) } = { value: 'fallback' }) { return <span>{label}:{renamed}</span>; } const Arrow = ({ value }) => <b>{value}</b>; function Method({ value }) { return <i>{value.toString()}</i>; } function Nested({ user: { name, profile: { age = 18 } } }) { return <u>{name}:{age}</u>; } function Rest({ id, ...rest }) { return <small>{id}:{rest.title}</small>; } function Callable({ onClick, value }) { const invoke = onClick; return <button onClick={() => invoke.call(null)}>{value}</button>; } export function App() { let value = $state(1); return <main><Child value={value} /><Arrow value={value} /><Method value={value} /><Nested user={{ name: 'Ada', profile: {} }} /><Rest id='row' title={String(value)} /><Callable onClick={() => value++} value={value} /></main>; }",
            "component-object-props.tsx",
        );
        input.options.strict_guarantee = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result.code.contains("function Child(__fictPropsParam)"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains(
                "const __fictProps = __fictPropsParam === void 0 ? { value: \"fallback\" } : __fictPropsParam"
            ),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("const renamed = prop(() => __fictProps.value)"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("const label = prop(() => __fictProps.label === void 0"),
            "{}",
            result.code
        );
        assert!(result.code.contains("() => renamed()"), "{}", result.code);
        assert!(result.code.contains("() => label()"), "{}", result.code);
        assert!(
            result
                .code
                .contains("__fictProps.label === void 0 ? String(renamed()) : void 0"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("__fictProps.label === void 0 ? __fictPropDefault : __fictProps.label"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("const Arrow = (__fictProps"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("const value = prop(() => __fictProps.value)"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("() => value().toString()"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("const __fictPropObject = __fictProps.user"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains(r#"Cannot destructure prop \"user\" because it is nullish"#),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("const name = prop(() => __fictProps.user.name)"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("const __fictPropObject_1 = __fictProps.user.profile"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("__fictProps.user.profile.age === void 0 ? 18 : void 0"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("const rest = __fictPropsRest(__fictProps, [\"id\"]);"),
            "{}",
            result.code
        );
        assert!(result.code.contains("() => rest.title"), "{}", result.code);
        assert!(
            result.code.contains("function Callable(__fictProps)"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("const onClick = __fictProps.onClick;"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("const value = prop(() => __fictProps.value);"),
            "{}",
            result.code
        );
        assert!(result.code.contains("invoke.call(null)"), "{}", result.code);
    }

    #[test]
    fn derives_reactively_from_destructured_component_props() {
        let result = compile(request(
            "function FunctionChild({ count }) { const functionDerived = count * 2; return <b>{functionDerived}</b>; } const ArrowChild = ({ count }) => { const arrowDerived = count * 3; return <i>{arrowDerived}</i>; }; export function App({ count }) { return <><FunctionChild count={count} /><ArrowChild count={count} /></>; }",
            "destructured-prop-derived.tsx",
        ));

        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
        assert!(
            result
                .code
                .contains("const functionDerived = __fictUseMemo(__fictCtx, () => count() * 2);"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("const arrowDerived = __fictUseMemo(__fictCtx, () => count() * 3);"),
            "{}",
            result.code
        );
        assert!(!result.code.contains("const functionDerived = count() * 2;"));
        assert!(!result.code.contains("const arrowDerived = count() * 3;"));
    }

    #[test]
    fn lowers_mutated_component_props_to_local_snapshots() {
        let result = compile(request(
            "import { $state } from 'fict'; function Child({ reactive, local, count = 1, user: { name }, alias }) { local = 'changed'; count++; name = name.toUpperCase(); ({ alias } = { alias: 'reassigned' }); return <p>{reactive}:{local}:{count}:{name}:{alias}</p>; } export function App() { let reactive = $state('A'); return <Child reactive={reactive} local='initial' user={{ name: 'ann' }} alias='initial' />; }",
            "mutated-component-props.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result
                .code
                .contains("const reactive = prop(() => __fictProps.reactive);"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("var local = __fictProps.local;"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("const __fictPropDefault = __fictProps.count;"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("var count = __fictPropDefault === void 0 ? 1 : __fictPropDefault;"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("local = \"changed\";"),
            "{}",
            result.code
        );
        assert!(result.code.contains("count++;"), "{}", result.code);
        assert!(
            result.code.contains("var name = __fictProps.user.name;"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("var alias = __fictProps.alias;"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("name = name.toUpperCase();"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("({alias} = { alias: \"reassigned\" });"),
            "{}",
            result.code
        );
        assert!(result.code.contains("() => reactive()"), "{}", result.code);
        assert!(result.code.contains("() => local"), "{}", result.code);
        assert!(result.code.contains("() => count"), "{}", result.code);
        assert!(!result.code.contains("local()"), "{}", result.code);
        assert!(!result.code.contains("count()"), "{}", result.code);
        assert!(!result.code.contains("name()"), "{}", result.code);
        assert!(!result.code.contains("alias()"), "{}", result.code);
    }

    #[test]
    fn invokes_function_values_stored_in_state_bindings() {
        let result = compile(request(
            r#"
                import { $state } from 'fict';
                export function Component() {
                    let direct = $state((value) => value + 1);
                    let optional = $state(() => 2);
                    let assigned = $state(null);
                    assigned = () => 3;
                    let numeric = $state(1);
                    const snapshot = numeric();
                    let a = $state(0);
                    let b = $state(() => a + 1);
                    let c = $state(() => b() + 1);
                    let d = $state(() => c() + 1);
                    return [direct(2), optional?.(), assigned(), snapshot, d()];
                }
            "#,
            "function-valued-state.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.code.contains("direct()(2)"), "{}", result.code);
        assert!(result.code.contains("optional()?.()"), "{}", result.code);
        assert!(result.code.contains("assigned()()"), "{}", result.code);
        assert!(result.code.contains("numeric()"), "{}", result.code);
        assert!(!result.code.contains("numeric()()"), "{}", result.code);
        assert!(result.code.contains("() => b()() + 1"), "{}", result.code);
        assert!(result.code.contains("() => c()() + 1"), "{}", result.code);
        assert!(result.code.contains("d()()"), "{}", result.code);
    }

    #[test]
    fn lowers_jsx_inside_component_prop_defaults() {
        let mut input = request(
            "import { $state } from 'fict'; export const calls = []; function Child({ label, fallback = (calls.push(label), <span data-id='fallback'>{label}</span>) } = {}) { return <div data-id='host'>{fallback}</div>; } export function App() { let label = $state('A'); return <><Child label={label} /><Child label={label} fallback={<em data-id='custom'>Custom</em>} /><Child label={label} fallback={null} /></>; }",
            "jsx-prop-default.tsx",
        );
        input.options.strict_guarantee = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result
                .code
                .contains("template(\"<span data-id=\\\"fallback\\\"><!----></span>\")"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("__fictProps.fallback === void 0 ? (calls.push(label()),"),
            "{}",
            result.code
        );
        assert!(result.code.contains("insert(__fict_jsx"), "{}", result.code);
        assert!(result.code.contains("() => label()"), "{}", result.code);
        assert!(
            result.code.contains(
                "const fallback = prop(() => __fictProps.fallback === void 0 ? __fictPropDefault : __fictProps.fallback);"
            ),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("\"data-id\": \"custom\""),
            "{}",
            result.code
        );
    }

    #[test]
    fn lowers_literal_component_prop_keys_to_computed_members() {
        let result = compile(request(
            "function Child({ 'foo-bar': value, 0: first, nested: { 'aria-label': label = 'fallback' }, ...rest }) { return <span>{value}:{first}:{label}:{String('extra' in rest)}:{String('foo-bar' in rest)}</span>; } export function App() { return <Child foo-bar='dash' {...{ 0: 'zero', nested: {}, extra: 'kept' }} />; }",
            "literal-component-props.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result
                .code
                .contains("const value = prop(() => __fictProps[\"foo-bar\"]);"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("const first = prop(() => __fictProps[\"0\"]);"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("__fictProps.nested[\"aria-label\"] === void 0"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains(
                "const rest = __fictPropsRest(__fictProps, [\n\t\t\"foo-bar\",\n\t\t\"0\",\n\t\t\"nested\"\n\t]);"
            ),
            "{}",
            result.code
        );
    }

    #[test]
    fn enforces_unsupported_component_props_pattern_guarantees() {
        let source = "const key = 'name'; function ArrayProps({ list: [first, second] }) { return <p>{first}:{second}</p>; } function ArrayRest({ list: [head, ...tail] }) { return <p>{head}:{tail.length}</p>; } function Computed({ [key]: value }) { return <p>{value}</p>; } function EmptyKey({ '': value }) { return <p>{value}</p>; } function NestedRest({ user: { ...userRest } }) { return <p>{String(userRest.name)}</p>; }";
        let strict = compile(request(source, "unsupported-component-props.tsx"));

        assert!(strict.has_errors());
        assert!(strict.code.is_empty());
        assert_eq!(
            strict
                .diagnostics
                .iter()
                .map(|diagnostic| diagnostic.code.as_str())
                .collect::<Vec<_>>(),
            [
                "FICT-P001",
                "FICT-P002",
                "FICT-P003",
                "FICT-P003",
                "FICT-P004"
            ]
        );
        assert!(strict.diagnostics.iter().all(|diagnostic| {
            diagnostic.severity == DiagnosticSeverity::Error
                && diagnostic.guarantee_class == GuaranteeClass::Fallback
                && diagnostic.primary_span.is_some()
        }));

        let mut fallback_request = request(source, "unsupported-component-props.tsx");
        fallback_request.options.strict_guarantee = false;
        let fallback = compile(fallback_request);
        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert!(fallback.diagnostics.iter().all(|diagnostic| {
            diagnostic.severity == DiagnosticSeverity::Warning
                && diagnostic.guarantee_class == GuaranteeClass::Fallback
        }));
        for pattern in [
            "{ list: [first, second] }",
            "{ list: [head, ...tail] }",
            "{ [key]: value }",
            "{ \"\": value }",
            "{ user: { ...userRest } }",
        ] {
            assert!(fallback.code.contains(pattern), "{}", fallback.code);
        }
        assert!(!fallback.code.contains("prop(() =>"), "{}", fallback.code);

        let mut escalated_request = request(source, "unsupported-component-props.tsx");
        escalated_request.options.strict_guarantee = false;
        escalated_request.options.warnings_as_errors = WarningsAsErrors::Boolean(true);
        let escalated = compile(escalated_request);
        assert!(escalated.has_errors());
        assert!(escalated.code.is_empty());
        assert!(
            escalated
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
        );

        let mut muted_request = request(source, "unsupported-component-props.tsx");
        muted_request.options.strict_guarantee = false;
        muted_request.options.warnings_as_errors = WarningsAsErrors::Boolean(true);
        muted_request
            .options
            .warning_levels
            .insert("FICT-P".into(), WarningLevel::Off);
        let muted = compile(muted_request);
        assert!(!muted.has_errors(), "{:?}", muted.diagnostics);
        assert!(muted.diagnostics.is_empty());
        assert!(!muted.code.is_empty());
    }

    #[test]
    fn diagnoses_dynamic_component_spreads_and_keeps_accessors_lazy() {
        let dynamic_sources = [
            (
                "call",
                "function Child(_props) { return null; } function Parent(props) { return <Child {...props()} />; }",
            ),
            (
                "tagged-template",
                "function Child(_props) { return null; } function tag(value) { return value; } function Parent() { return <Child {...tag`value`} />; }",
            ),
            (
                "template",
                "function Child(_props) { return null; } function Parent(value) { return <Child {...`${value}`} />; }",
            ),
            (
                "plain-template",
                "function Child(_props) { return null; } function Parent() { return <Child {...`value`} />; }",
            ),
            (
                "array-spread",
                "function Child(_props) { return null; } function Parent(items) { return <Child {...[...items]} />; }",
            ),
            (
                "dynamic-import",
                "function Child(_props) { return null; } function Parent() { return <Child {...import('./props.js')} />; }",
            ),
            (
                "class-expression",
                "function Child(_props) { return null; } function Parent() { return <Child {...class Props {}} />; }",
            ),
            (
                "class-static",
                "function Child(_props) { return null; } function Parent() { return <Child {...class Props { static x = 1; static [String('y')] = 2; static { this.z = 3; } }} />; }",
            ),
            (
                "computed-member",
                "function Child(_props) { return null; } function Parent(source, key) { return <Child {...source[key]} />; }",
            ),
            (
                "optional-member",
                "function Child(_props) { return null; } function Parent(source) { return <Child {...source?.value} />; }",
            ),
            (
                "object-spread",
                "function Child(_props) { return null; } function Parent(source) { return <Child {...{...source}} />; }",
            ),
        ];

        for (name, source) in dynamic_sources {
            let expected_codes: &[&str] = if name == "computed-member" {
                &["FICT-H", "FICT-P005"]
            } else {
                &["FICT-P005"]
            };
            let strict = compile(request(source, &format!("dynamic-spread-{name}.tsx")));
            assert!(strict.has_errors(), "{name}: {:?}", strict.diagnostics);
            assert!(strict.code.is_empty(), "{name}: {}", strict.code);
            assert_eq!(
                strict
                    .diagnostics
                    .iter()
                    .map(|diagnostic| diagnostic.code.as_str())
                    .collect::<Vec<_>>(),
                expected_codes,
                "{name}: {:?}",
                strict.diagnostics
            );
            assert!(strict.diagnostics.iter().all(|diagnostic| {
                diagnostic.severity == DiagnosticSeverity::Error
                    && diagnostic.guarantee_class == GuaranteeClass::Fallback
                    && diagnostic.primary_span.is_some()
            }));

            let mut fallback_request = request(source, &format!("dynamic-spread-{name}.tsx"));
            fallback_request.options.strict_guarantee = false;
            let fallback = compile(fallback_request);
            assert!(!fallback.has_errors(), "{name}: {:?}", fallback.diagnostics);
            assert_eq!(
                fallback
                    .diagnostics
                    .iter()
                    .map(|diagnostic| (diagnostic.code.as_str(), diagnostic.severity))
                    .collect::<Vec<_>>(),
                expected_codes
                    .iter()
                    .map(|code| (*code, DiagnosticSeverity::Warning))
                    .collect::<Vec<_>>(),
                "{name}: {:?}",
                fallback.diagnostics
            );
            assert!(!fallback.code.is_empty(), "{name}");
        }

        let safe = compile(request(
            "import { $state } from 'fict'; function Child(_props) { return null; } export function Direct() { let props = $state({ value: 1 }); return <Child {...props} />; } export function Called() { let props = $state({ value: 1 }); return <Child {...props()} />; } export function Optional() { let props = $state({ value: 1 }); return <Child {...props?.()} />; } export function Plain(props) { return <Child {...props} />; }",
            "safe-accessor-spreads.tsx",
        ));
        assert!(!safe.has_errors(), "{:?}", safe.diagnostics);
        assert!(safe.diagnostics.is_empty(), "{:?}", safe.diagnostics);
        assert_eq!(
            safe.code.matches("__fictProp(() => props())").count(),
            2,
            "{}",
            safe.code
        );
        assert!(
            safe.code.contains("__fictProp(() => props?.())"),
            "{}",
            safe.code
        );
        assert!(!safe.code.contains("props()()"), "{}", safe.code);
        assert!(!safe.code.contains("props()?.()"), "{}", safe.code);
    }

    #[test]
    fn preserves_store_resource_and_selector_runtime_primitives() {
        let mut input = request(
            "import { $store, createSelector, render } from 'fict'; import { resource } from 'fict/plus'; const greeting = resource(async (_ctx, name) => `hello ${name}`); export function App() { const model = $store({ selected: 'a', label: 'A' }); const selected = createSelector(() => model.selected); const result = greeting.read('world'); return <main><p>{model.label}</p><i class={selected('a') ? 'selected' : ''}>A</i><b>{result.loading ? 'loading' : result.data}</b></main>; } export function mount(node) { return render(() => <App />, node); }",
            "runtime-reactive-primitives.tsx",
        );
        input.options.strict_guarantee = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result
                .code
                .contains("const greeting = resource(async (_ctx, name) =>"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("const model = $store({")
                && result.code.contains("selected: \"a\"")
                && result.code.contains("label: \"A\""),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("const selected = createSelector(() => model.selected);"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("const result = greeting.read(\"world\");"),
            "{}",
            result.code
        );
        assert!(!result.code.contains("model()"), "{}", result.code);
        assert!(!result.code.contains("greeting()"), "{}", result.code);
        assert!(!result.code.contains("selected()"), "{}", result.code);
        assert!(!result.code.contains("__fictUseContext"), "{}", result.code);
    }

    #[test]
    fn enforces_selector_control_flow_lifecycle_safety() {
        let source = "import { createSelector as select } from 'fict'; export function App(ready) { if (ready) { const selected = select(() => ready); console.log(selected); } return <div>{String(ready)}</div>; }";
        let strict = compile(request(source, "conditional-selector.tsx"));

        assert!(strict.has_errors());
        assert!(strict.code.is_empty());
        let finding = strict
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code.as_str() == "FICT-R004")
            .expect("selector placement diagnostic");
        assert_eq!(finding.severity, DiagnosticSeverity::Error);
        assert_eq!(finding.guarantee_class, GuaranteeClass::Fallback);

        let mut fallback_request = request(source, "conditional-selector.tsx");
        fallback_request.options.strict_guarantee = false;
        fallback_request
            .options
            .warning_levels
            .insert("FICT-R004".into(), WarningLevel::Warn);
        let fallback = compile(fallback_request);
        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert!(fallback.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R004"
                && diagnostic.severity == DiagnosticSeverity::Warning
        }));
        assert!(
            fallback
                .code
                .contains("const selected = select(() => ready);"),
            "{}",
            fallback.code
        );
    }

    #[test]
    fn enforces_render_effect_control_flow_lifecycle_safety() {
        let cases = [
            "import { createRenderEffect } from 'fict/advanced'; export function App(ready) { if (ready) createRenderEffect(() => {}); return null; }",
            "import { createRenderEffect as renderEffect } from 'fict/advanced'; export function App(ready) { if (ready) renderEffect(() => {}); return null; }",
            "import * as Advanced from 'fict/advanced'; export function App(ready) { if (ready) Advanced.createRenderEffect(() => {}); return null; }",
            "import { createRenderEffect } from '@fictjs/runtime/advanced'; export function App(ready) { if (ready) createRenderEffect(() => {}); return null; }",
            "import * as RuntimeAdvanced from '@fictjs/runtime/advanced'; export function App(items) { for (const item of items) RuntimeAdvanced.createRenderEffect?.(() => item); return null; }",
        ];

        for (index, source) in cases.iter().enumerate() {
            let strict = compile(request(
                source,
                &format!("render-effect-control-{index}.tsx"),
            ));
            assert!(strict.has_errors(), "{source}: {:?}", strict.diagnostics);
            assert!(strict.code.is_empty(), "{source}: {}", strict.code);
            assert!(
                strict.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code.as_str() == "FICT-R004"
                        && diagnostic.severity == DiagnosticSeverity::Error
                }),
                "{source}: {:?}",
                strict.diagnostics
            );
        }

        let mut fallback_request = request(cases[0], "render-effect-control-warning.tsx");
        fallback_request.options.strict_guarantee = false;
        fallback_request
            .options
            .warning_levels
            .insert("FICT-R004".into(), WarningLevel::Warn);
        let fallback = compile(fallback_request);
        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert!(fallback.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R004"
                && diagnostic.severity == DiagnosticSeverity::Warning
        }));
        assert!(!fallback.code.is_empty());

        let shadow = compile(request(
            "export function App(ready) { const createRenderEffect = callback => callback(); if (ready) createRenderEffect(() => {}); return null; }",
            "render-effect-shadow.tsx",
        ));
        assert!(!shadow.has_errors(), "{:?}", shadow.diagnostics);
        assert!(
            shadow
                .diagnostics
                .iter()
                .all(|diagnostic| { diagnostic.code.as_str() != "FICT-R004" })
        );
    }

    #[test]
    fn enforces_call_based_reactive_control_flow_reexecution_guarantees() {
        let source = "import { $state } from 'fict'; export function App() { const count = $state(0); if (count > 10 && maybe?.()) return <Big />; return <Small />; }";
        let strict = compile(request(source, "call-control-flow.tsx"));
        assert!(strict.has_errors());
        assert!(strict.code.is_empty());
        let finding = strict
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code.as_str() == "FICT-R006")
            .expect("reactive control-flow diagnostic");
        assert_eq!(finding.severity, DiagnosticSeverity::Error);
        assert_eq!(finding.guarantee_class, GuaranteeClass::Fallback);
        assert!(finding.primary_span.is_some());
        assert!(finding.message.contains("count"));

        let mut fallback_request = request(source, "call-control-flow.tsx");
        fallback_request.options.strict_guarantee = false;
        let fallback = compile(fallback_request);
        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert!(fallback.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R006"
                && diagnostic.severity == DiagnosticSeverity::Warning
        }));
        assert!(!fallback.code.is_empty());

        let mut strict_reactivity_request = request(source, "call-control-flow.tsx");
        strict_reactivity_request.options.strict_guarantee = false;
        strict_reactivity_request.options.strict_reactivity = true;
        let strict_reactivity = compile(strict_reactivity_request);
        assert!(strict_reactivity.has_errors());
        assert!(strict_reactivity.code.is_empty());

        let mut muted_request = request(source, "call-control-flow.tsx");
        muted_request.options.strict_guarantee = false;
        muted_request
            .options
            .warning_levels
            .insert("FICT-R006".into(), WarningLevel::Off);
        let muted = compile(muted_request);
        assert!(!muted.has_errors(), "{:?}", muted.diagnostics);
        assert!(
            muted
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code.as_str() != "FICT-R006")
        );
    }

    #[test]
    fn fails_closed_for_late_inferred_hook_accessors_in_setup_control_flow() {
        let sources = [
            (
                "structured-hook-story.tsx",
                r#"
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
                "#,
            ),
            (
                "direct-hook-loop.tsx",
                r#"
                    import { $state } from 'fict';
                    function useCount() {
                        const count = $state(2);
                        return count;
                    }
                    export function App() {
                        const count = useCount();
                        const seen = [];
                        while (count && seen.length < 2) seen.push(count);
                        return <span>{seen.length}</span>;
                    }
                "#,
            ),
        ];

        for (filename, source) in sources {
            let strict = compile(request(source, filename));
            assert!(strict.has_errors(), "{filename}: {:?}", strict.diagnostics);
            assert!(strict.code.is_empty(), "{filename}: {}", strict.code);
            let finding = strict
                .diagnostics
                .iter()
                .find(|diagnostic| diagnostic.code.as_str() == "FICT-R006")
                .unwrap_or_else(|| {
                    panic!(
                        "{filename}: missing late hook control-flow diagnostic: {:?}",
                        strict.diagnostics
                    )
                });
            assert_eq!(finding.severity, DiagnosticSeverity::Error);
            assert_eq!(finding.guarantee_class, GuaranteeClass::Fallback);
            assert!(finding.primary_span.is_some());
        }

        let mut fallback_request = request(sources[0].1, sources[0].0);
        fallback_request.options.strict_guarantee = false;
        let fallback = compile(fallback_request);
        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert!(fallback.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R006"
                && diagnostic.severity == DiagnosticSeverity::Warning
        }));
        assert!(
            fallback.code.contains("if (bucket.count())"),
            "{}",
            fallback.code
        );

        let supported = compile(request(
            r#"
                import { $state } from 'fict';
                function useBucket() {
                    const count = $state(1);
                    return { count };
                }
                export function App() {
                    const bucket = useBucket();
                    if (bucket.count) return <strong>on</strong>;
                    return <span>off</span>;
                }
            "#,
            "structured-hook-branch-return.tsx",
        ));
        assert!(!supported.has_errors(), "{:?}", supported.diagnostics);
        assert!(
            supported
                .diagnostics
                .iter()
                .all(|diagnostic| { diagnostic.code.as_str() != "FICT-R006" })
        );
        assert!(
            supported
                .code
                .contains("createConditional(() => bucket.count()"),
            "{}",
            supported.code
        );
    }

    #[test]
    fn accepts_guaranteed_simple_if_return_control_flow() {
        let source = "import { $state } from 'fict'; export function App() { const count = $state(0); if (count > 10) return <Big />; return <Small />; }";
        let result = compile(request(source, "simple-control-flow.tsx"));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code.as_str() != "FICT-R006")
        );
        assert!(
            result.code.contains("createConditional(() => count() > 10"),
            "{}",
            result.code
        );
        let prop_ternary = compile(request(
            "export function App(props) { return props.broken ? <Broken /> : <Ready />; }",
            "prop-ternary-return.tsx",
        ));
        assert!(!prop_ternary.has_errors(), "{:?}", prop_ternary.diagnostics);
        assert!(
            prop_ternary
                .code
                .contains("createConditional(() => props.broken"),
            "{}",
            prop_ternary.code
        );

        let non_jsx = compile(request(
            "import { $state } from 'fict'; export function App() { const count = $state(0); if (count > 10 && maybe()) return count; return 0; }",
            "non-jsx-control-flow.js",
        ));
        assert!(!non_jsx.has_errors(), "{:?}", non_jsx.diagnostics);
        assert!(
            non_jsx
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code.as_str() != "FICT-R006")
        );
    }

    #[test]
    fn lowers_nullish_reactive_component_returns() {
        for (name, empty_return) in [
            ("null", "return null;"),
            ("undefined", "return undefined;"),
            ("bare", "return;"),
            ("void", "return void 0;"),
        ] {
            let source = format!(
                "import {{ $state }} from 'fict'; export function App() {{ const ready = $state(false); if (!ready) {empty_return} return <Ready />; }}"
            );
            let result = compile(request(&source, &format!("{name}-return.tsx")));
            assert!(!result.has_errors(), "{name}: {:?}", result.diagnostics);
            assert!(
                result
                    .diagnostics
                    .iter()
                    .all(|diagnostic| diagnostic.code.as_str() != "FICT-R006"),
                "{name}: {:?}",
                result.diagnostics
            );
            assert!(
                result.code.contains("createConditional"),
                "{name}: {}",
                result.code
            );
        }
    }

    #[test]
    fn does_not_treat_implicit_fallthrough_as_nullable_return() {
        for (name, source) in [
            (
                "partial-if",
                "import { $state } from 'fict'; export function App() { const ready = $state(false); if (ready) return <Ready />; }",
            ),
            (
                "partial-switch",
                "import { $state } from 'fict'; export function App() { const mode = $state(0); switch (mode) { case 1: return <One />; case 2: return <Two />; } }",
            ),
        ] {
            let strict = compile(request(source, &format!("{name}.tsx")));
            assert!(strict.has_errors(), "{name}: {:?}", strict.diagnostics);
            assert!(strict.code.is_empty(), "{name}: {}", strict.code);
            assert!(strict.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R006"
                    && diagnostic.severity == DiagnosticSeverity::Error
            }));

            let mut fallback_request = request(source, &format!("{name}.tsx"));
            fallback_request.options.strict_guarantee = false;
            let fallback = compile(fallback_request);
            assert!(!fallback.has_errors(), "{name}: {:?}", fallback.diagnostics);
            assert!(fallback.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R006"
                    && diagnostic.severity == DiagnosticSeverity::Warning
            }));
            assert!(
                !fallback.code.contains("createConditional"),
                "{name}: {}",
                fallback.code
            );
        }
    }

    #[test]
    fn lowers_compound_conditional_returns_with_tracked_dispatchers() {
        let else_if = compile(request(
            "import { $state } from 'fict'; export function App() { const mode = $state(0); if (mode === 0) return <Zero />; else if (mode === 1) return <One />; else return <Many />; }",
            "else-if-return.tsx",
        ));
        assert!(else_if.diagnostics.is_empty(), "{:?}", else_if.diagnostics);
        assert!(
            else_if.code.contains("createConditional(() => true"),
            "{}",
            else_if.code
        );
        assert!(
            else_if.code.contains("trackBranchReads: true"),
            "{}",
            else_if.code
        );

        let switch = compile(request(
            "import { $state } from 'fict'; export function App() { const mode = $state(0); switch (mode) { case 0: return <Zero />; case 1: return <One />; default: return <Many />; } }",
            "switch-return.tsx",
        ));
        assert!(switch.diagnostics.is_empty(), "{:?}", switch.diagnostics);
        assert!(
            switch.code.contains("createConditional(() => true"),
            "{}",
            switch.code
        );
        assert!(
            switch.code.contains("trackBranchReads: true"),
            "{}",
            switch.code
        );

        let fallthrough_switch = compile(request(
            "import { $state } from 'fict'; export function App() { const mode = $state(0); switch (mode) { case 0: 'fallthrough'; case 1: return <One />; default: return <Many />; } }",
            "switch-fallthrough-return.tsx",
        ));
        assert!(
            fallthrough_switch.diagnostics.is_empty()
                && fallthrough_switch.code.contains("trackBranchReads: true"),
            "{:?}\n{}",
            fallthrough_switch.diagnostics,
            fallthrough_switch.code
        );

        let sequential = compile(request(
            "import { $state } from 'fict'; export function App() { const mode = $state(0); if (mode === 0) return <Zero />; if (mode === 1) return <One />; return <Many />; }",
            "sequential-return.tsx",
        ));
        assert!(
            sequential.diagnostics.is_empty(),
            "{:?}",
            sequential.diagnostics
        );
        assert!(
            sequential.code.contains("trackBranchReads: true"),
            "{}",
            sequential.code
        );
    }

    #[test]
    fn lowers_expression_bodied_component_conditional_returns() {
        let result = compile(request(
            "const App = flag => flag ? <span /> : null; export { App };",
            "expression-arrow-return.tsx",
        ));

        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
        assert!(result.code.contains("createConditional"), "{}", result.code);
        assert!(
            result.code.contains("const App = (flag) => {") && result.code.contains("return "),
            "{}",
            result.code
        );
    }

    #[test]
    fn lazy_conditional_option_controls_control_flow_return_lowering() {
        let source = "import { $state } from 'fict'; export function App() { const count = $state(0); if (count > 10) return <Big />; return <Small />; }";
        let enabled = compile(request(source, "lazy-conditional.tsx"));
        assert!(!enabled.has_errors());
        assert!(
            enabled
                .code
                .contains("createConditional(() => count() > 10")
        );

        let mut disabled_request = request(source, "lazy-conditional.tsx");
        disabled_request.options.lazy_conditional = false;
        let disabled = compile(disabled_request);
        assert!(disabled.has_errors(), "{:?}", disabled.diagnostics);
        assert!(disabled.code.is_empty());
        assert!(disabled.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R006"
                && diagnostic.severity == DiagnosticSeverity::Error
        }));

        let mut fallback_request = request(source, "lazy-conditional.tsx");
        fallback_request.options.lazy_conditional = false;
        fallback_request.options.strict_guarantee = false;
        let fallback = compile(fallback_request);
        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert!(fallback.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R006"
                && diagnostic.severity == DiagnosticSeverity::Warning
        }));
        assert!(!fallback.code.contains("createConditional"));
        assert!(fallback.code.contains("if (count() > 10)"));
    }

    #[test]
    fn diagnoses_call_like_control_flow_forms_without_relying_on_call_hir_only() {
        for (name, predicate) in [
            ("constructor", "count > 0 && new Boolean(true)"),
            ("dynamic-import", "count > 0 && import('./feature.js')"),
            ("tagged-template", "count > 0 && tag`value`"),
        ] {
            let source = format!(
                "import {{ $state }} from 'fict'; export function App() {{ const count = $state(0); if ({predicate}) return <Big />; return <Small />; }}"
            );
            let result = compile(request(&source, &format!("{name}.tsx")));
            assert!(result.has_errors(), "{name}: {:?}", result.diagnostics);
            assert!(
                result.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code.as_str() == "FICT-R006"
                        && diagnostic.guarantee_class == GuaranteeClass::Fallback
                }),
                "{name}: {:?}",
                result.diagnostics
            );
        }
    }

    #[test]
    fn diagnoses_property_deletion_inside_reactive_control_flow() {
        let source = "import { $state } from 'fict'; export function App() { const count = $state(0); const object = { value: 1 }; if (count > 0) { delete object.value; } return <div>{count}</div>; }";
        let strict = compile(request(source, "delete-control-flow.jsx"));
        assert!(strict.has_errors());
        assert!(strict.code.is_empty());
        assert!(strict.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R006"
                && diagnostic.severity == DiagnosticSeverity::Error
                && diagnostic.guarantee_class == GuaranteeClass::Fallback
        }));

        let mut fallback_request = request(source, "delete-control-flow.jsx");
        fallback_request.options.strict_guarantee = false;
        let fallback = compile(fallback_request);
        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert!(fallback.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R006"
                && diagnostic.severity == DiagnosticSeverity::Warning
        }));
        assert!(
            fallback.code.contains("delete object.value"),
            "{}",
            fallback.code
        );
    }

    #[test]
    fn checks_the_whole_story_conditional_before_suppressing_r006() {
        let safe_source = "import { $state } from 'fict'; export function App() { const count = $state(0); let heading = 'empty'; if (count > 0) heading = count + ' items'; return <h1>{heading}</h1>; }";
        let safe_strict = compile(request(safe_source, "safe-story.tsx"));
        assert!(safe_strict.has_errors(), "{:?}", safe_strict.diagnostics);
        assert!(safe_strict.code.is_empty());
        assert!(safe_strict.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R006"
                && diagnostic.severity == DiagnosticSeverity::Error
        }));

        let mut safe_fallback_request = request(safe_source, "safe-story.tsx");
        safe_fallback_request.options.strict_guarantee = false;
        let safe_fallback = compile(safe_fallback_request);
        assert!(
            !safe_fallback.has_errors(),
            "{:?}",
            safe_fallback.diagnostics
        );
        assert!(
            safe_fallback.code.contains("__fictUseMemo"),
            "{}",
            safe_fallback.code
        );
        assert!(
            safe_fallback.code.contains("return { heading };"),
            "{}",
            safe_fallback.code
        );
        assert!(
            safe_fallback.code.contains("().heading"),
            "{}",
            safe_fallback.code
        );

        let unsafe_source = "import { $state } from 'fict'; const external = { fmt() { return 'count:'; } }; export function App() { const count = $state(0); let heading = 'empty'; if (count > 0) heading = external.fmt() + count; return <h1>{heading}</h1>; }";
        let strict = compile(request(unsafe_source, "unsafe-story.tsx"));
        assert!(strict.has_errors());
        assert!(strict.code.is_empty());
        assert!(strict.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R006" && diagnostic.message.contains("count")
        }));

        let mut fallback_request = request(unsafe_source, "unsafe-story.tsx");
        fallback_request.options.strict_guarantee = false;
        let fallback = compile(fallback_request);
        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert!(fallback.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R006"
                && diagnostic.severity == DiagnosticSeverity::Warning
        }));
    }

    #[test]
    fn accepts_memoizable_switch_stories_and_total_switch_returns() {
        let story_source = "import { $state } from 'fict'; export function App() { const mode = $state(0); let label = 'zero'; switch (mode) { case 0: label = 'zero'; break; case 1: label = 'one'; break; default: label = 'many'; } return <span>{label}</span>; }";
        let story_strict = compile(request(story_source, "switch-story.tsx"));
        assert!(story_strict.has_errors(), "{:?}", story_strict.diagnostics);
        assert!(story_strict.code.is_empty());
        let mut story_request = request(story_source, "switch-story.tsx");
        story_request.options.strict_guarantee = false;
        let story = compile(story_request);
        assert!(!story.has_errors(), "{:?}", story.diagnostics);
        assert!(
            story
                .diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.code.as_str() == "FICT-R006" })
        );
        assert!(story.code.contains("__fictUseMemo"), "{}", story.code);
        assert!(story.code.contains("switch (mode())"), "{}", story.code);
        assert!(story.code.contains("case 0:"), "{}", story.code);
        assert!(story.code.contains("case 1:"), "{}", story.code);
        assert!(story.code.contains("default:"), "{}", story.code);
        assert!(story.code.contains("().label"), "{}", story.code);

        let returns_source = "import { $state } from 'fict'; export function App() { const mode = $state(0); switch (mode) { case 0: return <Zero />; default: return <Many />; } }";
        let returns = compile(request(returns_source, "switch-return.tsx"));
        assert!(!returns.has_errors(), "{:?}", returns.diagnostics);
        assert!(
            returns
                .diagnostics
                .iter()
                .all(|diagnostic| { diagnostic.code.as_str() != "FICT-R006" })
        );
    }

    #[test]
    fn lowers_multiple_control_region_outputs_and_captured_reads_in_arrow_components() {
        let source = "import { $state } from 'fict'; declare function consume(value: string): void; export const App = () => { const mode = $state(false); let label; let detail; if (mode) { label = 'on'; detail = 'ready'; } else { label = 'off'; detail = 'idle'; } return <button onClick={() => consume(label)}>{label}:{detail}</button>; };";
        let strict = compile(request(source, "arrow-control-region.tsx"));
        assert!(strict.has_errors(), "{:?}", strict.diagnostics);
        assert!(strict.code.is_empty());

        let mut fallback_request = request(source, "arrow-control-region.tsx");
        fallback_request.options.strict_guarantee = false;
        let fallback = compile(fallback_request);
        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert!(fallback.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R006"
                && diagnostic.severity == DiagnosticSeverity::Warning
        }));
        assert!(fallback.code.contains("__fictUseMemo"), "{}", fallback.code);
        assert!(fallback.code.contains("return {"), "{}", fallback.code);
        assert!(fallback.code.contains("label,"), "{}", fallback.code);
        assert!(fallback.code.contains("detail"), "{}", fallback.code);
        assert!(fallback.code.contains("().label"), "{}", fallback.code);
        assert!(fallback.code.contains("().detail"), "{}", fallback.code);
        assert!(
            fallback.code.contains("consume(__fict_region"),
            "{}",
            fallback.code
        );
    }

    #[test]
    fn keeps_function_scoped_branch_vars_inside_control_regions() {
        let source = "import { $state } from 'fict'; function side() { return 2; } export function App() { const count = $state(1); let retained = side(); let out = 0; let intermediate = 0; if (count) { intermediate = side(); const readIntermediate = () => intermediate; var branchVar = readIntermediate(); out = branchVar; } return <span>{retained}:{out}:{branchVar}:{count}</span>; }";
        let mut fallback_request = request(source, "branch-var-control-region.tsx");
        fallback_request.options.strict_guarantee = false;
        let fallback = compile(fallback_request);

        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert!(fallback.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R006"
                && diagnostic.severity == DiagnosticSeverity::Warning
        }));
        assert!(
            fallback
                .code
                .contains("var branchVar = readIntermediate();"),
            "{}",
            fallback.code
        );
        assert!(
            fallback.code.contains("() => intermediate"),
            "{}",
            fallback.code
        );
        assert!(fallback.code.contains("return {"), "{}", fallback.code);
        assert!(
            fallback
                .code
                .contains("out,\n\t\t\tintermediate,\n\t\t\tbranchVar"),
            "{}",
            fallback.code
        );
        assert!(fallback.code.contains("().out"), "{}", fallback.code);
        assert!(fallback.code.contains("().branchVar"), "{}", fallback.code);
        let retained = fallback
            .code
            .find("let retained = side();")
            .unwrap_or_else(|| panic!("{}", fallback.code));
        let region = fallback
            .code
            .find("const __fict_region")
            .unwrap_or_else(|| panic!("{}", fallback.code));
        let output = fallback
            .code
            .find("let out = 0;")
            .unwrap_or_else(|| panic!("{}", fallback.code));
        assert!(retained < region && region < output, "{}", fallback.code);
    }

    #[test]
    fn enforces_call_based_and_nested_reactive_switch_guarantees() {
        let call_source = "import { $state } from 'fict'; export function App() { const mode = $state(0); let label = 'none'; switch (mode + choose?.()) { case 0: label = 'zero'; break; default: label = 'many'; } return <span>{label}</span>; }";
        let strict = compile(request(call_source, "call-switch.tsx"));
        assert!(strict.has_errors(), "{:?}", strict.diagnostics);
        assert!(strict.code.is_empty());
        let finding = strict
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code.as_str() == "FICT-R006")
            .unwrap_or_else(|| panic!("call-based switch diagnostic: {:?}", strict.diagnostics));
        assert_eq!(finding.severity, DiagnosticSeverity::Error);
        assert!(finding.message.contains("mode"));

        let mut fallback_request = request(call_source, "call-switch.tsx");
        fallback_request.options.strict_guarantee = false;
        let fallback = compile(fallback_request);
        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert!(fallback.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R006"
                && diagnostic.severity == DiagnosticSeverity::Warning
        }));

        let nested_source = "import { $state } from 'fict'; export function App() { const mode = $state(0); let label = 'none'; switch (mode) { case 0: switch (mode) { case 0: label = 'zero'; break; } break; default: label = 'many'; } return <span>{label}</span>; }";
        let nested = compile(request(nested_source, "nested-switch.tsx"));
        assert!(nested.has_errors(), "{:?}", nested.diagnostics);
        assert!(nested.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R006"
                && diagnostic.severity == DiagnosticSeverity::Error
        }));
    }

    #[test]
    fn emits_authored_try_catch_finally_from_structured_hir() {
        let source = "import { $state } from 'fict'; export function App() { let result = $state('init'); try { result = 'try'; if (globalThis.shouldThrow) throw new Error('boom'); } catch (error) { result = error.message; } finally { result += '!'; } return <span>{result}</span>; }";
        let compiled = compile(request(source, "try-catch-finally.tsx"));

        assert!(!compiled.has_errors(), "{:?}", compiled.diagnostics);
        assert!(
            compiled.diagnostics.is_empty(),
            "{:?}",
            compiled.diagnostics
        );
        assert!(compiled.code.contains("try {"), "{}", compiled.code);
        assert!(compiled.code.contains("catch (error)"), "{}", compiled.code);
        assert!(compiled.code.contains("finally {"), "{}", compiled.code);
        assert!(compiled.code.contains(")(\"try\");"), "{}", compiled.code);
        assert!(
            compiled.code.contains(")(result() + \"!\");"),
            "{}",
            compiled.code
        );
    }

    #[test]
    fn lowers_closed_reactive_try_stories_only_in_fallback_mode() {
        for (name, body) in [
            (
                "caught-throw",
                "if (n > 0) { throw new Error('boom'); } label = 'ok:' + n;",
            ),
            (
                "conditional-write",
                "if (n > 0) { label = 'big'; } else { label = 'ok:' + n; }",
            ),
        ] {
            let source = format!(
                "import {{ $state }} from 'fict'; export function App() {{ let n = $state(0); let label = 'init'; try {{ {body} }} catch (error) {{ label = 'caught:' + error.message; }} return <span>{{label}}</span>; }}"
            );
            let strict = compile(request(&source, &format!("try-{name}.tsx")));
            assert!(strict.has_errors(), "{name}: {:?}", strict.diagnostics);
            assert!(strict.code.is_empty());
            assert!(strict.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R006"
                    && diagnostic.severity == DiagnosticSeverity::Error
            }));

            let mut fallback_request = request(&source, &format!("try-{name}.tsx"));
            fallback_request.options.strict_guarantee = false;
            let result = compile(fallback_request);
            assert!(!result.has_errors(), "{name}: {:?}", result.diagnostics);
            assert!(result.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-R006"
                    && diagnostic.severity == DiagnosticSeverity::Warning
            }));
            assert!(
                result.code.contains("__fictUseMemo"),
                "{name}: {}",
                result.code
            );
            assert!(result.code.contains("try {"), "{name}: {}", result.code);
            assert!(
                result.code.contains("catch (error)"),
                "{name}: {}",
                result.code
            );
        }
    }

    #[test]
    fn rejects_reactive_try_stories_that_rethrow_from_catch() {
        let source = "import { $state } from 'fict'; export function App() { let count = $state(0); let label = 'init'; try { if (count > 0) throw 'boom'; label = 'ok'; } catch (error) { throw error; } return <span>{label}</span>; }";
        let strict = compile(request(source, "try-rethrow.tsx"));
        assert!(strict.has_errors(), "{:?}", strict.diagnostics);
        assert!(strict.code.is_empty());
        assert!(strict.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R006"
                && diagnostic.severity == DiagnosticSeverity::Error
                && diagnostic.message.contains("count")
        }));

        let mut fallback_request = request(source, "try-rethrow.tsx");
        fallback_request.options.strict_guarantee = false;
        let fallback = compile(fallback_request);
        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert!(fallback.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R006"
                && diagnostic.severity == DiagnosticSeverity::Warning
        }));
    }

    #[test]
    fn diagnoses_reactive_classic_and_enumeration_loop_controls() {
        let cases = [
            (
                "while",
                "2",
                "let index = 0; while (index < source) index += 1;",
                false,
            ),
            (
                "do-while",
                "2",
                "let index = 0; do { index += 1; } while (index < source);",
                false,
            ),
            (
                "for",
                "2",
                "for (let index = 0; index < source; index += 1) {}",
                false,
            ),
            ("break", "true", "for (;;) { if (source) break; }", false),
            (
                "continue",
                "false",
                "for (let index = 0; index < 1; index += 1) { if (source) continue; }",
                false,
            ),
            (
                "for-of",
                "[1, 2]",
                "for (const value of source) { void value; }",
                false,
            ),
            (
                "for-in",
                "{ first: 1, second: 2 }",
                "for (const key in source) { void key; }",
                false,
            ),
        ];

        for (name, initial, loop_source, is_async) in cases {
            let async_keyword = if is_async { "async " } else { "" };
            let owner_name = if is_async { "useLoop" } else { "App" };
            let return_value = if is_async { "source" } else { "<div />" };
            let source = format!(
                "import {{ $state }} from 'fict'; export {async_keyword}function {owner_name}() {{ let source = $state({initial}); {loop_source} return {return_value}; }}"
            );
            let filename = format!("reactive-{name}.tsx");
            let strict = compile(request(&source, &filename));
            assert!(strict.has_errors(), "{name}: {:?}", strict.diagnostics);
            assert!(strict.code.is_empty(), "{name}: {}", strict.code);
            let finding = strict
                .diagnostics
                .iter()
                .find(|diagnostic| diagnostic.code.as_str() == "FICT-R006")
                .unwrap_or_else(|| panic!("{name}: missing R006 in {:?}", strict.diagnostics));
            assert_eq!(finding.severity, DiagnosticSeverity::Error, "{name}");
            assert_eq!(finding.guarantee_class, GuaranteeClass::Fallback, "{name}");
            assert!(finding.primary_span.is_some(), "{name}: {finding:?}");
            assert!(finding.message.contains("source"), "{name}: {finding:?}");

            let mut fallback_request = request(&source, &filename);
            fallback_request.options.strict_guarantee = false;
            let fallback = compile(fallback_request);
            assert!(!fallback.has_errors(), "{name}: {:?}", fallback.diagnostics);
            assert!(!fallback.code.is_empty(), "{name}");
            assert!(
                fallback.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code.as_str() == "FICT-R006"
                        && diagnostic.severity == DiagnosticSeverity::Warning
                        && diagnostic.message.contains("source")
                }),
                "{name}: {:?}",
                fallback.diagnostics
            );
        }
    }

    #[test]
    fn diagnoses_reactive_loop_controls_inside_labeled_blocks() {
        let source = "import { $state } from 'fict'; export function App() { let hot = $state(true); let label = 'cold'; choose: { for (const item of hot ? [1] : [2]) { if (item === 1) { label = 'hot'; break choose; } } label = 'warm'; } return <div>{label}</div>; }";
        let strict = compile(request(source, "labeled-block-loop.tsx"));

        assert!(strict.has_errors(), "{:?}", strict.diagnostics);
        assert!(strict.code.is_empty());
        assert!(strict.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R006"
                && diagnostic.severity == DiagnosticSeverity::Error
                && diagnostic.message.contains("hot")
        }));

        let mut fallback_request = request(source, "labeled-block-loop.tsx");
        fallback_request.options.strict_guarantee = false;
        let fallback = compile(fallback_request);
        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert!(fallback.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R006"
                && diagnostic.severity == DiagnosticSeverity::Warning
                && diagnostic.message.contains("hot")
        }));
    }

    #[test]
    fn does_not_diagnose_reactive_reads_that_do_not_control_a_loop() {
        let source = "import { $state } from 'fict'; export function App() { let value = $state(1); let total = 0; for (let index = 0; index < 2; index += 1) total += value; return <div>{total}</div>; }";
        let result = compile(request(source, "loop-body-read.tsx"));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result
                .diagnostics
                .iter()
                .all(|diagnostic| { diagnostic.code.as_str() != "FICT-R006" }),
            "{:?}",
            result.diagnostics
        );
    }

    #[test]
    fn emits_authored_classic_loops_from_structured_hir() {
        let source = "import { $state } from 'fict'; export function App() { let count = $state(0); while (count < 1) count++; do { count++; } while (count < 2); for (let index = 0; index < 1; index++) { count += index; } return count; }";
        let result = compile(request(source, "classic-loops.js"));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
        assert!(
            result.code.contains("while (count() < 1)"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("while (count() < 2)"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("for (let index = 0; index < 1; index++)"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("__fict_previous + 1"),
            "{}",
            result.code
        );
        assert!(result.code.contains("count() + index"), "{}", result.code);
    }

    #[test]
    fn emits_authored_enumeration_loops_from_structured_hir() {
        let source = "import { $state } from 'fict'; export async function useTotals(values, object) { let total = $state(0); for (const value of values) total += value; for (const key in object) total += key.length; for await (const value of values) { total += await value; } return total; }";
        let result = compile(request(source, "enumeration-loops.js"));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
        assert!(
            result.code.contains("for (const value of values)"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("for (const key in object)"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("for await (const value of values)"),
            "{}",
            result.code
        );
        assert!(result.code.contains("total() + value"), "{}", result.code);
        assert!(
            result.code.contains("total() + key.length"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("total() + await value"),
            "{}",
            result.code
        );
    }

    #[test]
    fn applies_native_diagnostic_policy_precedence() {
        let finding = || {
            Diagnostic::new(
                DiagnosticCode::new("FICT-R006").expect("diagnostic code"),
                DiagnosticSeverity::Warning,
                "reactive control-flow fallback",
            )
            .with_guarantee_class(GuaranteeClass::Fallback)
        };

        let mut strict_reactivity = request("export const value = 1", "policy.js");
        strict_reactivity.options.strict_guarantee = false;
        strict_reactivity.options.strict_reactivity = true;
        strict_reactivity.integration_diagnostics.push(finding());
        let strict_reactivity = compile(strict_reactivity);
        assert!(strict_reactivity.has_errors());
        assert!(strict_reactivity.code.is_empty());
        assert_eq!(
            strict_reactivity.diagnostics[0].severity,
            DiagnosticSeverity::Error
        );

        let mut warnings_as_errors = request("export const value = 1", "policy.js");
        warnings_as_errors.options.strict_guarantee = false;
        warnings_as_errors.options.warnings_as_errors =
            WarningsAsErrors::Codes(vec!["FICT-R".into()]);
        warnings_as_errors.integration_diagnostics.push(finding());
        assert!(compile(warnings_as_errors).has_errors());

        let mut explicit_off = request("export const value = 1", "policy.js");
        explicit_off.options.strict_guarantee = false;
        explicit_off.options.warnings_as_errors = WarningsAsErrors::Boolean(true);
        explicit_off
            .options
            .warning_levels
            .insert("FICT-R".into(), WarningLevel::Off);
        explicit_off.integration_diagnostics.push(finding());
        let explicit_off = compile(explicit_off);
        assert!(!explicit_off.has_errors(), "{:?}", explicit_off.diagnostics);
        assert!(explicit_off.diagnostics.is_empty());
        assert!(explicit_off.code.contains("export const value = 1"));
    }

    #[test]
    fn enforces_strict_guarantee_configuration_and_suppression_rules() {
        let mut downgrade = request("export const value = 1", "strict-config.js");
        downgrade
            .options
            .warning_levels
            .insert("FICT-P".into(), WarningLevel::Warn);
        let downgrade = compile(downgrade);
        assert!(downgrade.has_errors());
        assert_eq!(downgrade.diagnostics[0].code.as_str(), "FICT-REQUEST");
        assert!(
            downgrade.diagnostics[0]
                .message
                .contains("does not allow downgrading FICT-P")
        );

        let strict = compile(request(
            "export const value = 1; // fict-ignore FICT-M",
            "strict-suppression.js",
        ));
        assert!(strict.has_errors());
        assert!(strict.code.is_empty());
        assert!(
            strict
                .diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.code.as_str() == "FICT-STRICT-SUPPRESSION" })
        );

        let mut non_strict = request(
            "export const value = 1; // fict-ignore FICT-M",
            "strict-suppression.js",
        );
        non_strict.options.strict_guarantee = false;
        let non_strict = compile(non_strict);
        assert!(!non_strict.has_errors(), "{:?}", non_strict.diagnostics);
        assert!(non_strict.code.contains("export const value = 1"));
    }

    #[test]
    fn applies_source_suppressions_before_warning_escalation() {
        let sources = [
            concat!(
                "import { $memo } from 'fict';\n",
                "// fict-ignore-next-line FICT-M003\n",
                "const value = $memo(() => { console.log('side'); });",
            ),
            concat!(
                "import { $memo } from 'fict';\n",
                "// fict-ignore-next-line FICT-M\u{2028}",
                "const value = $memo(() => { console.log('side'); });",
            ),
            concat!(
                "import { $memo } from 'fict';\n",
                "const value = $memo(() => { /* fict-ignore */ console.log('side'); });",
            ),
        ];
        for source in sources {
            let mut input = request(source, "suppressed.ts");
            input.options.strict_guarantee = false;
            input.options.warnings_as_errors = WarningsAsErrors::Boolean(true);
            let result = compile(input);
            assert!(!result.has_errors(), "{:?}", result.diagnostics);
            assert!(
                result
                    .diagnostics
                    .iter()
                    .all(|diagnostic| diagnostic.code.as_str() != "FICT-M003")
            );
            assert!(!result.code.is_empty());
        }

        let mut prose = request(
            concat!(
                "import { $memo } from 'fict';\n",
                "// documentation mentions fict-ignore-next-line FICT-M003\n",
                "const value = $memo(() => { console.log('side'); });",
            ),
            "prose.ts",
        );
        prose.options.strict_guarantee = false;
        let prose = compile(prose);
        assert!(
            prose
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == "FICT-M003")
        );

        let mut integration = request(
            "export const value = 1; // fict-ignore FICT-R006",
            "integration.js",
        );
        integration.options.strict_guarantee = false;
        integration.options.warnings_as_errors = WarningsAsErrors::Boolean(true);
        integration.integration_diagnostics.push(
            Diagnostic::new(
                DiagnosticCode::new("FICT-R006").expect("diagnostic code"),
                DiagnosticSeverity::Warning,
                "integration warning",
            )
            .with_primary_span(SourceSpan::new(0, 6).expect("source span")),
        );
        let integration = compile(integration);
        assert!(!integration.has_errors(), "{:?}", integration.diagnostics);
        assert!(integration.diagnostics.is_empty());
    }

    #[test]
    fn marks_only_runtime_boundary_reset_callbacks_as_reactive() {
        let result = compile(request(
            "import { $state, ErrorBoundary as Boundary } from 'fict'; import * as Runtime from 'fict'; function UserBoundary(props) { return <section>{props.children}</section>; } function App() { let key = $state(0); return <><Boundary fallback='error' resetKeys={() => key}>ready</Boundary><Runtime.Suspense fallback='loading' resetKeys={() => key}>ready</Runtime.Suspense><UserBoundary resetKeys={() => key}>user</UserBoundary></>; } function Shadow({ ErrorBoundary }) { let key = $state(0); return <ErrorBoundary resetKeys={() => key}>shadow</ErrorBoundary>; }",
            "boundary-reset-keys.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result
                .code
                .matches("resetKeys: __fictReactive(() => key())")
                .count(),
            2,
            "{}",
            result.code
        );
        assert_eq!(
            result
                .code
                .matches("resetKeys: nonReactive(() => key())")
                .count(),
            2,
            "{}",
            result.code
        );
        assert!(
            result.code.contains("import { __fictReactive }"),
            "{}",
            result.code
        );
    }

    #[test]
    fn omits_intrinsic_keys_without_losing_dynamic_key_effects() {
        let result = compile(request(
            "export function Static() { return <p key=\"row\" title=\"ok\" />; } export function Dynamic() { return <div before={before()} key={side()} after={after()} />; }",
            "intrinsic-key.tsx",
        ));
        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result
                .code
                .contains("template(\"<p title=\\\"ok\\\"></p>\")"),
            "{}",
            result.code
        );
        assert!(!result.code.contains("row"), "{}", result.code);
        assert!(!result.code.contains("\"key\""), "{}", result.code);
        assert_eq!(result.code.matches("side()").count(), 2, "{}", result.code);
        let before = (result.code.find("before()"), result.code.rfind("before()"));
        let key = (result.code.find("side()"), result.code.rfind("side()"));
        let after = (result.code.find("after()"), result.code.rfind("after()"));
        assert!(
            before.0 < key.0 && key.0 < after.0 && before.1 < key.1 && key.1 < after.1,
            "{}",
            result.code
        );
    }

    #[test]
    fn emits_fine_grained_ternary_and_logical_conditions() {
        let result = compile(request(
            "import { $state } from 'fict'; const Yes = () => null; const No = () => null; export function App() { let show = $state(true); let count = $state(0); return <main>{show ? <><Yes /></> : <No />}{show && <span>{count}</span>}</main>; }",
            "conditional.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result
                .code
                .contains("template(\"<main><!----><!----><!----><!----></main>\")"),
            "{}",
            result.code
        );
        assert_eq!(
            result.code.matches("= createConditional(").count(),
            2,
            "{}",
            result.code
        );
        assert!(result.code.contains("() => show()"), "{}", result.code);
        assert!(result.code.contains("type: Fragment"), "{}", result.code);
        assert!(result.code.contains("type: Yes"), "{}", result.code);
        assert!(result.code.contains("type: No"), "{}", result.code);
        assert!(result.code.contains("void 0"), "{}", result.code);
        assert!(
            result.code.contains("trackBranchReads: true"),
            "{}",
            result.code
        );
        assert!(
            result.code.matches("onDestroy(").count() >= 2,
            "{}",
            result.code
        );
    }

    #[test]
    fn emits_namespace_aware_conditional_creators() {
        let result = compile(request(
            "const Icon = () => null; export function Svg(show) { return <svg>{show && <Icon />}</svg>; } export function Annotation(props) { return <math><annotation-xml encoding={props.encoding}>{props.show ? <Icon /> : null}</annotation-xml></math>; }",
            "conditional-namespace.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result
                .code
                .contains("createElementInNamespace(__fict_child, \"svg\")"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("createElementInParentNamespace(__fict_child"),
            "{}",
            result.code
        );
    }

    #[test]
    fn preserves_inline_function_component_props_as_values() {
        let result = compile(request(
            "import { $state } from 'fict'; const Card = (_props) => null; export function App() { let count = $state(0); return <Card onSelect={(() => count++) as () => number} />; }",
            "function-component-prop.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(!result.code.contains("__fictProp"), "{}", result.code);
        assert!(
            result.code.contains("onSelect: nonReactive((() =>"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("count(__fict_previous + 1)"),
            "{}",
            result.code
        );
    }

    #[test]
    fn preserves_component_child_laziness_and_function_values() {
        let result = compile(request(
            "const Card = (_props) => null; export function Dynamic(props) { return <Card>hello {props.value}<b>x</b></Card>; } export function Callback(props) { return <Card>{() => props.value}</Card>; } export function Branch(props) { return <Card>{props.show ? <><b>x</b></> : null}</Card>; } export function Render(props) { return <Card view={props.show ? <><i>x</i></> : null} />; }",
            "component-children.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result.code.contains("children: prop(() => [")
                && result.code.contains("\"hello \"")
                && result.code.contains("props.value"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("children: nonReactive(() => props.value)"),
            "{}",
            result.code
        );
        assert!(result.code.contains("type: Fragment"), "{}", result.code);
        assert!(!result.code.contains("<b>"), "{}", result.code);
        assert!(!result.code.contains("<i>"), "{}", result.code);
    }

    #[test]
    fn emits_typescript_jsx_as_ordered_vnode_fallbacks() {
        let mut input = request(
            "type Props = { name: string; value: number; extra: Record<string, unknown> }; const Child = (props: { value: number }) => <em>{props.value}</em>; export function App(props: Props) { return <section id=\"root\" disabled {...props.extra}>Hello {props.name}<Child value={props.value} /></section>; }",
            "component.tsx",
        );
        input.options.fine_grained_dom = false;
        input.options.strict_guarantee = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-J003")
                .count(),
            1
        );
        assert!(!result.code.contains("<section"), "{}", result.code);
        assert!(!result.code.contains("type Props"), "{}", result.code);
        assert!(result.code.contains("type: \"section\""), "{}", result.code);
        assert!(result.code.contains("disabled: true"), "{}", result.code);
        assert!(result.code.contains("...props.extra"), "{}", result.code);
        assert!(result.code.contains("children:"), "{}", result.code);
        assert!(result.code.contains("type: Child"), "{}", result.code);
        assert!(
            result.code.contains("value: __fictProp(() => props.value)"),
            "{}",
            result.code
        );
        assert!(
            !result
                .code
                .contains("value: __fictReactive(() => props.value)"),
            "{}",
            result.code
        );
    }

    #[test]
    fn preserves_reactive_component_inputs_in_vnode_fallbacks() {
        let mut input = request(
            "import { $state } from 'fict'; function Child({ mode, label, children }) { return <span>{mode}:{label}:{children}</span>; } export function App() { let mode = $state(2); let extra = $state({ label: 'two' }); return <Child mode={mode} {...extra}>{mode}</Child>; }",
            "vnode-component-inputs.tsx",
        );
        input.options.fine_grained_dom = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result.code.contains("mode: __fictProp(() => mode())"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("__fictProp(() => extra())"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("children: prop(() => mode())"),
            "{}",
            result.code
        );
        assert!(result.code.contains("mergeProps("), "{}", result.code);
        assert!(
            !result.code.contains("mode: __fictReactive(() => mode())"),
            "{}",
            result.code
        );
    }

    #[test]
    fn rewrites_reactive_vnode_children_and_event_mutations() {
        let mut input = request(
            "import { $state } from 'fict'; export function Counter() { let count = $state(0); return <button onClick={() => count++}>{count}</button>; }",
            "counter.tsx",
        );
        input.options.fine_grained_dom = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.code.contains("onClick: () =>"), "{}", result.code);
        assert!(
            result.code.contains("count(__fict_previous + 1)"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("children: __fictReactive(() => count())"),
            "{}",
            result.code
        );
    }

    #[test]
    fn wraps_reactive_values_in_component_nested_vnodes() {
        let mut input = request(
            "import { $state } from 'fict'; function Frame(props) { return <section>{props.children}</section>; } export function Modal() { let visible = $state(true); let closing = $state(false); let title = $state('A'); if (!visible && !closing) return null; return <Frame><article className={closing ? 'closing' : ''}><h2>{title}</h2></article></Frame>; }",
            "component-nested-vnode.tsx",
        );
        input.options.strict_guarantee = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result
                .code
                .contains("className: __fictReactive(() => closing() ? \"closing\" : \"\")"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("children: __fictReactive(() => title())"),
            "{}",
            result.code
        );
    }

    #[test]
    fn imports_a_collision_free_runtime_fragment_for_short_syntax() {
        let mut input = request(
            "const Fragment = 'local'; export function App() { return <><span>a</span><span>{Fragment}</span></>; }",
            "fragment.jsx",
        );
        input.options.fine_grained_dom = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result.code.contains("Fragment as Fragment_1"),
            "{}",
            result.code
        );
        assert!(result.code.contains("type: Fragment_1"), "{}", result.code);
        assert!(
            result.code.contains("children: Fragment"),
            "{}",
            result.code
        );
    }

    #[test]
    fn imports_fragments_nested_inside_vnode_expression_values() {
        let mut input = request(
            "const View = (props) => props.render; export function App() { return <View render={() => <><i>x</i></>} />; }",
            "nested-fragment.jsx",
        );
        input.options.fine_grained_dom = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result.code.contains("import { Fragment }"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("render: nonReactive(() => ({"),
            "{}",
            result.code
        );
        assert!(result.code.contains("type: Fragment"), "{}", result.code);
        assert!(!result.code.contains("<i>"), "{}", result.code);
    }

    #[test]
    fn preserves_vnode_key_namespaces_and_nested_nodes() {
        let mut input = request(
            "const UI = { Card: (_props) => null }; const id = 'card'; const items = ['a', 'b']; export function App() { return <UI.Card key={id} foo:bar=\"&amp;\" node={<svg:path />} __proto__=\"safe\">{items}</UI.Card>; }",
            "vnode-edges.jsx",
        );
        input.options.fine_grained_dom = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(!result.code.contains("<UI.Card"), "{}", result.code);
        assert!(result.code.contains("type: UI.Card"), "{}", result.code);
        assert!(
            result.code.contains("\"foo:bar\": \"&\""),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("type: \"svg:path\""),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("[\"__proto__\"]: \"safe\""),
            "{}",
            result.code
        );
        assert!(result.code.contains("children: items"), "{}", result.code);
        assert!(result.code.contains("key: id"), "{}", result.code);
    }

    #[test]
    fn rewrites_state_captured_by_effect_callbacks() {
        let mut input = request(
            "import { $state, $effect } from 'fict'; const seen = []; function Component() { let count = $state(0); $effect(() => { seen.push(count); count += 1; }); return count; }",
            "captured.js",
        );
        input.options.strict_guarantee = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.code.contains("__fictUseEffect(__fictCtx"));
        assert!(result.code.contains("seen.push(count())"));
        assert!(result.code.contains("count() + 1"));
        assert!(result.code.contains("return count()"));
    }

    #[test]
    fn wraps_tracked_jsx_statement_expressions_in_effects() {
        let mut input = request(
            r#"
                import { $state } from "fict";
                function useBucket() {
                    const count = $state(2);
                    return { count };
                }
                export function Component() {
                    let count = $state(1);
                    const bucket = useBucket();
                    const log = [];
                    const node = <button onClick={() => log.push(count)}>{count}</button>;
                    log.push("static");
                    log.push(count);
                    log.push({ value: bucket.count });
                    count && log.push(count);
                    log.push.bind(log, count)();
                    try {
                        log.push(count);
                    } catch {}
                    node.props.onClick();
                    return log;
                }
                export function PropsComponent(props) {
                    const log = [];
                    log[0] = props.value;
                    log[1] = "value" in props;
                    props.value && log.push(props.value);
                    return <div>{log.length}</div>;
                }
                export function DestructuredProps({ value }) {
                    const log = [];
                    log[0] = value;
                    return <div>{value}</div>;
                }
            "#,
            "tracked-call-effects.tsx",
        );
        input.options.strict_guarantee = false;
        input.options.fine_grained_dom = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result.code.matches("__fictUseEffect(__fictCtx").count(),
            10,
            "{}",
            result.code
        );
        assert!(
            result.code.contains("log.push(\"static\")"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("() => log.push(count())"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("() => count() && log.push(count())"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("() => log.push.bind(log, count())()"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("() => node().props.onClick()"),
            "{}",
            result.code
        );
    }

    #[test]
    fn unwraps_runtime_accessors_before_member_invocation() {
        let mut input = request(
            r#"
                import { createMemo } from "fict";
                const calls = [];
                export function Component() {
                    const fn = createMemo(() => value => calls.push(value));
                    fn.call(null, "call");
                    fn.apply(null, ["apply"]);
                    fn.bind(null, "bind")();
                    fn?.call(null, "optional");
                    return <div>{fn()("render")}</div>;
                }
            "#,
            "runtime-accessor-members.tsx",
        );
        input.options.strict_guarantee = false;
        input.options.fine_grained_dom = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result.code.matches("__fictUseEffect(__fictCtx").count(),
            4,
            "{}",
            result.code
        );
        assert!(
            result.code.contains("() => fn().call(null"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("() => fn().apply(null"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("() => fn().bind(null"),
            "{}",
            result.code
        );
        assert!(result.code.contains("fn()?.call(null"), "{}", result.code);
        assert!(result.code.contains("fn()(\"render\")"), "{}", result.code);
        assert!(
            !result.code.contains("fn()()(\"render\")"),
            "{}",
            result.code
        );
    }

    #[test]
    fn enforces_nested_state_mutation_guarantees() {
        let source = "import { $state } from 'fict'; function App() { const user = $state({ name: 'Ada' }); user.name = 'Grace'; return user.name; }";
        let strict = compile(request(source, "nested.js"));
        assert!(strict.has_errors());
        assert!(strict.code.is_empty());
        assert!(
            strict
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == "FICT-M")
        );

        let mut fallback_request = request(source, "nested.js");
        fallback_request.options.strict_guarantee = false;
        let fallback = compile(fallback_request);
        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert!(fallback.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-M"
                && diagnostic.severity == DiagnosticSeverity::Warning
        }));
        assert!(fallback.code.contains("user().name = \"Grace\""));
        assert!(fallback.code.contains("return user().name"));

        let mut muted_request = request(source, "nested-muted.js");
        muted_request.options.strict_guarantee = false;
        muted_request
            .options
            .warning_levels
            .insert("FICT-M".into(), WarningLevel::Off);
        let muted = compile(muted_request);
        assert!(!muted.has_errors(), "{:?}", muted.diagnostics);
        assert!(muted.diagnostics.is_empty());

        let mut escalated_request = request(source, "nested-escalated.js");
        escalated_request.options.strict_guarantee = false;
        escalated_request.options.warnings_as_errors =
            WarningsAsErrors::Codes(vec!["FICT-M".into()]);
        let escalated = compile(escalated_request);
        assert!(escalated.has_errors());
        assert!(escalated.code.is_empty());
        assert_eq!(escalated.diagnostics.len(), 1);
        assert_eq!(escalated.diagnostics[0].code.as_str(), "FICT-M");
        assert_eq!(escalated.diagnostics[0].severity, DiagnosticSeverity::Error);
    }

    #[test]
    fn enforces_dynamic_reactive_property_guarantees() {
        let source = "import { $state, $memo, $store } from 'fict'; export function App(props) { const key = 'value'; const state = $state({ value: 1, nested: { value: 2 } }); const memo = $memo(() => ({ value: state.value + 3 })); const alias = state; const nested = state.nested; const bag = { ...state }; const store = $store({ value: 3 }); return <main>{state[key]}:{state?.[key]}:{memo[key]}:{alias[key]}:{nested[key]}:{bag[key]}:{store[key]}:{props[key]}</main>; }";
        let strict = compile(request(source, "dynamic-properties.tsx"));
        assert!(strict.has_errors());
        assert!(strict.code.is_empty());
        assert_eq!(
            strict
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-H")
                .count(),
            8,
            "{:?}",
            strict.diagnostics
        );
        assert!(strict.diagnostics.iter().all(|diagnostic| {
            diagnostic.code.as_str() == "FICT-H"
                && diagnostic.severity == DiagnosticSeverity::Error
                && diagnostic.guarantee_class == GuaranteeClass::Fallback
                && diagnostic.primary_span.is_some()
        }));

        let mut fallback_request = request(source, "dynamic-properties.tsx");
        fallback_request.options.strict_guarantee = false;
        let fallback = compile(fallback_request);
        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert_eq!(
            fallback
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-H")
                .count(),
            8,
            "{:?}",
            fallback.diagnostics
        );
        assert!(
            fallback
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.severity == DiagnosticSeverity::Warning)
        );
        assert!(fallback.code.contains("state()[key]"), "{}", fallback.code);

        let safe = compile(request(
            "import { $state } from 'fict'; export function App() { const state = $state({ value: 1, 0: 'zero' }); const plain = { value: 2 }; const key = 'value'; return <main>{state.value}:{state['value']}:{state[0]}:{plain[key]}</main>; }",
            "static-properties.tsx",
        ));
        assert!(!safe.has_errors(), "{:?}", safe.diagnostics);
        assert!(
            safe.diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code.as_str() != "FICT-H"),
            "{:?}",
            safe.diagnostics
        );

        let mutation_source = "import { $state } from 'fict'; export function App(key) { const state = $state({ value: 1 }); state[key] = 2; return <main>{state.value}</main>; }";
        let mut mutation_request = request(mutation_source, "dynamic-mutation.tsx");
        mutation_request.options.strict_guarantee = false;
        let mutation = compile(mutation_request);
        assert!(!mutation.has_errors(), "{:?}", mutation.diagnostics);
        assert_eq!(
            mutation
                .diagnostics
                .iter()
                .map(|diagnostic| diagnostic.code.as_str())
                .collect::<Vec<_>>(),
            ["FICT-H", "FICT-M"]
        );
    }

    #[test]
    fn enforces_reactive_argument_escape_guarantees() {
        let source = "import { $state, $memo } from 'fict'; function sink(...values) { return values; } class Box { constructor(value) { this.value = value; } } function tag(_parts, value) { return value; } export function App() { const state = $state({ value: 1 }); const doubled = $memo(() => state.value * 2); sink(state); sink([state]); sink(doubled); sink(state.value); sink?.({ value: state }); new Box(state); new Box([state]); tag`${state}`; return null; }";
        let strict = compile(request(source, "reactive-argument-escapes.js"));

        assert!(strict.has_errors());
        assert!(strict.code.is_empty());
        assert_eq!(
            strict
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-S002")
                .count(),
            3,
            "{:?}",
            strict.diagnostics
        );
        assert_eq!(
            strict
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-R002")
                .count(),
            5,
            "{:?}",
            strict.diagnostics
        );
        assert!(strict.diagnostics.iter().all(|diagnostic| {
            diagnostic.severity == DiagnosticSeverity::Error
                && diagnostic.guarantee_class == GuaranteeClass::Fallback
                && diagnostic.primary_span.is_some()
        }));

        let mut fallback_request = request(source, "reactive-argument-escapes.js");
        fallback_request.options.strict_guarantee = false;
        let fallback = compile(fallback_request);
        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert_eq!(fallback.diagnostics.len(), 8, "{:?}", fallback.diagnostics);
        assert!(
            fallback
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.severity == DiagnosticSeverity::Warning)
        );
        assert!(!fallback.code.is_empty());

        let mut muted_request = request(source, "reactive-argument-escapes-muted.js");
        muted_request.options.strict_guarantee = false;
        muted_request
            .options
            .warning_levels
            .insert("FICT-R002".into(), WarningLevel::Off);
        let muted = compile(muted_request);
        assert!(!muted.has_errors(), "{:?}", muted.diagnostics);
        assert!(
            muted
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code.as_str() != "FICT-R002")
        );

        let mut escalated_request = request(source, "reactive-argument-escapes-escalated.js");
        escalated_request.options.strict_guarantee = false;
        escalated_request.options.warnings_as_errors =
            WarningsAsErrors::Codes(vec!["FICT-R002".into()]);
        let escalated = compile(escalated_request);
        assert!(escalated.has_errors());
        assert!(escalated.code.is_empty());
        assert!(escalated.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R002"
                && diagnostic.severity == DiagnosticSeverity::Error
        }));
    }

    #[test]
    fn tracks_local_hook_return_accessors_at_unknown_boundaries() {
        let source = "import { $state } from 'fict'; function sink(value) { return value; } function useBucket() { const count = $state(0); return { count, plain: 7 }; } function useCount() { const count = $state(1); return count; } export function App() { const bucket = useBucket(); const count = useCount(); sink(() => bucket.count); sink(() => count); sink({ value: bucket.count }); sink([count]); sink(bucket.plain); const values = []; values.push(bucket.count); return <div>{bucket.count}:{values.length}</div>; }";
        let mut fallback_request = request(source, "local-hook-return-escapes.jsx");
        fallback_request.options.strict_guarantee = false;
        let fallback = compile(fallback_request);

        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert_eq!(
            fallback
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-R002")
                .count(),
            4,
            "{:?}",
            fallback.diagnostics
        );
        assert_eq!(
            fallback
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-R005")
                .count(),
            4,
            "{:?}",
            fallback.diagnostics
        );
        assert!(
            fallback
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.severity == DiagnosticSeverity::Warning)
        );

        let strict = compile(request(source, "local-hook-return-escapes.jsx"));
        assert!(strict.has_errors(), "{:?}", strict.diagnostics);
        assert!(strict.code.is_empty());
        assert!(strict.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R002"
                && diagnostic.severity == DiagnosticSeverity::Error
        }));
        assert!(strict.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R005"
                && diagnostic.severity == DiagnosticSeverity::Error
        }));
    }

    #[test]
    fn enforces_reactive_jsx_child_write_guarantees() {
        let source = "import { $state } from 'fict'; export function App() { let count = $state(0); let local = 0; return <main>{count++}{count = count + 1}{(count += 1, count)}{() => count++}<button onClick={() => count++}>{local++}</button></main>; }";
        let strict = compile(request(source, "reactive-jsx-write.tsx"));

        assert!(strict.has_errors());
        assert!(strict.code.is_empty());
        assert_eq!(
            strict
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-R007")
                .count(),
            3,
            "{:?}",
            strict.diagnostics
        );
        assert!(strict.diagnostics.iter().all(|diagnostic| {
            diagnostic.severity == DiagnosticSeverity::Error
                && diagnostic.guarantee_class == GuaranteeClass::Fallback
                && diagnostic.primary_span.is_some()
        }));

        let mut fallback_request = request(source, "reactive-jsx-write.tsx");
        fallback_request.options.strict_guarantee = false;
        let fallback = compile(fallback_request);
        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert_eq!(
            fallback
                .diagnostics
                .iter()
                .map(|diagnostic| diagnostic.code.as_str())
                .collect::<Vec<_>>(),
            ["FICT-R007", "FICT-R007", "FICT-R007"]
        );
        assert!(
            fallback
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.severity == DiagnosticSeverity::Warning)
        );
        assert!(!fallback.code.is_empty());

        let mut muted_request = request(source, "reactive-jsx-write-muted.tsx");
        muted_request.options.strict_guarantee = false;
        muted_request
            .options
            .warning_levels
            .insert("FICT-R007".into(), WarningLevel::Off);
        let muted = compile(muted_request);
        assert!(!muted.has_errors(), "{:?}", muted.diagnostics);
        assert!(
            muted
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code.as_str() != "FICT-R007")
        );

        let mut escalated_request = request(source, "reactive-jsx-write-escalated.tsx");
        escalated_request.options.strict_guarantee = false;
        escalated_request.options.warnings_as_errors =
            WarningsAsErrors::Codes(vec!["FICT-R007".into()]);
        let escalated = compile(escalated_request);
        assert!(escalated.has_errors());
        assert!(escalated.code.is_empty());
    }

    #[test]
    fn enforces_native_jsx_spread_guarantees() {
        let source = "function Widget(props) { return <span>{props.title}</span>; } export function App(props) { return <><div {...props} title='demo' {...props} /><Widget {...props} /></>; }";
        let strict = compile(request(source, "native-jsx-spread.tsx"));

        assert!(strict.has_errors());
        assert!(strict.code.is_empty());
        assert_eq!(
            strict
                .diagnostics
                .iter()
                .map(|diagnostic| diagnostic.code.as_str())
                .collect::<Vec<_>>(),
            ["FICT-J003"]
        );
        assert_eq!(strict.diagnostics[0].severity, DiagnosticSeverity::Error);
        assert_eq!(
            strict.diagnostics[0].guarantee_class,
            GuaranteeClass::Fallback
        );
        let spread = strict.diagnostics[0]
            .primary_span
            .expect("native spread span");
        assert_eq!(
            &source[spread.start() as usize..spread.end() as usize],
            "{...props}"
        );

        let mut fallback_request = request(source, "native-jsx-spread.tsx");
        fallback_request.options.strict_guarantee = false;
        let fallback = compile(fallback_request);
        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert_eq!(fallback.diagnostics.len(), 1, "{:?}", fallback.diagnostics);
        assert_eq!(fallback.diagnostics[0].code.as_str(), "FICT-J003");
        assert_eq!(
            fallback.diagnostics[0].severity,
            DiagnosticSeverity::Warning
        );
        assert!(
            fallback.code.contains("spread(__fict_node"),
            "{}",
            fallback.code
        );
    }

    #[test]
    fn diagnoses_inline_non_event_jsx_function_props() {
        let source = "function Button(_props) { return null; } export function Panel({ label, ok, stable }) { return <><Button renderLabel={() => label} /><Button renderLabel={ok && (() => label)} /><Button renderLabel={stable} /><button onClick={() => label} ref={node => node} /></>; }";
        let result = compile(request(source, "inline-function-props.tsx"));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(!result.code.is_empty());
        assert_eq!(
            result
                .diagnostics
                .iter()
                .map(|diagnostic| diagnostic.code.as_str())
                .collect::<Vec<_>>(),
            ["FICT-X003", "FICT-X003"]
        );
        assert!(result.diagnostics.iter().all(|diagnostic| {
            diagnostic.severity == DiagnosticSeverity::Warning
                && diagnostic.guarantee_class == GuaranteeClass::Advisory
        }));

        let mut muted_request = request(source, "inline-function-props-muted.tsx");
        muted_request
            .options
            .warning_levels
            .insert("FICT-X003".into(), WarningLevel::Off);
        let muted = compile(muted_request);
        assert!(!muted.has_errors(), "{:?}", muted.diagnostics);
        assert!(muted.diagnostics.is_empty());

        let mut escalated_request = request(source, "inline-function-props-error.tsx");
        escalated_request
            .options
            .warning_levels
            .insert("FICT-X003".into(), WarningLevel::Error);
        let escalated = compile(escalated_request);
        assert!(escalated.has_errors());
        assert!(escalated.code.is_empty());
    }

    #[test]
    fn enforces_memo_side_effect_guarantee_policy() {
        let source = "import { $memo } from 'fict'; export const value = $memo(() => { fetch('/api'); return 1; });";
        let strict = compile(request(source, "memo-side-effect.ts"));

        assert!(strict.has_errors());
        assert!(strict.code.is_empty());
        assert_eq!(strict.diagnostics.len(), 1, "{:?}", strict.diagnostics);
        assert_eq!(strict.diagnostics[0].code.as_str(), "FICT-M003");
        assert_eq!(strict.diagnostics[0].severity, DiagnosticSeverity::Error);
        assert_eq!(
            strict.diagnostics[0].guarantee_class,
            GuaranteeClass::Fallback
        );
        assert!(strict.diagnostics[0].primary_span.is_some());

        let mut fallback_request = request(source, "memo-side-effect-fallback.ts");
        fallback_request.options.strict_guarantee = false;
        let fallback = compile(fallback_request);
        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert!(!fallback.code.is_empty());
        assert_eq!(fallback.diagnostics.len(), 1, "{:?}", fallback.diagnostics);
        assert_eq!(fallback.diagnostics[0].code.as_str(), "FICT-M003");
        assert_eq!(
            fallback.diagnostics[0].severity,
            DiagnosticSeverity::Warning
        );

        let mut muted_request = request(source, "memo-side-effect-muted.ts");
        muted_request.options.strict_guarantee = false;
        muted_request
            .options
            .warning_levels
            .insert("FICT-M003".into(), WarningLevel::Off);
        let muted = compile(muted_request);
        assert!(!muted.has_errors(), "{:?}", muted.diagnostics);
        assert!(muted.diagnostics.is_empty());
        assert!(!muted.code.is_empty());

        let mut escalated_request = request(source, "memo-side-effect-escalated.ts");
        escalated_request.options.strict_guarantee = false;
        escalated_request
            .options
            .warning_levels
            .insert("FICT-M003".into(), WarningLevel::Error);
        let escalated = compile(escalated_request);
        assert!(escalated.has_errors());
        assert!(escalated.code.is_empty());

        let mut attempted_downgrade = request(source, "memo-side-effect-strict.ts");
        attempted_downgrade
            .options
            .warning_levels
            .insert("FICT-M003".into(), WarningLevel::Warn);
        let attempted_downgrade = compile(attempted_downgrade);
        assert!(attempted_downgrade.has_errors());
        assert_eq!(
            attempted_downgrade.diagnostics[0].severity,
            DiagnosticSeverity::Error
        );
    }

    #[test]
    fn diagnoses_reactive_callback_escape_shapes() {
        let source = "import { $state } from 'fict'; function sink(value) { return value; } export function App() { const count = $state(0); sink(() => count); const named = () => count; sink(named); function hoisted() { return count; } sink(hoisted); const nested = () => () => count; sink(nested); sink({ read: () => count }); sink([() => count]); const callbacks = { ...{ read: () => count } }; sink(callbacks); return null; }";
        let mut input = request(source, "reactive-callback-escapes.js");
        input.options.strict_guarantee = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-R005")
                .count(),
            7,
            "{:?}",
            result.diagnostics
        );
        assert!(result.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R005" && diagnostic.message.contains("count")
        }));

        let object_slots = "import { $state } from 'fict'; function sink(value) { return value; } export function App() { const count = $state(0); sink({ read: () => count }); sink([() => count]); sink(<button onClick={() => count++} />); return null; }";
        let mut object_input = request(object_slots, "reactive-callback-slots.tsx");
        object_input.options.strict_guarantee = false;
        let object_result = compile(object_input);
        assert!(
            !object_result.has_errors(),
            "{:?}",
            object_result.diagnostics
        );
        assert_eq!(
            object_result
                .diagnostics
                .iter()
                .map(|diagnostic| diagnostic.code.as_str())
                .collect::<Vec<_>>(),
            ["FICT-R005", "FICT-R005", "FICT-R005"]
        );
    }

    #[test]
    fn tracks_callback_alias_class_and_producer_shapes() {
        let source = "import { $state } from 'fict'; function sink(value) { return value; } export function App() { const count = $state(0); sink(hoisted); function hoisted() { return count; } const callbacks = { read: () => count, value: 1 }; sink(callbacks.read); const alias = callbacks.read; sink(alias); const shorthandRead = () => count; const shorthand = { shorthandRead }; sink(shorthand.shorthandRead); const assigned = {}; assigned.read = shorthandRead; sink(assigned.read); class MethodBox { read() { return count; } } const methodBox = new MethodBox(); sink(methodBox.read); class FieldBox { read = () => count; } const fieldBox = new FieldBox(); sink(fieldBox.read); class StaticBox { static read() { return count; } } sink(StaticBox.read); class GetterBox { get read() { return () => count; } } const getterBox = new GetterBox(); sink(getterBox.read); const methodAlias = methodBox.read; sink(methodAlias); sink((() => () => count)()); function makeRead() { return () => count; } sink(makeRead()); sink(true ? () => count : () => 0); sink(true && (() => count)); sink((0, () => count)); Promise.resolve(1).then(() => count); sink(callbacks.value); return null; }";
        let mut input = request(source, "callback-shape-matrix.js");
        input.options.strict_guarantee = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-R005")
                .count(),
            16,
            "{:?}",
            result.diagnostics
        );
        let plain_property_start = source
            .rfind("callbacks.value")
            .expect("plain property span") as u32;
        assert!(result.diagnostics.iter().all(|diagnostic| {
            diagnostic.code.as_str() != "FICT-R005"
                || diagnostic
                    .primary_span
                    .is_none_or(|span| span.start() != plain_property_start)
        }));
    }

    #[test]
    fn preserves_binding_aware_escape_host_identity() {
        let source = "import { $state, $store, batch as runtimeBatch, render as runtimeRender } from 'fict'; function sink(value) { return value; } function render(value) { return value; } function batch(callback) { return callback; } export function App() { const count = $state(0); const stateItems = $state([1, 2]); const storeItems = $store([1, 2]); let mutableItems = $state([1, 2]); mutableItems = [3]; stateItems.map(() => count); storeItems.forEach(() => count); mutableItems.map(() => count); runtimeBatch(() => count); runtimeRender(count); render(count); batch(() => count); console.log(count); sink([count]); return null; } export function Shadow() { const count = $state(0); const console = { log(value) { return value; } }; console.log([count]); return null; }";
        let mut input = request(source, "escape-host-identity.js");
        input.options.strict_guarantee = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-S002")
                .count(),
            2,
            "{:?}",
            result.diagnostics
        );
        assert_eq!(
            result
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-R002")
                .count(),
            4,
            "{:?}",
            result.diagnostics
        );
        assert_eq!(
            result
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-R005")
                .count(),
            2,
            "{:?}",
            result.diagnostics
        );
    }

    #[test]
    fn preserves_known_reactive_escape_boundaries() {
        let source = "import { $state, $store, batch, untrack, createEffect, render } from 'fict'; function sink(value) { return value; } function useValue(value) { return value; } export function App(items) { const count = $state(0); const local = [1, 2, 3]; $store({ value: count }); useValue(count); batch(() => count); untrack(() => count); createEffect(() => count); local.map(() => count); [1, 2].forEach(() => count); items.map(() => count); console.log(count); render(count); sink([count]); return null; }";
        let mut input = request(source, "known-escape-boundaries.js");
        input.options.strict_guarantee = false;
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(
            result
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-S002")
                .count(),
            1,
            "{:?}",
            result.diagnostics
        );
        assert_eq!(
            result
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-R002")
                .count(),
            2,
            "{:?}",
            result.diagnostics
        );
        assert_eq!(
            result
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == "FICT-R005")
                .count(),
            1,
            "{:?}",
            result.diagnostics
        );

        let configured = "import { $state } from 'fict'; function reactiveScope(callback) { return callback(); } function sink(value) { return value; } export function App() { const count = $state(0); reactiveScope(() => { sink([count]); return count; }); return null; }";
        let mut configured_input = request(configured, "configured-reactive-scope.js");
        configured_input.options.strict_guarantee = false;
        configured_input.options.reactive_scopes = vec!["reactiveScope".into()];
        let configured_result = compile(configured_input);
        assert!(
            !configured_result.has_errors(),
            "{:?}",
            configured_result.diagnostics
        );
        assert_eq!(
            configured_result
                .diagnostics
                .iter()
                .map(|diagnostic| diagnostic.code.as_str())
                .collect::<Vec<_>>(),
            ["FICT-R002"]
        );
    }

    #[test]
    fn configured_member_optional_and_global_scopes_preserve_strict_boundaries() {
        let cases = [
            (
                "configured-member-scope.js",
                "import { $state } from 'fict'; import * as utils from './host'; utils.renderHook(() => { const count = $state(1); return count; });",
            ),
            (
                "configured-optional-member-scope.js",
                "import { $state } from 'fict'; import * as utils from './host'; utils?.renderHook(() => { const count = $state(1); return count; });",
            ),
            (
                "configured-global-scope.js",
                "import { $state } from 'fict'; globalRenderHook(() => { const count = $state(1); return count; });",
            ),
        ];
        for (filename, source) in cases {
            let mut input = request(source, filename);
            input.options.reactive_scopes = vec!["renderHook".into(), "globalRenderHook".into()];
            let result = compile(input);
            assert!(!result.has_errors(), "{filename}: {:?}", result.diagnostics);
            assert!(
                result.diagnostics.iter().all(|diagnostic| !matches!(
                    diagnostic.code.as_str(),
                    "FICT-R002" | "FICT-R005"
                )),
                "{filename}: {:?}",
                result.diagnostics
            );
            assert!(
                result.code.contains("__fictUseSignal"),
                "{filename}: {}",
                result.code
            );
        }
    }

    #[cfg(not(feature = "preview"))]
    #[test]
    fn rejects_preview_options_until_the_optional_pass_graph_is_connected() {
        let mut input = request("export const value = 1", "preview.js");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            ..CompilerPreviewOptions::default()
        });
        let result = compile(input);

        assert!(result.has_errors());
        assert!(result.code.is_empty());
        assert_eq!(
            result.diagnostics[0].code.as_str(),
            "FICT-PREVIEW-UNAVAILABLE"
        );
    }

    #[cfg(feature = "preview")]
    #[test]
    fn accepts_preview_options_when_the_optional_pass_graph_is_enabled() {
        let mut input = request("export const value = 1", "preview.js");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            ..CompilerPreviewOptions::default()
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.code.contains("export const value = 1"));
    }

    #[cfg(feature = "preview")]
    #[test]
    fn emits_structured_preview_handlers_and_component_resume_entries() {
        let source = "import { $state } from 'fict'; export function App() { const count = $state(0); return <button onClick$={(event) => { event.preventDefault(); count++; }}>{count}</button>; }";
        let mut input = request(source, "preview-handler.tsx");
        input.public_module_id = Some("/src/preview-handler.tsx".into());
        input.options.sourcemap = true;
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: false,
            ..CompilerPreviewOptions::default()
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.code.contains("setAttribute(\"on:click\""));
        assert!(result.code.contains("fict:compiler-artifact:handler-0"));
        assert!(result.code.contains("\"default\", \"pd\""));
        assert!(result.code.contains("export const __fict_r0"));
        assert!(result.code.contains("/src/preview-handler.tsx"));
        assert_eq!(result.artifacts.len(), 1);
        let artifact = &result.artifacts[0];
        assert_eq!(artifact.id, "handler-0");
        assert!(artifact.code.contains("export default"));
        assert!(
            artifact.code.contains("__fictUseLexicalScope"),
            "{}",
            artifact.code
        );
        assert!(artifact.map.is_some());
        let handler = artifact.handler.as_ref().expect("handler routing metadata");
        assert_eq!(handler.source_export_name, "__fict_e0");
        assert_eq!(handler.artifact_export_name, "default");
        assert_eq!(handler.module_specifier, "fict:compiler-artifact:handler-0");
        assert_eq!(
            &source[handler.source_span.start() as usize..handler.source_span.end() as usize],
            "(event) => { event.preventDefault(); count++; }"
        );
    }

    #[cfg(feature = "preview")]
    #[test]
    fn transforms_preview_handlers_with_source_spans_beyond_the_artifact_wrapper() {
        let source = format!(
            "/* {} */\nexport function App() {{ return <button onClick$={{(event: MouseEvent) => event.preventDefault()}}>Deploy</button>; }}",
            "padding".repeat(512)
        );
        let mut input = request(&source, "preview-long-handler-offset.tsx");
        input.options.sourcemap = true;
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: false,
            ..CompilerPreviewOptions::default()
        });

        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        let artifact = result.artifacts.first().expect("one handler artifact");
        assert!(artifact.code.contains("event.preventDefault()"));
        assert!(!artifact.code.contains("MouseEvent"));
        assert!(artifact.map.is_some());
    }

    #[cfg(feature = "preview")]
    #[test]
    fn scopes_preview_prevent_default_detection_to_the_event_parameter() {
        let source = r#"
            export function App() {
                return <div>
                    <button onClick$={(event) => { (() => event.preventDefault())(); }} />
                    <button onClick$={(event) => { ((event) => event.preventDefault())({ preventDefault() {} }); }} />
                    <button onClick$={(event) => { (({ event }) => event.preventDefault())({ event: { preventDefault() {} } }); }} />
                    <button onClick$={(event) => { ({ preventDefault() {} }).preventDefault(); }} />
                </div>;
            }
        "#;
        let mut input = request(source, "preview-prevent-default-scope.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: false,
            ..CompilerPreviewOptions::default()
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(result.artifacts.len(), 4);
        assert_eq!(result.code.matches("\"default\", \"pd\"").count(), 2);
        assert!(
            result
                .code
                .contains("__fictQrl(\"fict:compiler-artifact:handler-0\", \"default\", \"pd\")"),
            "{}",
            result.code
        );
        for handler in 1..=3 {
            assert!(
                result.code.contains(&format!(
                    "__fictQrl(\"fict:compiler-artifact:handler-{handler}\", \"default\")"
                )),
                "{}",
                result.code
            );
        }
    }

    #[cfg(feature = "preview")]
    #[test]
    fn marks_prevent_default_for_referenced_preview_handlers() {
        let source = r#"
            function moduleHandler(event) { event["preventDefault"](); }
            export function App() {
                const localHandler = event => event.preventDefault();
                const shadowedHandler = event => ((event) => event.preventDefault())({ preventDefault() {} });
                return <>
                    <button onClick$={moduleHandler}>Module</button>
                    <button onClick$={localHandler}>Local</button>
                    <button onClick$={shadowedHandler}>Shadowed</button>
                </>;
            }
        "#;
        let mut input = request(source, "preview-prevent-default-reference.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: false,
            ..CompilerPreviewOptions::default()
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(result.artifacts.len(), 3);
        assert_eq!(result.code.matches("\"default\", \"pd\"").count(), 2);
        for handler in 0..=1 {
            assert!(
                result.code.contains(&format!(
                    "__fictQrl(\"fict:compiler-artifact:handler-{handler}\", \"default\", \"pd\")"
                )),
                "{}",
                result.code
            );
        }
        assert!(
            result
                .code
                .contains("__fictQrl(\"fict:compiler-artifact:handler-2\", \"default\")"),
            "{}",
            result.code
        );
    }

    #[cfg(feature = "preview")]
    #[test]
    fn emits_preview_vnode_qrls_with_prop_and_module_capture_artifacts() {
        let source = "const moduleHelper = () => 1; export function App({ label = 'fallback' }) { return <button on:click$={() => { moduleHelper(); console.log(label); }}>{label}</button>; }";
        let mut input = request(source, "preview-vnode.tsx");
        input.options.fine_grained_dom = false;
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: false,
            ..CompilerPreviewOptions::default()
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.code.contains("\"attr:on:click\""), "{}", result.code);
        assert!(
            result
                .code
                .contains("export { moduleHelper as __fict_dep_0 }")
        );
        let artifact = result.artifacts.first().expect("one handler artifact");
        assert!(artifact.code.contains("__fictGetScopeProps"));
        assert!(artifact.code.contains("__fict_dep_0 as moduleHelper"));
        assert!(artifact.code.contains("label = () =>"));
    }

    #[cfg(feature = "preview")]
    #[test]
    fn restores_factory_expression_dependencies_in_preview_artifacts() {
        let source = "const makeHandler = () => event => event.type; export function App({ enabled = true }) { return <button onClick$={enabled ? makeHandler() : makeHandler()}>{enabled}</button>; }";
        let mut input = request(source, "preview-handler-factory.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: false,
            ..CompilerPreviewOptions::default()
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(result.artifacts.len(), 1);
        assert!(
            result
                .code
                .contains("export { makeHandler as __fict_dep_0 }"),
            "{}",
            result.code
        );
        let artifact = &result.artifacts[0].code;
        assert!(
            artifact.contains("__fict_dep_0 as makeHandler"),
            "{artifact}"
        );
        assert!(artifact.contains("const enabled = () =>"), "{artifact}");
        assert!(
            artifact.contains("enabled() ? makeHandler() : makeHandler()"),
            "{artifact}"
        );
    }

    #[cfg(feature = "preview")]
    #[test]
    fn rejects_unrestorable_factory_expression_dependencies() {
        let source = "const makeHandler = value => () => value; export function App() { const local = Math.random(); return <button onClick$={makeHandler(local)}>Click</button>; }";
        let mut input = request(source, "preview-handler-factory-local.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: false,
            ..CompilerPreviewOptions::default()
        });
        let result = compile(input);

        assert!(result.has_errors());
        assert!(result.code.is_empty());
        assert_eq!(result.diagnostics[0].code.as_str(), "FICT-PREVIEW-CAPTURE");
        assert!(result.diagnostics[0].message.contains("local"));
    }

    #[cfg(feature = "preview")]
    #[test]
    fn rejects_factory_expressions_that_call_function_props() {
        let source = "export function App({ createHandler }) { return <button onClick$={createHandler('label')}>Click</button>; }";
        let mut input = request(source, "preview-handler-factory-prop.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: false,
            ..CompilerPreviewOptions::default()
        });
        let result = compile(input);

        assert!(result.has_errors());
        assert!(result.code.is_empty());
        assert_eq!(
            result.diagnostics[0].code.as_str(),
            "FICT-PREVIEW-PROP-CALL"
        );
        assert!(result.diagnostics[0].message.contains("createHandler"));
    }

    #[cfg(feature = "preview")]
    #[test]
    fn restores_component_prop_rest_objects_in_preview_artifacts() {
        let source = "export function Button({ id, kind, ...rest }) { return <button onClick$={() => console.log(rest.title)}>Click</button>; }";
        let mut input = request(source, "preview-prop-rest.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: false,
            ..CompilerPreviewOptions::default()
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        let artifact = result
            .artifacts
            .first()
            .expect("prop-rest handler artifact");
        assert!(
            artifact.code.contains("__fictPropsRest"),
            "{}",
            artifact.code
        );
        assert!(
            artifact
                .code
                .contains("const rest = __fictPropsRest(__scopeProps, [\"id\", \"kind\"]);"),
            "{}",
            artifact.code
        );
        assert!(artifact.code.contains("rest.title"), "{}", artifact.code);
    }

    #[cfg(feature = "preview")]
    #[test]
    fn restores_transitive_prop_default_dependencies_in_preview_artifacts() {
        let source = "const moduleDefault = () => 'module'; export function Button({ a, b = a, fn, fnResult = fn(), label = moduleDefault() }) { return <button onClick$={() => console.log(b, fnResult, label)}>Click</button>; }";
        let mut input = request(source, "preview-prop-default-dependencies.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: false,
            ..CompilerPreviewOptions::default()
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result
                .code
                .contains("export { moduleDefault as __fict_dep_0 }"),
            "{}",
            result.code
        );
        let artifact = result.artifacts.first().expect("prop-default artifact");
        assert!(
            artifact
                .code
                .contains("const a = () => __scopeProps[\"a\"]"),
            "{}",
            artifact.code
        );
        assert!(
            artifact.code.contains("const b = () =>") && artifact.code.contains("a()"),
            "{}",
            artifact.code
        );
        assert!(
            artifact.code.contains("const fn = __scopeProps[\"fn\"]"),
            "{}",
            artifact.code
        );
        assert!(
            artifact.code.contains("const fnResult = () =>") && artifact.code.contains("fn()"),
            "{}",
            artifact.code
        );
        assert!(
            artifact.code.contains("__fict_dep_0 as moduleDefault")
                && artifact.code.contains("moduleDefault()"),
            "{}",
            artifact.code
        );
        assert!(
            artifact
                .code
                .contains("console.log(b(), fnResult(), label())"),
            "{}",
            artifact.code
        );
    }

    #[cfg(feature = "preview")]
    #[test]
    fn rejects_preview_handlers_that_call_function_props() {
        for (name, source, expected) in [
            (
                "member",
                "export function Button(props) { return <button onClick$={() => props.onClick()}>Click</button>; }",
                "props.onClick",
            ),
            (
                "optional-nested",
                "export function Button(props) { return <button onClick$={() => props.handlers.save?.()}>Click</button>; }",
                "props.handlers.save",
            ),
            (
                "destructured",
                "export function Button({ onClick }) { return <button onClick$={() => onClick()}>Click</button>; }",
                "onClick",
            ),
            (
                "local-handler",
                "export function Button(props) { const handler = () => props.onClick(); return <button onClick$={handler}>Click</button>; }",
                "props.onClick",
            ),
            (
                "returned-closure",
                "export function Button(props) { return <button onClick$={() => () => props.onClick()}>Click</button>; }",
                "props.onClick",
            ),
            (
                "optional-destructured",
                "export function Button({ onClick }) { return <button onClick$={() => onClick?.()}>Click</button>; }",
                "onClick",
            ),
        ] {
            let mut input = request(source, &format!("preview-function-prop-{name}.tsx"));
            input.options.preview = Some(CompilerPreviewOptions {
                resumable: true,
                auto_extract_handlers: false,
                ..CompilerPreviewOptions::default()
            });
            let result = compile(input);

            assert!(result.has_errors(), "{name}: {:?}", result.diagnostics);
            assert!(result.code.is_empty(), "{name}: {}", result.code);
            assert!(
                result.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code.as_str() == "FICT-PREVIEW-PROP-CALL"
                        && diagnostic.message.contains(expected)
                }),
                "{name}: {:?}",
                result.diagnostics
            );
        }
    }

    #[cfg(feature = "preview")]
    #[test]
    fn keeps_auto_handlers_that_call_function_props_eager() {
        let source = "export function Button(props) { return <button onClick={() => { if (props.enabled) props.onClick(); }}>Click</button>; }";
        let mut input = request(source, "preview-function-prop-auto.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: true,
            auto_extract_threshold: 1,
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.artifacts.is_empty(), "{:?}", result.artifacts);
        assert!(result.code.contains("addEventListener"), "{}", result.code);
        assert!(
            !result.code.contains("fict:compiler-artifact:"),
            "{}",
            result.code
        );
    }

    #[cfg(feature = "preview")]
    #[test]
    fn auto_extracts_semantically_expensive_and_stable_handlers() {
        let source = r#"
            const moduleHandler = () => 1;
            export function App() {
                const localHandler = () => 2;
                return <>
                    <button onClick={() => console.log('external')}>External</button>
                    <button onClick={async () => await fetch('/data')}>Async</button>
                    <button onClick={() => import('./lazy-handler.js')}>Import</button>
                    <button onClick={moduleHandler}>Module</button>
                    <button onClick={localHandler}>Local</button>
                    <button onClick={() => 1}>Simple</button>
                </>;
            }
        "#;
        let mut input = request(source, "preview-auto-semantics.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: true,
            auto_extract_threshold: 1_000,
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(result.artifacts.len(), 5, "{:?}", result.artifacts);
        for handler in 0..5 {
            assert!(
                result
                    .code
                    .contains(&format!("fict:compiler-artifact:handler-{handler}")),
                "{}",
                result.code
            );
        }
        assert!(result.code.contains("addEventListener"), "{}", result.code);
        assert!(
            result.artifacts[2]
                .code
                .contains("import(\"./lazy-handler.js\")"),
            "{}",
            result.artifacts[2].code
        );
        assert!(
            result.artifacts[4]
                .code
                .contains("const localHandler = () => 2"),
            "{}",
            result.artifacts[4].code
        );
    }

    #[cfg(feature = "preview")]
    #[test]
    fn auto_extracts_complex_non_function_handler_expressions() {
        let source = "const first = () => 1; const second = () => 2; export function App({ enabled }) { return <button onClick={enabled ? first : second}>Click</button>; }";
        let mut input = request(source, "preview-auto-expression.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: true,
            auto_extract_threshold: 1,
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(result.artifacts.len(), 1, "{:?}", result.artifacts);
        let artifact = &result.artifacts[0].code;
        assert!(
            artifact.contains("enabled() ? first : second"),
            "{artifact}"
        );
        assert!(artifact.contains("__fict_dep_0 as first"), "{artifact}");
        assert!(artifact.contains("__fict_dep_1 as second"), "{artifact}");
    }

    #[cfg(feature = "preview")]
    #[test]
    fn rejects_explicit_preview_event_options() {
        for (attribute, expected) in [
            ("onClickCapture$", "capture"),
            ("onClickPassive$", "passive"),
            ("onClickOnce$", "once"),
            ("onClickCapturePassiveOnce$", "capture, passive, once"),
        ] {
            for fine_grained_dom in [true, false] {
                let source = format!(
                    "export function Button() {{ return <button {attribute}={{() => console.log('x')}}>Click</button>; }}"
                );
                let mut input = request(&source, "preview-event-options.tsx");
                input.options.fine_grained_dom = fine_grained_dom;
                input.options.preview = Some(CompilerPreviewOptions {
                    resumable: true,
                    auto_extract_handlers: false,
                    ..CompilerPreviewOptions::default()
                });
                let result = compile(input);

                assert!(
                    result.has_errors(),
                    "{attribute}/{fine_grained_dom}: {:?}",
                    result.diagnostics
                );
                assert!(result.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code.as_str() == "FICT-PREVIEW-EVENT-OPTIONS"
                        && diagnostic.message.contains(expected)
                }));
            }
        }
    }

    #[cfg(feature = "preview")]
    #[test]
    fn rejects_explicit_preview_events_unobserved_by_default_loader() {
        for attribute in ["onSubmit$", "onChange$", "onFocus$", "onBlur$", "onScroll$"] {
            let source = format!(
                "export function Form() {{ return <form {attribute}={{() => console.log('x')}}>Save</form>; }}"
            );
            let mut input = request(&source, "preview-unobserved-event.tsx");
            input.options.preview = Some(CompilerPreviewOptions {
                resumable: true,
                auto_extract_handlers: false,
                ..CompilerPreviewOptions::default()
            });
            let result = compile(input);

            assert!(result.has_errors(), "{attribute}: {:?}", result.diagnostics);
            assert!(result.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-PREVIEW-EVENT-LOADER"
                    && diagnostic
                        .message
                        .contains("not observed by the default loader")
            }));
        }
    }

    #[cfg(feature = "preview")]
    #[test]
    fn keeps_auto_event_options_and_unobserved_events_eager() {
        for (name, attribute, expected) in [
            ("capture", "onClickCapture", "capture: true"),
            ("submit", "onSubmit", "\"submit\""),
        ] {
            let source = format!(
                "export function Form() {{ return <form {attribute}={{() => {{ console.log('before'); console.log('after'); }}}}>Save</form>; }}"
            );
            let mut input = request(&source, &format!("preview-event-eager-{name}.tsx"));
            input.options.preview = Some(CompilerPreviewOptions {
                resumable: true,
                auto_extract_handlers: true,
                auto_extract_threshold: 1,
            });
            let result = compile(input);

            assert!(!result.has_errors(), "{name}: {:?}", result.diagnostics);
            assert!(
                result.artifacts.is_empty(),
                "{name}: {:?}",
                result.artifacts
            );
            assert!(result.code.contains("bindEvent"), "{name}: {}", result.code);
            assert!(result.code.contains(expected), "{name}: {}", result.code);
            assert!(
                !result.code.contains("fict:compiler-artifact:"),
                "{name}: {}",
                result.code
            );
        }
    }

    #[cfg(feature = "preview")]
    #[test]
    fn rejects_non_serializable_signal_captures_in_preview_handlers() {
        for (name, source, signal) in [
            (
                "function",
                "import { $state } from 'fict'; export function App() { const callback = $state(() => 'hit'); return <button onClick$={() => console.log(typeof callback())}>Click</button>; }",
                "callback",
            ),
            (
                "object-function",
                "import { $state } from 'fict'; export function App() { const state = $state({ label: 'x', run: () => 'hit' }); return <button onClick$={() => console.log(state().label)}>Click</button>; }",
                "state",
            ),
            (
                "array-function",
                "import { $state } from 'fict'; export function App() { const state = $state([1, () => 'hit']); return <button onClick$={() => console.log(state()[0])}>Click</button>; }",
                "state",
            ),
            (
                "object-getter",
                "import { $state } from 'fict'; export function App() { const state = $state({ get value() { return 1; } }); return <button onClick$={() => console.log(state().value)}>Click</button>; }",
                "state",
            ),
            (
                "setter-assignment",
                "import { $state } from 'fict'; export function App() { const callback = $state(null); callback(() => 'hit'); return <button onClick$={() => console.log(typeof callback())}>Click</button>; }",
                "callback",
            ),
        ] {
            let mut input = request(source, &format!("preview-signal-{name}.tsx"));
            input.options.preview = Some(CompilerPreviewOptions {
                resumable: true,
                auto_extract_handlers: false,
                ..CompilerPreviewOptions::default()
            });
            let result = compile(input);

            assert!(result.has_errors(), "{name}: {:?}", result.diagnostics);
            assert!(result.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-PREVIEW-CAPTURE"
                    && diagnostic.message.contains(&format!("signals: {signal}"))
            }));
        }
    }

    #[cfg(feature = "preview")]
    #[test]
    fn rejects_preview_handlers_that_capture_outer_signals() {
        let source = "import { $state } from 'fict'; export function Outer() { const count = $state(0); function Inner() { return <button onClick$={() => console.log(count())}>Click</button>; } return <Inner />; }";
        let mut input = request(source, "preview-outer-signal.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: false,
            ..CompilerPreviewOptions::default()
        });
        let result = compile(input);

        assert!(result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-PREVIEW-CAPTURE"
                    && diagnostic.message.contains("outer signals: count")
            }),
            "{:?}",
            result.diagnostics
        );
    }

    #[cfg(feature = "preview")]
    #[test]
    fn keeps_auto_non_serializable_signal_handlers_eager() {
        let source = "import { $state } from 'fict'; export function App() { const callback = $state(() => 'hit'); return <button onClick={() => { console.log(typeof callback()); console.log('again'); }}>Click</button>; }";
        let mut input = request(source, "preview-signal-auto.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: true,
            auto_extract_threshold: 1,
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.artifacts.is_empty(), "{:?}", result.artifacts);
        assert!(result.code.contains("addEventListener"), "{}", result.code);
    }

    #[cfg(feature = "preview")]
    #[test]
    fn keeps_auto_outer_signal_handlers_eager() {
        let source = "import { $state } from 'fict'; export function Outer() { const count = $state(0); function Inner() { return <button onClick={() => { console.log(count()); console.log('again'); }}>Click</button>; } return <Inner />; }";
        let mut input = request(source, "preview-outer-signal-auto.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: true,
            auto_extract_threshold: 1,
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.artifacts.is_empty(), "{:?}", result.artifacts);
        assert!(result.code.contains("addEventListener"), "{}", result.code);
    }

    #[cfg(feature = "preview")]
    #[test]
    fn rejects_preview_handlers_that_capture_keyed_list_aliases() {
        let source = "import { $state } from 'fict'; const remove = id => id; export function App() { const rows = $state([]); return <ul>{rows.map((row, index) => <li key={row.id}><button onClick$={() => remove(row.id + index)}>X</button></li>)}</ul>; }";
        let mut input = request(source, "preview-keyed-alias.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: false,
            ..CompilerPreviewOptions::default()
        });
        let result = compile(input);

        assert!(result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.code.is_empty(), "{}", result.code);
        assert!(
            result.diagnostics.iter().any(|diagnostic| {
                diagnostic.code.as_str() == "FICT-PREVIEW-CAPTURE"
                    && diagnostic.message.contains("non-serializable locals:")
                    && diagnostic.message.contains("row")
                    && diagnostic.message.contains("index")
            }),
            "{:?}",
            result.diagnostics
        );
    }

    #[cfg(feature = "preview")]
    #[test]
    fn keeps_auto_keyed_list_alias_handlers_eager() {
        let source = "import { $state } from 'fict'; const remove = id => id; export function App() { const rows = $state([]); return <ul>{rows.map((row, index) => <li key={row.id}><button onClick={() => remove(row.id + index)}>X</button></li>)}</ul>; }";
        let mut input = request(source, "preview-keyed-alias-auto.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: true,
            auto_extract_threshold: 1,
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.artifacts.is_empty(), "{:?}", result.artifacts);
        assert!(result.code.contains("createKeyedList"), "{}", result.code);
        assert!(result.code.contains("addEventListener"), "{}", result.code);
        assert!(!result.code.contains("fict:compiler-artifact:"));
    }

    #[cfg(feature = "preview")]
    #[test]
    fn rejects_explicit_preview_handlers_that_capture_lexical_execution_context() {
        for (name, source, expected) in [
            (
                "this",
                "export function App() { return <button onClick$={() => this}>Click</button>; }",
                "this",
            ),
            (
                "arguments-ref",
                "export function App() { const handler = () => arguments.length; return <button onClick$={handler}>Click</button>; }",
                "arguments",
            ),
            (
                "new-target-ref",
                "export function App() { const handler = () => new.target; return <button onClick$={handler}>Click</button>; }",
                "new.target",
            ),
            (
                "factory-this",
                "const make = value => () => value; export function App() { return <button onClick$={make(this)}>Click</button>; }",
                "this",
            ),
        ] {
            let mut input = request(source, &format!("preview-context-{name}.tsx"));
            input.options.preview = Some(CompilerPreviewOptions {
                resumable: true,
                auto_extract_handlers: false,
                ..CompilerPreviewOptions::default()
            });
            let result = compile(input);

            assert!(result.has_errors(), "{name}: {:?}", result.diagnostics);
            assert!(result.code.is_empty(), "{name}: {}", result.code);
            assert!(
                result.artifacts.is_empty(),
                "{name}: {:?}",
                result.artifacts
            );
            assert!(
                result.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code.as_str() == "FICT-PREVIEW-CONTEXT"
                        && diagnostic.message.contains(expected)
                }),
                "{name}: {:?}",
                result.diagnostics
            );
        }
    }

    #[cfg(feature = "preview")]
    #[test]
    fn rejects_explicit_preview_member_handler_values_at_render_boundary() {
        for (name, source) in [
            (
                "module-member",
                "const holder = { get handler() { return () => 1; } }; export function App() { return <button onClick$={holder.handler}>Click</button>; }",
            ),
            (
                "optional-member",
                "const holder = { handler: () => 1 }; export function App() { return <button onClick$={holder?.handler}>Click</button>; }",
            ),
            (
                "local-member",
                "export function App() { const holder = { handler: () => 1 }; return <button onClick$={holder.handler}>Click</button>; }",
            ),
        ] {
            let mut input = request(source, &format!("preview-member-{name}.tsx"));
            input.options.preview = Some(CompilerPreviewOptions {
                resumable: true,
                auto_extract_handlers: false,
                ..CompilerPreviewOptions::default()
            });
            let result = compile(input);

            assert!(result.has_errors(), "{name}: {:?}", result.diagnostics);
            assert!(result.code.is_empty(), "{name}: {}", result.code);
            assert!(
                result.artifacts.is_empty(),
                "{name}: {:?}",
                result.artifacts
            );
            assert!(
                result.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code.as_str() == "FICT-PREVIEW-HANDLER"
                        && diagnostic.message.contains("member-expression")
                }),
                "{name}: {:?}",
                result.diagnostics
            );
        }
    }

    #[cfg(feature = "preview")]
    #[test]
    fn keeps_auto_preview_member_handler_values_eager() {
        let source = "const holder = { handler: () => 1 }; export function App() { return <button onClick={holder.handler}>Click</button>; }";
        let mut input = request(source, "preview-member-auto.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: true,
            auto_extract_threshold: 1,
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.artifacts.is_empty(), "{:?}", result.artifacts);
        assert!(
            !result.code.contains("fict:compiler-artifact:"),
            "{}",
            result.code
        );
        assert!(result.code.contains("addEventListener"), "{}", result.code);
    }

    #[cfg(feature = "preview")]
    #[test]
    fn rejects_mutable_module_preview_handler_identifiers() {
        for (name, source) in [
            (
                "let",
                "export let handler = () => 1; export function swap() { handler = () => 2; } export function App() { return <button onClick$={handler}>Click</button>; }",
            ),
            (
                "var",
                "var handler = () => 1; export function App() { return <button onClick$={handler}>Click</button>; }",
            ),
            (
                "import",
                "import { handler } from './handlers'; export function App() { return <button onClick$={handler}>Click</button>; }",
            ),
        ] {
            let mut input = request(source, &format!("preview-module-handler-{name}.tsx"));
            input.options.preview = Some(CompilerPreviewOptions {
                resumable: true,
                auto_extract_handlers: false,
                ..CompilerPreviewOptions::default()
            });
            let result = compile(input);

            assert!(result.has_errors(), "{name}: {:?}", result.diagnostics);
            assert!(result.code.is_empty(), "{name}: {}", result.code);
            assert!(
                result.artifacts.is_empty(),
                "{name}: {:?}",
                result.artifacts
            );
            assert!(
                result.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code.as_str() == "FICT-PREVIEW-HANDLER"
                        && diagnostic
                            .message
                            .contains("mutable module handler identifier")
                }),
                "{name}: {:?}",
                result.diagnostics
            );
        }
    }

    #[cfg(feature = "preview")]
    #[test]
    fn imports_stable_module_preview_handler_identifiers_into_artifacts() {
        let source = "const constHandler = () => 'const'; function declaredHandler() { return 'declared'; } export function App() { return <><button onClick$={constHandler}>Const</button><button onClick$={declaredHandler}>Declared</button></>; }";
        let mut input = request(source, "preview-stable-module-handler.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: false,
            ..CompilerPreviewOptions::default()
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(result.artifacts.len(), 2, "{:?}", result.artifacts);
        assert!(
            result
                .code
                .contains("export { constHandler as __fict_dep_0 }"),
            "{}",
            result.code
        );
        assert!(
            result
                .code
                .contains("export { declaredHandler as __fict_dep_1 }"),
            "{}",
            result.code
        );
        assert!(
            result.artifacts[0]
                .code
                .contains("__fict_dep_0 as constHandler"),
            "{}",
            result.artifacts[0].code
        );
        assert!(
            result.artifacts[1]
                .code
                .contains("__fict_dep_1 as declaredHandler"),
            "{}",
            result.artifacts[1].code
        );
    }

    #[cfg(feature = "preview")]
    #[test]
    fn clones_stable_local_preview_handler_definitions_into_artifacts() {
        let source = "export function App({ label }: { label: string }) { const localConstHandler = (event: MouseEvent): string => label + event.type; function localFunctionHandler(event: MouseEvent): string { return label + event.type; } return <><button onClick$={localConstHandler}>Const</button><button onClick$={localFunctionHandler}>Declared</button></>; }";
        let mut input = request(source, "preview-stable-local-handler.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: false,
            ..CompilerPreviewOptions::default()
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(result.artifacts.len(), 2, "{:?}", result.artifacts);
        let const_artifact = &result.artifacts[0].code;
        assert!(
            const_artifact.contains("const localConstHandler = (event) =>"),
            "{const_artifact}"
        );
        assert!(
            const_artifact.contains("const __handler = localConstHandler"),
            "{const_artifact}"
        );
        assert!(const_artifact.contains("label()"), "{const_artifact}");
        assert!(!const_artifact.contains("MouseEvent"), "{const_artifact}");

        let declaration_artifact = &result.artifacts[1].code;
        assert!(
            declaration_artifact
                .contains("const localFunctionHandler = function localFunctionHandler(event)"),
            "{declaration_artifact}"
        );
        assert!(
            declaration_artifact.contains("const __handler = localFunctionHandler"),
            "{declaration_artifact}"
        );
        assert!(
            declaration_artifact.contains("label()"),
            "{declaration_artifact}"
        );
        assert!(
            !declaration_artifact.contains("MouseEvent"),
            "{declaration_artifact}"
        );
    }

    #[cfg(feature = "preview")]
    #[test]
    fn clones_transitive_local_function_dependencies_into_preview_artifacts() {
        let source = "import { $state } from 'fict'; const moduleSuffix = '!'; export function App({ prefix }: { prefix: string }) { const count = $state(0); const format = (event: MouseEvent): string => `${prefix}:${count}:${event.type}${moduleSuffix}`; function invoke(event: MouseEvent): string { return format(event); } return <button onClick$={(event: MouseEvent) => invoke(event)}>{count}</button>; }";
        let mut input = request(source, "preview-local-function-dependencies.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: false,
            ..CompilerPreviewOptions::default()
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(result.artifacts.len(), 1);
        assert!(
            result
                .code
                .contains("export { moduleSuffix as __fict_dep_0 }"),
            "{}",
            result.code
        );
        let artifact = &result.artifacts[0].code;
        assert!(artifact.contains("__fictUseLexicalScope"), "{artifact}");
        assert!(artifact.contains("const prefix = () =>"), "{artifact}");
        assert!(
            artifact.contains("__fict_dep_0 as moduleSuffix"),
            "{artifact}"
        );
        assert!(artifact.contains("const format = (event) =>"), "{artifact}");
        assert!(
            artifact.contains("const invoke = function invoke(event)"),
            "{artifact}"
        );
        assert!(artifact.contains("format(event)"), "{artifact}");
        assert!(artifact.contains("invoke(event)"), "{artifact}");
        assert!(artifact.contains("prefix()"), "{artifact}");
        assert!(artifact.contains("count()"), "{artifact}");
        assert!(!artifact.contains("MouseEvent"), "{artifact}");
    }

    #[cfg(feature = "preview")]
    #[test]
    fn rejects_unsafe_local_function_dependencies_in_preview_handlers() {
        for (name, source, code, expected) in [
            (
                "mutable",
                "export function App() { let helper = () => 1; helper = () => 2; return <button onClick$={() => helper()}>Click</button>; }",
                "FICT-PREVIEW-CAPTURE",
                "helper",
            ),
            (
                "local-capture",
                "export function App() { const value = Math.random(); const helper = () => value; return <button onClick$={() => helper()}>Click</button>; }",
                "FICT-PREVIEW-CAPTURE",
                "value",
            ),
            (
                "alias-property-mutation",
                "export function App() { const helper = () => 1; const alias = helper; alias.extra = 'x'; return <button onClick$={() => helper.extra}>Click</button>; }",
                "FICT-PREVIEW-CAPTURE",
                "helper",
            ),
            (
                "object-mutation",
                "export function App() { const helper = () => 1; Object.defineProperty(helper, 'secret', { value: 'x' }); Object.assign(helper, { extra: 'y' }); return <button onClick$={() => helper.secret + helper.extra}>Click</button>; }",
                "FICT-PREVIEW-CAPTURE",
                "helper",
            ),
            (
                "arguments",
                "export function App() { const helper = () => arguments.length; return <button onClick$={() => helper()}>Click</button>; }",
                "FICT-PREVIEW-CONTEXT",
                "helper -> arguments",
            ),
            (
                "function-prop",
                "export function App({ onCommit }) { const helper = () => onCommit(); return <button onClick$={() => helper()}>Click</button>; }",
                "FICT-PREVIEW-PROP-CALL",
                "onCommit",
            ),
        ] {
            let mut input = request(
                source,
                &format!("preview-local-function-dependency-{name}.tsx"),
            );
            input.options.preview = Some(CompilerPreviewOptions {
                resumable: true,
                auto_extract_handlers: false,
                ..CompilerPreviewOptions::default()
            });
            let result = compile(input);

            assert!(result.has_errors(), "{name}: {:?}", result.diagnostics);
            assert!(result.code.is_empty(), "{name}: {}", result.code);
            assert!(
                result.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code.as_str() == code && diagnostic.message.contains(expected)
                }),
                "{name}: {:?}",
                result.diagnostics
            );
        }
    }

    #[cfg(feature = "preview")]
    #[test]
    fn keeps_auto_handlers_with_unsafe_local_function_dependencies_eager() {
        for (name, source) in [
            (
                "reassigned",
                "export function App() { let helper = () => 1; helper = () => 2; return <button onClick={() => { helper(); console.log('eager'); }}>Click</button>; }",
            ),
            (
                "alias-mutated",
                "export function App() { const helper = () => 1; const alias = helper; alias.extra = 'x'; return <button onClick={() => { console.log(helper.extra); console.log('eager'); }}>Click</button>; }",
            ),
        ] {
            let mut input = request(
                source,
                &format!("preview-local-function-dependency-auto-{name}.tsx"),
            );
            input.options.preview = Some(CompilerPreviewOptions {
                resumable: true,
                auto_extract_handlers: true,
                auto_extract_threshold: 1,
            });
            let result = compile(input);

            assert!(!result.has_errors(), "{name}: {:?}", result.diagnostics);
            assert!(
                result.artifacts.is_empty(),
                "{name}: {:?}",
                result.artifacts
            );
            assert!(!result.code.contains("fict:compiler-artifact:"));
            assert!(
                result.code.contains("addEventListener"),
                "{name}: {}",
                result.code
            );
        }
    }

    #[cfg(feature = "preview")]
    #[test]
    fn rejects_mutable_or_aliased_local_preview_handler_identifiers() {
        for (name, source) in [
            (
                "let",
                "export function App() { let handler = () => 1; return <button onClick$={handler}>Click</button>; }",
            ),
            (
                "alias",
                "export function App() { const base = () => 1; const handler = base; return <button onClick$={handler}>Click</button>; }",
            ),
            (
                "reassigned-declaration",
                "export function App() { function handler() { return 1; } handler = () => 2; return <button onClick$={handler}>Click</button>; }",
            ),
            (
                "alias-property-mutation",
                "export function App() { const handler = () => 1; const alias = handler; alias.extra = 'x'; return <button onClick$={handler}>Click</button>; }",
            ),
        ] {
            let mut input = request(source, &format!("preview-local-handler-{name}.tsx"));
            input.options.preview = Some(CompilerPreviewOptions {
                resumable: true,
                auto_extract_handlers: false,
                ..CompilerPreviewOptions::default()
            });
            let result = compile(input);

            assert!(result.has_errors(), "{name}: {:?}", result.diagnostics);
            assert!(result.code.is_empty(), "{name}: {}", result.code);
            assert!(
                result.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code.as_str() == "FICT-PREVIEW-HANDLER"
                        && diagnostic.message.contains("mutable or aliased local")
                }),
                "{name}: {:?}",
                result.diagnostics
            );
        }
    }

    #[cfg(feature = "preview")]
    #[test]
    fn keeps_auto_mutable_or_aliased_local_preview_handlers_eager() {
        for (name, declaration) in [
            ("let", "let handler = () => console.log('let');"),
            (
                "alias",
                "const base = () => console.log('alias'); const handler = base;",
            ),
        ] {
            let source = format!(
                "export function App() {{ {declaration} return <button onClick={{handler}}>Click</button>; }}"
            );
            let mut input = request(&source, &format!("preview-local-handler-auto-{name}.tsx"));
            input.options.preview = Some(CompilerPreviewOptions {
                resumable: true,
                auto_extract_handlers: true,
                auto_extract_threshold: 1,
            });
            let result = compile(input);

            assert!(!result.has_errors(), "{name}: {:?}", result.diagnostics);
            assert!(
                result.artifacts.is_empty(),
                "{name}: {:?}",
                result.artifacts
            );
            assert!(
                result.code.contains("addEventListener"),
                "{name}: {}",
                result.code
            );
        }
    }

    #[cfg(feature = "preview")]
    #[test]
    fn keeps_auto_mutable_module_preview_handler_identifiers_eager() {
        let source = "export let handler = () => 1; export function App() { return <button onClick={handler}>Click</button>; }";
        let mut input = request(source, "preview-mutable-module-auto.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: true,
            auto_extract_threshold: 1,
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.artifacts.is_empty(), "{:?}", result.artifacts);
        assert!(
            !result.code.contains("fict:compiler-artifact:"),
            "{}",
            result.code
        );
        assert!(result.code.contains("addEventListener"), "{}", result.code);
    }

    #[cfg(feature = "preview")]
    #[test]
    fn falls_back_for_auto_preview_handlers_with_lexical_context() {
        let source = "export function App() { return <button onClick={() => { console.log(this); console.log('eager'); }}>Click</button>; }";
        let mut input = request(source, "preview-context-auto.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: true,
            auto_extract_threshold: 1,
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(result.artifacts.is_empty(), "{:?}", result.artifacts);
        assert!(
            !result.code.contains("fict:compiler-artifact:"),
            "{}",
            result.code
        );
        assert!(result.code.contains("addEventListener"), "{}", result.code);
    }

    #[cfg(feature = "preview")]
    #[test]
    fn preserves_context_owned_by_ordinary_preview_handler_functions() {
        let source = "export function App() { return <button onClick$={function () { return [this, arguments.length, new.target]; }}>Click</button>; }";
        let mut input = request(source, "preview-context-owned.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: false,
            ..CompilerPreviewOptions::default()
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        let artifact = result.artifacts.first().expect("ordinary handler artifact");
        assert!(artifact.code.contains("this"), "{}", artifact.code);
        assert!(
            artifact.code.contains("arguments.length"),
            "{}",
            artifact.code
        );
        assert!(artifact.code.contains("new.target"), "{}", artifact.code);
    }

    #[cfg(feature = "preview")]
    #[test]
    fn preserves_preview_handler_invocation_shapes() {
        let source = "const event = 42; const makeHandler = () => event => event.type; const makeObject = () => ({ handleEvent(event) { return event.type; } }); export function App() { return <><button onClick$={() => event}>Zero</button><button onClick$={makeHandler()}>Factory</button><button onClick$={() => () => event}>Returned</button><button onClick$={() => makeObject()}>Object</button></>; }";
        for (mode, fine_grained_dom) in [("fine", true), ("vnode", false)] {
            let mut input = request(source, &format!("preview-handler-shapes-{mode}.tsx"));
            input.options.fine_grained_dom = fine_grained_dom;
            input.options.preview = Some(CompilerPreviewOptions {
                resumable: true,
                auto_extract_handlers: false,
                ..CompilerPreviewOptions::default()
            });
            let result = compile(input);

            assert!(!result.has_errors(), "{mode}: {:?}", result.diagnostics);
            assert_eq!(result.artifacts.len(), 4, "{mode}: {:?}", result.artifacts);

            let zero = &result.artifacts[0].code;
            assert!(
                zero.contains("const __handler = () => event"),
                "{mode}: {zero}"
            );
            assert!(
                zero.contains("export default (scopeId, event_1, el)"),
                "{mode}: {zero}"
            );

            let factory = &result.artifacts[1].code;
            assert!(
                factory.contains("const __handler = makeHandler()"),
                "{mode}: {factory}"
            );

            let returned = &result.artifacts[2].code;
            assert!(
                returned.contains("const __handler = () => () => event"),
                "{mode}: {returned}"
            );
            assert!(
                returned.contains("__result !== __handler"),
                "{mode}: {returned}"
            );

            let object = &result.artifacts[3].code;
            assert!(
                object.contains("const __handler = () => makeObject()"),
                "{mode}: {object}"
            );
            assert!(
                object.contains("__result.handleEvent.call(__result, event)"),
                "{mode}: {object}"
            );
        }
    }

    #[cfg(feature = "preview")]
    #[test]
    fn allocates_preview_artifact_names_without_changing_user_bindings() {
        let source = "const scopeId = 'scope'; const event = 'event'; const el = 'element'; const __result = 'result'; const __scopeProps = 'props'; const __fictGetScopeProps = 'user helper'; export function App({ label }: { label: string }) { const __handler = () => 1; return <button onClick$={() => ({ scopeId, event, el, __handler, __result, __scopeProps, label, helper: __fictGetScopeProps, name: __handler.name, length: __handler.length })}>Click</button>; }";
        let mut input = request(source, "preview-artifact-name-collisions.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: false,
            ..CompilerPreviewOptions::default()
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        let artifact = &result
            .artifacts
            .first()
            .expect("name-collision handler artifact")
            .code;
        assert!(
            artifact.contains(
                "import { __fictGetScopeProps as __fictGetScopeProps_1 } from \"fict/internal\""
            ),
            "{artifact}"
        );
        assert!(
            artifact.contains("export default (scopeId_1, event_1, el_1)"),
            "{artifact}"
        );
        assert!(
            artifact.contains("const __scopeProps_1 = __fictGetScopeProps_1(scopeId_1) || {}"),
            "{artifact}"
        );
        assert!(artifact.contains("const __handler = () => 1"), "{artifact}");
        assert!(
            artifact.contains("const __handler_1 = () => ({"),
            "{artifact}"
        );
        assert!(
            artifact.contains("const __result_1 = __handler_1.call(el_1, event_1)"),
            "{artifact}"
        );
        for preserved in [
            "scopeId,",
            "event,",
            "el,",
            "__handler,",
            "__result,",
            "__scopeProps,",
            "name: __handler.name",
            "length: __handler.length",
        ] {
            assert!(artifact.contains(preserved), "{preserved}: {artifact}");
        }
    }

    #[cfg(feature = "preview")]
    #[test]
    fn allocates_preview_module_names_and_deduplicates_source_handlers() {
        let source = "export const __fict_e0 = 'event'; export const __fict_r0 = 'resume'; export const __fict_meta_App = 'meta'; export const __fict_dep_0 = 'dependency'; const moduleValue = 1; function Button() { return <button onClick$={() => moduleValue}>Click</button>; } export function App() { return <div><Button /><svg><g><Button /></g></svg></div>; }";
        let mut input = request(source, "preview-module-name-collisions.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: false,
            ..CompilerPreviewOptions::default()
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(result.artifacts.len(), 1, "{:?}", result.artifacts);
        assert_eq!(
            result.artifacts[0]
                .handler
                .as_ref()
                .expect("handler metadata")
                .source_export_name,
            "__fict_e1"
        );
        for preserved in [
            "export const __fict_e0 = \"event\"",
            "export const __fict_r0 = \"resume\"",
            "export const __fict_meta_App = \"meta\"",
            "export const __fict_dep_0 = \"dependency\"",
        ] {
            assert!(
                result.code.contains(preserved),
                "{preserved}: {}",
                result.code
            );
        }
        assert!(
            result
                .code
                .contains("export { moduleValue as __fict_dep_1 }"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("export const __fict_r1"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("export const __fict_r2"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("const __fict_meta_App_1"),
            "{}",
            result.code
        );
    }

    #[cfg(feature = "preview")]
    #[test]
    fn preserves_async_and_generator_preview_function_dependencies() {
        let source = "export function App() { const asyncHelper = async () => await Promise.resolve(1); function* generatorHelper() { yield 1; } return <><button onClick$={async () => await asyncHelper()}>Async</button><button onClick$={() => generatorHelper().next()}>Generator</button></>; }";
        let mut input = request(source, "preview-async-generator-functions.tsx");
        input.options.preview = Some(CompilerPreviewOptions {
            resumable: true,
            auto_extract_handlers: false,
            ..CompilerPreviewOptions::default()
        });
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert_eq!(result.artifacts.len(), 2);
        assert!(
            result.artifacts[0]
                .code
                .contains("const asyncHelper = async () => await Promise.resolve(1)"),
            "{}",
            result.artifacts[0].code
        );
        assert!(
            result.artifacts[0]
                .code
                .contains("async () => await asyncHelper()"),
            "{}",
            result.artifacts[0].code
        );
        assert!(
            result.artifacts[1]
                .code
                .contains("function* generatorHelper()"),
            "{}",
            result.artifacts[1].code
        );
        assert!(
            result.artifacts[1]
                .code
                .contains("generatorHelper().next()"),
            "{}",
            result.artifacts[1].code
        );
    }

    #[cfg(feature = "preview")]
    #[test]
    fn rejects_suspending_preview_factory_expressions() {
        // Keep the JSX owner ordinary: async and generator Components are rejected by the
        // synchronous render ABI before the Preview suspension policy runs.
        for (name, source, expected) in [
            (
                "await",
                "const make = () => () => 1; export async function renderButton() { return <button onClick$={await Promise.resolve(make())}>Click</button>; }",
                "await",
            ),
            (
                "yield",
                "const make = () => () => 1; export function* renderButton() { return <button onClick$={yield make()}>Click</button>; }",
                "yield",
            ),
        ] {
            let mut input = request(source, &format!("preview-factory-{name}.tsx"));
            input.options.preview = Some(CompilerPreviewOptions {
                resumable: true,
                auto_extract_handlers: false,
                ..CompilerPreviewOptions::default()
            });
            let result = compile(input);

            assert!(result.has_errors(), "{name}: {:?}", result.diagnostics);
            assert!(result.code.is_empty(), "{name}: {}", result.code);
            assert!(
                result.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code.as_str() == "FICT-PREVIEW-CONTEXT"
                        && diagnostic.message.contains(expected)
                }),
                "{name}: {:?}",
                result.diagnostics
            );
        }
    }

    #[cfg(feature = "preview")]
    #[test]
    fn keeps_auto_suspending_factory_expressions_eager() {
        // Lowercase JSX helpers may suspend; this exercises Preview fallback without creating
        // an invalid async or generator Component.
        for (name, source, expected, binding) in [
            (
                "await",
                "const make = () => () => 1; export async function renderButton() { return <button onClick={await Promise.resolve(make())}>Click</button>; }",
                "await Promise.resolve",
                "addEventListener",
            ),
            (
                "yield",
                "const make = () => () => 1; export function* renderButton() { return <button onClick={yield make()}>Click</button>; }",
                "yield make()",
                "onClick",
            ),
        ] {
            let mut input = request(source, &format!("preview-factory-{name}-auto.tsx"));
            input.options.preview = Some(CompilerPreviewOptions {
                resumable: true,
                auto_extract_handlers: true,
                auto_extract_threshold: 1,
            });
            let result = compile(input);

            assert!(!result.has_errors(), "{name}: {:?}", result.diagnostics);
            assert!(
                result.artifacts.is_empty(),
                "{name}: {:?}",
                result.artifacts
            );
            assert!(!result.code.contains("fict:compiler-artifact:"));
            assert!(result.code.contains(binding), "{name}: {}", result.code);
            assert!(result.code.contains(expected), "{name}: {}", result.code);
        }
    }

    #[test]
    fn returns_parser_errors_and_never_emits_partial_code() {
        let result = compile(request("export const =", "broken.ts"));
        assert!(result.has_errors());
        assert!(result.code.is_empty());
        assert_eq!(result.diagnostics[0].code.as_str(), "FICT-PARSE");
        assert!(result.diagnostics[0].primary_span.is_some());
    }

    #[test]
    fn emits_source_maps_and_explanations_only_when_requested() {
        let mut input = request("export const value: number = 1", "value.ts");
        input.options.sourcemap = true;
        input.options.explain = true;
        let result = compile(input);

        assert!(!result.has_errors());
        let map = result.map.expect("source map");
        assert_eq!(map.version, 3);
        assert_eq!(map.sources, ["value.ts"]);
        assert!(result.explain.is_some());
    }

    #[test]
    fn composes_native_output_with_an_input_source_map() {
        let mut input = request("export const value: number = 1", "intermediate.ts");
        input.options.sourcemap = true;
        input.input_source_map = Some(RawSourceMap {
            version: 3,
            file: Some("intermediate.ts".to_owned()),
            source_root: Some("../sources".to_owned()),
            sources: vec!["original.fict".to_owned()],
            sources_content: Some(vec![Some("export const value = 1".to_owned())]),
            names: Vec::new(),
            mappings: "AAAA".to_owned(),
            ignore_list: vec![0],
        });

        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        let map = result.map.expect("composed source map");
        assert_eq!(map.file, None);
        assert_eq!(map.source_root.as_deref(), Some("../sources"));
        assert_eq!(map.sources, ["original.fict"]);
        assert_eq!(
            map.sources_content,
            Some(vec![Some("export const value = 1".to_owned())])
        );
        assert_eq!(map.ignore_list, [0]);
    }

    #[test]
    fn creates_stable_internal_error_results() {
        let result = internal_error_result();
        assert!(result.has_errors());
        assert_eq!(result.diagnostics[0].code.as_str(), "FICT-I001");
        assert!(result.code.is_empty());
    }
}
