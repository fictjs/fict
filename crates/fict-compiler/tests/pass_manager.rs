use fict_compiler::{CorePassBudgets, CorePassOptions, run_core_passes};
use fict_compiler_oxc::{
    HirBuildOptions, OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, build_hir,
};

fn build_fixture() -> fict_hir::HirFile {
    let output = build_hir(
        r#"
            import { $state as state } from 'fict';
            export function App(props) {
                const count = state(props.initial);
                const doubled = count + count;
                return <button>{doubled}</button>;
            }
        "#,
        OxcCompileOptions {
            language: OxcSourceLanguage::JavaScriptJsx,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    output.hir.expect("verified frontend HIR")
}

#[test]
fn runs_complete_core_pipeline_and_materializes_region_ids() {
    let input = build_fixture();
    let output = run_core_passes(&input, CorePassOptions::default()).expect("core passes");

    assert_eq!(output.functions.len(), output.hir.functions.len());
    assert_eq!(
        output.stats.counters.get("functions").copied(),
        Some(output.hir.functions.len() as u64)
    );
    assert!(output.stats.stage_durations_ns.contains_key("verify-hir"));
    assert!(output.stats.stage_durations_ns.contains_key("ssa"));
    assert!(output.stats.stage_durations_ns.contains_key("regions"));
    assert!(output.stats.stage_durations_ns.contains_key("structurize"));
    for function in &output.functions {
        assert_eq!(
            output.hir.functions[function.function.as_usize()]
                .regions
                .len(),
            function.regions.regions.len()
        );
    }
}

#[test]
fn rejects_hir_that_exceeds_an_explicit_resource_budget() {
    let input = build_fixture();
    let diagnostics = run_core_passes(
        &input,
        CorePassOptions {
            optimize: false,
            budgets: CorePassBudgets {
                max_blocks: 0,
                ..CorePassBudgets::default()
            },
        },
    )
    .expect_err("zero block budget");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-PASS-BUDGET")
    );
}
