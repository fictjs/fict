use fict_compiler_oxc::{
    HirBuildOptions, OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, build_hir,
};

fn options() -> OxcCompileOptions {
    OxcCompileOptions {
        language: OxcSourceLanguage::JavaScript,
        module_kind: OxcModuleKind::Module,
        typescript: Default::default(),
        sourcemap: false,
    }
}

fn diagnostic_codes(source: &str) -> Vec<String> {
    build_hir(source, options(), &HirBuildOptions::default())
        .diagnostics
        .into_iter()
        .map(|diagnostic| diagnostic.code.as_str().to_owned())
        .collect()
}

#[test]
#[ignore = "known builtin receiver-exposure unsoundness; enable with callable effect summaries"]
fn builtin_effects_expose_receivers_that_user_code_retains() {
    let cases = [
        (
            "Reflect.set target setter",
            r#"
                import { $state } from 'fict';
                function App(holder) {
                    const count = $state(0);
                    const run = () => count;
                    const target = { run, set item(value) { holder.saved = this; } };
                    Reflect.set(target, 'item', 1);
                    return count;
                }
            "#,
        ),
        (
            "Reflect.get target getter",
            r#"
                import { $state } from 'fict';
                function App(holder) {
                    const count = $state(0);
                    const run = () => count;
                    const target = { run, get item() { holder.saved = this; return 1; } };
                    Reflect.get(target, 'item');
                    return count;
                }
            "#,
        ),
        (
            "Object.assign target setter",
            r#"
                import { $state } from 'fict';
                function App(holder) {
                    const count = $state(0);
                    const run = () => count;
                    const target = { run, set item(value) { holder.saved = this; } };
                    Object.assign(target, { item: 1 });
                    return count;
                }
            "#,
        ),
        (
            "Reflect.construct constructor",
            r#"
                import { $state } from 'fict';
                function App(holder) {
                    const count = $state(0);
                    const run = () => count;
                    class Target {
                        constructor() {
                            this.run = run;
                            holder.saved = this;
                        }
                    }
                    Reflect.construct(Target, []);
                    return count;
                }
            "#,
        ),
    ];

    let mut mismatches = Vec::new();
    for (name, source) in cases {
        let codes = diagnostic_codes(source);
        if !codes.iter().any(|code| code == "FICT-R005") {
            mismatches.push(format!("{name}: expected FICT-R005, got {codes:?}"));
        }
    }

    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}
