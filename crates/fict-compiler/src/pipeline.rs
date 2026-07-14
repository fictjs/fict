use std::mem;

use fict_compiler_oxc::{
    HirBuildOptions, OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, OxcTypeScriptOptions,
    build_hir, emit_program,
};
use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_emit::{NoJsxLoweringOptions, RuntimeFamily, lower_core};
use fict_metadata::MetadataResolutionStatus;

use crate::control_flow_diagnostics::reactive_control_flow_diagnostics;
use crate::diagnostic_policy::{apply_diagnostic_policy, configured_diagnostic_severity};
use crate::metadata_analysis::generate_module_metadata;
use crate::{
    CompileRequest, CompileResult, CompilerExplainArtifact, CompilerExplainEvent,
    CompilerExplainEventKind, CompilerStats, CorePassOptions, ModuleKind, NormalizedCompileRequest,
    RawSourceMap, SourceLanguage, run_core_passes,
};

/// Execute the currently connected native pipeline and return a complete result.
#[must_use]
pub fn compile(request: CompileRequest) -> CompileResult {
    match request.normalize() {
        Ok(request) => compile_normalized(request),
        Err(error) => invalid_request_result(error.to_string()),
    }
}

/// Construct a structured result for malformed public input.
#[must_use]
pub fn invalid_request_result(message: impl Into<String>) -> CompileResult {
    failed_result(
        "FICT-REQUEST",
        message,
        GuaranteeClass::Unsupported,
        Some("fix the request shape before invoking the native compiler"),
    )
}

/// Construct the generic result returned when the N-API panic boundary fires.
#[must_use]
pub fn internal_error_result() -> CompileResult {
    failed_result(
        "FICT-I001",
        "the native compiler encountered an internal error",
        GuaranteeClass::Internal,
        Some("retry with the legacy backend for the entire build and report the failing fixture"),
    )
}

fn compile_normalized(request: NormalizedCompileRequest) -> CompileResult {
    let mut result = CompileResult::empty();
    result.diagnostics = request.integration_diagnostics.clone();

    if request.input_source_map.is_some() {
        result.diagnostics.push(
            diagnostic(
                "FICT-SOURCEMAP-COMPOSE",
                DiagnosticSeverity::Error,
                "input source-map composition is not connected in the M1 pipeline",
                GuaranteeClass::Unsupported,
            )
            .with_help(
                "omit inputSourceMap or use the legacy backend until composition is enabled",
            ),
        );
    }

    if request.options.preview.is_some() {
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
    if result.metadata_incomplete {
        result.diagnostics.push(
            diagnostic(
                "FICT-METADATA-INCOMPLETE",
                DiagnosticSeverity::Error,
                "resolved metadata snapshot contains an incomplete module cycle",
                GuaranteeClass::Fallback,
            )
            .with_help("let the bundler graph converge before compiling this module"),
        );
    }

    finalize_diagnostics(&mut result, &request.options);
    if result.has_errors() {
        attach_explain_if_requested(&mut result, &request, &[]);
        return result;
    }

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
        attach_explain_if_requested(&mut result, &request, &[]);
        return result;
    };
    let Some(frontend) = build.frontend else {
        result.diagnostics.push(diagnostic(
            "FICT-I004",
            DiagnosticSeverity::Error,
            "the OXC frontend returned HIR without its binding summary",
            GuaranteeClass::Internal,
        ));
        finalize_diagnostics(&mut result, &request.options);
        attach_explain_if_requested(&mut result, &request, &[]);
        return result;
    };
    let Some(module_plan) = build.module_plan else {
        result.diagnostics.push(diagnostic(
            "FICT-I005",
            DiagnosticSeverity::Error,
            "the OXC frontend returned HIR without its owned module plan",
            GuaranteeClass::Internal,
        ));
        finalize_diagnostics(&mut result, &request.options);
        attach_explain_if_requested(&mut result, &request, &[]);
        return result;
    };
    if request.options.strict_guarantee
        && let Some(suppression) = frontend.source_facts.suppressions.first()
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
    finalize_diagnostics(&mut result, &request.options);
    if result.has_errors() {
        attach_explain_if_requested(&mut result, &request, &[]);
        return result;
    }
    let core = match run_core_passes(
        &hir,
        CorePassOptions {
            optimize: request.options.optimize,
            ..CorePassOptions::default()
        },
    ) {
        Ok(core) => core,
        Err(diagnostics) => {
            result.diagnostics.extend(diagnostics.into_sorted());
            finalize_diagnostics(&mut result, &request.options);
            attach_explain_if_requested(&mut result, &request, &[]);
            return result;
        }
    };
    let metadata = generate_module_metadata(&core, &module_plan, &frontend, &request.metadata);
    result.module_metadata = metadata.metadata;
    result.metadata_dependencies = metadata.dependencies;
    result.unresolved_metadata_requests = metadata.unresolved_requests;
    result.metadata_incomplete = metadata.incomplete;
    result
        .diagnostics
        .extend(reactive_control_flow_diagnostics(&core));
    finalize_diagnostics(&mut result, &request.options);
    if result.has_errors() {
        attach_explain_if_requested(&mut result, &request, &[]);
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
    let runtime_family = if frontend
        .macro_imports
        .iter()
        .any(|import| import.source.starts_with("@fictjs/runtime"))
    {
        RuntimeFamily::Runtime
    } else {
        RuntimeFamily::Fict
    };
    let emit = match lower_core(
        &core.hir,
        &regions,
        &cycles,
        NoJsxLoweringOptions {
            runtime_family,
            strict_guarantee: request.options.strict_guarantee,
            preview: false,
            fine_grained_dom: request.options.fine_grained_dom,
        },
    ) {
        Ok(emit) => emit,
        Err(diagnostics) => {
            result.diagnostics.extend(diagnostics.into_sorted());
            finalize_diagnostics(&mut result, &request.options);
            attach_explain_if_requested(&mut result, &request, &[]);
            return result;
        }
    };
    let helpers: Vec<_> = emit
        .imports
        .iter()
        .map(|intent| intent.helper.spec().key.to_owned())
        .collect();
    let output = emit_program(&request.code, &request.filename, oxc_options, &emit);
    result.diagnostics.extend(output.diagnostics);
    finalize_diagnostics(&mut result, &request.options);

    if !result.has_errors() {
        result.code = output.code;
        if let Some(source_map_json) = output.source_map_json {
            match serde_json::from_str::<RawSourceMap>(&source_map_json)
                .map_err(|error| error.to_string())
                .and_then(|map| {
                    map.validate()
                        .map(|()| map)
                        .map_err(|error| error.to_string())
                }) {
                Ok(map) => result.map = Some(map),
                Err(error) => result.diagnostics.push(
                    diagnostic(
                        "FICT-I002",
                        DiagnosticSeverity::Error,
                        format!("OXC emitted an invalid source map: {error}"),
                        GuaranteeClass::Internal,
                    )
                    .with_help("report the source-map fixture; partial output was discarded"),
                ),
            }
        }
    }

    finalize_diagnostics(&mut result, &request.options);
    if result.has_errors() {
        result.code.clear();
        result.map = None;
    }
    attach_explain_if_requested(&mut result, &request, &helpers);
    result
}

fn oxc_language(language: SourceLanguage) -> OxcSourceLanguage {
    match language {
        SourceLanguage::JavaScript => OxcSourceLanguage::JavaScript,
        SourceLanguage::JavaScriptJsx => OxcSourceLanguage::JavaScriptJsx,
        SourceLanguage::TypeScript => OxcSourceLanguage::TypeScript,
        SourceLanguage::TypeScriptJsx => OxcSourceLanguage::TypeScriptJsx,
    }
}

fn oxc_module_kind(module_kind: ModuleKind) -> OxcModuleKind {
    match module_kind {
        ModuleKind::Module => OxcModuleKind::Module,
        ModuleKind::Script => OxcModuleKind::Script,
        ModuleKind::CommonJs => OxcModuleKind::CommonJs,
        ModuleKind::Unambiguous => OxcModuleKind::Unambiguous,
    }
}

fn failed_result(
    code: &'static str,
    message: impl Into<String>,
    guarantee_class: GuaranteeClass,
    help: Option<&'static str>,
) -> CompileResult {
    let mut result = CompileResult::empty();
    let mut finding = diagnostic(code, DiagnosticSeverity::Error, message, guarantee_class);
    if let Some(help) = help {
        finding = finding.with_help(help);
    }
    result.diagnostics.push(finding);
    result
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

fn attach_explain_if_requested(
    result: &mut CompileResult,
    request: &NormalizedCompileRequest,
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
        events: helpers
            .iter()
            .map(|helper| CompilerExplainEvent {
                kind: CompilerExplainEventKind::RuntimeHelper,
                message: format!("emits runtime helper {helper}"),
                name: Some(helper.clone()),
                code: None,
                span: None,
            })
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use fict_diagnostics::{Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass};
    use fict_metadata::{
        HookReturnInfo, MetadataResolutionStatus, ModuleReactiveMetadata, ReactiveExportKind,
        ResolvedMetadataInput,
    };

    use super::{compile, internal_error_result};
    use crate::{
        COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerExplainEventKind, CompilerOptions,
        ModuleKind, WarningLevel, WarningsAsErrors,
    };

    fn request(code: &str, filename: &str) -> CompileRequest {
        CompileRequest {
            protocol_version: COMPILER_PROTOCOL_VERSION,
            code: code.to_owned(),
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
    fn emits_reactive_tsx_modules_as_commonjs() {
        let mut input = request(
            "import { $state } from 'fict'; export default function App() { let count = $state(0); return <button onClick={() => count++}>{count}</button>; }",
            "component.tsx",
        );
        input.module_kind = Some(ModuleKind::CommonJs);
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result.code.contains("__fict_cjs_load(\"fict/internal\""),
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
    fn generates_binding_aware_local_reactive_metadata() {
        let result = compile(request(
            r#"
                import { $memo, $store } from 'fict';
                import { createSignal } from 'fict/advanced';
                const count = createSignal(0);
                export const doubled = $memo(() => count * 2);
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
                && diagnostic.message.contains("imported hook")
        }));
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
                && diagnostic.message.contains("imported hook")
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
        assert!(state.code.contains("__fictUseSignal(__fictCtx_1, 0)"));
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
                && pattern_default.code.contains("view = (() =>"),
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
        assert!(jsx.code.contains("return __fict_tmpl0()"), "{}", jsx.code);

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
        assert!(
            result.code.contains("template(\"<i>a</i><i>b</i>\")"),
            "{}",
            result.code
        );
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
        assert!(result.code.contains(", false, true)"), "{}", result.code);
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
    fn emits_reactive_component_prop_getters() {
        let result = compile(request(
            "import { $state } from 'fict'; const Card = (_props) => null; export function App() { let count = $state(0); return <Card value={count} />; }",
            "reactive-component.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result.code.contains("import { __fictProp"),
            "{}",
            result.code
        );
        assert!(
            result.code.contains("value: __fictProp(() => count())"),
            "{}",
            result.code
        );
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
            2,
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
            2,
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
            1,
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
            1,
            "{}",
            result.code
        );
        assert!(!result.code.contains("makeKey(row())"), "{}", result.code);
        assert!(result.code.contains("type: Row"), "{}", result.code);
        assert!(result.code.contains("() => row()"), "{}", result.code);
        assert!(result.code.contains("key: __fict_key_"), "{}", result.code);
        assert!(
            result.code.contains("label: __fictProp(() => __fict_key)"),
            "{}",
            result.code
        );
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
            1,
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
            1,
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
            1,
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
        assert!(!result.code.contains("store.rows.map("), "{}", result.code);
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
            1,
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
            3,
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
        assert!(
            muted
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.severity == DiagnosticSeverity::Info)
        );
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
        assert!(muted.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-R006"
                && diagnostic.severity == DiagnosticSeverity::Info
        }));
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
        assert!(result.code.contains("if (count() > 10)"), "{}", result.code);

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
        let safe = compile(request(safe_source, "safe-story.tsx"));
        assert!(!safe.has_errors(), "{:?}", safe.diagnostics);
        assert!(
            safe.diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code.as_str() != "FICT-R006")
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
        let story = compile(request(story_source, "switch-story.tsx"));
        assert!(!story.has_errors(), "{:?}", story.diagnostics);
        assert!(
            story
                .diagnostics
                .iter()
                .all(|diagnostic| { diagnostic.code.as_str() != "FICT-R006" })
        );
        assert!(story.code.contains("switch (mode())"), "{}", story.code);
        assert!(story.code.contains("case 0:"), "{}", story.code);
        assert!(story.code.contains("case 1:"), "{}", story.code);
        assert!(story.code.contains("default:"), "{}", story.code);

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
        let source = "import { $state } from 'fict'; export function App(shouldThrow) { let result = $state('init'); try { result = 'try'; if (shouldThrow) throw new Error('boom'); } catch (error) { result = error.message; } finally { result += '!'; } return <span>{result}</span>; }";
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
            (
                "for-await-of",
                "[1, 2]",
                "for await (const value of source) { void value; }",
                true,
            ),
        ];

        for (name, initial, loop_source, is_async) in cases {
            let async_keyword = if is_async { "async " } else { "" };
            let source = format!(
                "import {{ $state }} from 'fict'; export {async_keyword}function App() {{ let source = $state({initial}); {loop_source} return <div />; }}"
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
        let source = "import { $state } from 'fict'; export async function App(values, object) { let total = $state(0); for (const value of values) total += value; for (const key in object) total += key.length; for await (const value of values) { total += await value; } return total; }";
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
        assert_eq!(
            explicit_off.diagnostics[0].severity,
            DiagnosticSeverity::Info
        );
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
        assert_eq!(result.code.matches("side()").count(), 1, "{}", result.code);
        let before = result.code.find("before()").expect("before expression");
        let key = result.code.find("side()").expect("key expression");
        let after = result.code.find("after()").expect("after expression");
        assert!(before < key && key < after, "{}", result.code);
    }

    #[test]
    fn emits_fine_grained_ternary_and_logical_conditions() {
        let result = compile(request(
            "import { $state } from 'fict'; const Yes = () => null; const No = () => null; export function App() { let show = $state(true); return <main>{show ? <><Yes /></> : <No />}{show && <span>{show}</span>}</main>; }",
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
        assert!(result.code.contains("children: count()"), "{}", result.code);
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
        assert!(result.code.contains("render: () => ({"), "{}", result.code);
        assert!(result.code.contains("type: Fragment"), "{}", result.code);
        assert!(!result.code.contains("<i>"), "{}", result.code);
    }

    #[test]
    fn preserves_vnode_key_namespaces_nested_nodes_and_spread_children() {
        let mut input = request(
            "const UI = { Card: (_props) => null }; const id = 'card'; const items = ['a', 'b']; export function App() { return <UI.Card key={id} foo:bar=\"&amp;\" node={<svg:path />} __proto__=\"safe\">{...items}</UI.Card>; }",
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
        assert!(
            result.code.contains("children: [...items]"),
            "{}",
            result.code
        );
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
        assert_eq!(muted.diagnostics.len(), 1);
        assert_eq!(muted.diagnostics[0].code.as_str(), "FICT-M");
        assert_eq!(muted.diagnostics[0].severity, DiagnosticSeverity::Info);

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
        let source = "import { $state, $memo, $store } from 'fict'; export function App(props) { const key = 'value'; const state = $state({ value: 1, nested: { value: 2 } }); const memo = $memo(() => ({ value: 4 })); const alias = state; const nested = state.nested; const bag = { ...state }; const store = $store({ value: 3 }); return <main>{state[key]}:{state?.[key]}:{memo[key]}:{alias[key]}:{nested[key]}:{bag[key]}:{store[key]}:{props[key]}</main>; }";
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
        assert!(muted.diagnostics.iter().all(|diagnostic| {
            diagnostic.code.as_str() != "FICT-R002"
                || diagnostic.severity == DiagnosticSeverity::Info
        }));

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
        assert!(muted.diagnostics.iter().all(|diagnostic| {
            diagnostic.code.as_str() != "FICT-R007"
                || diagnostic.severity == DiagnosticSeverity::Info
        }));

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
        assert!(
            muted
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.severity == DiagnosticSeverity::Info)
        );

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
        assert_eq!(muted.diagnostics[0].severity, DiagnosticSeverity::Info);
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
    fn rejects_preview_options_until_the_optional_pass_graph_is_connected() {
        let mut input = request("export const value = 1", "preview.js");
        input.options.preview = Some(Default::default());
        let result = compile(input);

        assert!(result.has_errors());
        assert!(result.code.is_empty());
        assert_eq!(
            result.diagnostics[0].code.as_str(),
            "FICT-PREVIEW-UNAVAILABLE"
        );
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
    fn creates_stable_internal_error_results() {
        let result = internal_error_result();
        assert!(result.has_errors());
        assert_eq!(result.diagnostics[0].code.as_str(), "FICT-I001");
        assert!(result.code.is_empty());
    }
}
