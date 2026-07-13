use std::collections::BTreeSet;

use fict_diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use fict_hir::{
    BlockId, FunctionKind, HirFile, HirFunction, HirInstruction, HirInstructionKind,
    TerminatorKind, ValueId,
};
use fict_reactivity::{DependencyPath, StructuredConstruct, StructuredConstructKind};

use crate::CorePassOutput;

pub(crate) fn reactive_control_flow_diagnostics(core: &CorePassOutput) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    for analysis in &core.functions {
        let function = &core.hir.functions[analysis.function.as_usize()];
        if function.kind != FunctionKind::Component
            || !core
                .hir
                .templates
                .iter()
                .any(|template| template.owner == function.id)
        {
            continue;
        }

        let tracked_locals: BTreeSet<_> = analysis
            .scopes
            .bindings
            .iter()
            .map(|binding| binding.name.local)
            .collect();
        let mut unsupported = BTreeSet::new();
        let mut primary_span: Option<SourceSpan> = None;
        for construct in &analysis.structurize.constructs {
            let StructuredConstructKind::Conditional { join, .. } = construct.kind else {
                continue;
            };
            let Some(block) = function.blocks.get(construct.header.as_usize()) else {
                continue;
            };
            let TerminatorKind::Branch { test, .. } = block.terminator.kind else {
                continue;
            };
            let Some(paths) = analysis
                .dependencies
                .value_dependencies
                .get(test.as_usize())
            else {
                continue;
            };
            let reactive_paths: Vec<_> = paths
                .iter()
                .filter(|path| {
                    path.local()
                        .is_some_and(|local| tracked_locals.contains(&local))
                })
                .cloned()
                .collect();
            if reactive_paths.is_empty() {
                continue;
            }

            let condition_invokes_user_code =
                value_has_unsafe_control_work(&core.hir, function, test, &mut BTreeSet::new());
            let branch_return = is_branch_return_construct(function, construct, join);
            let memoizable_story = !function.flags.no_memo
                && !construct_has_unsafe_control_work(&core.hir, function, construct);
            if !condition_invokes_user_code && (branch_return || memoizable_story) {
                continue;
            }

            unsupported.extend(reactive_paths);
            let span = function
                .values
                .get(test.as_usize())
                .and_then(|value| value.origin.primary_span)
                .or(block.terminator.origin.primary_span);
            if primary_span.is_none_or(|current| {
                span.is_some_and(|candidate| candidate.start() < current.start())
            }) {
                primary_span = span;
            }
        }
        if unsupported.is_empty() {
            continue;
        }

        let names = display_names(function, &unsupported);
        let displayed = if names.is_empty() {
            "reactive values".to_owned()
        } else {
            names.iter().take(5).cloned().collect::<Vec<_>>().join(", ")
        };
        let remainder = names
            .len()
            .checked_sub(5)
            .filter(|remaining| *remaining > 0)
            .map_or_else(String::new, |remaining| format!(" (+{remaining} more)"));
        let mut diagnostic = Diagnostic::new(
            DiagnosticCode::new("FICT-R006").expect("diagnostic literal"),
            DiagnosticSeverity::Warning,
            format!(
                "Reactive control-flow reads ({displayed}{remainder}) force region re-execution. Prefer expression-only branching in JSX (for example, ternary or logical expressions) when you want finer-grained updates."
            ),
        )
        .with_guarantee_class(GuaranteeClass::Fallback)
        .with_help(
            "keep calls out of control-flow predicates, use a supported branch-return shape, or move the branch into JSX",
        );
        if let Some(span) = primary_span {
            diagnostic = diagnostic.with_primary_span(span);
        }
        diagnostics.push(diagnostic);
    }
    diagnostics
}

fn display_names(function: &HirFunction, paths: &BTreeSet<DependencyPath>) -> Vec<String> {
    let mut names: Vec<_> = paths
        .iter()
        .filter_map(DependencyPath::local)
        .filter_map(|local| function.locals.get(local.as_usize()))
        .filter_map(|local| local.debug_name.clone())
        .collect();
    names.sort();
    names.dedup();
    names
}

fn is_branch_return_construct(
    function: &HirFunction,
    construct: &StructuredConstruct,
    join: Option<BlockId>,
) -> bool {
    let StructuredConstructKind::Conditional {
        consequent,
        alternate,
        ..
    } = construct.kind
    else {
        return false;
    };
    let consequent_returns = terminates_before_join(
        function,
        consequent,
        join,
        &mut BTreeSet::new(),
        function.blocks.len(),
    );
    let alternate_returns = terminates_before_join(
        function,
        alternate,
        join,
        &mut BTreeSet::new(),
        function.blocks.len(),
    );
    if join.is_none() {
        consequent_returns && alternate_returns
    } else {
        consequent_returns || alternate_returns
    }
}

fn terminates_before_join(
    function: &HirFunction,
    block: BlockId,
    join: Option<BlockId>,
    visiting: &mut BTreeSet<BlockId>,
    remaining: usize,
) -> bool {
    if remaining == 0 || Some(block) == join || !visiting.insert(block) {
        return false;
    }
    let Some(block_data) = function.blocks.get(block.as_usize()) else {
        return false;
    };
    let result = match &block_data.terminator.kind {
        TerminatorKind::Return { .. } | TerminatorKind::Throw { .. } => true,
        TerminatorKind::Goto { target } => terminates_before_join(
            function,
            *target,
            join,
            visiting,
            remaining.saturating_sub(1),
        ),
        TerminatorKind::Branch {
            consequent,
            alternate,
            ..
        } => {
            terminates_before_join(
                function,
                *consequent,
                join,
                visiting,
                remaining.saturating_sub(1),
            ) && terminates_before_join(
                function,
                *alternate,
                join,
                visiting,
                remaining.saturating_sub(1),
            )
        }
        TerminatorKind::Switch { cases, .. } => {
            !cases.is_empty()
                && cases.iter().all(|case| {
                    terminates_before_join(
                        function,
                        case.target,
                        join,
                        visiting,
                        remaining.saturating_sub(1),
                    )
                })
        }
        TerminatorKind::ForIn { .. }
        | TerminatorKind::ForOf { .. }
        | TerminatorKind::Try { .. }
        | TerminatorKind::Unreachable => false,
    };
    visiting.remove(&block);
    result
}

fn construct_has_unsafe_control_work(
    file: &HirFile,
    function: &HirFunction,
    construct: &StructuredConstruct,
) -> bool {
    let source_span = function.blocks[construct.header.as_usize()]
        .source_hint
        .as_ref()
        .and_then(|hint| hint.origin.primary_span);
    construct.blocks.iter().copied().any(|block| {
        function.blocks[block.as_usize()]
            .instructions
            .iter()
            .filter(|instruction| {
                source_span.is_none_or(|span| {
                    instruction
                        .origin
                        .primary_span
                        .is_some_and(|candidate| contains(span, candidate))
                })
            })
            .any(|instruction| instruction_is_unsafe(file, instruction))
    })
}

fn value_has_unsafe_control_work(
    file: &HirFile,
    function: &HirFunction,
    value: ValueId,
    visiting: &mut BTreeSet<ValueId>,
) -> bool {
    if !visiting.insert(value) {
        return false;
    }
    let Some(instruction) = function
        .blocks
        .iter()
        .flat_map(|block| &block.instructions)
        .find(|instruction| instruction.result == Some(value))
    else {
        return false;
    };
    if instruction_is_unsafe(file, instruction) {
        return true;
    }
    match &instruction.kind {
        HirInstructionKind::SyntaxFragment { inputs, .. } => inputs
            .iter()
            .any(|input| value_has_unsafe_control_work(file, function, *input, visiting)),
        HirInstructionKind::Unary { argument, .. } => {
            value_has_unsafe_control_work(file, function, *argument, visiting)
        }
        HirInstructionKind::Binary { left, right, .. } => {
            value_has_unsafe_control_work(file, function, *left, visiting)
                || value_has_unsafe_control_work(file, function, *right, visiting)
        }
        _ => false,
    }
}

fn instruction_is_unsafe(file: &HirFile, instruction: &HirInstruction) -> bool {
    match &instruction.kind {
        HirInstructionKind::Call(_)
        | HirInstructionKind::New { .. }
        | HirInstructionKind::Write { .. }
        | HirInstructionKind::ReadWrite { .. }
        | HirInstructionKind::Await { .. }
        | HirInstructionKind::Yield { .. }
        | HirInstructionKind::Debugger => true,
        HirInstructionKind::SyntaxFragment { fragment, .. } => file
            .syntax_fragments
            .get(fragment.as_usize())
            .is_some_and(|fragment| fragment.summary.has_side_effects),
        _ => false,
    }
}

fn contains(container: SourceSpan, candidate: SourceSpan) -> bool {
    container.start() <= candidate.start() && container.end() >= candidate.end()
}
