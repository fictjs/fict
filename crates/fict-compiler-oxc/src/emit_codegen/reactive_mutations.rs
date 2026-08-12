use std::collections::BTreeSet;

use fict_diagnostics::{GuaranteeClass, SourceSpan};
use oxc::{
    allocator::TakeIn,
    ast::{
        AstBuilder,
        ast::{AssignmentTarget, Expression, SimpleAssignmentTarget},
    },
    ast_visit::walk_mut,
    span::GetSpan,
};

use super::{
    AstRewriter, MutationRewrite, assignment_target_name, compound_binary_operator,
    compound_logical_operator, emit_error, getter_call, logical_compound_update, reactive_update,
    rewrite_pattern_assignment_target, rewrite_reactive_root, simple_assignment_target_name,
    value_preserving_setter,
};

impl<'a> AstRewriter<'a, '_> {
    pub(super) fn rewrite_mutation(
        &mut self,
        expression: &mut Expression<'a>,
        rewrite: MutationRewrite,
    ) -> bool {
        match rewrite {
            MutationRewrite::Write { projected } => {
                let Expression::AssignmentExpression(assignment) = expression else {
                    return false;
                };
                if assignment.operator != oxc::syntax::operator::AssignmentOperator::Assign {
                    return false;
                }
                if projected {
                    walk_mut::walk_assignment_expression(self, assignment);
                    return rewrite_assignment_target_root(&mut assignment.left, self.allocator);
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
            MutationRewrite::Compound {
                operator,
                projected,
            } => {
                let Expression::AssignmentExpression(assignment) = expression else {
                    return false;
                };
                if projected {
                    walk_mut::walk_assignment_expression(self, assignment);
                    return rewrite_assignment_target_root(&mut assignment.left, self.allocator);
                }
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
            MutationRewrite::Update {
                operator,
                prefix,
                projected,
            } => {
                let Expression::UpdateExpression(update) = expression else {
                    return false;
                };
                if update.prefix != prefix {
                    return false;
                }
                if projected {
                    walk_mut::walk_update_expression(self, update);
                    return rewrite_simple_assignment_target_root(
                        &mut update.argument,
                        self.allocator,
                    );
                }
                let Some(signal) = simple_assignment_target_name(&update.argument) else {
                    return false;
                };
                walk_mut::walk_update_expression(self, update);
                *expression =
                    reactive_update(self.allocator, &signal, operator, prefix, update.span);
                true
            }
            MutationRewrite::Delete => {
                let Expression::UnaryExpression(delete) = expression else {
                    return false;
                };
                if delete.operator != oxc::syntax::operator::UnaryOperator::Delete {
                    return false;
                }
                walk_mut::walk_unary_expression(self, delete);
                rewrite_reactive_root(&mut delete.argument, self.allocator)
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

fn rewrite_assignment_target_root<'a>(
    target: &mut AssignmentTarget<'a>,
    allocator: &'a oxc::allocator::Allocator,
) -> bool {
    match target {
        AssignmentTarget::StaticMemberExpression(member) => {
            rewrite_reactive_root(&mut member.object, allocator)
        }
        AssignmentTarget::ComputedMemberExpression(member) => {
            rewrite_reactive_root(&mut member.object, allocator)
        }
        AssignmentTarget::PrivateFieldExpression(member) => {
            rewrite_reactive_root(&mut member.object, allocator)
        }
        AssignmentTarget::TSAsExpression(expression) => {
            rewrite_reactive_root(&mut expression.expression, allocator)
        }
        AssignmentTarget::TSSatisfiesExpression(expression) => {
            rewrite_reactive_root(&mut expression.expression, allocator)
        }
        AssignmentTarget::TSNonNullExpression(expression) => {
            rewrite_reactive_root(&mut expression.expression, allocator)
        }
        AssignmentTarget::TSTypeAssertion(expression) => {
            rewrite_reactive_root(&mut expression.expression, allocator)
        }
        AssignmentTarget::AssignmentTargetIdentifier(_)
        | AssignmentTarget::ArrayAssignmentTarget(_)
        | AssignmentTarget::ObjectAssignmentTarget(_) => false,
    }
}

pub(super) fn rewrite_pattern_projected_target<'a>(
    target: &mut AssignmentTarget<'a>,
    expected: &BTreeSet<(u32, u32)>,
    matched: &mut BTreeSet<(u32, u32)>,
    allocator: &'a oxc::allocator::Allocator,
) {
    let location = (target.span().start, target.span().end);
    if expected.contains(&location) && rewrite_assignment_target_root(target, allocator) {
        matched.insert(location);
    }
}

fn rewrite_simple_assignment_target_root<'a>(
    target: &mut SimpleAssignmentTarget<'a>,
    allocator: &'a oxc::allocator::Allocator,
) -> bool {
    match target {
        SimpleAssignmentTarget::StaticMemberExpression(member) => {
            rewrite_reactive_root(&mut member.object, allocator)
        }
        SimpleAssignmentTarget::ComputedMemberExpression(member) => {
            rewrite_reactive_root(&mut member.object, allocator)
        }
        SimpleAssignmentTarget::PrivateFieldExpression(member) => {
            rewrite_reactive_root(&mut member.object, allocator)
        }
        SimpleAssignmentTarget::TSAsExpression(expression) => {
            rewrite_reactive_root(&mut expression.expression, allocator)
        }
        SimpleAssignmentTarget::TSSatisfiesExpression(expression) => {
            rewrite_reactive_root(&mut expression.expression, allocator)
        }
        SimpleAssignmentTarget::TSNonNullExpression(expression) => {
            rewrite_reactive_root(&mut expression.expression, allocator)
        }
        SimpleAssignmentTarget::TSTypeAssertion(expression) => {
            rewrite_reactive_root(&mut expression.expression, allocator)
        }
        SimpleAssignmentTarget::AssignmentTargetIdentifier(_) => false,
    }
}
