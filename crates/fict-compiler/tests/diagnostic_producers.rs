use std::collections::BTreeSet;

use fict_compiler::{
    COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions, WarningsAsErrors, compile,
};
use fict_diagnostics::DiagnosticSeverity;

fn compile_source(source: &str) -> fict_compiler::CompileResult {
    compile_source_with_options(
        source,
        CompilerOptions {
            strict_guarantee: false,
            ..CompilerOptions::default()
        },
    )
}

fn compile_source_with_options(
    source: &str,
    options: CompilerOptions,
) -> fict_compiler::CompileResult {
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

fn warnings_as_errors_options() -> CompilerOptions {
    CompilerOptions {
        strict_guarantee: false,
        warnings_as_errors: WarningsAsErrors::Boolean(true),
        ..CompilerOptions::default()
    }
}

#[test]
fn region_backed_effect_reads_do_not_produce_e001_or_fail_warnings_as_errors() {
    let result = compile_source_with_options(
        r#"
            import { $effect, $state } from 'fict';
            export function useProbe() {
                let n = $state(0);
                let label = 'none';
                if (n > 0) label = 'many';
                $effect(() => console.log(label));
                return { set: value => { n = value; } };
            }
        "#,
        warnings_as_errors_options(),
    );

    assert!(!result.has_errors(), "{:#?}", result.diagnostics);
    assert!(
        result
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code.as_str() != "FICT-E001"),
        "{:#?}",
        result.diagnostics
    );
    assert!(
        result.code.contains("console.log(__fict_region().label)"),
        "{}",
        result.code
    );
}

#[test]
fn named_region_backed_effect_callbacks_do_not_produce_e001() {
    let result = compile_source_with_options(
        r#"
            import { $effect, $state } from 'fict';
            export function useProbe() {
                let n = $state(0);
                let label = 'none';
                if (n > 0) label = 'many';
                const report = () => console.log(label);
                $effect(report);
                return { set: value => { n = value; } };
            }
        "#,
        warnings_as_errors_options(),
    );

    assert!(!result.has_errors(), "{:#?}", result.diagnostics);
    assert!(
        result
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code.as_str() != "FICT-E001"),
        "{:#?}",
        result.diagnostics
    );
    assert!(
        result.code.contains("console.log(__fict_region().label)"),
        "{}",
        result.code
    );
}

#[test]
fn unrelated_region_reads_do_not_hide_a_real_e001_warning() {
    let result = compile_source_with_options(
        r#"
            import { $effect, $state } from 'fict';
            export function useProbe() {
                let n = $state(0);
                let label = 'none';
                if (n > 0) label = 'many';
                const view = () => label;
                $effect(() => console.log('once'));
                return { view, set: value => { n = value; } };
            }
        "#,
        warnings_as_errors_options(),
    );

    let diagnostic = result
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code.as_str() == "FICT-E001")
        .unwrap_or_else(|| panic!("missing E001: {:#?}", result.diagnostics));
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
    assert!(result.has_errors());
    assert!(result.code.is_empty());
}

#[test]
fn region_reads_deferred_to_a_nested_callback_do_not_hide_e001() {
    let result = compile_source_with_options(
        r#"
            import { $effect, $state } from 'fict';
            export function useProbe() {
                let n = $state(0);
                let label = 'none';
                if (n > 0) label = 'many';
                $effect(() => () => console.log(label));
                return { set: value => { n = value; } };
            }
        "#,
        warnings_as_errors_options(),
    );

    let diagnostic = result
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code.as_str() == "FICT-E001")
        .unwrap_or_else(|| panic!("missing E001: {:#?}", result.diagnostics));
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
    assert!(result.has_errors());
    assert!(result.code.is_empty());
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
