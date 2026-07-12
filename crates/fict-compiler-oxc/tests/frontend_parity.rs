use fict_compiler_oxc::{
    HirBuildOptions, OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, build_hir,
};
use fict_hir::{print_hir, verify_hir};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    name: String,
    language: String,
    source: String,
    #[serde(default)]
    reactive_scopes: Vec<String>,
    accepted: bool,
    failure_class: Option<String>,
    legacy_message: Option<String>,
    rust_code: Option<String>,
}

fn language(value: &str) -> OxcSourceLanguage {
    match value {
        "js" => OxcSourceLanguage::JavaScript,
        "jsx" => OxcSourceLanguage::JavaScriptJsx,
        "ts" => OxcSourceLanguage::TypeScript,
        "tsx" => OxcSourceLanguage::TypeScriptJsx,
        _ => panic!("unknown fixture language {value}"),
    }
}

fn options(fixture: &Fixture) -> OxcCompileOptions {
    OxcCompileOptions {
        language: language(&fixture.language),
        module_kind: OxcModuleKind::Module,
        typescript: Default::default(),
        sourcemap: false,
    }
}

#[test]
fn shared_legacy_corpus_has_matching_rust_frontend_outcomes() {
    let fixtures: Vec<Fixture> = serde_json::from_str(include_str!(
        "../../../packages/compiler/test/differential/frontend-parity-fixtures.json"
    ))
    .expect("valid shared frontend parity corpus");
    assert!(
        fixtures.len() >= 12,
        "parity corpus must remain representative"
    );

    for fixture in fixtures {
        let hir_options = HirBuildOptions {
            reactive_scopes: fixture.reactive_scopes.clone(),
        };
        let first = build_hir(&fixture.source, options(&fixture), &hir_options);
        let second = build_hir(&fixture.source, options(&fixture), &hir_options);
        assert_eq!(first, second, "{} must be deterministic", fixture.name);

        if fixture.accepted {
            assert!(
                first.diagnostics.is_empty(),
                "{}: {:?}",
                fixture.name,
                first.diagnostics
            );
            let hir = first.hir.as_ref().expect("accepted fixture HIR");
            verify_hir(hir).unwrap_or_else(|diagnostics| {
                panic!("{}: {:?}", fixture.name, diagnostics.as_slice())
            });
            assert_eq!(print_hir(hir), print_hir(hir));
            assert_eq!(
                hir.syntax_fragments.len(),
                first.syntax_fragments.len(),
                "{} adapter/core fragment arenas",
                fixture.name
            );
            assert!(fixture.failure_class.is_none());
            assert!(fixture.legacy_message.is_none());
            assert!(fixture.rust_code.is_none());
        } else {
            assert!(first.hir.is_none(), "{} must fail closed", fixture.name);
            let rust_code = fixture.rust_code.as_deref().expect("Rust failure code");
            assert!(
                first
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code.as_str() == rust_code),
                "{} ({}) expected {}: {:?}",
                fixture.name,
                fixture.failure_class.as_deref().unwrap_or("missing-class"),
                rust_code,
                first.diagnostics
            );
            assert!(fixture.legacy_message.is_some());
        }
    }
}
