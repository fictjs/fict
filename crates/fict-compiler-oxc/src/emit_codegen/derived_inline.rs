use super::{DerivedCreationRewrite, emit_error, semantic_identity::SemanticIdentities};
use fict_diagnostics::{Diagnostic, GuaranteeClass, SourceSpan};
use fict_hir::BindingId;
use oxc::{
    allocator::{Allocator, CloneIn, TakeIn, Vec as ArenaVec},
    ast::ast::{
        ArrowFunctionExpression, BindingPattern, BlockStatement, CallExpression, Expression,
        Function, FunctionBody, Program, Statement, VariableDeclaration, VariableDeclarator,
    },
    ast_visit::{Visit, VisitMut, walk, walk_mut},
    span::{GetSpan, Span},
    syntax::{operator::UnaryOperator, scope::ScopeFlags},
};
use std::collections::{BTreeMap, BTreeSet};

type SourceLocation = (u32, u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LexicalSite {
    owner: Option<SourceLocation>,
    list: Option<SourceLocation>,
    statement: Option<SourceLocation>,
    statement_depth: usize,
}

struct Definition<'a> {
    site: LexicalSite,
    declarator: SourceLocation,
    replacement: Expression<'a>,
}

#[derive(Debug, Clone, Copy)]
struct ReferenceSite {
    site: LexicalSite,
    location: SourceLocation,
    accessor_call: bool,
}

struct InlineTarget<'a> {
    declarator: SourceLocation,
    reference: SourceLocation,
    replacement: Expression<'a>,
}

/// Inline a derived accessor only when its declaration and sole accessor read occupy the same
/// straight-line statement list. Generated `__*` names remain eligible when user-name inlining is
/// disabled, matching the Babel 0.28 optimizer contract.
pub(super) fn rewrite<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    identities: &SemanticIdentities,
    creations: &BTreeMap<BindingId, DerivedCreationRewrite>,
    reactive_reads: &BTreeSet<SourceLocation>,
) -> Result<BTreeSet<BindingId>, Vec<Diagnostic>> {
    let mut collector = CandidateCollector {
        allocator,
        identities,
        creations,
        reactive_reads,
        definitions: BTreeMap::new(),
        references: BTreeMap::new(),
        accessor_callees: BTreeSet::new(),
        owner: None,
        list: None,
        statement: None,
        statement_depth: 0,
    };
    collector.visit_program(program);
    let targets = collector.targets();
    if targets.is_empty() {
        return Ok(BTreeSet::new());
    }
    let expected: BTreeSet<_> = targets.keys().copied().collect();
    let mut rewriter = InlineRewriter {
        allocator,
        identities,
        targets: &targets,
        declarations: BTreeSet::new(),
        references: BTreeSet::new(),
    };
    rewriter.visit_program(program);
    if rewriter.declarations == expected && rewriter.references == expected {
        return Ok(expected);
    }
    let missing = expected
        .difference(&rewriter.declarations)
        .chain(expected.difference(&rewriter.references))
        .next()
        .copied()
        .expect("an incomplete rewrite has a missing binding");
    let target = &targets[&missing];
    Err(vec![
        emit_error(
            "FICT-OXC-EMIT-DERIVED-INLINE",
            "derived-memo inline plan did not match its declaration and sole accessor read",
            GuaranteeClass::Internal,
        )
        .with_primary_span(
            SourceSpan::new(target.declarator.0, target.declarator.1)
                .expect("ordered derived declaration span"),
        ),
    ])
}

struct CandidateCollector<'a, 'plan> {
    allocator: &'a Allocator,
    identities: &'plan SemanticIdentities,
    creations: &'plan BTreeMap<BindingId, DerivedCreationRewrite>,
    reactive_reads: &'plan BTreeSet<SourceLocation>,
    definitions: BTreeMap<BindingId, Definition<'a>>,
    references: BTreeMap<BindingId, Vec<ReferenceSite>>,
    accessor_callees: BTreeSet<(BindingId, SourceLocation)>,
    owner: Option<SourceLocation>,
    list: Option<SourceLocation>,
    statement: Option<SourceLocation>,
    statement_depth: usize,
}

impl<'a> CandidateCollector<'a, '_> {
    fn site(&self) -> LexicalSite {
        LexicalSite {
            owner: self.owner,
            list: self.list,
            statement: self.statement,
            statement_depth: self.statement_depth,
        }
    }

    fn targets(self) -> BTreeMap<BindingId, InlineTarget<'a>> {
        let mut targets = BTreeMap::new();
        for (binding, definition) in self.definitions {
            let Some([reference]) = self.references.get(&binding).map(Vec::as_slice) else {
                continue;
            };
            let Some(declaration_statement) = definition.site.statement else {
                continue;
            };
            let Some(reference_statement) = reference.site.statement else {
                continue;
            };
            if !reference.accessor_call
                || definition.site.owner != reference.site.owner
                || definition.site.list != reference.site.list
                || definition.site.statement_depth != 1
                || reference.site.statement_depth != 1
                || declaration_statement.1 > reference_statement.0
            {
                continue;
            }
            targets.insert(
                binding,
                InlineTarget {
                    declarator: definition.declarator,
                    reference: reference.location,
                    replacement: definition.replacement,
                },
            );
        }
        targets
    }

    fn collect_definition(&mut self, declarator: &VariableDeclarator<'a>) {
        if self.statement_depth != 1 {
            return;
        }
        let BindingPattern::BindingIdentifier(identifier) = &declarator.id else {
            return;
        };
        let Some(binding) = identifier
            .symbol_id
            .get()
            .and_then(|symbol| self.identities.binding_for_symbol(symbol))
        else {
            return;
        };
        let Some(creation) = self.creations.get(&binding) else {
            return;
        };
        let compiler_name = identifier.name.starts_with("__");
        if !(compiler_name && creation.inline_compiler_names
            || !compiler_name && creation.inline_user_names)
        {
            return;
        }
        let Some(initializer) = declarator.init.as_ref() else {
            return;
        };
        let Some(replacement) = derived_initializer(initializer, creation) else {
            return;
        };
        if !inlineable_expression(replacement, self.reactive_reads) {
            return;
        }
        let span = declarator.span;
        self.definitions.insert(
            binding,
            Definition {
                site: self.site(),
                declarator: (span.start, span.end),
                replacement: replacement.clone_in(self.allocator),
            },
        );
    }
}

impl<'a> Visit<'a> for CandidateCollector<'a, '_> {
    fn visit_program(&mut self, program: &Program<'a>) {
        let previous = self.list;
        self.list = Some((program.span.start, program.span.end));
        walk::walk_program(self, program);
        self.list = previous;
    }

    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        let previous = self.owner;
        self.owner = Some((function.span.start, function.span.end));
        walk::walk_function(self, function, flags);
        self.owner = previous;
    }

    fn visit_arrow_function_expression(&mut self, function: &ArrowFunctionExpression<'a>) {
        let previous = self.owner;
        self.owner = Some((function.span.start, function.span.end));
        walk::walk_arrow_function_expression(self, function);
        self.owner = previous;
    }

    fn visit_function_body(&mut self, body: &FunctionBody<'a>) {
        let previous_list = self.list;
        let previous_depth = self.statement_depth;
        self.list = Some((body.span.start, body.span.end));
        self.statement_depth = 0;
        walk::walk_function_body(self, body);
        self.list = previous_list;
        self.statement_depth = previous_depth;
    }

    fn visit_block_statement(&mut self, block: &BlockStatement<'a>) {
        let previous_list = self.list;
        let previous_depth = self.statement_depth;
        self.list = Some((block.span.start, block.span.end));
        self.statement_depth = 0;
        walk::walk_block_statement(self, block);
        self.list = previous_list;
        self.statement_depth = previous_depth;
    }

    fn visit_statement(&mut self, statement: &Statement<'a>) {
        let previous = self.statement;
        self.statement = Some(statement_location(statement));
        self.statement_depth = self.statement_depth.saturating_add(1);
        walk::walk_statement(self, statement);
        self.statement_depth = self.statement_depth.saturating_sub(1);
        self.statement = previous;
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        self.collect_definition(declarator);
        walk::walk_variable_declarator(self, declarator);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if call.arguments.is_empty()
            && let Expression::Identifier(identifier) = &call.callee
            && let Some(binding) = self.identities.binding_for_reference(identifier)
            && self.creations.contains_key(&binding)
            && self
                .reactive_reads
                .contains(&(identifier.span.start, identifier.span.end))
        {
            self.accessor_callees
                .insert((binding, (identifier.span.start, identifier.span.end)));
        }
        walk::walk_call_expression(self, call);
    }

    fn visit_identifier_reference(&mut self, identifier: &oxc::ast::ast::IdentifierReference<'a>) {
        let Some(binding) = self.identities.binding_for_reference(identifier) else {
            return;
        };
        if !self.creations.contains_key(&binding) {
            return;
        }
        let location = (identifier.span.start, identifier.span.end);
        let site = self.site();
        self.references
            .entry(binding)
            .or_default()
            .push(ReferenceSite {
                site,
                location,
                accessor_call: self.accessor_callees.contains(&(binding, location)),
            });
    }
}

struct InlineRewriter<'a, 'plan> {
    allocator: &'a Allocator,
    identities: &'plan SemanticIdentities,
    targets: &'plan BTreeMap<BindingId, InlineTarget<'a>>,
    declarations: BTreeSet<BindingId>,
    references: BTreeSet<BindingId>,
}

impl<'a> InlineRewriter<'a, '_> {
    fn remove_empty_declarations(statements: &mut ArenaVec<'a, Statement<'a>>) {
        statements.retain(|statement| {
            !matches!(
                statement,
                Statement::VariableDeclaration(declaration)
                    if declaration.declarations.is_empty()
            )
        });
    }
}

impl<'a> VisitMut<'a> for InlineRewriter<'a, '_> {
    fn visit_program(&mut self, program: &mut Program<'a>) {
        walk_mut::walk_program(self, program);
        Self::remove_empty_declarations(&mut program.body);
    }

    fn visit_function_body(&mut self, body: &mut FunctionBody<'a>) {
        walk_mut::walk_function_body(self, body);
        Self::remove_empty_declarations(&mut body.statements);
    }

    fn visit_block_statement(&mut self, block: &mut BlockStatement<'a>) {
        walk_mut::walk_block_statement(self, block);
        Self::remove_empty_declarations(&mut block.body);
    }

    fn visit_variable_declaration(&mut self, declaration: &mut VariableDeclaration<'a>) {
        let authored = declaration.declarations.take_in(&self.allocator);
        let mut retained = ArenaVec::new_in(&self.allocator);
        for mut declarator in authored {
            let matched = match &declarator.id {
                BindingPattern::BindingIdentifier(identifier) => identifier
                    .symbol_id
                    .get()
                    .and_then(|symbol| self.identities.binding_for_symbol(symbol))
                    .filter(|binding| {
                        self.targets.get(binding).is_some_and(|target| {
                            target.declarator == (declarator.span.start, declarator.span.end)
                        })
                    }),
                _ => None,
            };
            if let Some(binding) = matched {
                self.declarations.insert(binding);
                continue;
            }
            walk_mut::walk_variable_declarator(self, &mut declarator);
            retained.push(declarator);
        }
        declaration.declarations = retained;
    }

    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        let replacement = match expression {
            Expression::CallExpression(call) if call.arguments.is_empty() => {
                let Expression::Identifier(identifier) = &call.callee else {
                    walk_mut::walk_expression(self, expression);
                    return;
                };
                self.identities
                    .binding_for_reference(identifier)
                    .and_then(|binding| {
                        self.targets.get(&binding).and_then(|target| {
                            (target.reference == (identifier.span.start, identifier.span.end))
                                .then_some((binding, &target.replacement))
                        })
                    })
            }
            _ => None,
        };
        let Some((binding, replacement)) = replacement else {
            walk_mut::walk_expression(self, expression);
            return;
        };
        *expression = replacement.clone_in(self.allocator);
        self.references.insert(binding);
    }
}

fn derived_initializer<'a>(
    initializer: &'a Expression<'a>,
    creation: &DerivedCreationRewrite,
) -> Option<&'a Expression<'a>> {
    let helper = creation.rewrite.local.as_deref()?;
    let Expression::CallExpression(call) = initializer else {
        return None;
    };
    let Expression::Identifier(callee) = &call.callee else {
        return None;
    };
    if callee.name != helper {
        return None;
    }
    let getter = call.arguments.last()?.as_expression()?;
    let Expression::ArrowFunctionExpression(getter) = getter else {
        return None;
    };
    if !getter.expression || !getter.params.items.is_empty() || getter.params.rest.is_some() {
        return None;
    }
    let [Statement::ExpressionStatement(statement)] = getter.body.statements.as_slice() else {
        return None;
    };
    Some(&statement.expression)
}

fn inlineable_expression(
    expression: &Expression<'_>,
    reactive_reads: &BTreeSet<SourceLocation>,
) -> bool {
    match expression {
        Expression::BigIntLiteral(_)
        | Expression::BooleanLiteral(_)
        | Expression::Identifier(_)
        | Expression::NullLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::RegExpLiteral(_)
        | Expression::StringLiteral(_)
        | Expression::ThisExpression(_) => true,
        Expression::UnaryExpression(unary) => {
            unary.operator != UnaryOperator::Delete
                && inlineable_expression(&unary.argument, reactive_reads)
        }
        Expression::BinaryExpression(binary) => {
            inlineable_expression(&binary.left, reactive_reads)
                && inlineable_expression(&binary.right, reactive_reads)
        }
        Expression::LogicalExpression(logical) => {
            inlineable_expression(&logical.left, reactive_reads)
                && inlineable_expression(&logical.right, reactive_reads)
        }
        Expression::ConditionalExpression(conditional) => {
            inlineable_expression(&conditional.test, reactive_reads)
                && inlineable_expression(&conditional.consequent, reactive_reads)
                && inlineable_expression(&conditional.alternate, reactive_reads)
        }
        Expression::SequenceExpression(sequence) => sequence
            .expressions
            .iter()
            .all(|expression| inlineable_expression(expression, reactive_reads)),
        Expression::TemplateLiteral(template) => template
            .expressions
            .iter()
            .all(|expression| inlineable_expression(expression, reactive_reads)),
        Expression::CallExpression(call) => {
            call.arguments.is_empty()
                && matches!(&call.callee, Expression::Identifier(identifier)
                    if reactive_reads.contains(&(identifier.span.start, identifier.span.end)))
        }
        Expression::ParenthesizedExpression(parenthesized) => {
            inlineable_expression(&parenthesized.expression, reactive_reads)
        }
        Expression::TSAsExpression(assertion) => {
            inlineable_expression(&assertion.expression, reactive_reads)
        }
        Expression::TSNonNullExpression(assertion) => {
            inlineable_expression(&assertion.expression, reactive_reads)
        }
        Expression::TSSatisfiesExpression(assertion) => {
            inlineable_expression(&assertion.expression, reactive_reads)
        }
        Expression::TSTypeAssertion(assertion) => {
            inlineable_expression(&assertion.expression, reactive_reads)
        }
        Expression::TSInstantiationExpression(instantiation) => {
            inlineable_expression(&instantiation.expression, reactive_reads)
        }
        _ => false,
    }
}

fn statement_location(statement: &Statement<'_>) -> SourceLocation {
    let span: Span = statement.span();
    (span.start, span.end)
}
