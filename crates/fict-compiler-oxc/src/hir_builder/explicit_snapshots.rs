//! Explicit untracked value boundaries. A snapshot permission applies to the
//! synchronous callback and to proven primitive results, never to retained work.

use super::*;
use oxc::ast::ast::FunctionBody;
use oxc::ast_visit::walk::walk_variable_declarator;

type PrimitiveDependencies = BTreeSet<SymbolId>;

pub(super) struct SnapshotFacts {
    owners: BTreeSet<FunctionId>,
    primitive_symbols: BTreeSet<SymbolId>,
    primitive_calls: BTreeSet<(u32, u32)>,
    primitive_bindings: BTreeSet<SymbolId>,
}

pub(super) struct SnapshotInputs<'a> {
    pub scoping: &'a Scoping,
    pub aliases: &'a StaticHookAliases,
    pub calls: &'a BTreeMap<(u32, u32), &'a CallFact>,
    pub imports: &'a BTreeMap<BindingId, EscapeImportIdentity>,
    pub states: &'a BTreeSet<SymbolId>,
    pub immutable: &'a BTreeSet<SymbolId>,
    pub functions: &'a [HirFunction],
}

impl SnapshotFacts {
    pub(super) fn collect(program: &Program<'_>, inputs: SnapshotInputs<'_>) -> Self {
        let mut collector = SnapshotCollector {
            inputs,
            constraints: BTreeMap::new(),
            owners: BTreeSet::new(),
            calls: BTreeMap::new(),
            bindings: BTreeMap::new(),
        };
        collector.visit_program(program);
        let mut primitive_symbols = BTreeSet::new();
        loop {
            let mut changed = false;
            for (symbol, constraints) in &collector.constraints {
                if constraints.iter().all(|constraint| {
                    constraint.as_ref().is_some_and(|dependencies| {
                        dependencies
                            .iter()
                            .all(|source| primitive_symbols.contains(source))
                    })
                }) {
                    changed |= primitive_symbols.insert(*symbol);
                }
            }
            if !changed {
                break;
            }
        }
        let primitive_calls: BTreeSet<_> = collector
            .calls
            .into_iter()
            .filter_map(|(span, dependencies)| {
                dependencies
                    .iter()
                    .all(|source| primitive_symbols.contains(source))
                    .then_some(span)
            })
            .collect();
        let mut primitive_bindings = BTreeSet::new();
        loop {
            let mut changed = false;
            for (symbol, initializer) in &collector.bindings {
                if !primitive_symbols.contains(symbol) {
                    continue;
                }
                let snapshot = match initializer {
                    SnapshotInitializer::Call(span) => primitive_calls.contains(span),
                    SnapshotInitializer::Alias(source) => primitive_bindings.contains(source),
                };
                if snapshot {
                    changed |= primitive_bindings.insert(*symbol);
                }
            }
            if !changed {
                break;
            }
        }
        Self {
            owners: collector.owners,
            primitive_symbols,
            primitive_calls,
            primitive_bindings,
        }
    }

    pub(super) fn permits_argument(
        &self,
        scoping: &Scoping,
        aliases: &StaticHookAliases,
        owner: Option<FunctionId>,
        argument: EscapeArgument<'_, '_>,
    ) -> bool {
        if argument.spread {
            return false;
        }
        let expression = argument.expression.get_inner_expression();
        let span = expression.span();
        if self.primitive_calls.contains(&(span.start, span.end)) {
            return true;
        }
        if let Expression::Identifier(identifier) = expression
            && identifier_symbol(scoping, identifier)
                .is_some_and(|symbol| self.primitive_bindings.contains(&symbol))
        {
            return true;
        }
        owner.is_some_and(|owner| self.owners.contains(&owner))
            && expression_result_is_definitely_primitive(
                scoping,
                aliases,
                &self.primitive_symbols,
                expression,
            )
    }
}

enum SnapshotInitializer {
    Call((u32, u32)),
    Alias(SymbolId),
}

struct SnapshotCollector<'a> {
    inputs: SnapshotInputs<'a>,
    constraints: BTreeMap<SymbolId, Vec<Option<PrimitiveDependencies>>>,
    owners: BTreeSet<FunctionId>,
    calls: BTreeMap<(u32, u32), PrimitiveDependencies>,
    bindings: BTreeMap<SymbolId, SnapshotInitializer>,
}

impl SnapshotCollector<'_> {
    fn is_untrack(&self, call: &CallExpression<'_>) -> bool {
        self.inputs
            .calls
            .get(&(call.span.start, call.span.end))
            .and_then(|fact| fact.binding)
            .and_then(|binding| self.inputs.imports.get(&binding))
            .is_some_and(|import| {
                import.imported == "untrack"
                    && matches!(
                        import.source.as_str(),
                        "fict" | "fict/advanced" | "@fictjs/runtime" | "@fictjs/runtime/advanced"
                    )
            })
    }

    fn dependencies(&self, expression: &Expression<'_>) -> Option<PrimitiveDependencies> {
        if let Expression::CallExpression(call) = expression.get_inner_expression()
            && self.is_untrack(call)
        {
            let callback = call.arguments.first()?.as_expression()?;
            return self.callback_dependencies(callback);
        }
        expression_primitive_result_dependencies(
            self.inputs.scoping,
            self.inputs.aliases,
            expression,
        )
    }

    fn callback_dependencies(&self, callback: &Expression<'_>) -> Option<PrimitiveDependencies> {
        let body = synchronous_callback_body(callback)?;
        if let Expression::ArrowFunctionExpression(function) = callback.get_inner_expression()
            && function.expression
        {
            let [Statement::ExpressionStatement(statement)] = body.statements.as_slice() else {
                return None;
            };
            return self.dependencies(&statement.expression);
        }
        let mut returns = PrimitiveReturns {
            collector: self,
            dependencies: Some(BTreeSet::new()),
        };
        returns.visit_function_body(body);
        returns.dependencies
    }

    fn constrain(&mut self, symbol: SymbolId, dependencies: Option<PrimitiveDependencies>) {
        if self.inputs.states.contains(&symbol) || self.inputs.immutable.contains(&symbol) {
            self.constraints
                .entry(symbol)
                .or_default()
                .push(dependencies);
        }
    }
}

fn synchronous_callback_body<'node, 'ast>(
    expression: &'node Expression<'ast>,
) -> Option<&'node FunctionBody<'ast>> {
    match expression.get_inner_expression() {
        Expression::ArrowFunctionExpression(function) if !function.r#async => Some(&function.body),
        Expression::FunctionExpression(function) if !function.r#async && !function.generator => {
            function.body.as_deref()
        }
        _ => None,
    }
}

struct PrimitiveReturns<'facts, 'inputs> {
    collector: &'facts SnapshotCollector<'inputs>,
    dependencies: Option<PrimitiveDependencies>,
}

impl<'a> Visit<'a> for PrimitiveReturns<'_, '_> {
    fn visit_function(&mut self, _: &Function<'a>, _: ScopeFlags) {}
    fn visit_arrow_function_expression(&mut self, _: &ArrowFunctionExpression<'a>) {}

    fn visit_return_statement(&mut self, statement: &ReturnStatement<'a>) {
        let Some(dependencies) = self.dependencies.as_mut() else {
            return;
        };
        if let Some(argument) = &statement.argument {
            if let Some(returned) = self.collector.dependencies(argument) {
                dependencies.extend(returned);
            } else {
                self.dependencies = None;
            }
        }
    }
}

impl<'a> Visit<'a> for SnapshotCollector<'_> {
    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if let BindingPattern::BindingIdentifier(identifier) = &declarator.id
            && let Some(symbol) = identifier.symbol_id.get()
        {
            let initializer = declarator
                .init
                .as_ref()
                .map(Expression::get_inner_expression);
            let dependencies = if self.inputs.states.contains(&symbol) {
                initializer.and_then(|initializer| {
                    let Expression::CallExpression(call) = initializer else {
                        return None;
                    };
                    let fact = self.inputs.calls.get(&(call.span.start, call.span.end))?;
                    // Hook/module accessors can be written by another compilation unit.
                    if self.inputs.functions[fact.owner.as_usize()].kind != FunctionKind::Component
                    {
                        return None;
                    }
                    match call.arguments.first() {
                        None => Some(BTreeSet::new()),
                        Some(argument) => self.dependencies(argument.as_expression()?),
                    }
                })
            } else {
                initializer.and_then(|initializer| self.dependencies(initializer))
            };
            self.constrain(symbol, dependencies);
            if self.inputs.immutable.contains(&symbol) {
                let snapshot = match initializer {
                    Some(Expression::CallExpression(call)) if self.is_untrack(call) => {
                        Some(SnapshotInitializer::Call((call.span.start, call.span.end)))
                    }
                    Some(Expression::Identifier(identifier)) => {
                        identifier_symbol(self.inputs.scoping, identifier)
                            .map(SnapshotInitializer::Alias)
                    }
                    _ => None,
                };
                if let Some(snapshot) = snapshot {
                    self.bindings.insert(symbol, snapshot);
                }
            }
        }
        walk_variable_declarator(self, declarator);
    }

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        if let Some(identifier) = direct_assignment_target_identifier(&assignment.left)
            && let Some(symbol) = identifier_symbol(self.inputs.scoping, identifier)
        {
            let dependencies = match assignment.operator {
                OxcAssignmentOperator::Assign
                | OxcAssignmentOperator::LogicalOr
                | OxcAssignmentOperator::LogicalAnd
                | OxcAssignmentOperator::LogicalNullish => self.dependencies(&assignment.right),
                _ => Some(BTreeSet::new()),
            };
            self.constrain(symbol, dependencies);
        } else {
            let mut targets = Vec::new();
            collect_pattern_assignment_targets(
                self.inputs.scoping,
                &assignment.left,
                &mut targets,
                &mut Vec::new(),
            );
            for target in targets {
                self.constrain(target.symbol, None);
            }
        }
        oxc::ast_visit::walk::walk_assignment_expression(self, assignment);
    }

    fn visit_update_expression(&mut self, update: &UpdateExpression<'a>) {
        if let Some((symbol, false)) =
            simple_assignment_target_symbol(self.inputs.scoping, &update.argument)
        {
            self.constrain(symbol, Some(BTreeSet::new()));
        }
        oxc::ast_visit::walk::walk_update_expression(self, update);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if let Expression::Identifier(identifier) = call.callee.get_inner_expression()
            && let Some(symbol) = identifier_symbol(self.inputs.scoping, identifier)
            && self.inputs.states.contains(&symbol)
            && let Some(argument) = call.arguments.first()
        {
            self.constrain(
                symbol,
                argument
                    .as_expression()
                    .and_then(|expression| self.dependencies(expression)),
            );
        }
        if self.is_untrack(call)
            && let Some(callback) = call.arguments.first().and_then(Argument::as_expression)
            && synchronous_callback_body(callback).is_some()
        {
            if let Some(owner) = self
                .inputs
                .calls
                .get(&(call.span.start, call.span.end))
                .and_then(|fact| fact.callback)
            {
                self.owners.insert(owner);
            }
            if let Some(dependencies) = self.callback_dependencies(callback) {
                self.calls
                    .insert((call.span.start, call.span.end), dependencies);
            }
        }
        walk_call_expression(self, call);
    }

    fn visit_for_in_statement(&mut self, statement: &oxc::ast::ast::ForInStatement<'a>) {
        let target =
            structured_control_flow::planned_iteration_target(&statement.left, self.inputs.scoping);
        for symbol in target.assigned {
            self.constrain(symbol, Some(BTreeSet::new()));
        }
        oxc::ast_visit::walk::walk_for_in_statement(self, statement);
    }

    fn visit_for_of_statement(&mut self, statement: &oxc::ast::ast::ForOfStatement<'a>) {
        let target =
            structured_control_flow::planned_iteration_target(&statement.left, self.inputs.scoping);
        for symbol in target.assigned {
            self.constrain(symbol, None);
        }
        oxc::ast_visit::walk::walk_for_of_statement(self, statement);
    }
}
