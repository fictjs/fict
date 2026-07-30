use std::collections::BTreeMap;
use std::time::Instant;

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_hir::{FunctionId, HirFile, verify_hir};
use fict_reactivity::{
    AliasAnalysis, ConstantPropagationOptions, DceAnalysis, DependencyAnalysis,
    ReactiveCycleAnalysis, ReactiveScopeAnalysis, RegionAnalysis, ShapeAnalysis, SsaAnalysis,
    StructurizeAnalysis, analyze_aliases, analyze_constants, analyze_cse, analyze_dce,
    analyze_dependencies, analyze_reactive_cycles, analyze_reactive_scopes, analyze_regions,
    analyze_shapes, analyze_ssa, apply_constant_folding, apply_cse_rewrites, apply_dce,
    structurize_cfg,
};

use crate::reactive_write_validation::validate_reactive_writes;

/// Uniform contract for deterministic compiler passes.
pub trait CompilerPass {
    /// Explicit pass input.
    type Input;
    /// Explicit pass output.
    type Output;

    /// Stable stats/debug stage name.
    fn name(&self) -> &'static str;

    /// Run without hidden global or thread-local state.
    fn run(
        &self,
        input: Self::Input,
        context: &mut PassContext,
    ) -> Result<Self::Output, DiagnosticBundle>;
}

/// Hard resource/fixed-point budgets for one core compilation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CorePassBudgets {
    /// Maximum functions in one HIR file.
    pub max_functions: u32,
    /// Maximum total function-local values.
    pub max_values: u32,
    /// Maximum total CFG blocks.
    pub max_blocks: u32,
    /// Maximum total reactive regions.
    pub max_regions: u32,
    /// Maximum aggregate analysis fixed-point sweeps.
    pub max_fixed_point_iterations: u32,
    /// Constant propagation sweeps per function.
    pub max_optimizer_iterations: u32,
}

impl Default for CorePassBudgets {
    fn default() -> Self {
        Self {
            max_functions: 16_384,
            max_values: 2_000_000,
            max_blocks: 500_000,
            max_regions: 500_000,
            max_fixed_point_iterations: 2_000_000,
            max_optimizer_iterations: 256,
        }
    }
}

/// Core pass configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CorePassOptions {
    /// Run safe constant/CSE/DCE mutations before final analysis.
    pub optimize: bool,
    /// Escalate fallback diagnostics that cannot preserve fine-grained guarantees.
    pub strict_guarantee: bool,
    /// Resource budgets.
    pub budgets: CorePassBudgets,
}

impl Default for CorePassOptions {
    fn default() -> Self {
        Self {
            optimize: true,
            strict_guarantee: true,
            budgets: CorePassBudgets::default(),
        }
    }
}

/// Per-stage timing and deterministic structural counters.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CorePassStats {
    /// Aggregate stage durations in nanoseconds.
    pub stage_durations_ns: BTreeMap<String, u64>,
    /// Stable counters; never include source text or physical paths.
    pub counters: BTreeMap<String, u64>,
}

/// Mutable, request-local pass context.
#[derive(Debug)]
pub struct PassContext {
    /// Core options/budgets.
    pub options: CorePassOptions,
    /// Accumulated local stats.
    pub stats: CorePassStats,
}

impl PassContext {
    /// Construct a request-local context.
    #[must_use]
    pub fn new(options: CorePassOptions) -> Self {
        Self {
            options,
            stats: CorePassStats::default(),
        }
    }

    /// Run one contract pass and record its stable stage duration.
    pub fn run<P: CompilerPass>(
        &mut self,
        pass: &P,
        input: P::Input,
    ) -> Result<P::Output, DiagnosticBundle> {
        let start = Instant::now();
        let result = pass.run(input, self);
        self.record_duration(pass.name(), start.elapsed().as_nanos());
        result
    }

    fn record_duration(&mut self, stage: &str, elapsed_ns: u128) {
        let elapsed = u64::try_from(elapsed_ns).unwrap_or(u64::MAX);
        let counter = self
            .stats
            .stage_durations_ns
            .entry(stage.to_owned())
            .or_default();
        *counter = counter.saturating_add(elapsed);
    }

    fn set_counter(&mut self, name: &str, value: usize) {
        self.stats
            .counters
            .insert(name.to_owned(), u64::try_from(value).unwrap_or(u64::MAX));
    }
}

/// Final analyses for one optimized HIR function.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FunctionPassAnalysis {
    /// Function identity.
    pub function: FunctionId,
    /// Structural SSA and CFG.
    pub ssa: SsaAnalysis,
    /// Read/write/effect facts.
    pub dependencies: DependencyAnalysis,
    /// Versioned alias classes.
    pub aliases: AliasAnalysis,
    /// Object/array/reactive shapes.
    pub shapes: ShapeAnalysis,
    /// Tracked scope facts.
    pub scopes: ReactiveScopeAnalysis,
    /// Reactive dependency SCCs.
    pub cycles: ReactiveCycleAnalysis,
    /// Barrier-safe regions.
    pub regions: RegionAnalysis,
    /// Structured CFG or explicit fallback.
    pub structurize: StructurizeAnalysis,
}

/// Verified optimized HIR plus complete final analyses and stats.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorePassOutput {
    /// Optimized, region-materialized HIR.
    pub hir: HirFile,
    /// Function analyses in function arena order.
    pub functions: Vec<FunctionPassAnalysis>,
    /// Non-fatal findings produced after final binding and SSA analysis.
    pub diagnostics: Vec<fict_diagnostics::Diagnostic>,
    /// Per-pass timings and counters.
    pub stats: CorePassStats,
}

/// Run the complete M3 core pass pipeline with explicit invalidation/recomputation.
pub fn run_core_passes(
    input: &HirFile,
    options: CorePassOptions,
) -> Result<CorePassOutput, DiagnosticBundle> {
    let mut context = PassContext::new(options);
    timed(&mut context, "verify-hir", || verify_hir(input))?;
    enforce_initial_budgets(input, options.budgets)?;
    let mut hir = input.clone();
    let mut constants_folded = 0_usize;
    let mut cse_replacements = 0_usize;
    let mut dead_values = 0_usize;
    let mut optimization_iterations = 0_usize;

    if options.optimize {
        for function_index in 0..hir.functions.len() {
            let function_id = FunctionId::new(count_u32(function_index));
            let ssa = timed(&mut context, "optimizer-ssa", || {
                analyze_ssa(&hir.functions[function_index])
            })?;
            optimization_iterations =
                optimization_iterations.saturating_add(ssa.cfg.dominator_iterations as usize);
            let constants = timed(&mut context, "constant-propagation", || {
                analyze_constants(
                    &hir.functions[function_index],
                    &ssa,
                    ConstantPropagationOptions {
                        max_iterations: options.budgets.max_optimizer_iterations,
                    },
                )
            })?;
            optimization_iterations =
                optimization_iterations.saturating_add(constants.stats.iterations as usize);
            constants_folded = constants_folded.saturating_add(constants.foldable_values.len());
            hir = timed(&mut context, "constant-folding", || {
                apply_constant_folding(&hir, function_id, &constants)
            })?;

            let ssa = timed(&mut context, "optimizer-ssa", || {
                analyze_ssa(&hir.functions[function_index])
            })?;
            optimization_iterations =
                optimization_iterations.saturating_add(ssa.cfg.dominator_iterations as usize);
            let dependencies = timed(&mut context, "optimizer-dependencies", || {
                analyze_dependencies(&hir, function_id, &ssa)
            })?;
            optimization_iterations = optimization_iterations
                .saturating_add(dependencies.stats.fixed_point_iterations as usize);
            let cse = timed(&mut context, "cse", || {
                analyze_cse(&hir.functions[function_index], &ssa, &dependencies)
            })?;
            cse_replacements = cse_replacements.saturating_add(cse.replacements.len());
            hir = timed(&mut context, "cse-rewrite", || {
                apply_cse_rewrites(&hir, function_id, &cse)
            })?;

            let ssa = timed(&mut context, "optimizer-ssa", || {
                analyze_ssa(&hir.functions[function_index])
            })?;
            optimization_iterations =
                optimization_iterations.saturating_add(ssa.cfg.dominator_iterations as usize);
            let dependencies = timed(&mut context, "optimizer-dependencies", || {
                analyze_dependencies(&hir, function_id, &ssa)
            })?;
            optimization_iterations = optimization_iterations
                .saturating_add(dependencies.stats.fixed_point_iterations as usize);
            let aliases = timed(&mut context, "optimizer-aliases", || {
                analyze_aliases(&hir, function_id, &ssa, &dependencies)
            })?;
            optimization_iterations = optimization_iterations
                .saturating_add(aliases.stats.fixed_point_iterations as usize);
            let dce: DceAnalysis = timed(&mut context, "dce", || {
                analyze_dce(&hir, function_id, &ssa, &dependencies, &aliases)
            })?;
            dead_values = dead_values.saturating_add(dce.dead_values.len());
            hir = timed(&mut context, "dce-compact", || {
                apply_dce(&hir, function_id, &dce)
            })?;
        }
    }

    timed(&mut context, "verify-optimized-hir", || verify_hir(&hir))?;
    enforce_initial_budgets(&hir, options.budgets)?;
    let mut functions = Vec::with_capacity(hir.functions.len());
    let mut fixed_point_iterations = optimization_iterations;
    let mut total_regions = 0_usize;
    let mut total_cycles = 0_usize;
    for function_index in 0..hir.functions.len() {
        let function_id = FunctionId::new(count_u32(function_index));
        let function = &hir.functions[function_index];
        let ssa = timed(&mut context, "ssa", || analyze_ssa(function))?;
        let dependencies = timed(&mut context, "dependencies", || {
            analyze_dependencies(&hir, function_id, &ssa)
        })?;
        let aliases = timed(&mut context, "aliases", || {
            analyze_aliases(&hir, function_id, &ssa, &dependencies)
        })?;
        let shapes = timed(&mut context, "shapes", || {
            analyze_shapes(&hir, function_id, &ssa, &dependencies, &aliases)
        })?;
        let scopes = timed(&mut context, "reactive-scopes", || {
            analyze_reactive_scopes(&hir, function_id, &ssa, &dependencies, &aliases, &shapes)
        })?;
        let cycles = timed(&mut context, "reactive-cycles", || {
            analyze_reactive_cycles(function, &scopes)
        })?;
        let regions = timed(&mut context, "regions", || {
            analyze_regions(&hir, function, &ssa, &dependencies, &scopes, &cycles)
        })?;
        let structurize = timed(&mut context, "structurize", || {
            structurize_cfg(function, &ssa.cfg)
        })?;
        fixed_point_iterations = fixed_point_iterations
            .saturating_add(ssa.cfg.dominator_iterations as usize)
            .saturating_add(dependencies.stats.fixed_point_iterations as usize)
            .saturating_add(aliases.stats.fixed_point_iterations as usize)
            .saturating_add(shapes.stats.fixed_point_iterations as usize)
            .saturating_add(scopes.stats.fixed_point_iterations as usize);
        total_regions = total_regions.saturating_add(regions.regions.len());
        total_cycles = total_cycles.saturating_add(cycles.cycles.len());
        functions.push(FunctionPassAnalysis {
            function: function_id,
            ssa,
            dependencies,
            aliases,
            shapes,
            scopes,
            cycles,
            regions,
            structurize,
        });
    }
    let reactive_write_validation = timed(&mut context, "reactive-write-validation", || {
        validate_reactive_writes(&hir, &functions, options.strict_guarantee)
    })?;
    context.set_counter(
        "stateProvenanceWorkItems",
        reactive_write_validation.provenance_work_items,
    );
    context.set_counter(
        "stateProvenanceDependencyEdges",
        reactive_write_validation.provenance_dependency_edges,
    );
    context.set_counter(
        "stateProvenanceValueVisits",
        reactive_write_validation.provenance_value_visits,
    );
    let reactive_write_diagnostics = reactive_write_validation.diagnostics;
    if reactive_write_diagnostics.has_errors() {
        return Err(reactive_write_diagnostics);
    }
    enforce_final_budgets(total_regions, fixed_point_iterations, options.budgets)?;
    for analysis in &functions {
        hir.functions[analysis.function.as_usize()].regions = analysis
            .regions
            .regions
            .iter()
            .map(|region| region.id)
            .collect();
    }
    timed(&mut context, "verify-final-hir", || verify_hir(&hir))?;
    context.set_counter("functions", hir.functions.len());
    context.set_counter(
        "values",
        hir.functions
            .iter()
            .map(|function| function.values.len())
            .sum(),
    );
    context.set_counter(
        "blocks",
        hir.functions
            .iter()
            .map(|function| function.blocks.len())
            .sum(),
    );
    context.set_counter("regions", total_regions);
    context.set_counter("cycles", total_cycles);
    context.set_counter("fixedPointIterations", fixed_point_iterations);
    context.set_counter("constantsFolded", constants_folded);
    context.set_counter("cseReplacements", cse_replacements);
    context.set_counter("deadValues", dead_values);
    Ok(CorePassOutput {
        hir,
        functions,
        diagnostics: reactive_write_diagnostics.into_sorted(),
        stats: context.stats,
    })
}

fn timed<T>(
    context: &mut PassContext,
    stage: &'static str,
    operation: impl FnOnce() -> Result<T, DiagnosticBundle>,
) -> Result<T, DiagnosticBundle> {
    let start = Instant::now();
    let result = operation();
    context.record_duration(stage, start.elapsed().as_nanos());
    result
}

fn enforce_initial_budgets(
    hir: &HirFile,
    budgets: CorePassBudgets,
) -> Result<(), DiagnosticBundle> {
    let functions = count_u32(hir.functions.len());
    let values = count_u32(
        hir.functions
            .iter()
            .map(|function| function.values.len())
            .sum(),
    );
    let blocks = count_u32(
        hir.functions
            .iter()
            .map(|function| function.blocks.len())
            .sum(),
    );
    if functions > budgets.max_functions
        || values > budgets.max_values
        || blocks > budgets.max_blocks
    {
        return Err(DiagnosticBundle::new(vec![pass_error(
            "FICT-PASS-BUDGET",
            format!(
                "HIR exceeds core budget: functions {functions}/{}, values {values}/{}, blocks {blocks}/{}",
                budgets.max_functions, budgets.max_values, budgets.max_blocks
            ),
        )]));
    }
    Ok(())
}

fn enforce_final_budgets(
    regions: usize,
    fixed_point_iterations: usize,
    budgets: CorePassBudgets,
) -> Result<(), DiagnosticBundle> {
    let regions = count_u32(regions);
    let iterations = count_u32(fixed_point_iterations);
    if regions > budgets.max_regions || iterations > budgets.max_fixed_point_iterations {
        return Err(DiagnosticBundle::new(vec![pass_error(
            "FICT-PASS-BUDGET",
            format!(
                "analysis exceeds core budget: regions {regions}/{}, fixed-point iterations {iterations}/{}",
                budgets.max_regions, budgets.max_fixed_point_iterations
            ),
        )]));
    }
    Ok(())
}

fn pass_error(code: &'static str, message: impl Into<String>) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("pass manager diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(GuaranteeClass::Internal)
}

fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
