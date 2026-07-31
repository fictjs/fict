use std::collections::{BTreeMap, BTreeSet, VecDeque};

use fict_diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use fict_hir::{
    ArrayElement, BinaryOperator, Binding, BindingId, BindingKind, BlockId, CallArgument, CallHost,
    CallInstruction, CompoundAssignmentOperator, ContextValueKind, DeclarationKind, DeleteTarget,
    DesugaringKind, EvaluationMode, FictMacroKind, FileId, FunctionFlags, FunctionId, FunctionKind,
    GeneratedOrigin, GlobalId, HirBlock, HirFile, HirFunction, HirGlobal, HirInstruction,
    HirInstructionKind, HirLocal, HirObjectParameterCheck, HirObjectParameterMode,
    HirObjectParameterProperty, HirObjectParameterRest, HirParameter, HirPatternWrite, HirScope,
    HirTerminator, HirValue, ImportPhase, ImportedHookMember, ImportedHookReturn,
    ImportedReactiveKind, ImportedReactiveMember, ImportedReactiveMemberMatch,
    ImportedReactiveProperty, InstructionSemantics, IterationKind, JavaScriptString, JsxAttribute,
    JsxAttributeValue, JsxChild, JsxElement, JsxElementName, JsxExpressionKind, JsxListExpression,
    JsxListReceiver, JsxNode, JsxTemplate, LiteralValue, LocalId, LocalKind, ModuleExport,
    ModuleLocalExport, ModulePlan, MutationEffect, NumberLiteral, ObjectEntry, ObjectPropertyKind,
    Origin, PatternSummary, PropertyKey, Purity, ReactiveCallKind, ReactiveScopeHost,
    ReactiveScopeKind, RegionId, ScopeId, ScopeKind, StateMethodCallSemantics, StateReceiverKind,
    StructuredSourceHint, SyntaxFragment, SyntaxFragmentId, SyntaxFragmentKind, SyntaxSummary,
    TaggedTemplateQuasi, TemplateId, TerminatorKind, UnaryOperator, UpdateOperator, ValueId,
    ValueKind, classify_state_method_call, classify_state_method_result, verify_hir,
    verify_module_plan,
};
use fict_metadata::{
    HookReturnInfo, MetadataResolutionStatus, ModuleReactiveMetadata, ReactiveExportKind,
    ResolvedMetadataInput,
};
use oxc::{
    allocator::Allocator,
    ast::{
        ast::{
            ArrayAssignmentTarget, ArrayExpressionElement, ArrowFunctionExpression,
            AssignmentExpression, AssignmentPattern, AssignmentTarget,
            AssignmentTargetMaybeDefault, AssignmentTargetProperty, AssignmentTargetRest,
            AssignmentTargetWithDefault, BindingIdentifier, BindingPattern, BindingRestElement,
            CallExpression, ChainElement, Class, ClassElement, ClassType, ComputedMemberExpression,
            Decorator, Expression, ExpressionStatement, FormalParameter, FormalParameterRest,
            FormalParameters, Function, FunctionBody, FunctionType, IdentifierReference,
            ImportExpression, ImportOrExportKind, ImportPhase as OxcImportPhase, JSXAttributeItem,
            JSXAttributeName, JSXAttributeValue as OxcJsxAttributeValue, JSXChild as OxcJsxChild,
            JSXElement, JSXElementName as OxcJsxElementName, JSXExpression, JSXFragment,
            JSXMemberExpression, JSXMemberExpressionObject, LogicalExpression, MemberExpression,
            MetaProperty, MethodDefinitionKind, NewExpression, ObjectAssignmentTarget,
            ObjectPropertyKind as OxcObjectPropertyKind, Program, PropertyKey as OxcPropertyKey,
            PropertyKind, ReturnStatement, SimpleAssignmentTarget, Statement, Super,
            TSImportEqualsDeclaration, TSLiteral, TSModuleReference, TSType, TSTypeName,
            TSTypeOperatorOperator, TaggedTemplateExpression, TemplateLiteral, ThisExpression,
            UpdateExpression, VariableDeclaration, VariableDeclarationKind, VariableDeclarator,
        },
        ast_kind::AstKind,
    },
    ast_visit::{
        Visit,
        walk::{
            walk_arrow_function_expression, walk_assignment_pattern, walk_binding_rest_element,
            walk_call_expression, walk_expression, walk_expression_statement, walk_function,
            walk_jsx_element, walk_return_statement, walk_ts_import_equals_declaration,
            walk_variable_declaration, walk_variable_declarator,
        },
    },
    semantic::{Scoping, Semantic, SemanticBuilder},
    span::{GetSpan, Span},
    syntax::{
        number::ToJsString as _,
        operator::{
            AssignmentOperator as OxcAssignmentOperator, BinaryOperator as OxcBinaryOperator,
            LogicalOperator as OxcLogicalOperator, UnaryOperator as OxcUnaryOperator,
            UpdateOperator as OxcUpdateOperator,
        },
        scope::{ScopeFlags, ScopeId as OxcScopeId},
        symbol::SymbolId,
    },
};

use crate::{
    FictDirectiveKind, FrontendBinding, FrontendBindingKind, FrontendSummary, OxcCompileOptions,
    OxcSourceLanguage, analyze_frontend, analyze_typescript_compatibility,
};

use super::compile::{convert_diagnostics, parse_source, sorted};

mod advisory_diagnostics;
mod class_components;
mod dangerous_html;
mod function_abi;
mod inline_jsx_functions;
mod jsx_spread_children;
mod macro_policy;
mod memo_side_effects;
mod native_jsx_spreads;
mod reactive_jsx_writes;
mod resource_declarations;
mod structured_control_flow;

use class_components::ClassBindingCollector;
use macro_policy::unsupported_macro_diagnostics;

/// Binding-aware frontend controls that affect HIR classification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HirBuildOptions {
    /// Direct identifier or static-member hosts whose first callback is a reactive scope.
    ///
    /// Lexical identifiers are matched against their root binding, unresolved
    /// globals by name, and member calls by their non-computed property name.
    pub reactive_scopes: Vec<String>,
    /// Reject non-guaranteed nested state mutations instead of emitting a fallback warning.
    pub strict_guarantee: bool,
    /// Effective severity for runtime reactive creation in non-JSX control flow.
    pub reactive_creation_control_flow_severity: DiagnosticSeverity,
    /// Bundler-authoritative metadata snapshot used to annotate imported runtime bindings.
    pub resolved_metadata: Vec<ResolvedMetadataInput>,
}

impl Default for HirBuildOptions {
    fn default() -> Self {
        Self {
            reactive_scopes: Vec::new(),
            strict_guarantee: true,
            reactive_creation_control_flow_severity: DiagnosticSeverity::Error,
            resolved_metadata: Vec::new(),
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
    /// Verified OXC-independent module linkage facts using runtime HIR binding identities.
    pub module_plan: Option<ModulePlan>,
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
            module_plan: None,
            syntax_fragments: Vec::new(),
            diagnostics: frontend_output.diagnostics,
        };
    };

    if frontend.program_compiler_disabled() {
        return HirBuildOutput {
            hir: None,
            frontend: Some(frontend),
            module_plan: None,
            syntax_fragments: Vec::new(),
            diagnostics: frontend_output.diagnostics,
        };
    }

    let policy_diagnostics = unsupported_macro_diagnostics(&frontend);
    if !policy_diagnostics.is_empty() {
        return HirBuildOutput {
            hir: None,
            frontend: Some(frontend),
            module_plan: None,
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
                module_plan: None,
                syntax_fragments: Vec::new(),
                diagnostics: compatibility.diagnostics,
            };
        }
    }

    let allocator = Allocator::default();
    let parsed = parse_source(&allocator, source, compile_options);
    if !parsed.diagnostics.is_empty() {
        return HirBuildOutput {
            hir: None,
            frontend: Some(frontend),
            module_plan: None,
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
            module_plan: None,
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

#[derive(Debug, Clone)]
struct ParameterFact {
    span: SourceSpan,
    bindings: Vec<SymbolId>,
    rest_bindings: Vec<SymbolId>,
    is_rest: bool,
    direct_binding: Option<SymbolId>,
    default_value: Option<SourceSpan>,
    object: Option<ObjectParameterFact>,
    props_issues: Vec<PropsPatternIssue>,
    has_default: bool,
    has_rest: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PropsPatternIssue {
    kind: PropsPatternIssueKind,
    span: SourceSpan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PropsPatternIssueKind {
    Array,
    ArrayRest,
    Computed,
    Nested,
}

#[derive(Debug, Clone)]
struct ObjectParameterFact {
    properties: Vec<ObjectParameterPropertyFact>,
    rest: Option<ObjectParameterRestFact>,
}

#[derive(Debug, Clone)]
struct ObjectParameterPropertyFact {
    path: Vec<String>,
    binding: SymbolId,
    checks: Vec<ObjectParameterCheckFact>,
    default_value: Option<SourceSpan>,
    origin: SourceSpan,
}

#[derive(Debug, Clone)]
struct ObjectParameterCheckFact {
    path: Vec<String>,
    origin: SourceSpan,
}

#[derive(Debug, Clone)]
struct ObjectParameterRestFact {
    binding: SymbolId,
    excluded: Vec<String>,
    origin: SourceSpan,
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
    returns: Vec<FunctionReturnFact>,
}

#[derive(Debug, Clone, Copy)]
struct FunctionReturnFact {
    statement: SourceSpan,
    value: Option<SourceSpan>,
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
                returns: Vec::new(),
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
        public_binding: Option<&BindingIdentifier<'_>>,
        parameters: &FormalParameters<'_>,
        flags: FunctionFlags,
    ) -> FunctionId {
        let id = FunctionId::new(count_u32(self.functions.len()));
        let inferred = self.inferred_bindings.get(&(span.start, span.end));
        // A function-expression id is a lexical self-binding, not the public binding that
        // determines hook/component role. Prefer the surrounding variable binding and only use
        // an explicit id for declarations, where it is also the public binding.
        let binding = inferred
            .map(|(symbol, _)| *symbol)
            .or_else(|| public_binding.and_then(|identifier| identifier.symbol_id.get()));
        let display_name = inferred
            .map(|(_, name)| name.clone())
            .or_else(|| public_binding.map(|identifier| identifier.name.to_string()));
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
            returns: Vec::new(),
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
        let public_binding = if function.r#type == FunctionType::FunctionDeclaration {
            function.id.as_ref()
        } else {
            None
        };
        let id = self.add_function(
            function.span,
            body.span,
            function.scope_id.get(),
            public_binding,
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
        if let Some(expression) = function.get_expression() {
            self.functions[id.as_usize()]
                .returns
                .push(FunctionReturnFact {
                    statement: source_span(function.body.span),
                    value: Some(source_span(expression.get_inner_expression().span())),
                });
        }
        self.stack.push(id);
        walk_arrow_function_expression(self, function);
        self.stack.pop();
    }

    fn visit_return_statement(&mut self, statement: &ReturnStatement<'a>) {
        if let Some(owner) = self.stack.last().copied() {
            self.functions[owner.as_usize()]
                .returns
                .push(FunctionReturnFact {
                    statement: source_span(statement.span),
                    value: statement
                        .argument
                        .as_ref()
                        .map(|value| source_span(value.get_inner_expression().span())),
                });
        }
        walk_return_statement(self, statement);
    }
}

#[derive(Default)]
struct PatternBindingCollector {
    symbols: Vec<SymbolId>,
    rest_symbols: Vec<SymbolId>,
    has_defaults: bool,
    has_rest: bool,
    contains_await: bool,
    contains_yield: bool,
    contains_jsx: bool,
}

impl<'a> Visit<'a> for PatternBindingCollector {
    fn enter_node(&mut self, kind: AstKind<'a>) {
        match kind {
            AstKind::AwaitExpression(_) => self.contains_await = true,
            AstKind::YieldExpression(_) => self.contains_yield = true,
            AstKind::JSXElement(_) | AstKind::JSXFragment(_) => self.contains_jsx = true,
            _ => {}
        }
    }

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
        if let BindingPattern::BindingIdentifier(identifier) = &rest.argument
            && let Some(symbol) = identifier.symbol_id.get()
        {
            self.rest_symbols.push(symbol);
        }
        walk_binding_rest_element(self, rest);
    }

    fn visit_function(&mut self, _function: &Function<'a>, _flags: ScopeFlags) {}

    fn visit_arrow_function_expression(&mut self, _function: &ArrowFunctionExpression<'a>) {}
}

#[derive(Default)]
struct AssignmentPatternSyntaxCollector {
    has_defaults: bool,
    has_rest: bool,
    contains_await: bool,
    contains_yield: bool,
    contains_jsx: bool,
}

impl<'a> Visit<'a> for AssignmentPatternSyntaxCollector {
    fn enter_node(&mut self, kind: AstKind<'a>) {
        match kind {
            AstKind::AwaitExpression(_) => self.contains_await = true,
            AstKind::YieldExpression(_) => self.contains_yield = true,
            AstKind::JSXElement(_) | AstKind::JSXFragment(_) => self.contains_jsx = true,
            _ => {}
        }
    }

    fn visit_assignment_target_with_default(&mut self, target: &AssignmentTargetWithDefault<'a>) {
        self.has_defaults = true;
        oxc::ast_visit::walk::walk_assignment_target_with_default(self, target);
    }

    fn visit_assignment_target_rest(&mut self, target: &AssignmentTargetRest<'a>) {
        self.has_rest = true;
        oxc::ast_visit::walk::walk_assignment_target_rest(self, target);
    }

    fn visit_function(&mut self, _function: &Function<'a>, _flags: ScopeFlags) {}

    fn visit_arrow_function_expression(&mut self, _function: &ArrowFunctionExpression<'a>) {}
}

#[derive(Default)]
struct VariableDeclarationCollector {
    facts: Vec<VariableDeclarationFact>,
}

impl<'a> Visit<'a> for VariableDeclarationCollector {
    fn visit_variable_declaration(&mut self, declaration: &VariableDeclaration<'a>) {
        if !declaration.declare
            && matches!(
                declaration.kind,
                VariableDeclarationKind::Var
                    | VariableDeclarationKind::Let
                    | VariableDeclarationKind::Const
            )
        {
            for declarator in &declaration.declarations {
                let mut pattern = PatternBindingCollector::default();
                pattern.visit_binding_pattern(&declarator.id);
                let simple_binding = match &declarator.id {
                    BindingPattern::BindingIdentifier(binding) => binding.symbol_id.get(),
                    BindingPattern::ObjectPattern(_)
                    | BindingPattern::ArrayPattern(_)
                    | BindingPattern::AssignmentPattern(_) => None,
                };
                self.facts.push(VariableDeclarationFact {
                    declaration_kind: match declaration.kind {
                        VariableDeclarationKind::Var => DeclarationKind::Var,
                        VariableDeclarationKind::Let => DeclarationKind::Let,
                        VariableDeclarationKind::Const => DeclarationKind::Const,
                        VariableDeclarationKind::Using | VariableDeclarationKind::AwaitUsing => {
                            unreachable!("resource declarations are filtered above")
                        }
                    },
                    declarator_span: source_span(declarator.span),
                    pattern_span: source_span(declarator.id.span()),
                    initializer_span: declarator
                        .init
                        .as_ref()
                        .map(|initializer| source_span(initializer.get_inner_expression().span())),
                    initializer_has_effects: declarator.init.as_ref().is_some_and(|initializer| {
                        structured_control_flow::expression_has_effects(initializer)
                    }),
                    bindings: pattern.symbols,
                    simple_binding,
                    has_defaults: pattern.has_defaults,
                    has_rest: pattern.has_rest,
                    contains_await: pattern.contains_await,
                    contains_yield: pattern.contains_yield,
                    contains_jsx: pattern.contains_jsx,
                });
            }
        }
        walk_variable_declaration(self, declaration);
    }

    fn visit_ts_import_equals_declaration(&mut self, declaration: &TSImportEqualsDeclaration<'a>) {
        if declaration.import_kind != ImportOrExportKind::Type
            && !matches!(
                declaration.module_reference,
                TSModuleReference::ExternalModuleReference(_)
            )
            && let Some(symbol) = declaration.id.symbol_id.get()
        {
            self.facts.push(VariableDeclarationFact {
                // TypeScript lowers an internal import-equals alias to `var`, including
                // its pre-declaration `undefined` behavior. Model the emitted runtime
                // storage instead of treating the source-level alias as an ESM import.
                declaration_kind: DeclarationKind::Var,
                declarator_span: source_span(declaration.span),
                pattern_span: source_span(declaration.id.span),
                initializer_span: Some(source_span(declaration.module_reference.span())),
                initializer_has_effects: true,
                bindings: vec![symbol],
                simple_binding: Some(symbol),
                has_defaults: false,
                has_rest: false,
                contains_await: false,
                contains_yield: false,
                contains_jsx: false,
            });
        }
        walk_ts_import_equals_declaration(self, declaration);
    }
}

struct TypedExpressionCollector<'semantic> {
    scoping: &'semantic Scoping,
    facts: Vec<TypedExpressionFact>,
    classes: Vec<ClassFact>,
    decorators: Vec<DecoratorFact>,
    class_self_references: BTreeSet<(u32, u32)>,
}

struct ClassSelfReferenceCollector<'semantic> {
    scoping: &'semantic Scoping,
    symbol: SymbolId,
    spans: BTreeSet<(u32, u32)>,
}

impl<'a> Visit<'a> for ClassSelfReferenceCollector<'_> {
    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        let resolved = identifier
            .reference_id
            .get()
            .and_then(|reference| self.scoping.get_reference(reference).symbol_id());
        let resolves_to_class = resolved == Some(self.symbol);
        if resolves_to_class {
            self.spans
                .insert((identifier.span.start, identifier.span.end));
        }
    }
}

impl<'a> Visit<'a> for TypedExpressionCollector<'_> {
    fn visit_expression(&mut self, expression: &Expression<'a>) {
        let fact = match expression {
            Expression::BooleanLiteral(literal) => Some(TypedExpressionFact {
                span: source_span(literal.span),
                kind: TypedExpressionKind::Literal(LiteralValue::Boolean(literal.value)),
            }),
            Expression::NullLiteral(literal) => Some(TypedExpressionFact {
                span: source_span(literal.span),
                kind: TypedExpressionKind::Literal(LiteralValue::Null),
            }),
            Expression::NumericLiteral(literal) => Some(TypedExpressionFact {
                span: source_span(literal.span),
                kind: TypedExpressionKind::Literal(LiteralValue::Number(NumberLiteral::from_f64(
                    literal.value,
                ))),
            }),
            Expression::BigIntLiteral(literal) => Some(TypedExpressionFact {
                span: source_span(literal.span),
                kind: TypedExpressionKind::Literal(LiteralValue::BigInt(literal.value.to_string())),
            }),
            Expression::RegExpLiteral(literal) => Some(TypedExpressionFact {
                span: source_span(literal.span),
                kind: TypedExpressionKind::Literal(LiteralValue::RegExp {
                    pattern: literal.regex.pattern.text.to_string(),
                    flags: literal.regex.flags.to_string(),
                }),
            }),
            Expression::StringLiteral(literal) => {
                oxc_javascript_string(&literal.value, literal.lone_surrogates).map(|value| {
                    TypedExpressionFact {
                        span: source_span(literal.span),
                        kind: TypedExpressionKind::Literal(LiteralValue::String(value)),
                    }
                })
            }
            Expression::TemplateLiteral(template) => typed_template_literal(template),
            Expression::TaggedTemplateExpression(tagged) => {
                typed_tagged_template(self.scoping, tagged)
            }
            Expression::ImportExpression(import_expression) => {
                Some(typed_dynamic_import(import_expression))
            }
            Expression::ThisExpression(this_expression) => Some(TypedExpressionFact {
                span: source_span(this_expression.span),
                kind: TypedExpressionKind::Context {
                    kind: ContextValueKind::This,
                },
            }),
            Expression::Identifier(identifier)
                if is_context_arguments_reference(self.scoping, identifier) =>
            {
                Some(TypedExpressionFact {
                    span: source_span(identifier.span),
                    kind: TypedExpressionKind::Context {
                        kind: ContextValueKind::Arguments,
                    },
                })
            }
            Expression::MetaProperty(meta_property) => {
                context_value_kind(meta_property).map(|kind| TypedExpressionFact {
                    span: source_span(meta_property.span),
                    kind: TypedExpressionKind::Context { kind },
                })
            }
            Expression::UnaryExpression(unary) if unary.operator == OxcUnaryOperator::Delete => {
                typed_delete_expression(self.scoping, unary)
            }
            Expression::UnaryExpression(unary) if is_unresolved_typeof(self.scoping, unary) => {
                let Expression::Identifier(identifier) = unary.argument.get_inner_expression()
                else {
                    unreachable!("unresolved typeof is guaranteed to contain an identifier")
                };
                Some(TypedExpressionFact {
                    span: source_span(unary.span),
                    kind: TypedExpressionKind::UnresolvedTypeof {
                        identifier: identifier.name.to_string(),
                        reference_span: source_span(identifier.span),
                    },
                })
            }
            Expression::UnaryExpression(unary) if unary.operator != OxcUnaryOperator::Delete => {
                Some(TypedExpressionFact {
                    span: source_span(unary.span),
                    kind: TypedExpressionKind::Unary {
                        operator: unary_operator(unary.operator),
                        argument: source_span(unary.argument.get_inner_expression().span()),
                        argument_has_effects: structured_control_flow::expression_has_effects(
                            &unary.argument,
                        ),
                    },
                })
            }
            Expression::BinaryExpression(binary) => Some(TypedExpressionFact {
                span: source_span(binary.span),
                kind: TypedExpressionKind::Binary {
                    operator: binary_operator(binary.operator),
                    left: source_span(binary.left.get_inner_expression().span()),
                    right: source_span(binary.right.get_inner_expression().span()),
                    left_has_effects: structured_control_flow::expression_has_effects(&binary.left),
                    right_has_effects: structured_control_flow::expression_has_effects(
                        &binary.right,
                    ),
                },
            }),
            Expression::LogicalExpression(logical) => Some(TypedExpressionFact {
                span: source_span(logical.span),
                kind: TypedExpressionKind::Logical {
                    operator: logical_operator(logical.operator),
                    left: source_span(logical.left.get_inner_expression().span()),
                    right: source_span(logical.right.get_inner_expression().span()),
                    left_has_effects: structured_control_flow::expression_has_effects(
                        &logical.left,
                    ),
                    right_has_effects: structured_control_flow::expression_has_effects(
                        &logical.right,
                    ),
                },
            }),
            Expression::ConditionalExpression(conditional) => Some(TypedExpressionFact {
                span: source_span(conditional.span),
                kind: TypedExpressionKind::Conditional {
                    test: source_span(conditional.test.get_inner_expression().span()),
                    consequent: source_span(conditional.consequent.get_inner_expression().span()),
                    alternate: source_span(conditional.alternate.get_inner_expression().span()),
                    test_has_effects: structured_control_flow::expression_has_effects(
                        &conditional.test,
                    ),
                    consequent_has_effects: structured_control_flow::expression_has_effects(
                        &conditional.consequent,
                    ),
                    alternate_has_effects: structured_control_flow::expression_has_effects(
                        &conditional.alternate,
                    ),
                },
            }),
            Expression::SequenceExpression(sequence) => Some(TypedExpressionFact {
                span: source_span(sequence.span),
                kind: TypedExpressionKind::Sequence {
                    values: sequence
                        .expressions
                        .iter()
                        .map(|expression| {
                            let expression = expression.get_inner_expression();
                            TypedSequenceValue {
                                span: source_span(expression.span()),
                                has_effects: structured_control_flow::expression_has_effects(
                                    expression,
                                ),
                            }
                        })
                        .collect(),
                },
            }),
            Expression::AwaitExpression(await_expression) => {
                let argument = await_expression.argument.get_inner_expression();
                Some(TypedExpressionFact {
                    span: source_span(await_expression.span),
                    kind: TypedExpressionKind::Await {
                        value: source_span(argument.span()),
                        value_has_effects: structured_control_flow::expression_has_effects(
                            &await_expression.argument,
                        ),
                    },
                })
            }
            Expression::YieldExpression(yield_expression) => {
                let value = yield_expression
                    .argument
                    .as_ref()
                    .map(Expression::get_inner_expression);
                Some(TypedExpressionFact {
                    span: source_span(yield_expression.span),
                    kind: TypedExpressionKind::Yield {
                        value: value.map(|value| source_span(value.span())),
                        value_has_effects: yield_expression
                            .argument
                            .as_ref()
                            .is_some_and(structured_control_flow::expression_has_effects),
                        delegate: yield_expression.delegate,
                    },
                })
            }
            Expression::NewExpression(new_expression) => {
                let callee = new_expression.callee.get_inner_expression();
                Some(TypedExpressionFact {
                    span: source_span(new_expression.span),
                    kind: TypedExpressionKind::New {
                        callee: source_span(callee.span()),
                        callee_has_effects: structured_control_flow::expression_has_effects(
                            &new_expression.callee,
                        ),
                        arguments: new_expression
                            .arguments
                            .iter()
                            .map(|argument| {
                                if let Some(expression) = argument.as_expression() {
                                    let expression = expression.get_inner_expression();
                                    TypedNewArgument {
                                        value: source_span(expression.span()),
                                        value_has_effects:
                                            structured_control_flow::expression_has_effects(
                                                expression,
                                            ),
                                        spread: false,
                                    }
                                } else if let oxc::ast::ast::Argument::SpreadElement(spread) =
                                    argument
                                {
                                    let expression = spread.argument.get_inner_expression();
                                    TypedNewArgument {
                                        value: source_span(expression.span()),
                                        value_has_effects:
                                            structured_control_flow::expression_has_effects(
                                                &spread.argument,
                                            ),
                                        spread: true,
                                    }
                                } else {
                                    unreachable!(
                                        "every constructor argument is an expression or spread"
                                    )
                                }
                            })
                            .collect(),
                    },
                })
            }
            Expression::ArrayExpression(array) => Some(TypedExpressionFact {
                span: source_span(array.span),
                kind: TypedExpressionKind::Array {
                    elements: array
                        .elements
                        .iter()
                        .map(|element| match element {
                            ArrayExpressionElement::Elision(elision) => {
                                TypedArrayElement::Hole(source_span(elision.span))
                            }
                            ArrayExpressionElement::SpreadElement(spread) => {
                                let argument = spread.argument.get_inner_expression();
                                TypedArrayElement::Spread {
                                    span: source_span(argument.span()),
                                    origin: source_span(spread.span),
                                    has_effects: structured_control_flow::expression_has_effects(
                                        &spread.argument,
                                    ),
                                }
                            }
                            element => {
                                let expression = element.to_expression().get_inner_expression();
                                TypedArrayElement::Value {
                                    span: source_span(expression.span()),
                                    has_effects: structured_control_flow::expression_has_effects(
                                        expression,
                                    ),
                                }
                            }
                        })
                        .collect(),
                },
            }),
            Expression::ObjectExpression(object) => {
                typed_object_entries(object).map(|entries| TypedExpressionFact {
                    span: source_span(object.span),
                    kind: TypedExpressionKind::Object { entries },
                })
            }
            _ => None,
        };
        if let Some(fact) = fact {
            self.facts.push(fact);
        }
        walk_expression(self, expression);
    }

    fn visit_class(&mut self, class: &Class<'a>) {
        let declaration_binding = (class.r#type == ClassType::ClassDeclaration)
            .then(|| {
                class
                    .id
                    .as_ref()
                    .and_then(|identifier| identifier.symbol_id.get())
            })
            .flatten();
        if let Some(symbol) = declaration_binding {
            let mut self_references = ClassSelfReferenceCollector {
                scoping: self.scoping,
                symbol,
                spans: BTreeSet::new(),
            };
            self_references.visit_class(class);
            self.class_self_references.extend(self_references.spans);
        }
        let mut deferred_initializers = Vec::new();
        let mut decorator_spans: Vec<_> = class
            .decorators
            .iter()
            .map(|decorator| source_span(decorator.span))
            .collect();
        let mut eager_spans = decorator_spans.clone();
        if let Some(super_class) = &class.super_class {
            eager_spans.push(source_span(super_class.get_inner_expression().span()));
        }
        for element in &class.body.body {
            match element {
                ClassElement::StaticBlock(block) => {
                    eager_spans.push(source_span(block.span));
                }
                ClassElement::MethodDefinition(method) => {
                    let decorators = method
                        .decorators
                        .iter()
                        .map(|decorator| source_span(decorator.span));
                    decorator_spans.extend(decorators.clone());
                    eager_spans.extend(decorators);
                    if method.computed {
                        eager_spans.push(source_span(method.key.span()));
                    }
                    eager_spans.push(source_span(method.value.span));
                }
                ClassElement::PropertyDefinition(property) => {
                    let decorators = property
                        .decorators
                        .iter()
                        .map(|decorator| source_span(decorator.span));
                    decorator_spans.extend(decorators.clone());
                    eager_spans.extend(decorators);
                    if property.computed {
                        eager_spans.push(source_span(property.key.span()));
                    }
                    if let Some(initializer) = &property.value {
                        let span = source_span(initializer.get_inner_expression().span());
                        if property.r#static {
                            eager_spans.push(span);
                        } else {
                            deferred_initializers.push(span);
                        }
                    }
                }
                ClassElement::AccessorProperty(property) => {
                    let decorators = property
                        .decorators
                        .iter()
                        .map(|decorator| source_span(decorator.span));
                    decorator_spans.extend(decorators.clone());
                    eager_spans.extend(decorators);
                    if property.computed {
                        eager_spans.push(source_span(property.key.span()));
                    }
                    if let Some(initializer) = &property.value {
                        let span = source_span(initializer.get_inner_expression().span());
                        if property.r#static {
                            eager_spans.push(span);
                        } else {
                            deferred_initializers.push(span);
                        }
                    }
                }
                ClassElement::TSIndexSignature(_) => {}
            }
        }
        self.classes.push(ClassFact {
            span: source_span(class.span),
            declaration_binding,
            deferred_initializers,
            eager_spans,
            decorator_spans,
        });
        oxc::ast_visit::walk::walk_class(self, class);
    }

    fn visit_decorator(&mut self, decorator: &Decorator<'a>) {
        self.decorators.push(DecoratorFact {
            span: source_span(decorator.span),
        });
        oxc::ast_visit::walk::walk_decorator(self, decorator);
    }
}

fn typed_template_literal(template: &TemplateLiteral<'_>) -> Option<TypedExpressionFact> {
    let quasis: Option<Vec<_>> = template
        .quasis
        .iter()
        .map(|quasi| {
            quasi
                .value
                .cooked
                .as_ref()
                .and_then(|value| oxc_javascript_string(value, quasi.lone_surrogates))
        })
        .collect();
    let quasis = quasis?;
    if template.expressions.is_empty() {
        return quasis.into_iter().next().map(|value| TypedExpressionFact {
            span: source_span(template.span),
            kind: TypedExpressionKind::Literal(LiteralValue::String(value)),
        });
    }
    Some(TypedExpressionFact {
        span: source_span(template.span),
        kind: TypedExpressionKind::TemplateLiteral {
            quasis,
            expressions: template
                .expressions
                .iter()
                .map(|expression| {
                    let inner = expression.get_inner_expression();
                    TypedTemplateExpression {
                        span: source_span(inner.span()),
                        has_effects: structured_control_flow::expression_has_effects(expression),
                    }
                })
                .collect(),
        },
    })
}

fn typed_tagged_template(
    scoping: &Scoping,
    tagged: &TaggedTemplateExpression<'_>,
) -> Option<TypedExpressionFact> {
    let tag = tagged.tag.get_inner_expression();
    let quasis = tagged
        .quasi
        .quasis
        .iter()
        .map(|quasi| {
            let cooked = match quasi.value.cooked.as_ref() {
                Some(value) => Some(oxc_javascript_string(value, quasi.lone_surrogates)?),
                None => None,
            };
            Some(TaggedTemplateQuasi {
                cooked,
                raw: quasi.value.raw.to_string(),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(TypedExpressionFact {
        span: source_span(tagged.span),
        kind: TypedExpressionKind::TaggedTemplate {
            tag: source_span(tag.span()),
            tag_has_effects: structured_control_flow::expression_has_effects(&tagged.tag),
            tag_reference: planned_invocation_reference(scoping, &tagged.tag),
            tag_binding: resolved_callee_symbol(scoping, &tagged.tag),
            quasis,
            substitutions: tagged
                .quasi
                .expressions
                .iter()
                .map(|expression| {
                    let inner = expression.get_inner_expression();
                    TypedTemplateExpression {
                        span: source_span(inner.span()),
                        has_effects: structured_control_flow::expression_has_effects(expression),
                    }
                })
                .collect(),
        },
    })
}

fn typed_dynamic_import(import_expression: &ImportExpression<'_>) -> TypedExpressionFact {
    let specifier = import_expression.source.get_inner_expression();
    let options = import_expression
        .options
        .as_ref()
        .map(Expression::get_inner_expression);
    TypedExpressionFact {
        span: source_span(import_expression.span),
        kind: TypedExpressionKind::DynamicImport {
            specifier: source_span(specifier.span()),
            specifier_has_effects: structured_control_flow::expression_has_effects(
                &import_expression.source,
            ),
            options: options.map(|options| source_span(options.span())),
            options_have_effects: import_expression
                .options
                .as_ref()
                .is_some_and(structured_control_flow::expression_has_effects),
            phase: match import_expression.phase {
                None => ImportPhase::Evaluation,
                Some(OxcImportPhase::Source) => ImportPhase::Source,
                Some(OxcImportPhase::Defer) => ImportPhase::Defer,
            },
        },
    }
}

fn context_value_kind(meta_property: &MetaProperty<'_>) -> Option<ContextValueKind> {
    match (
        meta_property.meta.name.as_str(),
        meta_property.property.name.as_str(),
    ) {
        ("new", "target") => Some(ContextValueKind::NewTarget),
        ("import", "meta") => Some(ContextValueKind::ImportMeta),
        _ => None,
    }
}

fn typed_delete_expression(
    scoping: &Scoping,
    unary: &oxc::ast::ast::UnaryExpression<'_>,
) -> Option<TypedExpressionFact> {
    let argument = unary.argument.get_inner_expression();
    let value_target = || TypedDeleteTarget::Value {
        span: source_span(argument.span()),
        has_effects: structured_control_flow::expression_has_effects(&unary.argument),
    };
    let target = match argument {
        Expression::Identifier(identifier) => {
            let reference = scoping.get_reference(identifier.reference_id.get()?);
            if reference_is_inside_with(scoping, reference.scope_id()) {
                return None;
            }
            planned_identifier_place(scoping, identifier).map_or_else(
                || TypedDeleteTarget::UnresolvedIdentifier {
                    identifier: identifier.name.to_string(),
                    reference_span: source_span(identifier.span),
                },
                TypedDeleteTarget::Place,
            )
        }
        Expression::StaticMemberExpression(member) => planned_static_member_place(scoping, member)
            .map_or_else(value_target, TypedDeleteTarget::Place),
        Expression::ComputedMemberExpression(member) => {
            planned_computed_member_place(scoping, member)
                .map_or_else(value_target, TypedDeleteTarget::Place)
        }
        Expression::ChainExpression(chain)
            if matches!(
                chain.expression,
                ChainElement::StaticMemberExpression(_) | ChainElement::ComputedMemberExpression(_)
            ) =>
        {
            planned_expression_place(scoping, &unary.argument)
                .map_or_else(value_target, TypedDeleteTarget::Place)
        }
        _ => value_target(),
    };
    Some(TypedExpressionFact {
        span: source_span(unary.span),
        kind: TypedExpressionKind::Delete { target },
    })
}

fn oxc_javascript_string(value: &str, has_lone_surrogates: bool) -> Option<JavaScriptString> {
    if !has_lone_surrogates {
        return Some(value.into());
    }

    let mut code_units = Vec::with_capacity(value.len());
    let mut characters = value.chars();
    while let Some(character) = characters.next() {
        if character == '\u{fffd}' {
            let encoded = characters.by_ref().take(4).collect::<String>();
            if encoded.len() != 4 {
                return None;
            }
            code_units.push(u16::from_str_radix(&encoded, 16).ok()?);
        } else {
            let mut encoded = [0_u16; 2];
            code_units.extend_from_slice(character.encode_utf16(&mut encoded));
        }
    }
    Some(JavaScriptString::from_code_units(code_units))
}

fn typed_object_entries(
    object: &oxc::ast::ast::ObjectExpression<'_>,
) -> Option<Vec<TypedObjectEntry>> {
    object
        .properties
        .iter()
        .map(|entry| match entry {
            OxcObjectPropertyKind::SpreadProperty(spread) => {
                let value = spread.argument.get_inner_expression();
                Some(TypedObjectEntry::Spread {
                    value: source_span(value.span()),
                    value_has_effects: structured_control_flow::expression_has_effects(
                        &spread.argument,
                    ),
                    origin: source_span(spread.span),
                })
            }
            OxcObjectPropertyKind::ObjectProperty(property) => {
                let key = if property.computed {
                    let expression = property.key.as_expression()?.get_inner_expression();
                    TypedObjectKey::Computed {
                        expression: source_span(expression.span()),
                        expression_has_effects: structured_control_flow::expression_has_effects(
                            expression,
                        ),
                    }
                } else {
                    typed_static_object_key(&property.key)?
                };
                let kind = match property.kind {
                    PropertyKind::Get => ObjectPropertyKind::Get,
                    PropertyKind::Set => ObjectPropertyKind::Set,
                    PropertyKind::Init if property.method => ObjectPropertyKind::Method,
                    PropertyKind::Init => ObjectPropertyKind::Init,
                };
                let prototype_setter = kind == ObjectPropertyKind::Init
                    && !property.computed
                    && !property.shorthand
                    && matches!(&key, TypedObjectKey::Static(name) if name == "__proto__");
                let value = property.value.get_inner_expression();
                Some(TypedObjectEntry::Property {
                    key,
                    value: source_span(value.span()),
                    value_has_effects: structured_control_flow::expression_has_effects(
                        &property.value,
                    ),
                    kind,
                    shorthand: property.shorthand,
                    prototype_setter,
                    origin: source_span(property.span),
                })
            }
        })
        .collect()
}

fn typed_static_object_key(key: &OxcPropertyKey<'_>) -> Option<TypedObjectKey> {
    if matches!(key, OxcPropertyKey::StringLiteral(literal) if literal.lone_surrogates) {
        return None;
    }
    let name = match key {
        OxcPropertyKey::NumericLiteral(literal) if literal.value == 0.0 => "0".to_owned(),
        OxcPropertyKey::NumericLiteral(literal) => literal.value.to_js_string(),
        _ => key.static_name()?.into_owned(),
    };
    name.parse::<u32>()
        .ok()
        .filter(|index| index.to_string() == name)
        .map_or_else(
            || Some(TypedObjectKey::Static(name)),
            |index| Some(TypedObjectKey::Index(index)),
        )
}

fn parameter_facts(parameters: &FormalParameters<'_>) -> Vec<ParameterFact> {
    let mut facts =
        Vec::with_capacity(parameters.items.len() + usize::from(parameters.rest.is_some()));
    for parameter in &parameters.items {
        let mut collector = PatternBindingCollector::default();
        collector.visit_binding_pattern(&parameter.pattern);
        facts.push(ParameterFact {
            span: source_span(parameter.span),
            rest_bindings: collector.rest_symbols,
            is_rest: false,
            bindings: collector.symbols,
            direct_binding: match &parameter.pattern {
                BindingPattern::BindingIdentifier(identifier) => identifier.symbol_id.get(),
                BindingPattern::ObjectPattern(_)
                | BindingPattern::ArrayPattern(_)
                | BindingPattern::AssignmentPattern(_) => None,
            },
            default_value: parameter
                .initializer
                .as_ref()
                .map(|initializer| source_span(initializer.span())),
            object: simple_object_parameter(&parameter.pattern),
            props_issues: object_props_pattern_issues(&parameter.pattern),
            has_default: parameter.initializer.is_some() || collector.has_defaults,
            has_rest: collector.has_rest,
        });
    }
    if let Some(rest) = &parameters.rest {
        let mut collector = PatternBindingCollector::default();
        collector.visit_binding_pattern(&rest.rest.argument);
        let mut rest_bindings = collector.rest_symbols;
        if let BindingPattern::BindingIdentifier(identifier) = &rest.rest.argument
            && let Some(symbol) = identifier.symbol_id.get()
        {
            rest_bindings.push(symbol);
        }
        facts.push(ParameterFact {
            span: source_span(rest.span),
            bindings: collector.symbols,
            rest_bindings,
            is_rest: true,
            direct_binding: None,
            default_value: None,
            object: None,
            props_issues: Vec::new(),
            has_default: collector.has_defaults,
            has_rest: true,
        });
    }
    facts
}

fn object_props_pattern_issues(pattern: &BindingPattern<'_>) -> Vec<PropsPatternIssue> {
    let BindingPattern::ObjectPattern(object) = pattern else {
        return Vec::new();
    };
    let mut issues = Vec::new();
    collect_object_props_pattern_issues(object, true, &mut issues);
    issues
}

fn collect_object_props_pattern_issues(
    object: &oxc::ast::ast::ObjectPattern<'_>,
    allow_rest: bool,
    issues: &mut Vec<PropsPatternIssue>,
) {
    for property in &object.properties {
        if property.computed || property.key.static_name().is_none_or(|key| key.is_empty()) {
            issues.push(PropsPatternIssue {
                kind: PropsPatternIssueKind::Computed,
                span: source_span(property.span),
            });
            continue;
        }
        match &property.value {
            BindingPattern::BindingIdentifier(_) => {}
            BindingPattern::ObjectPattern(nested) => {
                collect_object_props_pattern_issues(nested, false, issues);
            }
            BindingPattern::AssignmentPattern(default) => {
                if !matches!(&default.left, BindingPattern::BindingIdentifier(_)) {
                    issues.push(PropsPatternIssue {
                        kind: PropsPatternIssueKind::Nested,
                        span: source_span(property.span),
                    });
                }
            }
            BindingPattern::ArrayPattern(array) => {
                issues.push(PropsPatternIssue {
                    kind: if array.rest.is_some() {
                        PropsPatternIssueKind::ArrayRest
                    } else {
                        PropsPatternIssueKind::Array
                    },
                    span: source_span(array.span),
                });
            }
        }
    }
    if let Some(rest) = &object.rest
        && (!allow_rest || !matches!(&rest.argument, BindingPattern::BindingIdentifier(_)))
    {
        issues.push(PropsPatternIssue {
            kind: PropsPatternIssueKind::Nested,
            span: source_span(rest.span),
        });
    }
}

fn simple_object_parameter(pattern: &BindingPattern<'_>) -> Option<ObjectParameterFact> {
    let BindingPattern::ObjectPattern(object) = pattern else {
        return None;
    };
    let mut properties = Vec::new();
    collect_simple_object_parameter_properties(object, &[], true, &mut properties)?;
    let excluded = object
        .properties
        .iter()
        .map(|property| {
            let key = property.key.static_name()?;
            (!key.is_empty()).then(|| key.into_owned())
        })
        .collect::<Option<Vec<_>>>()?;
    let rest = if let Some(rest) = &object.rest {
        let BindingPattern::BindingIdentifier(binding) = &rest.argument else {
            return None;
        };
        Some(ObjectParameterRestFact {
            binding: binding.symbol_id.get()?,
            excluded,
            origin: source_span(rest.span),
        })
    } else {
        None
    };
    (!properties.is_empty() || rest.is_some()).then_some(ObjectParameterFact { properties, rest })
}

fn collect_simple_object_parameter_properties(
    object: &oxc::ast::ast::ObjectPattern<'_>,
    prefix: &[String],
    allow_rest: bool,
    properties: &mut Vec<ObjectParameterPropertyFact>,
) -> Option<()> {
    if object.rest.is_some() && !allow_rest {
        return None;
    }
    for property in &object.properties {
        if property.computed {
            return None;
        }
        let key = property.key.static_name()?.into_owned();
        if key.is_empty() {
            return None;
        }
        let mut path = prefix.to_vec();
        path.push(key);
        match &property.value {
            BindingPattern::BindingIdentifier(binding) => {
                properties.push(ObjectParameterPropertyFact {
                    path,
                    binding: binding.symbol_id.get()?,
                    checks: Vec::new(),
                    default_value: None,
                    origin: source_span(property.span),
                });
            }
            BindingPattern::AssignmentPattern(default) => {
                let BindingPattern::BindingIdentifier(binding) = &default.left else {
                    return None;
                };
                properties.push(ObjectParameterPropertyFact {
                    path,
                    binding: binding.symbol_id.get()?,
                    checks: Vec::new(),
                    default_value: Some(source_span(default.right.span())),
                    origin: source_span(property.span),
                });
            }
            BindingPattern::ObjectPattern(nested) => {
                let first_nested_property = properties.len();
                collect_simple_object_parameter_properties(nested, &path, false, properties)?;
                if first_nested_property == properties.len() {
                    return None;
                }
                properties[first_nested_property].checks.insert(
                    0,
                    ObjectParameterCheckFact {
                        path,
                        origin: source_span(nested.span),
                    },
                );
            }
            BindingPattern::ArrayPattern(_) => return None,
        }
    }
    Some(())
}

fn reference_is_invoked(
    semantic: &Semantic<'_>,
    node_id: oxc::syntax::node::NodeId,
    span: Span,
) -> bool {
    for ancestor in semantic.nodes().ancestors(node_id) {
        match ancestor.kind() {
            AstKind::CallExpression(call) => {
                if expression_invokes_reference(&call.callee, span) {
                    return true;
                }
            }
            AstKind::NewExpression(call) => {
                let callee = call.callee.span();
                if callee == span {
                    return true;
                }
            }
            AstKind::TaggedTemplateExpression(tagged) => {
                let tag = tagged.tag.span();
                if tag == span {
                    return true;
                }
            }
            AstKind::Function(_) | AstKind::ArrowFunctionExpression(_) => break,
            _ => {}
        }
    }
    false
}

fn expression_invokes_reference(expression: &Expression<'_>, span: Span) -> bool {
    let expression = expression.get_inner_expression();
    if expression.span() == span {
        return true;
    }
    expression.get_member_expr().is_some_and(|member| {
        matches!(
            member.static_property_name(),
            Some("call" | "apply" | "bind")
        ) && member.object().get_inner_expression().span() == span
    })
}

fn reference_alias_target(
    semantic: &Semantic<'_>,
    node_id: oxc::syntax::node::NodeId,
    span: Span,
) -> Option<SymbolId> {
    for ancestor in semantic.nodes().ancestors(node_id) {
        match ancestor.kind() {
            AstKind::VariableDeclarator(declarator)
                if declarator.init.as_ref().is_some_and(|initializer| {
                    initializer.get_inner_expression().span() == span
                }) =>
            {
                let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
                    return None;
                };
                return binding.symbol_id.get();
            }
            AstKind::Function(_) | AstKind::ArrowFunctionExpression(_) => break,
            _ => {}
        }
    }
    None
}

fn reference_is_jsx_closing_name(
    semantic: &Semantic<'_>,
    node_id: oxc::syntax::node::NodeId,
) -> bool {
    semantic
        .nodes()
        .ancestors(node_id)
        .any(|ancestor| matches!(ancestor.kind(), AstKind::JSXClosingElement(_)))
}

fn callable_prop_mode(
    semantic: &Semantic<'_>,
    root: SymbolId,
    has_default: bool,
) -> HirObjectParameterMode {
    let mut queue = vec![root];
    let mut visited = BTreeSet::new();
    let mut has_callable_use = false;
    let mut has_value_use = false;
    while let Some(symbol) = queue.pop() {
        if !visited.insert(symbol) {
            continue;
        }
        for reference in semantic.symbol_references(symbol) {
            if reference.is_write() {
                if symbol != root {
                    has_value_use = true;
                }
                continue;
            }
            if !reference.is_read() {
                continue;
            }
            let node = semantic.nodes().get_node(reference.node_id());
            let AstKind::IdentifierReference(identifier) = node.kind() else {
                has_value_use = true;
                continue;
            };
            if let Some(alias) =
                reference_alias_target(semantic, reference.node_id(), identifier.span)
            {
                queue.push(alias);
            } else if reference_is_invoked(semantic, reference.node_id(), identifier.span) {
                has_callable_use = true;
            } else {
                has_value_use = true;
            }
        }
    }
    if has_callable_use && !has_value_use && !has_default {
        HirObjectParameterMode::Value
    } else {
        HirObjectParameterMode::Accessor
    }
}

struct Builder<'source, 'semantic> {
    source: &'source str,
    frontend: FrontendSummary,
    semantic: &'semantic Semantic<'semantic>,
    old_to_new: BTreeMap<u32, BindingId>,
    symbol_to_binding: BTreeMap<SymbolId, BindingId>,
    global_by_name: BTreeMap<String, GlobalId>,
    globals: Vec<HirGlobal>,
    functions: Vec<HirFunction>,
    function_facts: Vec<FunctionFact>,
    function_by_span: BTreeMap<(u32, u32), FunctionId>,
    templates: Vec<JsxTemplate>,
    syntax_fragments: Vec<SyntaxFragment>,
    adapter_fragments: Vec<OxcSyntaxFragment>,
    diagnostics: Vec<Diagnostic>,
    macro_bindings: BTreeMap<BindingId, FictMacroKind>,
    reactive_bindings: BTreeMap<BindingId, RuntimeReactiveClassification>,
    reactive_namespace_sources: BTreeMap<BindingId, String>,
    unavailable_metadata_sources: BTreeSet<String>,
    configured_scope_names: BTreeSet<String>,
    configured_bindings: BTreeSet<BindingId>,
    reactive_value_bindings: BTreeSet<BindingId>,
    class_self_reference_spans: BTreeSet<(u32, u32)>,
    reactive_functions: BTreeMap<FunctionId, ReactiveScopeKind>,
    state_receivers: BTreeMap<SymbolId, StateReceiverKind>,
    transformed_list_calls: BTreeSet<(u32, u32)>,
    control_flow_plans: BTreeMap<FunctionId, structured_control_flow::FunctionControlFlowPlan>,
    strict_guarantee: bool,
    reactive_creation_control_flow_severity: DiagnosticSeverity,
}

fn apply_resolved_import_metadata(
    frontend: &mut FrontendSummary,
    resolved_metadata: &[ResolvedMetadataInput],
) {
    let snapshot: BTreeMap<_, _> = resolved_metadata
        .iter()
        .filter(|entry| {
            matches!(
                entry.status,
                MetadataResolutionStatus::Resolved | MetadataResolutionStatus::IncompleteCycle
            ) && entry.validate().is_ok()
        })
        .filter_map(|entry| {
            entry
                .metadata
                .as_ref()
                .map(|metadata| (entry.request.as_str(), metadata))
        })
        .collect();

    for binding in &mut frontend.bindings {
        let Some(import) = binding.import.as_mut() else {
            continue;
        };
        if import.kind != fict_hir::ImportKind::Value {
            continue;
        }
        let Some(metadata) = snapshot.get(import.source.as_str()).copied() else {
            continue;
        };
        let exported = match &import.imported {
            fict_hir::ImportedName::Default | fict_hir::ImportedName::ImportEquals => {
                Some("default")
            }
            fict_hir::ImportedName::Named(exported) => Some(exported.as_str()),
            fict_hir::ImportedName::Namespace => None,
        };
        import.reactive = exported
            .and_then(|exported| metadata.exports.get(exported))
            .map(imported_reactive_kind);
        import.hook_return = exported
            .and_then(|exported| metadata.hooks.get(exported))
            .map(imported_hook_return);
        let namespace = match &import.imported {
            fict_hir::ImportedName::Namespace | fict_hir::ImportedName::ImportEquals => {
                Some(metadata)
            }
            fict_hir::ImportedName::Default => metadata.namespaces.get("default"),
            fict_hir::ImportedName::Named(exported) => metadata.namespaces.get(exported),
        };
        import.reactive_members = namespace.map_or_else(Vec::new, flatten_reactive_members);
        import.hook_members = namespace.map_or_else(Vec::new, flatten_hook_members);
    }
}

fn imported_hook_return(info: &HookReturnInfo) -> ImportedHookReturn {
    ImportedHookReturn {
        direct_accessor: info.direct_accessor.as_ref().map(imported_reactive_kind),
        object_properties: info
            .object_props
            .iter()
            .map(|(key, kind)| ImportedReactiveProperty {
                key: key.clone(),
                kind: imported_reactive_kind(kind),
            })
            .collect(),
        array_properties: info
            .array_props
            .iter()
            .map(|(key, kind)| ImportedReactiveProperty {
                key: key.clone(),
                kind: imported_reactive_kind(kind),
            })
            .collect(),
    }
}

const fn imported_reactive_kind(kind: &ReactiveExportKind) -> ImportedReactiveKind {
    match kind {
        ReactiveExportKind::Signal => ImportedReactiveKind::Signal,
        ReactiveExportKind::Memo => ImportedReactiveKind::Memo,
        ReactiveExportKind::Store => ImportedReactiveKind::Store,
    }
}

fn flatten_reactive_members(metadata: &ModuleReactiveMetadata) -> Vec<ImportedReactiveMember> {
    let mut members = Vec::new();
    let mut stack = vec![(Vec::new(), metadata)];
    while let Some((path, metadata)) = stack.pop() {
        for (exported, kind) in &metadata.exports {
            let mut member_path = path.clone();
            member_path.push(exported.clone());
            members.push(ImportedReactiveMember {
                path: member_path,
                kind: imported_reactive_kind(kind),
            });
        }
        for (name, namespace) in &metadata.namespaces {
            let mut namespace_path = path.clone();
            namespace_path.push(name.clone());
            stack.push((namespace_path, namespace));
        }
    }
    members.sort_unstable_by(|left, right| left.path.cmp(&right.path));
    members
}

fn flatten_hook_members(metadata: &ModuleReactiveMetadata) -> Vec<ImportedHookMember> {
    let mut members = Vec::new();
    let mut stack = vec![(Vec::new(), metadata)];
    while let Some((path, metadata)) = stack.pop() {
        for (exported, shape) in &metadata.hooks {
            let mut member_path = path.clone();
            member_path.push(exported.clone());
            members.push(ImportedHookMember {
                path: member_path,
                return_shape: imported_hook_return(shape),
            });
        }
        for (name, namespace) in &metadata.namespaces {
            let mut namespace_path = path.clone();
            namespace_path.push(name.clone());
            stack.push((namespace_path, namespace));
        }
    }
    members.sort_unstable_by(|left, right| left.path.cmp(&right.path));
    members
}

impl<'source, 'semantic> Builder<'source, 'semantic> {
    fn new(
        source: &'source str,
        mut frontend: FrontendSummary,
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
        frontend.namespace_exports.retain_mut(|export| {
            let (Some(namespace), Some(target)) = (
                old_to_new.get(&export.namespace.index()).copied(),
                old_to_new.get(&export.target.index()).copied(),
            ) else {
                return false;
            };
            export.namespace = namespace;
            export.target = target;
            true
        });
        apply_resolved_import_metadata(&mut frontend, &options.resolved_metadata);
        let macro_bindings: BTreeMap<BindingId, FictMacroKind> = frontend
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
                    if macro_bindings.contains_key(&mapped) {
                        continue;
                    }
                    if let Some(classification) =
                        runtime_reactive_call_classification(&import.source, name)
                    {
                        reactive_bindings.insert(mapped, classification);
                    }
                }
                fict_hir::ImportedName::Namespace | fict_hir::ImportedName::ImportEquals
                    if runtime_reactive_namespace_source(&import.source) =>
                {
                    reactive_namespace_sources.insert(mapped, import.source.clone());
                }
                fict_hir::ImportedName::Default
                | fict_hir::ImportedName::Namespace
                | fict_hir::ImportedName::ImportEquals => {}
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
        let unavailable_metadata_sources = options
            .resolved_metadata
            .iter()
            .filter(|metadata| {
                matches!(
                    metadata.status,
                    MetadataResolutionStatus::Missing | MetadataResolutionStatus::IncompleteCycle
                )
            })
            .map(|metadata| metadata.request.clone())
            .collect();
        Self {
            source,
            frontend,
            semantic,
            old_to_new,
            symbol_to_binding,
            global_by_name: BTreeMap::new(),
            globals: Vec::new(),
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
            unavailable_metadata_sources,
            configured_scope_names: option_names,
            configured_bindings,
            reactive_value_bindings: BTreeSet::new(),
            class_self_reference_spans: BTreeSet::new(),
            reactive_functions: BTreeMap::new(),
            state_receivers: BTreeMap::new(),
            transformed_list_calls: BTreeSet::new(),
            control_flow_plans: BTreeMap::new(),
            strict_guarantee: options.strict_guarantee,
            reactive_creation_control_flow_severity: options
                .reactive_creation_control_flow_severity,
        }
    }

    fn build(&mut self, program: &Program<'_>) {
        self.diagnostics
            .extend(resource_declarations::diagnostics(program));
        self.diagnostics.extend(dangerous_html::diagnostics(
            program,
            self.semantic.scoping(),
        ));
        self.diagnostics
            .extend(jsx_spread_children::diagnostics(program));
        let mut collector = FunctionCollector::new(source_span(program.span));
        collector.visit_program(program);
        self.function_by_span = collector
            .functions
            .iter()
            .map(|function| ((function.span.start(), function.span.end()), function.id))
            .collect();
        self.function_facts = collector.functions;
        self.build_function_shells();
        self.control_flow_plans = structured_control_flow::collect(
            program,
            &self.function_by_span,
            self.semantic.scoping(),
        );
        self.apply_control_flow_plans();

        let function_by_span = self.function_by_span.clone();
        let symbol_to_binding = self.symbol_to_binding.clone();
        let reactive_bindings = self.reactive_bindings.clone();
        let reactive_namespace_sources = self.reactive_namespace_sources.clone();
        let configured_scope_names = self.configured_scope_names.clone();
        let configured_bindings = self.configured_bindings.clone();
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
        let namespace_imports: BTreeSet<_> = self
            .frontend
            .bindings
            .iter()
            .filter(|binding| {
                binding.kind == FrontendBindingKind::Import
                    && binding.import.as_ref().is_some_and(|import| {
                        matches!(
                            import.imported,
                            fict_hir::ImportedName::Namespace
                                | fict_hir::ImportedName::ImportEquals
                        )
                    })
            })
            .filter_map(|binding| self.old_to_new.get(&binding.id.index()).copied())
            .collect();
        let imported_hook_member_paths: BTreeMap<_, BTreeSet<_>> = self
            .frontend
            .bindings
            .iter()
            .filter_map(|binding| {
                let mapped = self.old_to_new.get(&binding.id.index()).copied()?;
                let import = binding.import.as_ref()?;
                (!import.hook_members.is_empty()).then(|| {
                    (
                        mapped,
                        import
                            .hook_members
                            .iter()
                            .map(|member| member.path.clone())
                            .collect(),
                    )
                })
            })
            .collect();
        let mut immediate_invocation_spans = ImmediateInvocationCollector::default();
        immediate_invocation_spans.visit_program(program);
        let immediate_invocations = immediate_invocation_spans
            .functions
            .into_iter()
            .filter_map(|span| self.function_by_span.get(&span).copied())
            .collect();
        let mut calls = CallCollector {
            scoping: self.semantic.scoping(),
            stack: vec![FunctionId::new(0)],
            function_by_span: &function_by_span,
            symbol_to_binding: &symbol_to_binding,
            hook_bindings: &hook_bindings,
            namespace_imports: &namespace_imports,
            imported_hook_member_paths: &imported_hook_member_paths,
            reactive_bindings: &reactive_bindings,
            reactive_namespace_sources: &reactive_namespace_sources,
            configured_scope_names: &configured_scope_names,
            configured_bindings: &configured_bindings,
            immediate_invocations: &immediate_invocations,
            context: PlacementContext::default(),
            calls: Vec::new(),
            effect_statements: BTreeMap::new(),
            concise_arrow_functions: BTreeSet::new(),
        };
        calls.visit_program(program);
        let mutable_alias_symbols: BTreeSet<SymbolId> = self
            .frontend
            .bindings
            .iter()
            .filter(|binding| binding.mutated)
            .map(|binding| SymbolId::from_usize(binding.id.as_usize()))
            .collect();
        let mut static_hook_aliases = StaticHookAliasCollector {
            scoping: self.semantic.scoping(),
            aliases: BTreeMap::new(),
            invalidated: BTreeSet::new(),
            member_invalidated: BTreeSet::new(),
            reflective_mutations: Vec::new(),
        };
        static_hook_aliases.visit_program(program);
        let static_hook_aliases = static_hook_aliases.finish(&mutable_alias_symbols);
        for (function, statements) in &calls.effect_statements {
            self.functions[function.as_usize()].effect_statements =
                statements.iter().copied().map(Origin::source).collect();
        }
        let mut known_arrays = KnownArrayCollector::default();
        known_arrays.visit_program(program);
        let mut variable_declarations = VariableDeclarationCollector::default();
        variable_declarations.visit_program(program);
        let mut typed_expressions = TypedExpressionCollector {
            scoping: self.semantic.scoping(),
            facts: Vec::new(),
            classes: Vec::new(),
            decorators: Vec::new(),
            class_self_references: BTreeSet::new(),
        };
        typed_expressions.visit_program(program);
        self.class_self_reference_spans = typed_expressions.class_self_references.clone();
        let binding_to_symbol: BTreeMap<_, _> = self
            .symbol_to_binding
            .iter()
            .map(|(symbol, binding)| (*binding, *symbol))
            .collect();
        let immutable_bindings: BTreeSet<_> = self
            .frontend
            .bindings
            .iter()
            .filter(|binding| !binding.mutated)
            .filter_map(|binding| self.old_to_new.get(&binding.id.index()).copied())
            .collect();
        for call in &calls.calls {
            let known_reactive_array = call.arguments.first().is_some_and(|argument| {
                argument.array_literal
                    && call
                        .direct_variable_binding
                        .is_some_and(|binding| immutable_bindings.contains(&binding))
                    && (call.reactive_kind == Some(ReactiveCallKind::Store)
                        || call.binding.is_some_and(|binding| {
                            self.macro_bindings.get(&binding) == Some(&FictMacroKind::State)
                        }))
            });
            if known_reactive_array
                && let Some(symbol) = call
                    .direct_variable_binding
                    .and_then(|binding| binding_to_symbol.get(&binding).copied())
            {
                known_arrays.symbols.insert(symbol);
            }
        }
        let mut jsx = JsxCollector {
            scoping: self.semantic.scoping(),
            known_arrays: &known_arrays.symbols,
            aliases: &static_hook_aliases,
            stack: vec![FunctionId::new(0)],
            scan_owners: Vec::new(),
            function_by_span: &function_by_span,
            roots: Vec::new(),
            tags: Vec::new(),
        };
        jsx.visit_program(program);
        for fact in &jsx.roots {
            collect_transformed_list_call_spans(&fact.root, &mut self.transformed_list_calls);
        }
        let mut class_bindings = ClassBindingCollector::new(self.semantic.scoping());
        class_bindings.visit_program(program);
        let mut mutations = MutationCollector {
            scoping: self.semantic.scoping(),
            facts: Vec::new(),
            pattern_assignments: Vec::new(),
        };
        mutations.visit_program(program);
        self.validate_imported_reactive_writes(&mutations, &typed_expressions.facts);
        let mut delete_targets = DeleteTargetCollector::default();
        delete_targets.visit_program(program);
        let mut suppressed_members = delete_targets.member_spans;
        suppressed_members.extend(mutations.facts.iter().map(|fact| {
            let span = fact.target_span;
            (span.start(), span.end())
        }));
        suppressed_members.extend(
            mutations
                .pattern_assignments
                .iter()
                .flat_map(|assignment| &assignment.projected_targets)
                .map(|target| (target.span.start(), target.span.end())),
        );
        let mut member_accesses = MemberAccessCollector {
            scoping: self.semantic.scoping(),
            suppressed: suppressed_members,
            facts: Vec::new(),
        };
        member_accesses.visit_program(program);
        self.classify_component_roles(&calls.calls, &jsx.roots);
        self.validate_class_components(&class_bindings, &jsx.tags);
        let reactive_symbols =
            self.analyze_reactive_symbols(program, &calls.calls, &mutable_alias_symbols);
        self.validate_state_method_calls(
            &calls.calls,
            &reactive_symbols.state,
            &reactive_symbols.state_receivers,
            &static_hook_aliases,
        );
        self.state_receivers
            .clone_from(&reactive_symbols.state_receivers);
        self.validate_advisory_diagnostics(program, &calls.calls, &reactive_symbols.reactive);
        self.validate_memo_side_effects(program, &calls.calls);
        self.validate_inline_jsx_functions(program);
        self.validate_native_jsx_spreads(program);
        self.validate_dynamic_property_access(program, &reactive_symbols.reactive);
        self.validate_reactive_jsx_writes(program, &reactive_symbols.reactive);
        self.validate_reactive_escapes(
            program,
            &calls.calls,
            &known_arrays.symbols,
            &reactive_symbols,
            &class_bindings,
            &static_hook_aliases,
        );
        self.validate_component_props_patterns();
        self.apply_call_classification(&calls.calls);
        self.validate_macro_placement(&calls.calls);
        self.validate_runtime_reactive_placement(&calls.calls);
        self.validate_missing_hook_metadata(&calls.calls, &static_hook_aliases);
        self.validate_hook_placement(&calls.calls);
        self.populate_function_bodies(
            &calls.calls,
            &variable_declarations.facts,
            &typed_expressions,
            &mutations,
            &member_accesses.facts,
            &jsx.roots,
        );
        self.validate_synchronous_function_abi(&calls.calls, &jsx.roots);
    }

    fn validate_component_props_patterns(&mut self) {
        let severity = if self.strict_guarantee {
            DiagnosticSeverity::Error
        } else {
            DiagnosticSeverity::Warning
        };
        for function in &self.function_facts {
            if self.functions[function.id.as_usize()].kind != FunctionKind::Component
                || function.parameters.len() != 1
            {
                continue;
            }
            for issue in &function.parameters[0].props_issues {
                self.diagnostics
                    .push(props_pattern_diagnostic(*issue, severity));
            }
        }
    }

    fn validate_imported_reactive_writes(
        &mut self,
        mutations: &MutationCollector<'_>,
        typed_expressions: &[TypedExpressionFact],
    ) {
        let mut readonly_targets = Vec::new();
        let mut unsafe_member_operations = Vec::new();
        for mutation in &mutations.facts {
            if mutation.projected {
                let Some((name, resolved)) = mutation
                    .place
                    .as_ref()
                    .and_then(|place| self.planned_imported_reactive_member(place))
                else {
                    continue;
                };
                let exact_target = resolved.accessor_depth
                    == mutation
                        .place
                        .as_ref()
                        .map_or(0, |place| place.projections.len());
                match resolved.kind {
                    ImportedReactiveKind::Signal => {
                        unsafe_member_operations.push((mutation.target_span, name, "mutating"));
                    }
                    ImportedReactiveKind::Memo if exact_target => {
                        readonly_targets.push((name, resolved.kind, mutation.target_span));
                    }
                    ImportedReactiveKind::Memo => {
                        unsafe_member_operations.push((mutation.target_span, name, "mutating"));
                    }
                    ImportedReactiveKind::Store if exact_target => {
                        readonly_targets.push((name, resolved.kind, mutation.target_span));
                    }
                    ImportedReactiveKind::Store => {}
                }
                continue;
            }
            let Some(binding) = mutation
                .symbol
                .and_then(|symbol| self.symbol_to_binding.get(&symbol).copied())
            else {
                continue;
            };
            if let Some(kind @ (ImportedReactiveKind::Memo | ImportedReactiveKind::Store)) =
                self.imported_reactive_kind(binding)
            {
                readonly_targets.push((
                    self.binding_display_name(binding).to_owned(),
                    kind,
                    mutation.target_span,
                ));
            }
        }
        for assignment in &mutations.pattern_assignments {
            for target in &assignment.targets {
                let Some(binding) = self.symbol_to_binding.get(&target.symbol).copied() else {
                    continue;
                };
                if let Some(kind @ (ImportedReactiveKind::Memo | ImportedReactiveKind::Store)) =
                    self.imported_reactive_kind(binding)
                {
                    readonly_targets.push((
                        self.binding_display_name(binding).to_owned(),
                        kind,
                        target.span,
                    ));
                }
            }
            for target in &assignment.projected_targets {
                let Some((name, resolved)) = self.planned_imported_reactive_member(&target.place)
                else {
                    continue;
                };
                let exact_target = resolved.accessor_depth == target.place.projections.len();
                match resolved.kind {
                    ImportedReactiveKind::Signal => {
                        unsafe_member_operations.push((target.span, name, "mutating"));
                    }
                    ImportedReactiveKind::Memo if exact_target => {
                        readonly_targets.push((name, resolved.kind, target.span));
                    }
                    ImportedReactiveKind::Memo => {
                        unsafe_member_operations.push((target.span, name, "mutating"));
                    }
                    ImportedReactiveKind::Store if exact_target => {
                        readonly_targets.push((name, resolved.kind, target.span));
                    }
                    ImportedReactiveKind::Store => {}
                }
            }
        }
        for expression in typed_expressions {
            let TypedExpressionKind::Delete {
                target: TypedDeleteTarget::Place(place),
            } = &expression.kind
            else {
                continue;
            };
            if let Some((name, resolved)) = self.planned_imported_reactive_member(place) {
                let exact_target = resolved.accessor_depth == place.projections.len();
                if resolved.kind != ImportedReactiveKind::Store || exact_target {
                    unsafe_member_operations.push((expression.span, name, "deleting"));
                }
            }
        }

        readonly_targets.sort_by(|left, right| {
            (left.2.start(), left.2.end(), &left.0, left.1).cmp(&(
                right.2.start(),
                right.2.end(),
                &right.0,
                right.1,
            ))
        });
        readonly_targets.dedup();
        for (name, kind, span) in readonly_targets {
            let (kind, help) = match kind {
                ImportedReactiveKind::Memo => (
                    "memo",
                    "derive a new local value instead of assigning to the imported memo accessor",
                ),
                ImportedReactiveKind::Store => (
                    "store",
                    "mutate a store property or replace the value in the exporting module",
                ),
                ImportedReactiveKind::Signal => unreachable!("signals remain writable"),
            };
            self.diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::new("FICT-METADATA-READONLY").expect("diagnostic literal"),
                    DiagnosticSeverity::Error,
                    format!("cannot write to imported {kind} binding {name:?}"),
                )
                .with_primary_span(span)
                .with_help(help)
                .with_guarantee_class(GuaranteeClass::Unsupported),
            );
        }

        unsafe_member_operations.sort_by(|left, right| {
            (left.0.start(), left.0.end(), &left.1, left.2).cmp(&(
                right.0.start(),
                right.0.end(),
                &right.1,
                right.2,
            ))
        });
        unsafe_member_operations.dedup();
        for (span, name, operation) in unsafe_member_operations {
            self.diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::new("FICT-M").expect("diagnostic literal"),
                    if self.strict_guarantee {
                        DiagnosticSeverity::Error
                    } else {
                        DiagnosticSeverity::Warning
                    },
                    format!(
                        "{operation} imported reactive namespace member {name:?} cannot preserve accessor semantics"
                    ),
                )
                .with_primary_span(span)
                .with_help(
                    "import a writable signal directly, or perform the update in the exporting module",
                )
                .with_guarantee_class(GuaranteeClass::Fallback),
            );
        }
    }

    fn imported_reactive_kind(&self, binding: BindingId) -> Option<ImportedReactiveKind> {
        self.frontend
            .bindings
            .iter()
            .find(|candidate| self.old_to_new.get(&candidate.id.index()).copied() == Some(binding))
            .and_then(|binding| binding.import.as_ref())
            .and_then(|import| import.reactive)
    }

    fn imported_hook_direct_kind(
        &self,
        binding: BindingId,
        callee_reference: Option<&PlannedPlace>,
    ) -> Option<ImportedReactiveKind> {
        let import = self
            .frontend
            .bindings
            .iter()
            .find(|candidate| self.old_to_new.get(&candidate.id.index()).copied() == Some(binding))
            .and_then(|binding| binding.import.as_ref())?;
        let shape = match callee_reference {
            Some(place) if !place.projections.is_empty() => {
                let path: Option<Vec<_>> = place
                    .projections
                    .iter()
                    .map(|projection| match projection {
                        PlannedProjection::Static { name, .. } => Some(name.clone()),
                        PlannedProjection::Index { index, .. } => Some(index.to_string()),
                        PlannedProjection::Computed { .. } => None,
                    })
                    .collect();
                import.resolve_hook_member_path(&path?)
            }
            Some(_) | None => import.hook_return.as_ref(),
        };
        shape.and_then(|hook| hook.direct_accessor)
    }

    fn planned_imported_reactive_member(
        &self,
        place: &PlannedPlace,
    ) -> Option<(String, ImportedReactiveMemberMatch)> {
        let PlannedPlaceBase::Binding(symbol) = place.base else {
            return None;
        };
        let binding = self.symbol_to_binding.get(&symbol).copied()?;
        let frontend = self.frontend.bindings.iter().find(|candidate| {
            self.old_to_new.get(&candidate.id.index()).copied() == Some(binding)
        })?;
        let import = frontend.import.as_ref()?;
        let mut path = Vec::new();
        for projection in &place.projections {
            match projection {
                PlannedProjection::Static { name, .. } => path.push(name.clone()),
                PlannedProjection::Index { index, .. } => path.push(index.to_string()),
                PlannedProjection::Computed { .. } => break,
            }
        }
        let resolved = import.resolve_reactive_member_path(&path)?;
        let member = import.reactive_members.get(resolved.member_index)?;
        let mut name = frontend.display_name.clone();
        for segment in &member.path {
            name.push('.');
            name.push_str(segment);
        }
        Some((name, resolved))
    }

    fn binding_display_name(&self, binding: BindingId) -> &str {
        self.frontend
            .bindings
            .iter()
            .find(|candidate| self.old_to_new.get(&candidate.id.index()).copied() == Some(binding))
            .map_or("<import>", |binding| binding.display_name.as_str())
    }

    fn analyze_reactive_symbols(
        &self,
        program: &Program<'_>,
        calls: &[CallFact],
        mutable_symbols: &BTreeSet<SymbolId>,
    ) -> ReactiveSymbolAnalysis {
        let binding_to_symbol: BTreeMap<_, _> = self
            .symbol_to_binding
            .iter()
            .map(|(symbol, binding)| (*binding, *symbol))
            .collect();
        let state: BTreeSet<_> = calls
            .iter()
            .filter(|call| {
                call.binding.is_some_and(|binding| {
                    self.macro_bindings.get(&binding) == Some(&FictMacroKind::State)
                })
            })
            .filter_map(|call| call.direct_variable_binding)
            .filter_map(|binding| binding_to_symbol.get(&binding).copied())
            .collect();
        let mut state_receivers = BTreeMap::new();
        let mut declared_state_receivers = BTreeSet::new();
        for call in calls.iter().filter(|call| {
            call.binding.is_some_and(|binding| {
                self.macro_bindings.get(&binding) == Some(&FictMacroKind::State)
            })
        }) {
            let Some(symbol) = call
                .direct_variable_binding
                .and_then(|binding| binding_to_symbol.get(&binding).copied())
            else {
                continue;
            };
            if call.declared_state_receiver_kind.is_some() {
                declared_state_receivers.insert(symbol);
            }
            let receiver = call.declared_state_receiver_kind.unwrap_or_else(|| {
                call.arguments
                    .first()
                    .map_or(StateReceiverKind::Unknown, |argument| {
                        argument.state_receiver_kind
                    })
            });
            state_receivers
                .entry(symbol)
                .and_modify(|current| {
                    if *current != receiver {
                        *current = StateReceiverKind::Unknown;
                    }
                })
                .or_insert(receiver);
        }
        let mut declared_binding_receivers = DeclaredStateReceiverTypeCollector {
            scoping: self.semantic.scoping(),
            receivers: BTreeMap::new(),
        };
        declared_binding_receivers.visit_program(program);
        let mut expression_receivers = declared_binding_receivers.receivers;
        for (symbol, receiver) in &state_receivers {
            expression_receivers.insert(*symbol, *receiver);
        }
        let mut receiver_mutations = StateReceiverMutationCollector {
            scoping: self.semantic.scoping(),
            state_symbols: &state,
            receivers: &expression_receivers,
            mutations: BTreeMap::new(),
        };
        receiver_mutations.visit_program(program);
        let receiver_mutations = receiver_mutations.mutations;
        for symbol in mutable_symbols {
            if declared_state_receivers.contains(symbol) || !state.contains(symbol) {
                continue;
            }
            let initial = state_receivers
                .get(symbol)
                .copied()
                .unwrap_or(StateReceiverKind::Unknown);
            let preserves_receiver = initial != StateReceiverKind::Unknown
                && receiver_mutations.get(symbol).is_some_and(|mutations| {
                    !mutations.is_empty() && mutations.iter().all(|receiver| *receiver == initial)
                });
            if !preserves_receiver {
                state_receivers.insert(*symbol, StateReceiverKind::Unknown);
            }
        }
        let source_reactive_symbols: BTreeSet<_> = calls
            .iter()
            .filter(|call| {
                call.reactive_kind.is_some()
                    || call
                        .binding
                        .and_then(|binding| self.macro_bindings.get(&binding))
                        .is_some_and(|kind| {
                            matches!(kind, FictMacroKind::State | FictMacroKind::Memo)
                        })
            })
            .filter_map(|call| call.direct_variable_binding)
            .filter_map(|binding| binding_to_symbol.get(&binding).copied())
            .collect();
        let mut source_escape_reactive_symbols: BTreeSet<_> = calls
            .iter()
            .filter(|call| {
                call.binding
                    .and_then(|binding| self.macro_bindings.get(&binding))
                    .is_some_and(|kind| matches!(kind, FictMacroKind::State | FictMacroKind::Memo))
            })
            .filter_map(|call| call.direct_variable_binding)
            .filter_map(|binding| binding_to_symbol.get(&binding).copied())
            .collect();
        let imported_reactive_symbols: BTreeSet<_> = self
            .frontend
            .bindings
            .iter()
            .filter(|binding| {
                binding.import.as_ref().is_some_and(|import| {
                    import.reactive.is_some() || !import.reactive_members.is_empty()
                })
            })
            .filter_map(|binding| self.old_to_new.get(&binding.id.index()).copied())
            .filter_map(|binding| binding_to_symbol.get(&binding).copied())
            .collect();
        source_escape_reactive_symbols.extend(imported_reactive_symbols.iter().copied());
        let component_parameter_symbols: BTreeSet<_> = self
            .function_facts
            .iter()
            .filter(|function| {
                self.functions[function.id.as_usize()].kind == FunctionKind::Component
            })
            .flat_map(|function| function.parameters.iter())
            .flat_map(|parameter| parameter.bindings.iter().copied())
            .collect();
        let mut reactive_symbols = source_reactive_symbols.clone();
        reactive_symbols.extend(component_parameter_symbols.iter().copied());

        let mut dependencies = ReactiveBindingDependencyCollector {
            scoping: self.semantic.scoping(),
            facts: Vec::new(),
        };
        dependencies.visit_program(program);
        propagate_reactive_symbols(&mut reactive_symbols, &dependencies.facts);
        let hook_return_shapes = collect_local_hook_return_shapes(
            program,
            self.semantic.scoping(),
            &self.function_by_span,
            &self.functions,
            calls,
            &binding_to_symbol,
            &self.macro_bindings,
        );
        let mut escape_reactive_symbols = source_escape_reactive_symbols;
        // The legacy escape pass propagates state/memo/imported-reactive aliases, but treats
        // component parameters as direct roots only. Propagating every props-derived local would
        // reject ordinary resource keys and event callbacks. Runtime reactive factory results
        // still participate in DOM dependency tracking, but do not become escape roots merely
        // because they came from store/resource/selector.
        propagate_reactive_symbols(&mut escape_reactive_symbols, &dependencies.facts);
        escape_reactive_symbols.extend(component_parameter_symbols);

        ReactiveSymbolAnalysis {
            state,
            state_receivers,
            reactive: reactive_symbols,
            escape_reactive: escape_reactive_symbols,
            hook_return_shapes,
            dependencies: dependencies.facts,
        }
    }

    fn validate_state_method_calls(
        &mut self,
        calls: &[CallFact],
        state_symbols: &BTreeSet<SymbolId>,
        state_receivers: &BTreeMap<SymbolId, StateReceiverKind>,
        aliases: &StaticHookAliases,
    ) {
        for call in calls {
            let Some(place) = call.callee_reference.as_ref() else {
                continue;
            };
            let PlannedPlaceBase::Binding(symbol) = place.base else {
                continue;
            };
            if !state_symbols.contains(&symbol) {
                continue;
            }
            let Some(method) = place.projections.last() else {
                continue;
            };
            let receiver = state_receivers
                .get(&symbol)
                .copied()
                .unwrap_or(StateReceiverKind::Unknown);
            let read_only = matches!(
                method,
                PlannedProjection::Static { name, .. }
                    if classify_state_method_call(receiver, name)
                        == StateMethodCallSemantics::ReadOnlyReceiver
                        && aliases.builtin_prototype_method_is_intact(receiver, name)
                        && static_alias_path_from_place(place, true)
                            .is_some_and(|path| aliases.path_is_intact(&path))
            );
            if !read_only {
                self.report_nested_reactive_mutation(call.span);
            }
        }
    }

    fn validate_dynamic_property_access(
        &mut self,
        program: &Program<'_>,
        reactive_symbols: &BTreeSet<SymbolId>,
    ) {
        let mut dynamic = DynamicReactivePropertyCollector {
            scoping: self.semantic.scoping(),
            reactive_symbols,
            spans: BTreeSet::new(),
        };
        dynamic.visit_program(program);
        for (start, end) in dynamic.spans {
            let span = SourceSpan::new(start, end).expect("ordered OXC member span");
            self.diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::new("FICT-H").expect("diagnostic literal"),
                    if self.strict_guarantee {
                        DiagnosticSeverity::Error
                    } else {
                        DiagnosticSeverity::Warning
                    },
                    "dynamic property access widens dependency tracking",
                )
                .with_primary_span(span)
                .with_help(
                    "use a static string or numeric property when the reactive shape is known",
                )
                .with_guarantee_class(GuaranteeClass::Fallback),
            );
        }
    }

    fn validate_native_jsx_spreads(&mut self, program: &Program<'_>) {
        let severity = if self.strict_guarantee {
            DiagnosticSeverity::Error
        } else {
            DiagnosticSeverity::Warning
        };
        for span in native_jsx_spreads::collect(program) {
            self.diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::new("FICT-J003").expect("diagnostic literal"),
                    severity,
                    "Spread on native element may include unknown props.",
                )
                .with_primary_span(span)
                .with_guarantee_class(GuaranteeClass::Fallback),
            );
        }
    }

    fn validate_inline_jsx_functions(&mut self, program: &Program<'_>) {
        for span in inline_jsx_functions::collect(program) {
            self.diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::new("FICT-X003").expect("diagnostic literal"),
                    DiagnosticSeverity::Warning,
                    "Inline function in JSX props may cause unnecessary re-renders.",
                )
                .with_primary_span(span)
                .with_guarantee_class(GuaranteeClass::Advisory),
            );
        }
    }

    fn validate_memo_side_effects(&mut self, program: &Program<'_>, calls: &[CallFact]) {
        let memo_calls = calls
            .iter()
            .filter(|call| {
                call.binding
                    .and_then(|binding| self.macro_bindings.get(&binding))
                    == Some(&FictMacroKind::Memo)
                    || matches!(
                        call.runtime_creation_kind,
                        Some(
                            RuntimeReactiveCreationKind::Memo
                                | RuntimeReactiveCreationKind::NamespaceMemo
                        )
                    )
            })
            .map(|call| (call.span.start(), call.span.end()))
            .collect();
        let severity = if self.strict_guarantee {
            DiagnosticSeverity::Error
        } else {
            DiagnosticSeverity::Warning
        };
        for span in memo_side_effects::collect(program, self.semantic.scoping(), &memo_calls) {
            self.diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::new("FICT-M003").expect("diagnostic literal"),
                    severity,
                    "Memo should not contain side effects.",
                )
                .with_primary_span(span)
                .with_guarantee_class(GuaranteeClass::Fallback),
            );
        }
    }

    fn validate_reactive_jsx_writes(
        &mut self,
        program: &Program<'_>,
        reactive_symbols: &BTreeSet<SymbolId>,
    ) {
        let severity = if self.strict_guarantee {
            DiagnosticSeverity::Error
        } else {
            DiagnosticSeverity::Warning
        };
        for span in reactive_jsx_writes::collect(program, self.semantic.scoping(), reactive_symbols)
        {
            self.diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::new("FICT-R007").expect("diagnostic literal"),
                    severity,
                    "Reactive state writes in JSX children cannot be installed as DOM bindings; move the write into an event, effect, or statement before rendering.",
                )
                .with_primary_span(span)
                .with_guarantee_class(GuaranteeClass::Fallback),
            );
        }
    }

    /// Enforces the legacy-compatible escape contract while the OXC frontend still owns
    /// binding-resolved source expressions. The resulting diagnostics are policy-neutral;
    /// the compiler facade applies warning overrides and strict escalation afterwards.
    fn validate_reactive_escapes(
        &mut self,
        program: &Program<'_>,
        calls: &[CallFact],
        known_arrays: &BTreeSet<SymbolId>,
        reactive: &ReactiveSymbolAnalysis,
        classes: &ClassBindingCollector<'_>,
        callback_aliases: &StaticHookAliases,
    ) {
        let binding_owners: BTreeMap<_, _> = self
            .frontend
            .bindings
            .iter()
            .map(|binding| {
                (
                    SymbolId::from_usize(binding.id.as_usize()),
                    self.function_owner_for_scope(binding.scope),
                )
            })
            .collect();
        let mut captures = FunctionCaptureCollector {
            scoping: self.semantic.scoping(),
            reactive_symbols: &reactive.escape_reactive,
            binding_owners: &binding_owners,
            function_by_span: &self.function_by_span,
            stack: vec![FunctionId::new(0)],
            captures: BTreeMap::new(),
        };
        captures.visit_program(program);

        let capturing_functions: Vec<_> = captures
            .captures
            .iter()
            .filter(|(_, symbols)| !symbols.is_empty())
            .map(|(function, symbols)| {
                (
                    self.function_facts[function.as_usize()].span,
                    symbols.clone(),
                )
            })
            .collect();
        let mut callback_captures: BTreeMap<SymbolId, BTreeSet<SymbolId>> = BTreeMap::new();
        for function in &self.function_facts {
            let mut captured: BTreeSet<SymbolId> = BTreeSet::new();
            for (span, symbols) in &capturing_functions {
                if !span_contains(function.span, *span) {
                    continue;
                }
                captured.extend(
                    symbols
                        .iter()
                        .filter(|symbol| binding_owners.get(symbol).copied() != Some(function.id)),
                );
            }
            if let (Some(binding), false) = (function.binding, captured.is_empty()) {
                callback_captures
                    .entry(binding)
                    .or_default()
                    .extend(captured);
            }
        }
        for (&binding, &span) in &classes.bindings {
            let mut captured: BTreeSet<SymbolId> = BTreeSet::new();
            for (function_span, symbols) in &capturing_functions {
                if span_contains(span, *function_span) {
                    captured.extend(symbols);
                }
            }
            if !captured.is_empty() {
                callback_captures
                    .entry(binding)
                    .or_default()
                    .extend(captured);
            }
        }
        loop {
            let mut changed = false;
            for dependency in &reactive.dependencies {
                if !dependency.callback_container {
                    continue;
                }
                let mut captured = BTreeSet::new();
                for source in &dependency.sources {
                    if let Some(source_captures) = callback_captures.get(source) {
                        captured.extend(source_captures);
                    }
                }
                for (span, symbols) in &capturing_functions {
                    if span_contains(dependency.source_span, *span) {
                        captured.extend(symbols);
                    }
                }
                if captured.is_empty() {
                    continue;
                }
                for target in &dependency.targets {
                    let target_captures = callback_captures.entry(*target).or_default();
                    for symbol in &captured {
                        changed |= target_captures.insert(*symbol);
                    }
                }
            }
            if !changed {
                break;
            }
        }

        let mut property_facts = CallbackPropertyCollector {
            scoping: self.semantic.scoping(),
            properties: Vec::new(),
            class_properties: Vec::new(),
            class_instances: Vec::new(),
        };
        property_facts.visit_program(program);
        let mut callback_property_captures: BTreeMap<(SymbolId, String), BTreeSet<SymbolId>> =
            BTreeMap::new();
        for property in &property_facts.properties {
            let mut captured: BTreeSet<SymbolId> = BTreeSet::new();
            for source in &property.sources {
                if let Some(source_captures) = callback_captures.get(source) {
                    captured.extend(source_captures);
                }
            }
            for (span, symbols) in &capturing_functions {
                if span_contains(property.source_span, *span) {
                    captured.extend(symbols);
                }
            }
            if !captured.is_empty() {
                callback_property_captures
                    .entry((property.target, property.property.clone()))
                    .or_default()
                    .extend(captured);
            }
        }
        let mut instance_class_properties: BTreeMap<(SymbolId, String), BTreeSet<SymbolId>> =
            BTreeMap::new();
        for property in &property_facts.class_properties {
            let mut captured: BTreeSet<SymbolId> = BTreeSet::new();
            for (span, symbols) in &capturing_functions {
                if span_contains(property.source_span, *span) {
                    captured.extend(symbols);
                }
            }
            if captured.is_empty() {
                continue;
            }
            if property.is_static {
                callback_property_captures
                    .entry((property.class, property.property.clone()))
                    .or_default()
                    .extend(captured);
            } else {
                instance_class_properties
                    .entry((property.class, property.property.clone()))
                    .or_default()
                    .extend(captured);
            }
        }
        for instance in &property_facts.class_instances {
            for ((class, property), captured) in &instance_class_properties {
                if *class == instance.class {
                    callback_property_captures
                        .entry((instance.instance, property.clone()))
                        .or_default()
                        .extend(captured);
                }
            }
        }
        let mutable_callback_symbols = self
            .frontend
            .bindings
            .iter()
            .filter(|binding| binding.mutated)
            .map(|binding| SymbolId::from_usize(binding.id.as_usize()))
            .collect::<BTreeSet<_>>();
        let callback_timings = collect_callback_timings(
            &self.function_facts,
            &property_facts,
            &mutable_callback_symbols,
        );

        let imports: BTreeMap<_, _> = self
            .frontend
            .bindings
            .iter()
            .filter_map(|binding| {
                let mapped = self.old_to_new.get(&binding.id.index()).copied()?;
                let import = binding.import.as_ref()?;
                let fict_hir::ImportedName::Named(imported) = &import.imported else {
                    return None;
                };
                Some((
                    mapped,
                    EscapeImportIdentity {
                        source: import.source.clone(),
                        imported: imported.clone(),
                    },
                ))
            })
            .collect();
        let local_hook_bindings: BTreeSet<_> = self
            .functions
            .iter()
            .filter(|function| function.kind == FunctionKind::Hook)
            .filter_map(|function| function.binding)
            .collect();
        let call_facts: BTreeMap<_, _> = calls
            .iter()
            .map(|call| ((call.span.start(), call.span.end()), call))
            .collect();
        let mut receiver_seeds = reactive.state_receivers.clone();
        receiver_seeds.extend(
            known_arrays
                .iter()
                .map(|symbol| (*symbol, StateReceiverKind::Array)),
        );
        let proven_receivers =
            collect_proven_receiver_kinds(program, self.semantic.scoping(), &receiver_seeds);
        let mut collector = ReactiveEscapeCollector {
            scoping: self.semantic.scoping(),
            call_facts: &call_facts,
            macro_bindings: &self.macro_bindings,
            local_hook_bindings: &local_hook_bindings,
            imports: &imports,
            known_arrays,
            state_symbols: &reactive.state,
            proven_receivers: &proven_receivers,
            reactive_symbols: &reactive.escape_reactive,
            hook_return_shapes: &reactive.hook_return_shapes,
            capturing_functions: &capturing_functions,
            callback_captures: &callback_captures,
            callback_property_captures: &callback_property_captures,
            callback_timings: &callback_timings,
            callback_aliases,
            diagnostics: Vec::new(),
        };
        collector.visit_program(program);

        let symbol_names: BTreeMap<_, _> = self
            .frontend
            .bindings
            .iter()
            .map(|binding| {
                (
                    SymbolId::from_usize(binding.id.as_usize()),
                    binding.display_name.clone(),
                )
            })
            .collect();
        let severity = if self.strict_guarantee {
            DiagnosticSeverity::Error
        } else {
            DiagnosticSeverity::Warning
        };
        for fact in collector.diagnostics {
            let (code, message, help) = match fact.kind {
                EscapeDiagnosticKind::StateSnapshot => (
                    "FICT-S002",
                    "state variable is passed as an argument; this passes a value snapshot and may escape component scope".to_owned(),
                    "pass an accessor or place the read inside a known reactive scope",
                ),
                EscapeDiagnosticKind::ReactiveValue => (
                    "FICT-R002",
                    "reactive value escapes scope when passed to an unknown function; dependency tracking may be imprecise".to_owned(),
                    "pass an accessor, memoize explicitly, or use a known synchronous host",
                ),
                EscapeDiagnosticKind::CallbackCapture(symbols) => {
                    let names = symbols
                        .iter()
                        .filter_map(|symbol| symbol_names.get(symbol))
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ");
                    (
                        "FICT-R005",
                        format!(
                            "function captures reactive variable(s): {names}; the callback may escape its reactive owner"
                        ),
                        "pass captured values as parameters or memoize explicitly",
                    )
                }
            };
            self.diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::new(code).expect("diagnostic literal"),
                    severity,
                    message,
                )
                .with_primary_span(fact.span)
                .with_help(help)
                .with_guarantee_class(GuaranteeClass::Fallback),
            );
        }
    }

    fn build_function_shells(&mut self) {
        let module_scope = self
            .function_facts
            .first()
            .map_or(ScopeId::new(0), |fact| fact.scope);
        let module_policy = |kind| {
            self.frontend
                .source_facts
                .directives
                .iter()
                .any(|directive| directive.scope == module_scope && directive.kind == kind)
        };
        let module_no_memo = module_policy(FictDirectiveKind::NoMemo);
        let module_pure = module_policy(FictDirectiveKind::Pure);
        for mut fact in self.function_facts.clone() {
            // Program directives are module policy and apply to every function in the file.
            // Function-scoped directives remain local to the exact semantic scope below.
            fact.flags.no_memo |= module_no_memo;
            fact.flags.pure |= module_pure;
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
                let rest_bindings: Vec<_> = parameter
                    .rest_bindings
                    .iter()
                    .filter_map(|symbol| self.symbol_to_binding.get(symbol).copied())
                    .collect();
                let direct_binding = parameter
                    .direct_binding
                    .and_then(|symbol| self.symbol_to_binding.get(&symbol).copied());
                direct_parameter_bindings.extend(direct_binding);
                let (object_properties, object_rest) = self
                    .lower_object_parameter(parameter)
                    .map_or((None, None), |(properties, rest)| (Some(properties), rest));
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
                    rest_bindings,
                    is_rest: parameter.is_rest,
                    default_value: parameter.default_value.map(Origin::source),
                    object_properties,
                    object_rest,
                    origin,
                });
                values.push(HirValue {
                    id: ValueId::new(count_u32(values.len())),
                    kind: ValueKind::Parameter(local),
                    origin,
                });
            }

            let accessor_parameter_bindings: BTreeSet<_> = parameters
                .iter()
                .flat_map(|parameter| parameter.object_properties.iter().flatten())
                .filter(|property| property.mode == HirObjectParameterMode::Accessor)
                .map(|property| property.binding)
                .collect();

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
                    kind: if accessor_parameter_bindings.contains(&hir_binding) {
                        LocalKind::Parameter
                    } else {
                        LocalKind::User
                    },
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
                parent: fact.parent,
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
                        origin: Origin::generated(
                            Some(fact.body_span),
                            GeneratedOrigin::ControlFlow,
                        ),
                    },
                    source_hint: None,
                    origin,
                }],
                entry: BlockId::new(0),
                effect_statements: Vec::new(),
                regions: Vec::<RegionId>::new(),
                origin,
            });
        }
    }

    fn apply_control_flow_plans(&mut self) {
        for (function_id, plan) in &self.control_flow_plans {
            if !plan.supported || !plan.has_control_flow {
                continue;
            }
            let function = &mut self.functions[function_id.as_usize()];
            let declarations = std::mem::take(&mut function.blocks[0].instructions);
            function.blocks = plan
                .blocks
                .iter()
                .map(|block| HirBlock {
                    id: block.id,
                    scope: block.scope,
                    instructions: Vec::new(),
                    terminator: HirTerminator {
                        kind: TerminatorKind::Unreachable,
                        origin: Origin::source(block.origin),
                    },
                    source_hint: block.source_kind.clone().map(|kind| StructuredSourceHint {
                        kind,
                        exit: block.source_exit,
                        switch_cases: block.source_switch_cases.clone(),
                        origin: Origin::source(block.source_origin.unwrap_or(block.origin)),
                    }),
                    origin: Origin::source(block.origin),
                })
                .collect();
            for declaration in declarations {
                let block = if matches!(
                    declaration.kind,
                    HirInstructionKind::Declare {
                        declaration_kind: DeclarationKind::Var,
                        ..
                    }
                ) {
                    function.entry
                } else {
                    declaration
                        .origin
                        .primary_span
                        .map_or(function.entry, |span| plan.block_for_span(span))
                };
                function.blocks[block.as_usize()]
                    .instructions
                    .push(declaration);
            }
        }
    }

    fn lower_object_parameter(
        &self,
        parameter: &ParameterFact,
    ) -> Option<(
        Vec<HirObjectParameterProperty>,
        Option<HirObjectParameterRest>,
    )> {
        let object = parameter.object.as_ref()?;
        let properties = object
            .properties
            .iter()
            .map(|property| {
                let binding = self.symbol_to_binding.get(&property.binding).copied()?;
                let mut references = Vec::new();
                let mut mutated = false;
                for reference in self.semantic.symbol_references(property.binding) {
                    if reference.is_write() {
                        mutated = true;
                        continue;
                    }
                    if !reference.is_read() {
                        continue;
                    }
                    let node = self.semantic.nodes().get_node(reference.node_id());
                    let AstKind::IdentifierReference(identifier) = node.kind() else {
                        return None;
                    };
                    if reference_is_jsx_closing_name(self.semantic, reference.node_id()) {
                        continue;
                    }
                    references.push(Origin::source(source_span(identifier.span)));
                }
                let mode = if mutated {
                    HirObjectParameterMode::Mutable
                } else {
                    callable_prop_mode(
                        self.semantic,
                        property.binding,
                        property.default_value.is_some(),
                    )
                };
                if mode != HirObjectParameterMode::Accessor {
                    references.clear();
                }
                let default_dependencies = property
                    .default_value
                    .map_or_else(Vec::new, |default| self.prop_default_dependencies(default));
                Some(HirObjectParameterProperty {
                    path: property.path.clone(),
                    binding,
                    mode,
                    checks: property
                        .checks
                        .iter()
                        .map(|check| HirObjectParameterCheck {
                            path: check.path.clone(),
                            origin: Origin::source(check.origin),
                        })
                        .collect(),
                    references,
                    default_value: property.default_value.map(Origin::source),
                    default_dependencies,
                    origin: Origin::source(property.origin),
                })
            })
            .collect::<Option<Vec<_>>>()?;
        let rest = if let Some(rest) = &object.rest {
            if self
                .semantic
                .symbol_references(rest.binding)
                .any(|reference| reference.is_write())
            {
                return None;
            }
            Some(HirObjectParameterRest {
                binding: self.symbol_to_binding.get(&rest.binding).copied()?,
                excluded: rest.excluded.clone(),
                origin: Origin::source(rest.origin),
            })
        } else {
            None
        };
        Some((properties, rest))
    }

    fn prop_default_dependencies(&self, default: SourceSpan) -> Vec<BindingId> {
        let mut dependencies: Vec<_> = self
            .symbol_to_binding
            .iter()
            .filter_map(|(symbol, binding)| {
                self.semantic
                    .symbol_references(*symbol)
                    .filter(|reference| reference.is_read())
                    .any(|reference| {
                        let node = self.semantic.nodes().get_node(reference.node_id());
                        matches!(node.kind(), AstKind::IdentifierReference(identifier)
                            if default.start() <= identifier.span.start
                                && identifier.span.end <= default.end())
                    })
                    .then_some(*binding)
            })
            .collect();
        dependencies.sort_unstable();
        dependencies.dedup();
        dependencies
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

    fn validate_missing_hook_metadata(&mut self, calls: &[CallFact], aliases: &StaticHookAliases) {
        for call in calls {
            let target = call
                .callee_reference
                .as_ref()
                .and_then(|place| static_alias_path_from_place(place, true))
                .or_else(|| {
                    let binding = call.binding?;
                    self.symbol_to_binding
                        .iter()
                        .find_map(|(symbol, candidate)| {
                            (*candidate == binding).then(|| StaticAliasPath::root(*symbol))
                        })
                });
            let Some(target) = target else {
                continue;
            };
            let target_is_hook_like = call.hook.is_some()
                || target
                    .properties
                    .last()
                    .is_some_and(|name| is_hook_name(name))
                || (target.properties.is_empty()
                    && target
                        .binding_root()
                        .and_then(|root| self.symbol_to_binding.get(&root))
                        .and_then(|binding| {
                            self.frontend.bindings.iter().find(|candidate| {
                                self.old_to_new.get(&candidate.id.index()).copied()
                                    == Some(*binding)
                            })
                        })
                        .is_some_and(|binding| is_hook_name(&binding.display_name)));
            let resolved = aliases.resolve(&target);
            let Some(binding) = resolved
                .binding_root()
                .and_then(|root| self.symbol_to_binding.get(&root).copied())
            else {
                continue;
            };
            let Some(frontend_binding) = self.frontend.bindings.iter().find(|candidate| {
                self.old_to_new.get(&candidate.id.index()).copied() == Some(binding)
            }) else {
                continue;
            };
            let Some(import) = frontend_binding.import.as_ref() else {
                continue;
            };
            if !self.unavailable_metadata_sources.contains(&import.source)
                || (!target_is_hook_like
                    && !requires_imported_hook_metadata(
                        frontend_binding,
                        import,
                        call.hook.as_ref(),
                    ))
                || imported_hook_metadata_available(import, &resolved.properties)
            {
                continue;
            }
            self.diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::new("FICT-H003").expect("diagnostic literal"),
                    DiagnosticSeverity::Warning,
                    "imported hook metadata is unavailable or belongs to an unresolved module boundary",
                )
                .with_primary_span(call.callee_span)
                .with_help(
                    "provide an authoritative resolved metadata snapshot or make the bundler resolution unambiguous",
                )
                .with_guarantee_class(GuaranteeClass::Fallback),
            );
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
        variable_declarations: &[VariableDeclarationFact],
        typed_expression_collector: &TypedExpressionCollector<'_>,
        mutation_collector: &MutationCollector<'_>,
        member_reads: &[MemberReadFact],
        jsx_roots: &[JsxFact],
    ) {
        let typed_expressions = typed_expression_collector.facts.as_slice();
        let classes = typed_expression_collector.classes.as_slice();
        let decorators = typed_expression_collector.decorators.as_slice();
        let mutations = mutation_collector.facts.as_slice();
        let pattern_assignments = mutation_collector.pattern_assignments.as_slice();
        let mut reactive_targets: BTreeSet<_> = calls
            .iter()
            .filter(|call| {
                call.binding
                    .and_then(|binding| self.macro_bindings.get(&binding))
                    .is_some_and(|kind| matches!(kind, FictMacroKind::State | FictMacroKind::Memo))
            })
            .filter_map(|call| call.direct_variable_binding)
            .collect();
        reactive_targets.extend(
            calls
                .iter()
                .filter(|call| {
                    call.binding
                        .and_then(|binding| {
                            self.imported_hook_direct_kind(binding, call.callee_reference.as_ref())
                        })
                        .is_some_and(|kind| {
                            matches!(
                                kind,
                                ImportedReactiveKind::Signal | ImportedReactiveKind::Memo
                            )
                        })
                })
                .filter_map(|call| call.direct_variable_binding),
        );
        reactive_targets.extend(self.frontend.bindings.iter().filter_map(|binding| {
            let reactive = binding.import.as_ref().and_then(|import| import.reactive)?;
            matches!(
                reactive,
                ImportedReactiveKind::Signal | ImportedReactiveKind::Memo
            )
            .then(|| self.old_to_new.get(&binding.id.index()).copied())
            .flatten()
        }));
        self.reactive_value_bindings = reactive_targets.clone();
        let mut opaque_patterns: Vec<_> = variable_declarations
            .iter()
            .filter(|declaration| {
                declaration.initializer_span.is_some() && declaration.simple_binding.is_none()
            })
            .map(|declaration| {
                (
                    self.function_owner_for_span(declaration.declarator_span),
                    declaration.pattern_span,
                )
            })
            .collect();
        opaque_patterns.extend(pattern_assignments.iter().map(|assignment| {
            (
                self.function_owner_for_span(assignment.span),
                assignment.pattern_span,
            )
        }));
        let mut accessor_read_suppressions = BTreeSet::new();
        for jsx in jsx_roots {
            collect_reactive_component_accessor_spans(
                &jsx.root,
                &self.symbol_to_binding,
                &reactive_targets,
                &mut accessor_read_suppressions,
            );
        }
        let mut projected_root_suppressions: BTreeSet<_> = member_reads
            .iter()
            .filter_map(|fact| fact.place.root_reference_span)
            .chain(
                mutations
                    .iter()
                    .filter_map(|fact| fact.place.as_ref()?.root_reference_span),
            )
            .chain(pattern_assignments.iter().flat_map(|assignment| {
                assignment
                    .projected_targets
                    .iter()
                    .filter_map(|target| target.place.root_reference_span)
            }))
            .chain(
                typed_expressions
                    .iter()
                    .filter_map(typed_expression_reference_suppression),
            )
            .map(|span| (span.start(), span.end()))
            .collect();
        projected_root_suppressions.extend(
            typed_expression_collector
                .class_self_references
                .iter()
                .copied(),
        );
        let reads = self.collect_reads(
            &reactive_targets,
            &accessor_read_suppressions,
            &projected_root_suppressions,
            &opaque_patterns,
        );
        self.preintern_globals(typed_expressions, mutations, member_reads, &reads);
        let local_mutations =
            self.collect_local_mutations(mutations, &reactive_targets, &opaque_patterns);
        for assignment in pattern_assignments {
            for target in &assignment.projected_targets {
                let reactive = match target.place.base {
                    PlannedPlaceBase::Binding(symbol) => self
                        .symbol_to_binding
                        .get(&symbol)
                        .is_some_and(|binding| reactive_targets.contains(binding)),
                    PlannedPlaceBase::UnresolvedGlobal { .. }
                    | PlannedPlaceBase::Context { .. }
                    | PlannedPlaceBase::Expression { .. } => false,
                };
                if reactive {
                    self.report_nested_reactive_mutation(target.span);
                }
            }
        }
        for fact in self.function_facts.clone() {
            let has_structured_control_flow = self.has_structured_control_flow(fact.id);
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

            for read in reads.iter().filter(|read| read.owner == fact.id) {
                let block = self.planned_block_for_span(fact.id, read.span);
                let semantics = match read.place.base {
                    PlannedPlaceBase::Binding(_) if read.reactive => reactive_read_semantics(),
                    PlannedPlaceBase::Binding(_) => InstructionSemantics::PURE_EAGER,
                    PlannedPlaceBase::UnresolvedGlobal { .. }
                    | PlannedPlaceBase::Context { .. }
                    | PlannedPlaceBase::Expression { .. } => {
                        InstructionSemantics::CONSERVATIVE_EAGER
                    }
                };
                let Some(place) = self.materialize_planned_place(fact.id, block, &read.place)
                else {
                    continue;
                };
                let value = self.push_value_to_block(
                    fact.id,
                    block,
                    ValueKind::InstructionResult,
                    Origin::source(read.span),
                    HirInstructionKind::Read { place },
                    semantics,
                );
                inputs.push(value);
            }

            let mut evaluation_facts: Vec<_> = calls
                .iter()
                .filter(|call| {
                    call.owner == fact.id
                        && (!span_is_within_owned_pattern(
                            call.owner,
                            call.span,
                            &opaque_patterns,
                        ) || call.reactive_kind.is_some()
                            || call.configured_reactive_scope
                            || call.binding.is_some_and(|binding| {
                                self.macro_bindings.contains_key(&binding)
                                    || self.configured_bindings.contains(&binding)
                            }))
                })
                .cloned()
                .map(EvaluationFact::Call)
                .chain(
                    jsx_roots
                        .iter()
                        .filter(|jsx| jsx.owner == fact.id)
                        .cloned()
                        .map(EvaluationFact::Jsx),
                )
                .chain(
                    typed_expressions
                        .iter()
                        .filter(|expression| {
                            let owner = self.function_owner_for_span(expression.span);
                            owner == fact.id
                                && !span_is_within_owned_pattern(
                                    owner,
                                    expression.span,
                                    &opaque_patterns,
                                )
                        })
                        .cloned()
                        .map(EvaluationFact::Typed),
                )
                .chain(
                    member_reads
                        .iter()
                        .filter(|member| {
                            let owner = self.function_owner_for_span(member.span);
                            owner == fact.id
                                && (!span_is_within_owned_pattern(
                                    owner,
                                    member.span,
                                    &opaque_patterns,
                                ) || matches!(
                                    member.place.base,
                                    PlannedPlaceBase::Binding(symbol)
                                        if self
                                            .symbol_to_binding
                                            .get(&symbol)
                                            .is_some_and(|binding| reactive_targets.contains(binding))
                                ))
                        })
                        .cloned()
                        .map(EvaluationFact::Member),
                )
                .chain(
                    local_mutations
                        .iter()
                        .filter(|mutation| mutation.owner == fact.id)
                        .cloned()
                        .map(EvaluationFact::Mutation),
                )
                .chain(
                    pattern_assignments
                        .iter()
                        .filter(|assignment| {
                            self.function_owner_for_span(assignment.span) == fact.id
                        })
                        .cloned()
                        .map(EvaluationFact::PatternAssignment),
                )
                .chain(
                    decorators
                        .iter()
                        .filter(|decorator| {
                            self.function_owner_for_span(decorator.span) == fact.id
                        })
                        .copied()
                        .map(EvaluationFact::Decorator),
                )
                .chain(
                    classes
                        .iter()
                        .filter(|class| self.function_owner_for_span(class.span) == fact.id)
                        .cloned()
                        .map(EvaluationFact::Class),
                )
                .collect();
            evaluation_facts.sort_by_key(|event| {
                let span = event.span();
                (span.end(), std::cmp::Reverse(span.start()), event.rank())
            });
            for event in &evaluation_facts {
                let value = match event {
                    EvaluationFact::Typed(expression) => {
                        self.materialize_typed_expression(fact.id, expression)
                    }
                    EvaluationFact::Jsx(jsx) => Some(self.materialize_jsx(fact.id, jsx)),
                    EvaluationFact::Call(call) => self.materialize_call(fact.id, call),
                    EvaluationFact::Member(member) => self.materialize_member_read(fact.id, member),
                    EvaluationFact::Mutation(mutation) => {
                        self.materialize_mutation(fact.id, mutation)
                    }
                    EvaluationFact::PatternAssignment(assignment) => {
                        self.materialize_pattern_assignment(fact.id, assignment)
                    }
                    EvaluationFact::Decorator(decorator) => {
                        Some(self.materialize_decorator(fact.id, decorator))
                    }
                    EvaluationFact::Class(class) => Some(self.materialize_class(fact.id, class)),
                };
                inputs.extend(value);
            }

            let owned_declarations: Vec<_> = variable_declarations
                .iter()
                .filter(|declaration| {
                    self.function_owner_for_span(declaration.declarator_span) == fact.id
                })
                .cloned()
                .collect();
            for declaration in &owned_declarations {
                inputs.extend(self.materialize_variable_declaration(fact.id, declaration));
            }

            for (_, pattern) in opaque_patterns
                .iter()
                .filter(|(owner, _)| *owner == fact.id)
            {
                self.mark_pattern_children_deferred(fact.id, *pattern);
            }

            if !has_structured_control_flow {
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
                if let [return_fact] = fact.returns.as_slice() {
                    let value = return_fact.value.map(|span| {
                        self.control_expression_value(fact.id, BlockId::new(0), span, true, true)
                    });
                    self.functions[fact.id.as_usize()].blocks[0].terminator = HirTerminator {
                        kind: TerminatorKind::Return { value },
                        origin: Origin::source(return_fact.statement),
                    };
                }
            }
            self.materialize_control_flow_terminators(fact.id);
            self.order_function_instructions(fact.id);
        }
    }

    fn collect_reads(
        &self,
        reactive_targets: &BTreeSet<BindingId>,
        suppressions: &BTreeSet<(u32, u32)>,
        projected_root_suppressions: &BTreeSet<(u32, u32)>,
        opaque_patterns: &[(FunctionId, SourceSpan)],
    ) -> Vec<ReadFact> {
        let mut reads = Vec::new();
        for (symbol, binding) in &self.symbol_to_binding {
            for reference in self.semantic.scoping().get_resolved_reference_ids(*symbol) {
                let reference = self.semantic.scoping().get_reference(*reference);
                if !reference.is_read()
                    || reference.is_write()
                    || reference_is_inside_with(self.semantic.scoping(), reference.scope_id())
                {
                    continue;
                }
                let span = source_span(self.semantic.reference_span(reference));
                if projected_root_suppressions.contains(&(span.start(), span.end())) {
                    continue;
                }
                let reactive = reactive_targets.contains(binding);
                let owner = self.function_owner_for_span(span);
                if !reactive && span_is_within_owned_pattern(owner, span, opaque_patterns) {
                    continue;
                }
                if reactive && suppressions.contains(&(span.start(), span.end())) {
                    continue;
                }
                reads.push(ReadFact {
                    owner,
                    place: PlannedPlace {
                        base: PlannedPlaceBase::Binding(*symbol),
                        projections: Vec::new(),
                        root_reference_span: Some(span),
                    },
                    span,
                    reactive,
                });
            }
        }
        for (name, reference_ids) in self.semantic.scoping().root_unresolved_references() {
            for reference_id in reference_ids {
                let reference = self.semantic.scoping().get_reference(*reference_id);
                if !reference.is_read()
                    || reference.is_write()
                    || reference_is_inside_with(self.semantic.scoping(), reference.scope_id())
                {
                    continue;
                }
                let span = source_span(self.semantic.reference_span(reference));
                if projected_root_suppressions.contains(&(span.start(), span.end()))
                    || suppressions.contains(&(span.start(), span.end()))
                {
                    continue;
                }
                let owner = self.function_owner_for_span(span);
                if name == "arguments" && owner != FunctionId::new(0) {
                    continue;
                }
                if span_is_within_owned_pattern(owner, span, opaque_patterns) {
                    continue;
                }
                reads.push(ReadFact {
                    owner,
                    place: PlannedPlace {
                        base: PlannedPlaceBase::UnresolvedGlobal {
                            name: name.to_string(),
                            span,
                        },
                        projections: Vec::new(),
                        root_reference_span: Some(span),
                    },
                    span,
                    reactive: false,
                });
            }
        }
        reads.sort_by_key(|read| (read.span.start(), read.span.end()));
        reads
    }

    fn collect_local_mutations(
        &mut self,
        mutations: &[MutationFact],
        reactive_targets: &BTreeSet<BindingId>,
        opaque_patterns: &[(FunctionId, SourceSpan)],
    ) -> Vec<LocalMutationFact> {
        let mut facts = Vec::new();
        for mutation in mutations {
            let binding = mutation
                .symbol
                .and_then(|symbol| self.symbol_to_binding.get(&symbol).copied());
            if mutation.symbol.is_some() && binding.is_none() {
                continue;
            }
            let reactive = binding.is_some_and(|binding| reactive_targets.contains(&binding));
            let owner = self.function_owner_for_span(mutation.span);
            if !reactive && span_is_within_owned_pattern(owner, mutation.span, opaque_patterns) {
                continue;
            }
            if mutation.projected && reactive {
                self.report_nested_reactive_mutation(mutation.span);
            }
            if mutation.projected && mutation.place.is_none() {
                continue;
            }
            let place = mutation.place.clone().or_else(|| {
                mutation.symbol.map(|symbol| PlannedPlace {
                    base: PlannedPlaceBase::Binding(symbol),
                    projections: Vec::new(),
                    root_reference_span: Some(mutation.target_span),
                })
            });
            let Some(place) = place else {
                continue;
            };
            facts.push(LocalMutationFact {
                owner,
                binding,
                place,
                span: mutation.span,
                kind: mutation.kind,
                reactive,
            });
        }
        facts.sort_by_key(|mutation| {
            (
                mutation.span.start(),
                mutation.span.end(),
                mutation.binding.map_or(u32::MAX, BindingId::index),
            )
        });
        facts
    }

    fn report_nested_reactive_mutation(&mut self, span: SourceSpan) {
        self.diagnostics.push(
            Diagnostic::new(
                DiagnosticCode::new("FICT-M").expect("diagnostic literal"),
                if self.strict_guarantee {
                    DiagnosticSeverity::Error
                } else {
                    DiagnosticSeverity::Warning
                },
                "nested mutation through a $state value cannot preserve fine-grained reactivity",
            )
            .with_primary_span(span)
            .with_help("replace the whole state value or use $store for nested mutation")
            .with_guarantee_class(GuaranteeClass::Fallback),
        );
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
        let block = self.planned_block_for_span(owner, span);
        let inputs = self.instruction_inputs_for_spans(owner, block, &[span], true);
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
        self.push_value_to_block(
            owner,
            block,
            ValueKind::SyntaxFragment(fragment),
            Origin::source(span),
            HirInstructionKind::SyntaxFragment { fragment, inputs },
            InstructionSemantics::CONSERVATIVE_EAGER,
        )
    }

    fn materialize_decorator(&mut self, owner: FunctionId, decorator: &DecoratorFact) -> ValueId {
        let block = self.planned_block_for_span(owner, decorator.span);
        let inputs = self.instruction_inputs_for_spans(owner, block, &[decorator.span], true);
        let fragment = self.add_fragment(
            SyntaxFragmentKind::Decorator,
            decorator.span,
            SyntaxSummary {
                referenced_bindings: self.read_referenced_bindings(decorator.span),
                has_side_effects: true,
                may_throw: true,
                contains_decorators: true,
                ..SyntaxSummary::default()
            },
        );
        self.push_value_to_block(
            owner,
            block,
            ValueKind::SyntaxFragment(fragment),
            Origin::source(decorator.span),
            HirInstructionKind::SyntaxFragment { fragment, inputs },
            InstructionSemantics::CONSERVATIVE_EAGER,
        )
    }

    fn materialize_class(&mut self, owner: FunctionId, class: &ClassFact) -> ValueId {
        let block = self.planned_block_for_span(owner, class.span);
        for initializer in &class.deferred_initializers {
            self.mark_span_deferred(owner, block, *initializer);
        }
        let inputs = self.instruction_inputs_for_spans(owner, block, &class.eager_spans, true);
        let declaration_binding = class
            .declaration_binding
            .and_then(|symbol| self.symbol_to_binding.get(&symbol).copied());
        let mut referenced_bindings =
            self.read_referenced_bindings_in_spans(owner, &class.eager_spans);
        if let Some(binding) = declaration_binding {
            // The declaration name is rebound as the inner name of the generated named class
            // expression. It must not become a dependency on the outer derived accessor.
            referenced_bindings.retain(|candidate| *candidate != binding);
        }
        let fragment = self.add_fragment(
            SyntaxFragmentKind::Class,
            class.span,
            SyntaxSummary {
                referenced_bindings,
                has_side_effects: true,
                may_throw: true,
                contains_decorators: !class.decorator_spans.is_empty(),
                ..SyntaxSummary::default()
            },
        );
        let value = self.push_value_to_block(
            owner,
            block,
            ValueKind::SyntaxFragment(fragment),
            Origin::source(class.span),
            HirInstructionKind::SyntaxFragment { fragment, inputs },
            InstructionSemantics::CONSERVATIVE_EAGER,
        );
        if let Some(binding) = declaration_binding
            && let Some(local) = self.functions[owner.as_usize()]
                .locals
                .iter()
                .find(|local| local.binding == Some(binding))
                .map(|local| local.id)
        {
            self.link_lexical_declaration(owner, local, block, value);
        }
        value
    }

    fn instruction_inputs_for_spans(
        &self,
        owner: FunctionId,
        block: BlockId,
        spans: &[SourceSpan],
        eager_only: bool,
    ) -> Vec<ValueId> {
        let mut ordered_inputs: Vec<_> = self.functions[owner.as_usize()].blocks[block.as_usize()]
            .instructions
            .iter()
            .enumerate()
            .filter_map(|(index, instruction)| {
                if eager_only && instruction.semantics.evaluation != EvaluationMode::Eager {
                    return None;
                }
                let value = instruction.result?;
                let candidate = instruction.origin.primary_span?;
                spans
                    .iter()
                    .any(|span| span_contains(*span, candidate))
                    .then_some((candidate.start(), candidate.end(), index, value))
            })
            .collect();
        ordered_inputs.sort_by_key(|(start, end, index, _)| (*start, *end, *index));
        let mut seen = BTreeSet::new();
        ordered_inputs
            .into_iter()
            .filter_map(|(_, _, _, value)| seen.insert(value).then_some(value))
            .collect()
    }

    fn materialize_typed_expression(
        &mut self,
        owner: FunctionId,
        expression: &TypedExpressionFact,
    ) -> Option<ValueId> {
        let block = self.planned_block_for_span(owner, expression.span);
        let origin = Origin::source(expression.span);
        Some(match &expression.kind {
            TypedExpressionKind::Literal(literal) => self.push_value_to_block(
                owner,
                block,
                ValueKind::Literal(literal.clone()),
                origin,
                HirInstructionKind::Literal(literal.clone()),
                InstructionSemantics::PURE_EAGER,
            ),
            TypedExpressionKind::UnresolvedTypeof { identifier, .. } => self.push_value_to_block(
                owner,
                block,
                ValueKind::InstructionResult,
                origin,
                HirInstructionKind::UnresolvedTypeof {
                    identifier: identifier.clone(),
                },
                InstructionSemantics::CONSERVATIVE_EAGER,
            ),
            TypedExpressionKind::Context { kind } => {
                self.materialize_context_value(owner, block, expression.span, *kind)
            }
            TypedExpressionKind::Delete { target } => {
                let deletes_nested_reactive_value = matches!(
                    target,
                    TypedDeleteTarget::Place(PlannedPlace {
                        base: PlannedPlaceBase::Binding(symbol),
                        projections,
                        ..
                    }) if !projections.is_empty()
                        && self
                            .symbol_to_binding
                            .get(symbol)
                            .is_some_and(|binding| self.reactive_value_bindings.contains(binding))
                );
                if deletes_nested_reactive_value {
                    self.report_nested_reactive_mutation(expression.span);
                }
                let target = match target {
                    TypedDeleteTarget::Place(place) => {
                        DeleteTarget::Place(self.materialize_planned_place(owner, block, place)?)
                    }
                    TypedDeleteTarget::UnresolvedIdentifier { identifier, .. } => {
                        DeleteTarget::UnresolvedIdentifier(identifier.clone())
                    }
                    TypedDeleteTarget::Value { span, has_effects } => DeleteTarget::Value(
                        self.control_expression_value(owner, block, *span, true, *has_effects),
                    ),
                };
                let semantics = delete_expression_semantics(&target);
                self.push_value_to_block(
                    owner,
                    block,
                    ValueKind::InstructionResult,
                    origin,
                    HirInstructionKind::Delete { target },
                    semantics,
                )
            }
            TypedExpressionKind::Unary {
                operator,
                argument,
                argument_has_effects,
            } => {
                let argument = self.control_expression_value(
                    owner,
                    block,
                    *argument,
                    true,
                    *argument_has_effects,
                );
                self.push_value_to_block(
                    owner,
                    block,
                    ValueKind::InstructionResult,
                    origin,
                    HirInstructionKind::Unary {
                        operator: *operator,
                        argument,
                    },
                    unary_expression_semantics(*operator),
                )
            }
            TypedExpressionKind::Binary {
                operator,
                left,
                right,
                left_has_effects,
                right_has_effects,
            } => {
                let left =
                    self.control_expression_value(owner, block, *left, true, *left_has_effects);
                let right =
                    self.control_expression_value(owner, block, *right, true, *right_has_effects);
                self.push_value_to_block(
                    owner,
                    block,
                    ValueKind::InstructionResult,
                    origin,
                    HirInstructionKind::Binary {
                        operator: *operator,
                        left,
                        right,
                    },
                    binary_expression_semantics(*operator),
                )
            }
            TypedExpressionKind::Logical {
                operator,
                left,
                right,
                left_has_effects,
                right_has_effects,
            } => {
                let right_span = *right;
                let left =
                    self.control_expression_value(owner, block, *left, true, *left_has_effects);
                let right = self.control_expression_value(
                    owner,
                    block,
                    right_span,
                    true,
                    *right_has_effects,
                );
                self.mark_span_deferred(owner, block, right_span);
                self.push_value_to_block(
                    owner,
                    block,
                    ValueKind::InstructionResult,
                    origin,
                    HirInstructionKind::Binary {
                        operator: *operator,
                        left,
                        right,
                    },
                    InstructionSemantics::PURE_EAGER,
                )
            }
            TypedExpressionKind::Conditional {
                test,
                consequent,
                alternate,
                test_has_effects,
                consequent_has_effects,
                alternate_has_effects,
            } => {
                let consequent_span = *consequent;
                let alternate_span = *alternate;
                let test =
                    self.control_expression_value(owner, block, *test, true, *test_has_effects);
                let consequent = self.control_expression_value(
                    owner,
                    block,
                    consequent_span,
                    true,
                    *consequent_has_effects,
                );
                let alternate = self.control_expression_value(
                    owner,
                    block,
                    alternate_span,
                    true,
                    *alternate_has_effects,
                );
                self.mark_span_deferred(owner, block, consequent_span);
                self.mark_span_deferred(owner, block, alternate_span);
                self.push_value_to_block(
                    owner,
                    block,
                    ValueKind::InstructionResult,
                    origin,
                    HirInstructionKind::Conditional {
                        test,
                        consequent,
                        alternate,
                    },
                    InstructionSemantics::PURE_EAGER,
                )
            }
            TypedExpressionKind::Sequence { values } => {
                let values = values
                    .iter()
                    .map(|value| {
                        self.control_expression_value(
                            owner,
                            block,
                            value.span,
                            true,
                            value.has_effects,
                        )
                    })
                    .collect();
                self.push_value_to_block(
                    owner,
                    block,
                    ValueKind::InstructionResult,
                    origin,
                    HirInstructionKind::Sequence { values },
                    InstructionSemantics::PURE_EAGER,
                )
            }
            TypedExpressionKind::TemplateLiteral {
                quasis,
                expressions,
            } => {
                let expressions = expressions
                    .iter()
                    .map(|expression| {
                        let value = self.control_expression_value(
                            owner,
                            block,
                            expression.span,
                            true,
                            expression.has_effects,
                        );
                        self.mark_span_deferred(owner, block, expression.span);
                        value
                    })
                    .collect();
                self.push_value_to_block(
                    owner,
                    block,
                    ValueKind::InstructionResult,
                    origin,
                    HirInstructionKind::TemplateLiteral {
                        quasis: quasis.clone(),
                        expressions,
                    },
                    InstructionSemantics::CONSERVATIVE_EAGER,
                )
            }
            TypedExpressionKind::TaggedTemplate {
                tag,
                tag_has_effects,
                tag_reference,
                tag_binding,
                quasis,
                substitutions,
            } => {
                let tag = self.control_expression_value(owner, block, *tag, true, *tag_has_effects);
                let tag_reference = tag_reference
                    .as_ref()
                    .and_then(|place| self.materialize_planned_place(owner, block, place));
                let substitutions = substitutions
                    .iter()
                    .map(|substitution| {
                        self.control_expression_value(
                            owner,
                            block,
                            substitution.span,
                            true,
                            substitution.has_effects,
                        )
                    })
                    .collect();
                let host = tag_binding
                    .and_then(|symbol| self.symbol_to_binding.get(&symbol).copied())
                    .map_or(CallHost::Unknown, CallHost::Binding);
                self.push_value_to_block(
                    owner,
                    block,
                    ValueKind::InstructionResult,
                    origin,
                    HirInstructionKind::TaggedTemplate {
                        tag,
                        tag_reference,
                        quasis: quasis.clone(),
                        substitutions,
                        host,
                    },
                    InstructionSemantics::CONSERVATIVE_EAGER,
                )
            }
            TypedExpressionKind::DynamicImport {
                specifier,
                specifier_has_effects,
                options,
                options_have_effects,
                phase,
            } => {
                let specifier = self.control_expression_value(
                    owner,
                    block,
                    *specifier,
                    true,
                    *specifier_has_effects,
                );
                let options = options.map(|options| {
                    self.control_expression_value(
                        owner,
                        block,
                        options,
                        true,
                        *options_have_effects,
                    )
                });
                self.push_value_to_block(
                    owner,
                    block,
                    ValueKind::InstructionResult,
                    origin,
                    HirInstructionKind::DynamicImport {
                        specifier,
                        options,
                        phase: *phase,
                    },
                    InstructionSemantics::CONSERVATIVE_EAGER,
                )
            }
            TypedExpressionKind::Await {
                value,
                value_has_effects,
            } => {
                let value =
                    self.control_expression_value(owner, block, *value, true, *value_has_effects);
                self.push_value_to_block(
                    owner,
                    block,
                    ValueKind::InstructionResult,
                    origin,
                    HirInstructionKind::Await { value },
                    InstructionSemantics::CONSERVATIVE_EAGER,
                )
            }
            TypedExpressionKind::Yield {
                value,
                value_has_effects,
                delegate,
            } => {
                let value = value.map(|value| {
                    self.control_expression_value(owner, block, value, true, *value_has_effects)
                });
                self.push_value_to_block(
                    owner,
                    block,
                    ValueKind::InstructionResult,
                    origin,
                    HirInstructionKind::Yield {
                        value,
                        delegate: *delegate,
                    },
                    InstructionSemantics::CONSERVATIVE_EAGER,
                )
            }
            TypedExpressionKind::New {
                callee,
                callee_has_effects,
                arguments,
            } => {
                let callee =
                    self.control_expression_value(owner, block, *callee, true, *callee_has_effects);
                let mut materialized = Vec::with_capacity(arguments.len());
                let mut owns_evaluation = false;
                for argument in arguments {
                    owns_evaluation |= argument.spread;
                    let value = self.control_expression_value(
                        owner,
                        block,
                        argument.value,
                        true,
                        argument.value_has_effects,
                    );
                    if owns_evaluation {
                        self.mark_span_deferred(owner, block, argument.value);
                    }
                    materialized.push(CallArgument {
                        value,
                        spread: argument.spread,
                    });
                }
                self.push_value_to_block(
                    owner,
                    block,
                    ValueKind::InstructionResult,
                    origin,
                    HirInstructionKind::New {
                        callee,
                        arguments: materialized,
                    },
                    InstructionSemantics::CONSERVATIVE_EAGER,
                )
            }
            TypedExpressionKind::Array { elements } => {
                let mut materialized = Vec::with_capacity(elements.len());
                let mut contains_spread = false;
                for element in elements {
                    match element {
                        TypedArrayElement::Hole(span) => {
                            materialized.push(ArrayElement::Hole(Origin::source(*span)));
                        }
                        TypedArrayElement::Value { span, has_effects } => {
                            let value = self.control_expression_value(
                                owner,
                                block,
                                *span,
                                true,
                                *has_effects,
                            );
                            if contains_spread {
                                self.mark_span_deferred(owner, block, *span);
                            }
                            materialized.push(ArrayElement::Value(value));
                        }
                        TypedArrayElement::Spread {
                            span,
                            origin,
                            has_effects,
                        } => {
                            contains_spread = true;
                            let value = self.control_expression_value(
                                owner,
                                block,
                                *span,
                                true,
                                *has_effects,
                            );
                            self.mark_span_deferred(owner, block, *span);
                            materialized.push(ArrayElement::Spread {
                                value,
                                origin: Origin::source(*origin),
                            });
                        }
                    }
                }
                self.push_value_to_block(
                    owner,
                    block,
                    ValueKind::InstructionResult,
                    origin,
                    HirInstructionKind::Array {
                        elements: materialized,
                    },
                    if contains_spread {
                        InstructionSemantics::CONSERVATIVE_EAGER
                    } else {
                        InstructionSemantics::PURE_EAGER
                    },
                )
            }
            TypedExpressionKind::Object { entries } => {
                let mut materialized = Vec::with_capacity(entries.len());
                let mut owns_evaluation = false;
                for entry in entries {
                    match entry {
                        TypedObjectEntry::Property {
                            key,
                            value,
                            value_has_effects,
                            kind,
                            shorthand,
                            prototype_setter,
                            origin,
                        } => {
                            let key = match key {
                                TypedObjectKey::Static(name) => PropertyKey::Static(name.clone()),
                                TypedObjectKey::Index(index) => PropertyKey::Index(*index),
                                TypedObjectKey::Computed {
                                    expression,
                                    expression_has_effects,
                                } => {
                                    owns_evaluation = true;
                                    let key = self.control_expression_value(
                                        owner,
                                        block,
                                        *expression,
                                        true,
                                        *expression_has_effects,
                                    );
                                    self.mark_span_deferred(owner, block, *expression);
                                    PropertyKey::Computed(key)
                                }
                            };
                            let property_value = self.control_expression_value(
                                owner,
                                block,
                                *value,
                                true,
                                *value_has_effects,
                            );
                            if owns_evaluation {
                                self.mark_span_deferred(owner, block, *value);
                            }
                            materialized.push(ObjectEntry::Property {
                                key,
                                value: property_value,
                                kind: *kind,
                                shorthand: *shorthand,
                                prototype_setter: *prototype_setter,
                                origin: Origin::source(*origin),
                            });
                        }
                        TypedObjectEntry::Spread {
                            value,
                            value_has_effects,
                            origin,
                        } => {
                            owns_evaluation = true;
                            let spread_value = self.control_expression_value(
                                owner,
                                block,
                                *value,
                                true,
                                *value_has_effects,
                            );
                            self.mark_span_deferred(owner, block, *value);
                            materialized.push(ObjectEntry::Spread {
                                value: spread_value,
                                origin: Origin::source(*origin),
                            });
                        }
                    }
                }
                self.push_value_to_block(
                    owner,
                    block,
                    ValueKind::InstructionResult,
                    origin,
                    HirInstructionKind::Object {
                        entries: materialized,
                    },
                    if owns_evaluation {
                        InstructionSemantics::CONSERVATIVE_EAGER
                    } else {
                        InstructionSemantics::PURE_EAGER
                    },
                )
            }
        })
    }

    fn materialize_jsx(&mut self, owner: FunctionId, jsx: &JsxFact) -> ValueId {
        let root = self.lower_jsx_node(owner, &jsx.root);
        let template = TemplateId::new(count_u32(self.templates.len()));
        self.templates.push(JsxTemplate {
            id: template,
            owner,
            root,
            contains_fragment: jsx.contains_fragment,
            origin: Origin::source(jsx.span),
        });
        self.push_value(
            owner,
            ValueKind::InstructionResult,
            Origin::source(jsx.span),
            HirInstructionKind::Jsx { template },
            InstructionSemantics::PURE_EAGER,
        )
    }

    fn materialize_variable_declaration(
        &mut self,
        owner: FunctionId,
        declaration: &VariableDeclarationFact,
    ) -> Vec<ValueId> {
        let Some(initializer_span) = declaration.initializer_span else {
            return Vec::new();
        };
        let block = self.planned_block_for_span(owner, declaration.declarator_span);
        let initializer = self.control_expression_value(
            owner,
            block,
            initializer_span,
            true,
            declaration.initializer_has_effects,
        );
        let mut materialized = vec![initializer];
        let binding_value = if declaration.simple_binding.is_some() {
            initializer
        } else {
            let declared_bindings = declaration
                .bindings
                .iter()
                .filter_map(|symbol| self.symbol_to_binding.get(symbol).copied())
                .collect();
            let fragment = self.add_fragment(
                SyntaxFragmentKind::Pattern,
                declaration.pattern_span,
                SyntaxSummary {
                    referenced_bindings: self.referenced_bindings(declaration.pattern_span),
                    pattern: Some(PatternSummary {
                        declared_bindings,
                        assigned_bindings: Vec::new(),
                        has_defaults: declaration.has_defaults,
                        has_rest: declaration.has_rest,
                    }),
                    has_side_effects: true,
                    may_throw: true,
                    contains_await: declaration.contains_await,
                    contains_yield: declaration.contains_yield,
                    contains_jsx: declaration.contains_jsx,
                    ..SyntaxSummary::default()
                },
            );
            let pattern_value = self.push_value_to_block(
                owner,
                block,
                ValueKind::SyntaxFragment(fragment),
                Origin::source(declaration.pattern_span),
                HirInstructionKind::SyntaxFragment {
                    fragment,
                    inputs: vec![initializer],
                },
                InstructionSemantics::CONSERVATIVE_EAGER,
            );
            materialized.push(pattern_value);
            pattern_value
        };

        for symbol in &declaration.bindings {
            let Some(binding) = self.symbol_to_binding.get(symbol).copied() else {
                continue;
            };
            let Some(local) = self.functions[owner.as_usize()]
                .locals
                .iter()
                .find(|local| local.binding == Some(binding))
                .map(|local| local.id)
            else {
                continue;
            };
            if declaration.declaration_kind == DeclarationKind::Var {
                self.functions[owner.as_usize()].blocks[block.as_usize()]
                    .instructions
                    .push(HirInstruction {
                        result: None,
                        kind: HirInstructionKind::Write {
                            place: fict_hir::Place::local(local),
                            value: binding_value,
                        },
                        semantics: InstructionSemantics {
                            purity: Purity::Impure,
                            mutation: MutationEffect::Local,
                            evaluation: EvaluationMode::Eager,
                            may_throw: false,
                        },
                        origin: Origin::source(declaration.declarator_span),
                    });
            } else {
                self.link_lexical_declaration(owner, local, block, binding_value);
            }
        }
        materialized
    }

    fn link_lexical_declaration(
        &mut self,
        owner: FunctionId,
        local: LocalId,
        target_block: BlockId,
        initializer: ValueId,
    ) {
        let function = &mut self.functions[owner.as_usize()];
        let Some((declaration_block, declaration_index)) =
            function.blocks.iter().find_map(|block| {
                block
                    .instructions
                    .iter()
                    .position(|instruction| {
                        matches!(
                            instruction.kind,
                            HirInstructionKind::Declare {
                                local: candidate,
                                ..
                            } if candidate == local
                        )
                    })
                    .map(|index| (block.id, index))
            })
        else {
            return;
        };
        let mut declaration = function.blocks[declaration_block.as_usize()]
            .instructions
            .remove(declaration_index);
        let HirInstructionKind::Declare {
            initializer: target,
            ..
        } = &mut declaration.kind
        else {
            unreachable!("selected declaration instruction")
        };
        *target = Some(initializer);
        function.blocks[target_block.as_usize()]
            .instructions
            .push(declaration);
    }

    fn materialize_call(&mut self, owner: FunctionId, call: &CallFact) -> Option<ValueId> {
        let block = self.planned_block_for_span(owner, call.span);
        let macro_kind = call
            .binding
            .and_then(|binding| self.macro_bindings.get(&binding).copied());
        let state_receiver_kind = if macro_kind == Some(FictMacroKind::State) {
            call.direct_variable_binding
                .and_then(|binding| {
                    self.symbol_to_binding
                        .iter()
                        .find_map(|(symbol, candidate)| (*candidate == binding).then_some(*symbol))
                })
                .and_then(|symbol| self.state_receivers.get(&symbol).copied())
                .unwrap_or(StateReceiverKind::Unknown)
        } else if self
            .transformed_list_calls
            .contains(&(call.span.start(), call.span.end()))
        {
            StateReceiverKind::Array
        } else {
            call.callee_reference
                .as_ref()
                .and_then(|place| match &place.base {
                    PlannedPlaceBase::Binding(symbol) => self.state_receivers.get(symbol).copied(),
                    PlannedPlaceBase::UnresolvedGlobal { .. }
                    | PlannedPlaceBase::Context { .. }
                    | PlannedPlaceBase::Expression { .. } => None,
                })
                .unwrap_or(StateReceiverKind::Unknown)
        };
        let callee = self.control_expression_value(
            owner,
            block,
            call.callee_span,
            true,
            call.callee_has_effects,
        );
        let callee_reference = call
            .callee_reference
            .as_ref()
            .and_then(|place| self.materialize_planned_place(owner, block, place));
        let mut arguments = Vec::new();
        let mut owns_evaluation = call.arguments_conditional;
        for argument in &call.arguments {
            owns_evaluation |= argument.spread;
            let value = if let Some(function) = argument.function {
                self.push_value_to_block(
                    owner,
                    block,
                    ValueKind::Function(function),
                    Origin::source(argument.span),
                    HirInstructionKind::Function { function },
                    InstructionSemantics::PURE_EAGER,
                )
            } else {
                self.control_expression_value(
                    owner,
                    block,
                    argument.span,
                    true,
                    argument.has_effects,
                )
            };
            if owns_evaluation {
                self.mark_span_deferred(owner, block, argument.span);
            }
            arguments.push(CallArgument {
                value,
                spread: argument.spread,
            });
        }
        let host = if let Some(kind) = self.call_reactive_scope_kind(call) {
            CallHost::ReactiveScope(ReactiveScopeHost {
                callee: call.binding,
                callback_index: 0,
                kind,
            })
        } else if let Some(binding) = call.binding {
            CallHost::Binding(binding)
        } else {
            CallHost::Unknown
        };
        let pure = call.pure && !call.arguments.iter().any(|argument| argument.spread);
        let value = self.push_value_to_block(
            owner,
            block,
            ValueKind::InstructionResult,
            Origin::source(call.span),
            HirInstructionKind::Call(CallInstruction {
                callee,
                callee_reference,
                state_receiver_kind,
                arguments,
                host,
                macro_kind,
                reactive_kind: call.reactive_kind,
                optional: call.optional,
            }),
            InstructionSemantics {
                purity: if pure { Purity::Pure } else { Purity::Unknown },
                mutation: if pure {
                    MutationEffect::None
                } else {
                    MutationEffect::Unknown
                },
                evaluation: EvaluationMode::Eager,
                may_throw: true,
            },
        );
        Some(value)
    }

    fn materialize_mutation(
        &mut self,
        owner: FunctionId,
        mutation: &LocalMutationFact,
    ) -> Option<ValueId> {
        let block = self.planned_block_for_span(owner, mutation.span);
        let place = self.materialize_planned_place(owner, block, &mutation.place)?;
        let projected = !place.projections.is_empty();
        let semantics =
            mutation_semantics(mutation.reactive, projected, mutation.binding.is_none());
        let kind = match mutation.kind {
            ReactiveMutationKind::Write {
                value_span,
                value_has_effects,
            } => {
                let value = self.control_expression_value(
                    owner,
                    block,
                    value_span,
                    true,
                    value_has_effects,
                );
                HirInstructionKind::Write { place, value }
            }
            ReactiveMutationKind::Compound {
                operator,
                value_span,
                value_has_effects,
            } => {
                let value = self.control_expression_value(
                    owner,
                    block,
                    value_span,
                    true,
                    value_has_effects,
                );
                if compound_assignment_is_conditional(operator) {
                    self.mark_span_deferred(owner, block, value_span);
                }
                HirInstructionKind::ReadWrite {
                    place,
                    compound: Some(operator),
                    value: Some(value),
                    update: None,
                    prefix: false,
                }
            }
            ReactiveMutationKind::Update { operator, prefix } => HirInstructionKind::ReadWrite {
                place,
                compound: None,
                value: None,
                update: Some(operator),
                prefix,
            },
        };
        Some(self.push_value_to_block(
            owner,
            block,
            ValueKind::InstructionResult,
            Origin::source(mutation.span),
            kind,
            semantics,
        ))
    }

    fn materialize_pattern_assignment(
        &mut self,
        owner: FunctionId,
        assignment: &PatternAssignmentFact,
    ) -> Option<ValueId> {
        let block = self.planned_block_for_span(owner, assignment.span);
        let value = self.control_expression_value(
            owner,
            block,
            assignment.value_span,
            true,
            assignment.value_has_effects,
        );
        let mut writes = Vec::new();
        let mut assigned_bindings = Vec::new();
        for target in &assignment.targets {
            let Some(binding) = self.symbol_to_binding.get(&target.symbol).copied() else {
                continue;
            };
            if !assigned_bindings.contains(&binding) {
                assigned_bindings.push(binding);
            }
            let Some(local) = self.functions[owner.as_usize()]
                .locals
                .iter()
                .find(|local| local.binding == Some(binding))
                .map(|local| local.id)
            else {
                continue;
            };
            writes.push(HirPatternWrite {
                local,
                origin: Origin::source(target.span),
            });
        }
        let fragment = self.add_fragment(
            SyntaxFragmentKind::Pattern,
            assignment.pattern_span,
            SyntaxSummary {
                referenced_bindings: self.read_referenced_bindings(assignment.pattern_span),
                pattern: Some(PatternSummary {
                    declared_bindings: Vec::new(),
                    assigned_bindings,
                    has_defaults: assignment.has_defaults,
                    has_rest: assignment.has_rest,
                }),
                has_side_effects: true,
                may_throw: true,
                contains_await: assignment.contains_await,
                contains_yield: assignment.contains_yield,
                contains_jsx: assignment.contains_jsx,
                ..SyntaxSummary::default()
            },
        );
        Some(self.push_value_to_block(
            owner,
            block,
            ValueKind::InstructionResult,
            Origin::source(assignment.span),
            HirInstructionKind::PatternAssignment {
                value,
                pattern: fragment,
                writes,
            },
            InstructionSemantics::CONSERVATIVE_EAGER,
        ))
    }

    fn materialize_member_read(
        &mut self,
        owner: FunctionId,
        member: &MemberReadFact,
    ) -> Option<ValueId> {
        let block = self.planned_block_for_span(owner, member.span);
        let place = self.materialize_planned_place(owner, block, &member.place)?;
        Some(self.push_value_to_block(
            owner,
            block,
            ValueKind::InstructionResult,
            Origin::source(member.span),
            HirInstructionKind::Read { place },
            projected_read_semantics(),
        ))
    }

    fn materialize_planned_place(
        &mut self,
        owner: FunctionId,
        block: BlockId,
        planned: &PlannedPlace,
    ) -> Option<fict_hir::Place> {
        let base = match &planned.base {
            PlannedPlaceBase::Binding(symbol) => {
                let binding = self.symbol_to_binding.get(symbol).copied()?;
                let local = self.functions[owner.as_usize()]
                    .locals
                    .iter()
                    .find(|local| local.binding == Some(binding))?
                    .id;
                fict_hir::PlaceBase::Local(local)
            }
            PlannedPlaceBase::UnresolvedGlobal { name, span } => {
                let global = self.intern_global(name, Origin::source(*span));
                fict_hir::PlaceBase::Global(global)
            }
            PlannedPlaceBase::Context { kind, span } => fict_hir::PlaceBase::Value(
                self.materialize_context_value(owner, block, *span, *kind),
            ),
            PlannedPlaceBase::Expression { span, has_effects } => {
                let value = self.control_expression_value(owner, block, *span, true, *has_effects);
                fict_hir::PlaceBase::Value(value)
            }
        };
        let mut projections = Vec::with_capacity(planned.projections.len());
        for projection in &planned.projections {
            projections.push(match projection {
                PlannedProjection::Static { name, optional } => {
                    fict_hir::Projection::StaticProperty {
                        name: name.clone(),
                        optional: *optional,
                    }
                }
                PlannedProjection::Computed {
                    key,
                    optional,
                    has_effects,
                    deferred,
                } => {
                    let key_value =
                        self.control_expression_value(owner, block, *key, true, *has_effects);
                    if *deferred {
                        self.mark_span_deferred(owner, block, *key);
                    }
                    fict_hir::Projection::ComputedProperty {
                        key: key_value,
                        optional: *optional,
                    }
                }
                PlannedProjection::Index { index, optional } => fict_hir::Projection::Index {
                    index: *index,
                    optional: *optional,
                },
            });
        }
        Some(fict_hir::Place { base, projections })
    }

    fn materialize_context_value(
        &mut self,
        owner: FunctionId,
        block: BlockId,
        span: SourceSpan,
        kind: ContextValueKind,
    ) -> ValueId {
        if let Some(value) = self.functions[owner.as_usize()].blocks[block.as_usize()]
            .instructions
            .iter()
            .rev()
            .find_map(|instruction| {
                (instruction.origin.primary_span == Some(span)
                    && matches!(
                        instruction.kind,
                        HirInstructionKind::Context { kind: candidate } if candidate == kind
                    ))
                .then_some(instruction.result)
                .flatten()
            })
        {
            return value;
        }
        self.push_value_to_block(
            owner,
            block,
            ValueKind::InstructionResult,
            Origin::source(span),
            HirInstructionKind::Context { kind },
            context_value_semantics(kind),
        )
    }

    fn mark_span_deferred(&mut self, owner: FunctionId, block: BlockId, span: SourceSpan) {
        for instruction in
            &mut self.functions[owner.as_usize()].blocks[block.as_usize()].instructions
        {
            if instruction
                .origin
                .primary_span
                .is_some_and(|candidate| span_contains(span, candidate))
            {
                instruction.semantics.evaluation = EvaluationMode::Deferred;
            }
        }
    }

    fn mark_pattern_children_deferred(&mut self, owner: FunctionId, pattern: SourceSpan) {
        for block in &mut self.functions[owner.as_usize()].blocks {
            for instruction in &mut block.instructions {
                if instruction.origin.primary_span.is_some_and(|candidate| {
                    candidate != pattern && span_contains(pattern, candidate)
                }) {
                    instruction.semantics.evaluation = EvaluationMode::Deferred;
                }
            }
        }
    }

    fn order_function_instructions(&mut self, owner: FunctionId) {
        for block in &mut self.functions[owner.as_usize()].blocks {
            if block.instructions.len() < 2 {
                continue;
            }
            let instructions = std::mem::take(&mut block.instructions);
            let mut definitions = BTreeMap::new();
            for (index, instruction) in instructions.iter().enumerate() {
                if let Some(result) = instruction.result {
                    definitions.insert(result, index);
                }
            }

            let mut dependencies = vec![BTreeSet::new(); instructions.len()];
            let mut dependents = vec![Vec::new(); instructions.len()];
            for (index, instruction) in instructions.iter().enumerate() {
                for input in instruction_value_inputs(instruction) {
                    if let Some(definition) = definitions.get(&input).copied()
                        && definition != index
                        && dependencies[index].insert(definition)
                    {
                        dependents[definition].push(index);
                    }
                }
            }

            let mut remaining: Vec<_> = dependencies.iter().map(BTreeSet::len).collect();
            let mut ready = BTreeSet::new();
            for (index, count) in remaining.iter().enumerate() {
                if *count == 0 {
                    ready.insert(instruction_source_order_key(&instructions[index], index));
                }
            }

            let mut order = Vec::with_capacity(instructions.len());
            while let Some(key) = ready.pop_first() {
                let index = key.3;
                order.push(index);
                for dependent in &dependents[index] {
                    remaining[*dependent] = remaining[*dependent].saturating_sub(1);
                    if remaining[*dependent] == 0 {
                        ready.insert(instruction_source_order_key(
                            &instructions[*dependent],
                            *dependent,
                        ));
                    }
                }
            }

            if order.len() != instructions.len() {
                block.instructions = instructions;
                continue;
            }
            let mut slots: Vec<_> = instructions.into_iter().map(Some).collect();
            block.instructions = order
                .into_iter()
                .filter_map(|index| slots[index].take())
                .collect();
        }
    }

    fn has_structured_control_flow(&self, owner: FunctionId) -> bool {
        self.control_flow_plans
            .get(&owner)
            .is_some_and(|plan| plan.supported && plan.has_control_flow)
    }

    fn planned_block_for_span(&self, owner: FunctionId, span: SourceSpan) -> BlockId {
        self.control_flow_plans
            .get(&owner)
            .filter(|plan| plan.supported && plan.has_control_flow)
            .map_or(BlockId::new(0), |plan| plan.block_for_span(span))
    }

    fn materialize_control_flow_terminators(&mut self, owner: FunctionId) {
        let Some(plan) = self
            .control_flow_plans
            .get(&owner)
            .filter(|plan| plan.supported && plan.has_control_flow)
            .cloned()
        else {
            return;
        };

        for block in plan.blocks {
            let origin = match &block.terminator {
                structured_control_flow::PlannedTerminator::Return { origin, .. } => *origin,
                structured_control_flow::PlannedTerminator::Throw { origin, .. }
                | structured_control_flow::PlannedTerminator::Goto { origin, .. }
                | structured_control_flow::PlannedTerminator::Branch { origin, .. }
                | structured_control_flow::PlannedTerminator::ForEach { origin, .. }
                | structured_control_flow::PlannedTerminator::SwitchDispatch { origin, .. }
                | structured_control_flow::PlannedTerminator::SwitchCase { origin, .. }
                | structured_control_flow::PlannedTerminator::Try { origin, .. }
                | structured_control_flow::PlannedTerminator::Unreachable { origin } => {
                    Origin::source(*origin)
                }
            };
            let kind = match block.terminator {
                structured_control_flow::PlannedTerminator::Return { value, .. } => {
                    TerminatorKind::Return {
                        value: value.map(|span| {
                            self.control_expression_value(owner, block.id, span, true, true)
                        }),
                    }
                }
                structured_control_flow::PlannedTerminator::Throw { value, .. } => {
                    TerminatorKind::Throw {
                        value: self.control_expression_value(owner, block.id, value, true, true),
                    }
                }
                structured_control_flow::PlannedTerminator::Goto { target, .. } => {
                    TerminatorKind::Goto { target }
                }
                structured_control_flow::PlannedTerminator::Branch {
                    test,
                    has_effects,
                    consequent,
                    alternate,
                    ..
                } => TerminatorKind::Branch {
                    test: self.control_expression_value(owner, block.id, test, true, has_effects),
                    consequent,
                    alternate,
                },
                structured_control_flow::PlannedTerminator::ForEach {
                    kind,
                    source,
                    source_block,
                    source_has_effects,
                    target,
                    body,
                    exit,
                    ..
                } => {
                    let source = self.control_expression_value(
                        owner,
                        source_block,
                        source,
                        true,
                        source_has_effects,
                    );
                    self.materialize_iteration_target(owner, body, kind, source, target);
                    match kind {
                        IterationKind::In => TerminatorKind::ForIn {
                            object: source,
                            body,
                            exit,
                        },
                        IterationKind::Of | IterationKind::AwaitOf => TerminatorKind::ForOf {
                            iterable: source,
                            r#await: kind == IterationKind::AwaitOf,
                            body,
                            exit,
                        },
                    }
                }
                structured_control_flow::PlannedTerminator::SwitchDispatch {
                    discriminant,
                    discriminant_has_effects,
                    target,
                    ..
                } => {
                    self.control_expression_value(
                        owner,
                        block.id,
                        discriminant,
                        true,
                        discriminant_has_effects,
                    );
                    TerminatorKind::Goto { target }
                }
                structured_control_flow::PlannedTerminator::SwitchCase {
                    discriminant,
                    discriminant_block,
                    discriminant_has_effects,
                    test,
                    test_has_effects,
                    consequent,
                    alternate,
                    ..
                } => {
                    let discriminant = self.control_expression_value(
                        owner,
                        discriminant_block,
                        discriminant,
                        true,
                        discriminant_has_effects,
                    );
                    let case_test = self.control_expression_value(
                        owner,
                        block.id,
                        test,
                        true,
                        test_has_effects,
                    );
                    let comparison_origin = Origin::desugared(test, DesugaringKind::Switch);
                    let comparison = self.push_value_to_block(
                        owner,
                        block.id,
                        ValueKind::InstructionResult,
                        comparison_origin,
                        HirInstructionKind::Binary {
                            operator: BinaryOperator::StrictEqual,
                            left: discriminant,
                            right: case_test,
                        },
                        InstructionSemantics::PURE_EAGER,
                    );
                    TerminatorKind::Branch {
                        test: comparison,
                        consequent,
                        alternate,
                    }
                }
                structured_control_flow::PlannedTerminator::Try {
                    body,
                    catch,
                    catch_pattern,
                    finally,
                    continuation,
                    ..
                } => {
                    if let (Some(catch), Some(pattern)) = (catch, catch_pattern) {
                        self.materialize_catch_pattern(owner, catch, pattern);
                    }
                    TerminatorKind::Try {
                        body,
                        catch,
                        finally,
                        continuation,
                    }
                }
                structured_control_flow::PlannedTerminator::Unreachable { .. } => {
                    TerminatorKind::Unreachable
                }
            };
            self.functions[owner.as_usize()].blocks[block.id.as_usize()].terminator =
                HirTerminator { kind, origin };
        }
    }

    fn materialize_iteration_target(
        &mut self,
        owner: FunctionId,
        body: BlockId,
        kind: IterationKind,
        source: ValueId,
        target: structured_control_flow::PlannedIterationTarget,
    ) {
        let declared_bindings: Vec<_> = target
            .declared
            .iter()
            .filter_map(|symbol| self.symbol_to_binding.get(symbol).copied())
            .collect();
        let assigned_bindings: Vec<_> = target
            .assigned
            .iter()
            .filter_map(|symbol| self.symbol_to_binding.get(symbol).copied())
            .collect();
        let mut targets = Vec::new();
        for binding in declared_bindings.iter().chain(&assigned_bindings) {
            let Some(local) = self.functions[owner.as_usize()]
                .locals
                .iter()
                .find(|local| local.binding == Some(*binding))
                .map(|local| local.id)
            else {
                continue;
            };
            if !targets.contains(&local) {
                targets.push(local);
            }
        }
        let fragment = self.add_fragment(
            SyntaxFragmentKind::Pattern,
            target.span,
            SyntaxSummary {
                referenced_bindings: self.referenced_bindings(target.span),
                pattern: Some(PatternSummary {
                    declared_bindings,
                    assigned_bindings,
                    has_defaults: target.has_defaults,
                    has_rest: target.has_rest,
                }),
                has_side_effects: true,
                may_throw: true,
                contains_await: kind == IterationKind::AwaitOf,
                ..SyntaxSummary::default()
            },
        );
        let block = &mut self.functions[owner.as_usize()].blocks[body.as_usize()];
        let insertion = block
            .instructions
            .iter()
            .position(|instruction| !matches!(instruction.kind, HirInstructionKind::Declare { .. }))
            .unwrap_or(block.instructions.len());
        block.instructions.insert(
            insertion,
            HirInstruction {
                result: None,
                kind: HirInstructionKind::Iteration {
                    kind,
                    source,
                    pattern: fragment,
                    targets,
                },
                semantics: InstructionSemantics::CONSERVATIVE_EAGER,
                origin: Origin::source(target.span),
            },
        );
    }

    fn materialize_catch_pattern(
        &mut self,
        owner: FunctionId,
        catch: BlockId,
        target: structured_control_flow::PlannedCatchPattern,
    ) {
        let mut ordered_inputs: Vec<_> = self.functions[owner.as_usize()].blocks[catch.as_usize()]
            .instructions
            .iter()
            .enumerate()
            .filter_map(|(index, instruction)| {
                let value = instruction.result?;
                let candidate = instruction.origin.primary_span?;
                span_contains(target.span, candidate).then_some((
                    candidate.start(),
                    candidate.end(),
                    index,
                    value,
                ))
            })
            .collect();
        ordered_inputs.sort_by_key(|(start, end, index, _)| (*start, *end, *index));
        let mut seen = BTreeSet::new();
        let inputs: Vec<_> = ordered_inputs
            .iter()
            .filter_map(|(_, _, _, value)| seen.insert(*value).then_some(*value))
            .collect();
        let last_input_instruction = ordered_inputs.iter().map(|(_, _, index, _)| *index).max();
        let declared_bindings: Vec<_> = target
            .declared
            .iter()
            .filter_map(|symbol| self.symbol_to_binding.get(symbol).copied())
            .collect();
        let fragment = self.add_fragment(
            SyntaxFragmentKind::Pattern,
            target.span,
            SyntaxSummary {
                referenced_bindings: self.referenced_bindings(target.span),
                pattern: Some(PatternSummary {
                    declared_bindings,
                    assigned_bindings: Vec::new(),
                    has_defaults: target.has_defaults,
                    has_rest: target.has_rest,
                }),
                has_side_effects: target.has_effects,
                may_throw: target.has_effects,
                ..SyntaxSummary::default()
            },
        );
        let block = &mut self.functions[owner.as_usize()].blocks[catch.as_usize()];
        let insertion = last_input_instruction.map_or_else(
            || {
                block
                    .instructions
                    .iter()
                    .position(|instruction| {
                        !matches!(instruction.kind, HirInstructionKind::Declare { .. })
                    })
                    .unwrap_or(block.instructions.len())
            },
            |index| index.saturating_add(1),
        );
        block.instructions.insert(
            insertion,
            HirInstruction {
                result: None,
                kind: HirInstructionKind::SyntaxFragment { fragment, inputs },
                semantics: if target.has_effects {
                    InstructionSemantics::CONSERVATIVE_EAGER
                } else {
                    InstructionSemantics::PURE_EAGER
                },
                origin: Origin::source(target.span),
            },
        );
    }

    fn control_expression_value(
        &mut self,
        owner: FunctionId,
        block: BlockId,
        span: SourceSpan,
        reuse_exact_value: bool,
        has_effects: bool,
    ) -> ValueId {
        if reuse_exact_value
            && let Some(value) = self.functions[owner.as_usize()].blocks[block.as_usize()]
                .instructions
                .iter()
                .rev()
                .find_map(|instruction| {
                    (instruction.origin.primary_span == Some(span))
                        .then_some(instruction.result)
                        .flatten()
                })
        {
            return value;
        }

        let mut ordered_inputs: Vec<_> = self.functions[owner.as_usize()].blocks[block.as_usize()]
            .instructions
            .iter()
            .enumerate()
            .filter_map(|(index, instruction)| {
                let value = instruction.result?;
                let candidate = instruction.origin.primary_span?;
                span_contains(span, candidate).then_some((
                    candidate.start(),
                    candidate.end(),
                    index,
                    value,
                ))
            })
            .collect();
        ordered_inputs.sort_by_key(|(start, end, index, _)| (*start, *end, *index));
        let mut seen = BTreeSet::new();
        let inputs = ordered_inputs
            .into_iter()
            .filter_map(|(_, _, _, value)| seen.insert(value).then_some(value))
            .collect();
        let fragment = self.add_fragment(
            SyntaxFragmentKind::Expression,
            span,
            SyntaxSummary {
                referenced_bindings: self.referenced_bindings(span),
                has_side_effects: has_effects,
                may_throw: has_effects,
                ..SyntaxSummary::default()
            },
        );
        self.push_value_to_block(
            owner,
            block,
            ValueKind::SyntaxFragment(fragment),
            Origin::source(span),
            HirInstructionKind::SyntaxFragment { fragment, inputs },
            if has_effects {
                InstructionSemantics::CONSERVATIVE_EAGER
            } else {
                InstructionSemantics::PURE_EAGER
            },
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
                let is_component = !matches!(name, RawJsxName::Intrinsic(_));
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
                                RawJsxAttributeValue::Expression {
                                    span,
                                    function_like,
                                    contains_fragment,
                                } => JsxAttributeValue::Expression {
                                    value: self.syntax_value(
                                        owner,
                                        *span,
                                        self.referenced_bindings(*span),
                                    ),
                                    function_like: *function_like,
                                    contains_fragment: *contains_fragment,
                                },
                                RawJsxAttributeValue::Node(node) => JsxAttributeValue::Node(
                                    Box::new(self.lower_jsx_node(owner, node)),
                                ),
                            },
                            origin: Origin::source(*span),
                        },
                        RawJsxAttribute::Spread {
                            expression,
                            kind,
                            span,
                        } => {
                            let referenced = self.referenced_bindings(*expression);
                            let uses_reactive_value = referenced
                                .iter()
                                .any(|binding| self.reactive_value_bindings.contains(binding));
                            let accessor_is_reactive = match kind {
                                RawJsxSpreadKind::AccessorCall { callee, .. } => self
                                    .symbol_to_binding
                                    .get(callee)
                                    .is_some_and(|binding| {
                                        self.reactive_value_bindings.contains(binding)
                                    }),
                                RawJsxSpreadKind::Static | RawJsxSpreadKind::Dynamic => false,
                            };
                            let dynamic = is_component
                                && (matches!(kind, RawJsxSpreadKind::Dynamic)
                                    || matches!(kind, RawJsxSpreadKind::AccessorCall { .. })
                                        && !accessor_is_reactive);
                            if dynamic {
                                self.diagnostics.push(
                                    Diagnostic::new(
                                        DiagnosticCode::new("FICT-P005")
                                            .expect("diagnostic literal"),
                                        if self.strict_guarantee {
                                            DiagnosticSeverity::Error
                                        } else {
                                            DiagnosticSeverity::Warning
                                        },
                                        "dynamic component props spread may not stay reactive",
                                    )
                                    .with_primary_span(*expression)
                                    .with_help(
                                        "use explicit component props or a stable reactive accessor source",
                                    )
                                    .with_guarantee_class(GuaranteeClass::Fallback),
                                );
                            }
                            JsxAttribute::Spread {
                                value: self.syntax_value(owner, *expression, referenced),
                                getter: is_component
                                    && (uses_reactive_value || accessor_is_reactive),
                                origin: Origin::source(*span),
                            }
                        }
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
            RawJsxChild::Expression {
                span,
                kind,
                contains_fragment,
                function_like,
                list,
                embedded_nodes,
            } => JsxChild::Expression {
                value: self.syntax_value(owner, *span, self.referenced_bindings(*span)),
                kind: *kind,
                contains_fragment: *contains_fragment,
                function_like: *function_like,
                list: list
                    .as_ref()
                    .and_then(|list| self.lower_jsx_list_expression(list)),
                embedded_nodes: embedded_nodes
                    .iter()
                    .map(|node| self.lower_jsx_node(owner, node))
                    .collect(),
                origin: Origin::source(*span),
            },
            RawJsxChild::Node(node) => JsxChild::Node(Box::new(self.lower_jsx_node(owner, node))),
            RawJsxChild::Spread { expression, span } => JsxChild::Spread {
                value: self.syntax_value(owner, *expression, self.referenced_bindings(*expression)),
                origin: Origin::source(*span),
            },
        }
    }

    fn lower_jsx_list_expression(&self, list: &RawJsxListExpression) -> Option<JsxListExpression> {
        let callback = self
            .function_facts
            .iter()
            .find(|function| function.span == list.callback)?
            .id;
        let receiver = match list.receiver {
            RawJsxListReceiver::ArrayLiteral => JsxListReceiver::ArrayLiteral,
            RawJsxListReceiver::Binding {
                root,
                projected,
                known_array,
            } => JsxListReceiver::Binding {
                root: self.symbol_to_binding.get(&root).copied()?,
                projected,
                known_array,
            },
        };
        Some(JsxListExpression {
            items: Origin::source(list.items),
            optional: list.optional,
            receiver,
            callback,
            key: list.key.map(Origin::source),
            key_source: list.key_source.map(Origin::source),
            key_alias_initializer: list.key_alias_initializer.map(Origin::source),
            item_references: list
                .item_references
                .iter()
                .copied()
                .map(Origin::source)
                .collect(),
            index_references: list
                .index_references
                .iter()
                .copied()
                .map(Origin::source)
                .collect(),
            needs_index: list.needs_index,
        })
    }

    fn push_value(
        &mut self,
        owner: FunctionId,
        kind: ValueKind,
        origin: Origin,
        instruction_kind: HirInstructionKind,
        semantics: InstructionSemantics,
    ) -> ValueId {
        let block = origin.primary_span.map_or(BlockId::new(0), |span| {
            self.planned_block_for_span(owner, span)
        });
        self.push_value_to_block(owner, block, kind, origin, instruction_kind, semantics)
    }

    fn push_value_to_block(
        &mut self,
        owner: FunctionId,
        block: BlockId,
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
        function.blocks[block.as_usize()]
            .instructions
            .push(HirInstruction {
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
                        if self
                            .class_self_reference_spans
                            .contains(&(reference_span.start(), reference_span.end()))
                        {
                            return None;
                        }
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

    fn read_referenced_bindings(&self, span: SourceSpan) -> Vec<BindingId> {
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
                        if !reference.is_read() {
                            return None;
                        }
                        let reference_span = source_span(self.semantic.reference_span(reference));
                        if self
                            .class_self_reference_spans
                            .contains(&(reference_span.start(), reference_span.end()))
                        {
                            return None;
                        }
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

    fn read_referenced_bindings_in_spans(
        &self,
        owner: FunctionId,
        spans: &[SourceSpan],
    ) -> Vec<BindingId> {
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
                        if !reference.is_read() {
                            return None;
                        }
                        let reference_span = source_span(self.semantic.reference_span(reference));
                        if self
                            .class_self_reference_spans
                            .contains(&(reference_span.start(), reference_span.end()))
                        {
                            return None;
                        }
                        (self.function_owner_for_span(reference_span) == owner
                            && spans
                                .iter()
                                .any(|span| span_contains(*span, reference_span)))
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

    fn intern_global(&mut self, name: &str, origin: Origin) -> GlobalId {
        if let Some(id) = self.global_by_name.get(name).copied() {
            return id;
        }
        let id = GlobalId::new(count_u32(self.globals.len()));
        self.global_by_name.insert(name.to_owned(), id);
        self.globals.push(HirGlobal {
            id,
            name: name.to_owned(),
            origin,
        });
        id
    }

    fn preintern_globals(
        &mut self,
        typed_expressions: &[TypedExpressionFact],
        mutations: &[MutationFact],
        member_reads: &[MemberReadFact],
        reads: &[ReadFact],
    ) {
        let mut references = Vec::new();
        references.extend(
            mutations
                .iter()
                .filter_map(|fact| fact.place.as_ref())
                .filter_map(planned_global_reference),
        );
        references.extend(
            member_reads
                .iter()
                .filter_map(|fact| planned_global_reference(&fact.place)),
        );
        references.extend(
            reads
                .iter()
                .filter_map(|fact| planned_global_reference(&fact.place)),
        );
        references.extend(typed_expressions.iter().filter_map(|expression| {
            let TypedExpressionKind::Delete {
                target: TypedDeleteTarget::Place(place),
            } = &expression.kind
            else {
                return None;
            };
            planned_global_reference(place)
        }));
        references.sort_unstable_by(|left, right| {
            (left.1.start(), left.1.end(), &left.0).cmp(&(right.1.start(), right.1.end(), &right.0))
        });

        let mut seen = BTreeSet::new();
        for (name, span) in references {
            if seen.insert(name.clone()) {
                self.intern_global(&name, Origin::source(span));
            }
        }
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
        let authored_free_names = authored_free_names(self.semantic);
        let module_plan = build_module_plan(&self.frontend, &self.old_to_new);
        let hir = HirFile {
            id: FileId::new(0),
            source_len: self.frontend.source.source_len,
            root_function: FunctionId::new(0),
            scopes,
            bindings,
            globals: self.globals,
            authored_free_names,
            functions: self.functions,
            templates: self.templates,
            syntax_fragments: self.syntax_fragments,
        };
        if let Err(verification) = verify_hir(&hir) {
            self.diagnostics.extend(verification.into_sorted());
        }
        if let Err(verification) = verify_module_plan(&hir, &module_plan) {
            self.diagnostics.extend(verification.into_sorted());
        }
        let has_errors = self
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error);
        let (hir, module_plan) = if has_errors {
            (None, None)
        } else {
            (Some(hir), Some(module_plan))
        };
        HirBuildOutput {
            hir,
            frontend: Some(self.frontend),
            module_plan,
            syntax_fragments: self.adapter_fragments,
            diagnostics: sorted(self.diagnostics),
        }
    }
}

fn authored_free_names(semantic: &Semantic<'_>) -> Vec<String> {
    let mut names = semantic
        .scoping()
        .root_unresolved_references()
        .iter()
        .filter_map(|(name, reference_ids)| {
            reference_ids
                .iter()
                .map(|reference_id| {
                    source_span(
                        semantic.reference_span(semantic.scoping().get_reference(*reference_id)),
                    )
                })
                .min_by_key(|span| (span.start(), span.end()))
                .map(|span| (span, name.to_string()))
        })
        .collect::<Vec<_>>();
    names.sort_unstable_by(|(left_span, left_name), (right_span, right_name)| {
        (left_span.start(), left_span.end(), left_name).cmp(&(
            right_span.start(),
            right_span.end(),
            right_name,
        ))
    });
    names.into_iter().map(|(_, name)| name).collect()
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
        kind: RawJsxSpreadKind,
        span: SourceSpan,
    },
}

#[derive(Debug, Clone, Copy)]
enum RawJsxSpreadKind {
    Static,
    Dynamic,
    AccessorCall {
        callee: SymbolId,
        callee_span: SourceSpan,
    },
}

#[derive(Debug, Clone)]
enum RawJsxAttributeValue {
    ImplicitTrue,
    Text(JavaScriptString),
    Expression {
        span: SourceSpan,
        function_like: bool,
        contains_fragment: bool,
    },
    Node(Box<RawJsxNode>),
}

#[derive(Debug, Clone)]
enum RawJsxChild {
    Text {
        value: JavaScriptString,
        span: SourceSpan,
    },
    Expression {
        span: SourceSpan,
        kind: JsxExpressionKind,
        contains_fragment: bool,
        function_like: bool,
        list: Option<RawJsxListExpression>,
        embedded_nodes: Vec<RawJsxNode>,
    },
    Node(Box<RawJsxNode>),
    Spread {
        expression: SourceSpan,
        span: SourceSpan,
    },
}

#[derive(Debug, Clone)]
struct RawJsxListExpression {
    items: SourceSpan,
    optional: bool,
    receiver: RawJsxListReceiver,
    callback: SourceSpan,
    key: Option<SourceSpan>,
    key_source: Option<SourceSpan>,
    key_alias_initializer: Option<SourceSpan>,
    item_references: Vec<SourceSpan>,
    index_references: Vec<SourceSpan>,
    needs_index: bool,
}

#[derive(Debug, Clone, Copy)]
enum RawJsxListReceiver {
    ArrayLiteral,
    Binding {
        root: SymbolId,
        projected: bool,
        known_array: bool,
    },
}

fn collect_transformed_list_call_spans(node: &RawJsxNode, spans: &mut BTreeSet<(u32, u32)>) {
    let (attributes, children) = match node {
        RawJsxNode::Element {
            attributes,
            children,
            ..
        } => (Some(attributes.as_slice()), children.as_slice()),
        RawJsxNode::Fragment { children, .. } => (None, children.as_slice()),
    };
    if let Some(attributes) = attributes {
        for attribute in attributes {
            if let RawJsxAttribute::Named {
                value: RawJsxAttributeValue::Node(node),
                ..
            } = attribute
            {
                collect_transformed_list_call_spans(node, spans);
            }
        }
    }
    for child in children {
        match child {
            RawJsxChild::Expression {
                span,
                list,
                embedded_nodes,
                ..
            } => {
                if list.is_some() {
                    spans.insert((span.start(), span.end()));
                }
                for node in embedded_nodes {
                    collect_transformed_list_call_spans(node, spans);
                }
            }
            RawJsxChild::Node(node) => collect_transformed_list_call_spans(node, spans),
            RawJsxChild::Text { .. } | RawJsxChild::Spread { .. } => {}
        }
    }
}

fn collect_reactive_component_accessor_spans(
    node: &RawJsxNode,
    symbol_to_binding: &BTreeMap<SymbolId, BindingId>,
    reactive_targets: &BTreeSet<BindingId>,
    spans: &mut BTreeSet<(u32, u32)>,
) {
    match node {
        RawJsxNode::Element {
            name,
            attributes,
            children,
            ..
        } => {
            let is_component = !matches!(name, RawJsxName::Intrinsic(_));
            for attribute in attributes {
                match attribute {
                    RawJsxAttribute::Spread {
                        kind:
                            RawJsxSpreadKind::AccessorCall {
                                callee,
                                callee_span,
                            },
                        ..
                    } if is_component
                        && symbol_to_binding
                            .get(callee)
                            .is_some_and(|binding| reactive_targets.contains(binding)) =>
                    {
                        spans.insert((callee_span.start(), callee_span.end()));
                    }
                    RawJsxAttribute::Named {
                        value: RawJsxAttributeValue::Node(node),
                        ..
                    } => collect_reactive_component_accessor_spans(
                        node,
                        symbol_to_binding,
                        reactive_targets,
                        spans,
                    ),
                    RawJsxAttribute::Named { .. } | RawJsxAttribute::Spread { .. } => {}
                }
            }
            for child in children {
                if let RawJsxChild::Node(node) = child {
                    collect_reactive_component_accessor_spans(
                        node,
                        symbol_to_binding,
                        reactive_targets,
                        spans,
                    );
                }
            }
        }
        RawJsxNode::Fragment { children, .. } => {
            for child in children {
                if let RawJsxChild::Node(node) = child {
                    collect_reactive_component_accessor_spans(
                        node,
                        symbol_to_binding,
                        reactive_targets,
                        spans,
                    );
                }
            }
        }
    }
}

struct JsxCollector<'facts> {
    scoping: &'facts Scoping,
    known_arrays: &'facts BTreeSet<SymbolId>,
    aliases: &'facts StaticHookAliases,
    stack: Vec<FunctionId>,
    scan_owners: Vec<FunctionId>,
    function_by_span: &'facts BTreeMap<(u32, u32), FunctionId>,
    roots: Vec<JsxFact>,
    tags: Vec<(RawJsxName, SourceSpan)>,
}

#[derive(Default)]
struct KnownArrayCollector {
    symbols: BTreeSet<SymbolId>,
}

impl<'a> Visit<'a> for KnownArrayCollector {
    fn visit_variable_declaration(&mut self, declaration: &VariableDeclaration<'a>) {
        if declaration.kind == VariableDeclarationKind::Const {
            for declarator in &declaration.declarations {
                let (BindingPattern::BindingIdentifier(binding), Some(initializer)) =
                    (&declarator.id, &declarator.init)
                else {
                    continue;
                };
                if matches!(
                    initializer.get_inner_expression(),
                    Expression::ArrayExpression(_)
                ) && let Some(symbol) = binding.symbol_id.get()
                {
                    self.symbols.insert(symbol);
                }
            }
        }
        walk_variable_declaration(self, declaration);
    }
}

#[derive(Clone, Copy)]
struct ReceiverDeclarationFact {
    symbol: SymbolId,
    source: ReceiverDeclarationSource,
}

#[derive(Clone, Copy)]
enum ReceiverDeclarationSource {
    Known(StateReceiverKind),
    Alias(SymbolId),
}

struct ReceiverDeclarationCollector<'semantic> {
    scoping: &'semantic Scoping,
    facts: Vec<ReceiverDeclarationFact>,
}

impl<'a> Visit<'a> for ReceiverDeclarationCollector<'_> {
    fn visit_variable_declaration(&mut self, declaration: &VariableDeclaration<'a>) {
        if declaration.kind == VariableDeclarationKind::Const {
            for declarator in &declaration.declarations {
                let (BindingPattern::BindingIdentifier(binding), Some(initializer)) =
                    (&declarator.id, &declarator.init)
                else {
                    continue;
                };
                if let Some(symbol) = binding.symbol_id.get() {
                    let direct = classify_state_receiver_assignment(
                        self.scoping,
                        initializer,
                        &BTreeMap::new(),
                    );
                    let source = if direct != StateReceiverKind::Unknown {
                        Some(ReceiverDeclarationSource::Known(direct))
                    } else {
                        let Expression::Identifier(identifier) = initializer.get_inner_expression()
                        else {
                            continue;
                        };
                        identifier_symbol(self.scoping, identifier)
                            .map(ReceiverDeclarationSource::Alias)
                    };
                    if let Some(source) = source {
                        self.facts.push(ReceiverDeclarationFact { symbol, source });
                    }
                }
            }
        }
        walk_variable_declaration(self, declaration);
    }
}

fn collect_proven_receiver_kinds<'ast>(
    program: &Program<'ast>,
    scoping: &Scoping,
    seeds: &BTreeMap<SymbolId, StateReceiverKind>,
) -> BTreeMap<SymbolId, StateReceiverKind> {
    let mut collector = ReceiverDeclarationCollector {
        scoping,
        facts: Vec::new(),
    };
    collector.visit_program(program);
    let mut receivers = seeds.clone();
    let mut dependents = BTreeMap::<SymbolId, Vec<SymbolId>>::new();
    for fact in collector.facts {
        match fact.source {
            ReceiverDeclarationSource::Known(receiver) => {
                if receivers
                    .get(&fact.symbol)
                    .is_none_or(|current| *current == StateReceiverKind::Unknown)
                {
                    receivers.insert(fact.symbol, receiver);
                }
            }
            ReceiverDeclarationSource::Alias(source) => {
                dependents.entry(source).or_default().push(fact.symbol);
            }
        }
    }
    let mut pending = receivers
        .iter()
        .filter_map(|(symbol, receiver)| {
            (*receiver != StateReceiverKind::Unknown).then_some((*symbol, *receiver))
        })
        .collect::<VecDeque<_>>();
    while let Some((source, receiver)) = pending.pop_front() {
        for target in dependents.get(&source).into_iter().flatten() {
            if receivers
                .get(target)
                .is_some_and(|current| *current != StateReceiverKind::Unknown)
            {
                continue;
            }
            receivers.insert(*target, receiver);
            pending.push_back((*target, receiver));
        }
    }
    receivers
}

impl JsxCollector<'_> {
    fn scan_jsx_element(&mut self, element: &JSXElement<'_>) {
        self.tags.push((
            raw_jsx_name(self.scoping, &element.opening_element.name),
            source_span(element.span),
        ));
        for attribute in &element.opening_element.attributes {
            match attribute {
                JSXAttributeItem::SpreadAttribute(spread) => {
                    self.scan_jsx_expression(&spread.argument);
                }
                JSXAttributeItem::Attribute(attribute) => match &attribute.value {
                    Some(OxcJsxAttributeValue::ExpressionContainer(container)) => {
                        if let Some(expression) = container.expression.as_expression() {
                            self.scan_jsx_expression(expression);
                        }
                    }
                    Some(OxcJsxAttributeValue::Element(element)) => {
                        self.scan_jsx_element(element);
                    }
                    Some(OxcJsxAttributeValue::Fragment(fragment)) => {
                        self.scan_jsx_fragment(fragment);
                    }
                    Some(OxcJsxAttributeValue::StringLiteral(_)) | None => {}
                },
            }
        }
        for child in &element.children {
            match child {
                OxcJsxChild::Element(element) => self.scan_jsx_element(element),
                OxcJsxChild::Fragment(fragment) => self.scan_jsx_fragment(fragment),
                OxcJsxChild::ExpressionContainer(container) => {
                    if let Some(expression) = container.expression.as_expression() {
                        self.scan_jsx_expression(expression);
                    }
                }
                OxcJsxChild::Spread(spread) => self.scan_jsx_expression(&spread.expression),
                OxcJsxChild::Text(_) => {}
            }
        }
    }

    fn scan_jsx_fragment(&mut self, fragment: &JSXFragment<'_>) {
        for child in &fragment.children {
            match child {
                OxcJsxChild::Element(element) => self.scan_jsx_element(element),
                OxcJsxChild::Fragment(fragment) => self.scan_jsx_fragment(fragment),
                OxcJsxChild::ExpressionContainer(container) => {
                    if let Some(expression) = container.expression.as_expression() {
                        self.scan_jsx_expression(expression);
                    }
                }
                OxcJsxChild::Spread(spread) => self.scan_jsx_expression(&spread.expression),
                OxcJsxChild::Text(_) => {}
            }
        }
    }

    fn scan_jsx_expression(&mut self, expression: &Expression<'_>) {
        match expression.get_inner_expression() {
            Expression::JSXElement(element) => self.scan_jsx_element(element),
            Expression::JSXFragment(fragment) => self.scan_jsx_fragment(fragment),
            _ => self.visit_expression(expression),
        }
    }
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
        let owner = *self.stack.last().expect("module JSX owner");
        if self.scan_owners.last() == Some(&owner) {
            self.scan_jsx_element(element);
            return;
        }
        let mut fragments = FragmentDetector::default();
        walk_jsx_element(&mut fragments, element);
        self.roots.push(JsxFact {
            owner,
            span: source_span(element.span),
            root: raw_jsx_element(self.scoping, self.known_arrays, self.aliases, element),
            contains_fragment: fragments.found,
        });
        self.scan_owners.push(owner);
        self.scan_jsx_element(element);
        self.scan_owners.pop();
    }

    fn visit_jsx_fragment(&mut self, fragment: &JSXFragment<'a>) {
        let owner = *self.stack.last().expect("module JSX owner");
        if self.scan_owners.last() == Some(&owner) {
            self.scan_jsx_fragment(fragment);
            return;
        }
        self.roots.push(JsxFact {
            owner,
            span: source_span(fragment.span),
            root: raw_jsx_fragment(self.scoping, self.known_arrays, self.aliases, fragment),
            contains_fragment: true,
        });
        self.scan_owners.push(owner);
        self.scan_jsx_fragment(fragment);
        self.scan_owners.pop();
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

fn raw_jsx_element(
    scoping: &Scoping,
    known_arrays: &BTreeSet<SymbolId>,
    aliases: &StaticHookAliases,
    element: &JSXElement<'_>,
) -> RawJsxNode {
    RawJsxNode::Element {
        name: raw_jsx_name(scoping, &element.opening_element.name),
        attributes: element
            .opening_element
            .attributes
            .iter()
            .map(|attribute| raw_jsx_attribute(scoping, known_arrays, aliases, attribute))
            .collect(),
        children: element
            .children
            .iter()
            .filter_map(|child| raw_jsx_child(scoping, known_arrays, aliases, child))
            .collect(),
        span: source_span(element.span),
    }
}

fn raw_jsx_fragment(
    scoping: &Scoping,
    known_arrays: &BTreeSet<SymbolId>,
    aliases: &StaticHookAliases,
    fragment: &JSXFragment<'_>,
) -> RawJsxNode {
    RawJsxNode::Fragment {
        children: fragment
            .children
            .iter()
            .filter_map(|child| raw_jsx_child(scoping, known_arrays, aliases, child))
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

fn raw_jsx_attribute(
    scoping: &Scoping,
    known_arrays: &BTreeSet<SymbolId>,
    aliases: &StaticHookAliases,
    attribute: &JSXAttributeItem<'_>,
) -> RawJsxAttribute {
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
                    raw_jsx_attribute_value(scoping, known_arrays, aliases, value)
                }),
            span: source_span(attribute.span),
        },
        JSXAttributeItem::SpreadAttribute(attribute) => RawJsxAttribute::Spread {
            expression: source_span(attribute.argument.span()),
            kind: raw_jsx_spread_kind(scoping, &attribute.argument),
            span: source_span(attribute.span),
        },
    }
}

fn raw_jsx_spread_kind(scoping: &Scoping, expression: &Expression<'_>) -> RawJsxSpreadKind {
    if let Some((callee, callee_span)) = direct_accessor_call(scoping, expression) {
        return RawJsxSpreadKind::AccessorCall {
            callee,
            callee_span,
        };
    }
    if is_dynamic_props_spread(expression) {
        RawJsxSpreadKind::Dynamic
    } else {
        RawJsxSpreadKind::Static
    }
}

fn direct_accessor_call(
    scoping: &Scoping,
    expression: &Expression<'_>,
) -> Option<(SymbolId, SourceSpan)> {
    let call = match expression.get_inner_expression() {
        Expression::CallExpression(call) => call.as_ref(),
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::CallExpression(call) => call.as_ref(),
            ChainElement::TSNonNullExpression(_)
            | ChainElement::ComputedMemberExpression(_)
            | ChainElement::StaticMemberExpression(_)
            | ChainElement::PrivateFieldExpression(_) => return None,
        },
        _ => return None,
    };
    if !call.arguments.is_empty() {
        return None;
    }
    let Expression::Identifier(identifier) = call.callee.get_inner_expression() else {
        return None;
    };
    let symbol = identifier
        .reference_id
        .get()
        .and_then(|reference| scoping.get_reference(reference).symbol_id())?;
    Some((symbol, source_span(identifier.span)))
}

fn is_dynamic_props_spread(expression: &Expression<'_>) -> bool {
    match expression.get_inner_expression() {
        Expression::CallExpression(_)
        | Expression::ConditionalExpression(_)
        | Expression::LogicalExpression(_)
        | Expression::SequenceExpression(_)
        | Expression::AssignmentExpression(_)
        | Expression::UpdateExpression(_)
        | Expression::AwaitExpression(_)
        | Expression::ImportExpression(_)
        | Expression::NewExpression(_)
        | Expression::YieldExpression(_)
        | Expression::TemplateLiteral(_)
        | Expression::TaggedTemplateExpression(_)
        | Expression::ClassExpression(_) => true,
        Expression::ChainExpression(_) => true,
        Expression::ComputedMemberExpression(_) => true,
        Expression::StaticMemberExpression(member) => {
            member.optional || !has_static_member_root(&member.object)
        }
        Expression::PrivateFieldExpression(member) => {
            member.optional || !has_static_member_root(&member.object)
        }
        Expression::ObjectExpression(object) => object
            .properties
            .iter()
            .any(|property| matches!(property, OxcObjectPropertyKind::SpreadProperty(_))),
        Expression::ArrayExpression(array) => array
            .elements
            .iter()
            .any(|element| matches!(element, ArrayExpressionElement::SpreadElement(_))),
        _ => false,
    }
}

fn has_static_member_root(expression: &Expression<'_>) -> bool {
    match expression.get_inner_expression() {
        Expression::Identifier(_) => true,
        Expression::StaticMemberExpression(member) => {
            !member.optional && has_static_member_root(&member.object)
        }
        Expression::PrivateFieldExpression(member) => {
            !member.optional && has_static_member_root(&member.object)
        }
        _ => false,
    }
}

fn raw_jsx_attribute_value(
    scoping: &Scoping,
    known_arrays: &BTreeSet<SymbolId>,
    aliases: &StaticHookAliases,
    value: &OxcJsxAttributeValue<'_>,
) -> RawJsxAttributeValue {
    match value {
        OxcJsxAttributeValue::StringLiteral(literal) => {
            RawJsxAttributeValue::Text(crate::jsx_text::decode_entities(literal.value.as_str()))
        }
        OxcJsxAttributeValue::ExpressionContainer(container) => {
            container.expression.as_expression().map_or(
                RawJsxAttributeValue::ImplicitTrue,
                |expression| match expression.get_inner_expression() {
                    Expression::JSXElement(element) => RawJsxAttributeValue::Node(Box::new(
                        raw_jsx_element(scoping, known_arrays, aliases, element),
                    )),
                    Expression::JSXFragment(fragment) => RawJsxAttributeValue::Node(Box::new(
                        raw_jsx_fragment(scoping, known_arrays, aliases, fragment),
                    )),
                    inner => {
                        let mut fragments = FragmentDetector::default();
                        fragments.visit_expression(expression);
                        RawJsxAttributeValue::Expression {
                            span: source_span(expression.span()),
                            function_like: inner.is_function(),
                            contains_fragment: fragments.found,
                        }
                    }
                },
            )
        }
        OxcJsxAttributeValue::Element(element) => RawJsxAttributeValue::Node(Box::new(
            raw_jsx_element(scoping, known_arrays, aliases, element),
        )),
        OxcJsxAttributeValue::Fragment(fragment) => RawJsxAttributeValue::Node(Box::new(
            raw_jsx_fragment(scoping, known_arrays, aliases, fragment),
        )),
    }
}

fn raw_jsx_child(
    scoping: &Scoping,
    known_arrays: &BTreeSet<SymbolId>,
    aliases: &StaticHookAliases,
    child: &OxcJsxChild<'_>,
) -> Option<RawJsxChild> {
    match child {
        OxcJsxChild::Text(text) => {
            crate::jsx_text::normalize_text(text.value.as_str()).map(|value| RawJsxChild::Text {
                value,
                span: source_span(text.span),
            })
        }
        OxcJsxChild::Element(element) => Some(RawJsxChild::Node(Box::new(raw_jsx_element(
            scoping,
            known_arrays,
            aliases,
            element,
        )))),
        OxcJsxChild::Fragment(fragment) => Some(RawJsxChild::Node(Box::new(raw_jsx_fragment(
            scoping,
            known_arrays,
            aliases,
            fragment,
        )))),
        OxcJsxChild::ExpressionContainer(container) => match &container.expression {
            JSXExpression::EmptyExpression(_) => None,
            expression => expression.as_expression().map(|expression| {
                match expression.get_inner_expression() {
                    Expression::JSXElement(element) => RawJsxChild::Node(Box::new(
                        raw_jsx_element(scoping, known_arrays, aliases, element),
                    )),
                    Expression::JSXFragment(fragment) => RawJsxChild::Node(Box::new(
                        raw_jsx_fragment(scoping, known_arrays, aliases, fragment),
                    )),
                    inner => {
                        let kind = match inner {
                            Expression::ConditionalExpression(_) => JsxExpressionKind::Conditional,
                            Expression::LogicalExpression(logical)
                                if logical.operator == OxcLogicalOperator::And =>
                            {
                                JsxExpressionKind::LogicalAnd
                            }
                            _ => JsxExpressionKind::Value,
                        };
                        let mut fragments = FragmentDetector::default();
                        fragments.visit_expression(expression);
                        let mut embedded = EmbeddedJsxCollector {
                            scoping,
                            known_arrays,
                            aliases,
                            nodes: Vec::new(),
                        };
                        embedded.visit_expression(expression);
                        RawJsxChild::Expression {
                            span: source_span(expression.span()),
                            kind,
                            contains_fragment: fragments.found,
                            function_like: inner.is_function(),
                            list: raw_jsx_list_expression(
                                scoping,
                                known_arrays,
                                aliases,
                                expression,
                            ),
                            embedded_nodes: embedded.nodes,
                        }
                    }
                }
            }),
        },
        OxcJsxChild::Spread(spread) => Some(RawJsxChild::Spread {
            expression: source_span(spread.expression.span()),
            span: source_span(spread.span),
        }),
    }
}

struct EmbeddedJsxCollector<'facts> {
    scoping: &'facts Scoping,
    known_arrays: &'facts BTreeSet<SymbolId>,
    aliases: &'facts StaticHookAliases,
    nodes: Vec<RawJsxNode>,
}

impl<'a> Visit<'a> for EmbeddedJsxCollector<'_> {
    fn visit_function(&mut self, _function: &Function<'a>, _flags: ScopeFlags) {}
    fn visit_arrow_function_expression(&mut self, _function: &ArrowFunctionExpression<'a>) {}
    fn visit_jsx_element(&mut self, element: &JSXElement<'a>) {
        self.nodes.push(raw_jsx_element(
            self.scoping,
            self.known_arrays,
            self.aliases,
            element,
        ));
    }
    fn visit_jsx_fragment(&mut self, fragment: &JSXFragment<'a>) {
        self.nodes.push(raw_jsx_fragment(
            self.scoping,
            self.known_arrays,
            self.aliases,
            fragment,
        ));
    }
}

fn raw_jsx_list_expression(
    scoping: &Scoping,
    known_arrays: &BTreeSet<SymbolId>,
    aliases: &StaticHookAliases,
    expression: &Expression<'_>,
) -> Option<RawJsxListExpression> {
    let call = match expression.get_inner_expression() {
        Expression::CallExpression(call) => call.as_ref(),
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::CallExpression(call) => call.as_ref(),
            ChainElement::TSNonNullExpression(_)
            | ChainElement::ComputedMemberExpression(_)
            | ChainElement::StaticMemberExpression(_)
            | ChainElement::PrivateFieldExpression(_) => return None,
        },
        _ => return None,
    };
    if call.optional || call.arguments.len() != 1 {
        return None;
    }
    let (items, optional) = match call.callee.get_inner_expression() {
        Expression::StaticMemberExpression(member) if member.property.name == "map" => {
            (&member.object, member.optional)
        }
        Expression::ComputedMemberExpression(member)
            if matches!(member.expression.get_inner_expression(),
                    Expression::StringLiteral(property) if property.value == "map") =>
        {
            (&member.object, member.optional)
        }
        _ => return None,
    };
    if !aliases.receiver_method_is_intact(scoping, items, StateReceiverKind::Array, "map") {
        return None;
    }
    let callback = call.arguments[0].as_expression()?.get_inner_expression();
    let (parameters, returned, function_expression) = match callback {
        Expression::ArrowFunctionExpression(callback) if !callback.r#async => (
            &callback.params,
            analyze_direct_arrow_return(callback)?,
            false,
        ),
        Expression::FunctionExpression(callback)
            if !callback.r#async
                && !callback.generator
                && callback.id.is_none()
                && callback.this_param.is_none() =>
        {
            (
                &callback.params,
                analyze_direct_function_return(callback)?,
                true,
            )
        }
        _ => return None,
    };
    if parameters.rest.is_some() || !(1..=2).contains(&parameters.items.len()) {
        return None;
    }
    let item = simple_parameter_symbol(parameters, 0)?;
    let index = if parameters.items.len() == 2 {
        Some(simple_parameter_symbol(parameters, 1)?)
    } else {
        None
    };
    let returned_expression = returned.expression.get_inner_expression();
    let Expression::JSXElement(element) = returned_expression else {
        return None;
    };
    let key = direct_jsx_key_span(element).ok()?;
    let (key_source, key_alias_initializer) = match returned.key_alias {
        Some((alias, initializer)) => {
            key?;
            let key_expression = direct_jsx_key_expression(element)?.get_inner_expression();
            let Expression::Identifier(identifier) = key_expression else {
                return None;
            };
            let resolved = scoping
                .get_reference(identifier.reference_id.get()?)
                .symbol_id()?;
            if resolved != alias {
                return None;
            }
            let initializer = source_span(initializer.span());
            (Some(initializer), Some(initializer))
        }
        None => (key, None),
    };
    let mut references = ListParameterReferenceCollector {
        scoping,
        item,
        index,
        item_references: Vec::new(),
        index_references: Vec::new(),
        readonly: true,
        uses_arguments: false,
        context_sensitive: false,
    };
    references.visit_expression(callback);
    if !references.readonly
        || references.uses_arguments
        || function_expression && references.context_sensitive
    {
        return None;
    }
    references.item_references.sort_unstable();
    references.item_references.dedup();
    references.index_references.sort_unstable();
    references.index_references.dedup();
    if let Some(key) = key {
        references
            .item_references
            .retain(|reference| reference.start() < key.start() || reference.end() > key.end());
        references
            .index_references
            .retain(|reference| reference.start() < key.start() || reference.end() > key.end());
    }
    if let Some(initializer) = key_alias_initializer {
        references.item_references.retain(|reference| {
            reference.start() < initializer.start() || reference.end() > initializer.end()
        });
        references.index_references.retain(|reference| {
            reference.start() < initializer.start() || reference.end() > initializer.end()
        });
    }
    let receiver = classify_raw_list_receiver(scoping, known_arrays, aliases, items)?;
    Some(RawJsxListExpression {
        items: source_span(items.span()),
        optional,
        receiver,
        callback: source_span(callback.span()),
        key,
        key_source,
        key_alias_initializer,
        item_references: references.item_references,
        index_references: references.index_references,
        needs_index: index.is_some(),
    })
}

struct DirectCallbackReturn<'a, 'callback> {
    expression: &'callback Expression<'a>,
    key_alias: Option<(SymbolId, &'callback Expression<'a>)>,
}

fn analyze_direct_arrow_return<'a, 'callback>(
    callback: &'callback ArrowFunctionExpression<'a>,
) -> Option<DirectCallbackReturn<'a, 'callback>> {
    if let Some(expression) = callback.get_expression() {
        return Some(DirectCallbackReturn {
            expression,
            key_alias: None,
        });
    }
    analyze_direct_callback_body(&callback.body)
}

fn analyze_direct_function_return<'a, 'callback>(
    callback: &'callback Function<'a>,
) -> Option<DirectCallbackReturn<'a, 'callback>> {
    analyze_direct_callback_body(callback.body.as_ref()?)
}

fn analyze_direct_callback_body<'a, 'callback>(
    body: &'callback FunctionBody<'a>,
) -> Option<DirectCallbackReturn<'a, 'callback>> {
    if !body.directives.is_empty() {
        return None;
    }
    match body.statements.as_slice() {
        [Statement::ReturnStatement(statement)] => {
            statement
                .argument
                .as_ref()
                .map(|expression| DirectCallbackReturn {
                    expression,
                    key_alias: None,
                })
        }
        [
            Statement::VariableDeclaration(declaration),
            Statement::ReturnStatement(statement),
        ] if declaration.kind == VariableDeclarationKind::Const
            && declaration.declarations.len() == 1 =>
        {
            let declarator = &declaration.declarations[0];
            let BindingPattern::BindingIdentifier(alias) = &declarator.id else {
                return None;
            };
            Some(DirectCallbackReturn {
                expression: statement.argument.as_ref()?,
                key_alias: Some((alias.symbol_id.get()?, declarator.init.as_ref()?)),
            })
        }
        _ => None,
    }
}

fn simple_parameter_symbol(parameters: &FormalParameters<'_>, index: usize) -> Option<SymbolId> {
    let parameter = parameters.items.get(index)?;
    if parameter.initializer.is_some() {
        return None;
    }
    let BindingPattern::BindingIdentifier(identifier) = &parameter.pattern else {
        return None;
    };
    identifier.symbol_id.get()
}

struct ListParameterReferenceCollector<'scoping> {
    scoping: &'scoping Scoping,
    item: SymbolId,
    index: Option<SymbolId>,
    item_references: Vec<SourceSpan>,
    index_references: Vec<SourceSpan>,
    readonly: bool,
    uses_arguments: bool,
    context_sensitive: bool,
}

impl<'a> Visit<'a> for ListParameterReferenceCollector<'_> {
    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        if identifier.name == "arguments" {
            self.uses_arguments = true;
        }
        let Some(reference) = identifier
            .reference_id
            .get()
            .map(|reference| self.scoping.get_reference(reference))
        else {
            return;
        };
        let Some(symbol) = reference.symbol_id() else {
            return;
        };
        let target = if symbol == self.item {
            Some(&mut self.item_references)
        } else if self.index == Some(symbol) {
            Some(&mut self.index_references)
        } else {
            None
        };
        let Some(target) = target else {
            return;
        };
        if reference.is_write() {
            self.readonly = false;
        }
        if reference.is_read() {
            target.push(source_span(identifier.span));
        }
    }

    fn visit_this_expression(&mut self, _expression: &ThisExpression) {
        self.context_sensitive = true;
    }

    fn visit_meta_property(&mut self, _property: &MetaProperty<'a>) {
        self.context_sensitive = true;
    }

    fn visit_super(&mut self, _super: &Super) {
        self.context_sensitive = true;
    }
}

fn direct_jsx_key_span(element: &JSXElement<'_>) -> Result<Option<SourceSpan>, ()> {
    let mut key = None;
    for attribute in &element.opening_element.attributes {
        let JSXAttributeItem::Attribute(attribute) = attribute else {
            return Err(());
        };
        if !matches!(&attribute.name, JSXAttributeName::Identifier(name) if name.name == "key") {
            continue;
        }
        if key.is_some() {
            return Err(());
        }
        key = Some(match attribute.value.as_ref().ok_or(())? {
            OxcJsxAttributeValue::StringLiteral(literal) => source_span(literal.span),
            OxcJsxAttributeValue::ExpressionContainer(container) => {
                source_span(container.expression.as_expression().ok_or(())?.span())
            }
            OxcJsxAttributeValue::Element(_) | OxcJsxAttributeValue::Fragment(_) => return Err(()),
        });
    }
    Ok(key)
}

fn direct_jsx_key_expression<'a, 'element>(
    element: &'element JSXElement<'a>,
) -> Option<&'element Expression<'a>> {
    let mut key = None;
    for attribute in &element.opening_element.attributes {
        let JSXAttributeItem::Attribute(attribute) = attribute else {
            return None;
        };
        if !matches!(&attribute.name, JSXAttributeName::Identifier(name) if name.name == "key") {
            continue;
        }
        if key.is_some() {
            return None;
        }
        let OxcJsxAttributeValue::ExpressionContainer(container) = attribute.value.as_ref()? else {
            return None;
        };
        key = container.expression.as_expression();
    }
    key
}

fn classify_raw_list_receiver(
    scoping: &Scoping,
    known_arrays: &BTreeSet<SymbolId>,
    aliases: &StaticHookAliases,
    expression: &Expression<'_>,
) -> Option<RawJsxListReceiver> {
    match expression.get_inner_expression() {
        Expression::ArrayExpression(_) => Some(RawJsxListReceiver::ArrayLiteral),
        Expression::Identifier(identifier) => scoping
            .get_reference(identifier.reference_id.get()?)
            .symbol_id()
            .map(|root| RawJsxListReceiver::Binding {
                root,
                projected: false,
                known_array: known_arrays.contains(&root),
            }),
        Expression::StaticMemberExpression(_)
        | Expression::ComputedMemberExpression(_)
        | Expression::PrivateFieldExpression(_) => {
            expression_root_symbol(scoping, expression).map(|root| RawJsxListReceiver::Binding {
                root,
                projected: true,
                known_array: false,
            })
        }
        Expression::CallExpression(call) if !call.optional => {
            let (receiver, method) = match call.callee.get_inner_expression() {
                Expression::StaticMemberExpression(member)
                    if !member.optional
                        && trusted_array_returning_method(member.property.name.as_str()) =>
                {
                    (&member.object, member.property.name.as_str())
                }
                Expression::ComputedMemberExpression(member) if !member.optional => {
                    let Expression::StringLiteral(property) =
                        member.expression.get_inner_expression()
                    else {
                        return None;
                    };
                    if !trusted_array_returning_method(property.value.as_str()) {
                        return None;
                    }
                    (&member.object, property.value.as_str())
                }
                _ => return None,
            };
            if !aliases.receiver_method_is_intact(
                scoping,
                receiver,
                StateReceiverKind::Array,
                method,
            ) {
                return None;
            }
            classify_raw_list_receiver(scoping, known_arrays, aliases, receiver)
        }
        _ => None,
    }
}

fn trusted_array_returning_method(name: &str) -> bool {
    matches!(name, "filter" | "map" | "slice" | "toReversed" | "toSorted")
}

fn is_mutating_array_method(name: &str) -> bool {
    matches!(
        name,
        "copyWithin"
            | "fill"
            | "pop"
            | "push"
            | "reverse"
            | "shift"
            | "sort"
            | "splice"
            | "unshift"
    )
}

#[derive(Debug, Clone)]
struct ArgumentFact {
    span: SourceSpan,
    has_effects: bool,
    spread: bool,
    function: Option<FunctionId>,
    array_literal: bool,
    state_receiver_kind: StateReceiverKind,
}

#[derive(Debug, Clone)]
struct CallFact {
    owner: FunctionId,
    span: SourceSpan,
    callee_span: SourceSpan,
    callee_has_effects: bool,
    callee_reference: Option<PlannedPlace>,
    binding: Option<BindingId>,
    configured_reactive_scope: bool,
    reactive_kind: Option<ReactiveCallKind>,
    runtime_creation_kind: Option<RuntimeReactiveCreationKind>,
    arguments: Vec<ArgumentFact>,
    declared_state_receiver_kind: Option<StateReceiverKind>,
    callback: Option<FunctionId>,
    direct_variable: Option<bool>,
    direct_variable_binding: Option<BindingId>,
    immediate_statement: bool,
    effect_statement: Option<SourceSpan>,
    immediate_default_export: bool,
    conditional_or_loop: bool,
    inside_jsx: bool,
    hook: Option<HookCall>,
    arguments_conditional: bool,
    optional: bool,
    pure: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RuntimeReactiveClassification {
    reactive_kind: Option<ReactiveCallKind>,
    creation_kind: Option<RuntimeReactiveCreationKind>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeReactiveCreationKind {
    Effect,
    Memo,
    NamespaceMemo,
    Selector,
}

impl RuntimeReactiveCreationKind {
    const fn scope_kind(self) -> Option<ReactiveScopeKind> {
        match self {
            Self::Effect => Some(ReactiveScopeKind::EffectCallback),
            Self::Memo | Self::NamespaceMemo => Some(ReactiveScopeKind::MemoCallback),
            Self::Selector => None,
        }
    }
}

fn call_arguments_are_conditional(call: &CallExpression<'_>) -> bool {
    call.optional || callee_continues_optional_chain(&call.callee)
}

fn callee_continues_optional_chain(expression: &Expression<'_>) -> bool {
    match expression {
        Expression::StaticMemberExpression(member) => {
            member.optional || callee_continues_optional_chain(&member.object)
        }
        Expression::ComputedMemberExpression(member) => {
            member.optional || callee_continues_optional_chain(&member.object)
        }
        Expression::PrivateFieldExpression(member) => {
            member.optional || callee_continues_optional_chain(&member.object)
        }
        Expression::CallExpression(call) => {
            call.optional || callee_continues_optional_chain(&call.callee)
        }
        Expression::TSInstantiationExpression(expression) => {
            callee_continues_optional_chain(&expression.expression)
        }
        Expression::TSNonNullExpression(expression) => {
            callee_continues_optional_chain(&expression.expression)
        }
        // Parentheses and an already completed ChainExpression terminate the optional chain.
        // For example, `(object?.method)(argument)` evaluates `argument` before throwing when
        // `object` is nullish, unlike `object?.method(argument)`.
        _ => false,
    }
}

#[derive(Debug, Clone)]
struct VariableDeclarationFact {
    declaration_kind: DeclarationKind,
    declarator_span: SourceSpan,
    pattern_span: SourceSpan,
    initializer_span: Option<SourceSpan>,
    initializer_has_effects: bool,
    bindings: Vec<SymbolId>,
    simple_binding: Option<SymbolId>,
    has_defaults: bool,
    has_rest: bool,
    contains_await: bool,
    contains_yield: bool,
    contains_jsx: bool,
}

#[derive(Debug, Clone)]
struct TypedExpressionFact {
    span: SourceSpan,
    kind: TypedExpressionKind,
}

#[derive(Debug, Clone)]
struct ClassFact {
    span: SourceSpan,
    declaration_binding: Option<SymbolId>,
    deferred_initializers: Vec<SourceSpan>,
    eager_spans: Vec<SourceSpan>,
    decorator_spans: Vec<SourceSpan>,
}

#[derive(Debug, Clone, Copy)]
struct DecoratorFact {
    span: SourceSpan,
}

#[derive(Debug, Clone)]
enum TypedExpressionKind {
    Literal(LiteralValue),
    UnresolvedTypeof {
        identifier: String,
        reference_span: SourceSpan,
    },
    Context {
        kind: ContextValueKind,
    },
    Delete {
        target: TypedDeleteTarget,
    },
    Unary {
        operator: UnaryOperator,
        argument: SourceSpan,
        argument_has_effects: bool,
    },
    Binary {
        operator: BinaryOperator,
        left: SourceSpan,
        right: SourceSpan,
        left_has_effects: bool,
        right_has_effects: bool,
    },
    Logical {
        operator: BinaryOperator,
        left: SourceSpan,
        right: SourceSpan,
        left_has_effects: bool,
        right_has_effects: bool,
    },
    Conditional {
        test: SourceSpan,
        consequent: SourceSpan,
        alternate: SourceSpan,
        test_has_effects: bool,
        consequent_has_effects: bool,
        alternate_has_effects: bool,
    },
    Sequence {
        values: Vec<TypedSequenceValue>,
    },
    TemplateLiteral {
        quasis: Vec<JavaScriptString>,
        expressions: Vec<TypedTemplateExpression>,
    },
    TaggedTemplate {
        tag: SourceSpan,
        tag_has_effects: bool,
        tag_reference: Option<PlannedPlace>,
        tag_binding: Option<SymbolId>,
        quasis: Vec<TaggedTemplateQuasi>,
        substitutions: Vec<TypedTemplateExpression>,
    },
    DynamicImport {
        specifier: SourceSpan,
        specifier_has_effects: bool,
        options: Option<SourceSpan>,
        options_have_effects: bool,
        phase: ImportPhase,
    },
    Await {
        value: SourceSpan,
        value_has_effects: bool,
    },
    Yield {
        value: Option<SourceSpan>,
        value_has_effects: bool,
        delegate: bool,
    },
    New {
        callee: SourceSpan,
        callee_has_effects: bool,
        arguments: Vec<TypedNewArgument>,
    },
    Array {
        elements: Vec<TypedArrayElement>,
    },
    Object {
        entries: Vec<TypedObjectEntry>,
    },
}

#[derive(Debug, Clone, Copy)]
struct TypedSequenceValue {
    span: SourceSpan,
    has_effects: bool,
}

#[derive(Debug, Clone, Copy)]
struct TypedTemplateExpression {
    span: SourceSpan,
    has_effects: bool,
}

#[derive(Debug, Clone)]
enum TypedArrayElement {
    Hole(SourceSpan),
    Value {
        span: SourceSpan,
        has_effects: bool,
    },
    Spread {
        span: SourceSpan,
        origin: SourceSpan,
        has_effects: bool,
    },
}

#[derive(Debug, Clone)]
enum TypedDeleteTarget {
    Place(PlannedPlace),
    UnresolvedIdentifier {
        identifier: String,
        reference_span: SourceSpan,
    },
    Value {
        span: SourceSpan,
        has_effects: bool,
    },
}

fn typed_expression_reference_suppression(expression: &TypedExpressionFact) -> Option<SourceSpan> {
    match &expression.kind {
        TypedExpressionKind::UnresolvedTypeof { reference_span, .. }
        | TypedExpressionKind::Delete {
            target: TypedDeleteTarget::UnresolvedIdentifier { reference_span, .. },
        } => Some(*reference_span),
        TypedExpressionKind::Delete {
            target: TypedDeleteTarget::Place(place),
        } => place.root_reference_span,
        _ => None,
    }
}

#[derive(Debug, Clone, Copy)]
struct TypedNewArgument {
    value: SourceSpan,
    value_has_effects: bool,
    spread: bool,
}

#[derive(Debug, Clone)]
enum TypedObjectEntry {
    Property {
        key: TypedObjectKey,
        value: SourceSpan,
        value_has_effects: bool,
        kind: ObjectPropertyKind,
        shorthand: bool,
        prototype_setter: bool,
        origin: SourceSpan,
    },
    Spread {
        value: SourceSpan,
        value_has_effects: bool,
        origin: SourceSpan,
    },
}

#[derive(Debug, Clone)]
enum TypedObjectKey {
    Static(String),
    Index(u32),
    Computed {
        expression: SourceSpan,
        expression_has_effects: bool,
    },
}

#[derive(Debug, Clone)]
struct ReadFact {
    owner: FunctionId,
    place: PlannedPlace,
    span: SourceSpan,
    reactive: bool,
}

#[derive(Debug, Clone)]
struct MutationFact {
    symbol: Option<SymbolId>,
    projected: bool,
    target_span: SourceSpan,
    place: Option<PlannedPlace>,
    span: SourceSpan,
    kind: ReactiveMutationKind,
}

#[derive(Debug, Clone)]
struct PatternAssignmentTargetFact {
    symbol: SymbolId,
    span: SourceSpan,
}

#[derive(Debug, Clone)]
struct PatternProjectedTargetFact {
    place: PlannedPlace,
    span: SourceSpan,
}

#[derive(Debug, Clone)]
struct PatternAssignmentFact {
    span: SourceSpan,
    pattern_span: SourceSpan,
    value_span: SourceSpan,
    value_has_effects: bool,
    targets: Vec<PatternAssignmentTargetFact>,
    projected_targets: Vec<PatternProjectedTargetFact>,
    has_defaults: bool,
    has_rest: bool,
    contains_await: bool,
    contains_yield: bool,
    contains_jsx: bool,
}

#[derive(Debug, Clone)]
struct LocalMutationFact {
    owner: FunctionId,
    binding: Option<BindingId>,
    place: PlannedPlace,
    span: SourceSpan,
    kind: ReactiveMutationKind,
    reactive: bool,
}

#[derive(Debug, Clone)]
struct MemberReadFact {
    span: SourceSpan,
    place: PlannedPlace,
}

#[derive(Debug, Clone)]
struct PlannedPlace {
    base: PlannedPlaceBase,
    projections: Vec<PlannedProjection>,
    root_reference_span: Option<SourceSpan>,
}

#[derive(Debug, Clone)]
enum PlannedPlaceBase {
    Binding(SymbolId),
    UnresolvedGlobal {
        name: String,
        span: SourceSpan,
    },
    Context {
        kind: ContextValueKind,
        span: SourceSpan,
    },
    Expression {
        span: SourceSpan,
        has_effects: bool,
    },
}

fn planned_global_reference(place: &PlannedPlace) -> Option<(String, SourceSpan)> {
    let PlannedPlaceBase::UnresolvedGlobal { name, span } = &place.base else {
        return None;
    };
    Some((name.clone(), *span))
}

fn reference_is_inside_with(scoping: &Scoping, mut scope: OxcScopeId) -> bool {
    loop {
        if scoping.scope_flags(scope).is_with() {
            return true;
        }
        let Some(parent) = scoping.scope_parent_id(scope) else {
            return false;
        };
        scope = parent;
    }
}

#[derive(Debug, Clone)]
enum PlannedProjection {
    Static {
        name: String,
        optional: bool,
    },
    Computed {
        key: SourceSpan,
        optional: bool,
        has_effects: bool,
        deferred: bool,
    },
    Index {
        index: u32,
        optional: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum StaticAliasRoot {
    Binding(SymbolId),
    UnresolvedGlobal(String),
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct StaticAliasPath {
    root: StaticAliasRoot,
    properties: Vec<String>,
}

impl StaticAliasPath {
    fn root(root: SymbolId) -> Self {
        Self {
            root: StaticAliasRoot::Binding(root),
            properties: Vec::new(),
        }
    }

    fn unresolved_global(name: String) -> Self {
        Self {
            root: StaticAliasRoot::UnresolvedGlobal(name),
            properties: Vec::new(),
        }
    }

    fn binding_root(&self) -> Option<SymbolId> {
        let StaticAliasRoot::Binding(root) = self.root else {
            return None;
        };
        Some(root)
    }

    fn with_property(&self, property: String) -> Self {
        let mut path = self.clone();
        path.properties.push(property);
        path
    }

    fn starts_with(&self, prefix: &Self) -> bool {
        self.root == prefix.root && self.properties.starts_with(&prefix.properties)
    }

    fn overlaps(&self, other: &Self) -> bool {
        self.starts_with(other) || other.starts_with(self)
    }
}

#[derive(Debug, Default)]
struct StaticHookAliases {
    aliases: BTreeMap<StaticAliasPath, StaticAliasPath>,
    member_invalidated: BTreeSet<StaticAliasPath>,
}

impl StaticHookAliases {
    fn resolve(&self, original: &StaticAliasPath) -> StaticAliasPath {
        let mut current = original.clone();
        let mut visited = BTreeSet::new();
        visited.insert(current.clone());

        while visited.len() <= self.aliases.len() {
            let replacement = (0..=current.properties.len()).rev().find_map(|length| {
                let prefix = StaticAliasPath {
                    root: current.root.clone(),
                    properties: current.properties[..length].to_vec(),
                };
                self.aliases.get(&prefix).map(|source| {
                    let mut resolved = source.clone();
                    resolved
                        .properties
                        .extend_from_slice(&current.properties[length..]);
                    resolved
                })
            });
            let Some(replacement) = replacement else {
                break;
            };
            if !visited.insert(replacement.clone()) {
                break;
            }
            current = replacement;
        }

        current
    }

    fn path_is_intact(&self, path: &StaticAliasPath) -> bool {
        let resolved = self.resolve(path);
        self.member_invalidated
            .iter()
            .all(|invalidated| !invalidated.overlaps(path) && !invalidated.overlaps(&resolved))
    }

    fn builtin_prototype_method_is_intact(
        &self,
        receiver: StateReceiverKind,
        method: &str,
    ) -> bool {
        if receiver == StateReceiverKind::Unknown {
            return false;
        }
        self.path_is_intact(
            &StaticAliasPath::unresolved_global("Object".to_string())
                .with_property("prototype".to_string())
                .with_property(method.to_string()),
        ) && builtin_state_receiver_constructor_names(receiver)
            .iter()
            .all(|constructor| {
                self.path_is_intact(
                    &StaticAliasPath::unresolved_global((*constructor).to_string())
                        .with_property("prototype".to_string())
                        .with_property(method.to_string()),
                )
            })
    }

    fn receiver_method_is_intact(
        &self,
        scoping: &Scoping,
        receiver: &Expression<'_>,
        receiver_kind: StateReceiverKind,
        method: &str,
    ) -> bool {
        self.builtin_prototype_method_is_intact(receiver_kind, method)
            && static_alias_source_path(scoping, receiver)
                .is_none_or(|path| self.path_is_intact(&path.with_property(method.to_string())))
    }
}

#[derive(Debug, Clone)]
enum EvaluationFact {
    Typed(TypedExpressionFact),
    Jsx(JsxFact),
    Call(CallFact),
    Member(MemberReadFact),
    Mutation(LocalMutationFact),
    PatternAssignment(PatternAssignmentFact),
    Decorator(DecoratorFact),
    Class(ClassFact),
}

impl EvaluationFact {
    fn span(&self) -> SourceSpan {
        match self {
            Self::Typed(expression) => expression.span,
            Self::Jsx(jsx) => jsx.span,
            Self::Call(call) => call.span,
            Self::Member(member) => member.span,
            Self::Mutation(mutation) => mutation.span,
            Self::PatternAssignment(assignment) => assignment.span,
            Self::Decorator(decorator) => decorator.span,
            Self::Class(class) => class.span,
        }
    }

    fn rank(&self) -> u8 {
        match self {
            Self::Typed(TypedExpressionFact {
                kind: TypedExpressionKind::Literal(_),
                ..
            }) => 0,
            Self::Typed(TypedExpressionFact {
                kind: TypedExpressionKind::UnresolvedTypeof { .. },
                ..
            }) => 1,
            Self::Typed(TypedExpressionFact {
                kind: TypedExpressionKind::Context { .. },
                ..
            }) => 1,
            Self::Typed(TypedExpressionFact {
                kind: TypedExpressionKind::Delete { .. },
                ..
            }) => 2,
            Self::Typed(TypedExpressionFact {
                kind: TypedExpressionKind::Unary { .. },
                ..
            }) => 2,
            Self::Typed(TypedExpressionFact {
                kind: TypedExpressionKind::Binary { .. },
                ..
            }) => 3,
            Self::Typed(TypedExpressionFact {
                kind: TypedExpressionKind::Logical { .. },
                ..
            }) => 4,
            Self::Typed(TypedExpressionFact {
                kind: TypedExpressionKind::Conditional { .. },
                ..
            }) => 5,
            Self::Typed(TypedExpressionFact {
                kind: TypedExpressionKind::Sequence { .. },
                ..
            }) => 6,
            Self::Typed(TypedExpressionFact {
                kind: TypedExpressionKind::TemplateLiteral { .. },
                ..
            }) => 7,
            Self::Typed(TypedExpressionFact {
                kind: TypedExpressionKind::TaggedTemplate { .. },
                ..
            }) => 8,
            Self::Typed(TypedExpressionFact {
                kind: TypedExpressionKind::DynamicImport { .. },
                ..
            }) => 9,
            Self::Typed(TypedExpressionFact {
                kind: TypedExpressionKind::Await { .. },
                ..
            }) => 10,
            Self::Typed(TypedExpressionFact {
                kind: TypedExpressionKind::Yield { .. },
                ..
            }) => 11,
            Self::Typed(TypedExpressionFact {
                kind: TypedExpressionKind::New { .. },
                ..
            }) => 12,
            Self::Typed(TypedExpressionFact {
                kind: TypedExpressionKind::Array { .. },
                ..
            }) => 13,
            Self::Typed(TypedExpressionFact {
                kind: TypedExpressionKind::Object { .. },
                ..
            }) => 14,
            Self::Jsx(_) => 15,
            Self::Member(_) => 16,
            Self::Call(_) => 17,
            Self::Mutation(_) => 18,
            Self::PatternAssignment(_) => 19,
            Self::Decorator(_) => 20,
            Self::Class(_) => 21,
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum ReactiveMutationKind {
    Write {
        value_span: SourceSpan,
        value_has_effects: bool,
    },
    Compound {
        operator: CompoundAssignmentOperator,
        value_span: SourceSpan,
        value_has_effects: bool,
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
    next_function_inheritance: Vec<bool>,
    jsx_depth: u32,
    variables: Vec<VariableContext>,
    expression_statements: Vec<SourceSpan>,
    default_exports: Vec<SourceSpan>,
    static_block_depth: u32,
}

impl PlacementContext {
    fn enter(&mut self, kind: AstKind<'_>) {
        match kind {
            AstKind::Function(_) | AstKind::ArrowFunctionExpression(_) => {
                let inherits_parent = self.next_function_inheritance.pop().unwrap_or(false);
                let baseline = if inherits_parent {
                    self.function_baselines
                        .last()
                        .copied()
                        .unwrap_or((self.block_depth, self.control_depth))
                } else {
                    (self.block_depth, self.control_depth)
                };
                self.function_baselines.push(baseline);
            }
            AstKind::JSXElement(_) | AstKind::JSXFragment(_) => {
                self.jsx_depth = self.jsx_depth.saturating_add(1);
            }
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
            AstKind::StaticBlock(_) => {
                self.static_block_depth = self.static_block_depth.saturating_add(1);
            }
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
            AstKind::JSXElement(_) | AstKind::JSXFragment(_) => {
                self.jsx_depth = self.jsx_depth.saturating_sub(1);
            }
            AstKind::BlockStatement(_) => self.block_depth = self.block_depth.saturating_sub(1),
            AstKind::VariableDeclarator(_) => {
                self.variables.pop();
            }
            AstKind::ExpressionStatement(_) => {
                self.expression_statements.pop();
            }
            AstKind::StaticBlock(_) => {
                self.static_block_depth = self.static_block_depth.saturating_sub(1);
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

    fn facts(
        &self,
        call: SourceSpan,
    ) -> (
        Option<bool>,
        Option<SymbolId>,
        bool,
        Option<SourceSpan>,
        bool,
        bool,
        bool,
    ) {
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
        let effect_statement = self.expression_statements.last().copied();
        let immediate_default_export =
            immediate_statement && self.default_exports.last().copied() == Some(call);
        (
            direct_variable,
            direct_variable_binding,
            immediate_statement,
            effect_statement,
            immediate_default_export,
            conditional_or_loop,
            self.jsx_depth > 0,
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
    )
}

#[derive(Default)]
struct ImmediateInvocationCollector {
    functions: BTreeSet<(u32, u32)>,
}

impl<'a> Visit<'a> for ImmediateInvocationCollector {
    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        let span = match call.callee.get_inner_expression() {
            Expression::FunctionExpression(function) => Some(function.span),
            Expression::ArrowFunctionExpression(function) => Some(function.span),
            _ => None,
        };
        if let Some(span) = span {
            self.functions.insert((span.start, span.end));
        }
        walk_call_expression(self, call);
    }
}

struct CallCollector<'facts, 'semantic> {
    scoping: &'semantic Scoping,
    stack: Vec<FunctionId>,
    function_by_span: &'facts BTreeMap<(u32, u32), FunctionId>,
    symbol_to_binding: &'facts BTreeMap<SymbolId, BindingId>,
    hook_bindings: &'facts BTreeSet<BindingId>,
    namespace_imports: &'facts BTreeSet<BindingId>,
    imported_hook_member_paths: &'facts BTreeMap<BindingId, BTreeSet<Vec<String>>>,
    reactive_bindings: &'facts BTreeMap<BindingId, RuntimeReactiveClassification>,
    reactive_namespace_sources: &'facts BTreeMap<BindingId, String>,
    configured_scope_names: &'facts BTreeSet<String>,
    configured_bindings: &'facts BTreeSet<BindingId>,
    immediate_invocations: &'facts BTreeSet<FunctionId>,
    context: PlacementContext,
    calls: Vec<CallFact>,
    effect_statements: BTreeMap<FunctionId, BTreeSet<SourceSpan>>,
    concise_arrow_functions: BTreeSet<FunctionId>,
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

    fn visit_expression_statement(&mut self, statement: &ExpressionStatement<'a>) {
        let (_, control_baseline) = self
            .context
            .function_baselines
            .last()
            .copied()
            .unwrap_or_default();
        let owner = *self.stack.last().expect("module expression owner");
        if self.context.control_depth == control_baseline
            && self.context.static_block_depth == 0
            && !self.concise_arrow_functions.contains(&owner)
        {
            self.effect_statements
                .entry(owner)
                .or_default()
                .insert(source_span(statement.expression.span()));
        }
        walk_expression_statement(self, statement);
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
        self.context
            .next_function_inheritance
            .push(self.immediate_invocations.contains(&id));
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
        if function.expression {
            self.concise_arrow_functions.insert(id);
        }
        self.stack.push(id);
        self.context
            .next_function_inheritance
            .push(self.immediate_invocations.contains(&id));
        walk_arrow_function_expression(self, function);
        self.stack.pop();
    }

    fn visit_logical_expression(&mut self, expression: &LogicalExpression<'a>) {
        self.visit_span(&expression.span);
        self.visit_expression(&expression.left);
        self.context.control_depth = self.context.control_depth.saturating_add(1);
        self.visit_expression(&expression.right);
        self.context.control_depth = self.context.control_depth.saturating_sub(1);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        let call_span = source_span(call.span);
        let (
            direct_variable,
            direct_variable_symbol,
            immediate_statement,
            effect_statement,
            immediate_default_export,
            conditional_or_loop,
            inside_jsx,
        ) = self.context.facts(call_span);
        let direct_variable_binding =
            direct_variable_symbol.and_then(|symbol| self.symbol_to_binding.get(&symbol).copied());
        let direct_binding = resolved_callee_symbol(self.scoping, &call.callee)
            .and_then(|symbol| self.symbol_to_binding.get(&symbol).copied());
        let configured_reactive_scope = configured_reactive_scope_call(
            self.scoping,
            &call.callee,
            direct_binding,
            self.configured_scope_names,
            self.configured_bindings,
        );
        let callee_reference = planned_invocation_reference(self.scoping, &call.callee);
        let namespace_reactive = namespace_reactive_call_classification(
            self.scoping,
            &call.callee,
            self.symbol_to_binding,
            self.reactive_namespace_sources,
        );
        let imported_hook_member_binding = callee_reference.as_ref().and_then(|place| {
            resolved_imported_hook_member_binding(
                place,
                self.symbol_to_binding,
                self.imported_hook_member_paths,
            )
        });
        let binding = direct_binding
            .or(namespace_reactive.map(|(binding, _)| binding))
            .or(imported_hook_member_binding);
        let runtime_reactive = direct_binding
            .and_then(|binding| self.reactive_bindings.get(&binding).copied())
            .or(namespace_reactive.map(|(_, classification)| classification));
        let reactive_kind =
            runtime_reactive.and_then(|classification| classification.reactive_kind);
        let runtime_creation_kind =
            runtime_reactive.and_then(|classification| classification.creation_kind);
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
                let (span, has_effects, spread, function, array_literal, state_receiver_kind) =
                    if let Some(expression) = argument.as_expression() {
                        let expression = expression.get_inner_expression();
                        (
                            source_span(expression.span()),
                            structured_control_flow::expression_has_effects(expression),
                            false,
                            self.function_for_expression(expression),
                            matches!(expression, Expression::ArrayExpression(_)),
                            classify_state_receiver_expression(self.scoping, expression),
                        )
                    } else if let oxc::ast::ast::Argument::SpreadElement(spread) = argument {
                        let expression = spread.argument.get_inner_expression();
                        (
                            source_span(expression.span()),
                            structured_control_flow::expression_has_effects(&spread.argument),
                            true,
                            None,
                            false,
                            StateReceiverKind::Unknown,
                        )
                    } else {
                        unreachable!("every call argument is an expression or spread")
                    };
                ArgumentFact {
                    span,
                    has_effects,
                    spread,
                    function,
                    array_literal,
                    state_receiver_kind,
                }
            })
            .collect();
        let declared_state_receiver_kind = call
            .type_arguments
            .as_ref()
            .and_then(|arguments| arguments.params.first())
            .and_then(|annotation| classify_state_receiver_type(self.scoping, annotation));
        self.calls.push(CallFact {
            owner: *self.stack.last().expect("module call owner"),
            span: call_span,
            callee_span: source_span(call.callee.get_inner_expression().span()),
            callee_has_effects: structured_control_flow::expression_has_effects(&call.callee),
            callee_reference,
            binding,
            configured_reactive_scope,
            reactive_kind,
            runtime_creation_kind,
            callback: arguments.first().and_then(|argument| argument.function),
            direct_variable,
            direct_variable_binding,
            immediate_statement,
            effect_statement,
            immediate_default_export,
            conditional_or_loop,
            inside_jsx,
            hook,
            arguments,
            declared_state_receiver_kind,
            arguments_conditional: call_arguments_are_conditional(call),
            optional: call.optional,
            pure: call.pure,
        });
        walk_call_expression(self, call);
    }
}

struct DeclaredStateReceiverTypeCollector<'semantic> {
    scoping: &'semantic Scoping,
    receivers: BTreeMap<SymbolId, StateReceiverKind>,
}

impl DeclaredStateReceiverTypeCollector<'_> {
    fn record(
        &mut self,
        pattern: &BindingPattern<'_>,
        annotation: Option<&oxc::ast::ast::TSTypeAnnotation<'_>>,
    ) {
        let (BindingPattern::BindingIdentifier(binding), Some(annotation)) = (pattern, annotation)
        else {
            return;
        };
        let Some(symbol) = binding.symbol_id.get() else {
            return;
        };
        if let Some(receiver) =
            classify_state_receiver_type(self.scoping, &annotation.type_annotation)
        {
            self.receivers.insert(symbol, receiver);
        }
    }
}

impl<'a> Visit<'a> for DeclaredStateReceiverTypeCollector<'_> {
    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        self.record(&declarator.id, declarator.type_annotation.as_deref());
        walk_variable_declarator(self, declarator);
    }

    fn visit_formal_parameter(&mut self, parameter: &FormalParameter<'a>) {
        self.record(&parameter.pattern, parameter.type_annotation.as_deref());
        oxc::ast_visit::walk::walk_formal_parameter(self, parameter);
    }

    fn visit_formal_parameter_rest(&mut self, parameter: &FormalParameterRest<'a>) {
        self.record(
            &parameter.rest.argument,
            parameter.type_annotation.as_deref(),
        );
        oxc::ast_visit::walk::walk_formal_parameter_rest(self, parameter);
    }
}

struct StateReceiverMutationCollector<'facts, 'semantic> {
    scoping: &'semantic Scoping,
    state_symbols: &'facts BTreeSet<SymbolId>,
    receivers: &'facts BTreeMap<SymbolId, StateReceiverKind>,
    mutations: BTreeMap<SymbolId, Vec<StateReceiverKind>>,
}

impl StateReceiverMutationCollector<'_, '_> {
    fn record(&mut self, symbol: SymbolId, receiver: StateReceiverKind) {
        if self.state_symbols.contains(&symbol) {
            self.mutations.entry(symbol).or_default().push(receiver);
        }
    }
}

impl<'a> Visit<'a> for StateReceiverMutationCollector<'_, '_> {
    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        if let Some(identifier) = direct_assignment_target_identifier(&assignment.left)
            && let Some(symbol) = identifier_symbol(self.scoping, identifier)
        {
            let receiver = if assignment.operator == OxcAssignmentOperator::Assign {
                classify_state_receiver_assignment(self.scoping, &assignment.right, self.receivers)
            } else {
                StateReceiverKind::Unknown
            };
            self.record(symbol, receiver);
        } else if matches!(
            assignment.left,
            AssignmentTarget::ArrayAssignmentTarget(_)
                | AssignmentTarget::ObjectAssignmentTarget(_)
        ) {
            let mut targets = Vec::new();
            collect_pattern_assignment_targets(
                self.scoping,
                &assignment.left,
                &mut targets,
                &mut Vec::new(),
            );
            for target in targets {
                self.record(target.symbol, StateReceiverKind::Unknown);
            }
        }
        oxc::ast_visit::walk::walk_assignment_expression(self, assignment);
    }

    fn visit_update_expression(&mut self, update: &UpdateExpression<'a>) {
        if let Some((symbol, projected)) =
            simple_assignment_target_symbol(self.scoping, &update.argument)
            && !projected
        {
            let receiver = if self.receivers.get(&symbol) == Some(&StateReceiverKind::Number) {
                StateReceiverKind::Number
            } else {
                StateReceiverKind::Unknown
            };
            self.record(symbol, receiver);
        }
        oxc::ast_visit::walk::walk_update_expression(self, update);
    }

    fn visit_for_in_statement(&mut self, statement: &oxc::ast::ast::ForInStatement<'a>) {
        let target =
            structured_control_flow::planned_iteration_target(&statement.left, self.scoping);
        for symbol in target.declared.into_iter().chain(target.assigned) {
            self.record(symbol, StateReceiverKind::Unknown);
        }
        oxc::ast_visit::walk::walk_for_in_statement(self, statement);
    }

    fn visit_for_of_statement(&mut self, statement: &oxc::ast::ast::ForOfStatement<'a>) {
        let target =
            structured_control_flow::planned_iteration_target(&statement.left, self.scoping);
        for symbol in target.declared.into_iter().chain(target.assigned) {
            self.record(symbol, StateReceiverKind::Unknown);
        }
        oxc::ast_visit::walk::walk_for_of_statement(self, statement);
    }
}

struct MutationCollector<'semantic> {
    scoping: &'semantic Scoping,
    facts: Vec<MutationFact>,
    pattern_assignments: Vec<PatternAssignmentFact>,
}

struct MemberAccessCollector<'semantic> {
    scoping: &'semantic Scoping,
    suppressed: BTreeSet<(u32, u32)>,
    facts: Vec<MemberReadFact>,
}

impl MemberAccessCollector<'_> {
    fn collect_static(&mut self, member: &oxc::ast::ast::StaticMemberExpression<'_>) {
        let span = source_span(member.span);
        if let Some(place) = planned_static_member_place(self.scoping, member)
            && !self.suppressed.contains(&(span.start(), span.end()))
        {
            self.facts.push(MemberReadFact { span, place });
        }
        self.visit_member_object(&member.object);
    }

    fn collect_computed(&mut self, member: &ComputedMemberExpression<'_>) {
        let span = source_span(member.span);
        if let Some(place) = planned_computed_member_place(self.scoping, member)
            && !self.suppressed.contains(&(span.start(), span.end()))
        {
            self.facts.push(MemberReadFact { span, place });
        }
        self.visit_member_object(&member.object);
        self.visit_expression(&member.expression);
    }

    fn visit_member_object<'a>(&mut self, object: &Expression<'a>) {
        match object.get_inner_expression() {
            Expression::StaticMemberExpression(member) => self.visit_member_object(&member.object),
            Expression::ComputedMemberExpression(member) => {
                self.visit_member_object(&member.object);
                self.visit_expression(&member.expression);
            }
            Expression::PrivateFieldExpression(member) => self.visit_member_object(&member.object),
            Expression::ChainExpression(chain) => match &chain.expression {
                ChainElement::StaticMemberExpression(member) => {
                    self.visit_member_object(&member.object);
                }
                ChainElement::ComputedMemberExpression(member) => {
                    self.visit_member_object(&member.object);
                    self.visit_expression(&member.expression);
                }
                ChainElement::PrivateFieldExpression(member) => {
                    self.visit_member_object(&member.object);
                }
                ChainElement::CallExpression(call) => self.visit_call_expression(call),
                ChainElement::TSNonNullExpression(expression) => {
                    self.visit_expression(&expression.expression);
                }
            },
            _ => self.visit_expression(object),
        }
    }
}

impl<'a> Visit<'a> for MemberAccessCollector<'_> {
    fn visit_static_member_expression(
        &mut self,
        member: &oxc::ast::ast::StaticMemberExpression<'a>,
    ) {
        self.collect_static(member);
    }

    fn visit_computed_member_expression(&mut self, member: &ComputedMemberExpression<'a>) {
        self.collect_computed(member);
    }

    fn visit_private_field_expression(
        &mut self,
        member: &oxc::ast::ast::PrivateFieldExpression<'a>,
    ) {
        self.visit_member_object(&member.object);
    }
}

#[derive(Default)]
struct DeleteTargetCollector {
    member_spans: BTreeSet<(u32, u32)>,
}

impl<'a> Visit<'a> for DeleteTargetCollector {
    fn visit_unary_expression(&mut self, expression: &oxc::ast::ast::UnaryExpression<'a>) {
        if expression.operator == OxcUnaryOperator::Delete {
            let argument = expression.argument.get_inner_expression();
            if let Some(span) = deleted_member_span(argument) {
                self.member_spans.insert((span.start(), span.end()));
            }
        }
        oxc::ast_visit::walk::walk_unary_expression(self, expression);
    }
}

fn deleted_member_span(expression: &Expression<'_>) -> Option<SourceSpan> {
    match expression.get_inner_expression() {
        Expression::StaticMemberExpression(member) => Some(source_span(member.span)),
        Expression::ComputedMemberExpression(member) => Some(source_span(member.span)),
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::StaticMemberExpression(member) => Some(source_span(member.span)),
            ChainElement::ComputedMemberExpression(member) => Some(source_span(member.span)),
            ChainElement::CallExpression(_)
            | ChainElement::PrivateFieldExpression(_)
            | ChainElement::TSNonNullExpression(_) => None,
        },
        _ => None,
    }
}

#[derive(Debug)]
struct ReactiveSymbolAnalysis {
    state: BTreeSet<SymbolId>,
    state_receivers: BTreeMap<SymbolId, StateReceiverKind>,
    reactive: BTreeSet<SymbolId>,
    escape_reactive: BTreeSet<SymbolId>,
    hook_return_shapes: BTreeMap<SymbolId, LocalHookReturnShape>,
    dependencies: Vec<ReactiveBindingDependencyFact>,
}

#[derive(Debug, Clone, Default)]
struct LocalHookReturnShape {
    direct: bool,
    members: BTreeSet<String>,
}

impl LocalHookReturnShape {
    fn has_accessor(&self) -> bool {
        self.direct || !self.members.is_empty()
    }
}

struct LocalHookReturnCollector<'facts, 'semantic, 'reactive> {
    scoping: &'semantic Scoping,
    function_by_span: &'facts BTreeMap<(u32, u32), FunctionId>,
    hook_functions: &'facts BTreeSet<FunctionId>,
    accessor_symbols: &'reactive BTreeSet<SymbolId>,
    stack: Vec<FunctionId>,
    shapes: BTreeMap<FunctionId, LocalHookReturnShape>,
}

impl LocalHookReturnCollector<'_, '_, '_> {
    fn direct_accessor(&self, expression: &Expression<'_>) -> bool {
        let Expression::Identifier(identifier) = expression.get_inner_expression() else {
            return false;
        };
        identifier
            .reference_id
            .get()
            .and_then(|reference| self.scoping.get_reference(reference).symbol_id())
            .is_some_and(|symbol| self.accessor_symbols.contains(&symbol))
    }

    fn record_return(&mut self, expression: &Expression<'_>) {
        let owner = *self.stack.last().expect("local hook return owner");
        if !self.hook_functions.contains(&owner) {
            return;
        }
        if self.direct_accessor(expression) {
            self.shapes.entry(owner).or_default().direct = true;
            return;
        }
        match expression.get_inner_expression() {
            Expression::ObjectExpression(object) => {
                for property in &object.properties {
                    let OxcObjectPropertyKind::ObjectProperty(property) = property else {
                        continue;
                    };
                    if property.computed || !self.direct_accessor(&property.value) {
                        continue;
                    }
                    let Some(name) = property.key.static_name() else {
                        continue;
                    };
                    self.shapes
                        .entry(owner)
                        .or_default()
                        .members
                        .insert(name.into_owned());
                }
            }
            Expression::ArrayExpression(array) => {
                for (index, element) in array.elements.iter().enumerate() {
                    if matches!(
                        element,
                        ArrayExpressionElement::Elision(_)
                            | ArrayExpressionElement::SpreadElement(_)
                    ) {
                        continue;
                    }
                    if self.direct_accessor(element.to_expression()) {
                        self.shapes
                            .entry(owner)
                            .or_default()
                            .members
                            .insert(index.to_string());
                    }
                }
            }
            _ => {}
        }
    }
}

impl<'a> Visit<'a> for LocalHookReturnCollector<'_, '_, '_> {
    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        let Some(owner) = self
            .function_by_span
            .get(&(function.span.start, function.span.end))
            .copied()
        else {
            walk_function(self, function, flags);
            return;
        };
        self.stack.push(owner);
        walk_function(self, function, flags);
        self.stack.pop();
    }

    fn visit_arrow_function_expression(&mut self, function: &ArrowFunctionExpression<'a>) {
        let Some(owner) = self
            .function_by_span
            .get(&(function.span.start, function.span.end))
            .copied()
        else {
            walk_arrow_function_expression(self, function);
            return;
        };
        self.stack.push(owner);
        walk_arrow_function_expression(self, function);
        self.stack.pop();
    }

    fn visit_return_statement(&mut self, statement: &ReturnStatement<'a>) {
        if let Some(argument) = &statement.argument {
            self.record_return(argument);
        }
        walk_return_statement(self, statement);
    }
}

fn collect_local_hook_return_shapes(
    program: &Program<'_>,
    scoping: &Scoping,
    function_by_span: &BTreeMap<(u32, u32), FunctionId>,
    functions: &[HirFunction],
    calls: &[CallFact],
    binding_to_symbol: &BTreeMap<BindingId, SymbolId>,
    macro_bindings: &BTreeMap<BindingId, FictMacroKind>,
) -> BTreeMap<SymbolId, LocalHookReturnShape> {
    let hook_functions: BTreeSet<_> = functions
        .iter()
        .filter(|function| function.kind == FunctionKind::Hook)
        .map(|function| function.id)
        .collect();
    let accessor_symbols: BTreeSet<_> = calls
        .iter()
        .filter(|call| {
            call.binding
                .and_then(|binding| macro_bindings.get(&binding))
                .is_some_and(|kind| matches!(kind, FictMacroKind::State | FictMacroKind::Memo))
        })
        .filter_map(|call| call.direct_variable_binding)
        .filter_map(|binding| binding_to_symbol.get(&binding).copied())
        .collect();
    let mut collector = LocalHookReturnCollector {
        scoping,
        function_by_span,
        hook_functions: &hook_functions,
        accessor_symbols: &accessor_symbols,
        stack: vec![FunctionId::new(0)],
        shapes: BTreeMap::new(),
    };
    collector.visit_program(program);

    let shapes_by_binding: BTreeMap<_, _> = functions
        .iter()
        .filter_map(|function| {
            let shape = collector.shapes.get(&function.id)?;
            if function.kind != FunctionKind::Hook || !shape.has_accessor() {
                return None;
            }
            Some((function.binding?, shape.clone()))
        })
        .collect();
    calls
        .iter()
        .filter_map(|call| {
            let shape = shapes_by_binding.get(&call.binding?)?.clone();
            let result = call.direct_variable_binding?;
            Some((*binding_to_symbol.get(&result)?, shape))
        })
        .collect()
}

fn propagate_reactive_symbols(
    symbols: &mut BTreeSet<SymbolId>,
    dependencies: &[ReactiveBindingDependencyFact],
) {
    loop {
        let mut changed = false;
        for fact in dependencies {
            if fact.sources.iter().any(|source| symbols.contains(source)) {
                for target in &fact.targets {
                    changed |= symbols.insert(*target);
                }
            }
        }
        if !changed {
            break;
        }
    }
}

#[derive(Debug, Clone)]
struct ReactiveBindingDependencyFact {
    targets: Vec<SymbolId>,
    sources: BTreeSet<SymbolId>,
    source_span: SourceSpan,
    callback_container: bool,
}

struct ReactiveBindingDependencyCollector<'semantic> {
    scoping: &'semantic Scoping,
    facts: Vec<ReactiveBindingDependencyFact>,
}

fn expression_can_carry_callback(expression: &Expression<'_>) -> bool {
    !matches!(
        expression.get_inner_expression(),
        Expression::CallExpression(_)
            | Expression::TaggedTemplateExpression(_)
            | Expression::AwaitExpression(_)
            | Expression::BinaryExpression(_)
            | Expression::UnaryExpression(_)
            | Expression::UpdateExpression(_)
    )
}

impl ReactiveBindingDependencyCollector<'_> {
    fn push_fact(&mut self, targets: Vec<SymbolId>, source: &Expression<'_>) {
        if targets.is_empty() {
            return;
        }
        let mut collector = ResolvedSymbolCollector {
            scoping: self.scoping,
            symbols: BTreeSet::new(),
        };
        collector.visit_expression(source);
        if !collector.symbols.is_empty() {
            self.facts.push(ReactiveBindingDependencyFact {
                targets,
                sources: collector.symbols,
                source_span: source_span(source.span()),
                callback_container: expression_can_carry_callback(source),
            });
        }
    }

    fn push_pattern_default_facts(&mut self, target: &AssignmentTarget<'_>) {
        match target {
            AssignmentTarget::ArrayAssignmentTarget(array) => {
                for element in array.elements.iter().flatten() {
                    self.push_maybe_default_facts(element);
                }
                if let Some(rest) = &array.rest {
                    self.push_pattern_default_facts(&rest.target);
                }
            }
            AssignmentTarget::ObjectAssignmentTarget(object) => {
                for property in &object.properties {
                    match property {
                        AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(property) => {
                            if let Some(initializer) = &property.init
                                && let Some(symbol) =
                                    identifier_symbol(self.scoping, &property.binding)
                            {
                                self.push_fact(vec![symbol], initializer);
                            }
                        }
                        AssignmentTargetProperty::AssignmentTargetPropertyProperty(property) => {
                            self.push_maybe_default_facts(&property.binding);
                        }
                    }
                }
                if let Some(rest) = &object.rest {
                    self.push_pattern_default_facts(&rest.target);
                }
            }
            AssignmentTarget::AssignmentTargetIdentifier(_)
            | AssignmentTarget::TSAsExpression(_)
            | AssignmentTarget::TSSatisfiesExpression(_)
            | AssignmentTarget::TSNonNullExpression(_)
            | AssignmentTarget::TSTypeAssertion(_)
            | AssignmentTarget::ComputedMemberExpression(_)
            | AssignmentTarget::StaticMemberExpression(_)
            | AssignmentTarget::PrivateFieldExpression(_) => {}
        }
    }

    fn push_maybe_default_facts(&mut self, target: &AssignmentTargetMaybeDefault<'_>) {
        match target {
            AssignmentTargetMaybeDefault::AssignmentTargetWithDefault(default) => {
                let mut targets = Vec::new();
                collect_pattern_assignment_targets(
                    self.scoping,
                    &default.binding,
                    &mut targets,
                    &mut Vec::new(),
                );
                let mut symbols = targets
                    .into_iter()
                    .map(|target| target.symbol)
                    .collect::<Vec<_>>();
                symbols.sort_unstable();
                symbols.dedup();
                self.push_fact(symbols, &default.init);
                self.push_pattern_default_facts(&default.binding);
            }
            AssignmentTargetMaybeDefault::ArrayAssignmentTarget(array) => {
                for element in array.elements.iter().flatten() {
                    self.push_maybe_default_facts(element);
                }
                if let Some(rest) = &array.rest {
                    self.push_pattern_default_facts(&rest.target);
                }
            }
            AssignmentTargetMaybeDefault::ObjectAssignmentTarget(object) => {
                for property in &object.properties {
                    match property {
                        AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(property) => {
                            if let Some(initializer) = &property.init
                                && let Some(symbol) =
                                    identifier_symbol(self.scoping, &property.binding)
                            {
                                self.push_fact(vec![symbol], initializer);
                            }
                        }
                        AssignmentTargetProperty::AssignmentTargetPropertyProperty(property) => {
                            self.push_maybe_default_facts(&property.binding);
                        }
                    }
                }
                if let Some(rest) = &object.rest {
                    self.push_pattern_default_facts(&rest.target);
                }
            }
            AssignmentTargetMaybeDefault::AssignmentTargetIdentifier(_)
            | AssignmentTargetMaybeDefault::TSAsExpression(_)
            | AssignmentTargetMaybeDefault::TSSatisfiesExpression(_)
            | AssignmentTargetMaybeDefault::TSNonNullExpression(_)
            | AssignmentTargetMaybeDefault::TSTypeAssertion(_)
            | AssignmentTargetMaybeDefault::ComputedMemberExpression(_)
            | AssignmentTargetMaybeDefault::StaticMemberExpression(_)
            | AssignmentTargetMaybeDefault::PrivateFieldExpression(_) => {}
        }
    }
}

impl<'a> Visit<'a> for ReactiveBindingDependencyCollector<'_> {
    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if let Some(initializer) = &declarator.init {
            let mut targets = PatternBindingCollector::default();
            targets.visit_binding_pattern(&declarator.id);
            self.push_fact(targets.symbols, initializer);
        }
        walk_variable_declarator(self, declarator);
    }

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        if matches!(
            assignment.left,
            AssignmentTarget::ArrayAssignmentTarget(_)
                | AssignmentTarget::ObjectAssignmentTarget(_)
        ) {
            let mut targets = Vec::new();
            collect_pattern_assignment_targets(
                self.scoping,
                &assignment.left,
                &mut targets,
                &mut Vec::new(),
            );
            let target_spans = targets
                .iter()
                .map(|target| (target.span.start(), target.span.end()))
                .collect();
            let mut pattern_reads = PatternReadSymbolCollector {
                scoping: self.scoping,
                target_spans,
                symbols: BTreeSet::new(),
            };
            pattern_reads.visit_assignment_target(&assignment.left);
            let mut target_symbols = targets
                .into_iter()
                .map(|target| target.symbol)
                .collect::<Vec<_>>();
            target_symbols.sort_unstable();
            target_symbols.dedup();
            if !target_symbols.is_empty() && !pattern_reads.symbols.is_empty() {
                self.facts.push(ReactiveBindingDependencyFact {
                    targets: target_symbols.clone(),
                    sources: pattern_reads.symbols,
                    source_span: source_span(assignment.span),
                    // Computed keys, default calls, and member bases affect reactive execution
                    // without becoming the callback value assigned to a target.
                    callback_container: false,
                });
            }
            self.push_fact(target_symbols, &assignment.right);
            self.push_pattern_default_facts(&assignment.left);
        } else {
            let targets = assignment_target_symbol(self.scoping, &assignment.left)
                .map(|(symbol, _)| vec![symbol])
                .unwrap_or_default();
            self.push_fact(targets, &assignment.right);
        }
        oxc::ast_visit::walk::walk_assignment_expression(self, assignment);
    }

    fn visit_for_in_statement(&mut self, statement: &oxc::ast::ast::ForInStatement<'a>) {
        let target =
            structured_control_flow::planned_iteration_target(&statement.left, self.scoping);
        let targets = target.declared.into_iter().chain(target.assigned).collect();
        self.push_fact(targets, &statement.right);
        oxc::ast_visit::walk::walk_for_in_statement(self, statement);
    }

    fn visit_for_of_statement(&mut self, statement: &oxc::ast::ast::ForOfStatement<'a>) {
        let target =
            structured_control_flow::planned_iteration_target(&statement.left, self.scoping);
        let targets = target.declared.into_iter().chain(target.assigned).collect();
        self.push_fact(targets, &statement.right);
        oxc::ast_visit::walk::walk_for_of_statement(self, statement);
    }
}

struct ResolvedSymbolCollector<'semantic> {
    scoping: &'semantic Scoping,
    symbols: BTreeSet<SymbolId>,
}

struct PatternReadSymbolCollector<'semantic> {
    scoping: &'semantic Scoping,
    target_spans: BTreeSet<(u32, u32)>,
    symbols: BTreeSet<SymbolId>,
}

impl<'a> Visit<'a> for PatternReadSymbolCollector<'_> {
    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        if self
            .target_spans
            .contains(&(identifier.span.start, identifier.span.end))
        {
            return;
        }
        if let Some(symbol) = identifier
            .reference_id
            .get()
            .and_then(|reference| self.scoping.get_reference(reference).symbol_id())
        {
            self.symbols.insert(symbol);
        }
    }

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        if assignment.operator == OxcAssignmentOperator::Assign {
            self.visit_expression(&assignment.right);
        } else {
            oxc::ast_visit::walk::walk_assignment_expression(self, assignment);
        }
    }
}

impl<'a> Visit<'a> for ResolvedSymbolCollector<'_> {
    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        if let Some(symbol) = identifier
            .reference_id
            .get()
            .and_then(|reference| self.scoping.get_reference(reference).symbol_id())
        {
            self.symbols.insert(symbol);
        }
    }

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        if assignment.operator == OxcAssignmentOperator::Assign {
            // A plain assignment expression evaluates to its RHS. Identifiers in an object or
            // array assignment target are writes, so they must not become value dependencies of
            // a binding or callback property initialized by the assignment result.
            self.visit_expression(&assignment.right);
        } else {
            oxc::ast_visit::walk::walk_assignment_expression(self, assignment);
        }
    }
}

struct CallbackReferenceCollector<'semantic> {
    scoping: &'semantic Scoping,
    symbols: BTreeSet<SymbolId>,
    members: BTreeSet<(SymbolId, String)>,
}

impl<'a> Visit<'a> for CallbackReferenceCollector<'_> {
    fn visit_function(&mut self, _function: &Function<'a>, _flags: ScopeFlags) {}

    fn visit_arrow_function_expression(&mut self, _function: &ArrowFunctionExpression<'a>) {}

    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        if let Some(symbol) = identifier
            .reference_id
            .get()
            .and_then(|reference| self.scoping.get_reference(reference).symbol_id())
        {
            self.symbols.insert(symbol);
        }
    }

    fn visit_static_member_expression(
        &mut self,
        member: &oxc::ast::ast::StaticMemberExpression<'a>,
    ) {
        if let Expression::Identifier(identifier) = member.object.get_inner_expression()
            && let Some(symbol) = identifier
                .reference_id
                .get()
                .and_then(|reference| self.scoping.get_reference(reference).symbol_id())
        {
            self.members
                .insert((symbol, member.property.name.to_string()));
            return;
        }
        oxc::ast_visit::walk::walk_static_member_expression(self, member);
    }

    fn visit_computed_member_expression(&mut self, member: &ComputedMemberExpression<'a>) {
        let property = match member.expression.get_inner_expression() {
            Expression::StringLiteral(property) => Some(property.value.to_string()),
            Expression::NumericLiteral(property) => Some(property.value.to_string()),
            _ => None,
        };
        if let (Expression::Identifier(identifier), Some(property)) =
            (member.object.get_inner_expression(), property)
            && let Some(symbol) = identifier
                .reference_id
                .get()
                .and_then(|reference| self.scoping.get_reference(reference).symbol_id())
        {
            self.members.insert((symbol, property));
            return;
        }
        oxc::ast_visit::walk::walk_computed_member_expression(self, member);
    }
}

fn span_contains(container: SourceSpan, nested: SourceSpan) -> bool {
    container.start() <= nested.start() && nested.end() <= container.end()
}

fn span_is_within_owned_pattern(
    owner: FunctionId,
    span: SourceSpan,
    patterns: &[(FunctionId, SourceSpan)],
) -> bool {
    patterns
        .iter()
        .any(|(pattern_owner, pattern)| *pattern_owner == owner && span_contains(*pattern, span))
}

fn static_member_name(expression: &Expression<'_>) -> Option<String> {
    match expression.get_inner_expression() {
        Expression::StringLiteral(property) => Some(property.value.to_string()),
        Expression::NumericLiteral(property) => Some(property.value.to_string()),
        _ => None,
    }
}

struct StaticHookAliasCollector<'semantic> {
    scoping: &'semantic Scoping,
    aliases: BTreeMap<StaticAliasPath, StaticAliasPath>,
    invalidated: BTreeSet<StaticAliasPath>,
    member_invalidated: BTreeSet<StaticAliasPath>,
    reflective_mutations: Vec<ReflectiveMemberMutationFact>,
}

struct ReflectiveMemberMutationFact {
    callee: StaticAliasPath,
    target: StaticAliasPath,
    key: Option<String>,
}

impl StaticHookAliasCollector<'_> {
    fn clear_overlapping_aliases(&mut self, path: &StaticAliasPath) {
        self.aliases.retain(|target, _| !target.overlaps(path));
    }

    fn insert_alias(&mut self, target: StaticAliasPath, source: StaticAliasPath) {
        self.clear_overlapping_aliases(&target);
        if target != source {
            self.aliases.insert(target, source);
        }
    }

    fn collect_initializer(&mut self, target: StaticAliasPath, value: &Expression<'_>) {
        self.clear_overlapping_aliases(&target);
        if let Expression::ObjectExpression(object) = value.get_inner_expression() {
            self.collect_object(&target, object);
        } else if let Some(source) = static_alias_source_path(self.scoping, value) {
            self.insert_alias(target, source);
        }
    }

    fn collect_object(
        &mut self,
        target: &StaticAliasPath,
        object: &oxc::ast::ast::ObjectExpression<'_>,
    ) {
        for property in &object.properties {
            let OxcObjectPropertyKind::ObjectProperty(property) = property else {
                self.aliases
                    .retain(|candidate, _| !candidate.starts_with(target));
                continue;
            };
            let Some(name) = property.key.static_name() else {
                self.aliases
                    .retain(|candidate, _| !candidate.starts_with(target));
                continue;
            };
            let property_target = target.with_property(name.into_owned());
            self.clear_overlapping_aliases(&property_target);
            if property.kind != PropertyKind::Init || property.method {
                continue;
            }
            if let Expression::ObjectExpression(nested) = property.value.get_inner_expression() {
                self.collect_object(&property_target, nested);
            } else if let Some(source) = static_alias_source_path(self.scoping, &property.value) {
                self.insert_alias(property_target, source);
            }
        }
    }

    fn invalidate_place(&mut self, place: Option<PlannedPlace>) {
        if let Some(place) = place.as_ref()
            && let Some(path) = static_alias_invalidation_path(place)
        {
            if !place.projections.is_empty()
                || matches!(&place.base, PlannedPlaceBase::UnresolvedGlobal { .. })
            {
                self.member_invalidated.insert(path.clone());
            }
            self.invalidated.insert(path);
        }
    }

    fn finish(mut self, mutable_symbols: &BTreeSet<SymbolId>) -> StaticHookAliases {
        let resolver = StaticHookAliases {
            aliases: self.aliases.clone(),
            member_invalidated: BTreeSet::new(),
        };
        for mutation in &self.reflective_mutations {
            let callee = resolver.resolve(&mutation.callee);
            let Some(keyed) = reflective_member_mutator_kind(&callee) else {
                continue;
            };
            let mut target = resolver.resolve(&mutation.target);
            if keyed && let Some(key) = &mutation.key {
                target.properties.push(key.clone());
            }
            self.invalidated.insert(target.clone());
            self.member_invalidated.insert(target);
        }
        let mut invalidated = self.invalidated.clone();
        invalidated.extend(self.invalidated.iter().map(|path| resolver.resolve(path)));
        let mut member_invalidated = self.member_invalidated.clone();
        member_invalidated.extend(
            self.member_invalidated
                .iter()
                .map(|path| resolver.resolve(path)),
        );
        self.aliases.retain(|target, source| {
            target
                .binding_root()
                .is_none_or(|root| !mutable_symbols.contains(&root))
                && source
                    .binding_root()
                    .is_none_or(|root| !mutable_symbols.contains(&root))
                && invalidated.iter().all(|invalidated| {
                    !target.overlaps(invalidated) && !source.overlaps(invalidated)
                })
        });
        StaticHookAliases {
            aliases: self.aliases,
            member_invalidated,
        }
    }
}

impl<'a> Visit<'a> for StaticHookAliasCollector<'_> {
    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if let BindingPattern::BindingIdentifier(binding) = &declarator.id
            && let Some(root) = binding.symbol_id.get()
            && let Some(initializer) = &declarator.init
        {
            self.collect_initializer(StaticAliasPath::root(root), initializer);
        }
        walk_variable_declarator(self, declarator);
    }

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        self.invalidate_place(planned_assignment_target_place(
            self.scoping,
            &assignment.left,
        ));
        oxc::ast_visit::walk::walk_assignment_expression(self, assignment);
    }

    fn visit_update_expression(&mut self, update: &UpdateExpression<'a>) {
        self.invalidate_place(planned_simple_assignment_target_place(
            self.scoping,
            &update.argument,
        ));
        oxc::ast_visit::walk::walk_update_expression(self, update);
    }

    fn visit_unary_expression(&mut self, expression: &oxc::ast::ast::UnaryExpression<'a>) {
        if expression.operator == OxcUnaryOperator::Delete {
            self.invalidate_place(planned_expression_place(
                self.scoping,
                expression.argument.get_inner_expression(),
            ));
        }
        oxc::ast_visit::walk::walk_unary_expression(self, expression);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if let Some(callee) = static_alias_source_path(self.scoping, &call.callee)
            && let Some(target) = call
                .arguments
                .first()
                .and_then(|argument| argument.as_expression())
                .and_then(|target| static_alias_source_path(self.scoping, target))
        {
            let key = call
                .arguments
                .get(1)
                .and_then(|argument| argument.as_expression())
                .and_then(static_member_name);
            self.reflective_mutations
                .push(ReflectiveMemberMutationFact {
                    callee,
                    target,
                    key,
                });
        }
        walk_call_expression(self, call);
    }
}

fn reflective_member_mutator_kind(callee: &StaticAliasPath) -> Option<bool> {
    let StaticAliasRoot::UnresolvedGlobal(root) = &callee.root else {
        return None;
    };
    let [method] = callee.properties.as_slice() else {
        return None;
    };
    match (root.as_str(), method.as_str()) {
        ("Object", "defineProperty") | ("Reflect", "defineProperty" | "set" | "deleteProperty") => {
            Some(true)
        }
        ("Object", "assign" | "defineProperties" | "setPrototypeOf")
        | ("Reflect", "setPrototypeOf") => Some(false),
        _ => None,
    }
}

struct FunctionCaptureCollector<'facts, 'semantic, 'reactive> {
    scoping: &'semantic Scoping,
    reactive_symbols: &'reactive BTreeSet<SymbolId>,
    binding_owners: &'facts BTreeMap<SymbolId, FunctionId>,
    function_by_span: &'facts BTreeMap<(u32, u32), FunctionId>,
    stack: Vec<FunctionId>,
    captures: BTreeMap<FunctionId, BTreeSet<SymbolId>>,
}

impl<'a> Visit<'a> for FunctionCaptureCollector<'_, '_, '_> {
    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        let Some(owner) = self
            .function_by_span
            .get(&(function.span.start, function.span.end))
            .copied()
        else {
            walk_function(self, function, flags);
            return;
        };
        self.stack.push(owner);
        walk_function(self, function, flags);
        self.stack.pop();
    }

    fn visit_arrow_function_expression(&mut self, function: &ArrowFunctionExpression<'a>) {
        let Some(owner) = self
            .function_by_span
            .get(&(function.span.start, function.span.end))
            .copied()
        else {
            walk_arrow_function_expression(self, function);
            return;
        };
        self.stack.push(owner);
        walk_arrow_function_expression(self, function);
        self.stack.pop();
    }

    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        let Some(symbol) = identifier
            .reference_id
            .get()
            .and_then(|reference| self.scoping.get_reference(reference).symbol_id())
        else {
            return;
        };
        if !self.reactive_symbols.contains(&symbol) {
            return;
        }
        let owner = *self.stack.last().expect("function capture owner");
        if owner == FunctionId::new(0) || self.binding_owners.get(&symbol).copied() == Some(owner) {
            return;
        }
        self.captures.entry(owner).or_default().insert(symbol);
    }
}

#[derive(Debug)]
struct CallbackPropertyFact {
    target: SymbolId,
    property: String,
    source_span: SourceSpan,
    sources: BTreeSet<SymbolId>,
}

#[derive(Debug)]
struct CallbackClassPropertyFact {
    class: SymbolId,
    property: String,
    source_span: SourceSpan,
    callback_span: Option<SourceSpan>,
    is_static: bool,
}

#[derive(Debug)]
struct CallbackClassInstanceFact {
    instance: SymbolId,
    class: SymbolId,
}

struct CallbackPropertyCollector<'semantic> {
    scoping: &'semantic Scoping,
    properties: Vec<CallbackPropertyFact>,
    class_properties: Vec<CallbackClassPropertyFact>,
    class_instances: Vec<CallbackClassInstanceFact>,
}

impl CallbackPropertyCollector<'_> {
    fn push_expression(&mut self, target: SymbolId, property: String, source: &Expression<'_>) {
        let mut symbols = ResolvedSymbolCollector {
            scoping: self.scoping,
            symbols: BTreeSet::new(),
        };
        symbols.visit_expression(source);
        self.properties.push(CallbackPropertyFact {
            target,
            property,
            source_span: source_span(source.span()),
            sources: symbols.symbols,
        });
    }

    fn push_object(&mut self, target: SymbolId, object: &oxc::ast::ast::ObjectExpression<'_>) {
        for property in &object.properties {
            let OxcObjectPropertyKind::ObjectProperty(property) = property else {
                continue;
            };
            let Some(name) = property.key.static_name() else {
                continue;
            };
            self.push_expression(target, name.into_owned(), &property.value);
        }
    }
}

impl<'a> Visit<'a> for CallbackPropertyCollector<'_> {
    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if let BindingPattern::BindingIdentifier(binding) = &declarator.id
            && let Some(target) = binding.symbol_id.get()
            && let Some(initializer) = &declarator.init
        {
            match initializer.get_inner_expression() {
                Expression::ObjectExpression(object) => self.push_object(target, object),
                Expression::NewExpression(new_expression) => {
                    if let Some(class) =
                        resolved_callee_symbol(self.scoping, &new_expression.callee)
                    {
                        self.class_instances.push(CallbackClassInstanceFact {
                            instance: target,
                            class,
                        });
                    }
                }
                _ => {}
            }
        }
        walk_variable_declarator(self, declarator);
    }

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        let target = match &assignment.left {
            AssignmentTarget::StaticMemberExpression(member) => {
                expression_root_symbol(self.scoping, &member.object)
                    .map(|symbol| (symbol, member.property.name.to_string()))
            }
            AssignmentTarget::ComputedMemberExpression(member) => {
                let name = match member.expression.get_inner_expression() {
                    Expression::StringLiteral(property) => Some(property.value.to_string()),
                    Expression::NumericLiteral(property) => Some(property.value.to_string()),
                    _ => None,
                };
                expression_root_symbol(self.scoping, &member.object).zip(name)
            }
            _ => None,
        };
        if let Some((target, property)) = target {
            self.push_expression(target, property, &assignment.right);
        }
        oxc::ast_visit::walk::walk_assignment_expression(self, assignment);
    }

    fn visit_class(&mut self, class: &Class<'a>) {
        if let Some(binding) = class
            .id
            .as_ref()
            .and_then(|identifier| identifier.symbol_id.get())
        {
            for element in &class.body.body {
                let Some(property) = element.static_name().map(|name| name.into_owned()) else {
                    continue;
                };
                let (is_static, callback_span) = match element {
                    oxc::ast::ast::ClassElement::MethodDefinition(definition) => (
                        definition.r#static,
                        (definition.kind == MethodDefinitionKind::Method)
                            .then(|| source_span(definition.value.span)),
                    ),
                    oxc::ast::ast::ClassElement::PropertyDefinition(definition) => (
                        definition.r#static,
                        definition
                            .value
                            .as_ref()
                            .map(|value| source_span(value.get_inner_expression().span())),
                    ),
                    oxc::ast::ast::ClassElement::AccessorProperty(definition) => (
                        definition.r#static,
                        definition
                            .value
                            .as_ref()
                            .map(|value| source_span(value.get_inner_expression().span())),
                    ),
                    oxc::ast::ast::ClassElement::StaticBlock(_)
                    | oxc::ast::ast::ClassElement::TSIndexSignature(_) => continue,
                };
                self.class_properties.push(CallbackClassPropertyFact {
                    class: binding,
                    property,
                    source_span: source_span(element.span()),
                    callback_span,
                    is_static,
                });
            }
        }
        oxc::ast_visit::walk::walk_class(self, class);
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct CallbackTiming {
    may_suspend: bool,
    may_return_iterator: bool,
}

impl CallbackTiming {
    fn from_flags(flags: FunctionFlags) -> Self {
        if flags.is_generator {
            Self {
                may_suspend: false,
                may_return_iterator: true,
            }
        } else {
            Self {
                may_suspend: flags.is_async,
                may_return_iterator: false,
            }
        }
    }

    fn merge(self, other: Self) -> Self {
        Self {
            may_suspend: self.may_suspend || other.may_suspend,
            may_return_iterator: self.may_return_iterator || other.may_return_iterator,
        }
    }
}

fn record_callback_timing(
    timings: &mut BTreeMap<StaticAliasPath, Option<CallbackTiming>>,
    path: StaticAliasPath,
    timing: Option<CallbackTiming>,
) {
    timings
        .entry(path)
        .and_modify(|current| {
            *current = match (*current, timing) {
                (Some(current), Some(timing)) => Some(current.merge(timing)),
                (None, _) | (_, None) => None,
            };
        })
        .or_insert(timing);
}

fn exact_callback_timing(functions: &[FunctionFact], span: SourceSpan) -> Option<CallbackTiming> {
    functions
        .iter()
        .filter(|function| function.span == span)
        .map(|function| CallbackTiming::from_flags(function.flags))
        .reduce(CallbackTiming::merge)
}

fn collect_callback_timings(
    functions: &[FunctionFact],
    properties: &CallbackPropertyCollector<'_>,
    mutable_symbols: &BTreeSet<SymbolId>,
) -> BTreeMap<StaticAliasPath, Option<CallbackTiming>> {
    let mut timings = BTreeMap::new();
    for function in functions {
        let Some(binding) = function.binding else {
            continue;
        };
        if mutable_symbols.contains(&binding) {
            continue;
        }
        record_callback_timing(
            &mut timings,
            StaticAliasPath::root(binding),
            Some(CallbackTiming::from_flags(function.flags)),
        );
    }

    let mut instance_timings = BTreeMap::<(SymbolId, String), Option<CallbackTiming>>::new();
    for property in &properties.class_properties {
        let timing = property
            .callback_span
            .and_then(|span| exact_callback_timing(functions, span));
        if property.is_static {
            record_callback_timing(
                &mut timings,
                StaticAliasPath::root(property.class).with_property(property.property.clone()),
                timing,
            );
        } else {
            instance_timings
                .entry((property.class, property.property.clone()))
                .and_modify(|current| {
                    *current = match (*current, timing) {
                        (Some(current), Some(timing)) => Some(current.merge(timing)),
                        (None, _) | (_, None) => None,
                    };
                })
                .or_insert(timing);
        }
    }
    for instance in &properties.class_instances {
        if mutable_symbols.contains(&instance.instance) {
            continue;
        }
        for ((class, property), timing) in &instance_timings {
            if *class == instance.class {
                record_callback_timing(
                    &mut timings,
                    StaticAliasPath::root(instance.instance).with_property(property.clone()),
                    *timing,
                );
            }
        }
    }
    for property in &properties.properties {
        record_callback_timing(
            &mut timings,
            StaticAliasPath::root(property.target).with_property(property.property.clone()),
            exact_callback_timing(functions, property.source_span),
        );
    }
    timings
}

#[derive(Debug, Clone)]
struct EscapeImportIdentity {
    source: String,
    imported: String,
}

#[derive(Debug)]
enum EscapeDiagnosticKind {
    StateSnapshot,
    ReactiveValue,
    CallbackCapture(BTreeSet<SymbolId>),
}

#[derive(Debug)]
struct EscapeDiagnosticFact {
    kind: EscapeDiagnosticKind,
    span: SourceSpan,
}

#[derive(Clone, Copy)]
struct EscapeArgument<'node, 'ast> {
    expression: &'node Expression<'ast>,
    span: SourceSpan,
    spread: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CallbackResultDisposition {
    Discarded,
    Retained,
}

struct ReactiveEscapeCollector<'facts, 'semantic, 'reactive> {
    scoping: &'semantic Scoping,
    call_facts: &'facts BTreeMap<(u32, u32), &'facts CallFact>,
    macro_bindings: &'facts BTreeMap<BindingId, FictMacroKind>,
    local_hook_bindings: &'facts BTreeSet<BindingId>,
    imports: &'facts BTreeMap<BindingId, EscapeImportIdentity>,
    known_arrays: &'facts BTreeSet<SymbolId>,
    state_symbols: &'reactive BTreeSet<SymbolId>,
    proven_receivers: &'reactive BTreeMap<SymbolId, StateReceiverKind>,
    reactive_symbols: &'reactive BTreeSet<SymbolId>,
    hook_return_shapes: &'reactive BTreeMap<SymbolId, LocalHookReturnShape>,
    capturing_functions: &'facts [(SourceSpan, BTreeSet<SymbolId>)],
    callback_captures: &'facts BTreeMap<SymbolId, BTreeSet<SymbolId>>,
    callback_property_captures: &'facts BTreeMap<(SymbolId, String), BTreeSet<SymbolId>>,
    callback_timings: &'facts BTreeMap<StaticAliasPath, Option<CallbackTiming>>,
    callback_aliases: &'facts StaticHookAliases,
    diagnostics: Vec<EscapeDiagnosticFact>,
}

impl ReactiveEscapeCollector<'_, '_, '_> {
    fn direct_state_symbol(&self, argument: EscapeArgument<'_, '_>) -> Option<SymbolId> {
        if argument.spread {
            return None;
        }
        let Expression::Identifier(identifier) = argument.expression.get_inner_expression() else {
            return None;
        };
        let symbol = identifier
            .reference_id
            .get()
            .and_then(|reference| self.scoping.get_reference(reference).symbol_id())?;
        self.state_symbols.contains(&symbol).then_some(symbol)
    }

    fn reactive_references(&self, argument: EscapeArgument<'_, '_>) -> BTreeSet<SymbolId> {
        let root = argument.expression.get_inner_expression();
        let root_function = match root {
            Expression::FunctionExpression(function) => {
                Some((function.span.start, function.span.end))
            }
            Expression::ArrowFunctionExpression(function) => {
                Some((function.span.start, function.span.end))
            }
            _ => None,
        };
        let mut collector = ReactiveArgumentCollector {
            scoping: self.scoping,
            reactive_symbols: self.reactive_symbols,
            hook_return_shapes: self.hook_return_shapes,
            root_function,
            symbols: BTreeSet::new(),
        };
        collector.visit_expression(argument.expression);
        collector.symbols
    }

    fn retained_reactive_references(&self, expression: &Expression<'_>) -> BTreeSet<SymbolId> {
        let mut collector = RetainedReactiveIdentityCollector {
            scoping: self.scoping,
            reactive_symbols: self.reactive_symbols,
            hook_return_shapes: self.hook_return_shapes,
            symbols: BTreeSet::new(),
        };
        collector.visit_expression(expression);
        collector.symbols
    }

    fn callback_captures(&self, argument: EscapeArgument<'_, '_>) -> BTreeSet<SymbolId> {
        let mut captured = BTreeSet::new();
        for (span, symbols) in self.capturing_functions {
            if span_contains(argument.span, *span) {
                captured.extend(symbols);
            }
        }
        let mut references = CallbackReferenceCollector {
            scoping: self.scoping,
            symbols: BTreeSet::new(),
            members: BTreeSet::new(),
        };
        references.visit_expression(argument.expression);
        for symbol in references.symbols {
            if let Some(symbol_captures) = self.callback_captures.get(&symbol) {
                captured.extend(symbol_captures);
            }
        }
        for member in references.members {
            if let Some(member_captures) = self.callback_property_captures.get(&member) {
                captured.extend(member_captures);
            }
        }
        captured.extend(
            self.reactive_references(argument)
                .into_iter()
                .filter(|symbol| self.hook_return_shapes.contains_key(symbol)),
        );
        captured
    }

    fn callback_timing(&self, expression: &Expression<'_>) -> Option<CallbackTiming> {
        let expression = expression.get_inner_expression();
        if let Some(path) = static_alias_source_path(self.scoping, expression) {
            let resolved = self.callback_aliases.resolve(&path);
            return self.callback_timings.get(&resolved).copied().flatten();
        }
        match expression {
            Expression::ArrowFunctionExpression(function) => Some(CallbackTiming {
                may_suspend: function.r#async,
                may_return_iterator: false,
            }),
            Expression::FunctionExpression(function) => Some(if function.generator {
                CallbackTiming {
                    may_suspend: false,
                    may_return_iterator: true,
                }
            } else {
                CallbackTiming {
                    may_suspend: function.r#async,
                    may_return_iterator: false,
                }
            }),
            Expression::ConditionalExpression(expression) => self
                .callback_timing(&expression.consequent)
                .zip(self.callback_timing(&expression.alternate))
                .map(|(left, right)| left.merge(right)),
            Expression::LogicalExpression(expression) => self
                .callback_timing(&expression.left)
                .zip(self.callback_timing(&expression.right))
                .map(|(left, right)| left.merge(right)),
            Expression::SequenceExpression(expression) => expression
                .expressions
                .last()
                .and_then(|value| self.callback_timing(value)),
            Expression::AssignmentExpression(expression) => self.callback_timing(&expression.right),
            _ => None,
        }
    }

    fn analyze_class_retained_expression(&mut self, expression: &Expression<'_>) {
        let root = expression.get_inner_expression();
        // Function-valued fields retain a callback rather than a state-derived value. They are
        // covered by the callback-capture analysis above and should keep its FICT-R005 contract.
        if matches!(
            root,
            Expression::FunctionExpression(_) | Expression::ArrowFunctionExpression(_)
        ) {
            return;
        }
        let argument = EscapeArgument {
            expression,
            span: source_span(root.span()),
            spread: false,
        };
        // Direct state roots are compiler-managed reads and are an established compatibility
        // contract for reactive class declarations (`extends Parent`, static fields, and
        // computed keys). Projections such as `rows.at(0)` expose nested shallow-state identity
        // and therefore still fail closed when the class retains them.
        if self.direct_class_state_symbol(root).is_some() {
            return;
        }
        if self.retained_reactive_references(expression).is_empty() {
            return;
        }
        // An instance or static field outlives the initializer evaluation. Without a structural
        // ownership proof, storing a state-derived projection there can later mutate shallow
        // state through an untracked receiver, so treat the storage itself as an escape boundary.
        self.diagnostics.push(EscapeDiagnosticFact {
            kind: EscapeDiagnosticKind::ReactiveValue,
            span: argument.span,
        });
    }

    fn direct_class_state_symbol(&self, expression: &Expression<'_>) -> Option<SymbolId> {
        let root = expression.get_inner_expression();
        if let Expression::SequenceExpression(sequence) = root {
            return sequence
                .expressions
                .last()
                .and_then(|expression| self.direct_class_state_symbol(expression));
        }
        self.direct_state_symbol(EscapeArgument {
            expression: root,
            span: source_span(root.span()),
            spread: false,
        })
    }

    fn emit_direct_state_warnings(&mut self, arguments: &[EscapeArgument<'_, '_>], allowed: bool) {
        if allowed {
            return;
        }
        let spans = arguments
            .iter()
            .filter(|argument| self.direct_state_symbol(**argument).is_some())
            .map(|argument| argument.span)
            .collect::<Vec<_>>();
        self.diagnostics
            .extend(spans.into_iter().map(|span| EscapeDiagnosticFact {
                kind: EscapeDiagnosticKind::StateSnapshot,
                span,
            }));
    }

    fn analyze_call<'node, 'ast>(
        &mut self,
        call: &'node CallExpression<'ast>,
        arguments: &[EscapeArgument<'node, 'ast>],
    ) {
        let Some(fact) = self.call_facts.get(&(call.span.start, call.span.end)) else {
            return;
        };
        let binding = fact.binding;
        let macro_kind = binding.and_then(|binding| self.macro_bindings.get(&binding).copied());
        let store = fact.reactive_kind == Some(ReactiveCallKind::Store);
        let local_hook = binding.is_some_and(|binding| self.local_hook_bindings.contains(&binding));
        let state_argument_import = binding
            .and_then(|binding| self.imports.get(&binding))
            .is_some_and(|import| {
                matches!(
                    import.imported.as_str(),
                    "render"
                        | "createEffect"
                        | "createMemo"
                        | "createSelector"
                        | "createRenderEffect"
                )
            });
        let state_arguments_allowed = store
            || local_hook
            || state_argument_import
            || fact.runtime_creation_kind == Some(RuntimeReactiveCreationKind::NamespaceMemo)
            || matches!(
                macro_kind,
                Some(FictMacroKind::Effect | FictMacroKind::Memo)
            );
        self.emit_direct_state_warnings(arguments, state_arguments_allowed);

        if store
            || macro_kind.is_some()
            || fact.runtime_creation_kind == Some(RuntimeReactiveCreationKind::NamespaceMemo)
            || is_safe_global_call(self.scoping, self.callback_aliases, &call.callee)
        {
            return;
        }
        if self.is_non_escaping_callback_host(&call.callee, binding, arguments) {
            return;
        }
        if self.is_non_escaping_hook_accumulator(&call.callee, arguments) {
            return;
        }

        let configured = fact.configured_reactive_scope;
        if !local_hook {
            for (index, argument) in arguments.iter().enumerate() {
                if (configured && index == 0)
                    || self.direct_state_symbol(*argument).is_some()
                    || self.is_non_retaining_identity_argument(&call.callee, index, *argument)
                    || self.is_non_escaping_string_replacer(
                        &call.callee,
                        index,
                        *argument,
                        arguments,
                    )
                {
                    continue;
                }
                if !self.reactive_references(*argument).is_empty() {
                    self.diagnostics.push(EscapeDiagnosticFact {
                        kind: EscapeDiagnosticKind::ReactiveValue,
                        span: argument.span,
                    });
                    break;
                }
            }
        }
        for (index, argument) in arguments.iter().enumerate() {
            if (configured && index == 0)
                || self.is_non_retaining_identity_argument(&call.callee, index, *argument)
                || self.is_non_escaping_string_replacer(&call.callee, index, *argument, arguments)
            {
                continue;
            }
            let captured = self.callback_captures(*argument);
            if captured.is_empty() {
                continue;
            }
            self.diagnostics.push(EscapeDiagnosticFact {
                kind: EscapeDiagnosticKind::CallbackCapture(captured),
                span: argument.span,
            });
            break;
        }
    }

    fn analyze_invocation(&mut self, arguments: &[EscapeArgument<'_, '_>]) {
        self.emit_direct_state_warnings(arguments, false);
        for argument in arguments {
            if self.direct_state_symbol(*argument).is_some() {
                continue;
            }
            if !self.reactive_references(*argument).is_empty() {
                self.diagnostics.push(EscapeDiagnosticFact {
                    kind: EscapeDiagnosticKind::ReactiveValue,
                    span: argument.span,
                });
                break;
            }
        }
    }

    fn builtin_method_is_intact(
        &self,
        receiver: &Expression<'_>,
        receiver_kind: StateReceiverKind,
        method: &str,
    ) -> bool {
        self.callback_aliases.receiver_method_is_intact(
            self.scoping,
            receiver,
            receiver_kind,
            method,
        ) && self.builtin_receiver_origin_is_intact(receiver, receiver_kind)
    }

    fn builtin_receiver_origin_is_intact(
        &self,
        expression: &Expression<'_>,
        expected: StateReceiverKind,
    ) -> bool {
        match expression.get_inner_expression() {
            Expression::NewExpression(expression) => {
                classify_global_state_constructor(self.scoping, &expression.callee) == expected
                    && static_alias_source_path(self.scoping, &expression.callee)
                        .is_some_and(|path| self.callback_aliases.path_is_intact(&path))
            }
            Expression::CallExpression(call) => {
                self.builtin_receiver_call_origin_is_intact(call, expected)
            }
            Expression::ChainExpression(chain) => match &chain.expression {
                ChainElement::CallExpression(call) => {
                    self.builtin_receiver_call_origin_is_intact(call, expected)
                }
                ChainElement::TSNonNullExpression(expression) => {
                    self.builtin_receiver_origin_is_intact(&expression.expression, expected)
                }
                ChainElement::ComputedMemberExpression(_)
                | ChainElement::PrivateFieldExpression(_)
                | ChainElement::StaticMemberExpression(_) => true,
            },
            Expression::ConditionalExpression(expression) => {
                self.builtin_receiver_origin_is_intact(&expression.consequent, expected)
                    && self.builtin_receiver_origin_is_intact(&expression.alternate, expected)
            }
            Expression::LogicalExpression(expression) => {
                self.builtin_receiver_origin_is_intact(&expression.left, expected)
                    && self.builtin_receiver_origin_is_intact(&expression.right, expected)
            }
            Expression::SequenceExpression(expression) => expression
                .expressions
                .last()
                .is_some_and(|value| self.builtin_receiver_origin_is_intact(value, expected)),
            Expression::AssignmentExpression(expression) => {
                self.builtin_receiver_origin_is_intact(&expression.right, expected)
            }
            _ => true,
        }
    }

    fn builtin_receiver_call_origin_is_intact(
        &self,
        call: &CallExpression<'_>,
        expected: StateReceiverKind,
    ) -> bool {
        if classify_global_state_factory_call(self.scoping, call) == expected
            || classify_global_state_constructor(self.scoping, &call.callee) == expected
        {
            return static_alias_source_path(self.scoping, &call.callee)
                .is_some_and(|path| self.callback_aliases.path_is_intact(&path));
        }
        let (receiver, method) = match call.callee.get_inner_expression() {
            Expression::StaticMemberExpression(member) => {
                (&member.object, member.property.name.as_str())
            }
            Expression::ComputedMemberExpression(member) => {
                let Expression::StringLiteral(property) = member.expression.get_inner_expression()
                else {
                    return false;
                };
                (&member.object, property.value.as_str())
            }
            _ => return false,
        };
        let receiver_kind =
            classify_state_receiver_assignment(self.scoping, receiver, self.proven_receivers);
        classify_state_method_result(receiver_kind, method) == expected
            && self.builtin_method_is_intact(receiver, receiver_kind, method)
    }

    fn is_non_escaping_callback_host(
        &self,
        callee: &Expression<'_>,
        binding: Option<BindingId>,
        arguments: &[EscapeArgument<'_, '_>],
    ) -> bool {
        if binding
            .and_then(|binding| self.imports.get(&binding))
            .is_some_and(|import| {
                matches!(
                    import.source.as_str(),
                    "fict" | "fict/advanced" | "@fictjs/runtime" | "@fictjs/runtime/advanced"
                ) && matches!(
                    import.imported.as_str(),
                    "untrack"
                        | "batch"
                        | "startTransition"
                        | "createEffect"
                        | "createMemo"
                        | "createRenderEffect"
                        | "runInScope"
                )
            })
        {
            return true;
        }

        let (receiver, method) = match unwrap_transparent_call_expression(callee) {
            Expression::StaticMemberExpression(member) => {
                (&member.object, member.property.name.as_str())
            }
            Expression::ComputedMemberExpression(member) => {
                let Expression::StringLiteral(property) = member.expression.get_inner_expression()
                else {
                    return false;
                };
                (&member.object, property.value.as_str())
            }
            _ => return false,
        };
        let mut receiver_kind =
            classify_state_receiver_assignment(self.scoping, receiver, self.proven_receivers);
        if receiver_kind == StateReceiverKind::Unknown && self.is_known_array_receiver(receiver) {
            receiver_kind = StateReceiverKind::Array;
        }
        if !self.builtin_method_is_intact(receiver, receiver_kind, method) {
            return false;
        }
        let disposition = match receiver_kind {
            StateReceiverKind::Array
                if matches!(method, "map" | "flatMap" | "reduce" | "reduceRight") =>
            {
                CallbackResultDisposition::Retained
            }
            StateReceiverKind::Array
                if matches!(
                    method,
                    "forEach"
                        | "filter"
                        | "some"
                        | "every"
                        | "find"
                        | "findIndex"
                        | "findLast"
                        | "findLastIndex"
                        | "sort"
                        | "toSorted"
                ) =>
            {
                CallbackResultDisposition::Discarded
            }
            StateReceiverKind::TypedArray if matches!(method, "reduce" | "reduceRight") => {
                CallbackResultDisposition::Retained
            }
            StateReceiverKind::TypedArray
                if matches!(
                    method,
                    "map"
                        | "forEach"
                        | "filter"
                        | "some"
                        | "every"
                        | "find"
                        | "findIndex"
                        | "findLast"
                        | "findLastIndex"
                        | "sort"
                        | "toSorted"
                ) =>
            {
                CallbackResultDisposition::Discarded
            }
            StateReceiverKind::Map | StateReceiverKind::Set if method == "forEach" => {
                CallbackResultDisposition::Discarded
            }
            StateReceiverKind::Unknown
            | StateReceiverKind::DataView
            | StateReceiverKind::Date
            | StateReceiverKind::Function
            | StateReceiverKind::Number
            | StateReceiverKind::Promise
            | StateReceiverKind::String
            | StateReceiverKind::WeakMap
            | StateReceiverKind::WeakSet
            | StateReceiverKind::Array
            | StateReceiverKind::TypedArray
            | StateReceiverKind::Map
            | StateReceiverKind::Set => return false,
        };
        let Some(callback) = arguments.first() else {
            return true;
        };
        if self.callback_captures(*callback).is_empty() {
            return true;
        }
        let Some(timing) = (!callback.spread)
            .then(|| self.callback_timing(callback.expression))
            .flatten()
        else {
            return false;
        };
        !timing.may_suspend
            && (disposition == CallbackResultDisposition::Discarded || !timing.may_return_iterator)
    }

    fn is_non_retaining_identity_argument(
        &self,
        callee: &Expression<'_>,
        index: usize,
        argument: EscapeArgument<'_, '_>,
    ) -> bool {
        if index != 0 || argument.spread {
            return false;
        }
        let (receiver, method) = match unwrap_transparent_call_expression(callee) {
            Expression::StaticMemberExpression(member) => {
                (&member.object, member.property.name.as_str())
            }
            Expression::ComputedMemberExpression(member) => {
                let Expression::StringLiteral(property) = member.expression.get_inner_expression()
                else {
                    return false;
                };
                (&member.object, property.value.as_str())
            }
            _ => return false,
        };
        let mut receiver_kind =
            classify_state_receiver_assignment(self.scoping, receiver, self.proven_receivers);
        if receiver_kind == StateReceiverKind::Unknown && self.is_known_array_receiver(receiver) {
            receiver_kind = StateReceiverKind::Array;
        }
        if !self.builtin_method_is_intact(receiver, receiver_kind, method) {
            return false;
        }
        matches!(
            (receiver_kind, method),
            (
                StateReceiverKind::Array | StateReceiverKind::TypedArray,
                "includes" | "indexOf" | "lastIndexOf"
            ) | (
                StateReceiverKind::Map | StateReceiverKind::WeakMap,
                "get" | "has"
            ) | (StateReceiverKind::Set | StateReceiverKind::WeakSet, "has")
        )
    }

    fn is_non_escaping_string_replacer(
        &self,
        callee: &Expression<'_>,
        index: usize,
        argument: EscapeArgument<'_, '_>,
        arguments: &[EscapeArgument<'_, '_>],
    ) -> bool {
        if index != 1 || argument.spread || self.callback_captures(argument).is_empty() {
            return false;
        }
        let Some(search) = arguments.first().filter(|search| !search.spread) else {
            return false;
        };
        let builtin_search_dispatch = match search.expression.get_inner_expression() {
            Expression::StringLiteral(_) | Expression::TemplateLiteral(_) => true,
            Expression::RegExpLiteral(_) => self.callback_aliases.path_is_intact(
                &StaticAliasPath::unresolved_global("RegExp".to_string())
                    .with_property("prototype".to_string()),
            ),
            _ => false,
        };
        if !builtin_search_dispatch {
            return false;
        }
        let (receiver, method) = match unwrap_transparent_call_expression(callee) {
            Expression::StaticMemberExpression(member) => {
                (&member.object, member.property.name.as_str())
            }
            Expression::ComputedMemberExpression(member) => {
                let Expression::StringLiteral(property) = member.expression.get_inner_expression()
                else {
                    return false;
                };
                (&member.object, property.value.as_str())
            }
            _ => return false,
        };
        if !matches!(method, "replace" | "replaceAll") {
            return false;
        }
        let receiver_kind =
            classify_state_receiver_assignment(self.scoping, receiver, self.proven_receivers);
        receiver_kind == StateReceiverKind::String
            && self.builtin_method_is_intact(receiver, receiver_kind, method)
            && self
                .callback_timing(argument.expression)
                .is_some_and(|timing| !timing.may_suspend)
    }

    fn is_non_escaping_hook_accumulator(
        &self,
        callee: &Expression<'_>,
        arguments: &[EscapeArgument<'_, '_>],
    ) -> bool {
        let (receiver, method) = match unwrap_transparent_call_expression(callee) {
            Expression::StaticMemberExpression(member)
                if is_mutating_array_method(member.property.name.as_str()) =>
            {
                (&member.object, member.property.name.as_str())
            }
            Expression::ComputedMemberExpression(member) => {
                let Expression::StringLiteral(property) = member.expression.get_inner_expression()
                else {
                    return false;
                };
                if !is_mutating_array_method(property.value.as_str()) {
                    return false;
                }
                (&member.object, property.value.as_str())
            }
            _ => return false,
        };
        if !self.is_known_array_receiver(receiver) {
            return false;
        }
        if !self.builtin_method_is_intact(receiver, StateReceiverKind::Array, method) {
            return false;
        }
        let mut found_hook_accessor = false;
        for argument in arguments {
            let references = self.reactive_references(*argument);
            if references
                .iter()
                .any(|symbol| !self.hook_return_shapes.contains_key(symbol))
            {
                return false;
            }
            found_hook_accessor |= !references.is_empty();
        }
        found_hook_accessor
    }

    fn is_known_array_receiver(&self, receiver: &Expression<'_>) -> bool {
        match receiver.get_inner_expression() {
            Expression::ArrayExpression(_) => true,
            Expression::Identifier(identifier) => identifier
                .reference_id
                .get()
                .and_then(|reference| self.scoping.get_reference(reference).symbol_id())
                .is_some_and(|symbol| self.known_arrays.contains(&symbol)),
            _ => false,
        }
    }
}

impl<'a> Visit<'a> for ReactiveEscapeCollector<'_, '_, '_> {
    fn visit_class(&mut self, class: &Class<'a>) {
        if let Some(super_class) = &class.super_class {
            self.analyze_class_retained_expression(super_class);
        }
        for element in &class.body.body {
            let initializer = match element {
                ClassElement::PropertyDefinition(property) => property.value.as_ref(),
                ClassElement::AccessorProperty(property) => property.value.as_ref(),
                ClassElement::StaticBlock(_)
                | ClassElement::MethodDefinition(_)
                | ClassElement::TSIndexSignature(_) => None,
            };
            if let Some(initializer) = initializer {
                self.analyze_class_retained_expression(initializer);
            }
        }
        oxc::ast_visit::walk::walk_class(self, class);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        let arguments = escape_arguments(&call.arguments);
        self.analyze_call(call, &arguments);
        walk_call_expression(self, call);
    }

    fn visit_new_expression(&mut self, expression: &NewExpression<'a>) {
        let arguments = escape_arguments(&expression.arguments);
        self.analyze_invocation(&arguments);
        oxc::ast_visit::walk::walk_new_expression(self, expression);
    }

    fn visit_tagged_template_expression(&mut self, expression: &TaggedTemplateExpression<'a>) {
        let arguments = expression
            .quasi
            .expressions
            .iter()
            .map(|expression| EscapeArgument {
                expression,
                span: source_span(expression.span()),
                spread: false,
            })
            .collect::<Vec<_>>();
        self.analyze_invocation(&arguments);
        oxc::ast_visit::walk::walk_tagged_template_expression(self, expression);
    }
}

fn escape_arguments<'node, 'ast>(
    arguments: &'node [oxc::ast::ast::Argument<'ast>],
) -> Vec<EscapeArgument<'node, 'ast>> {
    arguments
        .iter()
        .map(|argument| {
            if let Some(expression) = argument.as_expression() {
                EscapeArgument {
                    expression,
                    span: source_span(expression.span()),
                    spread: false,
                }
            } else if let oxc::ast::ast::Argument::SpreadElement(spread) = argument {
                EscapeArgument {
                    expression: &spread.argument,
                    span: source_span(spread.span),
                    spread: true,
                }
            } else {
                unreachable!("every invocation argument is an expression or spread")
            }
        })
        .collect()
}

struct ReactiveArgumentCollector<'semantic, 'reactive> {
    scoping: &'semantic Scoping,
    reactive_symbols: &'reactive BTreeSet<SymbolId>,
    hook_return_shapes: &'reactive BTreeMap<SymbolId, LocalHookReturnShape>,
    root_function: Option<(u32, u32)>,
    symbols: BTreeSet<SymbolId>,
}

impl<'a> Visit<'a> for ReactiveArgumentCollector<'_, '_> {
    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        if self.root_function == Some((function.span.start, function.span.end)) {
            walk_function(self, function, flags);
        }
    }

    fn visit_arrow_function_expression(&mut self, function: &ArrowFunctionExpression<'a>) {
        if self.root_function == Some((function.span.start, function.span.end)) {
            walk_arrow_function_expression(self, function);
        }
    }

    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        if let Some(symbol) = identifier
            .reference_id
            .get()
            .and_then(|reference| self.scoping.get_reference(reference).symbol_id())
            && (self.reactive_symbols.contains(&symbol)
                || self
                    .hook_return_shapes
                    .get(&symbol)
                    .is_some_and(|shape| shape.direct))
        {
            self.symbols.insert(symbol);
        }
    }

    fn visit_static_member_expression(
        &mut self,
        member: &oxc::ast::ast::StaticMemberExpression<'a>,
    ) {
        if let Expression::Identifier(identifier) = member.object.get_inner_expression()
            && let Some(symbol) = identifier
                .reference_id
                .get()
                .and_then(|reference| self.scoping.get_reference(reference).symbol_id())
            && self
                .hook_return_shapes
                .get(&symbol)
                .is_some_and(|shape| shape.members.contains(member.property.name.as_str()))
        {
            self.symbols.insert(symbol);
            return;
        }
        oxc::ast_visit::walk::walk_static_member_expression(self, member);
    }

    fn visit_computed_member_expression(&mut self, member: &ComputedMemberExpression<'a>) {
        let property = match member.expression.get_inner_expression() {
            Expression::StringLiteral(property) => Some(property.value.to_string()),
            Expression::NumericLiteral(property) => Some(property.value.to_string()),
            _ => None,
        };
        if let (Expression::Identifier(identifier), Some(property)) =
            (member.object.get_inner_expression(), property)
            && let Some(symbol) = identifier
                .reference_id
                .get()
                .and_then(|reference| self.scoping.get_reference(reference).symbol_id())
            && self
                .hook_return_shapes
                .get(&symbol)
                .is_some_and(|shape| shape.members.contains(&property))
        {
            self.symbols.insert(symbol);
            return;
        }
        oxc::ast_visit::walk::walk_computed_member_expression(self, member);
    }

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        if assignment.operator == OxcAssignmentOperator::Assign {
            // The value passed by a plain assignment expression is its RHS. Pattern identifiers
            // are write targets and therefore cannot make that value a reactive escape.
            self.visit_expression(&assignment.right);
        } else {
            oxc::ast_visit::walk::walk_assignment_expression(self, assignment);
        }
    }
}

struct RetainedReactiveIdentityCollector<'semantic, 'reactive> {
    scoping: &'semantic Scoping,
    reactive_symbols: &'reactive BTreeSet<SymbolId>,
    hook_return_shapes: &'reactive BTreeMap<SymbolId, LocalHookReturnShape>,
    symbols: BTreeSet<SymbolId>,
}

impl<'a> Visit<'a> for RetainedReactiveIdentityCollector<'_, '_> {
    fn visit_function(&mut self, _function: &Function<'a>, _flags: ScopeFlags) {}

    fn visit_arrow_function_expression(&mut self, _function: &ArrowFunctionExpression<'a>) {}

    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        if let Some(symbol) = identifier
            .reference_id
            .get()
            .and_then(|reference| self.scoping.get_reference(reference).symbol_id())
            && (self.reactive_symbols.contains(&symbol)
                || self
                    .hook_return_shapes
                    .get(&symbol)
                    .is_some_and(|shape| shape.direct))
        {
            self.symbols.insert(symbol);
        }
    }

    fn visit_static_member_expression(
        &mut self,
        member: &oxc::ast::ast::StaticMemberExpression<'a>,
    ) {
        if let Expression::Identifier(identifier) = member.object.get_inner_expression()
            && let Some(symbol) = identifier
                .reference_id
                .get()
                .and_then(|reference| self.scoping.get_reference(reference).symbol_id())
            && self
                .hook_return_shapes
                .get(&symbol)
                .is_some_and(|shape| shape.members.contains(member.property.name.as_str()))
        {
            self.symbols.insert(symbol);
            return;
        }
        self.visit_expression(&member.object);
    }

    fn visit_computed_member_expression(&mut self, member: &ComputedMemberExpression<'a>) {
        let property = match member.expression.get_inner_expression() {
            Expression::StringLiteral(property) => Some(property.value.to_string()),
            Expression::NumericLiteral(property) => Some(property.value.to_string()),
            _ => None,
        };
        if let (Expression::Identifier(identifier), Some(property)) =
            (member.object.get_inner_expression(), property)
            && let Some(symbol) = identifier
                .reference_id
                .get()
                .and_then(|reference| self.scoping.get_reference(reference).symbol_id())
            && self
                .hook_return_shapes
                .get(&symbol)
                .is_some_and(|shape| shape.members.contains(&property))
        {
            self.symbols.insert(symbol);
            return;
        }
        // The property chooses a slot but is not itself retained as the member value.
        self.visit_expression(&member.object);
    }

    fn visit_conditional_expression(
        &mut self,
        expression: &oxc::ast::ast::ConditionalExpression<'a>,
    ) {
        // The test controls identity selection but cannot become the selected value.
        self.visit_expression(&expression.consequent);
        self.visit_expression(&expression.alternate);
    }

    fn visit_binary_expression(&mut self, _expression: &oxc::ast::ast::BinaryExpression<'a>) {}

    fn visit_unary_expression(&mut self, _expression: &oxc::ast::ast::UnaryExpression<'a>) {}

    fn visit_template_literal(&mut self, _literal: &TemplateLiteral<'a>) {}

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        if assignment.operator == OxcAssignmentOperator::Assign {
            self.visit_expression(&assignment.right);
        } else {
            oxc::ast_visit::walk::walk_assignment_expression(self, assignment);
        }
    }

    fn visit_sequence_expression(&mut self, expression: &oxc::ast::ast::SequenceExpression<'a>) {
        // Only the tail becomes the sequence result. Earlier expressions still receive their
        // own call/write diagnostics while their values are discarded rather than retained by
        // the surrounding class base or field.
        if let Some(value) = expression.expressions.last() {
            self.visit_expression(value);
        }
    }
}

fn is_safe_global_call(
    scoping: &Scoping,
    aliases: &StaticHookAliases,
    callee: &Expression<'_>,
) -> bool {
    let unresolved = |identifier: &IdentifierReference<'_>| {
        identifier
            .reference_id
            .get()
            .is_some_and(|reference| scoping.get_reference(reference).symbol_id().is_none())
    };
    let safe = match unwrap_transparent_call_expression(callee) {
        Expression::Identifier(identifier) => {
            unresolved(identifier)
                && matches!(
                    identifier.name.as_str(),
                    "String"
                        | "Number"
                        | "Boolean"
                        | "parseInt"
                        | "parseFloat"
                        | "isNaN"
                        | "isFinite"
                        | "typeof"
                )
        }
        Expression::StaticMemberExpression(member) => {
            let Expression::Identifier(root) = member.object.get_inner_expression() else {
                return false;
            };
            if !unresolved(root) {
                return false;
            }
            matches!(
                (root.name.as_str(), member.property.name.as_str()),
                (
                    "console",
                    "log" | "info" | "warn" | "error" | "debug" | "trace" | "dir" | "table"
                ) | ("JSON", "stringify" | "parse")
                    | (
                        "Object",
                        "keys"
                            | "values"
                            | "entries"
                            | "isFrozen"
                            | "isSealed"
                            | "isExtensible"
                            | "getOwnPropertyNames"
                            | "getOwnPropertyDescriptor"
                            | "getPrototypeOf"
                    )
                    | ("Array", "isArray" | "from" | "of")
                    | (
                        "Math",
                        "abs"
                            | "ceil"
                            | "floor"
                            | "round"
                            | "max"
                            | "min"
                            | "pow"
                            | "sqrt"
                            | "random"
                            | "sin"
                            | "cos"
                            | "tan"
                            | "log"
                            | "exp"
                            | "sign"
                            | "trunc"
                    )
                    | ("Date", "now" | "parse")
            )
        }
        _ => false,
    };
    safe
        && static_alias_source_path(scoping, callee)
            .is_some_and(|path| aliases.path_is_intact(&path))
}

struct DynamicReactivePropertyCollector<'semantic, 'reactive> {
    scoping: &'semantic Scoping,
    reactive_symbols: &'reactive BTreeSet<SymbolId>,
    spans: BTreeSet<(u32, u32)>,
}

impl<'a> Visit<'a> for DynamicReactivePropertyCollector<'_, '_> {
    fn visit_computed_member_expression(&mut self, member: &ComputedMemberExpression<'a>) {
        let mut property = &member.expression;
        while let Expression::ParenthesizedExpression(parenthesized) = property {
            property = &parenthesized.expression;
        }
        let literal_property = matches!(
            property,
            Expression::StringLiteral(_) | Expression::NumericLiteral(_)
        );
        if !literal_property
            && expression_root_symbol(self.scoping, &member.object)
                .is_some_and(|symbol| self.reactive_symbols.contains(&symbol))
        {
            self.spans.insert((member.span.start, member.span.end));
        }
        oxc::ast_visit::walk::walk_computed_member_expression(self, member);
    }
}

impl<'a> Visit<'a> for MutationCollector<'_> {
    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        if assignment.operator == OxcAssignmentOperator::Assign
            && matches!(
                assignment.left,
                AssignmentTarget::ArrayAssignmentTarget(_)
                    | AssignmentTarget::ObjectAssignmentTarget(_)
            )
        {
            let mut targets = Vec::new();
            let mut projected_targets = Vec::new();
            collect_pattern_assignment_targets(
                self.scoping,
                &assignment.left,
                &mut targets,
                &mut projected_targets,
            );
            let mut syntax = AssignmentPatternSyntaxCollector::default();
            syntax.visit_assignment_target(&assignment.left);
            let right = assignment.right.get_inner_expression();
            self.pattern_assignments.push(PatternAssignmentFact {
                span: source_span(assignment.span),
                pattern_span: source_span(assignment.left.span()),
                value_span: source_span(right.span()),
                value_has_effects: structured_control_flow::expression_has_effects(
                    &assignment.right,
                ),
                targets,
                projected_targets,
                has_defaults: syntax.has_defaults,
                has_rest: syntax.has_rest,
                contains_await: syntax.contains_await,
                contains_yield: syntax.contains_yield,
                contains_jsx: syntax.contains_jsx,
            });
        }
        let place = planned_assignment_target_place(self.scoping, &assignment.left);
        let identity = assignment_target_symbol(self.scoping, &assignment.left);
        let symbol = identity.map(|(symbol, _)| symbol).or_else(|| {
            match place.as_ref().map(|place| &place.base) {
                Some(PlannedPlaceBase::Binding(symbol)) => Some(*symbol),
                Some(
                    PlannedPlaceBase::UnresolvedGlobal { .. }
                    | PlannedPlaceBase::Context { .. }
                    | PlannedPlaceBase::Expression { .. },
                )
                | None => None,
            }
        });
        let projected = identity.is_some_and(|(_, projected)| projected)
            || place
                .as_ref()
                .is_some_and(|place| !place.projections.is_empty());
        if symbol.is_some() || place.is_some() {
            let target_span = source_span(assignment.left.span());
            let right = assignment.right.get_inner_expression();
            let kind = if assignment.operator == OxcAssignmentOperator::Assign {
                Some(ReactiveMutationKind::Write {
                    value_span: source_span(right.span()),
                    value_has_effects: structured_control_flow::expression_has_effects(
                        &assignment.right,
                    ),
                })
            } else {
                compound_assignment_operator(assignment.operator).map(|operator| {
                    ReactiveMutationKind::Compound {
                        operator,
                        value_span: source_span(right.span()),
                        value_has_effects: structured_control_flow::expression_has_effects(
                            &assignment.right,
                        ),
                    }
                })
            };
            if let Some(kind) = kind {
                self.facts.push(MutationFact {
                    symbol,
                    projected,
                    target_span,
                    place,
                    span: source_span(assignment.span),
                    kind,
                });
            }
        }
        oxc::ast_visit::walk::walk_assignment_expression(self, assignment);
    }

    fn visit_update_expression(&mut self, update: &UpdateExpression<'a>) {
        let place = planned_simple_assignment_target_place(self.scoping, &update.argument);
        let identity = simple_assignment_target_symbol(self.scoping, &update.argument);
        let symbol = identity.map(|(symbol, _)| symbol).or_else(|| {
            match place.as_ref().map(|place| &place.base) {
                Some(PlannedPlaceBase::Binding(symbol)) => Some(*symbol),
                Some(
                    PlannedPlaceBase::UnresolvedGlobal { .. }
                    | PlannedPlaceBase::Context { .. }
                    | PlannedPlaceBase::Expression { .. },
                )
                | None => None,
            }
        });
        let projected = identity.is_some_and(|(_, projected)| projected)
            || place
                .as_ref()
                .is_some_and(|place| !place.projections.is_empty());
        if symbol.is_some() || place.is_some() {
            let target_span = source_span(update.argument.span());
            self.facts.push(MutationFact {
                symbol,
                projected,
                target_span,
                place,
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

fn collect_pattern_assignment_targets(
    scoping: &Scoping,
    target: &AssignmentTarget<'_>,
    targets: &mut Vec<PatternAssignmentTargetFact>,
    projected_targets: &mut Vec<PatternProjectedTargetFact>,
) {
    if let Some(identifier) = direct_assignment_target_identifier(target) {
        if let Some(symbol) = identifier_symbol(scoping, identifier) {
            targets.push(PatternAssignmentTargetFact {
                symbol,
                span: source_span(identifier.span),
            });
        }
        return;
    }
    match target {
        AssignmentTarget::ArrayAssignmentTarget(array) => {
            collect_array_assignment_targets(scoping, array, targets, projected_targets);
        }
        AssignmentTarget::ObjectAssignmentTarget(object) => {
            collect_object_assignment_targets(scoping, object, targets, projected_targets);
        }
        AssignmentTarget::StaticMemberExpression(_)
        | AssignmentTarget::ComputedMemberExpression(_)
        | AssignmentTarget::TSAsExpression(_)
        | AssignmentTarget::TSSatisfiesExpression(_)
        | AssignmentTarget::TSNonNullExpression(_)
        | AssignmentTarget::TSTypeAssertion(_) => {
            if let Some(place) = planned_assignment_target_place(scoping, target) {
                projected_targets.push(PatternProjectedTargetFact {
                    place,
                    span: source_span(target.span()),
                });
            }
        }
        AssignmentTarget::PrivateFieldExpression(_)
        | AssignmentTarget::AssignmentTargetIdentifier(_) => {}
    }
}

fn direct_assignment_target_identifier<'a, 'target>(
    target: &'target AssignmentTarget<'a>,
) -> Option<&'target IdentifierReference<'a>> {
    match target {
        AssignmentTarget::AssignmentTargetIdentifier(identifier) => Some(identifier),
        AssignmentTarget::TSAsExpression(expression) => {
            direct_expression_identifier(&expression.expression)
        }
        AssignmentTarget::TSSatisfiesExpression(expression) => {
            direct_expression_identifier(&expression.expression)
        }
        AssignmentTarget::TSNonNullExpression(expression) => {
            direct_expression_identifier(&expression.expression)
        }
        AssignmentTarget::TSTypeAssertion(expression) => {
            direct_expression_identifier(&expression.expression)
        }
        AssignmentTarget::ComputedMemberExpression(_)
        | AssignmentTarget::StaticMemberExpression(_)
        | AssignmentTarget::PrivateFieldExpression(_)
        | AssignmentTarget::ArrayAssignmentTarget(_)
        | AssignmentTarget::ObjectAssignmentTarget(_) => None,
    }
}

fn direct_expression_identifier<'a, 'expression>(
    expression: &'expression Expression<'a>,
) -> Option<&'expression IdentifierReference<'a>> {
    match expression.get_inner_expression() {
        Expression::Identifier(identifier) => Some(identifier),
        _ => None,
    }
}

fn collect_array_assignment_targets(
    scoping: &Scoping,
    array: &ArrayAssignmentTarget<'_>,
    targets: &mut Vec<PatternAssignmentTargetFact>,
    projected_targets: &mut Vec<PatternProjectedTargetFact>,
) {
    for element in array.elements.iter().flatten() {
        collect_maybe_default_assignment_targets(scoping, element, targets, projected_targets);
    }
    if let Some(rest) = &array.rest {
        collect_pattern_assignment_targets(scoping, &rest.target, targets, projected_targets);
    }
}

fn collect_object_assignment_targets(
    scoping: &Scoping,
    object: &ObjectAssignmentTarget<'_>,
    targets: &mut Vec<PatternAssignmentTargetFact>,
    projected_targets: &mut Vec<PatternProjectedTargetFact>,
) {
    for property in &object.properties {
        match property {
            AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(property) => {
                if let Some(symbol) = identifier_symbol(scoping, &property.binding) {
                    targets.push(PatternAssignmentTargetFact {
                        symbol,
                        span: source_span(property.binding.span),
                    });
                }
            }
            AssignmentTargetProperty::AssignmentTargetPropertyProperty(property) => {
                collect_maybe_default_assignment_targets(
                    scoping,
                    &property.binding,
                    targets,
                    projected_targets,
                );
            }
        }
    }
    if let Some(rest) = &object.rest {
        collect_pattern_assignment_targets(scoping, &rest.target, targets, projected_targets);
    }
}

fn collect_maybe_default_assignment_targets(
    scoping: &Scoping,
    target: &AssignmentTargetMaybeDefault<'_>,
    targets: &mut Vec<PatternAssignmentTargetFact>,
    projected_targets: &mut Vec<PatternProjectedTargetFact>,
) {
    match target {
        AssignmentTargetMaybeDefault::AssignmentTargetWithDefault(target) => {
            collect_pattern_assignment_targets(
                scoping,
                &target.binding,
                targets,
                projected_targets,
            );
        }
        AssignmentTargetMaybeDefault::AssignmentTargetIdentifier(identifier) => {
            if let Some(symbol) = identifier_symbol(scoping, identifier) {
                targets.push(PatternAssignmentTargetFact {
                    symbol,
                    span: source_span(identifier.span),
                });
            }
        }
        AssignmentTargetMaybeDefault::ArrayAssignmentTarget(array) => {
            collect_array_assignment_targets(scoping, array, targets, projected_targets);
        }
        AssignmentTargetMaybeDefault::ObjectAssignmentTarget(object) => {
            collect_object_assignment_targets(scoping, object, targets, projected_targets);
        }
        AssignmentTargetMaybeDefault::StaticMemberExpression(member) => {
            if let Some(place) = planned_static_member_place(scoping, member) {
                projected_targets.push(PatternProjectedTargetFact {
                    place,
                    span: source_span(member.span),
                });
            }
        }
        AssignmentTargetMaybeDefault::ComputedMemberExpression(member) => {
            if let Some(place) = planned_computed_member_place(scoping, member) {
                projected_targets.push(PatternProjectedTargetFact {
                    place,
                    span: source_span(member.span),
                });
            }
        }
        AssignmentTargetMaybeDefault::TSAsExpression(expression) => {
            collect_wrapped_pattern_target(
                scoping,
                &expression.expression,
                targets,
                projected_targets,
            );
        }
        AssignmentTargetMaybeDefault::TSSatisfiesExpression(expression) => {
            collect_wrapped_pattern_target(
                scoping,
                &expression.expression,
                targets,
                projected_targets,
            );
        }
        AssignmentTargetMaybeDefault::TSNonNullExpression(expression) => {
            collect_wrapped_pattern_target(
                scoping,
                &expression.expression,
                targets,
                projected_targets,
            );
        }
        AssignmentTargetMaybeDefault::TSTypeAssertion(expression) => {
            collect_wrapped_pattern_target(
                scoping,
                &expression.expression,
                targets,
                projected_targets,
            );
        }
        AssignmentTargetMaybeDefault::PrivateFieldExpression(_) => {}
    }
}

fn collect_wrapped_pattern_target(
    scoping: &Scoping,
    expression: &Expression<'_>,
    targets: &mut Vec<PatternAssignmentTargetFact>,
    projected_targets: &mut Vec<PatternProjectedTargetFact>,
) {
    if let Some(identifier) = direct_expression_identifier(expression) {
        if let Some(symbol) = identifier_symbol(scoping, identifier) {
            targets.push(PatternAssignmentTargetFact {
                symbol,
                span: source_span(identifier.span),
            });
        }
    } else if let Some(place) = planned_expression_place(scoping, expression) {
        projected_targets.push(PatternProjectedTargetFact {
            place,
            span: source_span(expression.span()),
        });
    }
}

fn assignment_target_symbol(
    scoping: &Scoping,
    target: &AssignmentTarget<'_>,
) -> Option<(SymbolId, bool)> {
    match target {
        AssignmentTarget::AssignmentTargetIdentifier(identifier) => {
            identifier_symbol(scoping, identifier).map(|symbol| (symbol, false))
        }
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

fn planned_assignment_target_place(
    scoping: &Scoping,
    target: &AssignmentTarget<'_>,
) -> Option<PlannedPlace> {
    match target {
        AssignmentTarget::AssignmentTargetIdentifier(identifier) => {
            planned_reference_identifier_place(scoping, identifier)
        }
        AssignmentTarget::StaticMemberExpression(member) => {
            planned_static_member_place(scoping, member)
        }
        AssignmentTarget::ComputedMemberExpression(member) => {
            planned_computed_member_place(scoping, member)
        }
        AssignmentTarget::TSAsExpression(expression) => {
            planned_expression_place(scoping, &expression.expression)
        }
        AssignmentTarget::TSSatisfiesExpression(expression) => {
            planned_expression_place(scoping, &expression.expression)
        }
        AssignmentTarget::TSNonNullExpression(expression) => {
            planned_expression_place(scoping, &expression.expression)
        }
        AssignmentTarget::TSTypeAssertion(expression) => {
            planned_expression_place(scoping, &expression.expression)
        }
        AssignmentTarget::PrivateFieldExpression(_)
        | AssignmentTarget::ArrayAssignmentTarget(_)
        | AssignmentTarget::ObjectAssignmentTarget(_) => None,
    }
}

fn simple_assignment_target_symbol(
    scoping: &Scoping,
    target: &SimpleAssignmentTarget<'_>,
) -> Option<(SymbolId, bool)> {
    match target {
        SimpleAssignmentTarget::AssignmentTargetIdentifier(identifier) => {
            identifier_symbol(scoping, identifier).map(|symbol| (symbol, false))
        }
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

fn planned_simple_assignment_target_place(
    scoping: &Scoping,
    target: &SimpleAssignmentTarget<'_>,
) -> Option<PlannedPlace> {
    match target {
        SimpleAssignmentTarget::AssignmentTargetIdentifier(identifier) => {
            planned_reference_identifier_place(scoping, identifier)
        }
        SimpleAssignmentTarget::StaticMemberExpression(member) => {
            planned_static_member_place(scoping, member)
        }
        SimpleAssignmentTarget::ComputedMemberExpression(member) => {
            planned_computed_member_place(scoping, member)
        }
        SimpleAssignmentTarget::TSAsExpression(expression) => {
            planned_expression_place(scoping, &expression.expression)
        }
        SimpleAssignmentTarget::TSSatisfiesExpression(expression) => {
            planned_expression_place(scoping, &expression.expression)
        }
        SimpleAssignmentTarget::TSNonNullExpression(expression) => {
            planned_expression_place(scoping, &expression.expression)
        }
        SimpleAssignmentTarget::TSTypeAssertion(expression) => {
            planned_expression_place(scoping, &expression.expression)
        }
        SimpleAssignmentTarget::PrivateFieldExpression(_) => None,
    }
}

fn planned_identifier_place(
    scoping: &Scoping,
    identifier: &IdentifierReference<'_>,
) -> Option<PlannedPlace> {
    let symbol = identifier_symbol(scoping, identifier)?;
    Some(PlannedPlace {
        base: PlannedPlaceBase::Binding(symbol),
        projections: Vec::new(),
        root_reference_span: Some(source_span(identifier.span)),
    })
}

fn planned_reference_identifier_place(
    scoping: &Scoping,
    identifier: &IdentifierReference<'_>,
) -> Option<PlannedPlace> {
    if let Some(place) = planned_identifier_place(scoping, identifier) {
        return Some(place);
    }
    let reference = scoping.get_reference(identifier.reference_id.get()?);
    if reference_is_inside_with(scoping, reference.scope_id()) {
        return None;
    }
    Some(PlannedPlace {
        base: PlannedPlaceBase::UnresolvedGlobal {
            name: identifier.name.to_string(),
            span: source_span(identifier.span),
        },
        projections: Vec::new(),
        root_reference_span: Some(source_span(identifier.span)),
    })
}

fn planned_static_member_place(
    scoping: &Scoping,
    member: &oxc::ast::ast::StaticMemberExpression<'_>,
) -> Option<PlannedPlace> {
    let mut place = planned_expression_place(scoping, &member.object)?;
    place.projections.push(PlannedProjection::Static {
        name: member.property.name.to_string(),
        optional: member.optional,
    });
    Some(place)
}

fn planned_computed_member_place(
    scoping: &Scoping,
    member: &ComputedMemberExpression<'_>,
) -> Option<PlannedPlace> {
    let mut place = planned_expression_place(scoping, &member.object)?;
    let deferred = member.optional
        || place.projections.iter().any(|projection| match projection {
            PlannedProjection::Static { optional, .. }
            | PlannedProjection::Computed { optional, .. }
            | PlannedProjection::Index { optional, .. } => *optional,
        });
    let projection = match member.expression.get_inner_expression() {
        Expression::StringLiteral(property) => PlannedProjection::Static {
            name: property.value.to_string(),
            optional: member.optional,
        },
        Expression::NumericLiteral(property)
            if property.value.is_finite()
                && property.value >= 0.0
                && property.value <= f64::from(u32::MAX)
                && property.value.fract() == 0.0 =>
        {
            PlannedProjection::Index {
                index: property.value as u32,
                optional: member.optional,
            }
        }
        expression => PlannedProjection::Computed {
            key: source_span(expression.span()),
            optional: member.optional,
            has_effects: structured_control_flow::expression_has_effects(expression),
            deferred,
        },
    };
    place.projections.push(projection);
    Some(place)
}

fn planned_invocation_reference(
    scoping: &Scoping,
    expression: &Expression<'_>,
) -> Option<PlannedPlace> {
    let place = planned_expression_place(scoping, expression)?;
    (!place.projections.is_empty()).then_some(place)
}

fn static_alias_path_from_place(
    place: &PlannedPlace,
    allow_optional: bool,
) -> Option<StaticAliasPath> {
    let root = match &place.base {
        PlannedPlaceBase::Binding(root) => StaticAliasRoot::Binding(*root),
        PlannedPlaceBase::UnresolvedGlobal { name, .. } => {
            StaticAliasRoot::UnresolvedGlobal(name.clone())
        }
        PlannedPlaceBase::Context { .. } | PlannedPlaceBase::Expression { .. } => return None,
    };
    let properties = place
        .projections
        .iter()
        .map(|projection| match projection {
            PlannedProjection::Static { name, optional } => {
                (allow_optional || !optional).then(|| name.clone())
            }
            PlannedProjection::Index { index, optional } => {
                (allow_optional || !optional).then(|| index.to_string())
            }
            PlannedProjection::Computed { .. } => None,
        })
        .collect::<Option<Vec<_>>>()?;
    Some(StaticAliasPath { root, properties })
}

fn static_alias_source_path(
    scoping: &Scoping,
    expression: &Expression<'_>,
) -> Option<StaticAliasPath> {
    let expression = unwrap_transparent_call_expression(expression);
    let place = planned_expression_place(scoping, expression)?;
    static_alias_path_from_place(&place, false)
}

fn static_alias_invalidation_path(place: &PlannedPlace) -> Option<StaticAliasPath> {
    let root = match &place.base {
        PlannedPlaceBase::Binding(root) => StaticAliasRoot::Binding(*root),
        PlannedPlaceBase::UnresolvedGlobal { name, .. } => {
            StaticAliasRoot::UnresolvedGlobal(name.clone())
        }
        PlannedPlaceBase::Context { .. } | PlannedPlaceBase::Expression { .. } => return None,
    };
    let mut path = StaticAliasPath {
        root,
        properties: Vec::new(),
    };
    for projection in &place.projections {
        match projection {
            PlannedProjection::Static { name, .. } => path.properties.push(name.clone()),
            PlannedProjection::Index { index, .. } => path.properties.push(index.to_string()),
            PlannedProjection::Computed { .. } => break,
        }
    }
    Some(path)
}

fn resolved_imported_hook_member_binding(
    place: &PlannedPlace,
    symbol_to_binding: &BTreeMap<SymbolId, BindingId>,
    imported_hook_member_paths: &BTreeMap<BindingId, BTreeSet<Vec<String>>>,
) -> Option<BindingId> {
    let PlannedPlaceBase::Binding(symbol) = place.base else {
        return None;
    };
    let binding = symbol_to_binding.get(&symbol).copied()?;
    let members = imported_hook_member_paths.get(&binding)?;
    let path: Option<Vec<_>> = place
        .projections
        .iter()
        .map(|projection| match projection {
            PlannedProjection::Static { name, .. } => Some(name.clone()),
            PlannedProjection::Index { index, .. } => Some(index.to_string()),
            PlannedProjection::Computed { .. } => None,
        })
        .collect();
    members.contains(&path?).then_some(binding)
}

fn planned_expression_place(
    scoping: &Scoping,
    expression: &Expression<'_>,
) -> Option<PlannedPlace> {
    match expression.get_inner_expression() {
        Expression::Identifier(identifier)
            if is_context_arguments_reference(scoping, identifier) =>
        {
            Some(PlannedPlace {
                base: PlannedPlaceBase::Context {
                    kind: ContextValueKind::Arguments,
                    span: source_span(identifier.span),
                },
                projections: Vec::new(),
                root_reference_span: Some(source_span(identifier.span)),
            })
        }
        Expression::Identifier(identifier) => {
            planned_reference_identifier_place(scoping, identifier)
                .or_else(|| Some(planned_expression_base(expression)))
        }
        Expression::StaticMemberExpression(member) => planned_static_member_place(scoping, member),
        Expression::ComputedMemberExpression(member) => {
            planned_computed_member_place(scoping, member)
        }
        Expression::PrivateFieldExpression(_) => None,
        Expression::Super(_) => None,
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::StaticMemberExpression(member) => {
                planned_static_member_place(scoping, member)
            }
            ChainElement::ComputedMemberExpression(member) => {
                planned_computed_member_place(scoping, member)
            }
            ChainElement::PrivateFieldExpression(_) => None,
            ChainElement::CallExpression(_) | ChainElement::TSNonNullExpression(_) => {
                Some(planned_expression_base(expression))
            }
        },
        _ => Some(planned_expression_base(expression)),
    }
}

fn planned_expression_base(expression: &Expression<'_>) -> PlannedPlace {
    PlannedPlace {
        base: PlannedPlaceBase::Expression {
            span: source_span(expression.span()),
            has_effects: structured_control_flow::expression_has_effects(expression),
        },
        projections: Vec::new(),
        root_reference_span: None,
    }
}

fn expression_root_symbol(scoping: &Scoping, expression: &Expression<'_>) -> Option<SymbolId> {
    match unwrap_transparent_call_expression(expression) {
        Expression::Identifier(identifier) => identifier_symbol(scoping, identifier),
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

fn identifier_symbol(scoping: &Scoping, identifier: &IdentifierReference<'_>) -> Option<SymbolId> {
    let reference = scoping.get_reference(identifier.reference_id.get()?);
    (!reference_is_inside_with(scoping, reference.scope_id()))
        .then(|| reference.symbol_id())
        .flatten()
}

fn is_context_arguments_reference(scoping: &Scoping, identifier: &IdentifierReference<'_>) -> bool {
    if identifier.name != "arguments" {
        return false;
    }
    let Some(reference) = identifier.reference_id.get() else {
        return false;
    };
    let reference = scoping.get_reference(reference);
    reference.symbol_id().is_none()
        && !reference_is_inside_with(scoping, reference.scope_id())
        && reference_is_inside_function(scoping, reference.scope_id())
}

fn reference_is_inside_function(scoping: &Scoping, mut scope: OxcScopeId) -> bool {
    loop {
        if scoping.scope_flags(scope).is_function() {
            return true;
        }
        let Some(parent) = scoping.scope_parent_id(scope) else {
            return false;
        };
        scope = parent;
    }
}

fn is_unresolved_typeof(
    scoping: &Scoping,
    expression: &oxc::ast::ast::UnaryExpression<'_>,
) -> bool {
    if expression.operator != OxcUnaryOperator::Typeof {
        return false;
    }
    let Expression::Identifier(identifier) = expression.argument.get_inner_expression() else {
        return false;
    };
    let Some(reference) = identifier.reference_id.get() else {
        return false;
    };
    let reference = scoping.get_reference(reference);
    reference.symbol_id().is_none() && !reference_is_inside_with(scoping, reference.scope_id())
}

fn unary_operator(operator: OxcUnaryOperator) -> UnaryOperator {
    match operator {
        OxcUnaryOperator::UnaryPlus => UnaryOperator::Plus,
        OxcUnaryOperator::UnaryNegation => UnaryOperator::Minus,
        OxcUnaryOperator::LogicalNot => UnaryOperator::Not,
        OxcUnaryOperator::BitwiseNot => UnaryOperator::BitNot,
        OxcUnaryOperator::Typeof => UnaryOperator::TypeOf,
        OxcUnaryOperator::Void => UnaryOperator::Void,
        OxcUnaryOperator::Delete => {
            unreachable!("delete is materialized as a reference-aware HIR instruction")
        }
    }
}

fn binary_operator(operator: OxcBinaryOperator) -> BinaryOperator {
    match operator {
        OxcBinaryOperator::Addition => BinaryOperator::Add,
        OxcBinaryOperator::Subtraction => BinaryOperator::Subtract,
        OxcBinaryOperator::Multiplication => BinaryOperator::Multiply,
        OxcBinaryOperator::Division => BinaryOperator::Divide,
        OxcBinaryOperator::Remainder => BinaryOperator::Remainder,
        OxcBinaryOperator::Exponential => BinaryOperator::Exponent,
        OxcBinaryOperator::Equality => BinaryOperator::Equal,
        OxcBinaryOperator::Inequality => BinaryOperator::NotEqual,
        OxcBinaryOperator::StrictEquality => BinaryOperator::StrictEqual,
        OxcBinaryOperator::StrictInequality => BinaryOperator::StrictNotEqual,
        OxcBinaryOperator::LessThan => BinaryOperator::LessThan,
        OxcBinaryOperator::LessEqualThan => BinaryOperator::LessThanOrEqual,
        OxcBinaryOperator::GreaterThan => BinaryOperator::GreaterThan,
        OxcBinaryOperator::GreaterEqualThan => BinaryOperator::GreaterThanOrEqual,
        OxcBinaryOperator::ShiftLeft => BinaryOperator::ShiftLeft,
        OxcBinaryOperator::ShiftRight => BinaryOperator::ShiftRight,
        OxcBinaryOperator::ShiftRightZeroFill => BinaryOperator::ShiftRightUnsigned,
        OxcBinaryOperator::BitwiseOR => BinaryOperator::BitOr,
        OxcBinaryOperator::BitwiseXOR => BinaryOperator::BitXor,
        OxcBinaryOperator::BitwiseAnd => BinaryOperator::BitAnd,
        OxcBinaryOperator::In => BinaryOperator::In,
        OxcBinaryOperator::Instanceof => BinaryOperator::InstanceOf,
    }
}

fn logical_operator(operator: OxcLogicalOperator) -> BinaryOperator {
    match operator {
        OxcLogicalOperator::And => BinaryOperator::LogicalAnd,
        OxcLogicalOperator::Or => BinaryOperator::LogicalOr,
        OxcLogicalOperator::Coalesce => BinaryOperator::NullishCoalescing,
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

fn classify_state_receiver_expression(
    scoping: &Scoping,
    expression: &Expression<'_>,
) -> StateReceiverKind {
    match expression.get_inner_expression() {
        Expression::ArrayExpression(_) => StateReceiverKind::Array,
        Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => {
            StateReceiverKind::Function
        }
        Expression::StringLiteral(_) | Expression::TemplateLiteral(_) => StateReceiverKind::String,
        Expression::NumericLiteral(_) | Expression::BigIntLiteral(_) => StateReceiverKind::Number,
        Expression::NewExpression(expression) => {
            classify_global_state_constructor(scoping, &expression.callee)
        }
        Expression::CallExpression(expression) => {
            let factory_receiver = classify_global_state_factory_call(scoping, expression);
            if factory_receiver != StateReceiverKind::Unknown {
                return factory_receiver;
            }
            let receiver = classify_global_state_constructor(scoping, &expression.callee);
            if matches!(
                receiver,
                StateReceiverKind::Array
                    | StateReceiverKind::Function
                    | StateReceiverKind::Number
                    | StateReceiverKind::String
            ) {
                receiver
            } else {
                StateReceiverKind::Unknown
            }
        }
        _ => StateReceiverKind::Unknown,
    }
}

fn classify_state_receiver_assignment(
    scoping: &Scoping,
    expression: &Expression<'_>,
    receivers: &BTreeMap<SymbolId, StateReceiverKind>,
) -> StateReceiverKind {
    let direct = classify_state_receiver_expression(scoping, expression);
    if direct != StateReceiverKind::Unknown {
        return direct;
    }
    match expression.get_inner_expression() {
        Expression::Identifier(identifier) => identifier_symbol(scoping, identifier)
            .and_then(|symbol| receivers.get(&symbol).copied())
            .unwrap_or(StateReceiverKind::Unknown),
        Expression::ConditionalExpression(expression) => merge_state_receiver_kinds(
            classify_state_receiver_assignment(scoping, &expression.consequent, receivers),
            classify_state_receiver_assignment(scoping, &expression.alternate, receivers),
        ),
        Expression::LogicalExpression(expression) => merge_state_receiver_kinds(
            classify_state_receiver_assignment(scoping, &expression.left, receivers),
            classify_state_receiver_assignment(scoping, &expression.right, receivers),
        ),
        Expression::SequenceExpression(expression) => expression
            .expressions
            .last()
            .map_or(StateReceiverKind::Unknown, |value| {
                classify_state_receiver_assignment(scoping, value, receivers)
            }),
        Expression::AssignmentExpression(expression) => {
            classify_state_receiver_assignment(scoping, &expression.right, receivers)
        }
        Expression::CallExpression(call) => classify_state_receiver_call(scoping, call, receivers),
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::CallExpression(call) => {
                classify_state_receiver_call(scoping, call, receivers)
            }
            ChainElement::TSNonNullExpression(expression) => {
                classify_state_receiver_assignment(scoping, &expression.expression, receivers)
            }
            ChainElement::ComputedMemberExpression(_)
            | ChainElement::PrivateFieldExpression(_)
            | ChainElement::StaticMemberExpression(_) => StateReceiverKind::Unknown,
        },
        _ => StateReceiverKind::Unknown,
    }
}

fn classify_state_receiver_call(
    scoping: &Scoping,
    call: &CallExpression<'_>,
    receivers: &BTreeMap<SymbolId, StateReceiverKind>,
) -> StateReceiverKind {
    let factory_receiver = classify_global_state_factory_call(scoping, call);
    if factory_receiver != StateReceiverKind::Unknown {
        return factory_receiver;
    }
    let (object, method) = match call.callee.get_inner_expression() {
        Expression::StaticMemberExpression(member) => {
            (&member.object, Some(member.property.name.as_str()))
        }
        Expression::ComputedMemberExpression(member) => {
            let method = match member.expression.get_inner_expression() {
                Expression::StringLiteral(property) => Some(property.value.as_str()),
                _ => None,
            };
            (&member.object, method)
        }
        _ => return StateReceiverKind::Unknown,
    };
    let Some(method) = method else {
        return StateReceiverKind::Unknown;
    };
    let receiver = classify_state_receiver_assignment(scoping, object, receivers);
    classify_state_method_result(receiver, method)
}

fn classify_global_state_factory_call(
    scoping: &Scoping,
    call: &CallExpression<'_>,
) -> StateReceiverKind {
    let Expression::StaticMemberExpression(member) = call.callee.get_inner_expression() else {
        return StateReceiverKind::Unknown;
    };
    let receiver = classify_global_state_constructor(scoping, &member.object);
    match (receiver, member.property.name.as_str()) {
        (StateReceiverKind::Array | StateReceiverKind::TypedArray, "from" | "of") => receiver,
        (
            StateReceiverKind::Promise,
            "all" | "allSettled" | "any" | "race" | "reject" | "resolve",
        ) => StateReceiverKind::Promise,
        (StateReceiverKind::String, "raw") => StateReceiverKind::String,
        _ => StateReceiverKind::Unknown,
    }
}

fn merge_state_receiver_kinds(
    left: StateReceiverKind,
    right: StateReceiverKind,
) -> StateReceiverKind {
    if left == right {
        left
    } else {
        StateReceiverKind::Unknown
    }
}

fn classify_state_receiver_type(
    scoping: &Scoping,
    annotation: &TSType<'_>,
) -> Option<StateReceiverKind> {
    match annotation {
        TSType::TSArrayType(_) | TSType::TSTupleType(_) => Some(StateReceiverKind::Array),
        TSType::TSFunctionType(_) | TSType::TSConstructorType(_) => {
            Some(StateReceiverKind::Function)
        }
        TSType::TSStringKeyword(_) | TSType::TSTemplateLiteralType(_) => {
            Some(StateReceiverKind::String)
        }
        TSType::TSNumberKeyword(_) | TSType::TSBigIntKeyword(_) => Some(StateReceiverKind::Number),
        TSType::TSLiteralType(literal) => match &literal.literal {
            TSLiteral::StringLiteral(_) | TSLiteral::TemplateLiteral(_) => {
                Some(StateReceiverKind::String)
            }
            TSLiteral::NumericLiteral(_)
            | TSLiteral::BigIntLiteral(_)
            | TSLiteral::UnaryExpression(_) => Some(StateReceiverKind::Number),
            TSLiteral::BooleanLiteral(_) => None,
        },
        TSType::TSParenthesizedType(parenthesized) => {
            classify_state_receiver_type(scoping, &parenthesized.type_annotation)
        }
        TSType::TSTypeOperatorType(operator)
            if operator.operator == TSTypeOperatorOperator::Readonly =>
        {
            classify_state_receiver_type(scoping, &operator.type_annotation)
        }
        TSType::TSTypeReference(reference) => {
            let TSTypeName::IdentifierReference(identifier) = &reference.type_name else {
                return None;
            };
            let reference = scoping.get_reference(identifier.reference_id.get()?);
            if reference.symbol_id().is_some()
                || reference_is_inside_with(scoping, reference.scope_id())
            {
                return None;
            }
            classify_builtin_state_receiver_name(identifier.name.as_str())
        }
        TSType::TSUnionType(union) => {
            let mut receiver = None;
            for member in &union.types {
                if state_receiver_type_is_nullish(member) {
                    continue;
                }
                let candidate = classify_state_receiver_type(scoping, member)?;
                if receiver.is_some_and(|current| current != candidate) {
                    return None;
                }
                receiver = Some(candidate);
            }
            receiver
        }
        _ => None,
    }
}

fn state_receiver_type_is_nullish(annotation: &TSType<'_>) -> bool {
    match annotation {
        TSType::TSNeverKeyword(_)
        | TSType::TSNullKeyword(_)
        | TSType::TSUndefinedKeyword(_)
        | TSType::TSVoidKeyword(_) => true,
        TSType::TSParenthesizedType(parenthesized) => {
            state_receiver_type_is_nullish(&parenthesized.type_annotation)
        }
        _ => false,
    }
}

fn classify_global_state_constructor(
    scoping: &Scoping,
    expression: &Expression<'_>,
) -> StateReceiverKind {
    let Expression::Identifier(identifier) = unwrap_transparent_call_expression(expression) else {
        return StateReceiverKind::Unknown;
    };
    let Some(reference) = identifier.reference_id.get() else {
        return StateReceiverKind::Unknown;
    };
    let reference = scoping.get_reference(reference);
    if reference.symbol_id().is_some() || reference_is_inside_with(scoping, reference.scope_id()) {
        return StateReceiverKind::Unknown;
    }
    classify_builtin_state_receiver_name(identifier.name.as_str())
        .unwrap_or(StateReceiverKind::Unknown)
}

fn classify_builtin_state_receiver_name(name: &str) -> Option<StateReceiverKind> {
    Some(match name {
        "Array" => StateReceiverKind::Array,
        "DataView" => StateReceiverKind::DataView,
        "Date" => StateReceiverKind::Date,
        "CallableFunction" | "Function" | "NewableFunction" => StateReceiverKind::Function,
        "Map" | "ReadonlyMap" => StateReceiverKind::Map,
        "BigInt" | "Number" => StateReceiverKind::Number,
        "Promise" => StateReceiverKind::Promise,
        "ReadonlySet" | "Set" => StateReceiverKind::Set,
        "ReadonlyArray" => StateReceiverKind::Array,
        "String" => StateReceiverKind::String,
        "BigInt64Array" | "BigUint64Array" | "Float32Array" | "Float64Array" | "Int8Array"
        | "Int16Array" | "Int32Array" | "Uint8Array" | "Uint8ClampedArray" | "Uint16Array"
        | "Uint32Array" => StateReceiverKind::TypedArray,
        "WeakMap" => StateReceiverKind::WeakMap,
        "WeakSet" => StateReceiverKind::WeakSet,
        _ => return None,
    })
}

fn builtin_state_receiver_constructor_names(
    receiver: StateReceiverKind,
) -> &'static [&'static str] {
    match receiver {
        StateReceiverKind::Array => &["Array"],
        StateReceiverKind::DataView => &["DataView"],
        StateReceiverKind::Date => &["Date"],
        StateReceiverKind::Function => &["Function"],
        StateReceiverKind::Map => &["Map"],
        StateReceiverKind::Number => &["BigInt", "Number"],
        StateReceiverKind::Promise => &["Promise"],
        StateReceiverKind::Set => &["Set"],
        StateReceiverKind::String => &["String"],
        StateReceiverKind::TypedArray => &[
            "BigInt64Array",
            "BigUint64Array",
            "Float32Array",
            "Float64Array",
            "Int8Array",
            "Int16Array",
            "Int32Array",
            "Uint8Array",
            "Uint8ClampedArray",
            "Uint16Array",
            "Uint32Array",
        ],
        StateReceiverKind::WeakMap => &["WeakMap"],
        StateReceiverKind::WeakSet => &["WeakSet"],
        StateReceiverKind::Unknown => &[],
    }
}

fn configured_reactive_scope_call(
    scoping: &Scoping,
    expression: &Expression<'_>,
    direct_binding: Option<BindingId>,
    configured_names: &BTreeSet<String>,
    configured_bindings: &BTreeSet<BindingId>,
) -> bool {
    if configured_names.is_empty() {
        return false;
    }
    match expression.get_inner_expression() {
        Expression::Identifier(identifier) => {
            if !configured_names.contains(identifier.name.as_str()) {
                return false;
            }
            let Some(reference) = identifier.reference_id.get() else {
                return false;
            };
            let reference = scoping.get_reference(reference);
            match reference.symbol_id() {
                Some(_) => {
                    direct_binding.is_some_and(|binding| configured_bindings.contains(&binding))
                }
                None => !reference_is_inside_with(scoping, reference.scope_id()),
            }
        }
        Expression::StaticMemberExpression(member) => {
            configured_names.contains(member.property.name.as_str())
        }
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::StaticMemberExpression(member) => {
                configured_names.contains(member.property.name.as_str())
            }
            ChainElement::CallExpression(_)
            | ChainElement::ComputedMemberExpression(_)
            | ChainElement::PrivateFieldExpression(_)
            | ChainElement::TSNonNullExpression(_) => false,
        },
        _ => false,
    }
}

fn namespace_reactive_call_classification(
    scoping: &Scoping,
    expression: &Expression<'_>,
    symbol_to_binding: &BTreeMap<SymbolId, BindingId>,
    namespace_sources: &BTreeMap<BindingId, String>,
) -> Option<(BindingId, RuntimeReactiveClassification)> {
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
    runtime_reactive_call_classification(namespace_sources.get(binding)?, property)
        .map(|classification| (*binding, classification))
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
            | "fict/slim"
            | "fict/plus"
            | "fict/advanced"
            | "fict/internal"
            | "@fictjs/runtime"
            | "@fictjs/runtime/advanced"
            | "@fictjs/runtime/internal"
    )
}

fn requires_imported_hook_metadata(
    binding: &FrontendBinding,
    import: &fict_hir::ImportBinding,
    hook: Option<&HookCall>,
) -> bool {
    if is_fict_runtime_source(&import.source) {
        return false;
    }
    match &import.imported {
        fict_hir::ImportedName::Named(imported) => {
            is_hook_name(imported) || is_hook_name(&binding.display_name) || hook.is_some()
        }
        fict_hir::ImportedName::Default => is_hook_name(&binding.display_name) || hook.is_some(),
        fict_hir::ImportedName::Namespace | fict_hir::ImportedName::ImportEquals => hook.is_some(),
    }
}

fn imported_hook_metadata_available(
    import: &fict_hir::ImportBinding,
    properties: &[String],
) -> bool {
    if properties.is_empty() {
        return import.hook_return.is_some();
    }
    import.resolve_hook_member_path(properties).is_some()
}

fn is_fict_runtime_source(source: &str) -> bool {
    matches!(
        source,
        "fict"
            | "fict/advanced"
            | "fict/internal"
            | "fict/internal/list"
            | "fict/plus"
            | "fict/slim"
            | "fict/jsx-runtime"
            | "fict/jsx-dev-runtime"
            | "@fictjs/runtime"
            | "@fictjs/runtime/advanced"
            | "@fictjs/runtime/internal"
            | "@fictjs/runtime/internal/list"
            | "@fictjs/runtime/jsx-runtime"
            | "@fictjs/runtime/jsx-dev-runtime"
            | "@fictjs/runtime/experimental/loader"
    )
}

fn runtime_reactive_call_classification(
    source: &str,
    imported: &str,
) -> Option<RuntimeReactiveClassification> {
    let classified = |reactive_kind, creation_kind| RuntimeReactiveClassification {
        reactive_kind,
        creation_kind,
    };
    match imported {
        "$memo" if matches!(source, "fict" | "fict/slim" | "fict/plus") => Some(classified(
            Some(ReactiveCallKind::Memo),
            Some(RuntimeReactiveCreationKind::NamespaceMemo),
        )),
        "$store" if matches!(source, "fict" | "fict/plus") => {
            Some(classified(Some(ReactiveCallKind::Store), None))
        }
        "resource" if matches!(source, "fict" | "fict/plus") => {
            Some(classified(Some(ReactiveCallKind::Resource), None))
        }
        "createMemo"
            if matches!(
                source,
                "fict" | "fict/internal" | "@fictjs/runtime" | "@fictjs/runtime/internal"
            ) =>
        {
            Some(classified(
                Some(ReactiveCallKind::Memo),
                Some(RuntimeReactiveCreationKind::Memo),
            ))
        }
        "createEffect"
            if matches!(
                source,
                "fict" | "fict/internal" | "@fictjs/runtime" | "@fictjs/runtime/internal"
            ) =>
        {
            Some(classified(None, Some(RuntimeReactiveCreationKind::Effect)))
        }
        "createRenderEffect"
            if matches!(
                source,
                "fict/advanced"
                    | "fict/internal"
                    | "@fictjs/runtime/advanced"
                    | "@fictjs/runtime/internal"
            ) =>
        {
            Some(classified(None, Some(RuntimeReactiveCreationKind::Effect)))
        }
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
            Some(classified(
                Some(ReactiveCallKind::Selector),
                Some(RuntimeReactiveCreationKind::Selector),
            ))
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
                    FrontendBindingKind::Var | FrontendBindingKind::Alias => BindingKind::Var,
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

fn build_module_plan(
    frontend: &FrontendSummary,
    old_to_new: &BTreeMap<u32, BindingId>,
) -> ModulePlan {
    let exports = frontend
        .module_exports
        .iter()
        .map(|export| match export {
            ModuleExport::Local {
                exported,
                target,
                origin,
            } => ModuleExport::Local {
                exported: exported.clone(),
                target: match target {
                    ModuleLocalExport::Binding(binding) => ModuleLocalExport::Binding(
                        old_to_new
                            .get(&binding.index())
                            .copied()
                            .unwrap_or_else(|| BindingId::new(u32::MAX)),
                    ),
                    ModuleLocalExport::DefaultExpression => ModuleLocalExport::DefaultExpression,
                },
                origin: *origin,
            },
            ModuleExport::ReExport {
                exported,
                source,
                imported,
                origin,
            } => ModuleExport::ReExport {
                exported: exported.clone(),
                source: source.clone(),
                imported: imported.clone(),
                origin: *origin,
            },
            ModuleExport::Star { source, origin } => ModuleExport::Star {
                source: source.clone(),
                origin: *origin,
            },
        })
        .collect();
    ModulePlan {
        has_module_syntax: frontend.has_module_syntax,
        exports,
    }
}

fn classify_named_function(name: Option<&str>) -> FunctionKind {
    let Some(name) = name else {
        return FunctionKind::Plain;
    };
    if is_hook_name(name) {
        FunctionKind::Hook
    } else {
        FunctionKind::Plain
    }
}

fn declaration_kind(kind: FrontendBindingKind) -> DeclarationKind {
    match kind {
        FrontendBindingKind::Var | FrontendBindingKind::Alias => DeclarationKind::Var,
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
    rest.as_bytes()
        .first()
        .is_some_and(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
}

fn coercive_expression_semantics() -> InstructionSemantics {
    InstructionSemantics {
        purity: Purity::Unknown,
        mutation: MutationEffect::Unknown,
        evaluation: EvaluationMode::Eager,
        may_throw: true,
    }
}

fn unary_expression_semantics(operator: UnaryOperator) -> InstructionSemantics {
    match operator {
        UnaryOperator::Not | UnaryOperator::TypeOf | UnaryOperator::Void => {
            InstructionSemantics::PURE_EAGER
        }
        UnaryOperator::Plus | UnaryOperator::Minus | UnaryOperator::BitNot => {
            coercive_expression_semantics()
        }
    }
}

fn delete_expression_semantics(target: &DeleteTarget) -> InstructionSemantics {
    match target {
        DeleteTarget::Value(_) => InstructionSemantics::PURE_EAGER,
        DeleteTarget::Place(place) if place.projections.is_empty() => {
            InstructionSemantics::PURE_EAGER
        }
        DeleteTarget::Place(_) => InstructionSemantics {
            purity: Purity::Impure,
            mutation: MutationEffect::Observable,
            evaluation: EvaluationMode::Eager,
            may_throw: true,
        },
        DeleteTarget::UnresolvedIdentifier(_) => InstructionSemantics::CONSERVATIVE_EAGER,
    }
}

fn context_value_semantics(kind: ContextValueKind) -> InstructionSemantics {
    match kind {
        ContextValueKind::This => InstructionSemantics {
            purity: Purity::Pure,
            mutation: MutationEffect::None,
            evaluation: EvaluationMode::Eager,
            // Accessing `this` before `super()` in a derived constructor throws.
            may_throw: true,
        },
        ContextValueKind::Arguments
        | ContextValueKind::NewTarget
        | ContextValueKind::ImportMeta => InstructionSemantics::PURE_EAGER,
    }
}

fn binary_expression_semantics(operator: BinaryOperator) -> InstructionSemantics {
    match operator {
        BinaryOperator::StrictEqual | BinaryOperator::StrictNotEqual => {
            InstructionSemantics::PURE_EAGER
        }
        BinaryOperator::LogicalAnd
        | BinaryOperator::LogicalOr
        | BinaryOperator::NullishCoalescing => InstructionSemantics::PURE_EAGER,
        BinaryOperator::Add
        | BinaryOperator::Subtract
        | BinaryOperator::Multiply
        | BinaryOperator::Divide
        | BinaryOperator::Remainder
        | BinaryOperator::Exponent
        | BinaryOperator::Equal
        | BinaryOperator::NotEqual
        | BinaryOperator::LessThan
        | BinaryOperator::LessThanOrEqual
        | BinaryOperator::GreaterThan
        | BinaryOperator::GreaterThanOrEqual
        | BinaryOperator::ShiftLeft
        | BinaryOperator::ShiftRight
        | BinaryOperator::ShiftRightUnsigned
        | BinaryOperator::BitOr
        | BinaryOperator::BitXor
        | BinaryOperator::BitAnd
        | BinaryOperator::In
        | BinaryOperator::InstanceOf => coercive_expression_semantics(),
    }
}

fn reactive_read_semantics() -> InstructionSemantics {
    InstructionSemantics {
        purity: Purity::Unknown,
        mutation: MutationEffect::None,
        evaluation: EvaluationMode::Eager,
        may_throw: true,
    }
}

fn projected_read_semantics() -> InstructionSemantics {
    InstructionSemantics {
        purity: Purity::Unknown,
        mutation: MutationEffect::None,
        evaluation: EvaluationMode::Eager,
        may_throw: true,
    }
}

fn mutation_semantics(reactive: bool, projected: bool, external: bool) -> InstructionSemantics {
    InstructionSemantics {
        purity: if reactive {
            Purity::Unknown
        } else {
            Purity::Impure
        },
        mutation: if reactive || projected || external {
            MutationEffect::Observable
        } else {
            MutationEffect::Local
        },
        evaluation: EvaluationMode::Eager,
        may_throw: true,
    }
}

fn compound_assignment_is_conditional(operator: CompoundAssignmentOperator) -> bool {
    matches!(
        operator,
        CompoundAssignmentOperator::LogicalAnd
            | CompoundAssignmentOperator::LogicalOr
            | CompoundAssignmentOperator::NullishCoalescing
    )
}

fn instruction_source_order_key(
    instruction: &HirInstruction,
    original_index: usize,
) -> (u32, std::cmp::Reverse<u32>, u8, usize) {
    let span = instruction.origin.primary_span;
    let end = span.map_or(0, SourceSpan::end);
    let start = span.map_or(0, SourceSpan::start);
    let rank = match instruction.kind {
        HirInstructionKind::Declare { .. } => 5,
        HirInstructionKind::Write { .. }
        | HirInstructionKind::ReadWrite { .. }
        | HirInstructionKind::PatternAssignment { .. } => 4,
        HirInstructionKind::Call(_) | HirInstructionKind::New { .. } => 3,
        HirInstructionKind::SyntaxFragment { .. } => 2,
        _ => 1,
    };
    (end, std::cmp::Reverse(start), rank, original_index)
}

fn instruction_value_inputs(instruction: &HirInstruction) -> Vec<ValueId> {
    let mut inputs = Vec::new();
    match &instruction.kind {
        HirInstructionKind::Declare { initializer, .. } => inputs.extend(initializer),
        HirInstructionKind::Read { place } => place_value_inputs(place, &mut inputs),
        HirInstructionKind::Write { place, value } => {
            place_value_inputs(place, &mut inputs);
            inputs.push(*value);
        }
        HirInstructionKind::ReadWrite { place, value, .. } => {
            place_value_inputs(place, &mut inputs);
            inputs.extend(value);
        }
        HirInstructionKind::Iteration { source, .. } => inputs.push(*source),
        HirInstructionKind::PatternAssignment { value, .. } => inputs.push(*value),
        HirInstructionKind::Delete { target } => match target {
            DeleteTarget::Place(place) => place_value_inputs(place, &mut inputs),
            DeleteTarget::UnresolvedIdentifier(_) => {}
            DeleteTarget::Value(value) => inputs.push(*value),
        },
        HirInstructionKind::Unary { argument, .. } => inputs.push(*argument),
        HirInstructionKind::Binary { left, right, .. } => inputs.extend([*left, *right]),
        HirInstructionKind::Conditional {
            test,
            consequent,
            alternate,
        } => inputs.extend([*test, *consequent, *alternate]),
        HirInstructionKind::Sequence { values } => inputs.extend(values),
        HirInstructionKind::TemplateLiteral { expressions, .. } => inputs.extend(expressions),
        HirInstructionKind::TaggedTemplate {
            tag, substitutions, ..
        } => {
            inputs.push(*tag);
            inputs.extend(substitutions);
        }
        HirInstructionKind::DynamicImport {
            specifier, options, ..
        } => {
            inputs.push(*specifier);
            inputs.extend(options);
        }
        HirInstructionKind::Call(call) => {
            inputs.push(call.callee);
            inputs.extend(call.arguments.iter().map(|argument| argument.value));
        }
        HirInstructionKind::New { callee, arguments } => {
            inputs.push(*callee);
            inputs.extend(arguments.iter().map(|argument| argument.value));
        }
        HirInstructionKind::Array { elements } => {
            for element in elements {
                match element {
                    fict_hir::ArrayElement::Hole(_) => {}
                    fict_hir::ArrayElement::Value(value)
                    | fict_hir::ArrayElement::Spread { value, .. } => inputs.push(*value),
                }
            }
        }
        HirInstructionKind::Object { entries } => {
            for entry in entries {
                match entry {
                    fict_hir::ObjectEntry::Property { key, value, .. } => {
                        if let fict_hir::PropertyKey::Computed(key) = key {
                            inputs.push(*key);
                        }
                        inputs.push(*value);
                    }
                    fict_hir::ObjectEntry::Spread { value, .. } => inputs.push(*value),
                }
            }
        }
        HirInstructionKind::Await { value } => inputs.push(*value),
        HirInstructionKind::Yield { value, .. } => inputs.extend(value),
        HirInstructionKind::SyntaxFragment {
            inputs: fragment_inputs,
            ..
        } => inputs.extend(fragment_inputs),
        HirInstructionKind::Literal(_)
        | HirInstructionKind::UnresolvedTypeof { .. }
        | HirInstructionKind::Context { .. }
        | HirInstructionKind::Function { .. }
        | HirInstructionKind::Jsx { .. }
        | HirInstructionKind::Phi { .. }
        | HirInstructionKind::Debugger => {}
    }
    inputs
}

fn place_value_inputs(place: &fict_hir::Place, inputs: &mut Vec<ValueId>) {
    if let fict_hir::PlaceBase::Value(value) = place.base {
        inputs.push(value);
    }
    for projection in &place.projections {
        if let fict_hir::Projection::ComputedProperty { key, .. } = projection {
            inputs.push(*key);
        }
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

fn props_pattern_diagnostic(issue: PropsPatternIssue, severity: DiagnosticSeverity) -> Diagnostic {
    let (code, message, help) = match issue.kind {
        PropsPatternIssueKind::Array => (
            "FICT-P001",
            "Props destructuring falls back to non-reactive binding.",
            "read the prop first, then destructure its array value inside the component body",
        ),
        PropsPatternIssueKind::ArrayRest => (
            "FICT-P002",
            "Array rest in props destructuring falls back to non-reactive binding.",
            "read the prop first, then apply array rest destructuring inside the component body",
        ),
        PropsPatternIssueKind::Computed => (
            "FICT-P003",
            "Computed property in props pattern cannot be made reactive.",
            "replace the computed key with a non-empty identifier, string, or numeric literal",
        ),
        PropsPatternIssueKind::Nested => (
            "FICT-P004",
            "Nested props destructuring falls back to non-reactive binding; access props directly or use prop.",
            "move the unsupported nested pattern into the component body after reading its parent prop",
        ),
    };
    Diagnostic::new(
        DiagnosticCode::new(code).expect("props diagnostic literal"),
        severity,
        message,
    )
    .with_primary_span(issue.span)
    .with_help(help)
    .with_guarantee_class(GuaranteeClass::Fallback)
}
