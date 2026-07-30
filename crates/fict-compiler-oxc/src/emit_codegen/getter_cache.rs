use oxc::{
    allocator::{Allocator, CloneIn, Vec as ArenaVec},
    ast::{
        AstBuilder, NONE,
        ast::{
            ArrowFunctionExpression, AssignmentTarget, BindingPattern, Class, Expression, Function,
            FunctionBody, FunctionType, Program, SpreadElement, Statement, VariableDeclarationKind,
            VariableDeclarator,
        },
    },
    ast_visit::{Visit, VisitMut, walk, walk_mut},
    span::{GetSpan, Span},
    syntax::{operator::AssignmentOperator, scope::ScopeFlags},
};
use std::collections::{BTreeMap, BTreeSet};

type SourceLocation = (u32, u32);

pub(super) fn rewrite<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    cacheable_calls: &BTreeSet<SourceLocation>,
    eligible_functions: &BTreeSet<SourceLocation>,
    reserved_names: &[String],
) {
    if cacheable_calls.is_empty() || eligible_functions.is_empty() {
        return;
    }
    let mut rewriter = GetterCacheRewriter {
        allocator,
        cacheable_calls,
        eligible_functions,
        reserved_names: reserved_names.iter().cloned().collect(),
    };
    rewriter.visit_program(program);
}

struct GetterCacheRewriter<'a, 'plan> {
    allocator: &'a Allocator,
    cacheable_calls: &'plan BTreeSet<SourceLocation>,
    eligible_functions: &'plan BTreeSet<SourceLocation>,
    reserved_names: BTreeSet<String>,
}

impl<'a> GetterCacheRewriter<'a, '_> {
    fn function_is_eligible(&self, location: SourceLocation) -> bool {
        self.eligible_functions.contains(&location)
    }

    fn rewrite_body(&mut self, body: &mut FunctionBody<'a>) -> Vec<String> {
        let mut analysis = CacheSafetyAnalysis::new(self.cacheable_calls);
        analysis.visit_function_body(body);
        analysis.finish_segment();

        let invalidated_getters = analysis.invalidated_getters;
        let cache_plan: BTreeMap<_, _> = analysis
            .cache_plan
            .into_iter()
            .filter(|(getter, _)| !invalidated_getters.contains(getter))
            .collect();
        let cache_names: BTreeMap<_, _> = cache_plan
            .keys()
            .map(|getter| (getter.clone(), self.allocate_cache_name(getter)))
            .collect();
        if cache_names.is_empty() {
            return Vec::new();
        }

        let mut replacer = AccessorCacheReplacer {
            allocator: self.allocator,
            cacheable_calls: self.cacheable_calls,
            cache_names: &cache_names,
            cache_plan: &cache_plan,
            read_ordinals: BTreeMap::new(),
            disabled: false,
        };
        replacer.visit_function_body(body);
        cache_names.into_values().collect()
    }

    fn allocate_cache_name(&mut self, getter: &str) -> String {
        let mut index = 0_u32;
        loop {
            let candidate = format!("__cached_{getter}_{index}");
            if self.reserved_names.insert(candidate.clone()) {
                return candidate;
            }
            index = index.saturating_add(1);
        }
    }

    fn prepend_declarations(&self, body: &mut FunctionBody<'a>, names: &[String]) {
        for name in names.iter().rev() {
            body.statements
                .insert(0, cache_declaration(self.allocator, name, body.span));
        }
    }

    fn rewrite_function_expression(&mut self, function: &mut Function<'a>) {
        let location = (function.span.start, function.span.end);
        if function.r#type != FunctionType::FunctionExpression
            || function.r#async
            || function.generator
            || !self.function_is_eligible(location)
        {
            return;
        }
        let Some(body) = &mut function.body else {
            return;
        };
        let names = self.rewrite_body(body);
        self.prepend_declarations(body, &names);
    }

    fn rewrite_arrow(&mut self, function: &mut ArrowFunctionExpression<'a>) {
        let location = (function.span.start, function.span.end);
        if function.r#async || !self.function_is_eligible(location) {
            return;
        }
        let names = self.rewrite_body(&mut function.body);
        if names.is_empty() {
            return;
        }
        if function.expression {
            let returned = function
                .get_expression()
                .expect("expression-bodied arrow has one expression statement")
                .clone_in(self.allocator);
            function.expression = false;
            let body_span = function.body.span;
            function.body.statements.clear();
            self.prepend_declarations(&mut function.body, &names);
            function
                .body
                .statements
                .push(Statement::new_return_statement(
                    body_span,
                    Some(returned),
                    &AstBuilder::new(self.allocator),
                ));
        } else {
            self.prepend_declarations(&mut function.body, &names);
        }
    }
}

impl<'a> VisitMut<'a> for GetterCacheRewriter<'a, '_> {
    fn visit_function(&mut self, function: &mut Function<'a>, flags: ScopeFlags) {
        self.rewrite_function_expression(function);
        walk_mut::walk_function(self, function, flags);
    }

    fn visit_arrow_function_expression(&mut self, function: &mut ArrowFunctionExpression<'a>) {
        self.rewrite_arrow(function);
        walk_mut::walk_arrow_function_expression(self, function);
    }
}

struct CacheSafetyAnalysis<'plan> {
    cacheable_calls: &'plan BTreeSet<SourceLocation>,
    segment_reads: BTreeMap<String, Vec<usize>>,
    read_ordinals: BTreeMap<String, usize>,
    cache_plan: BTreeMap<String, BTreeMap<usize, CacheReadAction>>,
    invalidated_getters: BTreeSet<String>,
    disabled: bool,
}

#[derive(Clone, Copy)]
enum CacheReadAction {
    Assign,
    Reuse,
}

impl<'plan> CacheSafetyAnalysis<'plan> {
    fn new(cacheable_calls: &'plan BTreeSet<SourceLocation>) -> Self {
        Self {
            cacheable_calls,
            segment_reads: BTreeMap::new(),
            read_ordinals: BTreeMap::new(),
            cache_plan: BTreeMap::new(),
            invalidated_getters: BTreeSet::new(),
            disabled: false,
        }
    }

    fn record_read(&mut self, getter: String) {
        if self.disabled {
            return;
        }
        let ordinal = self
            .read_ordinals
            .entry(getter.clone())
            .and_modify(|ordinal| *ordinal += 1)
            .or_insert(1);
        self.segment_reads.entry(getter).or_default().push(*ordinal);
    }

    fn finish_segment(&mut self) {
        for (getter, reads) in std::mem::take(&mut self.segment_reads) {
            if reads.len() < 3 {
                continue;
            }
            let actions = self.cache_plan.entry(getter).or_default();
            actions.insert(reads[1], CacheReadAction::Assign);
            actions.extend(
                reads
                    .into_iter()
                    .skip(2)
                    .map(|ordinal| (ordinal, CacheReadAction::Reuse)),
            );
        }
    }

    fn reset_segment(&mut self) {
        self.finish_segment();
    }

    fn visit_disabled_expression(&mut self, expression: &Expression<'_>) {
        let previous = self.disabled;
        self.disabled = true;
        self.reset_segment();
        walk::walk_expression(self, expression);
        self.disabled = previous;
        self.reset_segment();
    }

    fn visit_disabled_statement(&mut self, statement: &Statement<'_>) {
        let previous = self.disabled;
        self.disabled = true;
        self.reset_segment();
        walk::walk_statement(self, statement);
        self.disabled = previous;
        self.reset_segment();
    }

    fn visit_disabled_class(&mut self, class: &Class<'_>) {
        let previous = self.disabled;
        self.disabled = true;
        self.reset_segment();
        walk::walk_class(self, class);
        self.disabled = previous;
        self.reset_segment();
    }
}

impl<'a> Visit<'a> for CacheSafetyAnalysis<'_> {
    fn visit_expression(&mut self, expression: &Expression<'a>) {
        if let Some(name) = cacheable_call_name(expression, self.cacheable_calls) {
            self.record_read(name);
            return;
        }
        match expression {
            Expression::AssignmentExpression(_)
            | Expression::ConditionalExpression(_)
            | Expression::LogicalExpression(_)
            | Expression::ObjectExpression(_)
            | Expression::TemplateLiteral(_) => {
                self.visit_disabled_expression(expression);
                return;
            }
            Expression::CallExpression(call) => {
                if !call.arguments.is_empty()
                    && let Expression::Identifier(callee) = &call.callee
                {
                    self.invalidated_getters.insert(callee.name.to_string());
                }
                walk::walk_expression(self, expression);
                self.reset_segment();
                return;
            }
            Expression::AwaitExpression(_)
            | Expression::BinaryExpression(_)
            | Expression::ComputedMemberExpression(_)
            | Expression::ImportExpression(_)
            | Expression::NewExpression(_)
            | Expression::PrivateFieldExpression(_)
            | Expression::StaticMemberExpression(_)
            | Expression::TaggedTemplateExpression(_)
            | Expression::UnaryExpression(_)
            | Expression::UpdateExpression(_)
            | Expression::V8IntrinsicExpression(_)
            | Expression::YieldExpression(_) => {
                walk::walk_expression(self, expression);
                self.reset_segment();
                return;
            }
            Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => {
                self.visit_disabled_expression(expression);
                return;
            }
            _ => {}
        }
        walk::walk_expression(self, expression);
    }

    fn visit_statement(&mut self, statement: &Statement<'a>) {
        if let Statement::VariableDeclaration(declaration) = statement
            && declaration
                .declarations
                .iter()
                .any(|declarator| !matches!(&declarator.id, BindingPattern::BindingIdentifier(_)))
        {
            self.visit_disabled_statement(statement);
            return;
        }
        if matches!(statement, Statement::BlockStatement(_)) {
            self.reset_segment();
            walk::walk_statement(self, statement);
            self.reset_segment();
            return;
        }
        if matches!(
            statement,
            Statement::DoWhileStatement(_)
                | Statement::ForInStatement(_)
                | Statement::ForOfStatement(_)
                | Statement::ForStatement(_)
                | Statement::IfStatement(_)
                | Statement::LabeledStatement(_)
                | Statement::SwitchStatement(_)
                | Statement::TryStatement(_)
                | Statement::WhileStatement(_)
                | Statement::WithStatement(_)
        ) {
            self.visit_disabled_statement(statement);
            return;
        }
        walk::walk_statement(self, statement);
    }

    fn visit_function(&mut self, _function: &Function<'a>, _flags: ScopeFlags) {}

    fn visit_arrow_function_expression(&mut self, _function: &ArrowFunctionExpression<'a>) {}

    fn visit_class(&mut self, class: &Class<'a>) {
        self.visit_disabled_class(class);
    }

    fn visit_spread_element(&mut self, spread: &SpreadElement<'a>) {
        walk::walk_spread_element(self, spread);
        self.reset_segment();
    }
}

struct AccessorCacheReplacer<'a, 'plan> {
    allocator: &'a Allocator,
    cacheable_calls: &'plan BTreeSet<SourceLocation>,
    cache_names: &'plan BTreeMap<String, String>,
    cache_plan: &'plan BTreeMap<String, BTreeMap<usize, CacheReadAction>>,
    read_ordinals: BTreeMap<String, usize>,
    disabled: bool,
}

impl<'a> AccessorCacheReplacer<'a, '_> {
    fn visit_disabled_expression(&mut self, expression: &mut Expression<'a>) {
        let previous = self.disabled;
        self.disabled = true;
        walk_mut::walk_expression(self, expression);
        self.disabled = previous;
    }

    fn visit_disabled_statement(&mut self, statement: &mut Statement<'a>) {
        let previous = self.disabled;
        self.disabled = true;
        walk_mut::walk_statement(self, statement);
        self.disabled = previous;
    }

    fn visit_disabled_class(&mut self, class: &mut Class<'a>) {
        let previous = self.disabled;
        self.disabled = true;
        walk_mut::walk_class(self, class);
        self.disabled = previous;
    }
}

impl<'a> VisitMut<'a> for AccessorCacheReplacer<'a, '_> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        if matches!(
            expression,
            Expression::AssignmentExpression(_)
                | Expression::ConditionalExpression(_)
                | Expression::LogicalExpression(_)
                | Expression::ObjectExpression(_)
                | Expression::TemplateLiteral(_)
        ) {
            self.visit_disabled_expression(expression);
            return;
        }
        let Some(getter) = cacheable_call_name(expression, self.cacheable_calls) else {
            walk_mut::walk_expression(self, expression);
            return;
        };
        if self.disabled {
            return;
        }
        let Some(actions) = self.cache_plan.get(&getter) else {
            return;
        };
        let ordinal = self
            .read_ordinals
            .entry(getter.clone())
            .and_modify(|ordinal| *ordinal += 1)
            .or_insert(1);
        let Some(action) = actions.get(ordinal) else {
            return;
        };
        let cache = self
            .cache_names
            .get(&getter)
            .expect("cache plan has an allocated name");

        let span = expression.span();
        let builder = AstBuilder::new(self.allocator);
        match action {
            CacheReadAction::Assign => {
                let value = expression.clone_in(self.allocator);
                let target = AssignmentTarget::new_assignment_target_identifier(
                    span,
                    self.allocator.alloc_str(cache),
                    &builder,
                );
                *expression = Expression::new_assignment_expression(
                    span,
                    AssignmentOperator::Assign,
                    target,
                    value,
                    &builder,
                );
            }
            CacheReadAction::Reuse => {
                *expression =
                    Expression::new_identifier(span, self.allocator.alloc_str(cache), &builder);
            }
        }
    }

    fn visit_function(&mut self, _function: &mut Function<'a>, _flags: ScopeFlags) {}

    fn visit_arrow_function_expression(&mut self, _function: &mut ArrowFunctionExpression<'a>) {}

    fn visit_class(&mut self, class: &mut Class<'a>) {
        self.visit_disabled_class(class);
    }

    fn visit_statement(&mut self, statement: &mut Statement<'a>) {
        if let Statement::VariableDeclaration(declaration) = statement
            && declaration
                .declarations
                .iter()
                .any(|declarator| !matches!(&declarator.id, BindingPattern::BindingIdentifier(_)))
        {
            self.visit_disabled_statement(statement);
            return;
        }
        if matches!(statement, Statement::BlockStatement(_)) {
            walk_mut::walk_statement(self, statement);
            return;
        }
        if matches!(
            statement,
            Statement::DoWhileStatement(_)
                | Statement::ForInStatement(_)
                | Statement::ForOfStatement(_)
                | Statement::ForStatement(_)
                | Statement::IfStatement(_)
                | Statement::LabeledStatement(_)
                | Statement::SwitchStatement(_)
                | Statement::TryStatement(_)
                | Statement::WhileStatement(_)
                | Statement::WithStatement(_)
        ) {
            self.visit_disabled_statement(statement);
            return;
        }
        walk_mut::walk_statement(self, statement);
    }

    fn visit_spread_element(&mut self, spread: &mut SpreadElement<'a>) {
        walk_mut::walk_spread_element(self, spread);
    }
}

fn cacheable_call_name(
    expression: &Expression<'_>,
    cacheable_calls: &BTreeSet<SourceLocation>,
) -> Option<String> {
    let Expression::CallExpression(call) = expression else {
        return None;
    };
    if !call.arguments.is_empty() {
        return None;
    }
    let Expression::Identifier(callee) = &call.callee else {
        return None;
    };
    let call_location = (call.span.start, call.span.end);
    let callee_location = (callee.span.start, callee.span.end);
    (cacheable_calls.contains(&call_location) || cacheable_calls.contains(&callee_location))
        .then(|| callee.name.to_string())
}

fn cache_declaration<'a>(allocator: &'a Allocator, name: &str, span: Span) -> Statement<'a> {
    let builder = AstBuilder::new(allocator);
    let declaration = VariableDeclarator::new(
        span,
        VariableDeclarationKind::Let,
        BindingPattern::new_binding_identifier(span, allocator.alloc_str(name), &builder),
        NONE,
        None,
        false,
        &builder,
    );
    Statement::new_variable_declaration(
        span,
        VariableDeclarationKind::Let,
        ArenaVec::from_array_in([declaration], &allocator),
        false,
        &builder,
    )
}
