#![no_main]

use fict_compiler::{CorePassBudgets, CorePassOptions, run_core_passes};
use fict_compiler_oxc::{
    HirBuildOptions, OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, build_hir,
};
use fict_hir::{print_hir, verify_hir};
use libfuzzer_sys::fuzz_target;

const MAX_INPUT_BYTES: usize = 64 * 1024;

fuzz_target!(|data: &[u8]| {
    if data.len() < 2 || data.len() > MAX_INPUT_BYTES {
        return;
    }
    let Ok(source) = std::str::from_utf8(&data[2..]) else {
        return;
    };
    let language = match data[0] & 0b11 {
        0 => OxcSourceLanguage::JavaScript,
        1 => OxcSourceLanguage::TypeScript,
        2 => OxcSourceLanguage::JavaScriptJsx,
        _ => OxcSourceLanguage::TypeScriptJsx,
    };
    let module_kind = if data[1] & 1 == 0 {
        OxcModuleKind::Module
    } else {
        OxcModuleKind::CommonJs
    };
    let frontend = build_hir(
        source,
        OxcCompileOptions {
            language,
            module_kind,
            typescript: Default::default(),
            sourcemap: data[0] & 0b1000 != 0,
        },
        &HirBuildOptions {
            strict_guarantee: data[1] & 0b10 == 0,
            ..HirBuildOptions::default()
        },
    );
    let Some(hir) = frontend.hir else {
        return;
    };
    verify_hir(&hir).expect("the OXC builder must never publish invalid HIR");

    let options = CorePassOptions {
        optimize: data[0] & 0b100 == 0,
        budgets: CorePassBudgets {
            max_functions: 512,
            max_values: 20_000,
            max_blocks: 10_000,
            max_regions: 10_000,
            max_fixed_point_iterations: 100_000,
            max_optimizer_iterations: 32,
        },
    };
    let Ok(first) = run_core_passes(&hir, options) else {
        return;
    };
    verify_hir(&first.hir).expect("the core pipeline must preserve HIR invariants");

    let second = run_core_passes(&hir, options)
        .expect("a deterministic input accepted once must be accepted again");
    assert_eq!(print_hir(&first.hir), print_hir(&second.hir));
    assert_eq!(first.functions, second.functions);
    assert_eq!(first.stats.counters, second.stats.counters);
});
