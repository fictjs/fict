use fict_compiler_oxc::{
    HirBuildOptions, OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, build_hir,
};

fn options() -> OxcCompileOptions {
    OxcCompileOptions {
        language: OxcSourceLanguage::TypeScriptJsx,
        module_kind: OxcModuleKind::Module,
        typescript: Default::default(),
        sourcemap: false,
    }
}

fn build(source: &str) -> fict_compiler_oxc::HirBuildOutput {
    build_hir(source, options(), &HirBuildOptions::default())
}

#[test]
fn rejects_dangerous_html_with_renderable_native_children() {
    let cases = [
        "export function App({ html }) { return <div dangerouslySetInnerHTML={{ __html: html }}>text</div>; }",
        "export function App({ html, value }) { return <div dangerouslySetInnerHTML={{ __html: html }}>{value}</div>; }",
        "export function App({ html }) { return <div dangerouslySetInnerHTML={{ __html: html }}><span /></div>; }",
    ];

    for source in cases {
        let output = build(source);
        assert!(output.hir.is_none(), "{source}\n{:?}", output.diagnostics);
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == "FICT-J004"),
            "{source}\n{:?}",
            output.diagnostics
        );
    }
}

#[test]
fn permits_non_conflicting_and_component_uses() {
    let sources = [
        "export function App({ html }) { return <div dangerouslySetInnerHTML={{ __html: html }} />; }",
        "export function App({ html }) { return <div dangerouslySetInnerHTML={{ __html: html }}>\n  {/* formatting only */}\n</div>; }",
        "function Widget(props) { return <section />; } export function App({ html }) { return <Widget dangerouslySetInnerHTML={{ __html: html }}>child</Widget>; }",
    ];

    for source in sources {
        let output = build(source);
        assert!(output.hir.is_some(), "{source}\n{:?}", output.diagnostics);
        assert!(
            output
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code.as_str() != "FICT-J004"),
            "{source}\n{:?}",
            output.diagnostics
        );
    }
}
