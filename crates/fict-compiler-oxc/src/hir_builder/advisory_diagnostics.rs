use std::collections::BTreeSet;

use fict_diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use fict_hir::{FictMacroKind, FunctionId, FunctionKind};
use oxc::{
    ast::ast::{
        Argument, ArrayExpressionElement, ArrowFunctionExpression, CallExpression, ChainElement,
        Expression, Function, JSXAttributeItem, JSXAttributeName,
        JSXAttributeValue as OxcJsxAttributeValue, JSXChild as OxcJsxChild, JSXElement,
        JSXFragment, Program, ReturnStatement,
    },
    ast_visit::{
        Visit,
        walk::{walk_jsx_element, walk_jsx_fragment},
    },
    semantic::Scoping,
    span::GetSpan,
    syntax::{scope::ScopeFlags, symbol::SymbolId},
};

use super::{
    Builder, CallFact, memo_side_effects, simple_parameter_symbol, source_span, span_contains,
};

impl Builder<'_, '_> {
    pub(super) fn validate_advisory_diagnostics(
        &mut self,
        program: &Program<'_>,
        calls: &[CallFact],
        reactive_symbols: &BTreeSet<SymbolId>,
    ) {
        self.validate_component_advisories();
        self.validate_callback_dependencies(program, calls, reactive_symbols);
        self.diagnostics
            .extend(jsx_list_advisories(program, self.semantic.scoping()));
    }

    fn validate_component_advisories(&mut self) {
        for fact in self.function_facts.iter().skip(1) {
            let function = &self.functions[fact.id.as_usize()];
            if function.kind == FunctionKind::Component && fact.returns.is_empty() {
                self.diagnostics.push(advisory(
                    "FICT-C004",
                    DiagnosticSeverity::Warning,
                    "Component has no return statement and will render nothing.",
                    fact.span,
                ));
            }
            if !matches!(function.kind, FunctionKind::Component | FunctionKind::Hook) {
                continue;
            }
            let parent = self.functions[fact.parent.as_usize()].kind;
            if matches!(
                parent,
                FunctionKind::Component | FunctionKind::Hook | FunctionKind::ReactiveScope
            ) {
                self.diagnostics.push(
                    advisory(
                        "FICT-C003",
                        DiagnosticSeverity::Warning,
                        "Components and hooks should not be defined inside reactive owners.",
                        fact.span,
                    )
                    .with_help("move the definition to module scope to preserve identity"),
                );
            }
        }
    }

    fn validate_callback_dependencies(
        &mut self,
        program: &Program<'_>,
        calls: &[CallFact],
        reactive_symbols: &BTreeSet<SymbolId>,
    ) {
        let memo_calls: BTreeSet<_> = calls
            .iter()
            .filter(|call| self.reactive_callback_kind(call) == Some(FictMacroKind::Memo))
            .map(|call| (call.span.start(), call.span.end()))
            .collect();
        let side_effectful_memos =
            memo_side_effects::collect(program, self.semantic.scoping(), &memo_calls);

        for call in calls {
            let Some(kind @ (FictMacroKind::Effect | FictMacroKind::Memo)) =
                self.reactive_callback_kind(call)
            else {
                continue;
            };
            let Some(callback) = call.callback else {
                continue;
            };
            if self.callback_has_reactive_read(callback, reactive_symbols) {
                continue;
            }
            let callback_span = self.function_facts[callback.as_usize()].span;
            if kind == FictMacroKind::Memo
                && side_effectful_memos
                    .iter()
                    .any(|span| span_contains(callback_span, *span))
            {
                continue;
            }
            let (code, severity, message, help) = match kind {
                FictMacroKind::Effect => (
                    "FICT-E001",
                    DiagnosticSeverity::Warning,
                    "Effect has no reactive reads; it will run once.",
                    "use onMount for one-time work or read the intended reactive value",
                ),
                FictMacroKind::Memo => (
                    "FICT-M001",
                    DiagnosticSeverity::Info,
                    "Memo has no reactive dependencies and could be a constant.",
                    "replace the memo with a constant or read the intended reactive value",
                ),
                FictMacroKind::State => unreachable!("filtered reactive callback kinds"),
            };
            self.diagnostics
                .push(advisory(code, severity, message, call.span).with_help(help));
        }
    }

    fn reactive_callback_kind(&self, call: &CallFact) -> Option<FictMacroKind> {
        call.binding
            .and_then(|binding| self.macro_bindings.get(&binding).copied())
            .or_else(|| match call.runtime_creation_kind? {
                super::RuntimeReactiveCreationKind::Effect => Some(FictMacroKind::Effect),
                super::RuntimeReactiveCreationKind::Memo
                | super::RuntimeReactiveCreationKind::NamespaceMemo => Some(FictMacroKind::Memo),
                super::RuntimeReactiveCreationKind::Selector => None,
            })
    }

    fn callback_has_reactive_read(
        &self,
        callback: FunctionId,
        reactive_symbols: &BTreeSet<SymbolId>,
    ) -> bool {
        let body = self.function_facts[callback.as_usize()].body_span;
        reactive_symbols.iter().any(|symbol| {
            self.semantic.symbol_references(*symbol).any(|reference| {
                if !reference.is_read() {
                    return false;
                }
                let node = self.semantic.nodes().get_node(reference.node_id());
                span_contains(body, source_span(node.kind().span()))
            })
        })
    }
}

fn jsx_list_advisories(program: &Program<'_>, scoping: &Scoping) -> Vec<Diagnostic> {
    let mut collector = JsxListCollector {
        scoping,
        seen: BTreeSet::new(),
        diagnostics: Vec::new(),
    };
    collector.visit_program(program);
    collector.diagnostics
}

struct JsxListCollector<'semantic> {
    scoping: &'semantic Scoping,
    seen: BTreeSet<(u32, u32)>,
    diagnostics: Vec<Diagnostic>,
}

impl JsxListCollector<'_> {
    fn inspect_children(&mut self, children: &[OxcJsxChild<'_>]) {
        for child in children {
            match child {
                OxcJsxChild::ExpressionContainer(container) => {
                    if let Some(expression) = container.expression.as_expression() {
                        self.inspect_rendered_expression(expression);
                    }
                }
                OxcJsxChild::Spread(spread) => {
                    self.inspect_rendered_expression(&spread.expression);
                }
                OxcJsxChild::Element(_) | OxcJsxChild::Fragment(_) | OxcJsxChild::Text(_) => {}
            }
        }
    }

    fn inspect_rendered_expression(&mut self, expression: &Expression<'_>) {
        match expression.get_inner_expression() {
            Expression::CallExpression(call) => self.inspect_map_call(call),
            Expression::ChainExpression(chain) => {
                if let ChainElement::CallExpression(call) = &chain.expression {
                    self.inspect_map_call(call);
                }
            }
            Expression::ConditionalExpression(conditional) => {
                self.inspect_rendered_expression(&conditional.consequent);
                self.inspect_rendered_expression(&conditional.alternate);
            }
            Expression::LogicalExpression(logical) => {
                self.inspect_rendered_expression(&logical.left);
                self.inspect_rendered_expression(&logical.right);
            }
            Expression::SequenceExpression(sequence) => {
                if let Some(tail) = sequence.expressions.last() {
                    self.inspect_rendered_expression(tail);
                }
            }
            Expression::ArrayExpression(array) => {
                for element in &array.elements {
                    match element {
                        ArrayExpressionElement::SpreadElement(spread) => {
                            self.inspect_rendered_expression(&spread.argument);
                        }
                        element => {
                            if let Some(expression) = element.as_expression() {
                                self.inspect_rendered_expression(expression);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn inspect_map_call(&mut self, call: &CallExpression<'_>) {
        let is_map = match call.callee.get_inner_expression() {
            Expression::StaticMemberExpression(member) => member.property.name == "map",
            Expression::ComputedMemberExpression(member) => matches!(
                member.expression.get_inner_expression(),
                Expression::StringLiteral(property) if property.value == "map"
            ),
            _ => false,
        };
        if !is_map || !self.seen.insert((call.span.start, call.span.end)) {
            return;
        }
        let Some(callback) = call.arguments.first().and_then(Argument::as_expression) else {
            return;
        };
        let mut summary = match callback.get_inner_expression() {
            Expression::ArrowFunctionExpression(callback) => {
                ListReturnSummary::for_arrow(self.scoping, callback)
            }
            Expression::FunctionExpression(callback) => {
                ListReturnSummary::for_function(self.scoping, callback)
            }
            _ => return,
        };
        if !summary.found_jsx {
            return;
        }
        if summary.missing_key {
            self.diagnostics.push(advisory(
                "FICT-J002",
                DiagnosticSeverity::Warning,
                "Missing key prop in list rendering.",
                source_span(call.span),
            ));
        } else if let Some(key) = summary.index_key.take() {
            self.diagnostics.push(advisory(
                "FICT-J001",
                DiagnosticSeverity::Info,
                "An index-based key may lose item identity when the list changes.",
                key,
            ));
        }
    }
}

impl<'a> Visit<'a> for JsxListCollector<'_> {
    fn visit_jsx_element(&mut self, element: &JSXElement<'a>) {
        self.inspect_children(&element.children);
        walk_jsx_element(self, element);
    }

    fn visit_jsx_fragment(&mut self, fragment: &JSXFragment<'a>) {
        self.inspect_children(&fragment.children);
        walk_jsx_fragment(self, fragment);
    }
}

struct ListReturnSummary<'semantic> {
    scoping: &'semantic Scoping,
    index: Option<SymbolId>,
    found_jsx: bool,
    missing_key: bool,
    index_key: Option<SourceSpan>,
}

impl<'semantic> ListReturnSummary<'semantic> {
    fn for_arrow(scoping: &'semantic Scoping, callback: &ArrowFunctionExpression<'_>) -> Self {
        let mut summary = Self::new(scoping, simple_parameter_symbol(&callback.params, 1));
        if let Some(expression) = callback.get_expression() {
            summary.inspect_expression(expression);
        } else {
            summary.visit_function_body(&callback.body);
        }
        summary
    }

    fn for_function(scoping: &'semantic Scoping, callback: &Function<'_>) -> Self {
        let mut summary = Self::new(scoping, simple_parameter_symbol(&callback.params, 1));
        if let Some(body) = &callback.body {
            summary.visit_function_body(body);
        }
        summary
    }

    fn new(scoping: &'semantic Scoping, index: Option<SymbolId>) -> Self {
        Self {
            scoping,
            index,
            found_jsx: false,
            missing_key: false,
            index_key: None,
        }
    }

    fn inspect_expression(&mut self, expression: &Expression<'_>) {
        match expression.get_inner_expression() {
            Expression::JSXElement(element) => self.inspect_element(element),
            Expression::JSXFragment(_) => {
                self.found_jsx = true;
                self.missing_key = true;
            }
            Expression::ConditionalExpression(conditional) => {
                self.inspect_expression(&conditional.consequent);
                self.inspect_expression(&conditional.alternate);
            }
            Expression::LogicalExpression(logical) => {
                self.inspect_expression(&logical.left);
                self.inspect_expression(&logical.right);
            }
            Expression::SequenceExpression(sequence) => {
                if let Some(tail) = sequence.expressions.last() {
                    self.inspect_expression(tail);
                }
            }
            Expression::ArrayExpression(array) => {
                for element in &array.elements {
                    match element {
                        ArrayExpressionElement::SpreadElement(spread) => {
                            self.inspect_expression(&spread.argument);
                        }
                        element => {
                            if let Some(expression) = element.as_expression() {
                                self.inspect_expression(expression);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn inspect_element(&mut self, element: &JSXElement<'_>) {
        self.found_jsx = true;
        let mut has_key = false;
        for attribute in &element.opening_element.attributes {
            let JSXAttributeItem::Attribute(attribute) = attribute else {
                continue;
            };
            if !matches!(&attribute.name, JSXAttributeName::Identifier(name) if name.name == "key")
            {
                continue;
            }
            has_key = true;
            if self.index_key.is_none()
                && let Some(index) = self.index
                && let Some(OxcJsxAttributeValue::ExpressionContainer(container)) = &attribute.value
                && let Some(expression) = container.expression.as_expression()
                && expression_reads_symbol(expression, self.scoping, index)
            {
                self.index_key = Some(source_span(attribute.span));
            }
        }
        self.missing_key |= !has_key;
    }
}

impl<'a> Visit<'a> for ListReturnSummary<'_> {
    fn visit_return_statement(&mut self, statement: &ReturnStatement<'a>) {
        if let Some(argument) = &statement.argument {
            self.inspect_expression(argument);
        }
    }

    fn visit_function(&mut self, _function: &Function<'a>, _flags: ScopeFlags) {}

    fn visit_arrow_function_expression(&mut self, _function: &ArrowFunctionExpression<'a>) {}
}

fn expression_reads_symbol(
    expression: &Expression<'_>,
    scoping: &Scoping,
    symbol: SymbolId,
) -> bool {
    let mut collector = SymbolReadCollector {
        scoping,
        symbol,
        found: false,
    };
    collector.visit_expression(expression);
    collector.found
}

struct SymbolReadCollector<'semantic> {
    scoping: &'semantic Scoping,
    symbol: SymbolId,
    found: bool,
}

impl<'a> Visit<'a> for SymbolReadCollector<'_> {
    fn visit_identifier_reference(&mut self, identifier: &oxc::ast::ast::IdentifierReference<'a>) {
        self.found |= identifier
            .reference_id
            .get()
            .and_then(|reference| self.scoping.get_reference(reference).symbol_id())
            == Some(self.symbol);
    }
}

fn advisory(
    code: &'static str,
    severity: DiagnosticSeverity,
    message: &'static str,
    span: SourceSpan,
) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("diagnostic literal"),
        severity,
        message,
    )
    .with_primary_span(span)
    .with_guarantee_class(GuaranteeClass::Advisory)
}
