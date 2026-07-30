use fict_compiler::{COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions, compile};

fn compile_source(source: &str) -> fict_compiler::CompileResult {
    compile(CompileRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: source.into(),
        filename: "jsx-text-entities.tsx".into(),
        module_id: None,
        public_module_id: None,
        language: None,
        module_kind: None,
        input_source_map: None,
        options: CompilerOptions::default(),
        metadata: Vec::new(),
        integration_diagnostics: Vec::new(),
    })
}

#[test]
fn preserves_lone_surrogate_entities_across_dom_and_component_lowering() {
    let result = compile_source(
        r#"
            function Child(props) {
                return <span>{props.label}{props.children}</span>
            }
            export function Intrinsic() {
                return <div title="&#xD800;">&#55296;</div>
            }
            export function Component() {
                return <Child label="&#55296;">&#xD800;</Child>
            }
        "#,
    );

    assert!(!result.has_errors(), "{:#?}", result.diagnostics);
    assert!(!result.code.contains("&amp;#xD800;"), "{}", result.code);
    assert!(!result.code.contains("&amp;#55296;"), "{}", result.code);
    assert!(
        result.code.matches("\\ud800").count() >= 4,
        "{}",
        result.code
    );
}
