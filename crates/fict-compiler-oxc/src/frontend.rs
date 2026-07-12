use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use fict_hir::{BindingId, FictMacroKind, ImportBinding, ImportKind, ImportedName, ScopeId};
use oxc::{
    allocator::Allocator,
    ast::ast::{
        CallExpression, Expression, ImportDeclaration, ImportDeclarationSpecifier,
        ImportOrExportKind,
    },
    ast_visit::{Visit, walk::walk_call_expression},
    parser::{ParseOptions, Parser},
    semantic::{Scoping, Semantic, SemanticBuilder},
    span::{GetSpan, Span},
    syntax::{reference::ReferenceId, scope::ScopeFlags, symbol::SymbolFlags, symbol::SymbolId},
};

use crate::{OxcCompileOptions, OxcModuleKind, OxcSourceLanguage};

use super::compile::{convert_diagnostics, sorted, source_type};

const FICT_MACRO_MODULES: &[&str] = &["fict", "fict/slim"];
const MEMO_MACRO_MODULES: &[&str] = &["fict", "fict/slim", "fict/plus"];
const RUNTIME_MODULES: &[&str] = &[
    "fict",
    "fict/advanced",
    "fict/internal",
    "fict/internal/list",
    "fict/jsx-runtime",
    "fict/jsx-dev-runtime",
    "fict/experimental/loader",
    "fict/plus",
    "fict/slim",
    "@fictjs/runtime",
    "@fictjs/runtime/advanced",
    "@fictjs/runtime/internal",
    "@fictjs/runtime/internal/list",
    "@fictjs/runtime/jsx-runtime",
    "@fictjs/runtime/jsx-dev-runtime",
    "@fictjs/runtime/experimental/loader",
];

/// Owned source and semantic counts produced by the OXC frontend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontendSourceSummary {
    /// Requested source language.
    pub language: OxcSourceLanguage,
    /// Requested module grammar.
    pub requested_module_kind: OxcModuleKind,
    /// Whether OXC resolved the parsed program as an ECMAScript module.
    pub parsed_as_module: bool,
    /// Whether OXC resolved the parsed program as CommonJS.
    pub parsed_as_commonjs: bool,
    /// UTF-8 source byte length.
    pub source_len: u32,
    /// Number of top-level statements.
    pub statement_count: u32,
    /// Number of semantic AST nodes.
    pub node_count: u32,
    /// Number of semantic scopes.
    pub scope_count: u32,
    /// Number of semantic symbols, including erased type-only symbols.
    pub symbol_count: u32,
    /// Number of identifier references.
    pub reference_count: u32,
}

/// Owned scope category independent of OXC scope flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FrontendScopeKind {
    /// File root scope.
    Module,
    /// Function scope.
    Function,
    /// Class static block.
    ClassStaticBlock,
    /// TypeScript namespace/module block.
    TypeScriptNamespace,
    /// Catch clause.
    Catch,
    /// Dynamic `with` scope.
    With,
    /// Ordinary lexical block.
    Block,
}

/// Arena-independent semantic scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontendScope {
    /// Dense frontend scope identity.
    pub id: ScopeId,
    /// Lexical parent.
    pub parent: Option<ScopeId>,
    /// Scope category.
    pub kind: FrontendScopeKind,
    /// Whether strict mode applies.
    pub strict: bool,
    /// Whether the scope contains direct `eval`.
    pub contains_direct_eval: bool,
}

/// Owned semantic binding category before TypeScript runtime erasure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FrontendBindingKind {
    /// Function-scoped `var` or parameter.
    Var,
    /// Block-scoped `let`.
    Let,
    /// `const`.
    Const,
    /// Function declaration or named function expression.
    Function,
    /// Class binding.
    Class,
    /// Runtime import.
    Import,
    /// Catch parameter.
    Catch,
    /// Runtime enum.
    Enum,
    /// Runtime namespace/module.
    Namespace,
    /// Type-only declaration or import.
    TypeOnly,
    /// Ambient value declaration with no runtime storage in this file.
    Ambient,
    /// Semantic category not yet lowered by the HIR builder.
    Other,
}

/// Arena-independent semantic binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontendBinding {
    /// Dense binding identity in semantic source order.
    pub id: BindingId,
    /// Declaring scope.
    pub scope: ScopeId,
    /// Binding category.
    pub kind: FrontendBindingKind,
    /// Source spelling for diagnostics only.
    pub display_name: String,
    /// Declaration span.
    pub declaration_span: SourceSpan,
    /// Import identity, if any.
    pub import: Option<ImportBinding>,
    /// Whether this declaration produces a runtime binding in the current file.
    pub is_runtime: bool,
    /// Number of resolved semantic references.
    pub reference_count: u32,
    /// Whether semantic analysis observed a write after declaration.
    pub mutated: bool,
}

/// Direct compiler-macro import confirmed from module and exported symbol identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontendMacroImport {
    /// Macro semantics.
    pub kind: FictMacroKind,
    /// Resolved local binding identity.
    pub binding: BindingId,
    /// Exact source module.
    pub source: String,
    /// Exact imported name.
    pub imported_name: String,
    /// Local source spelling for diagnostics only.
    pub local_name: String,
    /// Import specifier span.
    pub span: SourceSpan,
}

/// Binding-confirmed compiler-macro call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontendMacroCall {
    /// Macro semantics.
    pub kind: FictMacroKind,
    /// Resolved imported binding identity.
    pub binding: BindingId,
    /// Full call span.
    pub call_span: SourceSpan,
    /// Callee identifier span.
    pub callee_span: SourceSpan,
    /// Whether optional-call syntax was authored.
    pub optional: bool,
    /// OXC pure-comment fact on the call.
    pub pure: bool,
}

/// Imported macro binding used somewhere other than a direct call callee.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontendMacroValueUse {
    /// Macro semantics.
    pub kind: FictMacroKind,
    /// Resolved imported binding identity.
    pub binding: BindingId,
    /// Identifier reference span.
    pub span: SourceSpan,
}

/// Namespace macro-shaped call, retained for a structured unsupported diagnostic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NamespaceMacroCall {
    /// Macro semantics implied by the static property.
    pub kind: FictMacroKind,
    /// Namespace import binding identity.
    pub namespace_binding: BindingId,
    /// Exact source module.
    pub source: String,
    /// Full call span.
    pub call_span: SourceSpan,
    /// Static property span.
    pub property_span: SourceSpan,
    /// Whether optional-call syntax was authored.
    pub optional: bool,
}

/// Complete owned frontend summary. No arena-backed AST or OXC ID escapes this value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontendSummary {
    /// Source and semantic counts.
    pub source: FrontendSourceSummary,
    /// Scopes in deterministic semantic order.
    pub scopes: Vec<FrontendScope>,
    /// Bindings in deterministic semantic order.
    pub bindings: Vec<FrontendBinding>,
    /// Binding-confirmed macro imports.
    pub macro_imports: Vec<FrontendMacroImport>,
    /// Binding-confirmed macro calls in source order.
    pub macro_calls: Vec<FrontendMacroCall>,
    /// Invalid value uses of direct compiler macro imports.
    pub macro_value_uses: Vec<FrontendMacroValueUse>,
    /// Unsupported namespace macro-shaped calls in source order.
    pub namespace_macro_calls: Vec<NamespaceMacroCall>,
}

/// Frontend result. `summary` is absent whenever parser or semantic errors exist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontendOutput {
    /// Owned frontend facts on success.
    pub summary: Option<FrontendSummary>,
    /// Structured parser/semantic diagnostics.
    pub diagnostics: Vec<Diagnostic>,
}

/// Parse and semantically analyze source into an arena-independent frontend summary.
#[must_use]
pub fn analyze_frontend(source: &str, options: OxcCompileOptions) -> FrontendOutput {
    let Ok(source_len) = u32::try_from(source.len()) else {
        return FrontendOutput {
            summary: None,
            diagnostics: vec![
                Diagnostic::new(
                    diagnostic_code("FICT-SOURCE-LIMIT"),
                    DiagnosticSeverity::Error,
                    "source exceeds the native compiler's 32-bit byte-offset limit",
                )
                .with_guarantee_class(GuaranteeClass::Unsupported),
            ],
        };
    };

    let allocator = Allocator::default();
    let requested_source_type = source_type(options);
    let parsed = Parser::new(&allocator, source, requested_source_type)
        .with_options(ParseOptions {
            allow_return_outside_function: options.module_kind == OxcModuleKind::CommonJs,
            ..ParseOptions::default()
        })
        .parse();
    if !parsed.diagnostics.is_empty() {
        return FrontendOutput {
            summary: None,
            diagnostics: sorted(convert_diagnostics(parsed.diagnostics, "FICT-PARSE")),
        };
    }

    let program = parsed.program;
    let semantic_result = SemanticBuilder::new()
        .with_build_nodes(true)
        .with_check_syntax_error(true)
        .with_enum_eval(true)
        .build(&program);
    let has_errors = semantic_result.diagnostics.has_errors();
    let diagnostics = sorted(convert_diagnostics(
        semantic_result.diagnostics,
        "FICT-SEMANTIC",
    ));
    if has_errors {
        return FrontendOutput {
            summary: None,
            diagnostics,
        };
    }

    let semantic = semantic_result.semantic;
    let summary = build_summary(source_len, options, &program, &semantic);
    FrontendOutput {
        summary: Some(summary),
        diagnostics,
    }
}

fn build_summary(
    source_len: u32,
    options: OxcCompileOptions,
    program: &oxc::ast::ast::Program<'_>,
    semantic: &Semantic<'_>,
) -> FrontendSummary {
    let mut import_collector = ImportCollector::default();
    import_collector.visit_program(program);
    let import_records = import_collector.records;
    let import_by_symbol: BTreeMap<_, _> = import_records
        .iter()
        .map(|record| (record.symbol, record))
        .collect();

    let scoping = semantic.scoping();
    let scopes = build_scopes(scoping);
    let bindings = build_bindings(scoping, &import_by_symbol);
    let symbol_to_binding: BTreeMap<_, _> = scoping
        .symbol_ids()
        .enumerate()
        .map(|(index, symbol)| (symbol, binding_id(index)))
        .collect();

    let mut direct_macros = BTreeMap::new();
    let mut namespace_macros = BTreeMap::new();
    let mut macro_imports = Vec::new();
    for record in &import_records {
        let Some(binding) = symbol_to_binding.get(&record.symbol).copied() else {
            continue;
        };
        if record.type_only {
            continue;
        }
        match &record.imported {
            ImportedName::Named(imported_name) => {
                if let Some(kind) = macro_kind(&record.source, imported_name) {
                    direct_macros.insert(record.symbol, (kind, binding));
                    macro_imports.push(FrontendMacroImport {
                        kind,
                        binding,
                        source: record.source.clone(),
                        imported_name: imported_name.clone(),
                        local_name: record.local_name.clone(),
                        span: record.span,
                    });
                }
            }
            ImportedName::Namespace if FICT_MACRO_MODULES.contains(&record.source.as_str()) => {
                namespace_macros.insert(record.symbol, (binding, record.source.clone()));
            }
            ImportedName::Default | ImportedName::Namespace => {}
        }
    }

    let mut macro_collector = MacroCollector {
        scoping,
        direct_macros: &direct_macros,
        namespace_macros: &namespace_macros,
        calls: Vec::new(),
        namespace_calls: Vec::new(),
        callee_references: BTreeSet::new(),
    };
    macro_collector.visit_program(program);

    let mut macro_value_uses = Vec::new();
    for (symbol, (kind, binding)) in &direct_macros {
        for reference_id in scoping.get_resolved_reference_ids(*symbol) {
            if macro_collector.callee_references.contains(reference_id) {
                continue;
            }
            let reference = scoping.get_reference(*reference_id);
            if !reference.is_value() {
                continue;
            }
            macro_value_uses.push(FrontendMacroValueUse {
                kind: *kind,
                binding: *binding,
                span: source_span(semantic.reference_span(reference)),
            });
        }
    }

    macro_imports.sort_by_key(|fact| (fact.span.start(), fact.binding));
    macro_collector
        .calls
        .sort_by_key(|fact| (fact.call_span.start(), fact.binding));
    macro_value_uses.sort_by_key(|fact| (fact.span.start(), fact.binding));
    macro_collector
        .namespace_calls
        .sort_by_key(|fact| (fact.call_span.start(), fact.namespace_binding));

    let stats = semantic.stats();
    FrontendSummary {
        source: FrontendSourceSummary {
            language: options.language,
            requested_module_kind: options.module_kind,
            parsed_as_module: program.source_type.is_module(),
            parsed_as_commonjs: program.source_type.is_commonjs(),
            source_len,
            statement_count: count_u32(program.body.len()),
            node_count: stats.nodes,
            scope_count: stats.scopes,
            symbol_count: stats.symbols,
            reference_count: stats.references,
        },
        scopes,
        bindings,
        macro_imports,
        macro_calls: macro_collector.calls,
        macro_value_uses,
        namespace_macro_calls: macro_collector.namespace_calls,
    }
}

fn build_scopes(scoping: &Scoping) -> Vec<FrontendScope> {
    scoping
        .scope_descendants_from_root()
        .enumerate()
        .map(|(index, scope)| {
            let flags = scoping.scope_flags(scope);
            FrontendScope {
                id: scope_id(index),
                parent: scoping
                    .scope_parent_id(scope)
                    .map(|parent| scope_id(parent.index())),
                kind: scope_kind(flags),
                strict: flags.is_strict_mode(),
                contains_direct_eval: flags.contains_direct_eval(),
            }
        })
        .collect()
}

fn build_bindings(
    scoping: &Scoping,
    imports: &BTreeMap<SymbolId, &ImportRecord>,
) -> Vec<FrontendBinding> {
    scoping
        .symbol_ids()
        .enumerate()
        .map(|(index, symbol)| {
            let flags = scoping.symbol_flags(symbol);
            let import = imports.get(&symbol).map(|record| ImportBinding {
                source: record.source.clone(),
                imported: record.imported.clone(),
                kind: if record.type_only {
                    ImportKind::TypeOnly
                } else {
                    ImportKind::Value
                },
            });
            FrontendBinding {
                id: binding_id(index),
                scope: scope_id(scoping.symbol_scope_id(symbol).index()),
                kind: binding_kind(flags),
                display_name: scoping.symbol_name(symbol).into(),
                declaration_span: source_span(scoping.symbol_span(symbol)),
                import,
                is_runtime: flags.is_value()
                    && !flags.contains(SymbolFlags::Ambient | SymbolFlags::TypeImport),
                reference_count: count_u32(scoping.get_resolved_reference_ids(symbol).len()),
                mutated: scoping.symbol_is_mutated(symbol),
            }
        })
        .collect()
}

fn scope_kind(flags: ScopeFlags) -> FrontendScopeKind {
    if flags.is_top() {
        FrontendScopeKind::Module
    } else if flags.is_function() {
        FrontendScopeKind::Function
    } else if flags.is_class_static_block() {
        FrontendScopeKind::ClassStaticBlock
    } else if flags.is_ts_module_block() {
        FrontendScopeKind::TypeScriptNamespace
    } else if flags.is_catch_clause() {
        FrontendScopeKind::Catch
    } else if flags.is_with() {
        FrontendScopeKind::With
    } else {
        FrontendScopeKind::Block
    }
}

fn binding_kind(flags: SymbolFlags) -> FrontendBindingKind {
    if flags.contains(SymbolFlags::Ambient) {
        FrontendBindingKind::Ambient
    } else if flags.contains(SymbolFlags::TypeImport) || (flags.is_type() && !flags.is_value()) {
        FrontendBindingKind::TypeOnly
    } else if flags.contains(SymbolFlags::Import) {
        FrontendBindingKind::Import
    } else if flags.contains(SymbolFlags::CatchVariable) {
        FrontendBindingKind::Catch
    } else if flags.is_function() {
        FrontendBindingKind::Function
    } else if flags.is_class() {
        FrontendBindingKind::Class
    } else if flags.contains(SymbolFlags::Enum) {
        FrontendBindingKind::Enum
    } else if flags.intersects(SymbolFlags::ValueModule | SymbolFlags::NamespaceModule) {
        FrontendBindingKind::Namespace
    } else if flags.is_const_variable() {
        FrontendBindingKind::Const
    } else if flags.contains(SymbolFlags::BlockScopedVariable) {
        FrontendBindingKind::Let
    } else if flags.contains(SymbolFlags::FunctionScopedVariable) {
        FrontendBindingKind::Var
    } else {
        FrontendBindingKind::Other
    }
}

#[derive(Debug, Clone)]
struct ImportRecord {
    symbol: SymbolId,
    source: String,
    imported: ImportedName,
    local_name: String,
    type_only: bool,
    span: SourceSpan,
}

#[derive(Default)]
struct ImportCollector {
    records: Vec<ImportRecord>,
}

impl<'a> Visit<'a> for ImportCollector {
    fn visit_import_declaration(&mut self, declaration: &ImportDeclaration<'a>) {
        let Some(specifiers) = &declaration.specifiers else {
            return;
        };
        for specifier in specifiers {
            let local = specifier.local();
            let Some(symbol) = local.symbol_id.get() else {
                continue;
            };
            let (imported, specifier_type_only) = match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(specifier) => (
                    ImportedName::Named(specifier.imported.name().to_string()),
                    specifier.import_kind == ImportOrExportKind::Type,
                ),
                ImportDeclarationSpecifier::ImportDefaultSpecifier(_) => {
                    (ImportedName::Default, false)
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => {
                    (ImportedName::Namespace, false)
                }
            };
            self.records.push(ImportRecord {
                symbol,
                source: declaration.source.value.to_string(),
                imported,
                local_name: local.name.to_string(),
                type_only: declaration.import_kind == ImportOrExportKind::Type
                    || specifier_type_only,
                span: source_span(specifier.span()),
            });
        }
    }
}

struct MacroCollector<'semantic, 'facts> {
    scoping: &'semantic Scoping,
    direct_macros: &'facts BTreeMap<SymbolId, (FictMacroKind, BindingId)>,
    namespace_macros: &'facts BTreeMap<SymbolId, (BindingId, String)>,
    calls: Vec<FrontendMacroCall>,
    namespace_calls: Vec<NamespaceMacroCall>,
    callee_references: BTreeSet<ReferenceId>,
}

impl<'a> Visit<'a> for MacroCollector<'_, '_> {
    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        let callee = unwrap_transparent_callee(&call.callee);
        match callee {
            Expression::Identifier(identifier) => {
                if let Some((reference_id, symbol)) = resolved_identifier(self.scoping, identifier)
                    && let Some((kind, binding)) = self.direct_macros.get(&symbol)
                {
                    self.callee_references.insert(reference_id);
                    self.calls.push(FrontendMacroCall {
                        kind: *kind,
                        binding: *binding,
                        call_span: source_span(call.span),
                        callee_span: source_span(identifier.span),
                        optional: call.optional,
                        pure: call.pure,
                    });
                }
            }
            Expression::StaticMemberExpression(member) => {
                if let Expression::Identifier(object) = unwrap_transparent_callee(&member.object)
                    && let Some((_, symbol)) = resolved_identifier(self.scoping, object)
                    && let Some((binding, source)) = self.namespace_macros.get(&symbol)
                    && let Some(kind) = namespace_macro_kind(member.property.name.as_str())
                {
                    self.namespace_calls.push(NamespaceMacroCall {
                        kind,
                        namespace_binding: *binding,
                        source: source.clone(),
                        call_span: source_span(call.span),
                        property_span: source_span(member.property.span),
                        optional: call.optional || member.optional,
                    });
                }
            }
            _ => {}
        }
        walk_call_expression(self, call);
    }
}

fn resolved_identifier(
    scoping: &Scoping,
    identifier: &oxc::ast::ast::IdentifierReference<'_>,
) -> Option<(ReferenceId, SymbolId)> {
    let reference_id = identifier.reference_id.get()?;
    let symbol = scoping.get_reference(reference_id).symbol_id()?;
    Some((reference_id, symbol))
}

fn unwrap_transparent_callee<'expression>(
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

fn macro_kind(source: &str, imported_name: &str) -> Option<FictMacroKind> {
    match imported_name {
        "$state" if FICT_MACRO_MODULES.contains(&source) => Some(FictMacroKind::State),
        "$effect" if FICT_MACRO_MODULES.contains(&source) => Some(FictMacroKind::Effect),
        "$memo" if MEMO_MACRO_MODULES.contains(&source) => Some(FictMacroKind::Memo),
        "createMemo" if RUNTIME_MODULES.contains(&source) => Some(FictMacroKind::Memo),
        _ => None,
    }
}

fn namespace_macro_kind(property: &str) -> Option<FictMacroKind> {
    match property {
        "$state" => Some(FictMacroKind::State),
        "$effect" => Some(FictMacroKind::Effect),
        _ => None,
    }
}

fn source_span(span: Span) -> SourceSpan {
    SourceSpan::new(span.start, span.end).expect("OXC spans must be ordered")
}

fn binding_id(index: usize) -> BindingId {
    BindingId::new(count_u32(index))
}

fn scope_id(index: usize) -> ScopeId {
    ScopeId::new(count_u32(index))
}

fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn diagnostic_code(value: &'static str) -> DiagnosticCode {
    DiagnosticCode::new(value).expect("frontend diagnostic literals must be valid")
}
