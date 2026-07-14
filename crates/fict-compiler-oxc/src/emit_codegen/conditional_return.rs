use super::{block_iife, const_statement, zero_parameter_expression_arrow};
use oxc::{
    allocator::{Allocator, CloneIn, Vec as ArenaVec},
    ast::{
        AstBuilder, NONE,
        ast::{Argument, Expression, IdentifierName, Statement},
    },
    span::Span,
};
use std::collections::{BTreeMap, BTreeSet};
#[derive(Debug, Clone)]
pub(super) struct ConditionalReturnRewrite {
    target: String,
    helper: String,
    create_helper: String,
    cleanup_helper: String,
}
impl ConditionalReturnRewrite {
    pub(super) fn new(target: &str, helper: &str, create: &str, cleanup: &str) -> Self {
        Self {
            target: target.to_owned(),
            helper: helper.to_owned(),
            create_helper: create.to_owned(),
            cleanup_helper: cleanup.to_owned(),
        }
    }
}
pub(super) fn lower_statements<'a>(
    allocator: &'a Allocator,
    statements: &mut ArenaVec<'a, Statement<'a>>,
    rewrites: &BTreeMap<(u32, u32), ConditionalReturnRewrite>,
    matched: &mut BTreeSet<(u32, u32)>,
    await_allowed: bool,
) {
    let mut index = 0;
    while index < statements.len() {
        if let Statement::ReturnStatement(returned) = &statements[index]
            && let Some(Expression::ConditionalExpression(conditional)) = &returned.argument
        {
            let location = (conditional.span.start, conditional.span.end);
            if let Some(rewrite) = rewrites.get(&location) {
                let replacement = binding_expression(
                    allocator,
                    rewrite,
                    conditional.test.clone_in(allocator),
                    conditional.consequent.clone_in(allocator),
                    conditional.alternate.clone_in(allocator),
                    returned.span,
                    await_allowed,
                );
                statements[index] = Statement::new_return_statement(
                    returned.span,
                    Some(replacement),
                    &AstBuilder::new(allocator),
                );
                matched.insert(location);
                index += 1;
                continue;
            }
        }
        let Statement::IfStatement(statement) = &statements[index] else {
            index += 1;
            continue;
        };
        let location = (statement.span.start, statement.span.end);
        let Some(rewrite) = rewrites.get(&location) else {
            index += 1;
            continue;
        };
        let Some(consequent) = return_argument(allocator, &statement.consequent) else {
            index += 1;
            continue;
        };
        let (alternate, remove_next) = if let Some(alternate) = &statement.alternate {
            (return_argument(allocator, alternate), false)
        } else {
            (
                statements
                    .get(index + 1)
                    .and_then(|next| return_argument(allocator, next)),
                true,
            )
        };
        let Some(alternate) = alternate else {
            index += 1;
            continue;
        };
        let test = statement.test.clone_in(allocator);
        let replacement = binding_expression(
            allocator,
            rewrite,
            test,
            consequent,
            alternate,
            statement.span,
            await_allowed,
        );
        statements[index] = Statement::new_return_statement(
            statement.span,
            Some(replacement),
            &AstBuilder::new(allocator),
        );
        if remove_next {
            statements.remove(index + 1);
        }
        matched.insert(location);
        index += 1;
    }
}
fn return_argument<'a>(
    allocator: &'a Allocator,
    statement: &Statement<'a>,
) -> Option<Expression<'a>> {
    let returned = match statement {
        Statement::ReturnStatement(returned) => returned,
        Statement::BlockStatement(block) if block.body.len() == 1 => {
            let Statement::ReturnStatement(returned) = &block.body[0] else {
                return None;
            };
            returned
        }
        _ => return None,
    };
    returned
        .argument
        .as_ref()
        .map(|value| value.clone_in(allocator))
}
fn binding_expression<'a>(
    allocator: &'a Allocator,
    rewrite: &ConditionalReturnRewrite,
    test: Expression<'a>,
    consequent: Expression<'a>,
    alternate: Expression<'a>,
    span: Span,
    await_allowed: bool,
) -> Expression<'a> {
    let builder = AstBuilder::new(allocator);
    let callee = Expression::new_identifier(span, allocator.alloc_str(&rewrite.helper), &builder);
    let create =
        Expression::new_identifier(span, allocator.alloc_str(&rewrite.create_helper), &builder);
    let mut arguments = ArenaVec::new_in(&allocator);
    arguments.extend(
        [test, consequent, alternate]
            .into_iter()
            .map(|value| Argument::from(zero_parameter_expression_arrow(allocator, value, span))),
    );
    arguments.insert(2, Argument::from(create));
    let binding = Expression::new_call_expression(span, callee, NONE, arguments, false, &builder);
    let mut body = ArenaVec::new_in(&allocator);
    body.push(const_statement(allocator, &rewrite.target, binding, span));
    let target = Expression::new_identifier(span, allocator.alloc_str(&rewrite.target), &builder);
    let dispose = Expression::new_static_member_expression(
        span,
        target,
        IdentifierName::new(span, "dispose", &builder),
        false,
        &builder,
    );
    let cleanup =
        Expression::new_identifier(span, allocator.alloc_str(&rewrite.cleanup_helper), &builder);
    let cleanup = Expression::new_call_expression(
        span,
        cleanup,
        NONE,
        ArenaVec::from_array_in([Argument::from(dispose)], &allocator),
        false,
        &builder,
    );
    body.push(Statement::new_expression_statement(span, cleanup, &builder));
    body.push(Statement::new_return_statement(
        span,
        Some(Expression::new_identifier(
            span,
            allocator.alloc_str(&rewrite.target),
            &builder,
        )),
        &builder,
    ));
    block_iife(allocator, body, span, await_allowed)
}
