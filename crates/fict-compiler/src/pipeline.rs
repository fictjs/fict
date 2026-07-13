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

    finalize_diagnostics(&mut result);
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
        },
    );
    result.diagnostics.extend(build.diagnostics);
    let Some(hir) = build.hir else {
        finalize_diagnostics(&mut result);
        if !result.has_errors() {
            result.diagnostics.push(diagnostic(
                "FICT-I003",
                DiagnosticSeverity::Error,
                "the OXC frontend returned no HIR without a diagnostic",
                GuaranteeClass::Internal,
            ));
        }
        finalize_diagnostics(&mut result);
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
        finalize_diagnostics(&mut result);
        attach_explain_if_requested(&mut result, &request, &[]);
        return result;
    };
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
            finalize_diagnostics(&mut result);
            attach_explain_if_requested(&mut result, &request, &[]);
            return result;
        }
    };
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
            finalize_diagnostics(&mut result);
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
    finalize_diagnostics(&mut result);

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

    finalize_diagnostics(&mut result);
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

fn finalize_diagnostics(result: &mut CompileResult) {
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
    use fict_diagnostics::DiagnosticSeverity;

    use super::{compile, internal_error_result};
    use crate::{
        COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerExplainEventKind, CompilerOptions,
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
        let result = compile(request(
            "export function View(first, second) { return <div id=\"before\" {...first} class=\"after\" {...second}>child</div>; }",
            "spread-order.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
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
        let result = compile(request(
            "export function Foreign(svgProps, mathProps) { return <><svg {...svgProps} /><math {...mathProps} /></>; }",
            "spread-namespace.tsx",
        ));

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
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
        let result = compile(request(
            "import { createKeyedList as list } from 'fict/internal/list'; export function App(items) { return list(() => items, (item) => item.id, (item) => <span>{item.name}</span>); }",
            "keyed-list.tsx",
        ));

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
        let result = compile(input);

        assert!(!result.has_errors(), "{:?}", result.diagnostics);
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
        let result = compile(request(
            "import { $state, $effect } from 'fict'; const seen = []; function Component() { let count = $state(0); $effect(() => { seen.push(count); count += 1; }); return count; }",
            "captured.js",
        ));

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
                .any(|diagnostic| diagnostic.code.as_str() == "FICT-M001")
        );

        let mut fallback_request = request(source, "nested.js");
        fallback_request.options.strict_guarantee = false;
        let fallback = compile(fallback_request);
        assert!(!fallback.has_errors(), "{:?}", fallback.diagnostics);
        assert!(fallback.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-M001"
                && diagnostic.severity == DiagnosticSeverity::Warning
        }));
        assert!(fallback.code.contains("user().name = \"Grace\""));
        assert!(fallback.code.contains("return user().name"));
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
