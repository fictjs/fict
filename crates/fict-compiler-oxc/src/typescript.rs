use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use oxc::{
    allocator::Allocator,
    ast::ast::{
        ArrowFunctionExpression, Declaration, Decorator, ExportAllDeclaration,
        ExportNamedDeclaration, FormalParameter, FormalParameterRest, Function, ImportDeclaration,
        ImportDeclarationSpecifier, ImportOrExportKind, Program, PropertyDefinition,
        ReturnStatement, Statement, TSEnumDeclaration, TSExportAssignment,
        TSImportEqualsDeclaration, TSModuleDeclaration, TSModuleDeclarationBody,
        TSModuleDeclarationName, TSModuleReference, VariableDeclarationKind,
    },
    ast_visit::{Visit, walk::*},
    semantic::{Scoping, SemanticBuilder},
    span::Span,
    syntax::{scope::ScopeFlags, symbol::SymbolId},
    transformer::{DecoratorOptions, RewriteExtensionsMode, TransformOptions},
};

use crate::{OxcCompileOptions, OxcModuleKind};

use super::compile::{convert_diagnostics, parse_source, sorted};

/// TypeScript lowering controls supported by the native adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OxcTypeScriptOptions {
    /// Enable runtime namespace lowering.
    pub allow_namespaces: bool,
    /// Preserve value imports unless they are explicitly type-only.
    pub only_remove_type_imports: bool,
    /// Inline and remove const enums where semantics permit.
    pub optimize_const_enums: bool,
    /// Inline statically known regular enum members where semantics permit.
    pub optimize_enums: bool,
    /// Rewrite relative TypeScript module extensions.
    pub rewrite_import_extensions: bool,
    /// Remove uninitialized class fields under assignment-semantics compatibility mode.
    pub remove_class_fields_without_initializer: bool,
}

impl Default for OxcTypeScriptOptions {
    fn default() -> Self {
        Self {
            allow_namespaces: true,
            only_remove_type_imports: false,
            optimize_const_enums: false,
            optimize_enums: false,
            rewrite_import_extensions: false,
            remove_class_fields_without_initializer: false,
        }
    }
}

/// Pass responsible for a TypeScript source feature.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum TypeScriptLoweringOwner {
    /// Safely lowered by the pinned OXC TypeScript pass.
    Oxc,
    /// Requires Fict compatibility lowering before the OXC pass.
    FictCompatibility,
    /// Erased as type-only syntax.
    Erase,
    /// Unsupported for the selected module/decorator profile.
    Unsupported,
}

/// Runtime-significant TypeScript source feature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeScriptFeatureKind {
    /// Runtime or const enum declaration.
    Enum {
        /// `const enum` declaration.
        const_enum: bool,
        /// Ambient declaration erased at runtime.
        declared: bool,
    },
    /// Namespace/module declaration.
    Namespace {
        /// Source name.
        name: String,
        /// One-based nesting depth.
        depth: u16,
        /// Multiple runtime declarations resolve to the same semantic symbol.
        merged: bool,
        /// Namespace exports `let` or `var`, which OXC cannot lower soundly.
        mutable_export: bool,
        /// Namespace contains at least one runtime statement.
        has_runtime_body: bool,
        /// Ambient declaration.
        declared: bool,
    },
    /// Current TC39/class/member decorator syntax.
    StandardDecorator,
    /// Legacy TypeScript parameter decorator.
    LegacyParameterDecorator,
    /// `declare` class field erased before runtime HIR.
    DeclareClassField,
    /// `import x = require(...)` or internal alias.
    ImportEquals {
        /// Whether the right side is an external module reference.
        external: bool,
    },
    /// TypeScript `export =` assignment.
    ExportAssignment,
    /// Type-only import declaration/specifier.
    TypeOnlyImport,
    /// Relative TypeScript import/export extension rewrite.
    ImportExtension {
        /// Original module specifier.
        source: String,
        /// JavaScript-equivalent module specifier.
        rewritten: String,
    },
    /// CommonJS top-level return.
    CommonJsTopLevelReturn,
}

/// One compatibility decision tied to source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeScriptFeature {
    /// Feature category.
    pub kind: TypeScriptFeatureKind,
    /// Responsible lowering pass.
    pub owner: TypeScriptLoweringOwner,
    /// Source span.
    pub span: SourceSpan,
}

/// Deterministic TypeScript compatibility plan for one parsed program.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TypeScriptCompatibilityPlan {
    /// Features in source order.
    pub features: Vec<TypeScriptFeature>,
    /// Whether any feature must be handled by Fict before generic OXC lowering.
    pub requires_fict_lowering: bool,
    /// Whether legacy parameter decorator transformation is required.
    pub has_legacy_parameter_decorators: bool,
    /// Whether standard decorators require a target-compatible lowering.
    pub has_standard_decorators: bool,
    /// Whether both decorator profiles occur and therefore require compatibility handling.
    pub has_mixed_decorator_profiles: bool,
    /// AST mutation requires semantic/scoping regeneration before HIR or codegen.
    pub requires_semantic_rebuild: bool,
    /// Explicit runtime namespace declaration segments and member ownership.
    pub namespaces: TypeScriptNamespacePlan,
}

/// Owned namespace compatibility plan in authored source order.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TypeScriptNamespacePlan {
    /// Runtime namespace declaration segments, including merged declarations.
    pub segments: Vec<TypeScriptNamespaceSegment>,
    /// Runtime references that require cross-segment or mutable synchronization.
    pub references: Vec<TypeScriptNamespaceReference>,
}

/// One authored runtime namespace declaration segment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeScriptNamespaceSegment {
    /// Namespace path from the file root.
    pub path: Vec<String>,
    /// Declaration origin.
    pub declaration_span: SourceSpan,
    /// Stable authored order among all namespace segments.
    pub source_order: u32,
    /// Whether another runtime segment owns the same namespace binding.
    pub merged: bool,
    /// Exported and internal members owned by this declaration segment.
    pub members: Vec<TypeScriptNamespaceMember>,
}

/// Binding owned by a TypeScript namespace declaration segment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeScriptNamespaceMember {
    /// Runtime member spelling.
    pub name: String,
    /// Declaration origin.
    pub declaration_span: SourceSpan,
    /// Whether the binding is exported onto the namespace object.
    pub exported: bool,
    /// Whether reads and writes must synchronize through the namespace object.
    pub mutable: bool,
    /// Whether this member is a nested namespace binding.
    pub namespace: bool,
}

/// Namespace member reference owned by the compatibility plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeScriptNamespaceReference {
    /// Namespace path that owns the referenced member.
    pub namespace_path: Vec<String>,
    /// Referenced member spelling.
    pub member: String,
    /// Member declaration origin.
    pub declaration_span: SourceSpan,
    /// Authored reference origin.
    pub reference_span: SourceSpan,
    /// Source segment index in [`TypeScriptNamespacePlan::segments`].
    pub source_segment: u32,
    /// Owning segment index in [`TypeScriptNamespacePlan::segments`].
    pub target_segment: u32,
    /// Whether the reference crosses authored declaration segments.
    pub cross_segment: bool,
    /// Whether the referenced binding is exported by its namespace.
    pub exported: bool,
    /// Whether the namespace object is the canonical mutable storage.
    pub mutable: bool,
    /// Whether this reference writes the member.
    pub write: bool,
}

/// Owned compatibility analysis result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeScriptCompatibilityOutput {
    /// Compatibility plan when parsing and semantic analysis succeed.
    pub plan: Option<TypeScriptCompatibilityPlan>,
    /// Parser, semantic, or unsupported-profile diagnostics.
    pub diagnostics: Vec<Diagnostic>,
}

/// Parse and classify TypeScript compatibility without exposing OXC-owned data.
#[must_use]
pub fn analyze_typescript_compatibility(
    source: &str,
    options: OxcCompileOptions,
) -> TypeScriptCompatibilityOutput {
    let allocator = Allocator::default();
    let parsed = parse_source(&allocator, source, options);
    if !parsed.diagnostics.is_empty() {
        return TypeScriptCompatibilityOutput {
            plan: None,
            diagnostics: sorted(convert_diagnostics(parsed.diagnostics, "FICT-PARSE")),
        };
    }
    let program = parsed.program;
    let semantic = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .with_enum_eval(true)
        .build(&program);
    if semantic.diagnostics.has_errors() {
        return TypeScriptCompatibilityOutput {
            plan: None,
            diagnostics: sorted(convert_diagnostics(semantic.diagnostics, "FICT-SEMANTIC")),
        };
    }

    let plan = plan_typescript_program(
        &program,
        semantic.semantic.scoping(),
        options.module_kind,
        &options.typescript,
    );
    let diagnostics = unsupported_diagnostics(&plan);
    TypeScriptCompatibilityOutput {
        plan: Some(plan),
        diagnostics,
    }
}

pub(crate) fn plan_typescript_program(
    program: &Program<'_>,
    scoping: &Scoping,
    module_kind: OxcModuleKind,
    typescript: &OxcTypeScriptOptions,
) -> TypeScriptCompatibilityPlan {
    let mut collector = CompatibilityCollector {
        module_kind,
        typescript: *typescript,
        ..CompatibilityCollector::default()
    };
    collector.visit_program(program);
    let mut plan = collector.finish();
    plan.namespaces = crate::typescript_namespace::collect_namespace_plan(program, scoping);
    plan
}

pub(crate) fn passthrough_blockers(plan: &TypeScriptCompatibilityPlan) -> Vec<Diagnostic> {
    unsupported_diagnostics(plan)
}

pub(crate) fn configure_transform(
    plan: &TypeScriptCompatibilityPlan,
    typescript: &OxcTypeScriptOptions,
    options: &mut TransformOptions,
) {
    options.typescript.allow_namespaces = typescript.allow_namespaces;
    options.typescript.allow_declare_fields = true;
    options.typescript.only_remove_type_imports = typescript.only_remove_type_imports;
    options.typescript.optimize_const_enums = typescript.optimize_const_enums;
    options.typescript.optimize_enums = typescript.optimize_enums;
    options.typescript.remove_class_fields_without_initializer =
        typescript.remove_class_fields_without_initializer;
    options.typescript.rewrite_import_extensions = typescript
        .rewrite_import_extensions
        .then_some(RewriteExtensionsMode::Rewrite);
    if plan.has_legacy_parameter_decorators && !plan.has_standard_decorators {
        options.decorator = DecoratorOptions {
            legacy: true,
            ..DecoratorOptions::default()
        };
    }
}

pub(crate) fn rewrite_import_equals_extensions<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
) {
    for statement in &mut program.body {
        let Statement::TSImportEqualsDeclaration(declaration) = statement else {
            continue;
        };
        let TSModuleReference::ExternalModuleReference(reference) =
            &mut declaration.module_reference
        else {
            continue;
        };
        let Some(rewritten) = rewrite_typescript_extension(reference.expression.value.as_str())
        else {
            continue;
        };
        reference.expression.value = allocator.alloc_str(&rewritten).into();
        reference.expression.raw = None;
    }
}

fn unsupported_diagnostics(plan: &TypeScriptCompatibilityPlan) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    for feature in &plan.features {
        if feature.owner != TypeScriptLoweringOwner::Unsupported {
            continue;
        }
        let (code, message) = match feature.kind {
            TypeScriptFeatureKind::ImportEquals { external: true } => (
                "FICT-TS-IMPORT-EQUALS",
                "external import-equals requires CommonJS/CTS module mode",
            ),
            TypeScriptFeatureKind::ExportAssignment => (
                "FICT-TS-EXPORT-ASSIGNMENT",
                "TypeScript export assignment requires CommonJS/CTS module mode",
            ),
            TypeScriptFeatureKind::CommonJsTopLevelReturn => (
                "FICT-TS-TOP-LEVEL-RETURN",
                "top-level return requires CommonJS/CTS module mode",
            ),
            TypeScriptFeatureKind::Namespace { .. } => (
                "FICT-TS-NAMESPACE-DISABLED",
                "runtime TypeScript namespaces are disabled by compiler options",
            ),
            TypeScriptFeatureKind::StandardDecorator => (
                "FICT-TS-DECORATOR-STANDARD",
                "standard decorators require a runnable lowering before native emission",
            ),
            _ => (
                "FICT-TS-UNSUPPORTED",
                "unsupported TypeScript source profile",
            ),
        };
        let mut diagnostic = unsupported(code, message, feature.span);
        if code == "FICT-TS-DECORATOR-STANDARD" {
            diagnostic = diagnostic.with_help(
                "lower standard decorators with a target-compatible transform, or remove them, before native Fict compilation",
            );
        }
        diagnostics.push(diagnostic);
    }
    if plan.has_mixed_decorator_profiles {
        let span = plan
            .features
            .iter()
            .find(|feature| {
                matches!(
                    feature.kind,
                    TypeScriptFeatureKind::StandardDecorator
                        | TypeScriptFeatureKind::LegacyParameterDecorator
                )
            })
            .map_or_else(|| SourceSpan::empty(0), |feature| feature.span);
        diagnostics.push(unsupported(
            "FICT-TS-DECORATOR-MIXED",
            "standard decorators and legacy parameter decorators require separate compatibility lowering",
            span,
        ));
    }
    sorted(diagnostics)
}

fn unsupported(code: &'static str, message: &'static str, span: SourceSpan) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("TypeScript diagnostic code must be valid"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_primary_span(span)
    .with_guarantee_class(GuaranteeClass::Unsupported)
}

struct CompatibilityCollector {
    module_kind: OxcModuleKind,
    typescript: OxcTypeScriptOptions,
    features: Vec<TypeScriptFeature>,
    namespace_symbols: Vec<(usize, SymbolId)>,
    namespace_counts: BTreeMap<SymbolId, u32>,
    parameter_decorators: BTreeSet<(u32, u32)>,
    function_depth: u32,
    namespace_depth: u16,
    has_legacy_parameter_decorators: bool,
    has_standard_decorators: bool,
}

impl Default for CompatibilityCollector {
    fn default() -> Self {
        Self {
            module_kind: OxcModuleKind::Module,
            typescript: OxcTypeScriptOptions::default(),
            features: Vec::new(),
            namespace_symbols: Vec::new(),
            namespace_counts: BTreeMap::new(),
            parameter_decorators: BTreeSet::new(),
            function_depth: 0,
            namespace_depth: 0,
            has_legacy_parameter_decorators: false,
            has_standard_decorators: false,
        }
    }
}

impl CompatibilityCollector {
    fn add(&mut self, kind: TypeScriptFeatureKind, owner: TypeScriptLoweringOwner, span: Span) {
        self.features.push(TypeScriptFeature {
            kind,
            owner,
            span: source_span(span),
        });
    }

    fn add_module_source(&mut self, source: &str, span: Span) {
        if self.typescript.rewrite_import_extensions
            && let Some(rewritten) = rewrite_typescript_extension(source)
        {
            self.add(
                TypeScriptFeatureKind::ImportExtension {
                    source: source.into(),
                    rewritten,
                },
                TypeScriptLoweringOwner::Oxc,
                span,
            );
        }
    }

    fn finish(mut self) -> TypeScriptCompatibilityPlan {
        for (feature_index, symbol) in self.namespace_symbols {
            if self.namespace_counts.get(&symbol).copied().unwrap_or(0) <= 1 {
                continue;
            }
            let TypeScriptFeatureKind::Namespace {
                merged,
                has_runtime_body,
                declared,
                ..
            } = &mut self.features[feature_index].kind
            else {
                continue;
            };
            *merged = *has_runtime_body && !*declared;
            if *merged {
                self.features[feature_index].owner = TypeScriptLoweringOwner::FictCompatibility;
            }
        }
        self.features.sort_by_key(|feature| feature.span.start());
        let requires_fict_lowering = self
            .features
            .iter()
            .any(|feature| feature.owner == TypeScriptLoweringOwner::FictCompatibility);
        TypeScriptCompatibilityPlan {
            features: self.features,
            requires_fict_lowering,
            has_legacy_parameter_decorators: self.has_legacy_parameter_decorators,
            has_standard_decorators: self.has_standard_decorators,
            has_mixed_decorator_profiles: self.has_legacy_parameter_decorators
                && self.has_standard_decorators,
            requires_semantic_rebuild: true,
            namespaces: TypeScriptNamespacePlan::default(),
        }
    }
}

impl<'a> Visit<'a> for CompatibilityCollector {
    fn visit_ts_enum_declaration(&mut self, declaration: &TSEnumDeclaration<'a>) {
        self.add(
            TypeScriptFeatureKind::Enum {
                const_enum: declaration.r#const,
                declared: declaration.declare,
            },
            if declaration.declare {
                TypeScriptLoweringOwner::Erase
            } else {
                TypeScriptLoweringOwner::Oxc
            },
            declaration.span,
        );
        walk_ts_enum_declaration(self, declaration);
    }

    fn visit_ts_module_declaration(&mut self, declaration: &TSModuleDeclaration<'a>) {
        self.namespace_depth = self.namespace_depth.saturating_add(1);
        let (name, symbol) = match &declaration.id {
            TSModuleDeclarationName::Identifier(identifier) => {
                (identifier.name.to_string(), identifier.symbol_id.get())
            }
            TSModuleDeclarationName::StringLiteral(literal) => (literal.value.to_string(), None),
        };
        let mutable_export = namespace_has_mutable_export(declaration);
        let has_runtime_body = namespace_has_runtime_body(declaration);
        let owner = if declaration.declare || !has_runtime_body {
            TypeScriptLoweringOwner::Erase
        } else if !self.typescript.allow_namespaces {
            TypeScriptLoweringOwner::Unsupported
        } else if mutable_export {
            TypeScriptLoweringOwner::FictCompatibility
        } else {
            TypeScriptLoweringOwner::Oxc
        };
        let feature_index = self.features.len();
        self.add(
            TypeScriptFeatureKind::Namespace {
                name,
                depth: self.namespace_depth,
                merged: false,
                mutable_export,
                has_runtime_body,
                declared: declaration.declare,
            },
            owner,
            declaration.span,
        );
        if let Some(symbol) = symbol {
            *self.namespace_counts.entry(symbol).or_default() += 1;
            self.namespace_symbols.push((feature_index, symbol));
        }
        walk_ts_module_declaration(self, declaration);
        self.namespace_depth = self.namespace_depth.saturating_sub(1);
    }

    fn visit_formal_parameter(&mut self, parameter: &FormalParameter<'a>) {
        for decorator in &parameter.decorators {
            self.parameter_decorators
                .insert((decorator.span.start, decorator.span.end));
            self.has_legacy_parameter_decorators = true;
            self.add(
                TypeScriptFeatureKind::LegacyParameterDecorator,
                TypeScriptLoweringOwner::Oxc,
                decorator.span,
            );
        }
        walk_formal_parameter(self, parameter);
    }

    fn visit_formal_parameter_rest(&mut self, parameter: &FormalParameterRest<'a>) {
        for decorator in &parameter.decorators {
            self.parameter_decorators
                .insert((decorator.span.start, decorator.span.end));
            self.has_legacy_parameter_decorators = true;
            self.add(
                TypeScriptFeatureKind::LegacyParameterDecorator,
                TypeScriptLoweringOwner::Oxc,
                decorator.span,
            );
        }
        walk_formal_parameter_rest(self, parameter);
    }

    fn visit_decorator(&mut self, decorator: &Decorator<'a>) {
        if !self
            .parameter_decorators
            .contains(&(decorator.span.start, decorator.span.end))
        {
            self.has_standard_decorators = true;
            self.add(
                TypeScriptFeatureKind::StandardDecorator,
                TypeScriptLoweringOwner::Unsupported,
                decorator.span,
            );
        }
        walk_decorator(self, decorator);
    }

    fn visit_property_definition(&mut self, property: &PropertyDefinition<'a>) {
        if property.declare {
            self.add(
                TypeScriptFeatureKind::DeclareClassField,
                TypeScriptLoweringOwner::Erase,
                property.span,
            );
        }
        walk_property_definition(self, property);
    }

    fn visit_ts_import_equals_declaration(&mut self, declaration: &TSImportEqualsDeclaration<'a>) {
        let external = matches!(
            declaration.module_reference,
            TSModuleReference::ExternalModuleReference(_)
        );
        if let TSModuleReference::ExternalModuleReference(reference) = &declaration.module_reference
        {
            self.add_module_source(
                reference.expression.value.as_str(),
                reference.expression.span,
            );
        }
        self.add(
            TypeScriptFeatureKind::ImportEquals { external },
            if external && self.module_kind != OxcModuleKind::CommonJs {
                TypeScriptLoweringOwner::Unsupported
            } else {
                TypeScriptLoweringOwner::Oxc
            },
            declaration.span,
        );
        walk_ts_import_equals_declaration(self, declaration);
    }

    fn visit_ts_export_assignment(&mut self, assignment: &TSExportAssignment<'a>) {
        self.add(
            TypeScriptFeatureKind::ExportAssignment,
            if self.module_kind == OxcModuleKind::CommonJs {
                TypeScriptLoweringOwner::Oxc
            } else {
                TypeScriptLoweringOwner::Unsupported
            },
            assignment.span,
        );
        walk_ts_export_assignment(self, assignment);
    }

    fn visit_import_declaration(&mut self, declaration: &ImportDeclaration<'a>) {
        self.add_module_source(declaration.source.value.as_str(), declaration.source.span);
        if declaration.import_kind == ImportOrExportKind::Type
            || declaration.specifiers.as_ref().is_some_and(|specifiers| {
                specifiers.iter().any(|specifier| {
                    matches!(
                        specifier,
                        ImportDeclarationSpecifier::ImportSpecifier(specifier)
                            if specifier.import_kind == ImportOrExportKind::Type
                    )
                })
            })
        {
            self.add(
                TypeScriptFeatureKind::TypeOnlyImport,
                TypeScriptLoweringOwner::Erase,
                declaration.span,
            );
        }
        walk_import_declaration(self, declaration);
    }

    fn visit_export_named_declaration(&mut self, declaration: &ExportNamedDeclaration<'a>) {
        if let Some(source) = &declaration.source {
            self.add_module_source(source.value.as_str(), source.span);
        }
        walk_export_named_declaration(self, declaration);
    }

    fn visit_export_all_declaration(&mut self, declaration: &ExportAllDeclaration<'a>) {
        self.add_module_source(declaration.source.value.as_str(), declaration.source.span);
        walk_export_all_declaration(self, declaration);
    }

    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        self.function_depth = self.function_depth.saturating_add(1);
        walk_function(self, function, flags);
        self.function_depth = self.function_depth.saturating_sub(1);
    }

    fn visit_arrow_function_expression(&mut self, function: &ArrowFunctionExpression<'a>) {
        self.function_depth = self.function_depth.saturating_add(1);
        walk_arrow_function_expression(self, function);
        self.function_depth = self.function_depth.saturating_sub(1);
    }

    fn visit_return_statement(&mut self, statement: &ReturnStatement<'a>) {
        if self.function_depth == 0 {
            self.add(
                TypeScriptFeatureKind::CommonJsTopLevelReturn,
                if self.module_kind == OxcModuleKind::CommonJs {
                    TypeScriptLoweringOwner::Oxc
                } else {
                    TypeScriptLoweringOwner::Unsupported
                },
                statement.span,
            );
        }
        walk_return_statement(self, statement);
    }
}

fn namespace_has_mutable_export(declaration: &TSModuleDeclaration<'_>) -> bool {
    namespace_statements(declaration).is_some_and(|statements| {
        statements.iter().any(|statement| {
            matches!(
                statement,
                Statement::ExportNamedDeclaration(export)
                    if matches!(
                        export.declaration.as_ref(),
                        Some(Declaration::VariableDeclaration(variable))
                            if variable.kind != VariableDeclarationKind::Const
                    )
            )
        })
    })
}

pub(crate) fn namespace_has_runtime_body(declaration: &TSModuleDeclaration<'_>) -> bool {
    if declaration.declare {
        return false;
    }
    match declaration.body.as_ref() {
        Some(TSModuleDeclarationBody::TSModuleDeclaration(nested)) => {
            namespace_has_runtime_body(nested)
        }
        Some(TSModuleDeclarationBody::TSModuleBlock(block)) => {
            block.body.iter().any(statement_has_runtime)
        }
        None => false,
    }
}

fn namespace_statements<'a>(
    declaration: &'a TSModuleDeclaration<'a>,
) -> Option<&'a [Statement<'a>]> {
    match declaration.body.as_ref()? {
        TSModuleDeclarationBody::TSModuleBlock(block) => Some(&block.body),
        TSModuleDeclarationBody::TSModuleDeclaration(_) => None,
    }
}

fn statement_has_runtime(statement: &Statement<'_>) -> bool {
    match statement {
        Statement::TSTypeAliasDeclaration(_)
        | Statement::TSInterfaceDeclaration(_)
        | Statement::TSGlobalDeclaration(_) => false,
        Statement::TSModuleDeclaration(namespace) => namespace_has_runtime_body(namespace),
        Statement::ExportNamedDeclaration(export) => export
            .declaration
            .as_ref()
            .is_some_and(declaration_has_runtime),
        _ => true,
    }
}

fn declaration_has_runtime(declaration: &Declaration<'_>) -> bool {
    match declaration {
        Declaration::TSTypeAliasDeclaration(_)
        | Declaration::TSInterfaceDeclaration(_)
        | Declaration::TSGlobalDeclaration(_) => false,
        Declaration::TSModuleDeclaration(namespace) => namespace_has_runtime_body(namespace),
        Declaration::VariableDeclaration(declaration) => !declaration.declare,
        Declaration::FunctionDeclaration(declaration) => !declaration.declare,
        Declaration::ClassDeclaration(declaration) => !declaration.declare,
        Declaration::TSEnumDeclaration(declaration) => !declaration.declare,
        Declaration::TSImportEqualsDeclaration(_) => true,
    }
}

fn rewrite_typescript_extension(source: &str) -> Option<String> {
    if !source.starts_with('.') {
        return None;
    }
    if source.contains(['?', '#']) {
        return None;
    }
    let (stem, extension) = source.rsplit_once('.')?;
    let rewritten = match extension.to_ascii_lowercase().as_str() {
        "ts" | "tsx" => "js",
        "mts" => "mjs",
        "cts" => "cjs",
        _ => return None,
    };
    Some(format!("{stem}.{rewritten}"))
}

fn source_span(span: Span) -> SourceSpan {
    SourceSpan::new(span.start, span.end).expect("OXC spans must be ordered")
}
