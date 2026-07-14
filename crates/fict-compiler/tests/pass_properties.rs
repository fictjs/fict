use fict_compiler::{CorePassOptions, run_core_passes};
use fict_compiler_oxc::{
    HirBuildOptions, OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, build_hir,
};
use fict_hir::{print_hir, verify_hir};

#[derive(Debug, Clone, Copy)]
struct DeterministicRng(u64);

impl DeterministicRng {
    fn next(&mut self) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 32) as u32
    }

    fn below(&mut self, upper: u32) -> u32 {
        self.next() % upper
    }
}

fn generated_program(seed: u64) -> String {
    let mut rng = DeterministicRng(seed);
    let initial = rng.below(9);
    let threshold = rng.below(11) + 1;
    let then_delta = rng.below(7) + 1;
    let else_delta = rng.below(5) + 1;
    let multiplier = rng.below(4) + 2;
    let values = (0..4)
        .map(|_| (rng.below(9) + 1).to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let selected_property = ["left", "right", "center"][rng.below(3) as usize];
    format!(
        r#"
            import {{ $memo, $state }} from 'fict';

            export function App(input: number) {{
                let count = $state({initial});
                let accumulator = input ?? {initial};
                const values = [{values}];
                const record = {{ left: {initial}, right: {threshold}, center: values[0] }};

                if (accumulator > {threshold}) {{
                    accumulator += {then_delta};
                }} else {{
                    accumulator -= {else_delta};
                }}
                for (const value of values) {{
                    accumulator += value;
                }}
                switch (accumulator % 3) {{
                    case 0:
                        accumulator += record.left;
                        break;
                    case 1:
                        accumulator += record.right;
                        break;
                    default:
                        accumulator += record.center;
                }}
                try {{
                    if (input < 0) throw input;
                    accumulator *= {multiplier};
                }} catch (error) {{
                    accumulator += error;
                }} finally {{
                    accumulator += 1;
                }}

                class Model {{
                    value = accumulator;
                    static marker = {seed};
                    read() {{ return this.value; }}
                }}
                const model = new Model();
                const selected = accumulator > {threshold}
                    ? record.{selected_property}
                    : values[1];
                const derived = $memo(() => count + model.value + selected);
                return <section data-value={{derived}}>{{derived}}:{{values.map((value, index) => <span key={{index}}>{{value}}</span>)}}</section>;
            }}
        "#,
    )
}

fn compile_options() -> OxcCompileOptions {
    OxcCompileOptions {
        language: OxcSourceLanguage::TypeScriptJsx,
        module_kind: OxcModuleKind::Module,
        typescript: Default::default(),
        sourcemap: false,
    }
}

#[test]
fn generated_programs_preserve_verified_deterministic_analysis_invariants() {
    for seed in 0_u64..96 {
        let source = generated_program(0x5eed_f1c7 ^ seed);
        let first_frontend = build_hir(
            &source,
            compile_options(),
            &HirBuildOptions {
                strict_guarantee: false,
                ..HirBuildOptions::default()
            },
        );
        let second_frontend = build_hir(
            &source,
            compile_options(),
            &HirBuildOptions {
                strict_guarantee: false,
                ..HirBuildOptions::default()
            },
        );
        assert_eq!(
            first_frontend.diagnostics, second_frontend.diagnostics,
            "seed {seed} frontend diagnostics"
        );
        let first_hir = first_frontend.hir.unwrap_or_else(|| {
            panic!(
                "seed {seed} must build HIR: {:?}",
                first_frontend.diagnostics
            )
        });
        let second_hir = second_frontend
            .hir
            .unwrap_or_else(|| panic!("seed {seed} second HIR build"));
        verify_hir(&first_hir).unwrap_or_else(|error| panic!("seed {seed}: {error:?}"));
        assert_eq!(print_hir(&first_hir), print_hir(&second_hir), "seed {seed}");

        let unoptimized = run_core_passes(
            &first_hir,
            CorePassOptions {
                optimize: false,
                ..CorePassOptions::default()
            },
        )
        .unwrap_or_else(|error| panic!("seed {seed} unoptimized passes: {error:?}"));
        let optimized = run_core_passes(&first_hir, CorePassOptions::default())
            .unwrap_or_else(|error| panic!("seed {seed} optimized passes: {error:?}"));
        let repeated = run_core_passes(&first_hir, CorePassOptions::default())
            .unwrap_or_else(|error| panic!("seed {seed} repeated passes: {error:?}"));

        verify_hir(&unoptimized.hir).unwrap_or_else(|error| panic!("seed {seed}: {error:?}"));
        verify_hir(&optimized.hir).unwrap_or_else(|error| panic!("seed {seed}: {error:?}"));
        assert_eq!(optimized.hir, repeated.hir, "seed {seed} optimized HIR");
        assert_eq!(
            optimized.functions, repeated.functions,
            "seed {seed} analyses"
        );
        assert_eq!(
            optimized.stats.counters, repeated.stats.counters,
            "seed {seed} deterministic counters"
        );
        assert_eq!(optimized.functions.len(), optimized.hir.functions.len());
        assert!(
            optimized.stats.counters["values"] <= unoptimized.stats.counters["values"],
            "seed {seed} optimizer introduced values"
        );
    }
}
