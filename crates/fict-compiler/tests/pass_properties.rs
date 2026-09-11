use fict_compiler::{CorePassOptions, run_core_passes};
use fict_compiler_oxc::{
    HirBuildOptions, OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, build_hir,
};
use fict_hir::{print_hir, verify_hir};
use fict_reactivity::{
    ConstantPropagationOptions, analyze_aliases, analyze_constants, analyze_cse, analyze_dce,
    analyze_dependencies, analyze_ssa, apply_constant_folding, apply_cse_rewrites, apply_dce,
};

// Reference the previous conservative invalidation strategy: every rewrite is
// applied and every analysis rebuilt, including when a rewrite plan is empty.
fn eagerly_recomputed_optimization(input: &fict_hir::HirFile) -> fict_compiler::CorePassOutput {
    let mut hir = input.clone();
    for index in 0..hir.functions.len() {
        let id = fict_hir::FunctionId::new(index as u32);
        let ssa = analyze_ssa(&hir.functions[index]).expect("reference SSA");
        let constants = analyze_constants(
            &hir.functions[index],
            &ssa,
            ConstantPropagationOptions::default(),
        )
        .expect("reference constants");
        hir = apply_constant_folding(&hir, id, &constants).expect("reference folding");
        let ssa = analyze_ssa(&hir.functions[index]).expect("reference SSA after folding");
        let dependencies = analyze_dependencies(&hir, id, &ssa).expect("reference dependencies");
        let cse = analyze_cse(&hir.functions[index], &ssa, &dependencies).expect("reference CSE");
        hir = apply_cse_rewrites(&hir, id, &cse).expect("reference CSE rewrites");
        let ssa = analyze_ssa(&hir.functions[index]).expect("reference SSA after CSE");
        let dependencies =
            analyze_dependencies(&hir, id, &ssa).expect("reference final dependencies");
        let aliases = analyze_aliases(&hir, id, &ssa, &dependencies).expect("reference aliases");
        let dce = analyze_dce(&hir, id, &ssa, &dependencies, &aliases).expect("reference DCE");
        hir = apply_dce(&hir, id, &dce).expect("reference compaction");
    }
    run_core_passes(
        &hir,
        CorePassOptions {
            optimize: false,
            ..CorePassOptions::default()
        },
    )
    .expect("reference final analyses")
}

#[test]
fn retained_analyses_match_eager_recomputation_after_empty_and_nonempty_rewrites() {
    let cases = [
        "export function equal(a, b) { const first = a === b; const second = a === b; return [first, second]; }",
        "export function folded() { const dead = 6 * 7; const value = (1 + 2) * 3; return value; }",
        "export function primitive() { const a = !false; return [a, 1 === 1, delete 1]; }",
        "export function branch(a) { let b = 1 + 2; if (a) { b = 3 + 4; } else { b = 5 + 6; } return b; }",
        "export function outer(a) { const dead = 1 + 2; function inner() { return a + 3; } return inner; }",
        "export function effect(obj) { const a = obj.value; obj.value = 2; const b = obj.value; return [a,b]; }",
        "import { $state } from 'fict'; export function App(props) { let value = $state(props.initial); const increment = () => value++; return <button onClick={increment}>{value * 2}</button>; }",
    ];
    let mut mutations = [0_u64; 3];
    for source in cases {
        let build = build_hir(source, compile_options(), &HirBuildOptions::default());
        assert!(build.diagnostics.is_empty(), "{:?}", build.diagnostics);
        let hir = build.hir.expect("reference fixture HIR");
        let expected = eagerly_recomputed_optimization(&hir);
        let actual = run_core_passes(&hir, CorePassOptions::default()).expect("retained analyses");
        assert_eq!(actual.hir, expected.hir, "{source}");
        assert_eq!(actual.functions, expected.functions, "{source}");
        assert_eq!(actual.diagnostics, expected.diagnostics, "{source}");
        for (index, name) in ["constantsFolded", "cseReplacements", "deadValues"]
            .into_iter()
            .enumerate()
        {
            mutations[index] += actual.stats.counters[name];
        }
    }
    assert!(
        mutations.iter().all(|count| *count > 0),
        "exercise all rewrite invalidations: {mutations:?}"
    );
}

#[derive(Debug, Clone, Copy)]
struct DeterministicRng(u64);

#[test]
fn region_phi_inputs_preserve_accepted_unsorted_binding_facts() {
    let source = "import { $state } from 'fict'; export function App(props) { let state = $state(props.initial); let value = 0; if (props.flag) { value = state + 1; } else { value = state * 2; } return <div>{value}</div>; }";
    let build = build_hir(source, compile_options(), &HirBuildOptions::default());
    assert!(build.diagnostics.is_empty(), "{:?}", build.diagnostics);
    let output = run_core_passes(&build.hir.unwrap(), CorePassOptions::default()).unwrap();
    let mut phi_count = 0;
    for facts in &output.functions {
        phi_count += facts
            .scopes
            .bindings
            .iter()
            .filter(|binding| {
                matches!(
                    binding.location,
                    fict_reactivity::SsaDefinitionLocation::Phi(_)
                )
            })
            .count();
        let mut scopes = facts.scopes.clone();
        scopes.bindings.reverse();
        let actual = fict_reactivity::analyze_regions(
            &output.hir,
            &output.hir.functions[facts.function.as_usize()],
            &facts.ssa,
            &facts.dependencies,
            &scopes,
            &facts.cycles,
        )
        .expect("the existing verifier accepts unique, unsorted bindings");
        assert_eq!(actual, facts.regions);
    }
    assert!(phi_count > 0, "exercise tracked Phi dependencies");
}

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

// Independent full-scan oracle for the indexed region facts and hierarchy.
// Keep the deliberately simple scans here so indexing bugs cannot reproduce
// themselves in the expected result.
fn assert_region_reference(output: &fict_compiler::CorePassOutput) {
    use fict_hir::{HirInstructionKind, ScopeId};
    use fict_reactivity::{DependencyBase, InstructionLocation, SsaDefinitionLocation};
    use std::collections::BTreeSet;

    let ancestors = |mut scope: ScopeId| {
        let mut result = Vec::new();
        while let Some(parent) = output.hir.scopes[scope.as_usize()].parent {
            result.push(parent);
            scope = parent;
        }
        result
    };
    for facts in &output.functions {
        let function = &output.hir.functions[facts.function.as_usize()];
        for region in &facts.regions.regions {
            let contains = |location: InstructionLocation| {
                region.ranges.iter().any(|range| {
                    location.block == range.block
                        && location.instruction >= range.start
                        && location.instruction < range.end
                })
            };
            let outputs: BTreeSet<_> = facts
                .scopes
                .bindings
                .iter()
                .filter(|binding| match binding.location {
                    SsaDefinitionLocation::Instruction { block, instruction } => {
                        contains(InstructionLocation { block, instruction })
                    }
                    SsaDefinitionLocation::Phi(block) => {
                        facts.regions.regions_by_block[block.as_usize()].first() == Some(&region.id)
                    }
                    SsaDefinitionLocation::Entry => false,
                })
                .map(|binding| binding.name)
                .collect();
            assert_eq!(region.outputs, outputs.iter().copied().collect::<Vec<_>>());
            let external = |path: &&fict_reactivity::DependencyPath| !matches!(path.base, DependencyBase::Ssa(name) if outputs.contains(&name));
            let mut inputs: BTreeSet<_> = facts
                .dependencies
                .reads
                .iter()
                .filter(|read| contains(read.location))
                .map(|read| &read.path)
                .filter(external)
                .cloned()
                .collect();
            for range in &region.ranges {
                for instruction in &function.blocks[range.block.as_usize()].instructions
                    [range.start as usize..range.end as usize]
                {
                    if matches!(instruction.kind, HirInstructionKind::Jsx { .. })
                        && let Some(result) = instruction.result
                    {
                        inputs.extend(
                            facts.dependencies.value_dependencies[result.as_usize()]
                                .iter()
                                .filter(external)
                                .cloned(),
                        );
                    }
                }
            }
            for binding in &facts.scopes.bindings {
                if matches!(binding.location, SsaDefinitionLocation::Phi(_))
                    && outputs.contains(&binding.name)
                {
                    inputs.extend(binding.dependencies.iter().filter(external).cloned());
                }
            }
            assert_eq!(region.inputs, inputs.into_iter().collect::<Vec<_>>());
            assert_eq!(
                region.has_control_flow,
                facts
                    .dependencies
                    .reads
                    .iter()
                    .any(|read| read.controls_flow && contains(read.location))
            );
            let parent = facts
                .regions
                .regions
                .iter()
                .filter(|candidate| {
                    candidate.scope != region.scope
                        && ancestors(region.scope).contains(&candidate.scope)
                        && facts
                            .ssa
                            .cfg
                            .dominates(candidate.blocks[0], region.blocks[0])
                })
                .max_by_key(|candidate| (ancestors(candidate.scope).len(), candidate.id))
                .map(|candidate| candidate.id);
            assert_eq!(region.parent, parent);
        }
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
        assert_region_reference(&unoptimized);
        assert_region_reference(&optimized);
        if seed == 0 {
            let facts = optimized
                .functions
                .iter()
                .find(|facts| !facts.regions.regions.is_empty())
                .expect("region fixture");
            let mut invalid = facts.regions.clone();
            invalid.regions[0].ranges[0].start = invalid.regions[0].ranges[0].end + 1;
            let error = fict_reactivity::verify_regions(
                &optimized.hir.functions[facts.function.as_usize()],
                &facts.dependencies,
                &facts.scopes,
                &facts.cycles,
                &invalid,
            )
            .expect_err("invalid range must fail without panicking");
            assert!(
                error
                    .as_slice()
                    .iter()
                    .any(|diagnostic| diagnostic.code.as_str() == "FICT-REGION-RANGE")
            );
        }
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
