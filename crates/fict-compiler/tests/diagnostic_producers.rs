use std::collections::BTreeSet;

use fict_compiler::{COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions, compile};

fn compile_source(source: &str) -> fict_compiler::CompileResult {
    let options = CompilerOptions {
        strict_guarantee: false,
        ..CompilerOptions::default()
    };
    compile(CompileRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: source.into(),
        filename: "diagnostic-producers.tsx".into(),
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

fn codes(result: &fict_compiler::CompileResult) -> BTreeSet<&str> {
    result
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.code.as_str())
        .collect()
}

#[test]
fn native_compiler_produces_every_advisory_diagnostic_it_registers() {
    let result = compile_source(
        r#"
            import { $effect, $memo, $state } from 'fict';
            export function Parent(props) {
                const count = $state(0);
                $effect(() => console.log('once'));
                const constant = $memo(() => 42);
                function Child() { return <span>{count}</span>; }
                function Broken() { <strong />; }
                return <main>
                    <Child />
                    <Broken />
                    {props.items.map(item => <i>{item.name}</i>)}
                    {props.items.map((item, index) => <b key={index}>{item.name}</b>)}
                    {constant}
                </main>;
            }
        "#,
    );

    assert!(!result.has_errors(), "{:?}", result.diagnostics);
    let actual = codes(&result);
    for expected in [
        "FICT-E001",
        "FICT-M001",
        "FICT-C003",
        "FICT-C004",
        "FICT-J001",
        "FICT-J002",
    ] {
        assert!(actual.contains(expected), "missing {expected}: {actual:?}");
    }
}

#[test]
fn advisory_producers_do_not_flag_supported_shapes() {
    let result = compile_source(
        r#"
            import { $effect, $memo, $state } from 'fict';
            function Child(props) { return <span>{props.value}</span>; }
            export function Parent(props) {
                const count = $state(0);
                $effect(() => console.log(count));
                const doubled = $memo(() => count * 2);
                const logged = $memo(() => { console.log('once'); return 1; });
                return <main>
                    <Child value={doubled} />
                    {props.items.map(item => <i key={item.id}>{item.name}</i>)}
                    {logged}
                </main>;
            }
        "#,
    );

    assert!(!result.has_errors(), "{:?}", result.diagnostics);
    let actual = codes(&result);
    for unexpected in [
        "FICT-E001",
        "FICT-M001",
        "FICT-C003",
        "FICT-C004",
        "FICT-J001",
        "FICT-J002",
    ] {
        assert!(
            !actual.contains(unexpected),
            "unexpected {unexpected}: {actual:?}"
        );
    }
}
