//! Conservative storage/return boundaries for mutable runtime factory containers.

use super::*;

pub(super) fn collect(
    program: &Program<'_>,
    scoping: &Scoping,
    aliases: &StaticHookAliases,
    exports: &[ModuleExport],
) -> BTreeSet<StaticAliasPath> {
    let mut collector = Exposures {
        scoping,
        paths: aliases.externally_stored_value_paths.clone(),
        exported: exports
            .iter()
            .filter_map(|export| match export {
                ModuleExport::Local {
                    target: ModuleLocalExport::Binding(binding),
                    ..
                } => Some(SymbolId::from_usize(binding.as_usize())),
                _ => None,
            })
            .collect(),
    };
    collector.paths.extend(
        collector
            .exported
            .iter()
            .copied()
            .map(StaticAliasPath::root),
    );
    collector.visit_program(program);
    let mut exposed = collector.paths;
    let mut pending = VecDeque::from_iter(exposed.iter().cloned());
    while let Some(path) = pending.pop_front() {
        let resolved = aliases.resolve(&path);
        if exposed.insert(resolved.clone()) {
            pending.push_back(resolved);
        }
        for (target, source) in &aliases.aliases {
            if target.starts_with(&path) && exposed.insert(source.clone()) {
                pending.push_back(source.clone());
            }
        }
    }
    exposed
}

struct Exposures<'a> {
    scoping: &'a Scoping,
    paths: BTreeSet<StaticAliasPath>,
    exported: BTreeSet<SymbolId>,
}

impl Exposures<'_> {
    fn value(&mut self, expression: &Expression<'_>) {
        if let Some(path) = static_alias_source_path(self.scoping, expression) {
            self.paths.insert(path);
            return;
        }
        match expression.get_inner_expression() {
            Expression::ObjectExpression(object) => {
                for property in &object.properties {
                    match property {
                        OxcObjectPropertyKind::ObjectProperty(property) => {
                            self.value(&property.value)
                        }
                        OxcObjectPropertyKind::SpreadProperty(spread) => {
                            self.value(&spread.argument)
                        }
                    }
                }
            }
            Expression::ArrayExpression(array) => {
                for element in &array.elements {
                    match element {
                        ArrayExpressionElement::Elision(_) => {}
                        ArrayExpressionElement::SpreadElement(spread) => {
                            self.value(&spread.argument)
                        }
                        element => self.value(element.to_expression()),
                    }
                }
            }
            Expression::ConditionalExpression(expression) => {
                self.value(&expression.consequent);
                self.value(&expression.alternate);
            }
            Expression::LogicalExpression(expression) => {
                self.value(&expression.left);
                self.value(&expression.right);
            }
            Expression::SequenceExpression(expression) => {
                if let Some(value) = expression.expressions.last() {
                    self.value(value);
                }
            }
            Expression::AssignmentExpression(expression) => self.value(&expression.right),
            _ => {}
        }
    }
}

impl<'a> Visit<'a> for Exposures<'_> {
    fn visit_object_expression(&mut self, object: &ObjectExpression<'a>) {
        // Nested object storage retains the old value even if a later property
        // write removes it from the final alias inventory. This proof deliberately
        // accepts direct aliases only, not borrowed mutable containers.
        for property in &object.properties {
            match property {
                OxcObjectPropertyKind::ObjectProperty(property) => self.value(&property.value),
                OxcObjectPropertyKind::SpreadProperty(spread) => self.value(&spread.argument),
            }
        }
        oxc::ast_visit::walk::walk_object_expression(self, object);
    }

    fn visit_array_expression(&mut self, array: &ArrayExpression<'a>) {
        for element in &array.elements {
            match element {
                ArrayExpressionElement::Elision(_) => {}
                ArrayExpressionElement::SpreadElement(spread) => self.value(&spread.argument),
                element => self.value(element.to_expression()),
            }
        }
        oxc::ast_visit::walk::walk_array_expression(self, array);
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if let BindingPattern::BindingIdentifier(binding) = &declarator.id
            && binding.symbol_id.get().is_some_and(|symbol| {
                self.exported.contains(&symbol) || self.scoping.symbol_is_mutated(symbol)
            })
            && let Some(value) = &declarator.init
        {
            self.value(value);
        }
        walk_variable_declarator(self, declarator);
    }

    fn visit_export_default_declaration(
        &mut self,
        declaration: &oxc::ast::ast::ExportDefaultDeclaration<'a>,
    ) {
        if let Some(value) = declaration.declaration.as_expression() {
            self.value(value);
        }
        oxc::ast_visit::walk::walk_export_default_declaration(self, declaration);
    }

    fn visit_return_statement(&mut self, statement: &ReturnStatement<'a>) {
        if let Some(value) = &statement.argument {
            self.value(value);
        }
        walk_return_statement(self, statement);
    }

    fn visit_throw_statement(&mut self, statement: &oxc::ast::ast::ThrowStatement<'a>) {
        self.value(&statement.argument);
        oxc::ast_visit::walk::walk_throw_statement(self, statement);
    }

    fn visit_yield_expression(&mut self, expression: &oxc::ast::ast::YieldExpression<'a>) {
        if let Some(value) = &expression.argument {
            self.value(value);
        }
        oxc::ast_visit::walk::walk_yield_expression(self, expression);
    }

    fn visit_property_definition(&mut self, property: &PropertyDefinition<'a>) {
        if let Some(value) = &property.value {
            self.value(value);
        }
        oxc::ast_visit::walk::walk_property_definition(self, property);
    }

    fn visit_accessor_property(&mut self, property: &AccessorProperty<'a>) {
        if let Some(value) = &property.value {
            self.value(value);
        }
        oxc::ast_visit::walk::walk_accessor_property(self, property);
    }

    fn visit_arrow_function_expression(&mut self, function: &ArrowFunctionExpression<'a>) {
        if function.expression
            && let Some(Statement::ExpressionStatement(statement)) =
                function.body.statements.first()
        {
            self.value(&statement.expression);
        }
        walk_arrow_function_expression(self, function);
    }

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        // A stored object may be observed by a caller even when the final alias
        // inventory no longer contains that earlier container value.
        self.value(&assignment.right);
        oxc::ast_visit::walk::walk_assignment_expression(self, assignment);
    }

    fn visit_jsx_expression_container(
        &mut self,
        container: &oxc::ast::ast::JSXExpressionContainer<'a>,
    ) {
        if let Some(value) = container.expression.as_expression() {
            self.value(value);
        }
        oxc::ast_visit::walk::walk_jsx_expression_container(self, container);
    }

    fn visit_jsx_spread_attribute(&mut self, spread: &oxc::ast::ast::JSXSpreadAttribute<'a>) {
        self.value(&spread.argument);
        oxc::ast_visit::walk::walk_jsx_spread_attribute(self, spread);
    }
}
