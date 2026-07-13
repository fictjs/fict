use std::collections::BTreeSet;

use fict_diagnostics::SourceSpan;
use oxc::{
    ast::ast::{Expression, JSXAttribute, JSXAttributeName, JSXAttributeValue, Program},
    ast_visit::{Visit, walk::walk_jsx_attribute},
};

use super::source_span;

/// Return non-event, non-ref JSX attributes whose authored value directly produces an inline
/// function. This mirrors the legacy shallow shape check: object/array/call contents are not
/// recursively classified, and only the final sequence expression value determines the prop.
pub(super) fn collect(program: &Program<'_>) -> Vec<SourceSpan> {
    let mut collector = InlineFunctionPropCollector {
        spans: BTreeSet::new(),
    };
    collector.visit_program(program);
    collector.spans.into_iter().collect()
}

struct InlineFunctionPropCollector {
    spans: BTreeSet<SourceSpan>,
}

impl<'a> Visit<'a> for InlineFunctionPropCollector {
    fn visit_jsx_attribute(&mut self, attribute: &JSXAttribute<'a>) {
        let JSXAttributeName::Identifier(name) = &attribute.name else {
            walk_jsx_attribute(self, attribute);
            return;
        };
        let name = name.name.as_str();
        let event = name.strip_prefix("on").is_some_and(|suffix| {
            suffix
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_uppercase())
        });
        if name != "ref"
            && !event
            && let Some(JSXAttributeValue::ExpressionContainer(container)) = &attribute.value
            && let Some(expression) = container.expression.as_expression()
            && expression_contains_inline_function(expression)
        {
            self.spans.insert(source_span(attribute.span));
        }
        walk_jsx_attribute(self, attribute);
    }
}

fn expression_contains_inline_function(expression: &Expression<'_>) -> bool {
    match expression.get_inner_expression() {
        Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => true,
        Expression::ConditionalExpression(conditional) => {
            expression_contains_inline_function(&conditional.consequent)
                || expression_contains_inline_function(&conditional.alternate)
        }
        Expression::LogicalExpression(logical) => {
            expression_contains_inline_function(&logical.left)
                || expression_contains_inline_function(&logical.right)
        }
        Expression::SequenceExpression(sequence) => sequence
            .expressions
            .last()
            .is_some_and(expression_contains_inline_function),
        _ => false,
    }
}
