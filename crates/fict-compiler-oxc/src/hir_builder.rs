use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use fict_hir::{
    Binding, BindingId, BindingKind, BlockId, CallArgument, CallHost, CallInstruction,
    DeclarationKind, EvaluationMode, FictMacroKind, FileId, FunctionFlags, FunctionId,
    FunctionKind, HirBlock, HirFile, HirFunction, HirInstruction, HirInstructionKind, HirLocal,
    HirParameter, HirScope, HirTerminator, HirValue, InstructionSemantics, JsxAttribute,
    JsxAttributeValue, JsxChild, JsxElement, JsxElementName, JsxNode, JsxTemplate, LocalId,
    LocalKind, MutationEffect, Origin, PatternSummary, Purity, ReactiveScopeHost,
    ReactiveScopeKind, RegionId, ScopeId, ScopeKind, SyntaxFragment, SyntaxFragmentId,
    SyntaxFragmentKind, SyntaxSummary, TemplateId, TerminatorKind, ValueId, ValueKind, verify_hir,
};
use oxc::{
    allocator::Allocator,
    ast::ast::{
        ArrowFunctionExpression, AssignmentPattern, BindingIdentifier, BindingPattern,
        BindingRestElement, CallExpression, Expression, FormalParameters, Function,
        JSXAttributeItem, JSXAttributeName, JSXAttributeValue as OxcJsxAttributeValue,
        JSXChild as OxcJsxChild, JSXElement, JSXElementName as OxcJsxElementName, JSXExpression,
        JSXFragment, JSXMemberExpression, JSXMemberExpressionObject, Program, VariableDeclarator,
    },
    ast_visit::{
        Visit,
        walk::{
            walk_arrow_function_expression, walk_assignment_pattern, walk_binding_rest_element,
            walk_call_expression, walk_function, walk_variable_declarator,
        },
    },
    parser::{ParseOptions, Parser},
    semantic::{Scoping, Semantic, SemanticBuilder},
    span::{GetSpan, Span},
    syntax::{scope::ScopeFlags, symbol::SymbolId},
};

use crate::{
    FictDirectiveKind, FrontendBindingKind, FrontendSummary, OxcCompileOptions, OxcSourceLanguage,
    analyze_frontend, analyze_typescript_compatibility,
};

use super::compile::{convert_diagnostics, sorted, source_type};

/// Binding-aware frontend controls that affect HIR classification.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HirBuildOptions {
    /// Direct-call hosts whose first callback is a reactive scope.
    ///
    /// Names are resolved once in the file root. Every HIR call and callback
    /// then carries the resolved [`BindingId`], never the spelling.
    pub reactive_scopes: Vec<String>,
}

/// OXC-owned syntax retained outside `fict-hir`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OxcSyntaxFragment {
    /// Handle stored in typed HIR.
    pub id: SyntaxFragmentId,
    /// Controlled syntax category.
    pub kind: SyntaxFragmentKind,
    /// Exact UTF-8 source slice used to re-materialize the node in the adapter.
    pub source: String,
    /// Original source span.
    pub span: SourceSpan,
}

/// Arena-independent result of OXC AST to Fict HIR construction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HirBuildOutput {
    /// Verified HIR. It is absent for parser, semantic, policy, or verifier errors.
    pub hir: Option<HirFile>,
    /// Owned frontend facts produced from the same source contract.
    pub frontend: Option<FrontendSummary>,
    /// Adapter-owned source required by controlled syntax fragments.
    pub syntax_fragments: Vec<OxcSyntaxFragment>,
    /// Structured diagnostics in deterministic order.
    pub diagnostics: Vec<Diagnostic>,
}

/// Parse, resolve bindings, classify functions/calls, and build verified typed HIR.
#[must_use]
pub fn build_hir(
    source: &str,
    compile_options: OxcCompileOptions,
    hir_options: &HirBuildOptions,
) -> HirBuildOutput {
    let frontend_output = analyze_frontend(source, compile_options);
    let Some(frontend) = frontend_output.summary else {
        return HirBuildOutput {
            hir: None,
            frontend: None,
            syntax_fragments: Vec::new(),
            diagnostics: frontend_output.diagnostics,
        };
    };

    let policy_diagnostics = unsupported_macro_diagnostics(&frontend);
    if !policy_diagnostics.is_empty() {
        return HirBuildOutput {
            hir: None,
            frontend: Some(frontend),
            syntax_fragments: Vec::new(),
            diagnostics: sorted(policy_diagnostics),
        };
    }

    if matches!(
        compile_options.language,
        OxcSourceLanguage::TypeScript | OxcSourceLanguage::TypeScriptJsx
    ) {
        let compatibility = analyze_typescript_compatibility(source, compile_options);
        if !compatibility.diagnostics.is_empty() {
            return HirBuildOutput {
                hir: None,
                frontend: Some(frontend),
                syntax_fragments: Vec::new(),
                diagnostics: compatibility.diagnostics,
            };
        }
    }

    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type(compile_options))
        .with_options(ParseOptions {
            allow_return_outside_function: compile_options.module_kind
                == crate::OxcModuleKind::CommonJs,
            ..ParseOptions::default()
        })
        .parse();
    if !parsed.diagnostics.is_empty() {
        return HirBuildOutput {
            hir: None,
            frontend: Some(frontend),
            syntax_fragments: Vec::new(),
            diagnostics: sorted(convert_diagnostics(parsed.diagnostics, "FICT-PARSE")),
        };
    }

    let program = parsed.program;
    let semantic_result = SemanticBuilder::new()
        .with_build_nodes(true)
        .with_check_syntax_error(true)
        .with_enum_eval(true)
        .build(&program);
    if semantic_result.diagnostics.has_errors() {
        return HirBuildOutput {
            hir: None,
            frontend: Some(frontend),
            syntax_fragments: Vec::new(),
            diagnostics: sorted(convert_diagnostics(
                semantic_result.diagnostics,
                "FICT-SEMANTIC",
            )),
        };
    }

    let semantic = semantic_result.semantic;
    let mut builder = Builder::new(source, frontend, &semantic, hir_options);
    builder.build(&program);
    builder.finish()
}

fn unsupported_macro_diagnostics(frontend: &FrontendSummary) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    for call in &frontend.macro_calls {
        if call.optional {
            diagnostics.push(
                error(
                    "FICT-HIR-MACRO-OPTIONAL",
                    "Fict compiler macros cannot be invoked through optional-call syntax",
                    call.call_span,
                )
                .with_help("invoke the imported macro directly"),
            );
        }
    }
    for value_use in &frontend.macro_value_uses {
        diagnostics.push(
            error(
                "FICT-HIR-MACRO-VALUE",
                "a Fict compiler macro import cannot escape as a runtime value",
                value_use.span,
            )
            .with_help("call the macro directly at its use site"),
        );
    }
    for call in &frontend.namespace_macro_calls {
        diagnostics.push(
            error(
                "FICT-HIR-MACRO-NAMESPACE",
                "Fict compiler macros must use a named import, not a namespace member",
                call.call_span,
            )
            .with_help("replace the namespace access with a named macro import"),
        );
    }
    diagnostics
}

#[derive(Debug, Clone)]
struct ParameterFact {
    span: SourceSpan,
    bindings: Vec<SymbolId>,
    has_default: bool,
    has_rest: bool,
}

#[derive(Debug, Clone)]
struct FunctionFact {
    id: FunctionId,
    parent: FunctionId,
    scope: ScopeId,
    binding: Option<SymbolId>,
    display_name: Option<String>,
    span: SourceSpan,
    body_span: SourceSpan,
    parameters: Vec<ParameterFact>,
    flags: FunctionFlags,
}

struct FunctionCollector {
    functions: Vec<FunctionFact>,
    stack: Vec<FunctionId>,
    inferred_bindings: BTreeMap<(u32, u32), (SymbolId, String)>,
}

impl FunctionCollector {
    fn new(program_span: SourceSpan) -> Self {
        Self {
            functions: vec![FunctionFact {
                id: FunctionId::new(0),
                parent: FunctionId::new(0),
                scope: ScopeId::new(0),
                binding: None,
                display_name: None,
                span: program_span,
                body_span: program_span,
                parameters: Vec::new(),
                flags: FunctionFlags::default(),
            }],
            stack: vec![FunctionId::new(0)],
            inferred_bindings: BTreeMap::new(),
        }
    }

    fn add_function(
        &mut self,
        span: Span,
        body_span: Span,
        scope: Option<oxc::syntax::scope::ScopeId>,
        explicit_binding: Option<&BindingIdentifier<'_>>,
        parameters: &FormalParameters<'_>,
        flags: FunctionFlags,
    ) -> FunctionId {
        let id = FunctionId::new(count_u32(self.functions.len()));
        let inferred = self.inferred_bindings.get(&(span.start, span.end));
        let binding = explicit_binding
            .and_then(|identifier| identifier.symbol_id.get())
            .or_else(|| inferred.map(|(symbol, _)| *symbol));
        let display_name = explicit_binding
            .map(|identifier| identifier.name.to_string())
            .or_else(|| inferred.map(|(_, name)| name.clone()));
        self.functions.push(FunctionFact {
            id,
            parent: *self.stack.last().expect("module function stack"),
            scope: ScopeId::new(scope.map_or(0, |scope| count_u32(scope.index()))),
            binding,
            display_name,
            span: source_span(span),
            body_span: source_span(body_span),
            parameters: parameter_facts(parameters),
            flags,
        });
        id
    }
}

impl<'a> Visit<'a> for FunctionCollector {
    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if let (BindingPattern::BindingIdentifier(binding), Some(initializer)) =
            (&declarator.id, &declarator.init)
            && matches!(
                initializer,
                Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_)
            )
            && let Some(symbol) = binding.symbol_id.get()
        {
            let span = initializer.span();
            self.inferred_bindings
                .insert((span.start, span.end), (symbol, binding.name.to_string()));
        }
        walk_variable_declarator(self, declarator);
    }

    fn visit_function(&mut self, function: &Function<'a>, scope_flags: ScopeFlags) {
        let Some(body) = &function.body else {
            return;
        };
        let id = self.add_function(
            function.span,
            body.span,
            function.scope_id.get(),
            function.id.as_ref(),
            &function.params,
            FunctionFlags {
                is_async: function.r#async,
                is_generator: function.generator,
                is_arrow: false,
                no_memo: false,
                pure: function.pure,
            },
        );
        self.stack.push(id);
        walk_function(self, function, scope_flags);
        self.stack.pop();
    }

    fn visit_arrow_function_expression(&mut self, function: &ArrowFunctionExpression<'a>) {
        let id = self.add_function(
            function.span,
            function.body.span,
            function.scope_id.get(),
            None,
            &function.params,
            FunctionFlags {
                is_async: function.r#async,
                is_generator: false,
                is_arrow: true,
                no_memo: false,
                pure: function.pure,
            },
        );
        self.stack.push(id);
        walk_arrow_function_expression(self, function);
        self.stack.pop();
    }
}

#[derive(Default)]
struct PatternBindingCollector {
    symbols: Vec<SymbolId>,
    has_defaults: bool,
    has_rest: bool,
}

impl<'a> Visit<'a> for PatternBindingCollector {
    fn visit_binding_identifier(&mut self, identifier: &BindingIdentifier<'a>) {
        if let Some(symbol) = identifier.symbol_id.get() {
            self.symbols.push(symbol);
        }
    }

    fn visit_assignment_pattern(&mut self, pattern: &AssignmentPattern<'a>) {
        self.has_defaults = true;
        walk_assignment_pattern(self, pattern);
    }

    fn visit_binding_rest_element(&mut self, rest: &BindingRestElement<'a>) {
        self.has_rest = true;
        walk_binding_rest_element(self, rest);
    }

    fn visit_function(&mut self, _function: &Function<'a>, _flags: ScopeFlags) {}

    fn visit_arrow_function_expression(&mut self, _function: &ArrowFunctionExpression<'a>) {}
}

fn parameter_facts(parameters: &FormalParameters<'_>) -> Vec<ParameterFact> {
    let mut facts =
        Vec::with_capacity(parameters.items.len() + usize::from(parameters.rest.is_some()));
    for parameter in &parameters.items {
        let mut collector = PatternBindingCollector::default();
        collector.visit_binding_pattern(&parameter.pattern);
        facts.push(ParameterFact {
            span: source_span(parameter.span),
            bindings: collector.symbols,
            has_default: parameter.initializer.is_some() || collector.has_defaults,
            has_rest: collector.has_rest,
        });
    }
    if let Some(rest) = &parameters.rest {
        let mut collector = PatternBindingCollector::default();
        collector.visit_binding_pattern(&rest.rest.argument);
        facts.push(ParameterFact {
            span: source_span(rest.span),
            bindings: collector.symbols,
            has_default: collector.has_defaults,
            has_rest: true,
        });
    }
    facts
}

struct Builder<'source, 'semantic> {
    source: &'source str,
    frontend: FrontendSummary,
    semantic: &'semantic Semantic<'semantic>,
    old_to_new: BTreeMap<u32, BindingId>,
    symbol_to_binding: BTreeMap<SymbolId, BindingId>,
    functions: Vec<HirFunction>,
    function_facts: Vec<FunctionFact>,
    function_by_span: BTreeMap<(u32, u32), FunctionId>,
    templates: Vec<JsxTemplate>,
    syntax_fragments: Vec<SyntaxFragment>,
    adapter_fragments: Vec<OxcSyntaxFragment>,
    diagnostics: Vec<Diagnostic>,
    macro_bindings: BTreeMap<BindingId, FictMacroKind>,
    configured_bindings: BTreeSet<BindingId>,
}

impl<'source, 'semantic> Builder<'source, 'semantic> {
    fn new(
        source: &'source str,
        frontend: FrontendSummary,
        semantic: &'semantic Semantic<'semantic>,
        options: &HirBuildOptions,
    ) -> Self {
        let mut old_to_new = BTreeMap::new();
        let mut symbol_to_binding = BTreeMap::new();
        for binding in frontend
            .bindings
            .iter()
            .filter(|binding| binding.is_runtime)
        {
            let new = BindingId::new(count_u32(old_to_new.len()));
            old_to_new.insert(binding.id.index(), new);
            symbol_to_binding.insert(SymbolId::from_usize(binding.id.as_usize()), new);
        }
        let macro_bindings = frontend
            .macro_imports
            .iter()
            .filter_map(|import| {
                old_to_new
                    .get(&import.binding.index())
                    .copied()
                    .map(|binding| (binding, import.kind))
            })
            .collect();
        let option_names: BTreeSet<_> = options.reactive_scopes.iter().cloned().collect();
        let configured_bindings = frontend
            .bindings
            .iter()
            .filter(|binding| {
                binding.is_runtime
                    && binding.scope == ScopeId::new(0)
                    && option_names.contains(&binding.display_name)
            })
            .filter_map(|binding| old_to_new.get(&binding.id.index()).copied())
            .collect();
        Self {
            source,
            frontend,
            semantic,
            old_to_new,
            symbol_to_binding,
            functions: Vec::new(),
            function_facts: Vec::new(),
            function_by_span: BTreeMap::new(),
            templates: Vec::new(),
            syntax_fragments: Vec::new(),
            adapter_fragments: Vec::new(),
            diagnostics: Vec::new(),
            macro_bindings,
            configured_bindings,
        }
    }

    fn build(&mut self, program: &Program<'_>) {
        let mut collector = FunctionCollector::new(source_span(program.span));
        collector.visit_program(program);
        self.function_by_span = collector
            .functions
            .iter()
            .map(|function| ((function.span.start(), function.span.end()), function.id))
            .collect();
        self.function_facts = collector.functions;
        self.build_function_shells();

        let function_by_span = self.function_by_span.clone();
        let symbol_to_binding = self.symbol_to_binding.clone();
        let mut calls = CallCollector {
            scoping: self.semantic.scoping(),
            stack: vec![FunctionId::new(0)],
            function_by_span: &function_by_span,
            symbol_to_binding: &symbol_to_binding,
            calls: Vec::new(),
        };
        calls.visit_program(program);
        let mut jsx = JsxCollector {
            scoping: self.semantic.scoping(),
            stack: vec![FunctionId::new(0)],
            function_by_span: &function_by_span,
            roots: Vec::new(),
        };
        jsx.visit_program(program);
        for root in &jsx.roots {
            if root.owner != FunctionId::new(0)
                && self.functions[root.owner.as_usize()].kind == FunctionKind::Plain
            {
                self.functions[root.owner.as_usize()].kind = FunctionKind::Component;
            }
        }
        self.apply_call_classification(&calls.calls);
        self.populate_function_bodies(&calls.calls, &jsx.roots);
    }

    fn build_function_shells(&mut self) {
        for mut fact in self.function_facts.clone() {
            for directive in self
                .frontend
                .source_facts
                .directives
                .iter()
                .filter(|directive| directive.scope == fact.scope)
            {
                match directive.kind {
                    FictDirectiveKind::NoMemo => fact.flags.no_memo = true,
                    FictDirectiveKind::Pure => fact.flags.pure = true,
                    FictDirectiveKind::UseStrict
                    | FictDirectiveKind::UseFictCompiler
                    | FictDirectiveKind::DisableFictCompiler
                    | FictDirectiveKind::Other => {}
                }
            }
            let binding = fact
                .binding
                .and_then(|symbol| self.symbol_to_binding.get(&symbol).copied());
            let kind = if fact.id == FunctionId::new(0) {
                FunctionKind::Module
            } else {
                classify_named_function(fact.display_name.as_deref())
            };
            let mut locals = Vec::new();
            let mut parameters = Vec::new();
            let mut values = Vec::new();
            let mut direct_parameter_bindings = BTreeSet::new();
            let parameter_bindings: BTreeSet<_> = fact
                .parameters
                .iter()
                .flat_map(|parameter| parameter.bindings.iter())
                .filter_map(|symbol| self.symbol_to_binding.get(symbol).copied())
                .collect();
            for parameter in &fact.parameters {
                let declared_bindings: Vec<_> = parameter
                    .bindings
                    .iter()
                    .filter_map(|symbol| self.symbol_to_binding.get(symbol).copied())
                    .collect();
                let direct_binding = (declared_bindings.len() == 1).then(|| declared_bindings[0]);
                direct_parameter_bindings.extend(direct_binding);
                let fragment = self.add_fragment(
                    SyntaxFragmentKind::Pattern,
                    parameter.span,
                    SyntaxSummary {
                        referenced_bindings: Vec::new(),
                        pattern: Some(PatternSummary {
                            declared_bindings,
                            assigned_bindings: Vec::new(),
                            has_defaults: parameter.has_default,
                            has_rest: parameter.has_rest,
                        }),
                        has_side_effects: parameter.has_default,
                        may_throw: parameter.has_default,
                        ..SyntaxSummary::default()
                    },
                );
                let local = LocalId::new(count_u32(locals.len()));
                let origin = Origin::source(parameter.span);
                locals.push(HirLocal {
                    id: local,
                    binding: direct_binding,
                    scope: fact.scope,
                    kind: LocalKind::Parameter,
                    declaration_kind: DeclarationKind::Parameter,
                    debug_name: direct_binding.and_then(|binding| {
                        self.frontend
                            .bindings
                            .iter()
                            .find(|candidate| {
                                self.old_to_new.get(&candidate.id.index()) == Some(&binding)
                            })
                            .map(|candidate| candidate.display_name.clone())
                    }),
                    origin,
                });
                parameters.push(HirParameter {
                    local,
                    binding: direct_binding,
                    pattern: fragment,
                    origin,
                });
                values.push(HirValue {
                    id: ValueId::new(count_u32(values.len())),
                    kind: ValueKind::Parameter(local),
                    origin,
                });
            }

            for source_binding in self
                .frontend
                .bindings
                .iter()
                .filter(|binding| binding.is_runtime)
            {
                let hir_binding = self.old_to_new[&source_binding.id.index()];
                if direct_parameter_bindings.contains(&hir_binding)
                    || self.function_owner_for_scope(source_binding.scope) != fact.id
                {
                    continue;
                }
                locals.push(HirLocal {
                    id: LocalId::new(count_u32(locals.len())),
                    binding: Some(hir_binding),
                    scope: source_binding.scope,
                    kind: LocalKind::User,
                    declaration_kind: if parameter_bindings.contains(&hir_binding) {
                        DeclarationKind::Parameter
                    } else {
                        declaration_kind(source_binding.kind)
                    },
                    debug_name: Some(source_binding.display_name.clone()),
                    origin: Origin::source(source_binding.declaration_span),
                });
            }

            let local_bindings: BTreeSet<_> =
                locals.iter().filter_map(|local| local.binding).collect();
            for captured in self.directly_referenced_bindings(&fact) {
                if local_bindings.contains(&captured) {
                    continue;
                }
                let Some(source_binding) = self.frontend.bindings.iter().find(|binding| {
                    self.old_to_new.get(&binding.id.index()).copied() == Some(captured)
                }) else {
                    continue;
                };
                locals.push(HirLocal {
                    id: LocalId::new(count_u32(locals.len())),
                    binding: Some(captured),
                    scope: fact.scope,
                    kind: LocalKind::Capture,
                    declaration_kind: DeclarationKind::Generated,
                    debug_name: Some(source_binding.display_name.clone()),
                    origin: Origin::source(source_binding.declaration_span),
                });
            }

            let declarations = locals
                .iter()
                .filter(|local| local.kind != LocalKind::Parameter)
                .map(|local| HirInstruction {
                    result: None,
                    kind: HirInstructionKind::Declare {
                        local: local.id,
                        declaration_kind: local.declaration_kind,
                        initializer: None,
                    },
                    semantics: InstructionSemantics::PURE_EAGER,
                    origin: local.origin,
                })
                .collect();

            let origin = Origin::source(fact.span);
            self.functions.push(HirFunction {
                id: fact.id,
                binding,
                scope: fact.scope,
                kind,
                flags: fact.flags,
                parameters,
                locals,
                values,
                blocks: vec![HirBlock {
                    id: BlockId::new(0),
                    scope: fact.scope,
                    instructions: declarations,
                    terminator: HirTerminator {
                        kind: TerminatorKind::Return { value: None },
                        origin,
                    },
                    source_hint: None,
                    origin,
                }],
                entry: BlockId::new(0),
                regions: Vec::<RegionId>::new(),
                origin,
            });
        }
    }

    fn function_owner_for_scope(&self, mut scope: ScopeId) -> FunctionId {
        loop {
            if let Some(function) = self
                .function_facts
                .iter()
                .rev()
                .find(|function| function.scope == scope)
            {
                return function.id;
            }
            let Some(parent) = self
                .frontend
                .scopes
                .get(scope.as_usize())
                .and_then(|scope| scope.parent)
            else {
                return FunctionId::new(0);
            };
            scope = parent;
        }
    }

    fn apply_call_classification(&mut self, calls: &[CallFact]) {
        for call in calls {
            let Some(binding) = call.binding else {
                continue;
            };
            let callback_kind = if self.configured_bindings.contains(&binding) {
                Some(ReactiveScopeKind::Configured)
            } else {
                match self.macro_bindings.get(&binding) {
                    Some(FictMacroKind::Effect) => Some(ReactiveScopeKind::EffectCallback),
                    Some(FictMacroKind::Memo) => Some(ReactiveScopeKind::MemoCallback),
                    Some(FictMacroKind::State) | None => None,
                }
            };
            if let (Some(kind), Some(callback)) = (callback_kind, call.callback) {
                self.functions[callback.as_usize()].kind = FunctionKind::ReactiveScope;
                let _ = kind;
            }
        }
    }

    fn populate_function_bodies(&mut self, calls: &[CallFact], jsx_roots: &[JsxFact]) {
        for fact in self.function_facts.clone() {
            let mut inputs = Vec::new();
            let call_argument_functions: BTreeSet<_> = calls
                .iter()
                .filter(|call| call.owner == fact.id)
                .flat_map(|call| {
                    call.arguments
                        .iter()
                        .filter_map(|argument| argument.function)
                })
                .collect();
            let nested: Vec<_> = self
                .function_facts
                .iter()
                .filter(|candidate| {
                    candidate.parent == fact.id
                        && candidate.id != fact.id
                        && !call_argument_functions.contains(&candidate.id)
                })
                .cloned()
                .collect();
            for child in nested {
                let value = self.push_value(
                    fact.id,
                    ValueKind::Function(child.id),
                    Origin::source(child.span),
                    HirInstructionKind::Function { function: child.id },
                    InstructionSemantics::PURE_EAGER,
                );
                inputs.push(value);
            }

            for call in calls.iter().filter(|call| call.owner == fact.id) {
                let callee = self.syntax_value(
                    fact.id,
                    call.callee_span,
                    call.binding.into_iter().collect(),
                );
                let mut arguments = Vec::new();
                for argument in &call.arguments {
                    let value = if let Some(function) = argument.function {
                        self.push_value(
                            fact.id,
                            ValueKind::Function(function),
                            Origin::source(argument.span),
                            HirInstructionKind::Function { function },
                            InstructionSemantics::PURE_EAGER,
                        )
                    } else {
                        self.syntax_value(
                            fact.id,
                            argument.span,
                            self.referenced_bindings(argument.span),
                        )
                    };
                    arguments.push(CallArgument {
                        value,
                        spread: argument.spread,
                    });
                }
                let host = if let Some(binding) = call.binding {
                    let reactive_kind = if self.configured_bindings.contains(&binding) {
                        Some(ReactiveScopeKind::Configured)
                    } else {
                        match self.macro_bindings.get(&binding) {
                            Some(FictMacroKind::Effect) => Some(ReactiveScopeKind::EffectCallback),
                            Some(FictMacroKind::Memo) => Some(ReactiveScopeKind::MemoCallback),
                            Some(FictMacroKind::State) | None => None,
                        }
                    };
                    reactive_kind.map_or(CallHost::Binding(binding), |kind| {
                        CallHost::ReactiveScope(ReactiveScopeHost {
                            callee: binding,
                            callback_index: 0,
                            kind,
                        })
                    })
                } else {
                    CallHost::Unknown
                };
                let value = self.push_value(
                    fact.id,
                    ValueKind::InstructionResult,
                    Origin::source(call.span),
                    HirInstructionKind::Call(CallInstruction {
                        callee,
                        arguments,
                        host,
                        macro_kind: call
                            .binding
                            .and_then(|binding| self.macro_bindings.get(&binding).copied()),
                        optional: call.optional,
                    }),
                    InstructionSemantics {
                        purity: if call.pure {
                            Purity::Pure
                        } else {
                            Purity::Unknown
                        },
                        mutation: if call.pure {
                            MutationEffect::None
                        } else {
                            MutationEffect::Unknown
                        },
                        evaluation: EvaluationMode::Eager,
                        may_throw: true,
                    },
                );
                inputs.push(value);
            }

            for jsx in jsx_roots.iter().filter(|jsx| jsx.owner == fact.id) {
                let root = self.lower_jsx_node(fact.id, &jsx.root);
                let template = TemplateId::new(count_u32(self.templates.len()));
                self.templates.push(JsxTemplate {
                    id: template,
                    owner: fact.id,
                    root,
                    origin: Origin::source(jsx.span),
                });
                let value = self.push_value(
                    fact.id,
                    ValueKind::InstructionResult,
                    Origin::source(jsx.span),
                    HirInstructionKind::Jsx { template },
                    InstructionSemantics::PURE_EAGER,
                );
                inputs.push(value);
            }

            let body_summary = SyntaxSummary {
                referenced_bindings: self.referenced_bindings(fact.body_span),
                has_side_effects: true,
                may_throw: true,
                contains_await: fact.flags.is_async,
                contains_yield: fact.flags.is_generator,
                contains_jsx: source_slice(self.source, fact.body_span)
                    .is_some_and(|slice| slice.contains('<')),
                ..SyntaxSummary::default()
            };
            let fragment =
                self.add_fragment(SyntaxFragmentKind::Statement, fact.body_span, body_summary);
            self.functions[fact.id.as_usize()].blocks[0]
                .instructions
                .push(HirInstruction {
                    result: None,
                    kind: HirInstructionKind::SyntaxFragment { fragment, inputs },
                    semantics: InstructionSemantics::CONSERVATIVE_EAGER,
                    origin: Origin::source(fact.body_span),
                });
        }
    }

    fn syntax_value(
        &mut self,
        owner: FunctionId,
        span: SourceSpan,
        referenced_bindings: Vec<BindingId>,
    ) -> ValueId {
        let fragment = self.add_fragment(
            SyntaxFragmentKind::Expression,
            span,
            SyntaxSummary {
                referenced_bindings,
                has_side_effects: true,
                may_throw: true,
                ..SyntaxSummary::default()
            },
        );
        self.push_value(
            owner,
            ValueKind::SyntaxFragment(fragment),
            Origin::source(span),
            HirInstructionKind::SyntaxFragment {
                fragment,
                inputs: Vec::new(),
            },
            InstructionSemantics::CONSERVATIVE_EAGER,
        )
    }

    fn lower_jsx_node(&mut self, owner: FunctionId, node: &RawJsxNode) -> JsxNode {
        match node {
            RawJsxNode::Element {
                name,
                attributes,
                children,
                span,
            } => {
                let name = match name {
                    RawJsxName::Intrinsic(name) => JsxElementName::Intrinsic(name.clone()),
                    RawJsxName::Component(symbol) => {
                        self.symbol_to_binding.get(symbol).copied().map_or_else(
                            || JsxElementName::Dynamic(self.syntax_value(owner, *span, Vec::new())),
                            JsxElementName::Component,
                        )
                    }
                    RawJsxName::Member { root, properties } => {
                        self.symbol_to_binding.get(root).copied().map_or_else(
                            || JsxElementName::Dynamic(self.syntax_value(owner, *span, Vec::new())),
                            |root| JsxElementName::Member {
                                root,
                                properties: properties.clone(),
                            },
                        )
                    }
                    RawJsxName::Dynamic(name_span) => JsxElementName::Dynamic(self.syntax_value(
                        owner,
                        *name_span,
                        self.referenced_bindings(*name_span),
                    )),
                };
                let attributes = attributes
                    .iter()
                    .map(|attribute| match attribute {
                        RawJsxAttribute::Named { name, value, span } => JsxAttribute::Named {
                            name: name.clone(),
                            value: match value {
                                RawJsxAttributeValue::ImplicitTrue => {
                                    JsxAttributeValue::ImplicitTrue
                                }
                                RawJsxAttributeValue::Text(text) => {
                                    JsxAttributeValue::Text(text.clone())
                                }
                                RawJsxAttributeValue::Expression(expression) => {
                                    JsxAttributeValue::Expression(self.syntax_value(
                                        owner,
                                        *expression,
                                        self.referenced_bindings(*expression),
                                    ))
                                }
                                RawJsxAttributeValue::Node(node) => JsxAttributeValue::Node(
                                    Box::new(self.lower_jsx_node(owner, node)),
                                ),
                            },
                            origin: Origin::source(*span),
                        },
                        RawJsxAttribute::Spread { expression, span } => JsxAttribute::Spread {
                            value: self.syntax_value(
                                owner,
                                *expression,
                                self.referenced_bindings(*expression),
                            ),
                            origin: Origin::source(*span),
                        },
                    })
                    .collect();
                let children = children
                    .iter()
                    .map(|child| self.lower_jsx_child(owner, child))
                    .collect();
                JsxNode::Element(JsxElement {
                    name,
                    attributes,
                    children,
                    origin: Origin::source(*span),
                })
            }
            RawJsxNode::Fragment { children, span } => JsxNode::Fragment {
                children: children
                    .iter()
                    .map(|child| self.lower_jsx_child(owner, child))
                    .collect(),
                origin: Origin::source(*span),
            },
        }
    }

    fn lower_jsx_child(&mut self, owner: FunctionId, child: &RawJsxChild) -> JsxChild {
        match child {
            RawJsxChild::Text { value, span } => JsxChild::Text {
                value: value.clone(),
                origin: Origin::source(*span),
            },
            RawJsxChild::Expression(span) => JsxChild::Expression {
                value: self.syntax_value(owner, *span, self.referenced_bindings(*span)),
                origin: Origin::source(*span),
            },
            RawJsxChild::Node(node) => JsxChild::Node(Box::new(self.lower_jsx_node(owner, node))),
            RawJsxChild::Spread { expression, span } => JsxChild::Spread {
                value: self.syntax_value(owner, *expression, self.referenced_bindings(*expression)),
                origin: Origin::source(*span),
            },
        }
    }

    fn push_value(
        &mut self,
        owner: FunctionId,
        kind: ValueKind,
        origin: Origin,
        instruction_kind: HirInstructionKind,
        semantics: InstructionSemantics,
    ) -> ValueId {
        let function = &mut self.functions[owner.as_usize()];
        let value = ValueId::new(count_u32(function.values.len()));
        function.values.push(HirValue {
            id: value,
            kind,
            origin,
        });
        function.blocks[0].instructions.push(HirInstruction {
            result: Some(value),
            kind: instruction_kind,
            semantics,
            origin,
        });
        value
    }

    fn referenced_bindings(&self, span: SourceSpan) -> Vec<BindingId> {
        let mut references: Vec<_> = self
            .semantic
            .scoping()
            .symbol_ids()
            .filter_map(|symbol| {
                let binding = self.symbol_to_binding.get(&symbol).copied()?;
                let first = self
                    .semantic
                    .scoping()
                    .get_resolved_reference_ids(symbol)
                    .iter()
                    .filter_map(|reference| {
                        let reference = self.semantic.scoping().get_reference(*reference);
                        let reference_span = source_span(self.semantic.reference_span(reference));
                        (reference_span.start() >= span.start()
                            && reference_span.end() <= span.end())
                        .then_some(reference_span.start())
                    })
                    .min()?;
                Some((first, binding))
            })
            .collect();
        references.sort_unstable();
        references.into_iter().map(|(_, binding)| binding).collect()
    }

    fn directly_referenced_bindings(&self, function: &FunctionFact) -> Vec<BindingId> {
        let nested_spans: Vec<_> = self
            .function_facts
            .iter()
            .filter(|candidate| {
                candidate.id != function.id
                    && candidate.span.start() >= function.body_span.start()
                    && candidate.span.end() <= function.body_span.end()
            })
            .map(|candidate| candidate.span)
            .collect();
        let mut references: Vec<_> = self
            .semantic
            .scoping()
            .symbol_ids()
            .filter_map(|symbol| {
                let binding = self.symbol_to_binding.get(&symbol).copied()?;
                let first = self
                    .semantic
                    .scoping()
                    .get_resolved_reference_ids(symbol)
                    .iter()
                    .filter_map(|reference| {
                        let reference = self.semantic.scoping().get_reference(*reference);
                        let reference_span = source_span(self.semantic.reference_span(reference));
                        (reference_span.start() >= function.body_span.start()
                            && reference_span.end() <= function.body_span.end()
                            && !nested_spans.iter().any(|nested| {
                                reference_span.start() >= nested.start()
                                    && reference_span.end() <= nested.end()
                            }))
                        .then_some(reference_span.start())
                    })
                    .min()?;
                Some((first, binding))
            })
            .collect();
        references.sort_unstable();
        references.into_iter().map(|(_, binding)| binding).collect()
    }

    fn add_fragment(
        &mut self,
        kind: SyntaxFragmentKind,
        span: SourceSpan,
        mut summary: SyntaxSummary,
    ) -> SyntaxFragmentId {
        let mut seen = BTreeSet::new();
        summary
            .referenced_bindings
            .retain(|binding| seen.insert(*binding));
        let id = SyntaxFragmentId::new(count_u32(self.syntax_fragments.len()));
        let origin = Origin::source(span);
        self.syntax_fragments.push(SyntaxFragment {
            id,
            kind,
            origin,
            summary,
        });
        self.adapter_fragments.push(OxcSyntaxFragment {
            id,
            kind,
            source: source_slice(self.source, span)
                .unwrap_or_default()
                .to_string(),
            span,
        });
        id
    }

    fn finish(mut self) -> HirBuildOutput {
        let parameter_symbols: BTreeSet<_> = self
            .function_facts
            .iter()
            .flat_map(|function| function.parameters.iter())
            .flat_map(|parameter| parameter.bindings.iter().copied())
            .collect();
        let scopes = build_hir_scopes(self.semantic.scoping(), self.frontend.source.source_len);
        let bindings = build_hir_bindings(&self.frontend, &self.old_to_new, &parameter_symbols);
        let hir = HirFile {
            id: FileId::new(0),
            source_len: self.frontend.source.source_len,
            root_function: FunctionId::new(0),
            scopes,
            bindings,
            functions: self.functions,
            templates: self.templates,
            syntax_fragments: self.syntax_fragments,
        };
        if let Err(verification) = verify_hir(&hir) {
            self.diagnostics.extend(verification.into_sorted());
        }
        let has_errors = self
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error);
        HirBuildOutput {
            hir: (!has_errors).then_some(hir),
            frontend: Some(self.frontend),
            syntax_fragments: self.adapter_fragments,
            diagnostics: sorted(self.diagnostics),
        }
    }
}

#[derive(Debug, Clone)]
struct JsxFact {
    owner: FunctionId,
    span: SourceSpan,
    root: RawJsxNode,
}

#[derive(Debug, Clone)]
enum RawJsxNode {
    Element {
        name: RawJsxName,
        attributes: Vec<RawJsxAttribute>,
        children: Vec<RawJsxChild>,
        span: SourceSpan,
    },
    Fragment {
        children: Vec<RawJsxChild>,
        span: SourceSpan,
    },
}

#[derive(Debug, Clone)]
enum RawJsxName {
    Intrinsic(String),
    Component(SymbolId),
    Member {
        root: SymbolId,
        properties: Vec<String>,
    },
    Dynamic(SourceSpan),
}

#[derive(Debug, Clone)]
enum RawJsxAttribute {
    Named {
        name: String,
        value: RawJsxAttributeValue,
        span: SourceSpan,
    },
    Spread {
        expression: SourceSpan,
        span: SourceSpan,
    },
}

#[derive(Debug, Clone)]
enum RawJsxAttributeValue {
    ImplicitTrue,
    Text(String),
    Expression(SourceSpan),
    Node(Box<RawJsxNode>),
}

#[derive(Debug, Clone)]
enum RawJsxChild {
    Text {
        value: String,
        span: SourceSpan,
    },
    Expression(SourceSpan),
    Node(Box<RawJsxNode>),
    Spread {
        expression: SourceSpan,
        span: SourceSpan,
    },
}

struct JsxCollector<'facts> {
    scoping: &'facts Scoping,
    stack: Vec<FunctionId>,
    function_by_span: &'facts BTreeMap<(u32, u32), FunctionId>,
    roots: Vec<JsxFact>,
}

impl<'a> Visit<'a> for JsxCollector<'_> {
    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        let Some(id) = self
            .function_by_span
            .get(&(function.span.start, function.span.end))
            .copied()
        else {
            return;
        };
        self.stack.push(id);
        walk_function(self, function, flags);
        self.stack.pop();
    }

    fn visit_arrow_function_expression(&mut self, function: &ArrowFunctionExpression<'a>) {
        let Some(id) = self
            .function_by_span
            .get(&(function.span.start, function.span.end))
            .copied()
        else {
            return;
        };
        self.stack.push(id);
        walk_arrow_function_expression(self, function);
        self.stack.pop();
    }

    fn visit_jsx_element(&mut self, element: &JSXElement<'a>) {
        self.roots.push(JsxFact {
            owner: *self.stack.last().expect("module JSX owner"),
            span: source_span(element.span),
            root: raw_jsx_element(self.scoping, element),
        });
    }

    fn visit_jsx_fragment(&mut self, fragment: &JSXFragment<'a>) {
        self.roots.push(JsxFact {
            owner: *self.stack.last().expect("module JSX owner"),
            span: source_span(fragment.span),
            root: raw_jsx_fragment(self.scoping, fragment),
        });
    }
}

fn raw_jsx_element(scoping: &Scoping, element: &JSXElement<'_>) -> RawJsxNode {
    RawJsxNode::Element {
        name: raw_jsx_name(scoping, &element.opening_element.name),
        attributes: element
            .opening_element
            .attributes
            .iter()
            .map(|attribute| raw_jsx_attribute(scoping, attribute))
            .collect(),
        children: element
            .children
            .iter()
            .filter_map(|child| raw_jsx_child(scoping, child))
            .collect(),
        span: source_span(element.span),
    }
}

fn raw_jsx_fragment(scoping: &Scoping, fragment: &JSXFragment<'_>) -> RawJsxNode {
    RawJsxNode::Fragment {
        children: fragment
            .children
            .iter()
            .filter_map(|child| raw_jsx_child(scoping, child))
            .collect(),
        span: source_span(fragment.span),
    }
}

fn raw_jsx_name(scoping: &Scoping, name: &OxcJsxElementName<'_>) -> RawJsxName {
    match name {
        OxcJsxElementName::Identifier(identifier) => {
            RawJsxName::Intrinsic(identifier.name.to_string())
        }
        OxcJsxElementName::IdentifierReference(identifier) => identifier
            .reference_id
            .get()
            .and_then(|reference| scoping.get_reference(reference).symbol_id())
            .map_or_else(
                || RawJsxName::Dynamic(source_span(identifier.span)),
                RawJsxName::Component,
            ),
        OxcJsxElementName::NamespacedName(name) => {
            RawJsxName::Intrinsic(format!("{}:{}", name.namespace.name, name.name.name))
        }
        OxcJsxElementName::MemberExpression(member) => raw_jsx_member_name(scoping, member),
        OxcJsxElementName::ThisExpression(expression) => {
            RawJsxName::Dynamic(source_span(expression.span))
        }
    }
}

fn raw_jsx_member_name(scoping: &Scoping, member: &JSXMemberExpression<'_>) -> RawJsxName {
    let mut properties = vec![member.property.name.to_string()];
    let mut object = &member.object;
    loop {
        match object {
            JSXMemberExpressionObject::IdentifierReference(identifier) => {
                return identifier
                    .reference_id
                    .get()
                    .and_then(|reference| scoping.get_reference(reference).symbol_id())
                    .map_or_else(
                        || RawJsxName::Dynamic(source_span(member.span)),
                        |root| {
                            properties.reverse();
                            RawJsxName::Member { root, properties }
                        },
                    );
            }
            JSXMemberExpressionObject::MemberExpression(parent) => {
                properties.push(parent.property.name.to_string());
                object = &parent.object;
            }
            JSXMemberExpressionObject::ThisExpression(_) => {
                return RawJsxName::Dynamic(source_span(member.span));
            }
        }
    }
}

fn raw_jsx_attribute(scoping: &Scoping, attribute: &JSXAttributeItem<'_>) -> RawJsxAttribute {
    match attribute {
        JSXAttributeItem::Attribute(attribute) => RawJsxAttribute::Named {
            name: match &attribute.name {
                JSXAttributeName::Identifier(name) => name.name.to_string(),
                JSXAttributeName::NamespacedName(name) => {
                    format!("{}:{}", name.namespace.name, name.name.name)
                }
            },
            value: attribute
                .value
                .as_ref()
                .map_or(RawJsxAttributeValue::ImplicitTrue, |value| {
                    raw_jsx_attribute_value(scoping, value)
                }),
            span: source_span(attribute.span),
        },
        JSXAttributeItem::SpreadAttribute(attribute) => RawJsxAttribute::Spread {
            expression: source_span(attribute.argument.span()),
            span: source_span(attribute.span),
        },
    }
}

fn raw_jsx_attribute_value(
    scoping: &Scoping,
    value: &OxcJsxAttributeValue<'_>,
) -> RawJsxAttributeValue {
    match value {
        OxcJsxAttributeValue::StringLiteral(literal) => {
            RawJsxAttributeValue::Text(literal.value.to_string())
        }
        OxcJsxAttributeValue::ExpressionContainer(container) => container
            .expression
            .as_expression()
            .map_or(RawJsxAttributeValue::ImplicitTrue, |expression| {
                RawJsxAttributeValue::Expression(source_span(expression.span()))
            }),
        OxcJsxAttributeValue::Element(element) => {
            RawJsxAttributeValue::Node(Box::new(raw_jsx_element(scoping, element)))
        }
        OxcJsxAttributeValue::Fragment(fragment) => {
            RawJsxAttributeValue::Node(Box::new(raw_jsx_fragment(scoping, fragment)))
        }
    }
}

fn raw_jsx_child(scoping: &Scoping, child: &OxcJsxChild<'_>) -> Option<RawJsxChild> {
    match child {
        OxcJsxChild::Text(text) => Some(RawJsxChild::Text {
            value: text.value.to_string(),
            span: source_span(text.span),
        }),
        OxcJsxChild::Element(element) => Some(RawJsxChild::Node(Box::new(raw_jsx_element(
            scoping, element,
        )))),
        OxcJsxChild::Fragment(fragment) => Some(RawJsxChild::Node(Box::new(raw_jsx_fragment(
            scoping, fragment,
        )))),
        OxcJsxChild::ExpressionContainer(container) => match &container.expression {
            JSXExpression::EmptyExpression(_) => None,
            expression => expression
                .as_expression()
                .map(|expression| RawJsxChild::Expression(source_span(expression.span()))),
        },
        OxcJsxChild::Spread(spread) => Some(RawJsxChild::Spread {
            expression: source_span(spread.expression.span()),
            span: source_span(spread.span),
        }),
    }
}

#[derive(Debug, Clone)]
struct ArgumentFact {
    span: SourceSpan,
    spread: bool,
    function: Option<FunctionId>,
}

#[derive(Debug, Clone)]
struct CallFact {
    owner: FunctionId,
    span: SourceSpan,
    callee_span: SourceSpan,
    binding: Option<BindingId>,
    arguments: Vec<ArgumentFact>,
    callback: Option<FunctionId>,
    optional: bool,
    pure: bool,
}

struct CallCollector<'facts, 'semantic> {
    scoping: &'semantic Scoping,
    stack: Vec<FunctionId>,
    function_by_span: &'facts BTreeMap<(u32, u32), FunctionId>,
    symbol_to_binding: &'facts BTreeMap<SymbolId, BindingId>,
    calls: Vec<CallFact>,
}

impl CallCollector<'_, '_> {
    fn function_for_expression(&self, expression: &Expression<'_>) -> Option<FunctionId> {
        let span = expression.span();
        self.function_by_span.get(&(span.start, span.end)).copied()
    }
}

impl<'a> Visit<'a> for CallCollector<'_, '_> {
    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        let Some(id) = self
            .function_by_span
            .get(&(function.span.start, function.span.end))
            .copied()
        else {
            return;
        };
        self.stack.push(id);
        walk_function(self, function, flags);
        self.stack.pop();
    }

    fn visit_arrow_function_expression(&mut self, function: &ArrowFunctionExpression<'a>) {
        let Some(id) = self
            .function_by_span
            .get(&(function.span.start, function.span.end))
            .copied()
        else {
            return;
        };
        self.stack.push(id);
        walk_arrow_function_expression(self, function);
        self.stack.pop();
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        let binding = resolved_callee_symbol(self.scoping, &call.callee)
            .and_then(|symbol| self.symbol_to_binding.get(&symbol).copied());
        let arguments: Vec<_> = call
            .arguments
            .iter()
            .map(|argument| {
                let (span, spread, function) = if let Some(expression) = argument.as_expression() {
                    (
                        source_span(expression.span()),
                        false,
                        self.function_for_expression(expression),
                    )
                } else if let oxc::ast::ast::Argument::SpreadElement(spread) = argument {
                    (source_span(spread.span), true, None)
                } else {
                    unreachable!("every call argument is an expression or spread")
                };
                ArgumentFact {
                    span,
                    spread,
                    function,
                }
            })
            .collect();
        self.calls.push(CallFact {
            owner: *self.stack.last().expect("module call owner"),
            span: source_span(call.span),
            callee_span: source_span(call.callee.span()),
            binding,
            callback: arguments.first().and_then(|argument| argument.function),
            arguments,
            optional: call.optional,
            pure: call.pure,
        });
        walk_call_expression(self, call);
    }
}

fn resolved_callee_symbol(scoping: &Scoping, expression: &Expression<'_>) -> Option<SymbolId> {
    let mut current = expression;
    loop {
        current = match current {
            Expression::Identifier(identifier) => {
                let reference = scoping.get_reference(identifier.reference_id.get()?);
                return reference.symbol_id();
            }
            Expression::ParenthesizedExpression(expression) => &expression.expression,
            Expression::TSAsExpression(expression) => &expression.expression,
            Expression::TSSatisfiesExpression(expression) => &expression.expression,
            Expression::TSTypeAssertion(expression) => &expression.expression,
            Expression::TSNonNullExpression(expression) => &expression.expression,
            Expression::TSInstantiationExpression(expression) => &expression.expression,
            _ => return None,
        };
    }
}

fn build_hir_scopes(scoping: &Scoping, source_len: u32) -> Vec<HirScope> {
    scoping
        .scope_descendants_from_root()
        .enumerate()
        .map(|(index, scope)| {
            let flags = scoping.scope_flags(scope);
            HirScope {
                id: ScopeId::new(count_u32(index)),
                parent: scoping
                    .scope_parent_id(scope)
                    .map(|parent| ScopeId::new(count_u32(parent.index()))),
                kind: if flags.is_top() {
                    ScopeKind::Module
                } else if flags.is_function() {
                    ScopeKind::Function
                } else if flags.is_class_static_block() {
                    ScopeKind::ClassStaticBlock
                } else if flags.is_catch_clause() {
                    ScopeKind::Catch
                } else if flags.is_with() {
                    ScopeKind::With
                } else {
                    ScopeKind::Block
                },
                origin: if index == 0 {
                    Origin::source(SourceSpan::new(0, source_len).expect("source length span"))
                } else {
                    Origin::generated(None, fict_hir::GeneratedOrigin::Bookkeeping)
                },
            }
        })
        .collect()
}

fn build_hir_bindings(
    frontend: &FrontendSummary,
    old_to_new: &BTreeMap<u32, BindingId>,
    parameter_symbols: &BTreeSet<SymbolId>,
) -> Vec<Binding> {
    frontend
        .bindings
        .iter()
        .filter(|binding| binding.is_runtime)
        .map(|binding| Binding {
            id: old_to_new[&binding.id.index()],
            scope: binding.scope,
            kind: if parameter_symbols.contains(&SymbolId::from_usize(binding.id.as_usize())) {
                BindingKind::Parameter
            } else {
                match binding.kind {
                    FrontendBindingKind::Var => BindingKind::Var,
                    FrontendBindingKind::Let => BindingKind::Let,
                    FrontendBindingKind::Const => BindingKind::Const,
                    FrontendBindingKind::Function => BindingKind::Function,
                    FrontendBindingKind::Class => BindingKind::Class,
                    FrontendBindingKind::Import => BindingKind::Import,
                    FrontendBindingKind::Catch => BindingKind::Catch,
                    FrontendBindingKind::Enum | FrontendBindingKind::Namespace => {
                        BindingKind::Namespace
                    }
                    FrontendBindingKind::TypeOnly
                    | FrontendBindingKind::Ambient
                    | FrontendBindingKind::Other => BindingKind::Synthetic,
                }
            },
            display_name: binding.display_name.clone(),
            import: binding.import.clone(),
            origin: Origin::source(binding.declaration_span),
        })
        .collect()
}

fn classify_named_function(name: Option<&str>) -> FunctionKind {
    let Some(name) = name else {
        return FunctionKind::Plain;
    };
    if is_hook_name(name) {
        FunctionKind::Hook
    } else if name.chars().next().is_some_and(char::is_uppercase) {
        FunctionKind::Component
    } else {
        FunctionKind::Plain
    }
}

fn declaration_kind(kind: FrontendBindingKind) -> DeclarationKind {
    match kind {
        FrontendBindingKind::Var => DeclarationKind::Var,
        FrontendBindingKind::Let => DeclarationKind::Let,
        FrontendBindingKind::Const | FrontendBindingKind::Enum | FrontendBindingKind::Namespace => {
            DeclarationKind::Const
        }
        FrontendBindingKind::Function => DeclarationKind::Function,
        FrontendBindingKind::Class => DeclarationKind::Class,
        FrontendBindingKind::Import => DeclarationKind::Import,
        FrontendBindingKind::Catch => DeclarationKind::Catch,
        FrontendBindingKind::TypeOnly
        | FrontendBindingKind::Ambient
        | FrontendBindingKind::Other => DeclarationKind::Generated,
    }
}

fn is_hook_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("use") else {
        return false;
    };
    rest.chars()
        .next()
        .is_some_and(|character| character.is_uppercase() || character.is_ascii_digit())
}

fn source_span(span: Span) -> SourceSpan {
    SourceSpan::new(span.start, span.end).expect("OXC spans are ordered")
}

fn source_slice(source: &str, span: SourceSpan) -> Option<&str> {
    source.get(span.start() as usize..span.end() as usize)
}

fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn error(code: &'static str, message: &'static str, span: SourceSpan) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("HIR diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_primary_span(span)
    .with_guarantee_class(GuaranteeClass::Unsupported)
}
