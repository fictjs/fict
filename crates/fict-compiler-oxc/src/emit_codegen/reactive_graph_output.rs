//! Count resolved compiler-helper call sites in the final AST and reconcile source anchors.

use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::SourceSpan;
use fict_emit::EmitProgram;
use oxc::{
    ast::ast::{
        ArrowFunctionExpression, BindingPattern, CallExpression, Expression, Function,
        IdentifierReference, ImportDeclarationSpecifier, Program, Statement,
    },
    ast_visit::{Visit, walk},
    semantic::Scoping,
    span::Span,
    syntax::{scope::ScopeFlags, symbol::SymbolId},
};

use crate::reactive_graph::{GraphCall, GraphOwner, OxcReactiveGraph};

#[derive(Clone)]
enum ImportBinding {
    Direct(String),
    Namespace(BTreeMap<String, String>),
}

pub(super) struct OutputTrace {
    imports: BTreeMap<String, ImportBinding>,
    raw: Census,
}

pub(super) fn capture(program: &Program<'_>, scoping: &Scoping, emit: &EmitProgram) -> OutputTrace {
    let mut imports = BTreeMap::new();
    let mut modules: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for intent in &emit.imports {
        modules
            .entry(intent.module_request.clone())
            .or_default()
            .insert(intent.imported.clone(), intent.helper.spec().key.to_owned());
    }
    let mut require_aliases = BTreeSet::new();
    // Only synthetic module declarations can certify the CommonJS adapter's load wrappers.
    // Authored lookalike functions, nested shadowed bindings and arbitrary aliases are excluded.
    for statement in &program.body {
        if let Statement::VariableDeclaration(declaration) = statement {
            for variable in &declaration.declarations {
                if variable.span.start != variable.span.end {
                    continue;
                }
                if let BindingPattern::BindingIdentifier(binding) = &variable.id
                    && let Some(Expression::Identifier(value)) = variable.init.as_ref()
                    && value.name == "require"
                    && resolved(value, scoping).is_none()
                {
                    require_aliases.insert(binding.name.to_string());
                }
            }
        }
    }
    for statement in &program.body {
        match statement {
            Statement::ImportDeclaration(declaration) => {
                for specifier in declaration.specifiers.iter().flatten() {
                    if let ImportDeclarationSpecifier::ImportSpecifier(specifier) = specifier
                        && let Some(intent) = emit.imports.iter().find(|intent| {
                            intent.module_request == declaration.source.value.as_str()
                                && intent.local == specifier.local.name.as_str()
                                && intent.imported == specifier.imported.name().as_str()
                        })
                    {
                        imports.insert(
                            intent.local.clone(),
                            ImportBinding::Direct(intent.helper.spec().key.to_owned()),
                        );
                    }
                }
            }
            Statement::VariableDeclaration(declaration) => {
                for variable in &declaration.declarations {
                    if variable.span.start != variable.span.end {
                        continue;
                    }
                    let BindingPattern::BindingIdentifier(binding) = &variable.id else {
                        continue;
                    };
                    let Some(Expression::CallExpression(load)) = variable.init.as_ref() else {
                        continue;
                    };
                    let Some(Expression::CallExpression(require)) =
                        load.arguments.first().and_then(|arg| arg.as_expression())
                    else {
                        continue;
                    };
                    let Expression::Identifier(callee) = &require.callee else {
                        continue;
                    };
                    if !(callee.name == "require" && resolved(callee, scoping).is_none()
                        || require_aliases.contains(callee.name.as_str()))
                    {
                        continue;
                    }
                    let Some(Expression::StringLiteral(module)) = require
                        .arguments
                        .first()
                        .and_then(|arg| arg.as_expression())
                    else {
                        continue;
                    };
                    if let Some(helpers) = modules.get(module.value.as_str()) {
                        imports.insert(
                            binding.name.to_string(),
                            ImportBinding::Namespace(helpers.clone()),
                        );
                    }
                }
            }
            _ => {}
        }
    }
    let raw = census(program, scoping, &imports);
    OutputTrace { imports, raw }
}

pub(super) fn finish(
    graph: &mut OxcReactiveGraph,
    captured: OutputTrace,
    program: &Program<'_>,
    scoping: &Scoping,
    source_len: usize,
) {
    let mut final_output = census(program, scoping, &captured.imports);
    let consistent = captured
        .raw
        .calls
        .iter()
        .map(|call| (&call.helper, call.owner))
        .eq(final_output
            .calls
            .iter()
            .map(|call| (&call.helper, call.owner)))
        && captured
            .raw
            .owners
            .iter()
            .map(|owner| (&owner.kind, owner.parent))
            .eq(final_output
                .owners
                .iter()
                .map(|owner| (&owner.kind, owner.parent)));
    graph.source_anchors_verified = consistent;
    if consistent {
        let source_span = |span: SourceSpan| {
            (span.start() < span.end() && span.end() as usize <= source_len).then_some(span)
        };
        let mut operations: BTreeMap<(u32, u32, &str), Vec<u32>> = BTreeMap::new();
        for operation in &graph.operations {
            if let (Some(span), Some(helper)) = (operation.span, operation.helper.as_deref()) {
                operations
                    .entry((span.start(), span.end(), helper))
                    .or_default()
                    .push(operation.id);
            }
        }
        for (call, raw) in final_output.calls.iter_mut().zip(&captured.raw.calls) {
            call.source_span = source_span(raw.span);
            if let Some(span) = call.source_span {
                call.operations = operations
                    .get(&(span.start(), span.end(), call.helper.as_str()))
                    .cloned()
                    .unwrap_or_default();
            }
        }
        let functions: BTreeMap<_, _> = graph
            .functions
            .iter()
            .filter_map(|function| {
                function
                    .span
                    .map(|span| ((span.start(), span.end()), function.id))
            })
            .collect();
        for (owner, raw) in final_output.owners.iter_mut().zip(&captured.raw.owners) {
            owner.source_span = source_span(raw.span);
            owner.function = owner
                .source_span
                .and_then(|span| functions.get(&(span.start(), span.end())).copied());
        }
    }
    graph.calls = final_output.calls;
    graph.owners = final_output.owners;
    graph
        .counters
        .insert("source.bindings".to_owned(), graph.bindings.len() as u64);
    graph.counters.insert(
        "emit.slots".to_owned(),
        graph
            .functions
            .iter()
            .map(|function| function.slots.len() as u64)
            .sum(),
    );
    graph.counters.insert(
        "output.function-sites".to_owned(),
        graph.owners.len() as u64,
    );
    for operation in &graph.operations {
        *graph
            .counters
            .entry(format!("emit.operation.{}", operation.kind))
            .or_default() += 1;
    }
    for decision in &graph.decisions {
        *graph
            .counters
            .entry(format!("decision.{}", decision.reason))
            .or_default() += 1;
    }
    for call in &graph.calls {
        *graph
            .counters
            .entry(format!("output.helper.{}", call.helper))
            .or_default() += 1;
    }
}

#[derive(Default)]
struct Census {
    calls: Vec<GraphCall>,
    owners: Vec<GraphOwner>,
}

fn census(
    program: &Program<'_>,
    scoping: &Scoping,
    names: &BTreeMap<String, ImportBinding>,
) -> Census {
    let imports = scoping
        .symbol_ids()
        .filter(|symbol| scoping.symbol_scope_id(*symbol) == scoping.root_scope_id())
        .filter_map(|symbol| {
            names
                .get(scoping.symbol_name(symbol))
                .map(|binding| (symbol, binding.clone()))
        })
        .collect();
    let mut collector = Collector {
        scoping,
        imports,
        output: Census::default(),
        owner: None,
    };
    collector.visit_program(program);
    collector.output
}

struct Collector<'s> {
    scoping: &'s Scoping,
    imports: BTreeMap<SymbolId, ImportBinding>,
    output: Census,
    owner: Option<u32>,
}

impl Collector<'_> {
    fn helper(&self, expression: &Expression<'_>) -> Option<&str> {
        match expression.get_inner_expression() {
            Expression::Identifier(identifier) => {
                match self.imports.get(&resolved(identifier, self.scoping)?)? {
                    ImportBinding::Direct(helper) => Some(helper),
                    ImportBinding::Namespace(_) => None,
                }
            }
            Expression::StaticMemberExpression(member) => {
                let Expression::Identifier(identifier) = member.object.get_inner_expression()
                else {
                    return None;
                };
                let ImportBinding::Namespace(helpers) =
                    self.imports.get(&resolved(identifier, self.scoping)?)?
                else {
                    return None;
                };
                helpers
                    .get(member.property.name.as_str())
                    .map(String::as_str)
            }
            Expression::SequenceExpression(sequence) => sequence
                .expressions
                .last()
                .and_then(|last| self.helper(last)),
            _ => None,
        }
    }

    fn enter(&mut self, span: Span, kind: &str) -> Option<u32> {
        let previous = self.owner;
        let id = self.output.owners.len() as u32;
        self.output.owners.push(GraphOwner {
            id,
            parent: previous,
            kind: kind.to_owned(),
            span: SourceSpan::new(span.start, span.end).expect("ordered AST owner"),
            source_span: None,
            function: None,
        });
        self.owner = Some(id);
        previous
    }
}

impl<'a> Visit<'a> for Collector<'_> {
    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if let Some(helper) = self.helper(&call.callee).map(str::to_owned) {
            self.output.calls.push(GraphCall {
                id: self.output.calls.len() as u32,
                helper,
                span: SourceSpan::new(call.span.start, call.span.end).expect("ordered AST call"),
                source_span: None,
                owner: self.owner,
                operations: Vec::new(),
            });
        }
        walk::walk_call_expression(self, call);
    }

    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        let previous = self.enter(function.span, "function");
        walk::walk_function(self, function, flags);
        self.owner = previous;
    }

    fn visit_arrow_function_expression(&mut self, function: &ArrowFunctionExpression<'a>) {
        let previous = self.enter(function.span, "arrow");
        walk::walk_arrow_function_expression(self, function);
        self.owner = previous;
    }
}

fn resolved(identifier: &IdentifierReference<'_>, scoping: &Scoping) -> Option<SymbolId> {
    identifier
        .reference_id
        .get()
        .and_then(|id| scoping.get_reference(id).symbol_id())
}
