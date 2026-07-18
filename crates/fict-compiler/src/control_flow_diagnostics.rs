use std::collections::BTreeSet;

use fict_diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use fict_hir::{
    BlockId, DeleteTarget, FunctionKind, HirFile, HirFunction, HirInstruction, HirInstructionKind,
    MutationEffect, PlaceBase, Projection, TerminatorKind, ValueId,
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
            match &construct.kind {
                StructuredConstructKind::Conditional { join, .. } => {
                    let Some(block) = function.blocks.get(construct.header.as_usize()) else {
                        continue;
                    };
                    let TerminatorKind::Branch { test, .. } = block.terminator.kind else {
                        continue;
                    };
                    let reactive_paths = reactive_control_paths(
                        analysis
                            .dependencies
                            .value_dependencies
                            .get(test.as_usize())
                            .map(Vec::as_slice),
                        &tracked_locals,
                    );
                    if reactive_paths.is_empty() {
                        continue;
                    }

                    let condition_invokes_user_code = value_has_unsafe_control_work(
                        &core.hir,
                        function,
                        test,
                        &mut BTreeSet::new(),
                    );
                    // A throw inside a try is not a function exit: it may enter the associated
                    // catch/finally story. Keep branch-return suppression disabled until that
                    // enclosing exception construct has been proven as one unit.
                    let enclosing_try_story = enclosing_try_story_is_closed(
                        function,
                        construct,
                        &analysis.structurize.constructs,
                    );
                    let has_try_ancestor = enclosing_try_story.is_some();
                    let branch_return =
                        !has_try_ancestor && is_branch_return_construct(function, construct, *join);
                    let memoizable_story = !function.flags.no_memo
                        && match enclosing_try_story {
                            Some(closed) => closed,
                            None => {
                                !construct_has_unsafe_control_work(&core.hir, function, construct)
                            }
                        };
                    if !condition_invokes_user_code && (branch_return || memoizable_story) {
                        continue;
                    }

                    unsupported.extend(reactive_paths);
                    record_primary_span(
                        &mut primary_span,
                        function
                            .values
                            .get(test.as_usize())
                            .and_then(|value| value.origin.primary_span)
                            .or(block.terminator.origin.primary_span),
                    );
                }
                StructuredConstructKind::Loop { .. } => {
                    for (control, block_id) in loop_control_values(function, construct) {
                        let reactive_paths = reactive_control_paths(
                            analysis
                                .dependencies
                                .value_dependencies
                                .get(control.as_usize())
                                .map(Vec::as_slice),
                            &tracked_locals,
                        );
                        if reactive_paths.is_empty() {
                            continue;
                        }
                        unsupported.extend(reactive_paths);
                        let block = &function.blocks[block_id.as_usize()];
                        record_primary_span(
                            &mut primary_span,
                            function
                                .values
                                .get(control.as_usize())
                                .and_then(|value| value.origin.primary_span)
                                .or(block.terminator.origin.primary_span),
                        );
                    }
                }
                StructuredConstructKind::Switch { arms, join } => {
                    let mut reactive_paths = BTreeSet::new();
                    let mut condition_invokes_user_code = false;
                    let mut switch_primary_span = None;
                    for (control, block_id) in switch_control_values(function, construct) {
                        let paths = reactive_control_paths(
                            analysis
                                .dependencies
                                .value_dependencies
                                .get(control.as_usize())
                                .map(Vec::as_slice),
                            &tracked_locals,
                        );
                        if paths.is_empty() {
                            continue;
                        }
                        reactive_paths.extend(paths);
                        condition_invokes_user_code |= value_has_unsafe_control_work(
                            &core.hir,
                            function,
                            control,
                            &mut BTreeSet::new(),
                        );
                        let block = &function.blocks[block_id.as_usize()];
                        record_primary_span(
                            &mut switch_primary_span,
                            function
                                .values
                                .get(control.as_usize())
                                .and_then(|value| value.origin.primary_span)
                                .or(block.terminator.origin.primary_span),
                        );
                    }
                    if reactive_paths.is_empty() {
                        continue;
                    }

                    let switch_return = arms.iter().any(|arm| arm.is_default)
                        && arms.iter().all(|arm| {
                            terminates_before_join(
                                function,
                                arm.target,
                                *join,
                                &mut BTreeSet::new(),
                                function.blocks.len(),
                            )
                        });
                    let contains_nested_switch = construct.children.iter().any(|child| {
                        analysis
                            .structurize
                            .constructs
                            .get(*child as usize)
                            .is_some_and(|child| {
                                matches!(child.kind, StructuredConstructKind::Switch { .. })
                            })
                    });
                    let memoizable_story = !function.flags.no_memo
                        && !contains_nested_switch
                        && !construct_has_unsafe_control_work(&core.hir, function, construct);
                    if !condition_invokes_user_code && (switch_return || memoizable_story) {
                        continue;
                    }

                    unsupported.extend(reactive_paths);
                    record_primary_span(&mut primary_span, switch_primary_span);
                }
                StructuredConstructKind::Try { .. } => {}
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
                "Reactive control-flow reads ({displayed}{remainder}) force region re-execution. Prefer expression-only branching or iteration in JSX (for example, ternary, logical, or map expressions) when you want finer-grained updates."
            ),
        )
        .with_guarantee_class(GuaranteeClass::Fallback)
        .with_help(
            "keep calls out of control-flow predicates, keep loop controls static, use a supported branch-return shape, or move reactive branching/iteration into JSX",
        );
        if let Some(span) = primary_span {
            diagnostic = diagnostic.with_primary_span(span);
        }
        diagnostics.push(diagnostic);
    }
    diagnostics
}

fn reactive_control_paths(
    paths: Option<&[DependencyPath]>,
    tracked_locals: &BTreeSet<fict_hir::LocalId>,
) -> Vec<DependencyPath> {
    paths
        .into_iter()
        .flatten()
        .filter(|path| {
            path.local()
                .is_some_and(|local| tracked_locals.contains(&local))
        })
        .cloned()
        .collect()
}

fn loop_control_values(
    function: &HirFunction,
    construct: &StructuredConstruct,
) -> Vec<(ValueId, BlockId)> {
    let mut controls = Vec::new();
    // A component loop executes only during its owning render. Every CFG decision nested in that
    // loop can therefore make the loop result stale, including `continue`/`break` predicates; the
    // backedge/header predicate alone is not a sufficient fail-closed boundary.
    for block_id in &construct.blocks {
        let block = &function.blocks[block_id.as_usize()];
        let value = match &block.terminator.kind {
            TerminatorKind::Branch { test, .. } => Some(*test),
            TerminatorKind::ForIn { object, .. } => Some(*object),
            TerminatorKind::ForOf { iterable, .. } => Some(*iterable),
            TerminatorKind::Switch { discriminant, .. } => Some(*discriminant),
            TerminatorKind::Return { .. }
            | TerminatorKind::Throw { .. }
            | TerminatorKind::Goto { .. }
            | TerminatorKind::Try { .. }
            | TerminatorKind::Unreachable => None,
        };
        if let Some(value) = value {
            controls.push((value, *block_id));
        }
    }
    controls.sort_unstable();
    controls.dedup();
    controls
}

fn switch_control_values(
    function: &HirFunction,
    construct: &StructuredConstruct,
) -> Vec<(ValueId, BlockId)> {
    let mut controls = Vec::new();
    let header = &function.blocks[construct.header.as_usize()];
    if let Some(hint) = &header.source_hint
        && !hint.switch_cases.is_empty()
    {
        for test_block in hint.switch_cases.iter().filter_map(|case| case.test) {
            let block = &function.blocks[test_block.as_usize()];
            if let TerminatorKind::Branch { test, .. } = block.terminator.kind {
                controls.push((test, test_block));
            }
        }
    } else if let TerminatorKind::Switch {
        discriminant,
        cases,
    } = &header.terminator.kind
    {
        controls.push((*discriminant, construct.header));
        controls.extend(
            cases
                .iter()
                .filter_map(|case| case.test.map(|test| (test, construct.header))),
        );
    }
    controls.sort_unstable();
    controls.dedup();
    controls
}

fn record_primary_span(primary: &mut Option<SourceSpan>, candidate: Option<SourceSpan>) {
    if primary.is_none_or(|current| {
        candidate.is_some_and(|candidate| candidate.start() < current.start())
    }) {
        *primary = candidate;
    }
}

fn enclosing_try_story_is_closed(
    function: &HirFunction,
    construct: &StructuredConstruct,
    constructs: &[StructuredConstruct],
) -> Option<bool> {
    let mut parent = construct.parent;
    let mut remaining = constructs.len();
    while let Some(parent_id) = parent {
        if remaining == 0 {
            return Some(false);
        }
        let Some(owner) = constructs.get(parent_id as usize) else {
            return Some(false);
        };
        if matches!(owner.kind, StructuredConstructKind::Try { .. }) {
            return Some(try_story_handles_abrupt_completion(function, owner));
        }
        parent = owner.parent;
        remaining = remaining.saturating_sub(1);
    }
    None
}

fn try_story_handles_abrupt_completion(
    function: &HirFunction,
    construct: &StructuredConstruct,
) -> bool {
    let StructuredConstructKind::Try { catch, finally, .. } = construct.kind else {
        return false;
    };
    let clause_span = |entry: Option<BlockId>| {
        entry
            .and_then(|entry| function.blocks.get(entry.as_usize()))
            .and_then(|block| block.source_hint.as_ref())
            .and_then(|hint| hint.origin.primary_span)
    };
    let catch_span = clause_span(catch);
    let finally_span = clause_span(finally);
    for block in construct
        .blocks
        .iter()
        .filter_map(|block| function.blocks.get(block.as_usize()))
    {
        let abrupt_span = block.terminator.origin.primary_span;
        match block.terminator.kind {
            TerminatorKind::Return { .. } => return false,
            TerminatorKind::Throw { .. } => {
                let escapes_from_clause = abrupt_span.is_some_and(|span| {
                    catch_span.is_some_and(|clause| contains(clause, span))
                        || finally_span.is_some_and(|clause| contains(clause, span))
                });
                if catch.is_none() || escapes_from_clause {
                    return false;
                }
            }
            TerminatorKind::Goto { .. }
            | TerminatorKind::Branch { .. }
            | TerminatorKind::ForIn { .. }
            | TerminatorKind::ForOf { .. }
            | TerminatorKind::Switch { .. }
            | TerminatorKind::Try { .. }
            | TerminatorKind::Unreachable => {}
        }
    }
    true
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
        HirInstructionKind::Conditional {
            test,
            consequent,
            alternate,
        } => {
            value_has_unsafe_control_work(file, function, *test, visiting)
                || value_has_unsafe_control_work(file, function, *consequent, visiting)
                || value_has_unsafe_control_work(file, function, *alternate, visiting)
        }
        HirInstructionKind::Sequence { values } => values
            .iter()
            .any(|value| value_has_unsafe_control_work(file, function, *value, visiting)),
        HirInstructionKind::TemplateLiteral { expressions, .. } => expressions
            .iter()
            .any(|value| value_has_unsafe_control_work(file, function, *value, visiting)),
        HirInstructionKind::TaggedTemplate {
            tag, substitutions, ..
        } => {
            value_has_unsafe_control_work(file, function, *tag, visiting)
                || substitutions
                    .iter()
                    .any(|value| value_has_unsafe_control_work(file, function, *value, visiting))
        }
        HirInstructionKind::DynamicImport {
            specifier, options, ..
        } => {
            value_has_unsafe_control_work(file, function, *specifier, visiting)
                || options.is_some_and(|value| {
                    value_has_unsafe_control_work(file, function, value, visiting)
                })
        }
        HirInstructionKind::Delete { target } => match target {
            DeleteTarget::Value(value) => {
                value_has_unsafe_control_work(file, function, *value, visiting)
            }
            DeleteTarget::Place(place) => {
                let base = match place.base {
                    PlaceBase::Value(value) => Some(value),
                    PlaceBase::Local(_) | PlaceBase::Ssa(_) | PlaceBase::Global(_) => None,
                };
                base.into_iter()
                    .chain(
                        place
                            .projections
                            .iter()
                            .filter_map(|projection| match projection {
                                Projection::ComputedProperty { key, .. } => Some(*key),
                                Projection::StaticProperty { .. } | Projection::Index { .. } => {
                                    None
                                }
                            }),
                    )
                    .any(|value| value_has_unsafe_control_work(file, function, value, visiting))
            }
            DeleteTarget::UnresolvedIdentifier(_) => false,
        },
        _ => false,
    }
}

fn instruction_is_unsafe(file: &HirFile, instruction: &HirInstruction) -> bool {
    match &instruction.kind {
        HirInstructionKind::Call(_)
        | HirInstructionKind::New { .. }
        | HirInstructionKind::TemplateLiteral { .. }
        | HirInstructionKind::TaggedTemplate { .. }
        | HirInstructionKind::DynamicImport { .. }
        | HirInstructionKind::Await { .. }
        | HirInstructionKind::Yield { .. }
        | HirInstructionKind::Debugger => true,
        HirInstructionKind::Write { .. } | HirInstructionKind::ReadWrite { .. } => {
            instruction.semantics.mutation != MutationEffect::Local
        }
        HirInstructionKind::Delete { .. } => instruction.semantics.mutation != MutationEffect::None,
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
