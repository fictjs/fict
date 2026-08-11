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

fn guarantee_codes(source: &str) -> Vec<String> {
    build_hir(source, options(), &HirBuildOptions::default())
        .diagnostics
        .into_iter()
        .map(|diagnostic| diagnostic.code.as_str().to_owned())
        .filter(|code| matches!(code.as_str(), "FICT-R002" | "FICT-R005"))
        .collect()
}

#[test]
fn external_storage_follows_javascript_control_flow() {
    let cases = [
        (
            "classic for executes its body before its update",
            r#"
                import { $state } from 'fict';
                function App(holder) {
                    const count = $state(0);
                    const run = () => count;
                    let callbacks = {};
                    for (
                        let once = true;
                        once;
                        callbacks = holder.callbacks, once = false
                    ) {
                        callbacks = {};
                    }
                    callbacks.run = run;
                    return count;
                }
            "#,
            true,
        ),
        (
            "a loop backedge reaches a later iteration",
            r#"
                import { $state } from 'fict';
                function App(holder) {
                    const count = $state(0);
                    const run = () => count;
                    let callbacks = {};
                    const next = holder.callbacks;
                    while (holder.more()) {
                        callbacks.run = run;
                        callbacks = next;
                    }
                    return count;
                }
            "#,
            true,
        ),
        (
            "continue executes a classic for update",
            r#"
                import { $state } from 'fict';
                function App(holder) {
                    const count = $state(0);
                    const run = () => count;
                    let callbacks = holder.callbacks;
                    for (let once = true; once; callbacks = {}, once = false) {
                        continue;
                    }
                    callbacks.run = run;
                    return count;
                }
            "#,
            false,
        ),
        (
            "finally transforms a pending break state",
            r#"
                import { $state } from 'fict';
                function App(holder) {
                    const count = $state(0);
                    const run = () => count;
                    let callbacks = {};
                    outer: while (true) {
                        try {
                            callbacks = holder.callbacks;
                            break outer;
                        } finally {
                            callbacks = {};
                        }
                    }
                    callbacks.run = run;
                    return count;
                }
            "#,
            false,
        ),
        (
            "an assignment after break is unreachable",
            r#"
                import { $state } from 'fict';
                function App(holder) {
                    const count = $state(0);
                    const run = () => count;
                    let callbacks = {};
                    while (true) {
                        break;
                        callbacks = holder.callbacks;
                    }
                    callbacks.run = run;
                    return count;
                }
            "#,
            false,
        ),
        (
            "switch break prevents state from leaking into another case",
            r#"
                import { $state } from 'fict';
                function App(holder) {
                    const count = $state(0);
                    const run = () => count;
                    let callbacks = {};
                    switch (holder.kind) {
                        case 0:
                            callbacks = holder.callbacks;
                            break;
                        case 1:
                            callbacks.run = run;
                            break;
                    }
                    return count;
                }
            "#,
            false,
        ),
        (
            "switch fallthrough carries state into the next case",
            r#"
                import { $state } from 'fict';
                function App(holder) {
                    const count = $state(0);
                    const run = () => count;
                    let callbacks = {};
                    switch (holder.kind) {
                        case 0:
                            callbacks = holder.callbacks;
                        case 1:
                            callbacks.run = run;
                    }
                    return count;
                }
            "#,
            true,
        ),
        (
            "an optional call preserves the skipped argument path",
            r#"
                import { $state } from 'fict';
                function App(holder) {
                    const count = $state(0);
                    const run = () => count;
                    let callbacks = holder.callbacks;
                    holder.install?.(callbacks = {});
                    callbacks.run = run;
                    return count;
                }
            "#,
            true,
        ),
    ];

    let mut mismatches = Vec::new();
    for (name, source, expected_r005) in cases {
        let codes = guarantee_codes(source);
        let actual_r005 = codes.iter().any(|code| code == "FICT-R005");
        let unexpected_escape = !expected_r005 && !codes.is_empty();
        if actual_r005 != expected_r005 || unexpected_escape {
            mismatches.push(format!(
                "{name}: expected R005={expected_r005}, got {actual_r005}; diagnostics={codes:?}"
            ));
        }
    }

    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}
