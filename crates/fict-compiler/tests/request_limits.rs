use fict_compiler::{
    AnalyzeOptions, AnalyzeRequest, COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions,
    RawSourceMap, RequestLimits, ScanRequest, analyze, compile, scan,
};
use fict_diagnostics::{Diagnostic, DiagnosticCode, DiagnosticSeverity};
use fict_metadata::{MetadataResolutionStatus, ResolvedMetadataInput};

fn compile_request(code: impl Into<String>) -> CompileRequest {
    CompileRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: code.into(),
        filename: "limits.tsx".into(),
        module_id: None,
        public_module_id: None,
        language: None,
        module_kind: None,
        input_source_map: None,
        options: CompilerOptions::default(),
        metadata: Vec::new(),
        integration_diagnostics: Vec::new(),
        limits: RequestLimits::default(),
    }
}

fn scan_request(code: impl Into<String>) -> ScanRequest {
    ScanRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: code.into(),
        filename: "limits.ts".into(),
        module_id: None,
        language: None,
        module_kind: None,
        limits: RequestLimits::default(),
    }
}

fn analyze_request(code: impl Into<String>) -> AnalyzeRequest {
    AnalyzeRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: code.into(),
        filename: "limits.tsx".into(),
        module_id: None,
        language: None,
        module_kind: None,
        metadata: Vec::new(),
        integration_diagnostics: Vec::new(),
        options: AnalyzeOptions::default(),
        limits: RequestLimits::default(),
    }
}

#[test]
fn source_limits_fail_closed_before_all_frontends() {
    let limits = RequestLimits {
        max_source_bytes: 4,
        ..RequestLimits::default()
    };

    let mut compile_request = compile_request("export const value = 1");
    compile_request.limits = limits;
    let compiled = compile(compile_request);
    assert_eq!(compiled.diagnostics[0].code.as_str(), "FICT-REQUEST");
    assert!(compiled.diagnostics[0].message.contains("maxSourceBytes"));

    let mut scan_request = scan_request("import './dependency'");
    scan_request.limits = limits;
    let scanned = scan(scan_request);
    assert_eq!(scanned.diagnostics[0].code.as_str(), "FICT-REQUEST");
    assert!(scanned.diagnostics[0].message.contains("maxSourceBytes"));

    let mut analyze_request = analyze_request("export function App() { return null }");
    analyze_request.limits = limits;
    let analyzed = analyze(analyze_request);
    assert_eq!(analyzed.diagnostics[0].code, "FICT-REQUEST");
    assert!(analyzed.diagnostics[0].message.contains("maxSourceBytes"));
}

#[test]
fn request_metadata_source_map_and_diagnostic_inputs_are_bounded() {
    let mut aggregate = compile_request("export const value = 1");
    aggregate.limits.max_request_bytes = 32;
    let result = compile(aggregate);
    assert_eq!(result.diagnostics[0].code.as_str(), "FICT-REQUEST");
    assert!(result.diagnostics[0].message.contains("maxRequestBytes"));

    let mut metadata = compile_request("export const value = 1");
    metadata.metadata.push(ResolvedMetadataInput {
        request: format!("./{}", "dependency".repeat(16)),
        resolved_id: None,
        status: MetadataResolutionStatus::Missing,
        metadata: None,
        fingerprint: "sha256:missing".into(),
    });
    metadata.limits.max_metadata_bytes = 32;
    let result = compile(metadata);
    assert_eq!(result.diagnostics[0].code.as_str(), "FICT-REQUEST");
    assert!(result.diagnostics[0].message.contains("maxMetadataBytes"));

    let mut source_map = compile_request("export const value = 1");
    source_map.input_source_map = Some(RawSourceMap {
        version: 3,
        file: None,
        source_root: None,
        sources: vec!["source.ts".repeat(16)],
        sources_content: None,
        names: Vec::new(),
        mappings: String::new(),
        ignore_list: Vec::new(),
    });
    source_map.limits.max_source_map_bytes = 32;
    let result = compile(source_map);
    assert_eq!(result.diagnostics[0].code.as_str(), "FICT-REQUEST");
    assert!(result.diagnostics[0].message.contains("maxSourceMapBytes"));

    let mut diagnostics = compile_request("export const value = 1");
    diagnostics.integration_diagnostics = (0..2)
        .map(|index| {
            Diagnostic::new(
                DiagnosticCode::new(format!("FICT-HOST-{index}"))
                    .expect("test diagnostic code is valid"),
                DiagnosticSeverity::Warning,
                "host diagnostic",
            )
        })
        .collect();
    diagnostics.limits.max_diagnostics = 1;
    let result = compile(diagnostics);
    assert_eq!(result.diagnostics[0].code.as_str(), "FICT-REQUEST");
    assert!(result.diagnostics[0].message.contains("maxDiagnostics"));
}

#[test]
fn hir_limits_stop_compile_and_analysis_before_passes() {
    let limits = RequestLimits {
        max_hir_nodes: 1,
        ..RequestLimits::default()
    };
    let source = "export function App() { return <main>ready</main> }";

    let mut compile_request = compile_request(source);
    compile_request.limits = limits;
    let compiled = compile(compile_request);
    assert_eq!(compiled.diagnostics[0].code.as_str(), "FICT-REQUEST");
    assert!(compiled.diagnostics[0].message.contains("maxHirNodes"));

    let mut analyze_request = analyze_request(source);
    analyze_request.limits = limits;
    let analyzed = analyze(analyze_request);
    assert_eq!(analyzed.diagnostics[0].code, "FICT-REQUEST");
    assert!(analyzed.diagnostics[0].message.contains("maxHirNodes"));
}

#[test]
fn semantic_graph_limits_stop_before_hir_construction() {
    let source = "export function App(first, second) { const value = first + second; return <main>{value}</main>; }";
    for (limits, setting) in [
        (
            RequestLimits {
                max_ast_nodes: 1,
                ..RequestLimits::default()
            },
            "maxAstNodes",
        ),
        (
            RequestLimits {
                max_scopes: 1,
                ..RequestLimits::default()
            },
            "maxScopes",
        ),
        (
            RequestLimits {
                max_symbols: 1,
                ..RequestLimits::default()
            },
            "maxSymbols",
        ),
    ] {
        let mut request = compile_request(source);
        request.limits = limits;
        let result = compile(request);
        assert_eq!(result.diagnostics[0].code.as_str(), "FICT-REQUEST");
        assert!(result.diagnostics[0].message.contains(setting));
    }
}

#[test]
fn source_map_and_complete_results_are_bounded_before_napi_serialization() {
    let mut source_map = compile_request("export const value = 1");
    source_map.options.sourcemap = true;
    source_map.limits.max_source_map_bytes = 16;
    let result = compile(source_map);
    assert_eq!(result.diagnostics[0].code.as_str(), "FICT-REQUEST");
    assert!(result.diagnostics[0].message.contains("maxSourceMapBytes"));

    let mut compile_output = compile_request(format!(
        "export const value = {:?}",
        "generated-output".repeat(512)
    ));
    compile_output.limits.max_output_bytes = 4 * 1024;
    let result = compile(compile_output);
    assert_eq!(result.diagnostics[0].code.as_str(), "FICT-REQUEST");
    assert!(result.diagnostics[0].message.contains("maxOutputBytes"));

    let imports = (0..256)
        .map(|index| format!("import './dependency-{index}';"))
        .collect::<String>();
    let mut scan_output = scan_request(imports);
    scan_output.limits.max_output_bytes = 4 * 1024;
    let result = scan(scan_output);
    assert_eq!(result.diagnostics[0].code.as_str(), "FICT-REQUEST");
    assert!(result.diagnostics[0].message.contains("maxOutputBytes"));

    let components = (0..128)
        .map(|index| format!("export function Component{index}() {{ return <div>{index}</div>; }}"))
        .collect::<String>();
    let mut analyze_output = analyze_request(components);
    analyze_output.limits.max_output_bytes = 4 * 1024;
    let result = analyze(analyze_output);
    assert_eq!(result.diagnostics[0].code, "FICT-REQUEST");
    assert!(result.diagnostics[0].message.contains("maxOutputBytes"));
}

#[test]
fn callers_cannot_disable_native_hard_ceilings() {
    let mut request = compile_request("export const value = 1");
    request.limits.max_source_bytes = u64::MAX;
    let result = compile(request);
    assert_eq!(result.diagnostics[0].code.as_str(), "FICT-REQUEST");
    assert!(result.diagnostics[0].message.contains("supported range"));
}

#[test]
fn absent_optional_payloads_do_not_consume_their_dedicated_limits() {
    let mut request = compile_request("export const value = 1");
    request.limits.max_metadata_bytes = 1;
    request.limits.max_source_map_bytes = 1;
    let result = compile(request);
    assert!(!result.has_errors(), "{:?}", result.diagnostics);
}
