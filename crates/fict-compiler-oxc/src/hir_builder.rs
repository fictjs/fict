use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use fict_hir::{
    Binding, BindingId, BindingKind, BlockId, CallArgument, CallHost, CallInstruction,
    CompoundAssignmentOperator, DeclarationKind, EvaluationMode, FictMacroKind, FileId,
    FunctionFlags, FunctionId, FunctionKind, HirBlock, HirFile, HirFunction, HirInstruction,
    HirInstructionKind, HirLocal, HirParameter, HirScope, HirTerminator, HirValue,
    InstructionSemantics, JsxAttribute, JsxAttributeValue, JsxChild, JsxElement, JsxElementName,
    JsxNode, JsxTemplate, LocalId, LocalKind, MutationEffect, Origin, PatternSummary, Purity,
    ReactiveCallKind, ReactiveScopeHost, ReactiveScopeKind, RegionId, ScopeId, ScopeKind,
    SyntaxFragment, SyntaxFragmentId, SyntaxFragmentKind, SyntaxSummary, TemplateId,
    TerminatorKind, UpdateOperator, ValueId, ValueKind, verify_hir,
};
use oxc::{
    allocator::Allocator,
    ast::{
        ast::{
            ArrowFunctionExpression, AssignmentExpression, AssignmentPattern, AssignmentTarget,
            BindingIdentifier, BindingPattern, BindingRestElement, CallExpression, Expression,
            FormalParameters, Function, JSXAttributeItem, JSXAttributeName,
            JSXAttributeValue as OxcJsxAttributeValue, JSXChild as OxcJsxChild, JSXElement,
            JSXElementName as OxcJsxElementName, JSXExpression, JSXFragment, JSXMemberExpression,
            JSXMemberExpressionObject, MemberExpression, Program, SimpleAssignmentTarget,
            UpdateExpression, VariableDeclarator,
        },
        ast_kind::AstKind,
    },
    ast_visit::{
        Visit,
        walk::{
            walk_arrow_function_expression, walk_assignment_pattern, walk_binding_rest_element,
            walk_call_expression, walk_function, walk_jsx_element, walk_variable_declarator,
        },
    },
    parser::{ParseOptions, Parser},
    semantic::{Scoping, Semantic, SemanticBuilder},
    span::{GetSpan, Span},
    syntax::{
        operator::{
            AssignmentOperator as OxcAssignmentOperator, UpdateOperator as OxcUpdateOperator,
        },
        scope::ScopeFlags,
        symbol::SymbolId,
    },
};

use crate::{
    FictDirectiveKind, FrontendBindingKind, FrontendSummary, OxcCompileOptions, OxcSourceLanguage,
    analyze_frontend, analyze_typescript_compatibility,
};

use super::compile::{convert_diagnostics, sorted, source_type};

/// Binding-aware frontend controls that affect HIR classification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HirBuildOptions {
    /// Direct-call hosts whose first callback is a reactive scope.
    ///
    /// Names are resolved once in the file root. Every HIR call and callback
    /// then carries the resolved [`BindingId`], never the spelling.
    pub reactive_scopes: Vec<String>,
    /// Reject non-guaranteed nested state mutations instead of emitting a fallback warning.
    pub strict_guarantee: bool,
}

impl Default for HirBuildOptions {
    fn default() -> Self {
        Self {
            reactive_scopes: Vec::new(),
            strict_guarantee: true,
        }
    }
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
    reactive_bindings: BTreeMap<BindingId, ReactiveCallKind>,
    reactive_namespace_sources: BTreeMap<BindingId, String>,
    configured_bindings: BTreeSet<BindingId>,
    reactive_functions: BTreeMap<FunctionId, ReactiveScopeKind>,
    strict_guarantee: bool,
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
        let mut reactive_bindings = BTreeMap::new();
        let mut reactive_namespace_sources = BTreeMap::new();
        for binding in &frontend.bindings {
            let Some(mapped) = old_to_new.get(&binding.id.index()).copied() else {
                continue;
            };
            let Some(import) = &binding.import else {
                continue;
            };
            match &import.imported {
                fict_hir::ImportedName::Named(name) => {
                    if let Some(kind) = runtime_reactive_call_kind(&import.source, name) {
                        reactive_bindings.insert(mapped, kind);
                    }
                }
                fict_hir::ImportedName::Namespace
                    if runtime_reactive_namespace_source(&import.source) =>
                {
                    reactive_namespace_sources.insert(mapped, import.source.clone());
                }
                fict_hir::ImportedName::Default | fict_hir::ImportedName::Namespace => {}
            }
        }
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
            reactive_bindings,
            reactive_namespace_sources,
            configured_bindings,
            reactive_functions: BTreeMap::new(),
            strict_guarantee: options.strict_guarantee,
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
        let reactive_bindings = self.reactive_bindings.clone();
        let reactive_namespace_sources = self.reactive_namespace_sources.clone();
        let hook_bindings: BTreeSet<_> = self
            .functions
            .iter()
            .filter(|function| function.kind == FunctionKind::Hook)
            .filter_map(|function| function.binding)
            .chain(self.frontend.bindings.iter().filter_map(|binding| {
                (binding.kind == FrontendBindingKind::Import && is_hook_name(&binding.display_name))
                    .then(|| self.old_to_new.get(&binding.id.index()).copied())
                    .flatten()
            }))
            .collect();
        let namespace_imports: BTreeSet<_> =
            self.frontend
                .bindings
                .iter()
                .filter(|binding| {
                    binding.kind == FrontendBindingKind::Import
                        && binding.import.as_ref().is_some_and(|import| {
                            import.imported == fict_hir::ImportedName::Namespace
                        })
                })
                .filter_map(|binding| self.old_to_new.get(&binding.id.index()).copied())
                .collect();
        let mut calls = CallCollector {
            scoping: self.semantic.scoping(),
            stack: vec![FunctionId::new(0)],
            function_by_span: &function_by_span,
            symbol_to_binding: &symbol_to_binding,
            hook_bindings: &hook_bindings,
            namespace_imports: &namespace_imports,
            reactive_bindings: &reactive_bindings,
            reactive_namespace_sources: &reactive_namespace_sources,
            context: PlacementContext::default(),
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
        let mut mutations = MutationCollector {
            scoping: self.semantic.scoping(),
            facts: Vec::new(),
        };
        mutations.visit_program(program);
        for root in &jsx.roots {
            if root.owner != FunctionId::new(0)
                && self.functions[root.owner.as_usize()].kind == FunctionKind::Plain
            {
                self.functions[root.owner.as_usize()].kind = FunctionKind::Component;
            }
        }
        self.apply_call_classification(&calls.calls);
        self.validate_macro_placement(&calls.calls);
        self.validate_hook_placement(&calls.calls);
        self.populate_function_bodies(&calls.calls, &mutations.facts, &jsx.roots);
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
                self.reactive_functions.insert(callback, kind);
            }
        }
    }

    fn validate_macro_placement(&mut self, calls: &[CallFact]) {
        for call in calls {
            let Some(macro_kind) = call
                .binding
                .and_then(|binding| self.macro_bindings.get(&binding).copied())
            else {
                continue;
            };
            match macro_kind {
                FictMacroKind::State => {
                    match call.direct_variable {
                        None => {
                            self.diagnostics.push(
                                error(
                                    "FICT-PLACEMENT-STATE-TARGET",
                                    "$state() must be assigned directly to a variable",
                                    call.span,
                                )
                                .with_help("use `let value = $state(initialValue)`"),
                            );
                            continue;
                        }
                        Some(false) => {
                            self.diagnostics.push(
                                error(
                                    "FICT-PLACEMENT-STATE-DESTRUCTURE",
                                    "destructuring a $state() result is not supported",
                                    call.span,
                                )
                                .with_help("assign the state to one identifier, then destructure a read-only alias"),
                            );
                            continue;
                        }
                        Some(true) => {}
                    }
                    if self.is_placement_nested(call.owner) {
                        self.diagnostics.push(
                            error(
                                "FICT-PLACEMENT-STATE-NESTED",
                                "$state() cannot be declared inside nested functions",
                                call.span,
                            )
                            .with_help("move the state declaration to the component top level or extract a hook"),
                        );
                        continue;
                    }
                    if !self.is_reactive_owner(call.owner, false) {
                        self.diagnostics.push(
                            error(
                                "FICT-PLACEMENT-STATE-OWNER",
                                "$state() must be declared inside a component or hook function body",
                                call.span,
                            )
                            .with_help("use $store or createSignal for module-level shared state")
                        );
                        continue;
                    }
                    if !call.immediate_statement || call.conditional_or_loop {
                        self.diagnostics.push(
                            error(
                                "FICT-PLACEMENT-STATE-CONTROL",
                                "$state() cannot be declared inside loops, conditionals, or nested blocks",
                                call.span,
                            )
                            .with_help("move the state declaration to the component or hook top level"),
                        );
                    }
                }
                FictMacroKind::Effect => {
                    if self.is_placement_nested(call.owner) {
                        self.diagnostics.push(
                            error(
                                "FICT-PLACEMENT-EFFECT-NESTED",
                                "$effect() cannot be called inside nested functions",
                                call.span,
                            )
                            .with_help(
                                "move the effect to the component top level or extract a hook",
                            ),
                        );
                        continue;
                    }
                    if !self.is_reactive_owner(call.owner, true) {
                        self.diagnostics.push(
                            error(
                                "FICT-PLACEMENT-EFFECT-OWNER",
                                "$effect() must be called inside a component or hook, or at module top level",
                                call.span,
                            )
                        );
                        continue;
                    }
                    if call.conditional_or_loop
                        || (!call.immediate_effect_statement && !call.immediate_default_export)
                    {
                        self.diagnostics.push(
                            error(
                                "FICT-PLACEMENT-EFFECT-CONTROL",
                                "$effect() cannot be called inside loops, conditionals, or nested blocks",
                                call.span,
                            )
                            .with_help("move the effect registration to the reactive owner top level"),
                        );
                    }
                }
                FictMacroKind::Memo => {
                    if call.conditional_or_loop {
                        self.diagnostics.push(
                            error(
                                "FICT-PLACEMENT-MEMO-CONTROL",
                                "$memo() cannot be called inside loops, conditionals, or nested blocks",
                                call.span,
                            )
                            .with_help("move the memo creation to the component or module top level"),
                        );
                    }
                }
            }
        }
    }

    fn validate_hook_placement(&mut self, calls: &[CallFact]) {
        for call in calls {
            let Some(hook) = &call.hook else {
                continue;
            };
            let nested = self.is_placement_nested(call.owner);
            match hook {
                HookCall::Direct { display_name } => {
                    if !self.is_reactive_owner(call.owner, false) {
                        self.diagnostics.push(
                            error(
                                "FICT-PLACEMENT-HOOK-OWNER",
                                "hook calls must be made inside a component or hook",
                                call.span,
                            )
                            .with_note(format!("resolved hook call: {display_name}()")),
                        );
                    } else if nested || call.conditional_or_loop {
                        self.diagnostics.push(
                            error(
                                "FICT-PLACEMENT-HOOK-CONTROL",
                                "hook calls must be made at the top level of a component or hook",
                                call.span,
                            )
                            .with_note(format!("resolved hook call: {display_name}()")),
                        );
                    }
                }
                HookCall::Member {
                    display_name,
                    namespace_import,
                } => {
                    let placement_sensitive = nested || call.conditional_or_loop;
                    if !namespace_import && !placement_sensitive {
                        continue;
                    }
                    if self.reactive_ancestor(call.owner).is_none() {
                        if *namespace_import {
                            self.diagnostics.push(
                                error(
                                    "FICT-PLACEMENT-HOOK-OWNER",
                                    "namespace hook calls must be made inside a component or hook",
                                    call.span,
                                )
                                .with_note(format!("resolved hook call: {display_name}()")),
                            );
                        }
                    } else if placement_sensitive {
                        self.diagnostics.push(error(
                            "FICT-PLACEMENT-HOOK-CONTROL",
                            "member hook calls must be made at the top level of a component or hook",
                            call.span,
                        ).with_note(format!("resolved hook call: {display_name}()")));
                    }
                }
            }
        }
    }

    fn is_reactive_owner(&self, function: FunctionId, allow_module: bool) -> bool {
        match self.functions[function.as_usize()].kind {
            FunctionKind::Module => allow_module,
            FunctionKind::Component | FunctionKind::Hook => true,
            FunctionKind::ReactiveScope => {
                self.reactive_functions.get(&function) == Some(&ReactiveScopeKind::Configured)
            }
            FunctionKind::Plain => false,
        }
    }

    fn is_placement_nested(&self, function: FunctionId) -> bool {
        if self.reactive_functions.get(&function) == Some(&ReactiveScopeKind::Configured) {
            return false;
        }
        function != FunctionId::new(0)
            && self.function_facts[function.as_usize()].parent != FunctionId::new(0)
    }

    fn reactive_ancestor(&self, mut function: FunctionId) -> Option<FunctionId> {
        loop {
            if self.is_reactive_owner(function, false) {
                return Some(function);
            }
            if function == FunctionId::new(0) {
                return None;
            }
            function = self.function_facts[function.as_usize()].parent;
        }
    }

    fn populate_function_bodies(
        &mut self,
        calls: &[CallFact],
        mutations: &[MutationFact],
        jsx_roots: &[JsxFact],
    ) {
        let reactive_targets: BTreeSet<_> = calls
            .iter()
            .filter(|call| {
                call.binding
                    .and_then(|binding| self.macro_bindings.get(&binding))
                    .is_some_and(|kind| matches!(kind, FictMacroKind::State | FictMacroKind::Memo))
            })
            .filter_map(|call| call.direct_variable_binding)
            .collect();
        let reactive_reads = self.collect_reactive_reads(&reactive_targets);
        let reactive_mutations = self.collect_reactive_mutations(mutations, &reactive_targets);
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
                        reactive_kind: call.reactive_kind,
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
                if let Some(binding) = call.direct_variable_binding {
                    self.link_direct_call_declaration(fact.id, binding, value);
                }
                inputs.push(value);
            }

            for read in reactive_reads.iter().filter(|read| read.owner == fact.id) {
                let Some(local) = self.functions[fact.id.as_usize()]
                    .locals
                    .iter()
                    .find(|local| local.binding == Some(read.binding))
                    .map(|local| local.id)
                else {
                    continue;
                };
                let value = self.push_value(
                    fact.id,
                    ValueKind::InstructionResult,
                    Origin::source(read.span),
                    HirInstructionKind::Read {
                        place: fict_hir::Place::local(local),
                    },
                    InstructionSemantics {
                        purity: Purity::Unknown,
                        mutation: MutationEffect::None,
                        evaluation: EvaluationMode::Eager,
                        may_throw: true,
                    },
                );
                inputs.push(value);
            }

            for mutation in reactive_mutations
                .iter()
                .filter(|mutation| mutation.owner == fact.id)
            {
                let Some(local) = self.functions[fact.id.as_usize()]
                    .locals
                    .iter()
                    .find(|local| local.binding == Some(mutation.binding))
                    .map(|local| local.id)
                else {
                    continue;
                };
                match mutation.kind {
                    ReactiveMutationKind::Write { value_span } => {
                        let value = self.syntax_value(
                            fact.id,
                            value_span,
                            self.referenced_bindings(value_span),
                        );
                        self.functions[fact.id.as_usize()].blocks[0]
                            .instructions
                            .push(HirInstruction {
                                result: None,
                                kind: HirInstructionKind::Write {
                                    place: fict_hir::Place::local(local),
                                    value,
                                },
                                semantics: reactive_mutation_semantics(),
                                origin: Origin::source(mutation.span),
                            });
                        inputs.push(value);
                    }
                    ReactiveMutationKind::Compound {
                        operator,
                        value_span,
                    } => {
                        let value = self.syntax_value(
                            fact.id,
                            value_span,
                            self.referenced_bindings(value_span),
                        );
                        let result = self.push_value(
                            fact.id,
                            ValueKind::InstructionResult,
                            Origin::source(mutation.span),
                            HirInstructionKind::ReadWrite {
                                place: fict_hir::Place::local(local),
                                compound: Some(operator),
                                value: Some(value),
                                update: None,
                                prefix: false,
                            },
                            reactive_mutation_semantics(),
                        );
                        inputs.extend([value, result]);
                    }
                    ReactiveMutationKind::Update { operator, prefix } => {
                        let result = self.push_value(
                            fact.id,
                            ValueKind::InstructionResult,
                            Origin::source(mutation.span),
                            HirInstructionKind::ReadWrite {
                                place: fict_hir::Place::local(local),
                                compound: None,
                                value: None,
                                update: Some(operator),
                                prefix,
                            },
                            reactive_mutation_semantics(),
                        );
                        inputs.push(result);
                    }
                }
            }

            for jsx in jsx_roots.iter().filter(|jsx| jsx.owner == fact.id) {
                let root = self.lower_jsx_node(fact.id, &jsx.root);
                let template = TemplateId::new(count_u32(self.templates.len()));
                self.templates.push(JsxTemplate {
                    id: template,
                    owner: fact.id,
                    root,
                    contains_fragment: jsx.contains_fragment,
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

    fn collect_reactive_reads(
        &self,
        reactive_targets: &BTreeSet<BindingId>,
    ) -> Vec<ReactiveReadFact> {
        let mut reads = Vec::new();
        for (symbol, binding) in &self.symbol_to_binding {
            if !reactive_targets.contains(binding) {
                continue;
            }
            for reference in self.semantic.scoping().get_resolved_reference_ids(*symbol) {
                let reference = self.semantic.scoping().get_reference(*reference);
                if !reference.is_read() || reference.is_write() {
                    continue;
                }
                let span = source_span(self.semantic.reference_span(reference));
                reads.push(ReactiveReadFact {
                    owner: self.function_owner_for_span(span),
                    binding: *binding,
                    span,
                });
            }
        }
        reads.sort_by_key(|read| (read.span.start(), read.span.end(), read.binding.index()));
        reads
    }

    fn collect_reactive_mutations(
        &mut self,
        mutations: &[MutationFact],
        reactive_targets: &BTreeSet<BindingId>,
    ) -> Vec<ReactiveMutationFact> {
        let mut facts = Vec::new();
        for mutation in mutations {
            let Some(binding) = self.symbol_to_binding.get(&mutation.symbol).copied() else {
                continue;
            };
            if !reactive_targets.contains(&binding) {
                continue;
            }
            if mutation.projected {
                self.diagnostics.push(
                    Diagnostic::new(
                        DiagnosticCode::new("FICT-M001").expect("diagnostic literal"),
                        if self.strict_guarantee {
                            DiagnosticSeverity::Error
                        } else {
                            DiagnosticSeverity::Warning
                        },
                        "nested mutation through a $state value cannot preserve fine-grained reactivity",
                    )
                    .with_primary_span(mutation.span)
                    .with_help("replace the whole state value or use $store for nested mutation")
                    .with_guarantee_class(GuaranteeClass::Fallback),
                );
                continue;
            }
            facts.push(ReactiveMutationFact {
                owner: self.function_owner_for_span(mutation.span),
                binding,
                span: mutation.span,
                kind: mutation.kind,
            });
        }
        facts.sort_by_key(|mutation| {
            (
                mutation.span.start(),
                mutation.span.end(),
                mutation.binding.index(),
            )
        });
        facts
    }

    fn function_owner_for_span(&self, span: SourceSpan) -> FunctionId {
        self.function_facts
            .iter()
            .filter(|function| {
                function.body_span.start() <= span.start() && function.body_span.end() >= span.end()
            })
            .min_by_key(|function| {
                function
                    .body_span
                    .end()
                    .saturating_sub(function.body_span.start())
            })
            .map_or(FunctionId::new(0), |function| function.id)
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

    fn link_direct_call_declaration(
        &mut self,
        owner: FunctionId,
        binding: BindingId,
        initializer: ValueId,
    ) {
        let function = &mut self.functions[owner.as_usize()];
        let Some(local) = function
            .locals
            .iter()
            .find(|local| local.binding == Some(binding))
            .map(|local| local.id)
        else {
            return;
        };
        let block = &mut function.blocks[0];
        let Some(index) = block.instructions.iter().position(|instruction| {
            matches!(
                instruction.kind,
                HirInstructionKind::Declare {
                    local: candidate,
                    ..
                } if candidate == local
            )
        }) else {
            return;
        };
        let mut declaration = block.instructions.remove(index);
        let HirInstructionKind::Declare {
            initializer: target,
            ..
        } = &mut declaration.kind
        else {
            unreachable!("selected declaration instruction")
        };
        *target = Some(initializer);
        block.instructions.push(declaration);
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
    contains_fragment: bool,
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
        let mut fragments = FragmentDetector::default();
        walk_jsx_element(&mut fragments, element);
        self.roots.push(JsxFact {
            owner: *self.stack.last().expect("module JSX owner"),
            span: source_span(element.span),
            root: raw_jsx_element(self.scoping, element),
            contains_fragment: fragments.found,
        });
    }

    fn visit_jsx_fragment(&mut self, fragment: &JSXFragment<'a>) {
        self.roots.push(JsxFact {
            owner: *self.stack.last().expect("module JSX owner"),
            span: source_span(fragment.span),
            root: raw_jsx_fragment(self.scoping, fragment),
            contains_fragment: true,
        });
    }
}

#[derive(Default)]
struct FragmentDetector {
    found: bool,
}

impl<'a> Visit<'a> for FragmentDetector {
    fn visit_jsx_fragment(&mut self, _fragment: &JSXFragment<'a>) {
        self.found = true;
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
            RawJsxAttributeValue::Text(crate::jsx_text::decode_entities(literal.value.as_str()))
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
        OxcJsxChild::Text(text) => {
            crate::jsx_text::normalize_text(text.value.as_str()).map(|value| RawJsxChild::Text {
                value,
                span: source_span(text.span),
            })
        }
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
    reactive_kind: Option<ReactiveCallKind>,
    arguments: Vec<ArgumentFact>,
    callback: Option<FunctionId>,
    direct_variable: Option<bool>,
    direct_variable_binding: Option<BindingId>,
    immediate_statement: bool,
    immediate_effect_statement: bool,
    immediate_default_export: bool,
    conditional_or_loop: bool,
    hook: Option<HookCall>,
    optional: bool,
    pure: bool,
}

#[derive(Debug, Clone, Copy)]
struct ReactiveReadFact {
    owner: FunctionId,
    binding: BindingId,
    span: SourceSpan,
}

#[derive(Debug, Clone, Copy)]
struct MutationFact {
    symbol: SymbolId,
    projected: bool,
    span: SourceSpan,
    kind: ReactiveMutationKind,
}

#[derive(Debug, Clone, Copy)]
struct ReactiveMutationFact {
    owner: FunctionId,
    binding: BindingId,
    span: SourceSpan,
    kind: ReactiveMutationKind,
}

#[derive(Debug, Clone, Copy)]
enum ReactiveMutationKind {
    Write {
        value_span: SourceSpan,
    },
    Compound {
        operator: CompoundAssignmentOperator,
        value_span: SourceSpan,
    },
    Update {
        operator: UpdateOperator,
        prefix: bool,
    },
}

#[derive(Debug, Clone)]
enum HookCall {
    Direct {
        display_name: String,
    },
    Member {
        display_name: String,
        namespace_import: bool,
    },
}

#[derive(Debug, Clone, Copy)]
struct VariableContext {
    initializer: Option<SourceSpan>,
    simple_identifier: bool,
    binding: Option<SymbolId>,
}

#[derive(Debug, Default)]
struct PlacementContext {
    block_depth: u32,
    control_depth: u32,
    function_baselines: Vec<(u32, u32)>,
    variables: Vec<VariableContext>,
    expression_statements: Vec<SourceSpan>,
    default_exports: Vec<SourceSpan>,
}

impl PlacementContext {
    fn enter(&mut self, kind: AstKind<'_>) {
        match kind {
            AstKind::Function(_) | AstKind::ArrowFunctionExpression(_) => self
                .function_baselines
                .push((self.block_depth, self.control_depth)),
            AstKind::BlockStatement(_) => self.block_depth = self.block_depth.saturating_add(1),
            AstKind::VariableDeclarator(declarator) => {
                self.variables.push(VariableContext {
                    initializer: declarator
                        .init
                        .as_ref()
                        .map(|init| source_span(init.span())),
                    simple_identifier: matches!(
                        declarator.id,
                        BindingPattern::BindingIdentifier(_)
                    ),
                    binding: match &declarator.id {
                        BindingPattern::BindingIdentifier(identifier) => identifier.symbol_id.get(),
                        _ => None,
                    },
                });
            }
            AstKind::ExpressionStatement(statement) => self
                .expression_statements
                .push(source_span(statement.expression.span())),
            AstKind::ExportDefaultDeclaration(declaration) => {
                self.default_exports
                    .push(declaration.declaration.as_expression().map_or_else(
                        || SourceSpan::empty(u32::MAX),
                        |expression| source_span(expression.span()),
                    ))
            }
            _ if is_control_context(kind) => {
                self.control_depth = self.control_depth.saturating_add(1);
            }
            _ => {}
        }
    }

    fn leave(&mut self, kind: AstKind<'_>) {
        match kind {
            AstKind::Function(_) | AstKind::ArrowFunctionExpression(_) => {
                self.function_baselines.pop();
            }
            AstKind::BlockStatement(_) => self.block_depth = self.block_depth.saturating_sub(1),
            AstKind::VariableDeclarator(_) => {
                self.variables.pop();
            }
            AstKind::ExpressionStatement(_) => {
                self.expression_statements.pop();
            }
            AstKind::ExportDefaultDeclaration(_) => {
                self.default_exports.pop();
            }
            _ if is_control_context(kind) => {
                self.control_depth = self.control_depth.saturating_sub(1);
            }
            _ => {}
        }
    }

    fn facts(&self, call: SourceSpan) -> (Option<bool>, Option<SymbolId>, bool, bool, bool, bool) {
        let (block_baseline, control_baseline) =
            self.function_baselines.last().copied().unwrap_or_default();
        let conditional_or_loop = self.control_depth > control_baseline;
        let immediate_statement = self.block_depth == block_baseline && !conditional_or_loop;
        let direct_variable = self.variables.last().and_then(|variable| {
            (variable.initializer == Some(call)).then_some(variable.simple_identifier)
        });
        let direct_variable_binding = self.variables.last().and_then(|variable| {
            (variable.initializer == Some(call))
                .then_some(variable.binding)
                .flatten()
        });
        let immediate_effect_statement =
            immediate_statement && self.expression_statements.last().copied() == Some(call);
        let immediate_default_export =
            immediate_statement && self.default_exports.last().copied() == Some(call);
        (
            direct_variable,
            direct_variable_binding,
            immediate_statement,
            immediate_effect_statement,
            immediate_default_export,
            conditional_or_loop,
        )
    }
}

fn is_control_context(kind: AstKind<'_>) -> bool {
    matches!(
        kind,
        AstKind::IfStatement(_)
            | AstKind::DoWhileStatement(_)
            | AstKind::WhileStatement(_)
            | AstKind::ForStatement(_)
            | AstKind::ForInStatement(_)
            | AstKind::ForOfStatement(_)
            | AstKind::SwitchStatement(_)
            | AstKind::ConditionalExpression(_)
            | AstKind::LogicalExpression(_)
    )
}

struct CallCollector<'facts, 'semantic> {
    scoping: &'semantic Scoping,
    stack: Vec<FunctionId>,
    function_by_span: &'facts BTreeMap<(u32, u32), FunctionId>,
    symbol_to_binding: &'facts BTreeMap<SymbolId, BindingId>,
    hook_bindings: &'facts BTreeSet<BindingId>,
    namespace_imports: &'facts BTreeSet<BindingId>,
    reactive_bindings: &'facts BTreeMap<BindingId, ReactiveCallKind>,
    reactive_namespace_sources: &'facts BTreeMap<BindingId, String>,
    context: PlacementContext,
    calls: Vec<CallFact>,
}

impl CallCollector<'_, '_> {
    fn function_for_expression(&self, expression: &Expression<'_>) -> Option<FunctionId> {
        let span = expression.span();
        self.function_by_span.get(&(span.start, span.end)).copied()
    }
}

impl<'a> Visit<'a> for CallCollector<'_, '_> {
    fn enter_node(&mut self, kind: AstKind<'a>) {
        self.context.enter(kind);
    }

    fn leave_node(&mut self, kind: AstKind<'a>) {
        self.context.leave(kind);
    }

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
        let call_span = source_span(call.span);
        let (
            direct_variable,
            direct_variable_symbol,
            immediate_statement,
            immediate_effect_statement,
            immediate_default_export,
            conditional_or_loop,
        ) = self.context.facts(call_span);
        let direct_variable_binding =
            direct_variable_symbol.and_then(|symbol| self.symbol_to_binding.get(&symbol).copied());
        let direct_binding = resolved_callee_symbol(self.scoping, &call.callee)
            .and_then(|symbol| self.symbol_to_binding.get(&symbol).copied());
        let namespace_reactive = namespace_reactive_call_kind(
            self.scoping,
            &call.callee,
            self.symbol_to_binding,
            self.reactive_namespace_sources,
        );
        let binding = direct_binding.or(namespace_reactive.map(|(binding, _)| binding));
        let reactive_kind = direct_binding
            .and_then(|binding| self.reactive_bindings.get(&binding).copied())
            .or(namespace_reactive.map(|(_, kind)| kind));
        let hook = classify_hook_call(
            self.scoping,
            &call.callee,
            self.symbol_to_binding,
            self.hook_bindings,
            self.namespace_imports,
        );
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
            span: call_span,
            callee_span: source_span(call.callee.span()),
            binding,
            reactive_kind,
            callback: arguments.first().and_then(|argument| argument.function),
            direct_variable,
            direct_variable_binding,
            immediate_statement,
            immediate_effect_statement,
            immediate_default_export,
            conditional_or_loop,
            hook,
            arguments,
            optional: call.optional,
            pure: call.pure,
        });
        walk_call_expression(self, call);
    }
}

struct MutationCollector<'semantic> {
    scoping: &'semantic Scoping,
    facts: Vec<MutationFact>,
}

impl<'a> Visit<'a> for MutationCollector<'_> {
    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        if let Some((symbol, projected)) = assignment_target_symbol(self.scoping, &assignment.left)
        {
            let kind = if assignment.operator == OxcAssignmentOperator::Assign {
                Some(ReactiveMutationKind::Write {
                    value_span: source_span(assignment.right.span()),
                })
            } else {
                compound_assignment_operator(assignment.operator).map(|operator| {
                    ReactiveMutationKind::Compound {
                        operator,
                        value_span: source_span(assignment.right.span()),
                    }
                })
            };
            if let Some(kind) = kind {
                self.facts.push(MutationFact {
                    symbol,
                    projected,
                    span: source_span(assignment.span),
                    kind,
                });
            }
        }
        oxc::ast_visit::walk::walk_assignment_expression(self, assignment);
    }

    fn visit_update_expression(&mut self, update: &UpdateExpression<'a>) {
        if let Some((symbol, projected)) =
            simple_assignment_target_symbol(self.scoping, &update.argument)
        {
            self.facts.push(MutationFact {
                symbol,
                projected,
                span: source_span(update.span),
                kind: ReactiveMutationKind::Update {
                    operator: match update.operator {
                        OxcUpdateOperator::Increment => UpdateOperator::Increment,
                        OxcUpdateOperator::Decrement => UpdateOperator::Decrement,
                    },
                    prefix: update.prefix,
                },
            });
        }
        oxc::ast_visit::walk::walk_update_expression(self, update);
    }
}

fn assignment_target_symbol(
    scoping: &Scoping,
    target: &AssignmentTarget<'_>,
) -> Option<(SymbolId, bool)> {
    match target {
        AssignmentTarget::AssignmentTargetIdentifier(identifier) => scoping
            .get_reference(identifier.reference_id.get()?)
            .symbol_id()
            .map(|symbol| (symbol, false)),
        AssignmentTarget::StaticMemberExpression(member) => {
            expression_root_symbol(scoping, &member.object).map(|symbol| (symbol, true))
        }
        AssignmentTarget::ComputedMemberExpression(member) => {
            expression_root_symbol(scoping, &member.object).map(|symbol| (symbol, true))
        }
        AssignmentTarget::PrivateFieldExpression(member) => {
            expression_root_symbol(scoping, &member.object).map(|symbol| (symbol, true))
        }
        _ => None,
    }
}

fn simple_assignment_target_symbol(
    scoping: &Scoping,
    target: &SimpleAssignmentTarget<'_>,
) -> Option<(SymbolId, bool)> {
    match target {
        SimpleAssignmentTarget::AssignmentTargetIdentifier(identifier) => scoping
            .get_reference(identifier.reference_id.get()?)
            .symbol_id()
            .map(|symbol| (symbol, false)),
        SimpleAssignmentTarget::StaticMemberExpression(member) => {
            expression_root_symbol(scoping, &member.object).map(|symbol| (symbol, true))
        }
        SimpleAssignmentTarget::ComputedMemberExpression(member) => {
            expression_root_symbol(scoping, &member.object).map(|symbol| (symbol, true))
        }
        SimpleAssignmentTarget::PrivateFieldExpression(member) => {
            expression_root_symbol(scoping, &member.object).map(|symbol| (symbol, true))
        }
        _ => None,
    }
}

fn expression_root_symbol(scoping: &Scoping, expression: &Expression<'_>) -> Option<SymbolId> {
    match unwrap_transparent_call_expression(expression) {
        Expression::Identifier(identifier) => scoping
            .get_reference(identifier.reference_id.get()?)
            .symbol_id(),
        Expression::StaticMemberExpression(member) => {
            expression_root_symbol(scoping, &member.object)
        }
        Expression::ComputedMemberExpression(member) => {
            expression_root_symbol(scoping, &member.object)
        }
        Expression::PrivateFieldExpression(member) => {
            expression_root_symbol(scoping, &member.object)
        }
        _ => None,
    }
}

fn compound_assignment_operator(
    operator: OxcAssignmentOperator,
) -> Option<CompoundAssignmentOperator> {
    Some(match operator {
        OxcAssignmentOperator::Assign => return None,
        OxcAssignmentOperator::Addition => CompoundAssignmentOperator::Add,
        OxcAssignmentOperator::Subtraction => CompoundAssignmentOperator::Subtract,
        OxcAssignmentOperator::Multiplication => CompoundAssignmentOperator::Multiply,
        OxcAssignmentOperator::Division => CompoundAssignmentOperator::Divide,
        OxcAssignmentOperator::Remainder => CompoundAssignmentOperator::Remainder,
        OxcAssignmentOperator::Exponential => CompoundAssignmentOperator::Exponent,
        OxcAssignmentOperator::ShiftLeft => CompoundAssignmentOperator::ShiftLeft,
        OxcAssignmentOperator::ShiftRight => CompoundAssignmentOperator::ShiftRight,
        OxcAssignmentOperator::ShiftRightZeroFill => CompoundAssignmentOperator::ShiftRightUnsigned,
        OxcAssignmentOperator::BitwiseOR => CompoundAssignmentOperator::BitOr,
        OxcAssignmentOperator::BitwiseXOR => CompoundAssignmentOperator::BitXor,
        OxcAssignmentOperator::BitwiseAnd => CompoundAssignmentOperator::BitAnd,
        OxcAssignmentOperator::LogicalOr => CompoundAssignmentOperator::LogicalOr,
        OxcAssignmentOperator::LogicalAnd => CompoundAssignmentOperator::LogicalAnd,
        OxcAssignmentOperator::LogicalNullish => CompoundAssignmentOperator::NullishCoalescing,
    })
}

fn resolved_callee_symbol(scoping: &Scoping, expression: &Expression<'_>) -> Option<SymbolId> {
    let Expression::Identifier(identifier) = unwrap_transparent_call_expression(expression) else {
        return None;
    };
    let reference = scoping.get_reference(identifier.reference_id.get()?);
    reference.symbol_id()
}

fn namespace_reactive_call_kind(
    scoping: &Scoping,
    expression: &Expression<'_>,
    symbol_to_binding: &BTreeMap<SymbolId, BindingId>,
    namespace_sources: &BTreeMap<BindingId, String>,
) -> Option<(BindingId, ReactiveCallKind)> {
    let expression = unwrap_transparent_call_expression(expression);
    let (object, property) = match expression {
        Expression::StaticMemberExpression(member) => {
            (&member.object, member.property.name.as_str())
        }
        Expression::ComputedMemberExpression(member) => {
            let Expression::StringLiteral(property) =
                unwrap_transparent_call_expression(&member.expression)
            else {
                return None;
            };
            (&member.object, property.value.as_str())
        }
        _ => return None,
    };
    let Expression::Identifier(object) = unwrap_transparent_call_expression(object) else {
        return None;
    };
    let symbol = scoping
        .get_reference(object.reference_id.get()?)
        .symbol_id()?;
    let binding = symbol_to_binding.get(&symbol)?;
    runtime_reactive_call_kind(namespace_sources.get(binding)?, property)
        .map(|kind| (*binding, kind))
}

fn unwrap_transparent_call_expression<'expression>(
    expression: &'expression Expression<'_>,
) -> &'expression Expression<'expression> {
    let mut current = expression;
    loop {
        current = match current {
            Expression::ParenthesizedExpression(expression) => &expression.expression,
            Expression::TSAsExpression(expression) => &expression.expression,
            Expression::TSSatisfiesExpression(expression) => &expression.expression,
            Expression::TSTypeAssertion(expression) => &expression.expression,
            Expression::TSNonNullExpression(expression) => &expression.expression,
            Expression::TSInstantiationExpression(expression) => &expression.expression,
            Expression::SequenceExpression(expression) => {
                let Some(last) = expression.expressions.last() else {
                    return current;
                };
                last
            }
            _ => return current,
        };
    }
}

fn runtime_reactive_namespace_source(source: &str) -> bool {
    matches!(
        source,
        "fict"
            | "fict/plus"
            | "fict/advanced"
            | "fict/internal"
            | "@fictjs/runtime/advanced"
            | "@fictjs/runtime/internal"
    )
}

fn runtime_reactive_call_kind(source: &str, imported: &str) -> Option<ReactiveCallKind> {
    match imported {
        "$store" if matches!(source, "fict" | "fict/plus") => Some(ReactiveCallKind::Store),
        "resource" if matches!(source, "fict" | "fict/plus") => Some(ReactiveCallKind::Resource),
        "createSelector"
            if matches!(
                source,
                "fict"
                    | "fict/advanced"
                    | "fict/internal"
                    | "@fictjs/runtime/advanced"
                    | "@fictjs/runtime/internal"
            ) =>
        {
            Some(ReactiveCallKind::Selector)
        }
        _ => None,
    }
}

fn classify_hook_call(
    scoping: &Scoping,
    expression: &Expression<'_>,
    symbol_to_binding: &BTreeMap<SymbolId, BindingId>,
    hook_bindings: &BTreeSet<BindingId>,
    namespace_imports: &BTreeSet<BindingId>,
) -> Option<HookCall> {
    let mut current = expression;
    loop {
        match current {
            Expression::Identifier(identifier) => {
                if !is_hook_name(identifier.name.as_str()) {
                    return None;
                }
                let resolved = identifier.reference_id.get().and_then(|reference| {
                    scoping
                        .get_reference(reference)
                        .symbol_id()
                        .and_then(|symbol| symbol_to_binding.get(&symbol).copied())
                });
                if resolved.is_some_and(|binding| !hook_bindings.contains(&binding)) {
                    return None;
                }
                return Some(HookCall::Direct {
                    display_name: identifier.name.to_string(),
                });
            }
            Expression::StaticMemberExpression(member) => {
                return classify_member_hook(
                    scoping,
                    &member.object,
                    member.property.name.as_str(),
                    symbol_to_binding,
                    namespace_imports,
                );
            }
            Expression::ComputedMemberExpression(member) => {
                let property = match &member.expression {
                    Expression::StringLiteral(literal) => literal.value.to_string(),
                    Expression::NumericLiteral(literal) => literal.value.to_string(),
                    _ => return None,
                };
                return classify_member_hook(
                    scoping,
                    &member.object,
                    &property,
                    symbol_to_binding,
                    namespace_imports,
                );
            }
            Expression::ChainExpression(chain) => {
                let member = chain.expression.as_member_expression()?;
                return match member {
                    MemberExpression::StaticMemberExpression(member) => classify_member_hook(
                        scoping,
                        &member.object,
                        member.property.name.as_str(),
                        symbol_to_binding,
                        namespace_imports,
                    ),
                    MemberExpression::ComputedMemberExpression(member) => {
                        let property = match &member.expression {
                            Expression::StringLiteral(literal) => literal.value.to_string(),
                            Expression::NumericLiteral(literal) => literal.value.to_string(),
                            _ => return None,
                        };
                        classify_member_hook(
                            scoping,
                            &member.object,
                            &property,
                            symbol_to_binding,
                            namespace_imports,
                        )
                    }
                    MemberExpression::PrivateFieldExpression(_) => None,
                };
            }
            Expression::ParenthesizedExpression(expression) => current = &expression.expression,
            Expression::TSAsExpression(expression) => current = &expression.expression,
            Expression::TSSatisfiesExpression(expression) => current = &expression.expression,
            Expression::TSTypeAssertion(expression) => current = &expression.expression,
            Expression::TSNonNullExpression(expression) => current = &expression.expression,
            Expression::TSInstantiationExpression(expression) => current = &expression.expression,
            _ => return None,
        }
    }
}

fn classify_member_hook(
    scoping: &Scoping,
    object: &Expression<'_>,
    property: &str,
    symbol_to_binding: &BTreeMap<SymbolId, BindingId>,
    namespace_imports: &BTreeSet<BindingId>,
) -> Option<HookCall> {
    if !is_hook_name(property) {
        return None;
    }
    let (object_name, object_binding) = if let Expression::Identifier(identifier) = object {
        let binding = identifier.reference_id.get().and_then(|reference| {
            scoping
                .get_reference(reference)
                .symbol_id()
                .and_then(|symbol| symbol_to_binding.get(&symbol).copied())
        });
        (Some(identifier.name.as_str()), binding)
    } else {
        (None, None)
    };
    Some(HookCall::Member {
        display_name: object_name.map_or_else(
            || property.to_string(),
            |object| format!("{object}.{property}"),
        ),
        namespace_import: object_binding
            .is_some_and(|binding| namespace_imports.contains(&binding)),
    })
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

fn reactive_mutation_semantics() -> InstructionSemantics {
    InstructionSemantics {
        purity: Purity::Unknown,
        mutation: MutationEffect::Local,
        evaluation: EvaluationMode::Eager,
        may_throw: true,
    }
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
