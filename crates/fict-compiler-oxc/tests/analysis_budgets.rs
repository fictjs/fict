use fict_compiler_oxc::{
    HirAnalysisBudgets, HirBuildOptions, OxcCompileOptions, OxcModuleKind, OxcSourceLanguage,
    build_hir,
};

fn options() -> OxcCompileOptions {
    OxcCompileOptions {
        language: OxcSourceLanguage::JavaScript,
        module_kind: OxcModuleKind::Module,
        typescript: Default::default(),
        sourcemap: false,
    }
}

#[test]
fn frontend_semantic_limits_stop_before_hir_construction() {
    for (budgets, setting) in [
        (
            HirAnalysisBudgets {
                max_frontend_nodes: 1,
                ..HirAnalysisBudgets::default()
            },
            "maxAstNodes",
        ),
        (
            HirAnalysisBudgets {
                max_frontend_scopes: 1,
                ..HirAnalysisBudgets::default()
            },
            "maxScopes",
        ),
        (
            HirAnalysisBudgets {
                max_frontend_symbols: 1,
                ..HirAnalysisBudgets::default()
            },
            "maxSymbols",
        ),
    ] {
        let output = build_hir(
            "export function App(first, second) { const value = first + second; return value; }",
            options(),
            &HirBuildOptions {
                analysis_budgets: budgets,
                ..HirBuildOptions::default()
            },
        );
        assert!(output.hir.is_none(), "{setting} must fail before HIR");
        assert!(
            output.frontend.is_none(),
            "limited frontend must be released"
        );
        assert_eq!(output.diagnostics[0].code.as_str(), "FICT-REQUEST");
        assert!(output.diagnostics[0].message.contains(setting));
    }
}

#[test]
fn static_hook_alias_analysis_fails_closed_when_its_budget_is_exhausted() {
    let output = build_hir(
        r#"
            import { $state } from 'fict';
            function App() {
                const count = $state(0);
                const values = [];
                const source = {
                    set first(value) { delete source.second; },
                    set second(value) { values.forEach = null; },
                };
                Reflect.set(source, 'first', 1);
                Reflect.set(source, 'second', 1);
                values.forEach(() => count);
                return count;
            }
        "#,
        options(),
        &HirBuildOptions {
            analysis_budgets: HirAnalysisBudgets {
                max_static_hook_alias_iterations: 1,
                ..HirAnalysisBudgets::default()
            },
            ..HirBuildOptions::default()
        },
    );

    assert!(output.hir.is_none(), "budget exhaustion must fail closed");
    assert!(
        output.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-PASS-BUDGET"
                && diagnostic.message.contains("static hook alias analysis")
        }),
        "{:#?}",
        output.diagnostics
    );
}

#[test]
fn storage_origin_analysis_fails_closed_when_its_budget_is_exhausted() {
    let output = build_hir(
        r#"
            import { $state } from 'fict';
            function App(holder) {
                const count = $state(0);
                let callbacks = {};
                while (holder.more()) {
                    callbacks = holder.callbacks;
                }
                callbacks.run = () => count;
                return count;
            }
        "#,
        options(),
        &HirBuildOptions {
            analysis_budgets: HirAnalysisBudgets {
                max_storage_origin_block_visits: 1,
                ..HirAnalysisBudgets::default()
            },
            ..HirBuildOptions::default()
        },
    );

    assert!(output.hir.is_none(), "budget exhaustion must fail closed");
    assert!(
        output.diagnostics.iter().any(|diagnostic| {
            diagnostic.code.as_str() == "FICT-PASS-BUDGET"
                && diagnostic.message.contains("storage origin analysis")
        }),
        "{:#?}",
        output.diagnostics
    );
}
