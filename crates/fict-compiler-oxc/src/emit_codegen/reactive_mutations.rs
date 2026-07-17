use std::collections::BTreeSet;

use fict_diagnostics::{GuaranteeClass, SourceSpan};
use oxc::{
    allocator::TakeIn,
    ast::{
        AstBuilder,
        ast::{AssignmentTarget, Expression},
    },
    ast_visit::walk_mut,
    syntax::number::NumberBase,
};

use super::{
    AstRewriter, MutationRewrite, assignment_target_name, compound_binary_operator,
    compound_logical_operator, emit_error, getter_call, logical_compound_update, postfix_update,
    rewrite_pattern_assignment_target, simple_assignment_target_name, update_binary_operator,
    value_preserving_setter,
};

impl<'a> AstRewriter<'a, '_> {
    pub(super) fn rewrite_mutation(
        &mut self,
        expression: &mut Expression<'a>,
        rewrite: MutationRewrite,
    ) -> bool {
        match rewrite {
            MutationRewrite::Write => {
                let Expression::AssignmentExpression(assignment) = expression else {
                    return false;
                };
                if assignment.operator != oxc::syntax::operator::AssignmentOperator::Assign {
                    return false;
                }
                let Some(signal) = assignment_target_name(&assignment.left) else {
                    return false;
                };
                walk_mut::walk_assignment_expression(self, assignment);
                let right = assignment.right.take_in(&self.allocator);
                let span = assignment.span;
                *expression = value_preserving_setter(self.allocator, &signal, right, span);
                true
            }
            MutationRewrite::Compound(operator) => {
                let Expression::AssignmentExpression(assignment) = expression else {
                    return false;
                };
                let Some(signal) = assignment_target_name(&assignment.left) else {
                    return false;
                };
                walk_mut::walk_assignment_expression(self, assignment);
                let right = assignment.right.take_in(&self.allocator);
                *expression = if let Some(logical) = compound_logical_operator(operator) {
                    logical_compound_update(
                        self.allocator,
                        &signal,
                        logical,
                        right,
                        assignment.span,
                    )
                } else {
                    let binary = compound_binary_operator(operator)
                        .expect("non-logical compound operator must be binary");
                    let builder = AstBuilder::new(self.allocator);
                    let current = getter_call(self.allocator, &signal, assignment.span);
                    let next = Expression::new_binary_expression(
                        assignment.span,
                        current,
                        binary,
                        right,
                        &builder,
                    );
                    value_preserving_setter(self.allocator, &signal, next, assignment.span)
                };
                true
            }
            MutationRewrite::Update { operator, prefix } => {
                let Expression::UpdateExpression(update) = expression else {
                    return false;
                };
                if update.prefix != prefix {
                    return false;
                }
                let Some(signal) = simple_assignment_target_name(&update.argument) else {
                    return false;
                };
                walk_mut::walk_update_expression(self, update);
                *expression = if prefix {
                    let builder = AstBuilder::new(self.allocator);
                    let current = getter_call(self.allocator, &signal, update.span);
                    let one = Expression::new_numeric_literal(
                        update.span,
                        1.0,
                        None,
                        NumberBase::Decimal,
                        &builder,
                    );
                    let next = Expression::new_binary_expression(
                        update.span,
                        current,
                        update_binary_operator(operator),
                        one,
                        &builder,
                    );
                    value_preserving_setter(self.allocator, &signal, next, update.span)
                } else {
                    postfix_update(self.allocator, &signal, operator, update.span)
                };
                true
            }
            MutationRewrite::Pattern { targets } => {
                let Expression::AssignmentExpression(assignment) = expression else {
                    return false;
                };
                if assignment.operator != oxc::syntax::operator::AssignmentOperator::Assign
                    || !matches!(
                        assignment.left,
                        AssignmentTarget::ArrayAssignmentTarget(_)
                            | AssignmentTarget::ObjectAssignmentTarget(_)
                    )
                {
                    return false;
                }
                walk_mut::walk_assignment_expression(self, assignment);
                let mut matched = BTreeSet::new();
                rewrite_pattern_assignment_target(
                    &mut assignment.left,
                    &targets,
                    &mut matched,
                    self.allocator,
                );
                if matched != targets {
                    self.diagnostics.push(
                        emit_error(
                            "FICT-OXC-EMIT-PATTERN",
                            "reactive pattern target origins do not match the OXC assignment pattern",
                            GuaranteeClass::Internal,
                        )
                        .with_primary_span(
                            SourceSpan::new(assignment.span.start, assignment.span.end)
                                .expect("ordered OXC assignment span"),
                        ),
                    );
                }
                true
            }
        }
    }
}
