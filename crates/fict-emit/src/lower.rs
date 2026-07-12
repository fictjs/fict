use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_hir::{
    FictMacroKind, FunctionId, FunctionKind, HirFile, HirInstructionKind, LocalId, PlaceBase,
    TerminatorKind, ValueId,
};
use fict_reactivity::{ReactiveCycleAnalysis, RegionAnalysis};

use crate::{
    CleanupOwner, EmitFunction, EmitOperation, EmitProgram, EmitSlotId, EmitTemporary,
    EmitTemporaryId, EmitValueRef, ReactiveSlot, ReactiveSlotKind, RuntimeFamily, RuntimeHelper,
    RuntimeImportIntent, verify_emit_program,
};

/// Phase-1 Core lowering configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoJsxLoweringOptions {
    /// Runtime package/import family.
    pub runtime_family: RuntimeFamily,
    /// Reject derived SCCs instead of emitting best-effort non-memo regions.
    pub strict_guarantee: bool,
    /// Allow Preview ABI helpers (none are emitted by this phase).
    pub preview: bool,
}

impl Default for NoJsxLoweringOptions {
    fn default() -> Self {
        Self {
            runtime_family: RuntimeFamily::Fict,
            strict_guarantee: true,
            preview: false,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct MacroSite {
    result: ValueId,
    local: Option<LocalId>,
    kind: FictMacroKind,
    slot: EmitSlotId,
}

/// Lower state/memo/effect and reactive reads/writes while preserving ordinary HIR.
pub fn lower_no_jsx(
    hir: &HirFile,
    regions: &[RegionAnalysis],
    cycles: &[ReactiveCycleAnalysis],
    options: NoJsxLoweringOptions,
) -> Result<EmitProgram, DiagnosticBundle> {
    if regions.len() != hir.functions.len() || cycles.len() != hir.functions.len() {
        return Err(DiagnosticBundle::new(vec![lower_error(
            "FICT-EMIT-ANALYSIS",
            "no-JSX lowering requires final region and cycle analysis for every function",
            GuaranteeClass::Internal,
        )]));
    }
    if options.strict_guarantee
        && let Some(cycle) = cycles.iter().flat_map(|analysis| &analysis.cycles).next()
    {
        return Err(DiagnosticBundle::new(vec![lower_error(
            "FICT-R-CYCLE",
            format!(
                "detected cyclic derived dependency across {} binding(s)",
                cycle.nodes.len()
            ),
            GuaranteeClass::Fallback,
        )]));
    }
    let mut functions = Vec::with_capacity(hir.functions.len());
    for (function_index, function) in hir.functions.iter().enumerate() {
        if let Some(instruction) = function
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .find(|instruction| matches!(instruction.kind, HirInstructionKind::Jsx { .. }))
        {
            let mut diagnostic = lower_error(
                "FICT-EMIT-JSX-STAGE",
                "JSX reached the no-JSX lowering phase",
                GuaranteeClass::Internal,
            );
            diagnostic.primary_span = instruction.origin.primary_span;
            return Err(DiagnosticBundle::new(vec![diagnostic]));
        }
        functions.push(lower_function(
            hir,
            FunctionId::new(count_u32(function_index)),
            &regions[function_index],
        )?);
    }
    let helpers: BTreeSet<_> = functions
        .iter()
        .flat_map(|function| function.operations.iter().filter_map(EmitOperation::helper))
        .collect();
    let imports = helpers
        .into_iter()
        .map(|helper| RuntimeImportIntent {
            helper,
            local: helper.spec().preferred_local.to_owned(),
        })
        .collect();
    let program = EmitProgram {
        runtime_family: options.runtime_family,
        preview: options.preview,
        strict_rejected: false,
        imports,
        functions,
    };
    verify_emit_program(hir, regions, &program)?;
    Ok(program)
}

fn lower_function(
    hir: &HirFile,
    function_id: FunctionId,
    regions: &RegionAnalysis,
) -> Result<EmitFunction, DiagnosticBundle> {
    let function = &hir.functions[function_id.as_usize()];
    let declarations_by_value: BTreeMap<_, _> = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .filter_map(|instruction| match &instruction.kind {
            HirInstructionKind::Declare {
                local,
                initializer: Some(value),
                ..
            } => Some((*value, *local)),
            _ => None,
        })
        .collect();
    let mut sites = Vec::new();
    for block in &function.blocks {
        for instruction in &block.instructions {
            let HirInstructionKind::Call(call) = &instruction.kind else {
                continue;
            };
            let Some(kind) = call.macro_kind else {
                continue;
            };
            let Some(result) = instruction.result else {
                return Err(DiagnosticBundle::new(vec![lower_error(
                    "FICT-EMIT-MACRO-RESULT",
                    "reactive macro call has no HIR result",
                    GuaranteeClass::Internal,
                )]));
            };
            sites.push(MacroSite {
                result,
                local: declarations_by_value.get(&result).copied(),
                kind,
                slot: EmitSlotId::new(count_u32(sites.len())),
            });
        }
    }
    let site_by_result: BTreeMap<_, _> = sites.iter().map(|site| (site.result, *site)).collect();
    let slot_by_local: BTreeMap<_, _> = sites
        .iter()
        .filter_map(|site| site.local.map(|local| (local, site.slot)))
        .collect();
    let slots = sites
        .iter()
        .map(|site| ReactiveSlot {
            id: site.slot,
            kind: match site.kind {
                FictMacroKind::State => ReactiveSlotKind::Signal,
                FictMacroKind::Memo => ReactiveSlotKind::Memo,
                FictMacroKind::Effect => ReactiveSlotKind::Effect,
            },
            binding: site
                .local
                .and_then(|local| function.locals.get(local.as_usize()))
                .and_then(|local| local.binding),
            control_path: Vec::new(),
            origin: macro_origin(function, site.result),
        })
        .collect();
    let mut temporaries = Vec::new();
    let mut value_temporaries = BTreeMap::new();
    let mut operations = Vec::new();
    for block in &function.blocks {
        for (instruction_index, instruction) in block.instructions.iter().enumerate() {
            if let HirInstructionKind::Call(call) = &instruction.kind
                && call.macro_kind.is_some()
            {
                let result = instruction.result.expect("macro result validated");
                let site = site_by_result[&result];
                match site.kind {
                    FictMacroKind::State | FictMacroKind::Memo => {
                        operations.push(EmitOperation::CreateReactive {
                            slot: site.slot,
                            source_result: result,
                            local: site.local,
                            initializer: call
                                .arguments
                                .first()
                                .map(|argument| lower_value(argument.value, &value_temporaries)),
                            helper: creation_helper(function.kind, site.kind),
                            origin: instruction.origin,
                        });
                    }
                    FictMacroKind::Effect => {
                        let Some(callback) = call.arguments.first() else {
                            return Err(DiagnosticBundle::new(vec![lower_error(
                                "FICT-EMIT-EFFECT-CALLBACK",
                                "effect macro has no callback input",
                                GuaranteeClass::Internal,
                            )]));
                        };
                        operations.push(EmitOperation::RegisterEffect {
                            slot: site.slot,
                            source_result: Some(result),
                            callback: lower_value(callback.value, &value_temporaries),
                            helper: effect_helper(function.kind),
                            cleanup: CleanupOwner::Slot(site.slot),
                            origin: instruction.origin,
                        });
                    }
                }
                continue;
            }
            if let HirInstructionKind::Declare {
                initializer: Some(initializer),
                ..
            } = instruction.kind
                && site_by_result.contains_key(&initializer)
            {
                continue;
            }
            match &instruction.kind {
                HirInstructionKind::Read { place } => {
                    let Some(slot) = place_local(place.base)
                        .and_then(|local| slot_by_local.get(&local).copied())
                    else {
                        preserve(&mut operations, block.id, instruction_index, instruction);
                        continue;
                    };
                    let Some(result) = instruction.result else {
                        return Err(DiagnosticBundle::new(vec![lower_error(
                            "FICT-EMIT-READ-RESULT",
                            "reactive read has no HIR result",
                            GuaranteeClass::Internal,
                        )]));
                    };
                    let target = allocate_temporary(
                        &mut temporaries,
                        format!("__fict_v{}", result.index()),
                        instruction.origin,
                    );
                    value_temporaries.insert(result, target);
                    operations.push(EmitOperation::ReadReactive {
                        slot,
                        source_result: result,
                        projections: place.projections.clone(),
                        target,
                        helper: None,
                        origin: instruction.origin,
                    });
                }
                HirInstructionKind::Write { place, value } => {
                    let Some(slot) = place_local(place.base)
                        .and_then(|local| slot_by_local.get(&local).copied())
                    else {
                        preserve(&mut operations, block.id, instruction_index, instruction);
                        continue;
                    };
                    operations.push(EmitOperation::WriteReactive {
                        slot,
                        projections: place.projections.clone(),
                        value: lower_value(*value, &value_temporaries),
                        origin: instruction.origin,
                    });
                }
                HirInstructionKind::ReadWrite {
                    place,
                    compound,
                    value,
                    update,
                    prefix,
                } => {
                    let Some(slot) = place_local(place.base)
                        .and_then(|local| slot_by_local.get(&local).copied())
                    else {
                        preserve(&mut operations, block.id, instruction_index, instruction);
                        continue;
                    };
                    let target = instruction.result.map(|result| {
                        let target = allocate_temporary(
                            &mut temporaries,
                            format!("__fict_v{}", result.index()),
                            instruction.origin,
                        );
                        value_temporaries.insert(result, target);
                        target
                    });
                    operations.push(EmitOperation::UpdateReactive {
                        slot,
                        source_result: instruction.result,
                        projections: place.projections.clone(),
                        compound: *compound,
                        value: value.map(|value| lower_value(value, &value_temporaries)),
                        update: *update,
                        prefix: *prefix,
                        target,
                        origin: instruction.origin,
                    });
                }
                _ => preserve(&mut operations, block.id, instruction_index, instruction),
            }
        }
        match &block.terminator.kind {
            TerminatorKind::Return { value } => operations.push(EmitOperation::Return {
                value: value.map(|value| lower_value(value, &value_temporaries)),
                origin: block.terminator.origin,
            }),
            TerminatorKind::Throw { .. }
            | TerminatorKind::Goto { .. }
            | TerminatorKind::Branch { .. }
            | TerminatorKind::Switch { .. }
            | TerminatorKind::Try { .. }
            | TerminatorKind::Unreachable => {}
        }
    }
    Ok(EmitFunction {
        source: function_id,
        slots,
        temporaries,
        regions: regions.top_level_regions.clone(),
        operations,
    })
}

fn creation_helper(kind: FunctionKind, macro_kind: FictMacroKind) -> RuntimeHelper {
    let scoped = matches!(
        kind,
        FunctionKind::Component | FunctionKind::Hook | FunctionKind::ReactiveScope
    );
    match (macro_kind, scoped) {
        (FictMacroKind::State, false) => RuntimeHelper::Signal,
        (FictMacroKind::State, true) => RuntimeHelper::UseSignal,
        (FictMacroKind::Memo, false) => RuntimeHelper::Memo,
        (FictMacroKind::Memo, true) => RuntimeHelper::UseMemo,
        (FictMacroKind::Effect, _) => unreachable!("effect has a dedicated helper"),
    }
}

fn effect_helper(kind: FunctionKind) -> RuntimeHelper {
    if matches!(
        kind,
        FunctionKind::Component | FunctionKind::Hook | FunctionKind::ReactiveScope
    ) {
        RuntimeHelper::UseEffect
    } else {
        RuntimeHelper::Effect
    }
}

fn place_local(base: PlaceBase) -> Option<LocalId> {
    match base {
        PlaceBase::Local(local) => Some(local),
        PlaceBase::Ssa(name) => Some(name.local),
        PlaceBase::Value(_) => None,
    }
}

fn lower_value(value: ValueId, temporaries: &BTreeMap<ValueId, EmitTemporaryId>) -> EmitValueRef {
    temporaries
        .get(&value)
        .copied()
        .map_or(EmitValueRef::Hir(value), EmitValueRef::Temporary)
}

fn allocate_temporary(
    temporaries: &mut Vec<EmitTemporary>,
    name: String,
    origin: fict_hir::Origin,
) -> EmitTemporaryId {
    let id = EmitTemporaryId::new(count_u32(temporaries.len()));
    temporaries.push(EmitTemporary { id, name, origin });
    id
}

fn preserve(
    operations: &mut Vec<EmitOperation>,
    block: fict_hir::BlockId,
    instruction: usize,
    hir: &fict_hir::HirInstruction,
) {
    operations.push(EmitOperation::PreserveHir {
        block,
        instruction: count_u32(instruction),
        origin: hir.origin,
    });
}

fn macro_origin(function: &fict_hir::HirFunction, result: ValueId) -> fict_hir::Origin {
    function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find(|instruction| instruction.result == Some(result))
        .map_or(function.origin, |instruction| instruction.origin)
}

fn lower_error(
    code: &'static str,
    message: impl Into<String>,
    guarantee: GuaranteeClass,
) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("lowering diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(guarantee)
}

fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
