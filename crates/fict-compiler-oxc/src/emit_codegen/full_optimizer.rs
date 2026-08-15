use super::semantic_identity::SemanticIdentities;
use fict_hir::BindingId;
use oxc::{
    allocator::{Allocator, CloneIn, Vec as ArenaVec},
    ast::{
        AstBuilder,
        ast::{
            ArrowFunctionExpression, BindingPattern, Expression, Function, ObjectProperty, Program,
            SwitchStatement, VariableDeclarationKind, VariableDeclarator, WithStatement,
        },
    },
    ast_visit::{Visit, VisitMut, walk, walk_mut},
    span::{GetSpan, Span},
    syntax::{
        number::NumberBase,
        operator::{BinaryOperator, LogicalOperator, UnaryOperator},
        scope::ScopeFlags,
    },
};
use std::collections::{BTreeMap, BTreeSet};

type SourceLocation = (u32, u32);

#[derive(Debug, Clone, PartialEq, Eq)]
enum Constant {
    Undefined,
    Null,
    Boolean(bool),
    Number(u64),
    String(String),
}

impl Constant {
    fn number(value: f64) -> Option<Self> {
        value.is_finite().then_some(Self::Number(value.to_bits()))
    }

    fn as_number(&self) -> Option<f64> {
        match self {
            Self::Number(bits) => Some(f64::from_bits(*bits)),
            _ => None,
        }
    }

    fn truthy(&self) -> bool {
        match self {
            Self::Undefined | Self::Null => false,
            Self::Boolean(value) => *value,
            Self::Number(bits) => {
                let value = f64::from_bits(*bits);
                value != 0.0 && !value.is_nan()
            }
            Self::String(value) => !value.is_empty(),
        }
    }

    fn nullish(&self) -> bool {
        matches!(self, Self::Undefined | Self::Null)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Evaluated {
    value: Constant,
    pure: bool,
}

#[derive(Debug, Clone)]
struct ConstantBinding {
    value: Constant,
    declaration_end: u32,
    owner: Option<SourceLocation>,
}

#[derive(Debug, Default)]
pub(super) struct FullOptimizationPlan {
    authored_expressions: BTreeSet<SourceLocation>,
    protected_identifiers: BTreeSet<SourceLocation>,
    constants: BTreeMap<BindingId, ConstantBinding>,
    // Unbound `undefined` is stable in module grammar, but sloppy scripts can shadow it dynamically.
    global_undefined_is_constant: bool,
}

pub(super) fn analyze<'a>(
    program: &Program<'a>,
    identities: &SemanticIdentities,
    global_undefined_is_constant: bool,
) -> FullOptimizationPlan {
    let mut collector = PlanCollector {
        identities,
        authored_expressions: BTreeSet::new(),
        protected_identifiers: BTreeSet::new(),
        constants: BTreeMap::new(),
        owner: None,
        shorthand_depth: 0,
        switch_depth: 0,
        dynamic_scope_depth: 0,
        global_undefined_is_constant,
    };
    collector.visit_program(program);
    FullOptimizationPlan {
        authored_expressions: collector.authored_expressions,
        protected_identifiers: collector.protected_identifiers,
        constants: collector.constants,
        global_undefined_is_constant,
    }
}

pub(super) fn rewrite<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    identities: &SemanticIdentities,
    plan: &FullOptimizationPlan,
) {
    if plan.authored_expressions.is_empty() {
        return;
    }
    AlgebraicRewriter {
        allocator,
        identities,
        plan,
        owner: None,
    }
    .visit_program(program);
}

struct PlanCollector<'identities> {
    identities: &'identities SemanticIdentities,
    authored_expressions: BTreeSet<SourceLocation>,
    protected_identifiers: BTreeSet<SourceLocation>,
    constants: BTreeMap<BindingId, ConstantBinding>,
    owner: Option<SourceLocation>,
    shorthand_depth: usize,
    switch_depth: usize,
    dynamic_scope_depth: usize,
    global_undefined_is_constant: bool,
}

impl<'a> Visit<'a> for PlanCollector<'_> {
    fn visit_expression(&mut self, expression: &Expression<'a>) {
        let span = expression.span();
        if self.dynamic_scope_depth == 0 {
            self.authored_expressions.insert((span.start, span.end));
            if self.shorthand_depth > 0 && matches!(expression, Expression::Identifier(_)) {
                self.protected_identifiers.insert((span.start, span.end));
            }
        }
        walk::walk_expression(self, expression);
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if self.dynamic_scope_depth == 0
            && self.switch_depth == 0
            && declarator.kind == VariableDeclarationKind::Const
            && let BindingPattern::BindingIdentifier(identifier) = &declarator.id
            && let Some(symbol) = identifier.symbol_id.get()
            && let Some(binding) = self.identities.binding_for_symbol(symbol)
            && let Some(initializer) = declarator.init.as_ref()
            && let Some(value) = evaluate_bound_expression(
                initializer,
                self.identities,
                &self.constants,
                self.global_undefined_is_constant,
            )
        {
            self.constants.insert(
                binding,
                ConstantBinding {
                    value: value.value,
                    declaration_end: declarator.span.end,
                    owner: self.owner,
                },
            );
        }
        walk::walk_variable_declarator(self, declarator);
    }

    fn visit_object_property(&mut self, property: &ObjectProperty<'a>) {
        self.shorthand_depth += usize::from(property.shorthand);
        walk::walk_object_property(self, property);
        self.shorthand_depth -= usize::from(property.shorthand);
    }

    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        let previous = self.owner;
        let previous_switch_depth = self.switch_depth;
        self.owner = Some((function.span.start, function.span.end));
        self.switch_depth = 0;
        walk::walk_function(self, function, flags);
        self.owner = previous;
        self.switch_depth = previous_switch_depth;
    }

    fn visit_arrow_function_expression(&mut self, function: &ArrowFunctionExpression<'a>) {
        let previous = self.owner;
        let previous_switch_depth = self.switch_depth;
        self.owner = Some((function.span.start, function.span.end));
        self.switch_depth = 0;
        walk::walk_arrow_function_expression(self, function);
        self.owner = previous;
        self.switch_depth = previous_switch_depth;
    }

    fn visit_switch_statement(&mut self, statement: &SwitchStatement<'a>) {
        // A later case can enter the shared lexical scope without executing an earlier declaration.
        self.switch_depth += 1;
        walk::walk_switch_statement(self, statement);
        self.switch_depth -= 1;
    }

    fn visit_with_statement(&mut self, statement: &WithStatement<'a>) {
        // `with` can intercept names that static binding identities resolve to an outer constant.
        self.dynamic_scope_depth += 1;
        walk::walk_with_statement(self, statement);
        self.dynamic_scope_depth -= 1;
    }
}

struct AlgebraicRewriter<'a, 'plan> {
    allocator: &'a Allocator,
    identities: &'plan SemanticIdentities,
    plan: &'plan FullOptimizationPlan,
    owner: Option<SourceLocation>,
}

impl<'a> AlgebraicRewriter<'a, '_> {
    fn rewrite_identifier(&self, expression: &Expression<'a>) -> Option<Expression<'a>> {
        let Expression::Identifier(identifier) = expression else {
            return None;
        };
        let location = (identifier.span.start, identifier.span.end);
        if self.plan.protected_identifiers.contains(&location) {
            return None;
        }
        let binding = self.identities.binding_for_reference(identifier)?;
        let constant = self.plan.constants.get(&binding)?;
        if constant.owner != self.owner || identifier.span.start < constant.declaration_end {
            return None;
        }
        constant_expression(self.allocator, &constant.value, identifier.span)
    }

    fn simplify(&self, expression: &Expression<'a>) -> Option<Expression<'a>> {
        let span = expression.span();
        if let Some(value) = evaluate_literal_expression(
            expression,
            self.identities,
            self.plan.global_undefined_is_constant,
        ) && value.pure
            && !matches!(
                expression,
                Expression::BooleanLiteral(_)
                    | Expression::NullLiteral(_)
                    | Expression::NumericLiteral(_)
                    | Expression::StringLiteral(_)
            )
        {
            return constant_expression(self.allocator, &value.value, span);
        }
        match expression {
            Expression::LogicalExpression(logical) => {
                let left = evaluate_literal_expression(
                    &logical.left,
                    self.identities,
                    self.plan.global_undefined_is_constant,
                )?;
                if !left.pure {
                    return None;
                }
                match logical.operator {
                    LogicalOperator::And if left.value == Constant::Boolean(true) => {
                        Some(logical.right.clone_in(self.allocator))
                    }
                    LogicalOperator::And if left.value == Constant::Boolean(false) => {
                        constant_expression(self.allocator, &Constant::Boolean(false), span)
                    }
                    LogicalOperator::Or if left.value == Constant::Boolean(false) => {
                        Some(logical.right.clone_in(self.allocator))
                    }
                    LogicalOperator::Or if left.value == Constant::Boolean(true) => {
                        constant_expression(self.allocator, &Constant::Boolean(true), span)
                    }
                    LogicalOperator::Coalesce if left.value.nullish() => {
                        Some(logical.right.clone_in(self.allocator))
                    }
                    LogicalOperator::Coalesce => Some(logical.left.clone_in(self.allocator)),
                    LogicalOperator::And | LogicalOperator::Or => None,
                }
            }
            Expression::ConditionalExpression(conditional) => {
                if let Some(test) = evaluate_literal_expression(
                    &conditional.test,
                    self.identities,
                    self.plan.global_undefined_is_constant,
                ) && test.pure
                {
                    return Some(
                        if test.value.truthy() {
                            &conditional.consequent
                        } else {
                            &conditional.alternate
                        }
                        .clone_in(self.allocator),
                    );
                }
                let consequent = evaluate_literal_expression(
                    &conditional.consequent,
                    self.identities,
                    self.plan.global_undefined_is_constant,
                )?;
                let alternate = evaluate_literal_expression(
                    &conditional.alternate,
                    self.identities,
                    self.plan.global_undefined_is_constant,
                )?;
                if consequent.value != alternate.value || !consequent.pure || !alternate.pure {
                    return None;
                }
                let mut expressions = ArenaVec::new_in(&self.allocator);
                expressions.push(conditional.test.clone_in(self.allocator));
                expressions.push(conditional.consequent.clone_in(self.allocator));
                Some(Expression::new_sequence_expression(
                    span,
                    expressions,
                    &AstBuilder::new(self.allocator),
                ))
            }
            _ => None,
        }
    }
}

impl<'a> VisitMut<'a> for AlgebraicRewriter<'a, '_> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expression);
        let span = expression.span();
        if !self
            .plan
            .authored_expressions
            .contains(&(span.start, span.end))
        {
            return;
        }
        if let Some(replacement) = self.rewrite_identifier(expression) {
            *expression = replacement;
            return;
        }
        if let Some(replacement) = self.simplify(expression) {
            *expression = replacement;
        }
    }

    fn visit_function(&mut self, function: &mut Function<'a>, flags: ScopeFlags) {
        let previous = self.owner;
        self.owner = Some((function.span.start, function.span.end));
        walk_mut::walk_function(self, function, flags);
        self.owner = previous;
    }

    fn visit_arrow_function_expression(&mut self, function: &mut ArrowFunctionExpression<'a>) {
        let previous = self.owner;
        self.owner = Some((function.span.start, function.span.end));
        walk_mut::walk_arrow_function_expression(self, function);
        self.owner = previous;
    }
}

fn evaluated(value: Constant) -> Option<Evaluated> {
    Some(Evaluated { value, pure: true })
}

fn evaluate_literal_expression(
    expression: &Expression<'_>,
    identities: &SemanticIdentities,
    global_undefined_is_constant: bool,
) -> Option<Evaluated> {
    evaluate_expression(expression, identities, None, global_undefined_is_constant)
}

fn evaluate_bound_expression(
    expression: &Expression<'_>,
    identities: &SemanticIdentities,
    constants: &BTreeMap<BindingId, ConstantBinding>,
    global_undefined_is_constant: bool,
) -> Option<Evaluated> {
    evaluate_expression(
        expression,
        identities,
        Some(constants),
        global_undefined_is_constant,
    )
}

fn evaluate_expression(
    expression: &Expression<'_>,
    identities: &SemanticIdentities,
    constants: Option<&BTreeMap<BindingId, ConstantBinding>>,
    global_undefined_is_constant: bool,
) -> Option<Evaluated> {
    match expression {
        Expression::BooleanLiteral(literal) => evaluated(Constant::Boolean(literal.value)),
        Expression::NullLiteral(_) => evaluated(Constant::Null),
        Expression::NumericLiteral(literal) => evaluated(Constant::number(literal.value)?),
        Expression::StringLiteral(literal) if !literal.lone_surrogates => {
            evaluated(Constant::String(literal.value.to_string()))
        }
        Expression::Identifier(identifier) => {
            if let Some(binding) = identities.binding_for_reference(identifier) {
                let constant = constants?.get(&binding)?;
                evaluated(constant.value.clone())
            } else if global_undefined_is_constant && identifier.name == "undefined" {
                evaluated(Constant::Undefined)
            } else {
                None
            }
        }
        Expression::UnaryExpression(unary) => evaluate_unary(
            unary.operator,
            evaluate_expression(
                &unary.argument,
                identities,
                constants,
                global_undefined_is_constant,
            ),
        ),
        Expression::BinaryExpression(binary) => evaluate_binary(
            binary.operator,
            evaluate_expression(
                &binary.left,
                identities,
                constants,
                global_undefined_is_constant,
            )?,
            evaluate_expression(
                &binary.right,
                identities,
                constants,
                global_undefined_is_constant,
            )?,
        ),
        Expression::LogicalExpression(logical) => {
            let left = evaluate_expression(
                &logical.left,
                identities,
                constants,
                global_undefined_is_constant,
            )?;
            match logical.operator {
                LogicalOperator::And if !left.value.truthy() => Some(left),
                LogicalOperator::Or if left.value.truthy() => Some(left),
                LogicalOperator::Coalesce if !left.value.nullish() => Some(left),
                LogicalOperator::And | LogicalOperator::Or | LogicalOperator::Coalesce => {
                    let right = evaluate_expression(
                        &logical.right,
                        identities,
                        constants,
                        global_undefined_is_constant,
                    )?;
                    Some(Evaluated {
                        value: right.value,
                        pure: left.pure && right.pure,
                    })
                }
            }
        }
        Expression::ConditionalExpression(conditional) => {
            if let Some(test) = evaluate_expression(
                &conditional.test,
                identities,
                constants,
                global_undefined_is_constant,
            ) {
                let selected = if test.value.truthy() {
                    &conditional.consequent
                } else {
                    &conditional.alternate
                };
                let selected = evaluate_expression(
                    selected,
                    identities,
                    constants,
                    global_undefined_is_constant,
                )?;
                return Some(Evaluated {
                    value: selected.value,
                    pure: test.pure && selected.pure,
                });
            }
            let consequent = evaluate_expression(
                &conditional.consequent,
                identities,
                constants,
                global_undefined_is_constant,
            )?;
            let alternate = evaluate_expression(
                &conditional.alternate,
                identities,
                constants,
                global_undefined_is_constant,
            )?;
            (consequent.value == alternate.value).then_some(Evaluated {
                value: consequent.value,
                pure: false,
            })
        }
        Expression::SequenceExpression(sequence) => {
            let last = sequence.expressions.last()?;
            let value =
                evaluate_expression(last, identities, constants, global_undefined_is_constant)?;
            let pure = value.pure
                && sequence.expressions[..sequence.expressions.len() - 1]
                    .iter()
                    .all(|expression| {
                        evaluate_expression(
                            expression,
                            identities,
                            constants,
                            global_undefined_is_constant,
                        )
                        .is_some_and(|value| value.pure)
                    });
            Some(Evaluated {
                value: value.value,
                pure,
            })
        }
        Expression::ParenthesizedExpression(parenthesized) => evaluate_expression(
            &parenthesized.expression,
            identities,
            constants,
            global_undefined_is_constant,
        ),
        Expression::TSAsExpression(expression) => evaluate_expression(
            &expression.expression,
            identities,
            constants,
            global_undefined_is_constant,
        ),
        Expression::TSNonNullExpression(expression) => evaluate_expression(
            &expression.expression,
            identities,
            constants,
            global_undefined_is_constant,
        ),
        Expression::TSSatisfiesExpression(expression) => evaluate_expression(
            &expression.expression,
            identities,
            constants,
            global_undefined_is_constant,
        ),
        Expression::TSTypeAssertion(expression) => evaluate_expression(
            &expression.expression,
            identities,
            constants,
            global_undefined_is_constant,
        ),
        _ => None,
    }
}

fn evaluate_unary(operator: UnaryOperator, argument: Option<Evaluated>) -> Option<Evaluated> {
    if operator == UnaryOperator::Void {
        return Some(Evaluated {
            value: Constant::Undefined,
            pure: argument.is_some_and(|value| value.pure),
        });
    }
    let argument = argument?;
    let value = match operator {
        UnaryOperator::LogicalNot => Constant::Boolean(!argument.value.truthy()),
        UnaryOperator::UnaryPlus => Constant::number(argument.value.as_number()?)?,
        UnaryOperator::UnaryNegation => Constant::number(-argument.value.as_number()?)?,
        UnaryOperator::BitwiseNot => {
            Constant::number(f64::from(!to_int32(argument.value.as_number()?)))?
        }
        UnaryOperator::Typeof => Constant::String(
            match argument.value {
                Constant::Undefined => "undefined",
                Constant::Null => "object",
                Constant::Boolean(_) => "boolean",
                Constant::Number(_) => "number",
                Constant::String(_) => "string",
            }
            .to_owned(),
        ),
        UnaryOperator::Void | UnaryOperator::Delete => return None,
    };
    Some(Evaluated {
        value,
        pure: argument.pure,
    })
}

fn evaluate_binary(
    operator: BinaryOperator,
    left: Evaluated,
    right: Evaluated,
) -> Option<Evaluated> {
    let value = match operator {
        BinaryOperator::Addition => match (&left.value, &right.value) {
            (Constant::String(left), Constant::String(right)) => {
                Constant::String(format!("{left}{right}"))
            }
            _ => Constant::number(left.value.as_number()? + right.value.as_number()?)?,
        },
        BinaryOperator::Subtraction => {
            Constant::number(left.value.as_number()? - right.value.as_number()?)?
        }
        BinaryOperator::Multiplication => {
            Constant::number(left.value.as_number()? * right.value.as_number()?)?
        }
        BinaryOperator::Division => {
            Constant::number(left.value.as_number()? / right.value.as_number()?)?
        }
        BinaryOperator::Remainder => {
            Constant::number(left.value.as_number()? % right.value.as_number()?)?
        }
        BinaryOperator::Exponential => {
            Constant::number(left.value.as_number()?.powf(right.value.as_number()?))?
        }
        BinaryOperator::StrictEquality | BinaryOperator::StrictInequality => {
            let equal = strict_equal_constant(&left.value, &right.value);
            Constant::Boolean(if operator == BinaryOperator::StrictEquality {
                equal
            } else {
                !equal
            })
        }
        BinaryOperator::LessThan => {
            Constant::Boolean(left.value.as_number()? < right.value.as_number()?)
        }
        BinaryOperator::LessEqualThan => {
            Constant::Boolean(left.value.as_number()? <= right.value.as_number()?)
        }
        BinaryOperator::GreaterThan => {
            Constant::Boolean(left.value.as_number()? > right.value.as_number()?)
        }
        BinaryOperator::GreaterEqualThan => {
            Constant::Boolean(left.value.as_number()? >= right.value.as_number()?)
        }
        BinaryOperator::ShiftLeft => Constant::number(f64::from(
            to_int32(left.value.as_number()?)
                .wrapping_shl(to_uint32(right.value.as_number()?) & 31),
        ))?,
        BinaryOperator::ShiftRight => Constant::number(f64::from(
            to_int32(left.value.as_number()?)
                .wrapping_shr(to_uint32(right.value.as_number()?) & 31),
        ))?,
        BinaryOperator::ShiftRightZeroFill => Constant::number(f64::from(
            to_uint32(left.value.as_number()?)
                .wrapping_shr(to_uint32(right.value.as_number()?) & 31),
        ))?,
        BinaryOperator::BitwiseOR => Constant::number(f64::from(
            to_int32(left.value.as_number()?) | to_int32(right.value.as_number()?),
        ))?,
        BinaryOperator::BitwiseXOR => Constant::number(f64::from(
            to_int32(left.value.as_number()?) ^ to_int32(right.value.as_number()?),
        ))?,
        BinaryOperator::BitwiseAnd => Constant::number(f64::from(
            to_int32(left.value.as_number()?) & to_int32(right.value.as_number()?),
        ))?,
        BinaryOperator::Equality
        | BinaryOperator::Inequality
        | BinaryOperator::In
        | BinaryOperator::Instanceof => return None,
    };
    Some(Evaluated {
        value,
        pure: left.pure && right.pure,
    })
}

fn strict_equal_constant(left: &Constant, right: &Constant) -> bool {
    match (left, right) {
        (Constant::Undefined, Constant::Undefined) | (Constant::Null, Constant::Null) => true,
        (Constant::Boolean(left), Constant::Boolean(right)) => left == right,
        (Constant::Number(left), Constant::Number(right)) => {
            f64::from_bits(*left) == f64::from_bits(*right)
        }
        (Constant::String(left), Constant::String(right)) => left == right,
        _ => false,
    }
}

fn constant_expression<'a>(
    allocator: &'a Allocator,
    constant: &Constant,
    span: Span,
) -> Option<Expression<'a>> {
    let builder = AstBuilder::new(allocator);
    Some(match constant {
        Constant::Undefined => Expression::new_unary_expression(
            span,
            UnaryOperator::Void,
            Expression::new_numeric_literal(span, 0.0, None, NumberBase::Decimal, &builder),
            &builder,
        ),
        Constant::Null => Expression::new_null_literal(span, &builder),
        Constant::Boolean(value) => Expression::new_boolean_literal(span, *value, &builder),
        Constant::Number(bits) => {
            let value = f64::from_bits(*bits);
            if value == 0.0 && value.is_sign_negative() {
                Expression::new_unary_expression(
                    span,
                    UnaryOperator::UnaryNegation,
                    Expression::new_numeric_literal(span, 0.0, None, NumberBase::Decimal, &builder),
                    &builder,
                )
            } else {
                Expression::new_numeric_literal(span, value, None, NumberBase::Decimal, &builder)
            }
        }
        Constant::String(value) => {
            Expression::new_string_literal(span, allocator.alloc_str(value), None, &builder)
        }
    })
}

fn to_int32(value: f64) -> i32 {
    to_uint32(value) as i32
}

fn to_uint32(value: f64) -> u32 {
    if !value.is_finite() || value == 0.0 {
        return 0;
    }
    value.trunc().rem_euclid(4_294_967_296.0) as u32
}
