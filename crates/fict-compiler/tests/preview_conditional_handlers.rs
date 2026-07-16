#![cfg(feature = "preview")]

use fict_compiler::{
    COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions, CompilerPreviewOptions, compile,
};

#[test]
fn emits_preview_handlers_inside_conditional_jsx_branches() {
    let source = "import { $state } from 'fict'; export function App() { let show = $state(true); let count = $state(0); return <div><button onClick$={() => show = !show}>Toggle</button>{show && <button onClick$={() => count++}>{count}</button>}</div>; }";
    let result = compile(CompileRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: source.to_owned(),
        filename: "preview-conditional-handler.tsx".to_owned(),
        module_id: None,
        public_module_id: None,
        language: None,
        module_kind: None,
        input_source_map: None,
        options: CompilerOptions {
            preview: Some(CompilerPreviewOptions {
                resumable: true,
                auto_extract_handlers: true,
                ..CompilerPreviewOptions::default()
            }),
            ..CompilerOptions::default()
        },
        metadata: Vec::new(),
        integration_diagnostics: Vec::new(),
    });

    assert!(!result.has_errors(), "{:?}", result.diagnostics);
    assert_eq!(result.artifacts.len(), 2, "{}", result.code);
    assert_eq!(result.code.matches("fict:compiler-artifact:").count(), 2);
}
