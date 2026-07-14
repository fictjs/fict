use std::collections::BTreeSet;

use fict_diagnostics::SourceSpan;
use oxc::{
    ast::ast::{
        ArrowFunctionExpression, AssignmentExpression, AssignmentTarget,
        AssignmentTargetMaybeDefault, AssignmentTargetProperty, Function, JSXChild, JSXElement,
        JSXFragment, Program, SimpleAssignmentTarget, UpdateExpression,
    },
    ast_visit::{
        Visit,
        walk::{
            walk_assignment_expression, walk_jsx_element, walk_jsx_fragment, walk_update_expression,
        },
    },
    semantic::Scoping,
    syntax::{scope::ScopeFlags, symbol::SymbolId},
};

use super::{
    assignment_target_symbol, expression_root_symbol, simple_assignment_target_symbol, source_span,
};

/// Return one diagnostic span per JSX child container that writes a binding-resolved reactive
/// root. Attribute expressions are deliberately excluded: event/ref/property lowering owns those
/// execution boundaries. Nested functions and nested JSX are also excluded from the current
/// container and are visited independently at their own JSX child boundary.
pub(super) fn collect(
    program: &Program<'_>,
    scoping: &Scoping,
    reactive_symbols: &BTreeSet<SymbolId>,
) -> Vec<SourceSpan> {
    let mut collector = JsxChildWriteCollector {
        scoping,
        reactive_symbols,
        spans: BTreeSet::new(),
    };
    collector.visit_program(program);
    collector.spans.into_iter().collect()
}

struct JsxChildWriteCollector<'semantic, 'reactive> {
    scoping: &'semantic Scoping,
    reactive_symbols: &'reactive BTreeSet<SymbolId>,
    spans: BTreeSet<SourceSpan>,
}

impl JsxChildWriteCollector<'_, '_> {
    fn check_children<'a>(&mut self, children: &[JSXChild<'a>]) {
        for child in children {
            let JSXChild::ExpressionContainer(container) = child else {
                continue;
            };
            let Some(expression) = container.expression.as_expression() else {
                continue;
            };
            let mut writes = ReactiveWriteCollector {
                scoping: self.scoping,
                reactive_symbols: self.reactive_symbols,
                found: false,
            };
            writes.visit_expression(expression);
            if writes.found {
                self.spans.insert(source_span(container.span));
            }
        }
    }
}

impl<'a> Visit<'a> for JsxChildWriteCollector<'_, '_> {
    fn visit_jsx_element(&mut self, element: &JSXElement<'a>) {
        self.check_children(&element.children);
        walk_jsx_element(self, element);
    }

    fn visit_jsx_fragment(&mut self, fragment: &JSXFragment<'a>) {
        self.check_children(&fragment.children);
        walk_jsx_fragment(self, fragment);
    }
}

struct ReactiveWriteCollector<'semantic, 'reactive> {
    scoping: &'semantic Scoping,
    reactive_symbols: &'reactive BTreeSet<SymbolId>,
    found: bool,
}

impl<'a> Visit<'a> for ReactiveWriteCollector<'_, '_> {
    fn visit_function(&mut self, _function: &Function<'a>, _flags: ScopeFlags) {}

    fn visit_arrow_function_expression(&mut self, _function: &ArrowFunctionExpression<'a>) {}

    fn visit_jsx_element(&mut self, _element: &JSXElement<'a>) {}

    fn visit_jsx_fragment(&mut self, _fragment: &JSXFragment<'a>) {}

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        if assignment_target_writes_reactive(self.scoping, &assignment.left, self.reactive_symbols)
        {
            self.found = true;
            return;
        }
        walk_assignment_expression(self, assignment);
    }

    fn visit_update_expression(&mut self, update: &UpdateExpression<'a>) {
        if simple_target_writes_reactive(self.scoping, &update.argument, self.reactive_symbols) {
            self.found = true;
            return;
        }
        walk_update_expression(self, update);
    }
}

fn assignment_target_writes_reactive(
    scoping: &Scoping,
    target: &AssignmentTarget<'_>,
    reactive_symbols: &BTreeSet<SymbolId>,
) -> bool {
    if assignment_target_symbol(scoping, target)
        .is_some_and(|(symbol, _)| reactive_symbols.contains(&symbol))
    {
        return true;
    }
    if target.get_expression().is_some_and(|expression| {
        expression_root_symbol(scoping, expression)
            .is_some_and(|symbol| reactive_symbols.contains(&symbol))
    }) {
        return true;
    }
    match target {
        AssignmentTarget::ArrayAssignmentTarget(array) => {
            array.elements.iter().flatten().any(|element| {
                maybe_default_target_writes_reactive(scoping, element, reactive_symbols)
            }) || array.rest.as_ref().is_some_and(|rest| {
                assignment_target_writes_reactive(scoping, &rest.target, reactive_symbols)
            })
        }
        AssignmentTarget::ObjectAssignmentTarget(object) => {
            object.properties.iter().any(|property| match property {
                AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(property) => property
                    .binding
                    .reference_id
                    .get()
                    .and_then(|reference| scoping.get_reference(reference).symbol_id())
                    .is_some_and(|symbol| reactive_symbols.contains(&symbol)),
                AssignmentTargetProperty::AssignmentTargetPropertyProperty(property) => {
                    maybe_default_target_writes_reactive(
                        scoping,
                        &property.binding,
                        reactive_symbols,
                    )
                }
            }) || object.rest.as_ref().is_some_and(|rest| {
                assignment_target_writes_reactive(scoping, &rest.target, reactive_symbols)
            })
        }
        _ => false,
    }
}

fn maybe_default_target_writes_reactive(
    scoping: &Scoping,
    target: &AssignmentTargetMaybeDefault<'_>,
    reactive_symbols: &BTreeSet<SymbolId>,
) -> bool {
    if let Some(target) = target.as_assignment_target() {
        return assignment_target_writes_reactive(scoping, target, reactive_symbols);
    }
    match target {
        AssignmentTargetMaybeDefault::AssignmentTargetWithDefault(default) => {
            assignment_target_writes_reactive(scoping, &default.binding, reactive_symbols)
        }
        _ => false,
    }
}

fn simple_target_writes_reactive(
    scoping: &Scoping,
    target: &SimpleAssignmentTarget<'_>,
    reactive_symbols: &BTreeSet<SymbolId>,
) -> bool {
    simple_assignment_target_symbol(scoping, target)
        .is_some_and(|(symbol, _)| reactive_symbols.contains(&symbol))
        || target.get_expression().is_some_and(|expression| {
            expression_root_symbol(scoping, expression)
                .is_some_and(|symbol| reactive_symbols.contains(&symbol))
        })
}
