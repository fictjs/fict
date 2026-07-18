use super::{expression_arrow, zero_parameter_expression_arrow};
use oxc::{
    allocator::{Allocator, CloneIn, Vec as ArenaVec},
    ast::{
        AstBuilder, NONE,
        ast::{
            Argument, ArrowFunctionExpression, AssignmentTarget, AssignmentTargetMaybeDefault,
            AssignmentTargetProperty, AssignmentTargetRest, BindingPattern, Class, Expression,
            ForInStatement, ForOfStatement, ForStatement, ForStatementInit, ForStatementLeft,
            FormalParameter, FormalParameterKind, FormalParameters, Function, FunctionBody,
            IdentifierName, IfStatement, Statement, VariableDeclaration, VariableDeclarationKind,
            VariableDeclarator,
        },
    },
    ast_visit::{VisitMut, walk_mut},
    span::Span,
    syntax::{operator::AssignmentOperator, scope::ScopeFlags},
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
    _await_allowed: bool,
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
        if matches!(
            &statement.test,
            Expression::Identifier(identifier)
                if identifier.name.as_str() == rewrite.target.as_str()
        ) {
            index += 1;
            continue;
        }
        let remove_count = if statement.alternate.is_some() {
            0
        } else {
            let Some(count) = fallthrough_statement_count(&statements[index + 1..]) else {
                index += 1;
                continue;
            };
            count
        };
        let statement_span = statement.span;
        let test = statement.test.clone_in(allocator);
        let (dispatcher, hoisted_vars) = statement_dispatcher_expression(
            allocator,
            rewrite,
            statement,
            &statements[index + 1..index + 1 + remove_count],
        );
        let replacement =
            dispatcher_binding_expression(allocator, rewrite, test, dispatcher, statement_span);
        statements[index] = Statement::new_return_statement(
            statement_span,
            Some(replacement),
            &AstBuilder::new(allocator),
        );
        for _ in 0..remove_count {
            statements.remove(index + 1);
        }
        if let Some(declaration) = hoisted_var_statement(allocator, hoisted_vars, statement_span) {
            statements.insert(index, declaration);
            index += 1;
        }
        matched.insert(location);
        index += 1;
    }
}

fn fallthrough_statement_count(statements: &[Statement<'_>]) -> Option<usize> {
    statements
        .iter()
        .position(statement_returns_value)
        .map(|index| index.saturating_add(1))
}

fn statement_dispatcher_expression<'a>(
    allocator: &'a Allocator,
    rewrite: &ConditionalReturnRewrite,
    statement: &IfStatement<'a>,
    fallthrough: &[Statement<'a>],
) -> (Expression<'a>, Vec<(String, Span)>) {
    let builder = AstBuilder::new(allocator);
    let selector = allocator.alloc_str(&rewrite.target);
    let mut statements = ArenaVec::new_in(&allocator);
    statements.push(Statement::new_if_statement(
        statement.span,
        Expression::new_identifier(statement.span, selector, &builder),
        statement.consequent.clone_in(allocator),
        statement.alternate.clone_in(allocator),
        &builder,
    ));
    statements.extend(
        fallthrough
            .iter()
            .map(|statement| statement.clone_in(allocator)),
    );
    let mut hoister = DispatcherVarHoister::new(allocator);
    for statement in &mut statements {
        hoister.visit_statement(statement);
    }
    let pattern = BindingPattern::new_binding_identifier(statement.span, selector, &builder);
    let parameter = FormalParameter::new(
        statement.span,
        ArenaVec::new_in(&allocator),
        pattern,
        NONE,
        NONE,
        false,
        None,
        false,
        false,
        &builder,
    );
    let parameters = FormalParameters::boxed(
        statement.span,
        FormalParameterKind::ArrowFormalParameters,
        ArenaVec::from_array_in([parameter], &allocator),
        NONE,
        &builder,
    );
    let body = FunctionBody::boxed(
        statement.span,
        ArenaVec::new_in(&allocator),
        statements,
        &builder,
    );
    (
        Expression::new_arrow_function_expression(
            statement.span,
            false,
            false,
            NONE,
            parameters,
            NONE,
            body,
            &builder,
        ),
        hoister.bindings,
    )
}

struct DispatcherVarHoister<'a> {
    allocator: &'a Allocator,
    bindings: Vec<(String, Span)>,
    seen: BTreeSet<String>,
}

impl<'a> DispatcherVarHoister<'a> {
    fn new(allocator: &'a Allocator) -> Self {
        Self {
            allocator,
            bindings: Vec::new(),
            seen: BTreeSet::new(),
        }
    }

    fn record_pattern(&mut self, pattern: &BindingPattern<'a>) {
        for identifier in pattern.get_binding_identifiers() {
            let name = identifier.name.to_string();
            if self.seen.insert(name.clone()) {
                self.bindings.push((name, identifier.span));
            }
        }
    }

    fn declaration_expression(
        &mut self,
        declaration: &VariableDeclaration<'a>,
    ) -> Option<Expression<'a>> {
        let mut assignments = ArenaVec::new_in(&self.allocator);
        for declarator in &declaration.declarations {
            self.record_pattern(&declarator.id);
            let Some(initializer) = &declarator.init else {
                continue;
            };
            let target = binding_pattern_assignment_target(
                self.allocator,
                declarator.id.clone_in(self.allocator),
            );
            assignments.push(Expression::new_assignment_expression(
                declarator.span,
                AssignmentOperator::Assign,
                target,
                initializer.clone_in(self.allocator),
                &AstBuilder::new(self.allocator),
            ));
        }
        match assignments.len() {
            0 => None,
            1 => assignments.pop(),
            _ => Some(Expression::new_sequence_expression(
                declaration.span,
                assignments,
                &AstBuilder::new(self.allocator),
            )),
        }
    }

    fn rewrite_loop_left(&mut self, left: &mut ForStatementLeft<'a>) {
        let ForStatementLeft::VariableDeclaration(declaration) = left else {
            return;
        };
        if declaration.kind != VariableDeclarationKind::Var || declaration.declarations.len() != 1 {
            return;
        }
        let declarator = &declaration.declarations[0];
        self.record_pattern(&declarator.id);
        *left = ForStatementLeft::from(binding_pattern_assignment_target(
            self.allocator,
            declarator.id.clone_in(self.allocator),
        ));
    }
}

impl<'a> VisitMut<'a> for DispatcherVarHoister<'a> {
    fn visit_statement(&mut self, statement: &mut Statement<'a>) {
        if let Statement::VariableDeclaration(declaration) = statement
            && declaration.kind == VariableDeclarationKind::Var
        {
            let span = declaration.span;
            *statement = self.declaration_expression(declaration).map_or_else(
                || Statement::new_empty_statement(span, &AstBuilder::new(self.allocator)),
                |expression| {
                    Statement::new_expression_statement(
                        span,
                        expression,
                        &AstBuilder::new(self.allocator),
                    )
                },
            );
            return;
        }
        walk_mut::walk_statement(self, statement);
    }

    fn visit_for_statement(&mut self, statement: &mut ForStatement<'a>) {
        if let Some(ForStatementInit::VariableDeclaration(declaration)) = &statement.init
            && declaration.kind == VariableDeclarationKind::Var
        {
            statement.init = self
                .declaration_expression(declaration)
                .map(ForStatementInit::from);
        }
        walk_mut::walk_for_statement(self, statement);
    }

    fn visit_for_in_statement(&mut self, statement: &mut ForInStatement<'a>) {
        self.rewrite_loop_left(&mut statement.left);
        walk_mut::walk_for_in_statement(self, statement);
    }

    fn visit_for_of_statement(&mut self, statement: &mut ForOfStatement<'a>) {
        self.rewrite_loop_left(&mut statement.left);
        walk_mut::walk_for_of_statement(self, statement);
    }

    fn visit_function(&mut self, _function: &mut Function<'a>, _flags: ScopeFlags) {}

    fn visit_arrow_function_expression(&mut self, _function: &mut ArrowFunctionExpression<'a>) {}

    fn visit_class(&mut self, _class: &mut Class<'a>) {}
}

fn binding_pattern_assignment_target<'a>(
    allocator: &'a Allocator,
    pattern: BindingPattern<'a>,
) -> AssignmentTarget<'a> {
    let builder = AstBuilder::new(allocator);
    match pattern {
        BindingPattern::BindingIdentifier(identifier) => {
            AssignmentTarget::new_assignment_target_identifier(
                identifier.span,
                identifier.name,
                &builder,
            )
        }
        BindingPattern::AssignmentPattern(pattern) => {
            binding_pattern_assignment_target(allocator, pattern.unbox().left)
        }
        BindingPattern::ArrayPattern(pattern) => {
            let pattern = pattern.unbox();
            let elements = ArenaVec::from_iter_in(
                pattern.elements.into_iter().map(|element| {
                    element.map(|element| binding_pattern_assignment_value(allocator, element))
                }),
                &allocator,
            );
            let rest = pattern.rest.map(|rest| {
                let rest = rest.unbox();
                AssignmentTargetRest::boxed(
                    rest.span,
                    binding_pattern_assignment_target(allocator, rest.argument),
                    &builder,
                )
            });
            AssignmentTarget::new_array_assignment_target(pattern.span, elements, rest, &builder)
        }
        BindingPattern::ObjectPattern(pattern) => {
            let pattern = pattern.unbox();
            let properties = ArenaVec::from_iter_in(
                pattern.properties.into_iter().map(|property| {
                    AssignmentTargetProperty::new_assignment_target_property_property(
                        property.span,
                        property.key,
                        binding_pattern_assignment_value(allocator, property.value),
                        property.computed,
                        &builder,
                    )
                }),
                &allocator,
            );
            let rest = pattern.rest.map(|rest| {
                let rest = rest.unbox();
                AssignmentTargetRest::boxed(
                    rest.span,
                    binding_pattern_assignment_target(allocator, rest.argument),
                    &builder,
                )
            });
            AssignmentTarget::new_object_assignment_target(pattern.span, properties, rest, &builder)
        }
    }
}

fn binding_pattern_assignment_value<'a>(
    allocator: &'a Allocator,
    pattern: BindingPattern<'a>,
) -> AssignmentTargetMaybeDefault<'a> {
    if let BindingPattern::AssignmentPattern(pattern) = pattern {
        let pattern = pattern.unbox();
        return AssignmentTargetMaybeDefault::new_assignment_target_with_default(
            pattern.span,
            binding_pattern_assignment_target(allocator, pattern.left),
            pattern.right,
            &AstBuilder::new(allocator),
        );
    }
    AssignmentTargetMaybeDefault::from(binding_pattern_assignment_target(allocator, pattern))
}

fn hoisted_var_statement<'a>(
    allocator: &'a Allocator,
    bindings: Vec<(String, Span)>,
    span: Span,
) -> Option<Statement<'a>> {
    if bindings.is_empty() {
        return None;
    }
    let builder = AstBuilder::new(allocator);
    let declarations = ArenaVec::from_iter_in(
        bindings.into_iter().map(|(name, binding_span)| {
            VariableDeclarator::new(
                binding_span,
                VariableDeclarationKind::Var,
                BindingPattern::new_binding_identifier(
                    binding_span,
                    allocator.alloc_str(&name),
                    &builder,
                ),
                NONE,
                None,
                false,
                &builder,
            )
        }),
        &allocator,
    );
    Some(Statement::new_variable_declaration(
        span,
        VariableDeclarationKind::Var,
        declarations,
        false,
        &builder,
    ))
}

fn statement_returns_value(statement: &Statement<'_>) -> bool {
    match statement {
        Statement::ReturnStatement(returned) => returned.argument.is_some(),
        Statement::BlockStatement(block) => block.body.iter().any(statement_returns_value),
        _ => false,
    }
}
fn binding_expression<'a>(
    allocator: &'a Allocator,
    rewrite: &ConditionalReturnRewrite,
    test: Expression<'a>,
    consequent: Expression<'a>,
    alternate: Expression<'a>,
    span: Span,
) -> Expression<'a> {
    let binding = conditional_expression(allocator, rewrite, test, consequent, alternate, span);
    finalized_binding_expression(allocator, rewrite, binding, span)
}

fn dispatcher_binding_expression<'a>(
    allocator: &'a Allocator,
    rewrite: &ConditionalReturnRewrite,
    test: Expression<'a>,
    dispatcher: Expression<'a>,
    span: Span,
) -> Expression<'a> {
    let builder = AstBuilder::new(allocator);
    let dispatcher_call = |selected| {
        call_with_argument(
            allocator,
            Expression::new_identifier(span, allocator.alloc_str(&rewrite.target), &builder),
            Expression::new_boolean_literal(span, selected, &builder),
            span,
        )
    };
    let binding = conditional_expression(
        allocator,
        rewrite,
        test,
        dispatcher_call(true),
        dispatcher_call(false),
        span,
    );
    // The allocated target is collision-free. Reusing it in nested, non-overlapping parameter
    // scopes materializes the dispatcher exactly once without inventing another local name.
    let finalized = finalized_binding_expression(allocator, rewrite, binding, span);
    let receive_dispatcher = expression_arrow(
        allocator,
        allocator.alloc_str(&rewrite.target),
        finalized,
        span,
    );
    call_with_argument(allocator, receive_dispatcher, dispatcher, span)
}

fn conditional_expression<'a>(
    allocator: &'a Allocator,
    rewrite: &ConditionalReturnRewrite,
    test: Expression<'a>,
    consequent: Expression<'a>,
    alternate: Expression<'a>,
    span: Span,
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
    Expression::new_call_expression(span, callee, NONE, arguments, false, &builder)
}

fn finalized_binding_expression<'a>(
    allocator: &'a Allocator,
    rewrite: &ConditionalReturnRewrite,
    binding: Expression<'a>,
    span: Span,
) -> Expression<'a> {
    let builder = AstBuilder::new(allocator);
    let target =
        || Expression::new_identifier(span, allocator.alloc_str(&rewrite.target), &builder);
    let dispose = Expression::new_static_member_expression(
        span,
        target(),
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
    let result = Expression::new_sequence_expression(
        span,
        ArenaVec::from_array_in([cleanup, target()], &allocator),
        &builder,
    );
    let finalize = expression_arrow(
        allocator,
        allocator.alloc_str(&rewrite.target),
        result,
        span,
    );
    call_with_argument(allocator, finalize, binding, span)
}

fn call_with_argument<'a>(
    allocator: &'a Allocator,
    callee: Expression<'a>,
    argument: Expression<'a>,
    span: Span,
) -> Expression<'a> {
    Expression::new_call_expression(
        span,
        callee,
        NONE,
        ArenaVec::from_array_in([Argument::from(argument)], &allocator),
        false,
        &AstBuilder::new(allocator),
    )
}
