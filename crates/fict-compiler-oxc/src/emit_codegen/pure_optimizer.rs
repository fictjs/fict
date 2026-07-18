use super::semantic_identity::SemanticIdentities;
use fict_emit::RuntimeHelper;
use fict_hir::BindingId;
use oxc::{
    allocator::{Allocator, TakeIn, Vec as ArenaVec},
    ast::{
        AstBuilder,
        ast::{
            Argument, ArrayExpressionElement, ArrowFunctionExpression, BindingPattern,
            CallExpression, ChainElement, Expression, Function, IdentifierReference,
            MemberExpression, ObjectPropertyKind, Program, Statement, VariableDeclaration,
            VariableDeclarationKind, VariableDeclarator,
        },
    },
    ast_visit::{Visit, VisitMut, walk, walk_mut},
    span::{GetSpan, Span},
    syntax::{
        operator::{BinaryOperator, UnaryOperator},
        scope::ScopeFlags,
    },
};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

type SourceLocation = (u32, u32);

#[derive(Debug, Default)]
pub(super) struct PureOptimizationPlan {
    dead_bindings: BTreeSet<BindingId>,
    cse_replacements: BTreeMap<BindingId, String>,
}

#[derive(Debug)]
struct Candidate {
    original_dependencies: Vec<BindingId>,
    dependencies: Vec<BindingId>,
}

#[derive(Clone, Copy)]
struct PureContext<'identities> {
    identities: &'identities SemanticIdentities,
    runtime_helpers: &'identities BTreeMap<String, RuntimeHelper>,
}

fn licensed_pure_expression(expression: &Expression<'_>, context: PureContext<'_>) -> bool {
    let expression = expression.get_inner_expression();
    if let Some(member) = expression.as_member_expression() {
        return pure_member_expression(member, context);
    }
    match expression {
        Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::BigIntLiteral(_)
        | Expression::RegExpLiteral(_)
        | Expression::StringLiteral(_)
        | Expression::Identifier(_)
        | Expression::Super(_)
        | Expression::ThisExpression(_) => true,
        Expression::TemplateLiteral(template) => template
            .expressions
            .iter()
            .all(|expression| known_primitive_pure_expression(expression, context)),
        Expression::ArrayExpression(array) => array.elements.iter().all(|element| match element {
            ArrayExpressionElement::Elision(_) => true,
            ArrayExpressionElement::SpreadElement(_) => false,
            _ => element
                .as_expression()
                .is_some_and(|expression| licensed_pure_expression(expression, context)),
        }),
        Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => true,
        Expression::BinaryExpression(binary) => {
            coercion_safe_pure_binary(binary.operator, &binary.left, &binary.right, context)
        }
        Expression::CallExpression(call) => pure_call_expression(call, context, false),
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::CallExpression(call) => pure_call_expression(call, context, false),
            ChainElement::TSNonNullExpression(wrapper) => {
                licensed_pure_expression(&wrapper.expression, context)
            }
            _ => chain
                .expression
                .as_member_expression()
                .is_some_and(|member| pure_member_expression(member, context)),
        },
        Expression::ConditionalExpression(conditional) => {
            licensed_pure_expression(&conditional.test, context)
                && licensed_pure_expression(&conditional.consequent, context)
                && licensed_pure_expression(&conditional.alternate, context)
        }
        Expression::LogicalExpression(logical) => {
            licensed_pure_expression(&logical.left, context)
                && licensed_pure_expression(&logical.right, context)
        }
        Expression::ObjectExpression(object) => object.properties.iter().all(|property| {
            let ObjectPropertyKind::ObjectProperty(property) = property else {
                return false;
            };
            (!property.computed
                || property
                    .key
                    .as_expression()
                    .is_some_and(|key| known_primitive_pure_expression(key, context)))
                && licensed_pure_expression(&property.value, context)
        }),
        Expression::SequenceExpression(sequence) => sequence
            .expressions
            .iter()
            .all(|expression| licensed_pure_expression(expression, context)),
        Expression::UnaryExpression(unary) => match unary.operator {
            UnaryOperator::LogicalNot | UnaryOperator::Typeof | UnaryOperator::Void => {
                licensed_pure_expression(&unary.argument, context)
            }
            UnaryOperator::UnaryPlus | UnaryOperator::UnaryNegation | UnaryOperator::BitwiseNot => {
                known_primitive_pure_expression(&unary.argument, context)
            }
            UnaryOperator::Delete => false,
        },
        _ => false,
    }
}

fn licensed_cse_expression(expression: &Expression<'_>, context: PureContext<'_>) -> bool {
    let expression = expression.get_inner_expression();
    if let Some(member) = expression.as_member_expression() {
        return cse_member_expression(member, context);
    }
    match expression {
        Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::BigIntLiteral(_)
        | Expression::StringLiteral(_)
        | Expression::Identifier(_)
        | Expression::Super(_)
        | Expression::ThisExpression(_) => true,
        Expression::TemplateLiteral(template) => template
            .expressions
            .iter()
            .all(|expression| known_primitive_cse_expression(expression, context)),
        Expression::BinaryExpression(binary) => {
            coercion_safe_cse_binary(binary.operator, &binary.left, &binary.right, context)
        }
        Expression::CallExpression(call) => pure_call_expression(call, context, true),
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::CallExpression(call) => pure_call_expression(call, context, true),
            ChainElement::TSNonNullExpression(wrapper) => {
                licensed_cse_expression(&wrapper.expression, context)
            }
            _ => chain
                .expression
                .as_member_expression()
                .is_some_and(|member| cse_member_expression(member, context)),
        },
        Expression::ConditionalExpression(conditional) => {
            licensed_cse_expression(&conditional.test, context)
                && licensed_cse_expression(&conditional.consequent, context)
                && licensed_cse_expression(&conditional.alternate, context)
        }
        Expression::LogicalExpression(logical) => {
            licensed_cse_expression(&logical.left, context)
                && licensed_cse_expression(&logical.right, context)
        }
        Expression::SequenceExpression(sequence) => sequence
            .expressions
            .iter()
            .all(|expression| licensed_cse_expression(expression, context)),
        Expression::UnaryExpression(unary) => match unary.operator {
            UnaryOperator::LogicalNot | UnaryOperator::Typeof | UnaryOperator::Void => {
                licensed_cse_expression(&unary.argument, context)
            }
            UnaryOperator::UnaryPlus | UnaryOperator::UnaryNegation | UnaryOperator::BitwiseNot => {
                known_primitive_cse_expression(&unary.argument, context)
            }
            UnaryOperator::Delete => false,
        },
        _ => false,
    }
}

fn pure_member_expression(member: &MemberExpression<'_>, context: PureContext<'_>) -> bool {
    match member {
        MemberExpression::ComputedMemberExpression(member) => {
            licensed_pure_expression(&member.object, context)
                && licensed_pure_expression(&member.expression, context)
        }
        MemberExpression::StaticMemberExpression(member) => {
            licensed_pure_expression(&member.object, context)
        }
        MemberExpression::PrivateFieldExpression(member) => {
            licensed_pure_expression(&member.object, context)
        }
    }
}

fn cse_member_expression(member: &MemberExpression<'_>, context: PureContext<'_>) -> bool {
    match member {
        MemberExpression::ComputedMemberExpression(member) => {
            licensed_cse_expression(&member.object, context)
                && licensed_cse_expression(&member.expression, context)
        }
        MemberExpression::StaticMemberExpression(member) => {
            licensed_cse_expression(&member.object, context)
        }
        MemberExpression::PrivateFieldExpression(member) => {
            licensed_cse_expression(&member.object, context)
        }
    }
}

fn known_primitive_pure_expression(expression: &Expression<'_>, context: PureContext<'_>) -> bool {
    let expression = expression.get_inner_expression();
    match expression {
        Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::BigIntLiteral(_)
        | Expression::StringLiteral(_) => true,
        Expression::UnaryExpression(unary) => match unary.operator {
            UnaryOperator::LogicalNot | UnaryOperator::Typeof | UnaryOperator::Void => {
                licensed_pure_expression(&unary.argument, context)
            }
            UnaryOperator::UnaryPlus | UnaryOperator::UnaryNegation | UnaryOperator::BitwiseNot => {
                known_primitive_pure_expression(&unary.argument, context)
            }
            UnaryOperator::Delete => false,
        },
        Expression::BinaryExpression(binary) => {
            coercion_safe_pure_binary(binary.operator, &binary.left, &binary.right, context)
        }
        Expression::ConditionalExpression(conditional) => {
            licensed_pure_expression(&conditional.test, context)
                && known_primitive_pure_expression(&conditional.consequent, context)
                && known_primitive_pure_expression(&conditional.alternate, context)
        }
        _ => expression
            .as_member_expression()
            .is_some_and(|member| stable_member_expression(member, context)),
    }
}

fn known_primitive_cse_expression(expression: &Expression<'_>, context: PureContext<'_>) -> bool {
    let expression = expression.get_inner_expression();
    match expression {
        Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::BigIntLiteral(_)
        | Expression::StringLiteral(_) => true,
        Expression::UnaryExpression(unary) => match unary.operator {
            UnaryOperator::LogicalNot | UnaryOperator::Typeof | UnaryOperator::Void => {
                licensed_cse_expression(&unary.argument, context)
            }
            UnaryOperator::UnaryPlus | UnaryOperator::UnaryNegation | UnaryOperator::BitwiseNot => {
                known_primitive_cse_expression(&unary.argument, context)
            }
            UnaryOperator::Delete => false,
        },
        Expression::BinaryExpression(binary) => {
            coercion_safe_cse_binary(binary.operator, &binary.left, &binary.right, context)
        }
        Expression::ConditionalExpression(conditional) => {
            licensed_cse_expression(&conditional.test, context)
                && known_primitive_cse_expression(&conditional.consequent, context)
                && known_primitive_cse_expression(&conditional.alternate, context)
        }
        _ => expression
            .as_member_expression()
            .is_some_and(|member| stable_member_expression(member, context)),
    }
}

fn coercion_safe_pure_binary(
    operator: BinaryOperator,
    left: &Expression<'_>,
    right: &Expression<'_>,
    context: PureContext<'_>,
) -> bool {
    if matches!(
        operator,
        BinaryOperator::StrictEquality | BinaryOperator::StrictInequality
    ) {
        return licensed_pure_expression(left, context) && licensed_pure_expression(right, context);
    }
    !matches!(operator, BinaryOperator::In | BinaryOperator::Instanceof)
        && known_primitive_pure_expression(left, context)
        && known_primitive_pure_expression(right, context)
}

fn coercion_safe_cse_binary(
    operator: BinaryOperator,
    left: &Expression<'_>,
    right: &Expression<'_>,
    context: PureContext<'_>,
) -> bool {
    if matches!(
        operator,
        BinaryOperator::StrictEquality | BinaryOperator::StrictInequality
    ) {
        return licensed_cse_expression(left, context) && licensed_cse_expression(right, context);
    }
    !matches!(operator, BinaryOperator::In | BinaryOperator::Instanceof)
        && known_primitive_cse_expression(left, context)
        && known_primitive_cse_expression(right, context)
}

fn pure_call_expression(call: &CallExpression<'_>, context: PureContext<'_>, cse: bool) -> bool {
    let argument_is_safe = |argument: &Argument<'_>| {
        argument.as_expression().is_some_and(|expression| {
            if cse {
                licensed_cse_expression(expression, context)
            } else {
                licensed_pure_expression(expression, context)
            }
        })
    };
    if !call.arguments.iter().all(argument_is_safe) {
        return false;
    }
    let callee = call.callee.get_inner_expression();
    let (root, member) = match callee {
        Expression::Identifier(identifier) => (identifier.as_ref(), None),
        Expression::StaticMemberExpression(member) => {
            let Expression::Identifier(identifier) = member.object.get_inner_expression() else {
                return false;
            };
            (identifier.as_ref(), Some(member.property.name.as_str()))
        }
        _ => return false,
    };
    if member.is_none()
        && let Some(helper) = context.runtime_helpers.get(root.name.as_str())
    {
        return matches!(
            helper,
            RuntimeHelper::Memo | RuntimeHelper::UseMemo | RuntimeHelper::UseContext
        );
    }
    if member.is_none() {
        match root.name.as_str() {
            "$memo" | "createMemo" => return true,
            "$state" | "$effect" | "$store" | "createSignal" | "createEffect" | "createStore"
            | "onMount" | "startTransition" | "render" => return false,
            _ => {}
        }
    }
    if context.identities.binding_for_reference(root).is_none()
        && let Some(safe) = builtin_call_is_safe(root.name.as_str(), member, &call.arguments)
    {
        return safe;
    }
    true
}

fn builtin_call_is_safe(
    root: &str,
    member: Option<&str>,
    arguments: &[Argument<'_>],
) -> Option<bool> {
    match (root, member) {
        ("String" | "Number", None) => Some(
            arguments
                .first()
                .is_none_or(|argument| argument.as_expression().is_some_and(primitive_literal)),
        ),
        ("BigInt", None) => Some(
            arguments.len() == 1
                && arguments[0]
                    .as_expression()
                    .is_some_and(valid_bigint_literal),
        ),
        ("parseInt" | "parseFloat", None) => Some(
            arguments
                .first()
                .is_none_or(|argument| argument.as_expression().is_some_and(primitive_literal))
                && arguments
                    .get(1)
                    .is_none_or(|argument| argument.as_expression().is_some_and(primitive_literal)),
        ),
        ("Math", Some(method)) if pure_math_method(method) => {
            Some(arguments.iter().all(|argument| {
                argument
                    .as_expression()
                    .is_some_and(primitive_number_literal)
            }))
        }
        _ => None,
    }
}

fn primitive_literal(expression: &Expression<'_>) -> bool {
    matches!(
        expression.get_inner_expression(),
        Expression::BooleanLiteral(_)
            | Expression::NullLiteral(_)
            | Expression::NumericLiteral(_)
            | Expression::BigIntLiteral(_)
            | Expression::StringLiteral(_)
    )
}

fn primitive_number_literal(expression: &Expression<'_>) -> bool {
    primitive_literal(expression)
        && !matches!(
            expression.get_inner_expression(),
            Expression::BigIntLiteral(_)
        )
}

fn valid_bigint_literal(expression: &Expression<'_>) -> bool {
    match expression.get_inner_expression() {
        Expression::BooleanLiteral(_) | Expression::BigIntLiteral(_) => true,
        Expression::NumericLiteral(number) => {
            number.value.is_finite() && number.value.fract() == 0.0
        }
        Expression::StringLiteral(string) => valid_bigint_string(string.value.as_str()),
        _ => false,
    }
}

fn valid_bigint_string(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() {
        return true;
    }
    let (digits, radix) = if let Some(value) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        (value, 16)
    } else if let Some(value) = value
        .strip_prefix("0o")
        .or_else(|| value.strip_prefix("0O"))
    {
        (value, 8)
    } else if let Some(value) = value
        .strip_prefix("0b")
        .or_else(|| value.strip_prefix("0B"))
    {
        (value, 2)
    } else {
        (value.strip_prefix(['+', '-']).unwrap_or(value), 10)
    };
    !digits.is_empty() && digits.chars().all(|character| character.is_digit(radix))
}

fn pure_math_method(name: &str) -> bool {
    matches!(
        name,
        "abs"
            | "ceil"
            | "floor"
            | "round"
            | "trunc"
            | "sign"
            | "min"
            | "max"
            | "pow"
            | "sqrt"
            | "cbrt"
            | "hypot"
            | "log"
            | "log10"
            | "log2"
            | "exp"
            | "sin"
            | "cos"
            | "tan"
    )
}

fn stable_member_expression(member: &MemberExpression<'_>, context: PureContext<'_>) -> bool {
    let MemberExpression::StaticMemberExpression(member) = member else {
        return false;
    };
    let Expression::Identifier(root) = member.object.get_inner_expression() else {
        return false;
    };
    if context.identities.binding_for_reference(root).is_some() {
        return false;
    }
    match root.name.as_str() {
        "Math" => matches!(
            member.property.name.as_str(),
            "E" | "LN2" | "LN10" | "LOG2E" | "LOG10E" | "PI" | "SQRT1_2" | "SQRT2"
        ),
        "Number" => matches!(
            member.property.name.as_str(),
            "EPSILON"
                | "MAX_SAFE_INTEGER"
                | "MIN_SAFE_INTEGER"
                | "MAX_VALUE"
                | "MIN_VALUE"
                | "NaN"
                | "POSITIVE_INFINITY"
                | "NEGATIVE_INFINITY"
        ),
        "Symbol" => matches!(
            member.property.name.as_str(),
            "asyncIterator"
                | "hasInstance"
                | "isConcatSpreadable"
                | "iterator"
                | "match"
                | "matchAll"
                | "replace"
                | "search"
                | "species"
                | "split"
                | "toPrimitive"
                | "toStringTag"
                | "unscopables"
        ),
        _ => false,
    }
}

pub(super) fn analyze<'a>(
    program: &Program<'a>,
    identities: &SemanticIdentities,
    pure_functions: &BTreeSet<SourceLocation>,
    runtime_helpers: &BTreeMap<String, RuntimeHelper>,
    source: &str,
) -> PureOptimizationPlan {
    if pure_functions.is_empty() {
        return PureOptimizationPlan::default();
    }
    let context = PureContext {
        identities,
        runtime_helpers,
    };
    let mut cse = CseCollector {
        identities,
        pure_functions,
        context,
        source,
        active: false,
        statement_declaration: false,
        available: BTreeMap::new(),
        replacements: BTreeMap::new(),
    };
    cse.visit_program(program);

    let mut references = ReferenceCollector::new(identities);
    references.visit_program(program);
    let mut candidates = CandidateCollector {
        identities,
        pure_functions,
        context,
        active: false,
        statement_declaration: false,
        candidates: BTreeMap::new(),
    };
    candidates.visit_program(program);

    for (binding, replacement) in &cse.replacements {
        let Some(candidate) = candidates.candidates.get_mut(binding) else {
            continue;
        };
        for dependency in &candidate.original_dependencies {
            decrement(&mut references.counts, *dependency);
        }
        *references.counts.entry(replacement.0).or_default() += 1;
        candidate.dependencies = vec![replacement.0];
    }

    let mut dead_bindings = BTreeSet::new();
    let mut queue: VecDeque<_> = candidates
        .candidates
        .keys()
        .filter(|binding| references.counts.get(binding).copied().unwrap_or(0) == 0)
        .copied()
        .collect();
    while let Some(binding) = queue.pop_front() {
        if !dead_bindings.insert(binding) {
            continue;
        }
        let Some(candidate) = candidates.candidates.get(&binding) else {
            continue;
        };
        for dependency in &candidate.dependencies {
            if decrement(&mut references.counts, *dependency) == 0
                && candidates.candidates.contains_key(dependency)
            {
                queue.push_back(*dependency);
            }
        }
    }
    PureOptimizationPlan {
        dead_bindings,
        cse_replacements: cse
            .replacements
            .into_iter()
            .map(|(binding, (_, name))| (binding, name))
            .collect(),
    }
}

fn decrement(counts: &mut BTreeMap<BindingId, usize>, binding: BindingId) -> usize {
    let count = counts.entry(binding).or_default();
    *count = count.saturating_sub(1);
    *count
}

struct ReferenceCollector<'identities> {
    identities: &'identities SemanticIdentities,
    counts: BTreeMap<BindingId, usize>,
    references: Vec<BindingId>,
}

impl<'identities> ReferenceCollector<'identities> {
    fn new(identities: &'identities SemanticIdentities) -> Self {
        Self {
            identities,
            counts: BTreeMap::new(),
            references: Vec::new(),
        }
    }
}

impl<'a> Visit<'a> for ReferenceCollector<'_> {
    fn visit_identifier_reference(&mut self, reference: &IdentifierReference<'a>) {
        if let Some(binding) = self.identities.binding_for_reference(reference) {
            *self.counts.entry(binding).or_default() += 1;
            self.references.push(binding);
        }
    }
}

fn expression_dependencies<'a>(
    expression: &Expression<'a>,
    identities: &SemanticIdentities,
) -> Vec<BindingId> {
    let mut collector = ReferenceCollector::new(identities);
    collector.visit_expression(expression);
    collector.references
}

struct CandidateCollector<'identities, 'policy> {
    identities: &'identities SemanticIdentities,
    pure_functions: &'policy BTreeSet<SourceLocation>,
    context: PureContext<'identities>,
    active: bool,
    statement_declaration: bool,
    candidates: BTreeMap<BindingId, Candidate>,
}

impl<'a> Visit<'a> for CandidateCollector<'_, '_> {
    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        let previous = self.active;
        let previous_declaration = self.statement_declaration;
        self.active = self
            .pure_functions
            .contains(&(function.span.start, function.span.end));
        self.statement_declaration = false;
        walk::walk_function(self, function, flags);
        self.active = previous;
        self.statement_declaration = previous_declaration;
    }

    fn visit_arrow_function_expression(&mut self, function: &ArrowFunctionExpression<'a>) {
        let previous = self.active;
        let previous_declaration = self.statement_declaration;
        self.active = self
            .pure_functions
            .contains(&(function.span.start, function.span.end));
        self.statement_declaration = false;
        walk::walk_arrow_function_expression(self, function);
        self.active = previous;
        self.statement_declaration = previous_declaration;
    }

    fn visit_statement(&mut self, statement: &Statement<'a>) {
        let previous = self.statement_declaration;
        self.statement_declaration = matches!(statement, Statement::VariableDeclaration(_));
        walk::walk_statement(self, statement);
        self.statement_declaration = previous;
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if self.active
            && self.statement_declaration
            && !matches!(
                declarator.kind,
                VariableDeclarationKind::Using | VariableDeclarationKind::AwaitUsing
            )
            && let Some((binding, initializer)) = declarator_binding(declarator, self.identities)
            && licensed_pure_expression(initializer, self.context)
        {
            let dependencies = expression_dependencies(initializer, self.identities);
            self.candidates.entry(binding).or_insert(Candidate {
                original_dependencies: dependencies.clone(),
                dependencies,
            });
        }
        walk::walk_variable_declarator(self, declarator);
    }
}

struct CseCollector<'identities, 'policy, 'source> {
    identities: &'identities SemanticIdentities,
    pure_functions: &'policy BTreeSet<SourceLocation>,
    context: PureContext<'identities>,
    source: &'source str,
    active: bool,
    statement_declaration: bool,
    available: BTreeMap<String, (BindingId, String)>,
    replacements: BTreeMap<BindingId, (BindingId, String)>,
}

impl<'a> Visit<'a> for CseCollector<'_, '_, '_> {
    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        let previous_active = self.active;
        let previous_declaration = self.statement_declaration;
        let previous_available = std::mem::take(&mut self.available);
        self.active = self
            .pure_functions
            .contains(&(function.span.start, function.span.end));
        self.statement_declaration = false;
        walk::walk_function(self, function, flags);
        self.active = previous_active;
        self.statement_declaration = previous_declaration;
        self.available = previous_available;
    }

    fn visit_arrow_function_expression(&mut self, function: &ArrowFunctionExpression<'a>) {
        let previous_active = self.active;
        let previous_declaration = self.statement_declaration;
        let previous_available = std::mem::take(&mut self.available);
        self.active = self
            .pure_functions
            .contains(&(function.span.start, function.span.end));
        self.statement_declaration = false;
        walk::walk_arrow_function_expression(self, function);
        self.active = previous_active;
        self.statement_declaration = previous_declaration;
        self.available = previous_available;
    }

    fn visit_statement(&mut self, statement: &Statement<'a>) {
        if !self.active {
            walk::walk_statement(self, statement);
            return;
        }
        match statement {
            Statement::VariableDeclaration(_) => {
                let previous = self.statement_declaration;
                self.statement_declaration = true;
                walk::walk_statement(self, statement);
                self.statement_declaration = previous;
            }
            Statement::ExpressionStatement(expression) => {
                walk::walk_statement(self, statement);
                if !licensed_pure_expression(&expression.expression, self.context) {
                    self.available.clear();
                }
            }
            _ => {
                self.available.clear();
                walk::walk_statement(self, statement);
                self.available.clear();
            }
        }
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if self.active {
            if !self.statement_declaration {
                self.available.clear();
                walk::walk_variable_declarator(self, declarator);
                return;
            }
            let Some((binding, initializer)) = declarator_binding(declarator, self.identities)
            else {
                self.available.clear();
                walk::walk_variable_declarator(self, declarator);
                return;
            };
            if matches!(
                declarator.kind,
                VariableDeclarationKind::Using | VariableDeclarationKind::AwaitUsing
            ) {
                self.available.clear();
                walk::walk_variable_declarator(self, declarator);
                return;
            }
            if let Some(key) = cse_key(initializer, self.context, self.identities, self.source) {
                if let Some(canonical) = self.available.get(&key).cloned() {
                    self.replacements.insert(binding, canonical);
                } else if let BindingPattern::BindingIdentifier(identifier) = &declarator.id {
                    self.available
                        .insert(key, (binding, identifier.name.to_string()));
                }
            } else if !licensed_pure_expression(initializer, self.context) {
                self.available.clear();
            }
        }
        walk::walk_variable_declarator(self, declarator);
    }
}

fn declarator_binding<'a>(
    declarator: &'a VariableDeclarator<'a>,
    identities: &SemanticIdentities,
) -> Option<(BindingId, &'a Expression<'a>)> {
    let BindingPattern::BindingIdentifier(identifier) = &declarator.id else {
        return None;
    };
    let binding = identifier
        .symbol_id
        .get()
        .and_then(|symbol| identities.binding_for_symbol(symbol))?;
    Some((binding, declarator.init.as_ref()?))
}

fn cse_key<'a>(
    expression: &Expression<'a>,
    context: PureContext<'_>,
    identities: &SemanticIdentities,
    source: &str,
) -> Option<String> {
    if !licensed_cse_expression(expression, context) {
        return None;
    }
    match expression.get_inner_expression() {
        Expression::CallExpression(call)
            if call
                .arguments
                .iter()
                .all(|argument| argument.as_expression().is_some()) => {}
        Expression::StaticMemberExpression(_) | Expression::ComputedMemberExpression(_) => {}
        Expression::ChainExpression(chain)
            if matches!(
                &chain.expression,
                ChainElement::CallExpression(call)
                    if call.arguments.iter().all(|argument| argument.as_expression().is_some())
            ) || chain.expression.as_member_expression().is_some() => {}
        _ => return None,
    }
    Some(expression_fingerprint(expression, identities, source))
}

fn expression_fingerprint(
    expression: &Expression<'_>,
    identities: &SemanticIdentities,
    source: &str,
) -> String {
    let expression = expression.get_inner_expression();
    match expression {
        Expression::Identifier(identifier) => {
            identities.binding_for_reference(identifier).map_or_else(
                || format!("global:{}", identifier.name),
                |binding| format!("binding:{}", binding.index()),
            )
        }
        Expression::BooleanLiteral(boolean) => format!("boolean:{}", boolean.value),
        Expression::NullLiteral(_) => "null".to_owned(),
        Expression::NumericLiteral(number) => format!("number:{:016x}", number.value.to_bits()),
        Expression::BigIntLiteral(bigint) => length_prefixed("bigint", bigint.value.as_str()),
        Expression::StringLiteral(string) => length_prefixed("string", string.value.as_str()),
        Expression::StaticMemberExpression(_)
        | Expression::ComputedMemberExpression(_)
        | Expression::PrivateFieldExpression(_) => {
            member_fingerprint(expression.to_member_expression(), identities, source)
        }
        Expression::CallExpression(call) => call_fingerprint(call, identities, source),
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::CallExpression(call) => {
                format!("chain:{}", call_fingerprint(call, identities, source))
            }
            ChainElement::TSNonNullExpression(wrapper) => format!(
                "chain-non-null:{}",
                expression_fingerprint(&wrapper.expression, identities, source)
            ),
            _ => format!(
                "chain:{}",
                member_fingerprint(chain.expression.to_member_expression(), identities, source,)
            ),
        },
        Expression::TemplateLiteral(template) => format!(
            "template:{}:{}",
            template
                .quasis
                .iter()
                .map(|quasi| length_prefixed(
                    "quasi",
                    quasi
                        .value
                        .cooked
                        .map_or_else(|| quasi.value.raw.as_str(), |cooked| cooked.as_str(),)
                ))
                .collect::<Vec<_>>()
                .join("|"),
            template
                .expressions
                .iter()
                .map(|expression| expression_fingerprint(expression, identities, source))
                .collect::<Vec<_>>()
                .join("|")
        ),
        Expression::UnaryExpression(unary) => format!(
            "unary:{:?}:{}",
            unary.operator,
            expression_fingerprint(&unary.argument, identities, source)
        ),
        Expression::BinaryExpression(binary) => format!(
            "binary:{:?}:{}:{}",
            binary.operator,
            expression_fingerprint(&binary.left, identities, source),
            expression_fingerprint(&binary.right, identities, source)
        ),
        Expression::LogicalExpression(logical) => format!(
            "logical:{:?}:{}:{}",
            logical.operator,
            expression_fingerprint(&logical.left, identities, source),
            expression_fingerprint(&logical.right, identities, source)
        ),
        Expression::ConditionalExpression(conditional) => format!(
            "conditional:{}:{}:{}",
            expression_fingerprint(&conditional.test, identities, source),
            expression_fingerprint(&conditional.consequent, identities, source),
            expression_fingerprint(&conditional.alternate, identities, source)
        ),
        Expression::SequenceExpression(sequence) => format!(
            "sequence:{}",
            sequence
                .expressions
                .iter()
                .map(|expression| expression_fingerprint(expression, identities, source))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Expression::Super(_) => "super".to_owned(),
        Expression::ThisExpression(_) => "this".to_owned(),
        _ => source_fragment(expression.span(), source),
    }
}

fn member_fingerprint(
    member: &MemberExpression<'_>,
    identities: &SemanticIdentities,
    source: &str,
) -> String {
    match member {
        MemberExpression::StaticMemberExpression(member) => format!(
            "static:{}:{}:{}",
            member.optional,
            expression_fingerprint(&member.object, identities, source),
            member.property.name
        ),
        MemberExpression::ComputedMemberExpression(member) => format!(
            "computed:{}:{}:{}",
            member.optional,
            expression_fingerprint(&member.object, identities, source),
            expression_fingerprint(&member.expression, identities, source)
        ),
        MemberExpression::PrivateFieldExpression(member) => format!(
            "private:{}:{}:{}",
            member.optional,
            expression_fingerprint(&member.object, identities, source),
            member.field.name
        ),
    }
}

fn call_fingerprint(
    call: &CallExpression<'_>,
    identities: &SemanticIdentities,
    source: &str,
) -> String {
    format!(
        "call:{}:{}({})",
        call.optional,
        expression_fingerprint(&call.callee, identities, source),
        call.arguments
            .iter()
            .filter_map(|argument| argument.as_expression())
            .map(|argument| expression_fingerprint(argument, identities, source))
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn length_prefixed(kind: &str, value: &str) -> String {
    format!("{kind}:{}:{value}", value.len())
}

fn source_fragment(span: Span, source: &str) -> String {
    source
        .get(span.start as usize..span.end as usize)
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

pub(super) fn rewrite<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    identities: &SemanticIdentities,
    plan: &PureOptimizationPlan,
) {
    if plan.dead_bindings.is_empty() && plan.cse_replacements.is_empty() {
        return;
    }
    PureRewriter {
        allocator,
        identities,
        plan,
    }
    .visit_program(program);
}

struct PureRewriter<'a, 'identities, 'plan> {
    allocator: &'a Allocator,
    identities: &'identities SemanticIdentities,
    plan: &'plan PureOptimizationPlan,
}

impl<'a> VisitMut<'a> for PureRewriter<'a, '_, '_> {
    fn visit_statements(&mut self, statements: &mut ArenaVec<'a, Statement<'a>>) {
        let authored = statements.take_in(&self.allocator);
        let mut rewritten = ArenaVec::new_in(&self.allocator);
        for mut statement in authored {
            self.visit_statement(&mut statement);
            if matches!(
                &statement,
                Statement::VariableDeclaration(declaration) if declaration.declarations.is_empty()
            ) {
                continue;
            }
            rewritten.push(statement);
        }
        *statements = rewritten;
    }

    fn visit_variable_declaration(&mut self, declaration: &mut VariableDeclaration<'a>) {
        let authored = declaration.declarations.take_in(&self.allocator);
        let mut rewritten = ArenaVec::new_in(&self.allocator);
        for mut declarator in authored {
            let binding =
                declarator_binding(&declarator, self.identities).map(|(binding, _)| binding);
            if binding.is_some_and(|binding| self.plan.dead_bindings.contains(&binding)) {
                continue;
            }
            if let Some(name) = binding.and_then(|binding| self.plan.cse_replacements.get(&binding))
            {
                let span = declarator
                    .init
                    .as_ref()
                    .map_or(declarator.span, |initializer| initializer.span());
                declarator.init = Some(Expression::new_identifier(
                    span,
                    self.allocator.alloc_str(name),
                    &AstBuilder::new(self.allocator),
                ));
            } else {
                walk_mut::walk_variable_declarator(self, &mut declarator);
            }
            rewritten.push(declarator);
        }
        declaration.declarations = rewritten;
    }
}
