use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_hir::{
    ArrayElement, BinaryOperator, FunctionId, HirFile, HirFunction, HirInstructionKind,
    LiteralValue, NumberLiteral, ObjectEntry, Place, PlaceBase, Projection, PropertyKey, SsaName,
    TerminatorKind, UnaryOperator, ValueId, ValueKind, verify_hir,
};

use crate::{
    DependencyAnalysis, DependencyPath, InstructionLocation, SsaAnalysis, SsaDefinitionLocation,
    SsaUseKind, SsaUseLocation, verify_ssa,
};

/// Explicit fixed-point budget for constant propagation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConstantPropagationOptions {
    /// Maximum full value/SSA sweeps.
    pub max_iterations: u32,
}

impl Default for ConstantPropagationOptions {
    fn default() -> Self {
        Self {
            max_iterations: 128,
        }
    }
}

/// Constant assigned to one HIR value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValueConstantFact {
    /// Function-local value.
    pub value: ValueId,
    /// Exact literal, including IEEE-754 bits.
    pub literal: LiteralValue,
}

/// Constant assigned to one SSA definition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SsaConstantFact {
    /// Versioned local definition.
    pub name: SsaName,
    /// Exact literal.
    pub literal: LiteralValue,
}

/// Constant propagation statistics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ConstantPropagationStats {
    /// Constant HIR values.
    pub value_constants: u32,
    /// Constant SSA definitions.
    pub ssa_constants: u32,
    /// Foldable result instructions.
    pub foldable_instructions: u32,
    /// Fixed-point sweeps.
    pub iterations: u32,
}

/// Exact, conservative constant propagation result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConstantPropagation {
    /// Sorted value facts.
    pub values: Vec<ValueConstantFact>,
    /// Sorted SSA facts.
    pub bindings: Vec<SsaConstantFact>,
    /// Result values whose instructions may be replaced with literals.
    pub foldable_values: Vec<ValueId>,
    /// Deterministic statistics.
    pub stats: ConstantPropagationStats,
}

/// One duplicate pure result redirected to an earlier dominating result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CseReplacement {
    /// Redundant result.
    pub duplicate: ValueId,
    /// Earlier result with the same pure expression.
    pub canonical: ValueId,
    /// Redundant instruction location.
    pub location: InstructionLocation,
}

/// Common-subexpression elimination statistics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CseStats {
    /// Pure expression candidates.
    pub candidates: u32,
    /// Redundant results.
    pub replacements: u32,
    /// Barriers that cleared the expression table.
    pub invalidations: u32,
}

/// Barrier-aware, block-local CSE plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CseAnalysis {
    /// Sorted duplicate-to-canonical replacements.
    pub replacements: Vec<CseReplacement>,
    /// Deterministic statistics.
    pub stats: CseStats,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum CseExpression {
    Unary(UnaryOperator, ValueId),
    Binary(BinaryOperator, ValueId, ValueId),
    Read(DependencyPath),
}

/// Find reusable pure expressions without crossing any dependency barrier.
pub fn analyze_cse(
    function: &HirFunction,
    ssa: &SsaAnalysis,
    dependencies: &DependencyAnalysis,
) -> Result<CseAnalysis, DiagnosticBundle> {
    verify_ssa(function, ssa)?;
    let barriers: BTreeSet<_> = dependencies
        .barriers
        .iter()
        .map(|barrier| barrier.location)
        .collect();
    let reads: BTreeMap<_, _> = dependencies
        .reads
        .iter()
        .map(|read| (read.location, read.path.clone()))
        .collect();
    let mut replacements = Vec::new();
    let mut canonical_values = BTreeMap::new();
    let mut candidates = 0_usize;
    let mut invalidations = 0_usize;
    for block in &function.blocks {
        if !ssa.cfg.reachable[block.id.as_usize()] {
            continue;
        }
        let mut available = BTreeMap::new();
        for (instruction_index, instruction) in block.instructions.iter().enumerate() {
            let location = InstructionLocation {
                block: block.id,
                instruction: count_u32(instruction_index),
            };
            if barriers.contains(&location) {
                available.clear();
                invalidations = invalidations.saturating_add(1);
                continue;
            }
            if instruction.semantics != fict_hir::InstructionSemantics::PURE_EAGER {
                continue;
            }
            let Some(result) = instruction.result else {
                continue;
            };
            let expression = match &instruction.kind {
                HirInstructionKind::Unary { operator, argument } => {
                    CseExpression::Unary(*operator, resolve_value(*argument, &canonical_values))
                }
                HirInstructionKind::Binary {
                    operator,
                    left,
                    right,
                } => CseExpression::Binary(
                    *operator,
                    resolve_value(*left, &canonical_values),
                    resolve_value(*right, &canonical_values),
                ),
                HirInstructionKind::Read { .. } => {
                    let Some(path) = reads.get(&location) else {
                        continue;
                    };
                    CseExpression::Read(path.clone())
                }
                _ => continue,
            };
            candidates = candidates.saturating_add(1);
            if let Some(canonical) = available.get(&expression).copied() {
                replacements.push(CseReplacement {
                    duplicate: result,
                    canonical,
                    location,
                });
                canonical_values.insert(result, canonical);
            } else {
                available.insert(expression, result);
            }
        }
    }
    replacements.sort_unstable();
    let analysis = CseAnalysis {
        stats: CseStats {
            candidates: count_u32(candidates),
            replacements: count_u32(replacements.len()),
            invalidations: count_u32(invalidations),
        },
        replacements,
    };
    verify_cse(function, dependencies, &analysis)?;
    Ok(analysis)
}

/// Redirect explicit HIR consumers to canonical CSE results and verify the full file.
pub fn apply_cse_rewrites(
    file: &HirFile,
    function_id: FunctionId,
    analysis: &CseAnalysis,
) -> Result<HirFile, DiagnosticBundle> {
    let replacements: BTreeMap<_, _> = analysis
        .replacements
        .iter()
        .map(|replacement| (replacement.duplicate, replacement.canonical))
        .collect();
    let mut result = file.clone();
    let Some(function) = result.functions.get_mut(function_id.as_usize()) else {
        return Err(DiagnosticBundle::new(vec![optimizer_error(
            "FICT-OPT-FUNCTION",
            "CSE function is outside the HIR arena",
        )]));
    };
    for block in &mut function.blocks {
        for instruction in &mut block.instructions {
            rewrite_instruction_values(instruction, &replacements);
        }
        rewrite_terminator_values(&mut block.terminator.kind, &replacements);
    }
    verify_hir(&result)?;
    Ok(result)
}

/// Verify replacement uniqueness, dominance/order, barriers, and statistics.
pub fn verify_cse(
    function: &HirFunction,
    dependencies: &DependencyAnalysis,
    analysis: &CseAnalysis,
) -> Result<(), DiagnosticBundle> {
    let mut diagnostics = DiagnosticBundle::default();
    let barriers: BTreeSet<_> = dependencies
        .barriers
        .iter()
        .map(|barrier| barrier.location)
        .collect();
    if analysis
        .replacements
        .windows(2)
        .any(|pair| pair[0] >= pair[1])
    {
        diagnostics.push(optimizer_error(
            "FICT-OPT-CSE-ORDER",
            "CSE replacements must be sorted and unique",
        ));
    }
    let result_locations: BTreeMap<_, _> = function
        .blocks
        .iter()
        .flat_map(|block| {
            block
                .instructions
                .iter()
                .enumerate()
                .filter_map(move |(index, instruction)| {
                    instruction.result.map(|result| {
                        (
                            result,
                            InstructionLocation {
                                block: block.id,
                                instruction: count_u32(index),
                            },
                        )
                    })
                })
        })
        .collect();
    for replacement in &analysis.replacements {
        let canonical = result_locations.get(&replacement.canonical);
        let duplicate = result_locations.get(&replacement.duplicate);
        if duplicate != Some(&replacement.location)
            || canonical.is_none_or(|canonical| {
                canonical.block != replacement.location.block
                    || canonical.instruction >= replacement.location.instruction
            })
            || barriers.contains(&replacement.location)
        {
            diagnostics.push(optimizer_error(
                "FICT-OPT-CSE-DOMINANCE",
                "CSE canonical result must precede its duplicate in one barrier-safe block",
            ));
        }
    }
    if analysis.stats.replacements != count_u32(analysis.replacements.len())
        || analysis.stats.candidates < analysis.stats.replacements
    {
        diagnostics.push(optimizer_error(
            "FICT-OPT-CSE-STATS",
            "CSE stats do not match replacement results",
        ));
    }
    if diagnostics.is_empty() {
        Ok(())
    } else {
        Err(diagnostics)
    }
}

/// Propagate exact primitive literals through pure operators, reads, assignments, and Phi joins.
pub fn analyze_constants(
    function: &HirFunction,
    ssa: &SsaAnalysis,
    options: ConstantPropagationOptions,
) -> Result<ConstantPropagation, DiagnosticBundle> {
    verify_ssa(function, ssa)?;
    if options.max_iterations == 0 {
        return Err(DiagnosticBundle::new(vec![optimizer_error(
            "FICT-OPT-BUDGET",
            "constant propagation requires a positive iteration budget",
        )]));
    }
    let definitions_by_location: BTreeMap<_, _> = ssa
        .definitions
        .iter()
        .filter_map(|definition| match definition.location {
            SsaDefinitionLocation::Instruction { block, instruction } => {
                Some(((block, instruction, definition.name.local), definition.name))
            }
            SsaDefinitionLocation::Entry | SsaDefinitionLocation::Phi(_) => None,
        })
        .collect();
    let read_sources: BTreeMap<_, _> = ssa
        .uses
        .iter()
        .filter_map(|usage| {
            if usage.kind != SsaUseKind::Read {
                return None;
            }
            let SsaUseLocation::Instruction { block, instruction } = usage.location else {
                return None;
            };
            let hir_instruction = function
                .blocks
                .get(block.as_usize())?
                .instructions
                .get(instruction as usize)?;
            if !matches!(&hir_instruction.kind, HirInstructionKind::Read { place } if place.is_local())
            {
                return None;
            }
            hir_instruction.result.map(|result| (result, usage.name))
        })
        .collect();
    let mut values: BTreeMap<ValueId, LiteralValue> = BTreeMap::new();
    let mut bindings: BTreeMap<SsaName, LiteralValue> = BTreeMap::new();
    let mut iterations = 0_u32;
    loop {
        iterations = iterations.saturating_add(1);
        if iterations > options.max_iterations {
            return Err(DiagnosticBundle::new(vec![optimizer_error(
                "FICT-OPT-NONCONVERGENCE",
                "constant propagation exceeded its configured fixed-point budget",
            )]));
        }
        let previous_values = values.clone();
        let previous_bindings = bindings.clone();
        for block in &function.blocks {
            if !ssa.cfg.reachable[block.id.as_usize()] {
                continue;
            }
            for (instruction_index, instruction) in block.instructions.iter().enumerate() {
                if let Some(result) = instruction.result
                    && let Some(literal) = evaluate_instruction(
                        instruction,
                        result,
                        &previous_values,
                        &previous_bindings,
                        &read_sources,
                    )
                {
                    values.insert(result, literal);
                }
                let (local, assigned) = match &instruction.kind {
                    HirInstructionKind::Declare {
                        local, initializer, ..
                    } => (*local, *initializer),
                    HirInstructionKind::Write { place, value } if place.is_local() => {
                        let local = match place.base {
                            fict_hir::PlaceBase::Local(local) => local,
                            fict_hir::PlaceBase::Ssa(name) => name.local,
                            fict_hir::PlaceBase::Value(_) => continue,
                        };
                        (local, Some(*value))
                    }
                    _ => continue,
                };
                let Some(target) =
                    definitions_by_location.get(&(block.id, count_u32(instruction_index), local))
                else {
                    continue;
                };
                if let Some(literal) = assigned.and_then(|value| previous_values.get(&value)) {
                    bindings.insert(*target, literal.clone());
                }
            }
        }
        for phi in &ssa.phis {
            let incoming: Option<Vec<_>> = phi
                .sources
                .iter()
                .map(|(_, source)| previous_bindings.get(source).cloned())
                .collect();
            if let Some(incoming) = incoming
                && let Some(first) = incoming.first()
                && incoming.iter().all(|literal| literal == first)
            {
                bindings.insert(phi.target, first.clone());
            }
        }
        if values == previous_values && bindings == previous_bindings {
            break;
        }
    }
    let mut foldable_values: Vec<_> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .filter_map(|instruction| {
            let result = instruction.result?;
            if values.contains_key(&result)
                && !matches!(instruction.kind, HirInstructionKind::Literal(_))
                && instruction.semantics == fict_hir::InstructionSemantics::PURE_EAGER
            {
                Some(result)
            } else {
                None
            }
        })
        .collect();
    foldable_values.sort_unstable();
    foldable_values.dedup();
    let value_facts = values
        .into_iter()
        .map(|(value, literal)| ValueConstantFact { value, literal })
        .collect::<Vec<_>>();
    let binding_facts = bindings
        .into_iter()
        .map(|(name, literal)| SsaConstantFact { name, literal })
        .collect::<Vec<_>>();
    let analysis = ConstantPropagation {
        stats: ConstantPropagationStats {
            value_constants: count_u32(value_facts.len()),
            ssa_constants: count_u32(binding_facts.len()),
            foldable_instructions: count_u32(foldable_values.len()),
            iterations,
        },
        values: value_facts,
        bindings: binding_facts,
        foldable_values,
    };
    verify_constants(function, ssa, &analysis)?;
    Ok(analysis)
}

/// Replace proven pure result instructions with exact literals and re-verify HIR.
pub fn apply_constant_folding(
    file: &HirFile,
    function_id: FunctionId,
    analysis: &ConstantPropagation,
) -> Result<HirFile, DiagnosticBundle> {
    let constants: BTreeMap<_, _> = analysis
        .values
        .iter()
        .map(|fact| (fact.value, fact.literal.clone()))
        .collect();
    let foldable: BTreeSet<_> = analysis.foldable_values.iter().copied().collect();
    let mut result = file.clone();
    let Some(function) = result.functions.get_mut(function_id.as_usize()) else {
        return Err(DiagnosticBundle::new(vec![optimizer_error(
            "FICT-OPT-FUNCTION",
            "constant folding function is outside the HIR arena",
        )]));
    };
    for block in &mut function.blocks {
        for instruction in &mut block.instructions {
            let Some(value) = instruction.result else {
                continue;
            };
            if !foldable.contains(&value) {
                continue;
            }
            let Some(literal) = constants.get(&value).cloned() else {
                continue;
            };
            instruction.kind = HirInstructionKind::Literal(literal.clone());
            instruction.semantics = fict_hir::InstructionSemantics::PURE_EAGER;
            if let Some(hir_value) = function.values.get_mut(value.as_usize()) {
                hir_value.kind = ValueKind::Literal(literal);
            }
        }
    }
    verify_hir(&result)?;
    Ok(result)
}

/// Verify constant fact uniqueness, arena references, foldability, and statistics.
pub fn verify_constants(
    function: &HirFunction,
    ssa: &SsaAnalysis,
    analysis: &ConstantPropagation,
) -> Result<(), DiagnosticBundle> {
    let mut diagnostics = DiagnosticBundle::default();
    if analysis
        .values
        .windows(2)
        .any(|pair| pair[0].value >= pair[1].value)
        || analysis
            .values
            .iter()
            .any(|fact| function.values.get(fact.value.as_usize()).is_none())
    {
        diagnostics.push(optimizer_error(
            "FICT-OPT-CONSTANT-VALUE",
            "value constants must be sorted, unique, and reference the value arena",
        ));
    }
    let definitions: BTreeSet<_> = ssa
        .definitions
        .iter()
        .map(|definition| definition.name)
        .collect();
    if analysis
        .bindings
        .windows(2)
        .any(|pair| pair[0].name >= pair[1].name)
        || analysis
            .bindings
            .iter()
            .any(|fact| !definitions.contains(&fact.name))
    {
        diagnostics.push(optimizer_error(
            "FICT-OPT-CONSTANT-SSA",
            "SSA constants must be sorted, unique, and reference definitions",
        ));
    }
    let value_names: BTreeSet<_> = analysis.values.iter().map(|fact| fact.value).collect();
    if analysis
        .foldable_values
        .windows(2)
        .any(|pair| pair[0] >= pair[1])
        || analysis
            .foldable_values
            .iter()
            .any(|value| !value_names.contains(value))
    {
        diagnostics.push(optimizer_error(
            "FICT-OPT-FOLDABLE",
            "foldable values must be sorted, unique constant results",
        ));
    }
    if analysis.stats.value_constants != count_u32(analysis.values.len())
        || analysis.stats.ssa_constants != count_u32(analysis.bindings.len())
        || analysis.stats.foldable_instructions != count_u32(analysis.foldable_values.len())
        || analysis.stats.iterations == 0
    {
        diagnostics.push(optimizer_error(
            "FICT-OPT-CONSTANT-STATS",
            "constant propagation stats do not match result arenas",
        ));
    }
    if diagnostics.is_empty() {
        Ok(())
    } else {
        Err(diagnostics)
    }
}

fn evaluate_instruction(
    instruction: &fict_hir::HirInstruction,
    result: ValueId,
    values: &BTreeMap<ValueId, LiteralValue>,
    bindings: &BTreeMap<SsaName, LiteralValue>,
    read_sources: &BTreeMap<ValueId, SsaName>,
) -> Option<LiteralValue> {
    if instruction.semantics != fict_hir::InstructionSemantics::PURE_EAGER {
        return None;
    }
    match &instruction.kind {
        HirInstructionKind::Literal(LiteralValue::RegExp { .. }) => None,
        HirInstructionKind::Literal(literal) => Some(literal.clone()),
        HirInstructionKind::Read { place } if place.is_local() => read_sources
            .get(&result)
            .and_then(|source| bindings.get(source))
            .cloned(),
        HirInstructionKind::Unary { operator, argument } => {
            fold_unary(*operator, values.get(argument)?)
        }
        HirInstructionKind::Binary {
            operator,
            left,
            right,
        } => fold_binary(*operator, values.get(left)?, values.get(right)?),
        _ => None,
    }
}

fn fold_unary(operator: UnaryOperator, value: &LiteralValue) -> Option<LiteralValue> {
    match operator {
        UnaryOperator::Not => Some(LiteralValue::Boolean(!truthy(value)?)),
        UnaryOperator::Void => Some(LiteralValue::Undefined),
        UnaryOperator::Plus => number(value).map(number_literal),
        UnaryOperator::Minus => number(value).map(|value| number_literal(-value)),
        UnaryOperator::BitNot => number(value)
            .map(to_int32)
            .map(|value| number_literal(f64::from(!value))),
        UnaryOperator::TypeOf => Some(LiteralValue::String(
            match value {
                LiteralValue::Undefined => "undefined",
                LiteralValue::Boolean(_) => "boolean",
                LiteralValue::Number(_) => "number",
                LiteralValue::BigInt(_) => "bigint",
                LiteralValue::String(_) => "string",
                LiteralValue::Null | LiteralValue::RegExp { .. } => "object",
            }
            .into(),
        )),
        UnaryOperator::Delete => None,
    }
}

fn fold_binary(
    operator: BinaryOperator,
    left: &LiteralValue,
    right: &LiteralValue,
) -> Option<LiteralValue> {
    if operator == BinaryOperator::Add
        && let (LiteralValue::String(left), LiteralValue::String(right)) = (left, right)
    {
        return Some(LiteralValue::String(format!("{left}{right}")));
    }
    if matches!(
        operator,
        BinaryOperator::StrictEqual | BinaryOperator::StrictNotEqual
    ) {
        let equal = strict_equal(left, right)?;
        return Some(LiteralValue::Boolean(
            if operator == BinaryOperator::StrictEqual {
                equal
            } else {
                !equal
            },
        ));
    }
    let left = number(left)?;
    let right = number(right)?;
    let literal = match operator {
        BinaryOperator::Add => number_literal(left + right),
        BinaryOperator::Subtract => number_literal(left - right),
        BinaryOperator::Multiply => number_literal(left * right),
        BinaryOperator::Divide => number_literal(left / right),
        BinaryOperator::Remainder => number_literal(left % right),
        BinaryOperator::Exponent => number_literal(left.powf(right)),
        BinaryOperator::LessThan => LiteralValue::Boolean(left < right),
        BinaryOperator::LessThanOrEqual => LiteralValue::Boolean(left <= right),
        BinaryOperator::GreaterThan => LiteralValue::Boolean(left > right),
        BinaryOperator::GreaterThanOrEqual => LiteralValue::Boolean(left >= right),
        BinaryOperator::ShiftLeft => number_literal(f64::from(
            to_int32(left).wrapping_shl(to_uint32(right) & 31),
        )),
        BinaryOperator::ShiftRight => number_literal(f64::from(
            to_int32(left).wrapping_shr(to_uint32(right) & 31),
        )),
        BinaryOperator::ShiftRightUnsigned => number_literal(f64::from(
            to_uint32(left).wrapping_shr(to_uint32(right) & 31),
        )),
        BinaryOperator::BitOr => number_literal(f64::from(to_int32(left) | to_int32(right))),
        BinaryOperator::BitXor => number_literal(f64::from(to_int32(left) ^ to_int32(right))),
        BinaryOperator::BitAnd => number_literal(f64::from(to_int32(left) & to_int32(right))),
        BinaryOperator::Equal
        | BinaryOperator::NotEqual
        | BinaryOperator::StrictEqual
        | BinaryOperator::StrictNotEqual
        | BinaryOperator::In
        | BinaryOperator::InstanceOf
        | BinaryOperator::LogicalAnd
        | BinaryOperator::LogicalOr
        | BinaryOperator::NullishCoalescing => return None,
    };
    Some(literal)
}

fn strict_equal(left: &LiteralValue, right: &LiteralValue) -> Option<bool> {
    match (left, right) {
        (LiteralValue::Null, LiteralValue::Null)
        | (LiteralValue::Undefined, LiteralValue::Undefined) => Some(true),
        (LiteralValue::Boolean(left), LiteralValue::Boolean(right)) => Some(left == right),
        (LiteralValue::String(left), LiteralValue::String(right)) => Some(left == right),
        (LiteralValue::Number(left), LiteralValue::Number(right)) => {
            let left = left.to_f64();
            let right = right.to_f64();
            Some(!left.is_nan() && !right.is_nan() && left == right)
        }
        (LiteralValue::BigInt(left), LiteralValue::BigInt(right)) => Some(left == right),
        (LiteralValue::RegExp { .. }, LiteralValue::RegExp { .. }) => None,
        (LiteralValue::Null, _)
        | (LiteralValue::Undefined, _)
        | (LiteralValue::Boolean(_), _)
        | (LiteralValue::Number(_), _)
        | (LiteralValue::BigInt(_), _)
        | (LiteralValue::String(_), _)
        | (LiteralValue::RegExp { .. }, _) => Some(false),
    }
}

fn truthy(value: &LiteralValue) -> Option<bool> {
    match value {
        LiteralValue::Null | LiteralValue::Undefined => Some(false),
        LiteralValue::Boolean(value) => Some(*value),
        LiteralValue::Number(value) => {
            let value = value.to_f64();
            Some(value != 0.0 && !value.is_nan())
        }
        LiteralValue::String(value) => Some(!value.is_empty()),
        LiteralValue::BigInt(value) => Some(!value.trim_start_matches(['-', '+', '0']).is_empty()),
        LiteralValue::RegExp { .. } => Some(true),
    }
}

fn number(value: &LiteralValue) -> Option<f64> {
    match value {
        LiteralValue::Number(value) => Some(value.to_f64()),
        _ => None,
    }
}

fn number_literal(value: f64) -> LiteralValue {
    LiteralValue::Number(NumberLiteral::from_f64(value))
}

fn to_uint32(value: f64) -> u32 {
    if !value.is_finite() || value == 0.0 {
        return 0;
    }
    value.trunc().rem_euclid(4_294_967_296.0) as u32
}

fn to_int32(value: f64) -> i32 {
    to_uint32(value) as i32
}

fn resolve_value(mut value: ValueId, replacements: &BTreeMap<ValueId, ValueId>) -> ValueId {
    let mut remaining = replacements.len().saturating_add(1);
    while remaining > 0 {
        let Some(next) = replacements.get(&value).copied() else {
            break;
        };
        if next == value {
            break;
        }
        value = next;
        remaining -= 1;
    }
    value
}

fn rewrite_value(value: &mut ValueId, replacements: &BTreeMap<ValueId, ValueId>) {
    *value = resolve_value(*value, replacements);
}

fn rewrite_place(place: &mut Place, replacements: &BTreeMap<ValueId, ValueId>) {
    if let PlaceBase::Value(value) = &mut place.base {
        rewrite_value(value, replacements);
    }
    for projection in &mut place.projections {
        if let Projection::ComputedProperty { key, .. } = projection {
            rewrite_value(key, replacements);
        }
    }
}

fn rewrite_instruction_values(
    instruction: &mut fict_hir::HirInstruction,
    replacements: &BTreeMap<ValueId, ValueId>,
) {
    match &mut instruction.kind {
        HirInstructionKind::Declare { initializer, .. } => {
            if let Some(value) = initializer {
                rewrite_value(value, replacements);
            }
        }
        HirInstructionKind::Read { place } => rewrite_place(place, replacements),
        HirInstructionKind::Write { place, value } => {
            rewrite_place(place, replacements);
            rewrite_value(value, replacements);
        }
        HirInstructionKind::ReadWrite { place, value, .. } => {
            rewrite_place(place, replacements);
            if let Some(value) = value {
                rewrite_value(value, replacements);
            }
        }
        HirInstructionKind::Unary { argument, .. } => rewrite_value(argument, replacements),
        HirInstructionKind::Binary { left, right, .. } => {
            rewrite_value(left, replacements);
            rewrite_value(right, replacements);
        }
        HirInstructionKind::Call(call) => {
            rewrite_value(&mut call.callee, replacements);
            for argument in &mut call.arguments {
                rewrite_value(&mut argument.value, replacements);
            }
        }
        HirInstructionKind::New { callee, arguments } => {
            rewrite_value(callee, replacements);
            for argument in arguments {
                rewrite_value(&mut argument.value, replacements);
            }
        }
        HirInstructionKind::Array { elements } => {
            for element in elements {
                match element {
                    ArrayElement::Hole(_) => {}
                    ArrayElement::Value(value) | ArrayElement::Spread { value, .. } => {
                        rewrite_value(value, replacements);
                    }
                }
            }
        }
        HirInstructionKind::Object { entries } => {
            for entry in entries {
                match entry {
                    ObjectEntry::Property { key, value, .. } => {
                        if let PropertyKey::Computed(key) = key {
                            rewrite_value(key, replacements);
                        }
                        rewrite_value(value, replacements);
                    }
                    ObjectEntry::Spread { value, .. } => rewrite_value(value, replacements),
                }
            }
        }
        HirInstructionKind::Await { value } => rewrite_value(value, replacements),
        HirInstructionKind::Yield { value, .. } => {
            if let Some(value) = value {
                rewrite_value(value, replacements);
            }
        }
        HirInstructionKind::SyntaxFragment { inputs, .. } => {
            for value in inputs {
                rewrite_value(value, replacements);
            }
        }
        HirInstructionKind::Literal(_)
        | HirInstructionKind::Function { .. }
        | HirInstructionKind::Jsx { .. }
        | HirInstructionKind::Phi { .. }
        | HirInstructionKind::Debugger => {}
    }
}

fn rewrite_terminator_values(
    terminator: &mut TerminatorKind,
    replacements: &BTreeMap<ValueId, ValueId>,
) {
    match terminator {
        TerminatorKind::Return { value } => {
            if let Some(value) = value {
                rewrite_value(value, replacements);
            }
        }
        TerminatorKind::Throw { value } => rewrite_value(value, replacements),
        TerminatorKind::Branch { test, .. } => rewrite_value(test, replacements),
        TerminatorKind::Switch {
            discriminant,
            cases,
        } => {
            rewrite_value(discriminant, replacements);
            for case in cases {
                if let Some(test) = &mut case.test {
                    rewrite_value(test, replacements);
                }
            }
        }
        TerminatorKind::Goto { .. } | TerminatorKind::Try { .. } | TerminatorKind::Unreachable => {}
    }
}

fn optimizer_error(code: &'static str, message: impl Into<String>) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("optimizer diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(GuaranteeClass::Internal)
}

fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
