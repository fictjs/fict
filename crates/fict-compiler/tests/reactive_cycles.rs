use std::collections::BTreeSet;

use fict_compiler::{
    COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions, CorePassOptions, WarningLevel,
    compile, run_core_passes,
};
use fict_compiler_oxc::{
    HirBuildOptions, OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, build_hir,
};
use fict_hir::LocalId;

fn compile_source(source: &str, options: CompilerOptions) -> fict_compiler::CompileResult {
    compile(CompileRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: source.into(),
        filename: "cycle.tsx".into(),
        module_id: None,
        public_module_id: None,
        language: None,
        module_kind: None,
        input_source_map: None,
        options,
        metadata: Vec::new(),
        integration_diagnostics: Vec::new(),
        limits: Default::default(),
    })
}

fn assert_cycle_error(source: &str) {
    let result = compile_source(
        source,
        CompilerOptions {
            strict_guarantee: false,
            ..CompilerOptions::default()
        },
    );
    let cycle = result
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code.as_str() == "FICT-R-CYCLE")
        .unwrap_or_else(|| panic!("missing cycle diagnostic: {:#?}", result.diagnostics));
    assert_eq!(cycle.severity, fict_diagnostics::DiagnosticSeverity::Error);
    assert!(cycle.primary_span.is_some(), "{cycle:#?}");
    assert!(
        cycle
            .notes
            .iter()
            .any(|note| note.starts_with("cycle SCC nodes:")),
        "{cycle:#?}"
    );
    assert!(
        cycle
            .notes
            .iter()
            .any(|note| note.starts_with("cycle dependency edges:")),
        "{cycle:#?}"
    );
}

#[test]
fn long_forward_reference_cycle_retains_every_graph_edge() {
    let source = r#"
        import { $state } from 'fict'
        function Component() {
            const count = $state(0)
            const a = count + b
            const b = c + 1
            const c = a + 1
            return a + b + c
        }
    "#;
    let build = build_hir(
        source,
        OxcCompileOptions {
            language: OxcSourceLanguage::TypeScriptJsx,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions {
            strict_guarantee: false,
            ..HirBuildOptions::default()
        },
    );
    let hir = build
        .hir
        .unwrap_or_else(|| panic!("HIR diagnostics: {:#?}", build.diagnostics));
    let core = run_core_passes(
        &hir,
        CorePassOptions {
            optimize: false,
            ..CorePassOptions::default()
        },
    )
    .expect("core analyses");
    let analysis = core
        .functions
        .iter()
        .find(|analysis| {
            core.hir.functions[analysis.function.as_usize()]
                .locals
                .iter()
                .any(|local| local.debug_name.as_deref() == Some("count"))
        })
        .expect("Component analysis");
    let function = &core.hir.functions[analysis.function.as_usize()];
    let local_name = |local: LocalId| {
        function.locals[local.as_usize()]
            .debug_name
            .as_deref()
            .expect("named source local")
    };
    let cycle = analysis.cycles.cycles.first().expect("derived SCC");
    assert_eq!(
        cycle
            .nodes
            .iter()
            .map(|node| local_name(node.local))
            .collect::<Vec<_>>(),
        ["a", "b", "c"],
        "SCC: {cycle:#?}; scopes: {:#?}",
        analysis.scopes
    );
    let edges: BTreeSet<_> = cycle
        .edges
        .iter()
        .map(|edge| (local_name(edge.from.local), local_name(edge.to.local)))
        .collect();
    assert_eq!(edges, BTreeSet::from([("a", "c"), ("b", "a"), ("c", "b")]));
}

#[test]
fn forward_reference_resolution_does_not_merge_ordinary_ssa_versions() {
    let source = r#"
        import { $state } from 'fict'
        function Component() {
            const count = $state(0)
            let snapshot = count + 1
            snapshot = 0
            const plain = snapshot + 1
            return plain
        }
    "#;
    let build = build_hir(
        source,
        OxcCompileOptions {
            language: OxcSourceLanguage::TypeScriptJsx,
            module_kind: OxcModuleKind::Module,
            typescript: Default::default(),
            sourcemap: false,
        },
        &HirBuildOptions {
            strict_guarantee: false,
            ..HirBuildOptions::default()
        },
    );
    let hir = build
        .hir
        .unwrap_or_else(|| panic!("HIR diagnostics: {:#?}", build.diagnostics));
    let core = run_core_passes(
        &hir,
        CorePassOptions {
            optimize: false,
            ..CorePassOptions::default()
        },
    )
    .expect("core analyses");
    let analysis = core
        .functions
        .iter()
        .find(|analysis| {
            core.hir.functions[analysis.function.as_usize()]
                .locals
                .iter()
                .any(|local| local.debug_name.as_deref() == Some("snapshot"))
        })
        .expect("Component analysis");
    let function = &core.hir.functions[analysis.function.as_usize()];
    assert!(analysis.cycles.cycles.is_empty(), "{:#?}", analysis.cycles);
    assert!(
        analysis.scopes.bindings.iter().all(|binding| {
            function.locals[binding.name.local.as_usize()]
                .debug_name
                .as_deref()
                != Some("plain")
        }),
        "ordinary reassignment version must not inherit the earlier derived version: {:#?}",
        analysis.scopes
    );
}

#[test]
fn ordinary_versions_do_not_form_forward_cycles_across_control_flow() {
    for source in [
        r#"
            import { $state } from 'fict'
            function Component(flag) {
                const count = $state(1)
                let value = 0
                if (flag) {
                    const derived = count + value
                    value = derived + 1
                }
                return value
            }
        "#,
        r#"
            import { $state } from 'fict'
            function Component(items) {
                const count = $state(1)
                let value = 0
                for (const item of items) {
                    const derived = count + value
                    value = derived + item
                }
                return value
            }
        "#,
        r#"
            import { $state } from 'fict'
            function Component() {
                const count = $state(1)
                let value = 0
                try {
                    const derived = count + value
                    value = derived + 1
                } catch {
                    value = count + 2
                }
                return value
            }
        "#,
    ] {
        let result = compile_source(
            source,
            CompilerOptions {
                strict_guarantee: false,
                ..CompilerOptions::default()
            },
        );
        assert!(
            result
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code.as_str() != "FICT-R-CYCLE"),
            "unexpected cycle for source:\n{source}\n{:#?}",
            result.diagnostics
        );
    }
}

#[test]
fn rejects_long_branch_region_and_alias_derived_cycles() {
    for source in [
        r#"
            import { $state } from 'fict'
            function Component() {
                const count = $state(0)
                const a = count + b
                const b = c + 1
                const c = a + 1
                return a + b + c
            }
        "#,
        r#"
            import { $state } from 'fict'
            function Component() {
                const count = $state(0)
                const a = count + b
                const b = c + 1
                const c = d + 1
                const d = a + 1
                return a + b + c + d
            }
        "#,
        r#"
            import { $state } from 'fict'
            function Component(flag) {
                const count = $state(0)
                if (flag) {
                    const a = count + b
                    const b = c + 1
                    const c = a + 1
                    return a + b + c
                }
                return count
            }
        "#,
        r#"
            import { $state } from 'fict'
            function Component() {
                const count = $state(0)
                const a = count + alias
                const alias = b
                const b = a + 1
                return a + alias + b
            }
        "#,
    ] {
        assert_cycle_error(source);
    }
}

#[test]
fn cycle_error_is_unsuppressible_and_points_to_the_first_scc_binding() {
    let source = r#"
        import { $state } from 'fict'
        function Component() {
            const count = $state(0)
            // fict-ignore FICT-R-CYCLE
            const a = count + b
            const b = c + 1
            const c = a + 1
            return a + b + c
        }
    "#;
    let mut options = CompilerOptions {
        strict_guarantee: false,
        ..CompilerOptions::default()
    };
    options
        .warning_levels
        .insert("FICT-R-CYCLE".into(), WarningLevel::Off);
    let result = compile_source(source, options);
    let diagnostic = result
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code.as_str() == "FICT-R-CYCLE")
        .unwrap_or_else(|| {
            panic!(
                "missing unsuppressible diagnostic: {:#?}",
                result.diagnostics
            )
        });
    let start = source.find("const a").expect("a declaration") + "const ".len();
    assert_eq!(
        diagnostic.primary_span,
        fict_diagnostics::SourceSpan::new(
            u32::try_from(start).expect("source offset"),
            u32::try_from(start + 1).expect("source offset"),
        )
    );
    assert_eq!(diagnostic.secondary_labels.len(), 2);
    assert_eq!(
        diagnostic.severity,
        fict_diagnostics::DiagnosticSeverity::Error
    );
}
