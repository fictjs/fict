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

#[test]
fn rejects_resource_declarations_until_disposal_is_modeled() {
    let cases = [
        "function work() { using resource = acquire(); return resource; }",
        "function work() { using resource = acquire(); throw new Error(); }",
        "function work() { while (ready) { using resource = acquire(); break; } }",
        "function work() { { using resource = acquire(); } return 1; }",
        "async function work() { await using resource = acquireAsync(); return resource; }",
    ];

    for source in cases {
        let output = build_hir(source, options(), &HirBuildOptions::default());
        assert!(output.hir.is_none(), "{source}\n{:?}", output.diagnostics);
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == "FICT-USING-UNSUPPORTED"),
            "{source}\n{:?}",
            output.diagnostics
        );
    }
}
