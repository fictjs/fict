use fict_compiler::{CorePassBudgets, CorePassOptions, run_core_passes};
use fict_compiler_oxc::{
    HirBuildOptions, OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, build_hir,
};
use fict_hir::{FunctionKind, StructuredSourceKind};

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

#[test]
fn analyzes_frontend_if_cfg_as_control_dependent_reactive_work() {
    let frontend = build_hir(
        r#"
            import { $state } from 'fict';
            export function App() {
                const count = $state(0);
                if (count > 10 && maybe()) return <Big />;
                return <Small />;
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
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified frontend CFG"),
        CorePassOptions::default(),
    )
    .expect("core passes over frontend CFG");
    let app = output
        .hir
        .functions
        .iter()
        .find(|function| function.kind == FunctionKind::Component)
        .expect("component function");
    let analysis = &output.functions[app.id.as_usize()];

    assert_eq!(app.blocks.len(), 4);
    assert!(!analysis.dependencies.control_flow_reads.is_empty());
    assert!(!analysis.dependencies.barriers.is_empty());
    assert_eq!(analysis.structurize.stats.conditionals, 1);
    assert!(analysis.structurize.fallback.is_none());
    assert_eq!(
        analysis
            .ssa
            .cfg
            .reachable
            .iter()
            .filter(|reachable| **reachable)
            .count(),
        4
    );
}

#[test]
fn analyzes_frontend_while_cfg_with_a_backedge_and_reactive_phi() {
    let frontend = build_hir(
        r#"
            import { $state } from 'fict';
            export function App() {
                let count = $state(0);
                while (count < 3) count++;
                return <span>{count}</span>;
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
    assert!(
        frontend.diagnostics.is_empty(),
        "{:?}",
        frontend.diagnostics
    );
    let output = run_core_passes(
        &frontend.hir.expect("verified frontend loop CFG"),
        CorePassOptions::default(),
    )
    .expect("core passes over loop CFG");
    let app = output
        .hir
        .functions
        .iter()
        .find(|function| function.kind == FunctionKind::Component)
        .expect("component function");
    let analysis = &output.functions[app.id.as_usize()];
    let count = app
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("count"))
        .expect("count local")
        .id;

    assert_eq!(app.blocks.len(), 4);
    assert_eq!(analysis.ssa.cfg.back_edges.len(), 1);
    assert_eq!(analysis.ssa.cfg.loop_headers.len(), 1);
    assert!(
        analysis
            .ssa
            .phis
            .iter()
            .any(|phi| phi.target.local == count)
    );
    assert!(!analysis.dependencies.control_flow_reads.is_empty());
    assert_eq!(analysis.structurize.stats.loops, 1);
    assert!(analysis.structurize.fallback.is_none());
    let header = analysis.ssa.cfg.loop_headers[0];
    assert!(matches!(
        app.blocks[header.as_usize()]
            .source_hint
            .as_ref()
            .map(|hint| &hint.kind),
        Some(StructuredSourceKind::WhileLoop)
    ));
}
