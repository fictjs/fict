use super::SemanticIdentities;
use fict_hir::BindingId;
use oxc::{
    allocator::Vec as ArenaVec,
    ast::ast::{
        ArrowFunctionExpression, BindingIdentifier, BindingPattern, CatchClause, ForInStatement,
        ForOfStatement, FormalParameters, Function, IdentifierReference, Program, Statement,
        VariableDeclarator, WithStatement,
    },
    ast_visit::{Visit, walk},
    syntax::{reference::ReferenceId, scope::ScopeFlags},
};
use std::collections::BTreeSet;

pub(super) fn collect(
    program: &Program<'_>,
    identities: &SemanticIdentities,
) -> BTreeSet<ReferenceId> {
    let mut collector = InitializedReads {
        identities,
        initialized: BTreeSet::new(),
        declarations: Vec::new(),
        reads: BTreeSet::new(),
        dynamic_scope_depth: 0,
    };
    collector.visit_program(program);
    collector.reads
}

struct InitializedReads<'identities> {
    identities: &'identities SemanticIdentities,
    initialized: BTreeSet<BindingId>,
    declarations: Vec<BindingId>,
    reads: BTreeSet<ReferenceId>,
    dynamic_scope_depth: usize,
}

impl InitializedReads<'_> {
    fn declare_identifier(&mut self, identifier: &BindingIdentifier<'_>) {
        if let Some(binding) = identifier
            .symbol_id
            .get()
            .and_then(|symbol| self.identities.binding_for_symbol(symbol))
            && self.initialized.insert(binding)
        {
            self.declarations.push(binding);
        }
    }

    fn declare(&mut self, pattern: &BindingPattern<'_>) {
        for identifier in pattern.get_binding_identifiers() {
            self.declare_identifier(identifier);
        }
    }

    fn restore(&mut self, checkpoint: usize) {
        for binding in self.declarations.drain(checkpoint..) {
            self.initialized.remove(&binding);
        }
    }
}

impl<'a> Visit<'a> for InitializedReads<'_> {
    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        if self.dynamic_scope_depth == 0
            && self
                .identities
                .binding_for_reference(identifier)
                .map_or_else(
                    || matches!(identifier.name.as_str(), "undefined" | "NaN" | "Infinity"),
                    |binding| self.initialized.contains(&binding),
                )
            && let Some(reference) = identifier.reference_id.get()
        {
            self.reads.insert(reference);
        }
    }

    fn visit_statements(&mut self, statements: &ArenaVec<'a, Statement<'a>>) {
        // Each block/case starts with only the bindings initialized on entry.
        // A declaration in an earlier switch case does not dominate a later case.
        let checkpoint = self.declarations.len();
        walk::walk_statements(self, statements);
        self.restore(checkpoint);
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        walk::walk_variable_declarator(self, declarator);
        self.declare(&declarator.id);
    }

    fn visit_formal_parameters(&mut self, parameters: &FormalParameters<'a>) {
        walk::walk_formal_parameters(self, parameters);
        for parameter in &parameters.items {
            self.declare(&parameter.pattern);
        }
        if let Some(rest) = &parameters.rest {
            self.declare(&rest.rest.argument);
        }
    }

    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        // A closure can run before an enclosing lexical declaration initializes.
        let outer = std::mem::take(&mut self.initialized);
        let outer_declarations = std::mem::take(&mut self.declarations);
        if let Some(identifier) = &function.id {
            self.declare_identifier(identifier);
        }
        walk::walk_function(self, function, flags);
        self.initialized = outer;
        self.declarations = outer_declarations;
    }

    fn visit_arrow_function_expression(&mut self, function: &ArrowFunctionExpression<'a>) {
        let outer = std::mem::take(&mut self.initialized);
        let outer_declarations = std::mem::take(&mut self.declarations);
        walk::walk_arrow_function_expression(self, function);
        self.initialized = outer;
        self.declarations = outer_declarations;
    }

    fn visit_catch_clause(&mut self, clause: &CatchClause<'a>) {
        let checkpoint = self.declarations.len();
        if let Some(parameter) = &clause.param {
            self.visit_catch_parameter(parameter);
            self.declare(&parameter.pattern);
        }
        self.visit_block_statement(&clause.body);
        self.restore(checkpoint);
    }

    fn visit_for_of_statement(&mut self, statement: &ForOfStatement<'a>) {
        let checkpoint = self.declarations.len();
        self.visit_expression(&statement.right);
        self.visit_for_statement_left(&statement.left);
        self.visit_statement(&statement.body);
        self.restore(checkpoint);
    }

    fn visit_for_in_statement(&mut self, statement: &ForInStatement<'a>) {
        let checkpoint = self.declarations.len();
        self.visit_expression(&statement.right);
        self.visit_for_statement_left(&statement.left);
        self.visit_statement(&statement.body);
        self.restore(checkpoint);
    }

    fn visit_with_statement(&mut self, statement: &WithStatement<'a>) {
        self.dynamic_scope_depth += 1;
        walk::walk_with_statement(self, statement);
        self.dynamic_scope_depth -= 1;
    }
}
