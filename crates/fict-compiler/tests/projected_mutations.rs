use fict_compiler::{COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions, compile};

fn request(code: &str) -> CompileRequest {
    CompileRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: code.into(),
        filename: "projected-mutations.tsx".into(),
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
    }
}

#[test]
fn materializes_every_projected_state_mutation_without_adapter_fallback() {
    let result = compile(request(
        r#"
            import { $state } from 'fict';
            export function App() {
                const state = $state({ nested: {} });
                state.nested.assigned = rhs('assigned', 3);
                state.nested[key('compound')] += rhs('delta', 5);
                state.nested[key('postfix')]++;
                ++state.nested[key('prefix')];
                state.nested[key('postdec')]--;
                --state.nested[key('predec')];
                const removed = delete state.nested[key('removed')];
                return removed;
            }
        "#,
    ));

    assert!(!result.has_errors(), "{:?}", result.diagnostics);
    for (code, expected) in [("FICT-M", 7), ("FICT-H", 6)] {
        assert_eq!(
            result
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code.as_str() == code)
                .count(),
            expected,
            "{:?}",
            result.diagnostics
        );
    }
    for authored in [
        "state().nested.assigned = rhs(\"assigned\", 3)",
        "state().nested[key(\"compound\")] += rhs(\"delta\", 5)",
        "state().nested[key(\"postfix\")]++",
        "++state().nested[key(\"prefix\")]",
        "state().nested[key(\"postdec\")]--",
        "--state().nested[key(\"predec\")]",
        "delete state().nested[key(\"removed\")]",
    ] {
        assert!(
            result.code.contains(authored),
            "{authored}\n{}",
            result.code
        );
    }
    assert!(!result.code.contains("FICT-OXC-EMIT-UNSUPPORTED"));
}
