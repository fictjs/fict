#[cfg(feature = "preview")]
use fict_compiler::CompilerPreviewOptions;
use fict_compiler::{COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions, compile};

fn request(source: &str, filename: &str) -> CompileRequest {
    CompileRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: source.to_owned(),
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
fn remaps_optimized_values_inside_embedded_jsx() {
    let source = "export function App(props) { const a = 1; const b = a + 2; if (props.ok) void b; return <div>{props.children || <Routes routes={props.routes} />}</div>; }";
    let result = compile(request(source, "optimized-embedded-jsx.tsx"));

    assert!(!result.has_errors(), "{:?}", result.diagnostics);
    assert!(result.code.contains("Routes"), "{}", result.code);
}

#[cfg(feature = "preview")]
#[test]
fn emits_preview_handlers_inside_conditional_jsx_branches() {
    let source = "import { $state } from 'fict'; export function App() { let show = $state(true); let count = $state(0); return <div><button onClick$={() => show = !show}>Toggle</button>{show && <button onClick$={() => count++}>{count}</button>}</div>; }";
    let mut input = request(source, "preview-conditional-handler.tsx");
    input.options.preview = Some(CompilerPreviewOptions {
        resumable: true,
        auto_extract_handlers: true,
        ..CompilerPreviewOptions::default()
    });
    let result = compile(input);

    assert!(!result.has_errors(), "{:?}", result.diagnostics);
    assert_eq!(result.artifacts.len(), 2, "{}", result.code);
    assert_eq!(result.code.matches("fict:compiler-artifact:").count(), 4);
}
