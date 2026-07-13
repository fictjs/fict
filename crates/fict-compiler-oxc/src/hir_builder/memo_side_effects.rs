use std::collections::BTreeSet;

use fict_diagnostics::SourceSpan;
use oxc::{
    ast::ast::{
        AccessorProperty, Argument, ArrayExpressionElement, ArrowFunctionExpression,
        CallExpression, Class, ClassElement, Expression, Function, ObjectPropertyKind, Program,
        PropertyDefinition,
    },
    ast_visit::{Visit, walk::walk_call_expression},
    semantic::{Scoping, SymbolId},
    syntax::{operator::UnaryOperator, scope::ScopeFlags},
};

use super::source_span;

const PURE_CALLS: &[&str] = &[
    "JSON.stringify",
    "JSON.parse",
    "Object.keys",
    "Object.values",
    "Object.entries",
    "Object.isFrozen",
    "Object.isSealed",
    "Object.isExtensible",
    "Object.getOwnPropertyNames",
    "Object.getOwnPropertyDescriptor",
    "Object.getPrototypeOf",
    "Array.isArray",
    "Array.from",
    "Array.of",
    "Math.abs",
    "Math.ceil",
    "Math.floor",
    "Math.round",
    "Math.max",
    "Math.min",
    "Math.pow",
    "Math.sqrt",
    "Math.sin",
    "Math.cos",
    "Math.tan",
    "Math.log",
    "Math.exp",
    "Math.sign",
    "Math.trunc",
    "String",
    "Number",
    "Boolean",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    "typeof",
    "Date.now",
    "Date.parse",
];

const EFFECTFUL_CALLS: &[&str] = &[
    "$effect",
    "render",
    "fetch",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "requestAnimationFrame",
    "cancelAnimationFrame",
];

const USER_CODE_INVOKING_BUILTINS: &[&str] = &[
    "JSON.parse",
    "JSON.stringify",
    "Object.values",
    "Object.entries",
    "Array.from",
    "String",
    "Number",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
];

const MUTATING_MEMBER_PROPERTIES: &[&str] = &[
    "push",
    "pop",
    "splice",
    "shift",
    "unshift",
    "sort",
    "reverse",
    "set",
    "add",
    "delete",
    "append",
    "appendChild",
    "remove",
    "removeChild",
    "setAttribute",
    "dispatchEvent",
    "replaceChildren",
    "replaceWith",
];

/// Locate imported `$memo`/`createMemo` calls whose shallow callback alternatives perform work
/// during memo evaluation. Nested closures, object methods, getters, and instance field
/// initializers are deliberately lazy; direct IIFEs, class static initialization, JSX expression
/// containers, computed keys, and callback argument expressions are eager.
pub(super) fn collect(
    program: &Program<'_>,
    scoping: &Scoping,
    memo_calls: &BTreeSet<(u32, u32)>,
) -> Vec<SourceSpan> {
    let mut collector = MemoCallCollector {
        scoping,
        memo_calls,
        spans: Vec::new(),
    };
    collector.visit_program(program);
    collector.spans
}

struct MemoCallCollector<'facts, 'semantic> {
    scoping: &'semantic Scoping,
    memo_calls: &'facts BTreeSet<(u32, u32)>,
    spans: Vec<SourceSpan>,
}

impl<'a> Visit<'a> for MemoCallCollector<'_, '_> {
    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if self.memo_calls.contains(&(call.span.start, call.span.end))
            && let Some(argument) = call.arguments.first().and_then(Argument::as_expression)
            && let Some(span) = first_side_effectful_callback(argument, self.scoping)
        {
            self.spans.push(span);
        }
        walk_call_expression(self, call);
    }
}

fn first_side_effectful_callback(
    expression: &Expression<'_>,
    scoping: &Scoping,
) -> Option<SourceSpan> {
    match expression {
        Expression::ArrowFunctionExpression(function) => {
            callback_has_side_effects_arrow(function, scoping).then(|| source_span(function.span))
        }
        Expression::FunctionExpression(function) => {
            callback_has_side_effects_function(function, scoping)
                .then(|| source_span(function.span))
        }
        Expression::SequenceExpression(sequence) => sequence
            .expressions
            .last()
            .and_then(|expression| first_side_effectful_callback(expression, scoping)),
        Expression::ConditionalExpression(conditional) => {
            first_side_effectful_callback(&conditional.consequent, scoping)
                .or_else(|| first_side_effectful_callback(&conditional.alternate, scoping))
        }
        Expression::LogicalExpression(logical) => {
            first_side_effectful_callback(&logical.left, scoping)
                .or_else(|| first_side_effectful_callback(&logical.right, scoping))
        }
        Expression::ParenthesizedExpression(wrapper) => {
            first_side_effectful_callback(&wrapper.expression, scoping)
        }
        Expression::TSAsExpression(wrapper) => {
            first_side_effectful_callback(&wrapper.expression, scoping)
        }
        Expression::TSTypeAssertion(wrapper) => {
            first_side_effectful_callback(&wrapper.expression, scoping)
        }
        Expression::TSNonNullExpression(wrapper) => {
            first_side_effectful_callback(&wrapper.expression, scoping)
        }
        Expression::TSSatisfiesExpression(wrapper) => {
            first_side_effectful_callback(&wrapper.expression, scoping)
        }
        _ => None,
    }
}

fn callback_has_side_effects_arrow(
    function: &ArrowFunctionExpression<'_>,
    scoping: &Scoping,
) -> bool {
    let mut analyzer = MemoSideEffectAnalyzer::new(scoping);
    analyzer.visit_arrow_body(function);
    analyzer.found
}

fn callback_has_side_effects_function(function: &Function<'_>, scoping: &Scoping) -> bool {
    let mut analyzer = MemoSideEffectAnalyzer::new(scoping);
    analyzer.visit_function_body_if_present(function);
    analyzer.found
}

struct MemoSideEffectAnalyzer<'semantic> {
    scoping: &'semantic Scoping,
    found: bool,
}

impl<'semantic> MemoSideEffectAnalyzer<'semantic> {
    fn new(scoping: &'semantic Scoping) -> Self {
        Self {
            scoping,
            found: false,
        }
    }

    fn visit_arrow_body(&mut self, function: &ArrowFunctionExpression<'_>) {
        if let Some(expression) = function.get_expression() {
            self.visit_expression(expression);
        } else {
            self.visit_function_body(&function.body);
        }
    }

    fn visit_function_body_if_present(&mut self, function: &Function<'_>) {
        if let Some(body) = &function.body {
            self.visit_function_body(body);
        }
    }

    fn visit_argument(&mut self, argument: &Argument<'_>) {
        if self.found {
            return;
        }
        if let Some(expression) = argument.as_expression() {
            self.visit_expression(expression);
        } else if let Argument::SpreadElement(spread) = argument {
            self.visit_expression(&spread.argument);
        }
    }

    fn visit_direct_iife(&mut self, callee: &Expression<'_>) -> bool {
        match callee.get_inner_expression() {
            Expression::ArrowFunctionExpression(function) => {
                self.visit_arrow_body(function);
                true
            }
            Expression::FunctionExpression(function) => {
                self.visit_function_body_if_present(function);
                true
            }
            _ => false,
        }
    }

    fn root_symbol(&self, callee: &Expression<'_>) -> Option<SymbolId> {
        let identifier = match callee.get_inner_expression() {
            Expression::Identifier(identifier) => identifier.as_ref(),
            Expression::StaticMemberExpression(member) => {
                let Expression::Identifier(identifier) = member.object.get_inner_expression()
                else {
                    return None;
                };
                identifier.as_ref()
            }
            _ => return None,
        };
        identifier
            .reference_id
            .get()
            .and_then(|reference| self.scoping.get_reference(reference).symbol_id())
    }

    fn call_name(&self, callee: &Expression<'_>) -> Option<String> {
        match callee.get_inner_expression() {
            Expression::Identifier(identifier) => Some(identifier.name.to_string()),
            Expression::StaticMemberExpression(member) => {
                let Expression::Identifier(object) = member.object.get_inner_expression() else {
                    return None;
                };
                Some(format!("{}.{}", object.name, member.property.name))
            }
            _ => None,
        }
    }

    fn is_effectful_call(&self, call: &CallExpression<'_>) -> bool {
        let Some(name) = self.call_name(&call.callee) else {
            return true;
        };
        if PURE_CALLS.contains(&name.as_str()) && self.root_symbol(&call.callee).is_some() {
            return true;
        }
        if self.is_user_code_invoking_builtin(&name, call) {
            return true;
        }
        if PURE_CALLS.contains(&name.as_str()) {
            return false;
        }
        if EFFECTFUL_CALLS.contains(&name.as_str())
            || name.starts_with("console.")
            || name.starts_with("document.")
            || name.starts_with("window.")
        {
            return true;
        }
        if let Expression::StaticMemberExpression(member) = call.callee.get_inner_expression() {
            let property = member.property.name.as_str();
            if MUTATING_MEMBER_PROPERTIES.contains(&property) {
                return true;
            }
            if matches!(
                member.object.get_inner_expression(),
                Expression::Identifier(object)
                    if matches!(object.name.as_str(), "document" | "window")
            ) {
                return true;
            }
        }
        false
    }

    fn is_user_code_invoking_builtin(&self, name: &str, call: &CallExpression<'_>) -> bool {
        if !USER_CODE_INVOKING_BUILTINS.contains(&name) {
            return false;
        }
        if call
            .arguments
            .iter()
            .any(|argument| matches!(argument, Argument::SpreadElement(_)))
        {
            return true;
        }
        let arguments = call
            .arguments
            .iter()
            .filter_map(Argument::as_expression)
            .collect::<Vec<_>>();
        match name {
            "JSON.parse" => arguments.get(1).is_some(),
            "JSON.stringify" => arguments
                .iter()
                .any(|argument| !is_plain_memo_data_value(argument)),
            "Object.values" | "Object.entries" => arguments
                .first()
                .is_some_and(|source| !is_plain_memo_data_value(source)),
            "Array.from" => {
                arguments.get(1).is_some()
                    || arguments
                        .first()
                        .is_some_and(|source| !is_plain_array_from_source(source))
            }
            "String" | "Number" | "parseInt" | "parseFloat" | "isNaN" | "isFinite" => arguments
                .iter()
                .any(|argument| !is_plain_primitive_memo_value(argument)),
            _ => false,
        }
    }

    fn visit_class_property(&mut self, property: &PropertyDefinition<'_>) {
        self.visit_decorators(&property.decorators);
        if property.computed {
            self.visit_property_key(&property.key);
        }
        if property.r#static
            && let Some(value) = &property.value
        {
            self.visit_expression(value);
        }
    }

    fn visit_class_accessor(&mut self, property: &AccessorProperty<'_>) {
        self.visit_decorators(&property.decorators);
        if property.computed {
            self.visit_property_key(&property.key);
        }
        if property.r#static
            && let Some(value) = &property.value
        {
            self.visit_expression(value);
        }
    }
}

impl<'a> Visit<'a> for MemoSideEffectAnalyzer<'_> {
    fn visit_function(&mut self, _function: &Function<'a>, _flags: ScopeFlags) {
        // Nested functions are lazy. Direct IIFEs are entered explicitly from the call visitor.
    }

    fn visit_arrow_function_expression(&mut self, _function: &ArrowFunctionExpression<'a>) {
        // Nested functions are lazy. Direct IIFEs are entered explicitly from the call visitor.
    }

    fn visit_assignment_expression(
        &mut self,
        _expression: &oxc::ast::ast::AssignmentExpression<'a>,
    ) {
        self.found = true;
    }

    fn visit_update_expression(&mut self, _expression: &oxc::ast::ast::UpdateExpression<'a>) {
        self.found = true;
    }

    fn visit_await_expression(&mut self, _expression: &oxc::ast::ast::AwaitExpression<'a>) {
        self.found = true;
    }

    fn visit_new_expression(&mut self, _expression: &oxc::ast::ast::NewExpression<'a>) {
        self.found = true;
    }

    fn visit_throw_statement(&mut self, _statement: &oxc::ast::ast::ThrowStatement<'a>) {
        self.found = true;
    }

    fn visit_unary_expression(&mut self, expression: &oxc::ast::ast::UnaryExpression<'a>) {
        if expression.operator == UnaryOperator::Delete {
            self.found = true;
        } else {
            self.visit_expression(&expression.argument);
        }
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if self.found {
            return;
        }
        self.visit_expression(&call.callee);
        for argument in &call.arguments {
            self.visit_argument(argument);
        }
        if self.found {
            return;
        }
        if self.visit_direct_iife(&call.callee) {
            return;
        }
        self.found = self.is_effectful_call(call);
    }

    fn visit_class(&mut self, class: &Class<'a>) {
        if self.found {
            return;
        }
        self.visit_decorators(&class.decorators);
        if let Some(super_class) = &class.super_class {
            self.visit_expression(super_class);
        }
        for element in &class.body.body {
            if self.found {
                return;
            }
            match element {
                ClassElement::StaticBlock(block) => {
                    for statement in &block.body {
                        self.visit_statement(statement);
                    }
                }
                ClassElement::MethodDefinition(method) => {
                    self.visit_decorators(&method.decorators);
                    if method.computed {
                        self.visit_property_key(&method.key);
                    }
                }
                ClassElement::PropertyDefinition(property) => {
                    self.visit_class_property(property);
                }
                ClassElement::AccessorProperty(property) => {
                    self.visit_class_accessor(property);
                }
                ClassElement::TSIndexSignature(_) => {}
            }
        }
    }
}

fn unwrap_static_memo_value<'node, 'ast>(
    mut expression: &'node Expression<'ast>,
) -> &'node Expression<'ast> {
    loop {
        expression = match expression {
            Expression::ParenthesizedExpression(wrapper) => &wrapper.expression,
            Expression::TSAsExpression(wrapper) => &wrapper.expression,
            Expression::TSTypeAssertion(wrapper) => &wrapper.expression,
            Expression::TSNonNullExpression(wrapper) => &wrapper.expression,
            _ => return expression,
        };
    }
}

fn is_plain_primitive_memo_value(expression: &Expression<'_>) -> bool {
    match unwrap_static_memo_value(expression) {
        Expression::StringLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_)
        | Expression::BigIntLiteral(_) => true,
        Expression::UnaryExpression(unary)
            if matches!(
                unary.operator,
                UnaryOperator::UnaryPlus
                    | UnaryOperator::UnaryNegation
                    | UnaryOperator::LogicalNot
                    | UnaryOperator::BitwiseNot
                    | UnaryOperator::Void
            ) =>
        {
            is_plain_primitive_memo_value(&unary.argument)
        }
        _ => false,
    }
}

fn is_plain_memo_data_value(expression: &Expression<'_>) -> bool {
    let expression = unwrap_static_memo_value(expression);
    if is_plain_primitive_memo_value(expression) {
        return true;
    }
    match expression {
        Expression::ArrayExpression(array) => array.elements.iter().all(|element| match element {
            ArrayExpressionElement::Elision(_) => true,
            ArrayExpressionElement::SpreadElement(_) => false,
            _ => element
                .as_expression()
                .is_some_and(is_plain_memo_data_value),
        }),
        Expression::ObjectExpression(object) => object.properties.iter().all(|property| {
            let ObjectPropertyKind::ObjectProperty(property) = property else {
                return false;
            };
            !property.computed && is_plain_memo_data_value(&property.value)
        }),
        _ => false,
    }
}

fn is_plain_array_from_source(expression: &Expression<'_>) -> bool {
    match unwrap_static_memo_value(expression) {
        Expression::StringLiteral(_) => true,
        Expression::ArrayExpression(array) => array.elements.iter().all(|element| match element {
            ArrayExpressionElement::Elision(_) => true,
            ArrayExpressionElement::SpreadElement(_) => false,
            _ => element
                .as_expression()
                .is_some_and(is_plain_memo_data_value),
        }),
        _ => false,
    }
}
