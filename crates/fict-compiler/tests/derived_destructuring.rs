use fict_compiler::{COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions, compile};

fn compile_source(code: &str, filename: &str) -> fict_compiler::CompileResult {
    compile(CompileRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: code.into(),
        filename: filename.into(),
        module_id: None,
        public_module_id: None,
        language: None,
        module_kind: None,
        input_source_map: None,
        options: CompilerOptions {
            strict_guarantee: false,
            ..CompilerOptions::default()
        },
        metadata: Vec::new(),
        integration_diagnostics: Vec::new(),
    })
}

#[test]
fn evaluates_object_pattern_initializers_once_per_reactive_revision() {
    let result = compile_source(
        r#"
            function makePair(value) {
                return { first: value, second: value + 1 };
            }
            export function App(props) {
                const { first, second } = makePair(props.value);
                return <div>{first}:{second}</div>;
            }
        "#,
        "shared-object-pattern.tsx",
    );

    assert!(!result.has_errors(), "{:?}", result.diagnostics);
    assert_eq!(
        result.code.matches("makePair(props.value)").count(),
        1,
        "{}",
        result.code
    );
    assert!(
        result.code.contains("__fict_destructure_"),
        "{}",
        result.code
    );
}

#[test]
fn evaluates_array_rest_initializers_once_per_reactive_revision() {
    let result = compile_source(
        r#"
            function makeList(value) {
                return [value, value + 1, value + 2];
            }
            export function App(props) {
                const [first, ...rest] = makeList(props.value);
                return <div>{first}:{rest.length}</div>;
            }
        "#,
        "shared-array-pattern.tsx",
    );

    assert!(!result.has_errors(), "{:?}", result.diagnostics);
    assert_eq!(
        result.code.matches("makeList(props.value)").count(),
        1,
        "{}",
        result.code
    );
    assert!(
        result.code.contains("__fict_destructure_"),
        "{}",
        result.code
    );
}
