use fict_compiler::{COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions, compile};

fn request(code: impl Into<String>, filename: impl Into<String>) -> CompileRequest {
    CompileRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: code.into(),
        filename: filename.into(),
        module_id: None,
        public_module_id: None,
        language: None,
        module_kind: None,
        input_source_map: None,
        options: CompilerOptions::default(),
        metadata: Vec::new(),
        integration_diagnostics: Vec::new(),
        limits: Default::default(),
    }
}

fn structured_hooks(body: &str) -> String {
    format!(
        r#"
            import {{ $memo, $state, $store }} from 'fict';
            function useThing() {{
                const count = $state(1);
                const doubled = $memo(() => count * 2);
                const state = $store({{ value: 1 }});
                return {{ count, doubled, state, plain: 1 }};
            }}
            function usePair() {{
                const count = $state(1);
                const doubled = $memo(() => count * 2);
                return [doubled, count];
            }}
            export function App() {{
                const thing = useThing();
                const pair = usePair();
                {body}
            }}
        "#
    )
}

#[test]
fn consumes_structured_member_metadata_from_same_module_hooks() {
    let valid = compile(request(
        structured_hooks(
            "thing.count(2); thing.state.value = 2; thing.plain = 3; return [thing.count, thing.doubled, thing.state.value, thing.plain, pair[0], pair[1]];",
        ),
        "local-structured-hook-valid.jsx",
    ));
    assert!(!valid.has_errors(), "{:?}", valid.diagnostics);
    for expected in [
        "thing.count(2)",
        "thing.count()",
        "thing.doubled()",
        "thing.state.value = 2",
        "thing.plain = 3",
        "pair[0]()",
        "pair[1]()",
    ] {
        assert!(valid.code.contains(expected), "{expected}: {}", valid.code);
    }
    assert!(!valid.code.contains("thing.count()(2)"), "{}", valid.code);

    for (name, mutation, expected_code) in [
        ("memo-write", "thing.doubled = 5", "FICT-METADATA-READONLY"),
        (
            "memo-delete",
            "delete thing.doubled",
            "FICT-METADATA-READONLY",
        ),
        ("tuple-memo-write", "pair[0] = 5", "FICT-METADATA-READONLY"),
        ("signal-write", "thing.count = 2", "FICT-M"),
        ("signal-delete", "delete thing.count", "FICT-M"),
        ("tuple-signal-write", "pair[1] = 2", "FICT-M"),
        (
            "store-replace",
            "thing.state = { value: 2 }",
            "FICT-METADATA-READONLY",
        ),
        (
            "store-delete",
            "delete thing.state",
            "FICT-METADATA-READONLY",
        ),
        (
            "captured-memo-write",
            "const write = () => { thing.doubled = 5 }; return write",
            "FICT-METADATA-READONLY",
        ),
    ] {
        let invalid = compile(request(
            structured_hooks(&format!("{mutation}; return thing.plain;")),
            format!("local-hook-{name}.jsx"),
        ));
        assert!(
            invalid.has_errors() && invalid.code.is_empty(),
            "{name}: {invalid:?}"
        );
        let diagnostic = invalid
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code.as_str() == expected_code)
            .unwrap_or_else(|| panic!("{name}: {:?}", invalid.diagnostics));
        assert!(
            diagnostic
                .help
                .as_deref()
                .is_some_and(|help| help.contains("explicit setter")),
            "{name}: {diagnostic:?}"
        );
    }

    let reassigned = compile(request(
        "import { $memo } from 'fict'; function useThing() { const doubled = $memo(() => 2); return { doubled }; } export function App() { let thing = useThing(); thing = { doubled: 1 }; thing.doubled = 2; return thing.doubled; }",
        "local-hook-reassigned-root.jsx",
    ));
    assert!(!reassigned.has_errors(), "{:?}", reassigned.diagnostics);
    assert!(
        reassigned.code.contains("thing.doubled = 2"),
        "{}",
        reassigned.code
    );

    let reassigned_hook = compile(request(
        "import { $memo } from 'fict'; function useThing() { const doubled = $memo(() => 2); return { doubled }; } useThing = () => ({ doubled: 1 }); export function App() { const thing = useThing(); thing.doubled = 2; return thing.doubled; }",
        "local-hook-reassigned-binding.jsx",
    ));
    assert!(
        !reassigned_hook.has_errors() && reassigned_hook.code.contains("thing.doubled = 2"),
        "{reassigned_hook:?}"
    );
    assert!(!reassigned_hook.code.contains("thing.doubled()"));
}
