use fict_compiler::{COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions, compile};

fn request(code: &str, filename: &str) -> CompileRequest {
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
    }
}

#[test]
fn plain_uppercase_functions_keep_native_parameter_semantics() {
    let result = compile(request(
        "export function Helper({ a, b, unused }) { return b + a; } export const renderItems = items => items.map(item => <span>{item}</span>);",
        "plain-function-roles.tsx",
    ));
    assert!(!result.has_errors(), "{:?}", result.diagnostics);
    assert!(result.code.contains("function Helper({"));
    assert!(result.code.contains("unused"));
    assert!(!result.code.contains("function Helper(__fictProps"));
    assert!(!result.code.contains("const a = prop("));
}

#[test]
fn render_owners_fail_closed_when_the_sync_abi_cannot_run_them() {
    for (source, filename, code) in [
        (
            "export async function App() { return <div />; }",
            "async.tsx",
            "FICT-FUNCTION-ASYNC-COMPONENT",
        ),
        (
            "export function* App() { yield 1; return <div />; }",
            "generator.tsx",
            "FICT-FUNCTION-GENERATOR-COMPONENT",
        ),
        (
            "export function* useItems() { yield 1; }",
            "hook.ts",
            "FICT-FUNCTION-GENERATOR-HOOK",
        ),
        (
            "export async function useView() { await ready(); return <div />; }",
            "async-hook.tsx",
            "FICT-FUNCTION-ASYNC-HOOK-AFTER-AWAIT",
        ),
    ] {
        let result = compile(request(source, filename));
        assert!(result.code.is_empty(), "{code}: {}", result.code);
        assert!(
            result
                .diagnostics
                .iter()
                .any(|item| item.code.as_str() == code)
        );
    }

    let allowed = compile(request(
        "import { $state } from 'fict'; export async function useProbe() { const count = $state(1); await ready(); return count; } export async function loadView() { await ready(); return <div />; }",
        "allowed.tsx",
    ));
    assert!(!allowed.has_errors(), "{:?}", allowed.diagnostics);
}

#[test]
fn rejects_class_bindings_used_as_jsx_components() {
    for (source, name) in [
        (
            "class App {} export function Parent() { return <App />; }",
            "App",
        ),
        (
            "const App = class {}; export function Parent() { return <App />; }",
            "App",
        ),
        (
            "export class App {} export function Parent() { return <App />; }",
            "App",
        ),
        (
            "const UI = { App: class {} }; export function Parent() { return <UI.App />; }",
            "UI.App",
        ),
        (
            "const UI = {}; UI.Panel = class {}; export function Parent() { return <UI.Panel />; }",
            "UI.Panel",
        ),
    ] {
        let result = compile(request(source, "class-component.tsx"));
        let diagnostic = result
            .diagnostics
            .iter()
            .find(|item| item.code.as_str() == "FICT-COMPONENT-CLASS")
            .unwrap_or_else(|| panic!("missing class diagnostic for {name}: {result:?}"));
        assert!(result.code.is_empty());
        assert!(diagnostic.notes.iter().any(|note| note.contains(name)));
    }

    let allowed = compile(request(
        "class ViewModel { value = 1 } function App() { return <span>ok</span>; } export function Parent() { const model = new ViewModel(); return <App value={model.value} />; }",
        "class-helper.tsx",
    ));
    assert!(!allowed.has_errors(), "{:?}", allowed.diagnostics);
}
