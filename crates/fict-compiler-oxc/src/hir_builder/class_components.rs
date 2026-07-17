use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::SourceSpan;
use oxc::{
    ast::ast::{
        AssignmentExpression, AssignmentTarget, BindingPattern, Class, Expression,
        MemberExpression, ObjectExpression, ObjectPropertyKind, VariableDeclarator,
    },
    ast_visit::{
        Visit,
        walk::{walk_assignment_expression, walk_class, walk_variable_declarator},
    },
    semantic::Scoping,
    syntax::{operator::AssignmentOperator, symbol::SymbolId},
};

use super::{Builder, RawJsxName, error, identifier_symbol, source_span};

pub(super) struct ClassBindingCollector<'semantic> {
    scoping: &'semantic Scoping,
    pub(super) bindings: BTreeMap<SymbolId, SourceSpan>,
    member_paths: BTreeSet<(SymbolId, Vec<String>)>,
}

impl<'semantic> ClassBindingCollector<'semantic> {
    pub(super) fn new(scoping: &'semantic Scoping) -> Self {
        Self {
            scoping,
            bindings: BTreeMap::new(),
            member_paths: BTreeSet::new(),
        }
    }

    fn collect_object(&mut self, root: SymbolId, prefix: &[String], object: &ObjectExpression<'_>) {
        for property in &object.properties {
            let ObjectPropertyKind::ObjectProperty(property) = property else {
                continue;
            };
            let Some(key) = (!property.computed)
                .then(|| property.key.static_name())
                .flatten()
            else {
                continue;
            };
            let mut path = prefix.to_vec();
            path.push(key.into_owned());
            match property.value.get_inner_expression() {
                Expression::ClassExpression(_) => {
                    self.member_paths.insert((root, path));
                }
                Expression::ObjectExpression(object) => self.collect_object(root, &path, object),
                _ => {}
            }
        }
    }

    fn record_assignment(&mut self, assignment: &AssignmentExpression<'_>) {
        if assignment.operator != AssignmentOperator::Assign
            || !matches!(
                assignment.right.get_inner_expression(),
                Expression::ClassExpression(_)
            )
        {
            return;
        }
        if let AssignmentTarget::AssignmentTargetIdentifier(identifier) = &assignment.left
            && let Some(symbol) = identifier_symbol(self.scoping, identifier)
        {
            self.bindings.insert(symbol, source_span(assignment.span));
        } else if let Some(member) = assignment.left.as_member_expression()
            && let Some(path) = static_member_path(self.scoping, member)
        {
            self.member_paths.insert(path);
        }
    }
}

impl<'a> Visit<'a> for ClassBindingCollector<'_> {
    fn visit_class(&mut self, class: &Class<'a>) {
        if let Some(symbol) = class.id.as_ref().and_then(|id| id.symbol_id.get()) {
            self.bindings.insert(symbol, source_span(class.span));
        }
        walk_class(self, class);
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if let (BindingPattern::BindingIdentifier(binding), Some(initializer)) =
            (&declarator.id, &declarator.init)
            && let Some(symbol) = binding.symbol_id.get()
        {
            match initializer.get_inner_expression() {
                Expression::ClassExpression(class) => {
                    self.bindings.insert(symbol, source_span(class.span));
                }
                Expression::ObjectExpression(object) => self.collect_object(symbol, &[], object),
                _ => {}
            }
        }
        walk_variable_declarator(self, declarator);
    }

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        self.record_assignment(assignment);
        walk_assignment_expression(self, assignment);
    }
}

impl Builder<'_, '_> {
    pub(super) fn validate_class_components(
        &mut self,
        classes: &ClassBindingCollector<'_>,
        tags: &[(RawJsxName, SourceSpan)],
    ) {
        for (tag, span) in tags {
            let name = match tag {
                RawJsxName::Component(symbol) if classes.bindings.contains_key(symbol) => {
                    self.semantic.scoping().symbol_name(*symbol).to_owned()
                }
                RawJsxName::Member { root, properties }
                    if classes.member_paths.contains(&(*root, properties.clone())) =>
                {
                    format!(
                        "{}.{}",
                        self.semantic.scoping().symbol_name(*root),
                        properties.join(".")
                    )
                }
                _ => continue,
            };
            self.diagnostics.push(
                error(
                    "FICT-COMPONENT-CLASS",
                    "class components are not supported; Fict components must be functions",
                    *span,
                )
                .with_note(format!("class JSX component: {name}"))
                .with_help("replace the class with a function component"),
            );
        }
    }
}

fn static_member_path(
    scoping: &Scoping,
    member: &MemberExpression<'_>,
) -> Option<(SymbolId, Vec<String>)> {
    let (root, mut path) = static_expression_path(scoping, member.object())?;
    path.push(member.static_property_name()?.to_owned());
    Some((root, path))
}

fn static_expression_path(
    scoping: &Scoping,
    expression: &Expression<'_>,
) -> Option<(SymbolId, Vec<String>)> {
    match expression.get_inner_expression() {
        Expression::Identifier(identifier) => {
            Some((identifier_symbol(scoping, identifier)?, vec![]))
        }
        expression => static_member_path(scoping, expression.as_member_expression()?),
    }
}
