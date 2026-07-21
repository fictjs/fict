use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::{Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass};
use oxc::{
    allocator::{Allocator, ReplaceWith, Vec as ArenaVec},
    ast::{
        AstBuilder, NONE,
        ast::{
            Argument, BindingIdentifier, Directive, Expression, IdentifierName,
            IdentifierReference, ImportDeclarationSpecifier, Program, Statement,
        },
    },
    ast_visit::{VisitMut, walk_mut},
    parser::Parser,
    semantic::Scoping,
    span::{GetSpan, SourceType, Span},
    syntax::number::NumberBase,
    transformer_plugins::ModuleRunnerTransform,
};
use oxc_traverse::{Ancestor, Traverse, TraverseCtx, traverse_mut};

const RUNNER_IMPORT: &str = "__vite_ssr_import__";
const RUNNER_EXPORTS: &str = "__vite_ssr_exports__";
const RUNNER_EXPORT_ALL: &str = "__vite_ssr_exportAll__";
const RUNNER_DYNAMIC_IMPORT: &str = "__vite_ssr_dynamic_import__";
const RUNNER_IMPORT_META: &str = "__vite_ssr_import_meta__";
const COMMONJS_GENERATED_GLOBAL_BINDINGS: [&str; 8] = [
    "arguments",
    "exports",
    "module",
    "require",
    "__filename",
    "__dirname",
    "Object",
    "WeakMap",
];

/// Lower standard ESM declarations in a CommonJS/CTS request after ordinary OXC transforms.
///
/// OXC 0.139 lowers TypeScript `import =` and `export =` for CommonJS but intentionally does not
/// implement Babel's standard ESM-to-CommonJS transform. Its module-runner transform already owns
/// the difficult binding-aware portion (live imported reads, re-exports, and exported getters), so
/// this adapter converts that runner protocol into synchronous CommonJS primitives.
pub(crate) fn lower_standard_esm_to_commonjs<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    scoping: Scoping,
) -> Result<(), Box<Diagnostic>> {
    if !contains_standard_esm(program) {
        program.source_type = program.source_type.with_commonjs(true);
        return Ok(());
    }

    let mixed_default_namespace_symbols = mixed_default_namespace_symbols(program);
    let original_symbol_names: Vec<_> = scoping.symbol_names().map(str::to_owned).collect();
    let authored_unresolved_references: BTreeSet<_> = scoping
        .root_unresolved_references_ids()
        .flatten()
        .map(|reference_id| reference_id.index())
        .collect();
    let mut runner = ModuleRunnerTransform::new();
    let scoping = traverse_mut(&mut runner, allocator, program, scoping, ());

    let mut reserved_names: BTreeSet<String> = scoping
        .symbol_names()
        .map(str::to_owned)
        .chain(
            scoping
                .root_unresolved_references()
                .keys()
                .map(ToString::to_string),
        )
        .chain(COMMONJS_GENERATED_GLOBAL_BINDINGS.map(str::to_owned))
        .collect();
    let generated_bindings = generated_binding_names(
        allocator,
        &scoping,
        &original_symbol_names,
        &mut reserved_names,
    );
    let mixed_default_namespace_bindings = mixed_default_namespace_symbols
        .into_iter()
        .filter_map(|(default_symbol, namespace_symbol)| {
            generated_bindings
                .get(&namespace_symbol)
                .copied()
                .map(|namespace_name| (default_symbol, namespace_name))
        })
        .collect();
    let require_local = allocate_name(allocator, &mut reserved_names, "__fict_cjs_require");
    let static_import_local = allocate_name(allocator, &mut reserved_names, "__fict_cjs_load");
    let namespace_cache_local =
        allocate_name(allocator, &mut reserved_names, "__fict_cjs_namespace_cache");
    let exports_local = allocate_name(allocator, &mut reserved_names, "__fict_cjs_exports");
    let export_all_local = allocate_name(allocator, &mut reserved_names, "__fict_cjs_export_all");
    let dynamic_import_local =
        allocate_name(allocator, &mut reserved_names, "__fict_cjs_dynamic_import");
    let import_meta_local = allocate_name(allocator, &mut reserved_names, "__fict_cjs_import_meta");

    let mut adapter = CommonJsRunnerAdapter {
        allocator,
        authored_unresolved_references,
        generated_bindings,
        mixed_default_namespace_bindings,
        require_local,
        static_import_local,
        namespace_cache_local,
        exports_local,
        export_all_local,
        dynamic_import_local,
        import_meta_local,
        uses_require: false,
        uses_static_import: false,
        uses_exports: false,
        uses_export_all: false,
        uses_dynamic_import: false,
        uses_import_meta: false,
    };
    let _ = traverse_mut(&mut adapter, allocator, program, scoping, ());

    inject_commonjs_prelude(allocator, program, &adapter)?;
    program.source_type = program.source_type.with_commonjs(true);
    Ok(())
}

fn mixed_default_namespace_symbols(program: &Program<'_>) -> BTreeMap<usize, usize> {
    let mut bindings = BTreeMap::new();
    for statement in &program.body {
        let Statement::ImportDeclaration(declaration) = statement else {
            continue;
        };
        let Some(specifiers) = &declaration.specifiers else {
            continue;
        };
        let default_symbol = specifiers.iter().find_map(|specifier| {
            let ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) = specifier else {
                return None;
            };
            specifier.local.symbol_id.get().map(|symbol| symbol.index())
        });
        let namespace_symbol = specifiers.iter().find_map(|specifier| {
            let ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) = specifier else {
                return None;
            };
            specifier.local.symbol_id.get().map(|symbol| symbol.index())
        });
        if let (Some(default_symbol), Some(namespace_symbol)) = (default_symbol, namespace_symbol) {
            bindings.insert(default_symbol, namespace_symbol);
        }
    }
    bindings
}

fn contains_standard_esm(program: &Program<'_>) -> bool {
    program.source_type.is_module()
        || program.body.iter().any(|statement| {
            matches!(
                statement,
                Statement::ImportDeclaration(_)
                    | Statement::ExportAllDeclaration(_)
                    | Statement::ExportNamedDeclaration(_)
                    | Statement::ExportDefaultDeclaration(_)
            )
        })
}

fn generated_binding_names<'a>(
    allocator: &'a Allocator,
    scoping: &Scoping,
    original_symbol_names: &[String],
    reserved_names: &mut BTreeSet<String>,
) -> BTreeMap<usize, &'a str> {
    let mut names = BTreeMap::new();
    let root_scope = scoping.root_scope_id();
    for symbol_id in scoping.symbol_ids() {
        let index = symbol_id.index();
        let current = scoping.symbol_name(symbol_id);
        let generated_global_binding = scoping.symbol_scope_id(symbol_id) == root_scope
            && COMMONJS_GENERATED_GLOBAL_BINDINGS.contains(&current);
        let runner_created = index >= original_symbol_names.len();
        let runner_renamed = original_symbol_names
            .get(index)
            .is_some_and(|original| original != current && current.starts_with("__vite_ssr_"));
        if runner_created || runner_renamed || generated_global_binding {
            let preferred = if generated_global_binding {
                format!("__fict_cjs_user_{}", current.trim_start_matches('_'))
            } else if current.contains("import") {
                "__fict_cjs_import".to_owned()
            } else if current.contains("default") {
                "__fict_cjs_default".to_owned()
            } else {
                "__fict_cjs_binding".to_owned()
            };
            names.insert(index, allocate_name(allocator, reserved_names, &preferred));
        }
    }
    names
}

fn allocate_name<'a>(
    allocator: &'a Allocator,
    reserved_names: &mut BTreeSet<String>,
    preferred: &str,
) -> &'a str {
    if reserved_names.insert(preferred.to_owned()) {
        return allocator.alloc_str(preferred);
    }
    let mut index = 1_u32;
    loop {
        let candidate = format!("{preferred}_{index}");
        if reserved_names.insert(candidate.clone()) {
            return allocator.alloc_str(&candidate);
        }
        index = index.saturating_add(1);
    }
}

struct CommonJsRunnerAdapter<'a> {
    allocator: &'a Allocator,
    authored_unresolved_references: BTreeSet<usize>,
    generated_bindings: BTreeMap<usize, &'a str>,
    mixed_default_namespace_bindings: BTreeMap<usize, &'a str>,
    require_local: &'a str,
    static_import_local: &'a str,
    namespace_cache_local: &'a str,
    exports_local: &'a str,
    export_all_local: &'a str,
    dynamic_import_local: &'a str,
    import_meta_local: &'a str,
    uses_require: bool,
    uses_static_import: bool,
    uses_exports: bool,
    uses_export_all: bool,
    uses_dynamic_import: bool,
    uses_import_meta: bool,
}

impl<'a> Traverse<'a, ()> for CommonJsRunnerAdapter<'a> {
    fn enter_expression(&mut self, expression: &mut Expression<'a>, ctx: &mut TraverseCtx<'a, ()>) {
        if let Expression::Identifier(identifier) = expression {
            let namespace_name = identifier
                .reference_id
                .get()
                .and_then(|reference_id| ctx.scoping().get_reference(reference_id).symbol_id())
                .and_then(|symbol_id| {
                    self.mixed_default_namespace_bindings
                        .get(&symbol_id.index())
                })
                .copied();
            if let Some(namespace_name) = namespace_name {
                let span = identifier.span;
                let builder = AstBuilder::new(self.allocator);
                let namespace = Expression::new_identifier(
                    span,
                    self.allocator.alloc_str(namespace_name),
                    &builder,
                );
                let default = Expression::new_static_member_expression(
                    span,
                    namespace,
                    IdentifierName::new(span, self.allocator.alloc_str("default"), &builder),
                    false,
                    &builder,
                );
                *expression = if matches!(ctx.parent(), Ancestor::CallExpressionCallee(_)) {
                    let zero = Expression::new_numeric_literal(
                        span,
                        0.0,
                        None,
                        NumberBase::Decimal,
                        &builder,
                    );
                    Expression::new_sequence_expression(
                        span,
                        ArenaVec::from_array_in([zero, default], &self.allocator),
                        &builder,
                    )
                } else {
                    default
                };
                return;
            }
        }
        let Expression::AwaitExpression(awaited) = expression else {
            return;
        };
        let Expression::CallExpression(call) = &mut awaited.argument else {
            return;
        };
        if !callee_is_runner_import(&call.callee, &self.authored_unresolved_references) {
            return;
        }
        if let Some(source) = call
            .arguments
            .first_mut()
            .and_then(Argument::as_expression_mut)
        {
            let builder = AstBuilder::new(self.allocator);
            let span = source.span();
            source.replace_with(|source| {
                let callee =
                    Expression::new_identifier(span, self.allocator.alloc_str("require"), &builder);
                let mut arguments = ArenaVec::new_in(&self.allocator);
                arguments.push(Argument::from(source));
                Expression::new_call_expression(span, callee, NONE, arguments, false, &builder)
            });
        }
        expression.replace_with(|expression| {
            let Expression::AwaitExpression(awaited) = expression else {
                unreachable!("checked runner await expression")
            };
            awaited.unbox().argument
        });
    }

    fn enter_binding_identifier(
        &mut self,
        identifier: &mut BindingIdentifier<'a>,
        _ctx: &mut TraverseCtx<'a, ()>,
    ) {
        let Some(symbol_id) = identifier.symbol_id.get() else {
            return;
        };
        if let Some(name) = self.generated_bindings.get(&symbol_id.index()) {
            identifier.name = (*name).into();
        }
    }

    fn enter_identifier_reference(
        &mut self,
        identifier: &mut IdentifierReference<'a>,
        ctx: &mut TraverseCtx<'a, ()>,
    ) {
        let symbol_id = identifier
            .reference_id
            .get()
            .and_then(|reference_id| ctx.scoping().get_reference(reference_id).symbol_id());
        if let Some(symbol_id) = symbol_id {
            if let Some(name) = self.generated_bindings.get(&symbol_id.index()) {
                identifier.name = (*name).into();
            }
            return;
        }
        if authored_unresolved_reference(identifier, &self.authored_unresolved_references) {
            return;
        }

        let replacement = match identifier.name.as_str() {
            RUNNER_IMPORT => {
                self.uses_static_import = true;
                self.static_import_local
            }
            RUNNER_EXPORTS => {
                self.uses_exports = true;
                self.exports_local
            }
            RUNNER_EXPORT_ALL => {
                self.uses_exports = true;
                self.uses_export_all = true;
                self.export_all_local
            }
            RUNNER_DYNAMIC_IMPORT => {
                self.uses_dynamic_import = true;
                self.dynamic_import_local
            }
            RUNNER_IMPORT_META => {
                self.uses_require = true;
                self.uses_import_meta = true;
                self.import_meta_local
            }
            _ => return,
        };
        identifier.name = self.allocator.alloc_str(replacement).into();
        identifier.reference_id.set(None);
    }
}

fn authored_unresolved_reference(
    identifier: &IdentifierReference<'_>,
    authored_unresolved_references: &BTreeSet<usize>,
) -> bool {
    identifier
        .reference_id
        .get()
        .is_some_and(|reference_id| authored_unresolved_references.contains(&reference_id.index()))
}

fn callee_is_runner_import(
    expression: &Expression<'_>,
    authored_unresolved_references: &BTreeSet<usize>,
) -> bool {
    matches!(
        expression,
        Expression::Identifier(identifier)
            if identifier.name == RUNNER_IMPORT
                && !authored_unresolved_reference(identifier, authored_unresolved_references)
    )
}

fn inject_commonjs_prelude<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    adapter: &CommonJsRunnerAdapter<'a>,
) -> Result<(), Box<Diagnostic>> {
    if !program.has_use_strict_directive() {
        let builder = AstBuilder::new(allocator);
        program
            .directives
            .insert(0, Directive::new_use_strict(&builder));
    }

    let mut sources = Vec::new();
    if adapter.uses_require {
        sources.push(format!("const {} = require;", adapter.require_local));
    }
    if adapter.uses_static_import {
        sources.push(format!(
            "const {} = new WeakMap();",
            adapter.namespace_cache_local
        ));
        sources.push(format!(
            "const {} = (value, metadata) => {{ const needsNamespace = !metadata || !metadata.importedNames || metadata.importedNames.includes(\"default\"); if (!needsNamespace || (value && value.__esModule)) return value; const objectLike = value !== null && (typeof value === \"object\" || typeof value === \"function\"); if (objectLike) {{ const cached = {}.get(value); if (cached) return cached; }} const wrapper = Object.create(null); if (objectLike) {{ for (const key in value) {{ if (key === \"default\" || !Object.prototype.hasOwnProperty.call(value, key)) continue; const descriptor = Object.getOwnPropertyDescriptor(value, key); if (descriptor && (descriptor.get || descriptor.set)) Object.defineProperty(wrapper, key, descriptor); else wrapper[key] = value[key]; }} }} Object.defineProperty(wrapper, \"default\", {{ enumerable: true, value }}); if (objectLike) {}.set(value, wrapper); return wrapper; }};",
            adapter.static_import_local,
            adapter.namespace_cache_local,
            adapter.namespace_cache_local
        ));
    }
    if adapter.uses_exports {
        sources.push(format!("const {} = exports;", adapter.exports_local));
        sources.push(format!(
            "Object.defineProperty({}, \"__esModule\", {{ value: true }});",
            adapter.exports_local
        ));
    }
    if adapter.uses_export_all {
        sources.push(format!(
            "const {} = source => {{ for (const key of Object.keys(source)) {{ if (key !== \"default\" && key !== \"__esModule\" && !Object.prototype.hasOwnProperty.call({}, key)) {{ Object.defineProperty({}, key, {{ enumerable: true, configurable: true, get() {{ return source[key]; }} }}); }} }} }};",
            adapter.export_all_local, adapter.exports_local, adapter.exports_local
        ));
    }
    if adapter.uses_dynamic_import {
        sources.push(format!(
            "const {} = (source, options) => options === void 0 ? import(source) : import(source, options);",
            adapter.dynamic_import_local
        ));
    }
    if adapter.uses_import_meta {
        sources.push(format!(
            "const {} = {{ url: {}(\"node:url\").pathToFileURL(__filename).href }};",
            adapter.import_meta_local, adapter.require_local
        ));
    }
    if sources.is_empty() {
        return Ok(());
    }

    let source = allocator.alloc_str(&sources.join("\n"));
    let parsed = Parser::new(allocator, source, SourceType::cjs()).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(Box::new(commonjs_error(
            "generated CommonJS compatibility prelude did not parse",
        )));
    }
    let mut prelude = parsed.program;
    ZeroSpans.visit_program(&mut prelude);
    for statement in prelude.body.into_iter().rev() {
        program.body.insert(0, statement);
    }
    Ok(())
}

fn commonjs_error(message: &'static str) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new("FICT-OXC-CJS").expect("diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(GuaranteeClass::Internal)
}

struct ZeroSpans;

impl<'a> VisitMut<'a> for ZeroSpans {
    fn visit_span(&mut self, span: &mut Span) {
        *span = Span::default();
    }

    fn visit_program(&mut self, program: &mut Program<'a>) {
        walk_mut::walk_program(self, program);
    }
}
