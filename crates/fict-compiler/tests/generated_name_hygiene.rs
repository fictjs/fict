use fict_compiler::{COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions, compile};

fn compile_source(source: &str, options: CompilerOptions) -> fict_compiler::CompileResult {
    compile(CompileRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: source.into(),
        filename: "generated-name-hygiene.tsx".into(),
        module_id: None,
        public_module_id: None,
        language: None,
        module_kind: None,
        input_source_map: None,
        options,
        metadata: Vec::new(),
        integration_diagnostics: Vec::new(),
    })
}

#[test]
fn compiler_generated_names_never_capture_authored_free_identifiers() {
    let source = r#"
        import { $state } from 'fict'

        export const helperType = typeof __fictUseSignal
        export const helperValue = __fictUseSignal
        export const contextType = typeof __fictCtx
        export const templateType = typeof __fict_tmpl0
        export const cacheType = typeof __cached_count_0

        export function App() {
            let count = $state(0)
            return <button>{count + count}</button>
        }
    "#;
    let result = compile_source(source, CompilerOptions::default());

    assert!(!result.has_errors(), "{:#?}", result.diagnostics);
    for authored in [
        "typeof __fictUseSignal",
        "helperValue = __fictUseSignal",
        "typeof __fictCtx",
        "typeof __fict_tmpl0",
        "typeof __cached_count_0",
    ] {
        assert!(
            result.code.contains(authored),
            "missing {authored:?}:\n{}",
            result.code
        );
    }
    assert!(
        result.code.contains("__fictUseSignal as __fictUseSignal_1"),
        "{}",
        result.code
    );
    assert!(result.code.contains("const __fictCtx_1"), "{}", result.code);
    assert!(
        result.code.contains("const __fict_tmpl0_1"),
        "{}",
        result.code
    );
}
