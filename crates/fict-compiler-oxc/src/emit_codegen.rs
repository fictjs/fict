use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use fict_diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use fict_emit::{EmitOperation, EmitProgram, RuntimeHelper};
use fict_hir::{CompoundAssignmentOperator, UpdateOperator};
use oxc::{
    allocator::{Allocator, TakeIn, Vec as ArenaVec},
    ast::{
        AstBuilder, NONE,
        ast::{
            Argument, ArrowFunctionExpression, AssignmentTarget, BindingPattern, Expression,
            FormalParameter, FormalParameterKind, FormalParameters, Function, FunctionBody,
            ImportDeclarationSpecifier, ImportOrExportKind, SimpleAssignmentTarget, Statement,
        },
    },
    ast_visit::{VisitMut, walk_mut},
    codegen::{Codegen, CodegenOptions},
    parser::{ParseOptions, Parser},
    semantic::SemanticBuilder,
    span::{GetSpan, SourceType, Span},
    syntax::{
        number::NumberBase,
        operator::{BinaryOperator as OxcBinaryOperator, LogicalOperator as OxcLogicalOperator},
        scope::ScopeFlags,
    },
    transformer::{JsxOptions, Module, TransformOptions, Transformer},
};

use crate::{OxcCompileOptions, OxcCompileOutput, OxcModuleKind};

use super::compile::{convert_diagnostics, failed_output, sorted, source_type};
use super::typescript::{configure_transform, passthrough_blockers, plan_typescript_program};

/// Lower the currently supported EmitIR subset into the original OXC program, run TypeScript
/// lowering and OXC code generation, and parse the generated JavaScript again as a hard backend
/// invariant.
#[must_use]
pub fn emit_program(
    source: &str,
    filename: &str,
    options: OxcCompileOptions,
    emit: &EmitProgram,
) -> OxcCompileOutput {
    let mut diagnostics = unsupported_operations(emit);
    if source_type(options).is_jsx() {
        diagnostics.push(emit_error(
            "FICT-OXC-EMIT-JSX",
            "OXC output emission requires JSX to be fully represented by supported EmitIR operations",
            GuaranteeClass::Unsupported,
        ));
    }
    if options.module_kind == OxcModuleKind::Script && !emit.imports.is_empty() {
        diagnostics.push(emit_error(
            "FICT-OXC-EMIT-SCRIPT-IMPORT",
            "runtime helper imports cannot be injected into classic script output",
            GuaranteeClass::Unsupported,
        ));
    }
    if !diagnostics.is_empty() {
        return failed_output(diagnostics);
    }

    let import_source = render_runtime_imports(emit);
    let (context_sources, context_diagnostics) = render_context_sources(emit);
    diagnostics.extend(context_diagnostics);
    if !diagnostics.is_empty() {
        return failed_output(diagnostics);
    }
    let allocator = Allocator::default();
    let input_source_type = source_type(options);
    let parsed = Parser::new(&allocator, source, input_source_type)
        .with_options(ParseOptions {
            allow_return_outside_function: options.module_kind == OxcModuleKind::CommonJs,
            ..ParseOptions::default()
        })
        .parse();
    if !parsed.diagnostics.is_empty() {
        return failed_output(convert_diagnostics(parsed.diagnostics, "FICT-PARSE"));
    }
    let mut program = parsed.program;
    let context_declarations = match parse_context_declarations(&allocator, &context_sources) {
        Ok(declarations) => declarations,
        Err(findings) => return failed_output(findings),
    };

    strip_compiler_macro_imports(&mut program);

    let (rewrites, rewrite_diagnostics) = call_rewrites(emit);
    let (reads, read_diagnostics) = read_rewrites(emit);
    let (mutations, mutation_diagnostics) = mutation_rewrites(emit);
    diagnostics.extend(rewrite_diagnostics);
    diagnostics.extend(read_diagnostics);
    diagnostics.extend(mutation_diagnostics);
    if !diagnostics.is_empty() {
        return failed_output(diagnostics);
    }
    let mut rewriter = AstRewriter {
        allocator: &allocator,
        call_rewrites: &rewrites,
        reads: &reads,
        mutations: &mutations,
        context_declarations,
        matched_calls: BTreeSet::new(),
        matched_reads: BTreeSet::new(),
        matched_mutations: BTreeSet::new(),
    };
    rewriter.visit_program(&mut program);
    for location in rewrites.keys() {
        if !rewriter.matched_calls.contains(location) {
            diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-ORIGIN",
                    "EmitIR call origin does not identify an OXC call expression",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(
                    SourceSpan::new(location.0, location.1)
                        .expect("ordered EmitIR rewrite location"),
                ),
            );
        }
    }
    for location in &reads {
        if !rewriter.matched_reads.contains(location) {
            diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-ORIGIN",
                    "EmitIR reactive-read origin does not identify an OXC identifier expression",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(
                    SourceSpan::new(location.0, location.1).expect("ordered EmitIR read location"),
                ),
            );
        }
    }
    for location in mutations.keys() {
        if !rewriter.matched_mutations.contains(location) {
            diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-ORIGIN",
                    "EmitIR reactive-mutation origin does not identify a supported OXC assignment or update expression",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(
                    SourceSpan::new(location.0, location.1)
                        .expect("ordered EmitIR mutation location"),
                ),
            );
        }
    }
    for location in rewriter.context_declarations.keys() {
        diagnostics.push(
            emit_error(
                "FICT-OXC-EMIT-CONTEXT",
                "EmitIR function context origin does not identify a function body",
                GuaranteeClass::Internal,
            )
            .with_primary_span(
                SourceSpan::new(location.0, location.1).expect("ordered EmitIR context location"),
            ),
        );
    }
    if !diagnostics.is_empty() {
        return failed_output(diagnostics);
    }

    if !import_source.is_empty() {
        let parsed_imports = Parser::new(&allocator, &import_source, SourceType::mjs()).parse();
        if !parsed_imports.diagnostics.is_empty() {
            return failed_output(convert_diagnostics(
                parsed_imports.diagnostics,
                "FICT-OXC-EMIT-IMPORT",
            ));
        }
        let mut import_program = parsed_imports.program;
        ZeroSpans.visit_program(&mut import_program);
        for statement in import_program.body.into_iter().rev() {
            program.body.insert(0, statement);
        }
    }

    let semantic = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .with_enum_eval(true)
        .build(&program);
    let semantic_has_errors = semantic.diagnostics.has_errors();
    diagnostics.extend(convert_diagnostics(
        semantic.diagnostics,
        "FICT-SEMANTIC-EMIT",
    ));
    if semantic_has_errors {
        return failed_output(diagnostics);
    }

    let typescript_plan = input_source_type
        .is_typescript()
        .then(|| plan_typescript_program(&program, options.module_kind, &options.typescript));
    if let Some(plan) = &typescript_plan {
        let blockers = passthrough_blockers(plan);
        if !blockers.is_empty() {
            diagnostics.extend(blockers);
            return failed_output(diagnostics);
        }
    }
    let mut transform_options = TransformOptions {
        jsx: JsxOptions::disable(),
        ..TransformOptions::default()
    };
    if options.module_kind == OxcModuleKind::CommonJs {
        transform_options.env.module = Module::CommonJS;
    }
    if let Some(plan) = &typescript_plan {
        configure_transform(plan, &options.typescript, &mut transform_options);
    }
    let transformed = Transformer::new(&allocator, Path::new(filename), &transform_options)
        .build_with_scoping(semantic.semantic.into_scoping(), &mut program);
    let transform_has_errors = transformed.diagnostics.has_errors();
    diagnostics.extend(convert_diagnostics(
        transformed.diagnostics,
        "FICT-TRANSFORM-EMIT",
    ));
    if transform_has_errors {
        return failed_output(diagnostics);
    }

    let rebuilt = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .with_enum_eval(true)
        .build(&program);
    let rebuilt_has_errors = rebuilt.diagnostics.has_errors();
    diagnostics.extend(convert_diagnostics(
        rebuilt.diagnostics,
        "FICT-SEMANTIC-POST-EMIT",
    ));
    if rebuilt_has_errors {
        return failed_output(diagnostics);
    }

    let generated = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: options.sourcemap.then(|| PathBuf::from(filename)),
            ..CodegenOptions::default()
        })
        .with_source_text(source)
        .with_source_type(input_source_type)
        .with_scoping(Some(rebuilt.semantic.into_scoping()))
        .build(&program);

    let validation_type = output_source_type(options.module_kind);
    let validation = Parser::new(&allocator, &generated.code, validation_type)
        .with_options(ParseOptions {
            allow_return_outside_function: options.module_kind == OxcModuleKind::CommonJs,
            ..ParseOptions::default()
        })
        .parse();
    if !validation.diagnostics.is_empty() {
        diagnostics.extend(convert_diagnostics(
            validation.diagnostics,
            "FICT-OXC-EMIT-REPARSE",
        ));
        return failed_output(diagnostics);
    }
    let validation_semantic = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .build(&validation.program);
    let validation_has_errors = validation_semantic.diagnostics.has_errors();
    diagnostics.extend(convert_diagnostics(
        validation_semantic.diagnostics,
        "FICT-OXC-EMIT-REPARSE-SEMANTIC",
    ));
    if validation_has_errors {
        return failed_output(diagnostics);
    }

    OxcCompileOutput {
        code: generated.code,
        source_map_json: generated.map.map(|map| map.to_json_string()),
        diagnostics: sorted(diagnostics),
    }
}

fn strip_compiler_macro_imports(program: &mut oxc::ast::ast::Program<'_>) {
    program.body.retain_mut(|statement| {
        let Statement::ImportDeclaration(declaration) = statement else {
            return true;
        };
        if declaration.import_kind == ImportOrExportKind::Type {
            return true;
        }
        let source = declaration.source.value.to_string();
        let Some(specifiers) = &mut declaration.specifiers else {
            return true;
        };
        let original_len = specifiers.len();
        specifiers.retain(|specifier| {
            let ImportDeclarationSpecifier::ImportSpecifier(specifier) = specifier else {
                return true;
            };
            specifier.import_kind == ImportOrExportKind::Type
                || super::frontend::macro_kind(&source, specifier.imported.name().as_str())
                    .is_none()
        });
        original_len == specifiers.len() || !specifiers.is_empty()
    });
}

fn unsupported_operations(emit: &EmitProgram) -> Vec<Diagnostic> {
    let unsupported_scoped_helper = emit.functions.iter().find(|function| {
        function.context.is_none()
            && function
                .operations
                .iter()
                .filter_map(EmitOperation::helper)
                .any(is_scoped_helper)
    });
    if let Some(function) = unsupported_scoped_helper {
        let mut diagnostic = emit_error(
            "FICT-OXC-EMIT-CONTEXT",
            "component and hook runtime helpers require a function context plan",
            GuaranteeClass::Unsupported,
        );
        diagnostic.primary_span = function.operations.iter().find_map(|operation| {
            operation
                .helper()
                .filter(|helper| is_scoped_helper(*helper))
                .and(operation_origin(operation).primary_span)
        });
        return vec![diagnostic];
    }
    let unsupported = emit
        .functions
        .iter()
        .flat_map(|function| &function.operations)
        .find(|operation| match operation {
            EmitOperation::ReadReactive { projections, .. }
            | EmitOperation::WriteReactive { projections, .. } => !projections.is_empty(),
            EmitOperation::UpdateReactive { projections, .. } => !projections.is_empty(),
            _ => matches!(
                operation,
                EmitOperation::CreateVNode { .. }
                    | EmitOperation::DeclareTemplate { .. }
                    | EmitOperation::CloneTemplate { .. }
                    | EmitOperation::ResolveElement { .. }
                    | EmitOperation::InvokeComponent { .. }
                    | EmitOperation::CreateElement { .. }
                    | EmitOperation::BindDom { .. }
                    | EmitOperation::ApplyProps { .. }
                    | EmitOperation::BindEvent { .. }
                    | EmitOperation::BindRef { .. }
                    | EmitOperation::Insert { .. }
                    | EmitOperation::Conditional { .. }
                    | EmitOperation::KeyedList { .. }
            ),
        });
    unsupported.map_or_else(Vec::new, |operation| {
        let mut diagnostic = emit_error(
            "FICT-OXC-EMIT-UNSUPPORTED",
            "EmitIR contains an operation not yet materialized by the OXC output adapter",
            GuaranteeClass::Unsupported,
        );
        diagnostic.primary_span = operation_origin(operation).primary_span;
        vec![diagnostic]
    })
}

fn is_scoped_helper(helper: RuntimeHelper) -> bool {
    matches!(
        helper,
        RuntimeHelper::UseSignal | RuntimeHelper::UseMemo | RuntimeHelper::UseEffect
    )
}

#[derive(Debug, Clone)]
struct CallRewrite {
    local: String,
    context: Option<String>,
}

fn call_rewrites(emit: &EmitProgram) -> (BTreeMap<(u32, u32), CallRewrite>, Vec<Diagnostic>) {
    let helper_names: BTreeMap<_, _> = emit
        .imports
        .iter()
        .map(|intent| (intent.helper, intent.local.as_str()))
        .collect();
    let mut rewrites = BTreeMap::new();
    let mut diagnostics = Vec::new();
    for function in &emit.functions {
        for operation in &function.operations {
            let helper = match operation {
                EmitOperation::CreateReactive { helper, .. }
                | EmitOperation::RegisterEffect { helper, .. } => Some(*helper),
                _ => None,
            };
            let Some(helper) = helper else {
                continue;
            };
            let Some(span) = operation_origin(operation).primary_span else {
                diagnostics.push(emit_error(
                    "FICT-OXC-EMIT-ORIGIN",
                    "call-lowering EmitIR operation requires a source origin",
                    GuaranteeClass::Internal,
                ));
                continue;
            };
            let Some(local) = helper_names.get(&helper) else {
                diagnostics.push(emit_error(
                    "FICT-OXC-EMIT-IMPORT",
                    "call-lowering helper has no runtime import intent",
                    GuaranteeClass::Internal,
                ));
                continue;
            };
            let context = is_scoped_helper(helper)
                .then(|| {
                    function
                        .context
                        .as_ref()
                        .map(|context| context.local.clone())
                })
                .flatten();
            if is_scoped_helper(helper) && context.is_none() {
                diagnostics.push(
                    emit_error(
                        "FICT-OXC-EMIT-CONTEXT",
                        "scoped call-lowering helper has no function context plan",
                        GuaranteeClass::Internal,
                    )
                    .with_primary_span(span),
                );
                continue;
            }
            if rewrites
                .insert(
                    (span.start(), span.end()),
                    CallRewrite {
                        local: (*local).to_owned(),
                        context,
                    },
                )
                .is_some()
            {
                diagnostics.push(
                    emit_error(
                        "FICT-OXC-EMIT-ORIGIN",
                        "multiple call-lowering operations share the same source origin",
                        GuaranteeClass::Internal,
                    )
                    .with_primary_span(span),
                );
            }
        }
    }
    (rewrites, diagnostics)
}

fn read_rewrites(emit: &EmitProgram) -> (BTreeSet<(u32, u32)>, Vec<Diagnostic>) {
    let mut reads = BTreeSet::new();
    let mut diagnostics = Vec::new();
    for operation in emit
        .functions
        .iter()
        .flat_map(|function| &function.operations)
    {
        let EmitOperation::ReadReactive { origin, .. } = operation else {
            continue;
        };
        let Some(span) = origin.primary_span else {
            diagnostics.push(emit_error(
                "FICT-OXC-EMIT-ORIGIN",
                "reactive-read EmitIR operation requires a source origin",
                GuaranteeClass::Internal,
            ));
            continue;
        };
        if !reads.insert((span.start(), span.end())) {
            diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-ORIGIN",
                    "multiple reactive-read operations share the same source origin",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(span),
            );
        }
    }
    (reads, diagnostics)
}

#[derive(Debug, Clone, Copy)]
enum MutationRewrite {
    Write,
    Compound(CompoundAssignmentOperator),
    Update {
        operator: UpdateOperator,
        prefix: bool,
    },
}

fn mutation_rewrites(
    emit: &EmitProgram,
) -> (BTreeMap<(u32, u32), MutationRewrite>, Vec<Diagnostic>) {
    let mut mutations = BTreeMap::new();
    let mut diagnostics = Vec::new();
    for operation in emit
        .functions
        .iter()
        .flat_map(|function| &function.operations)
    {
        let (origin, rewrite) = match operation {
            EmitOperation::WriteReactive { origin, .. } => (origin, MutationRewrite::Write),
            EmitOperation::UpdateReactive {
                origin,
                compound: Some(operator),
                update: None,
                ..
            } => (origin, MutationRewrite::Compound(*operator)),
            EmitOperation::UpdateReactive {
                origin,
                compound: None,
                update: Some(operator),
                prefix,
                ..
            } => (
                origin,
                MutationRewrite::Update {
                    operator: *operator,
                    prefix: *prefix,
                },
            ),
            _ => continue,
        };
        let Some(span) = origin.primary_span else {
            diagnostics.push(emit_error(
                "FICT-OXC-EMIT-ORIGIN",
                "reactive-mutation EmitIR operation requires a source origin",
                GuaranteeClass::Internal,
            ));
            continue;
        };
        if mutations
            .insert((span.start(), span.end()), rewrite)
            .is_some()
        {
            diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-ORIGIN",
                    "multiple reactive-mutation operations share the same source origin",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(span),
            );
        }
    }
    (mutations, diagnostics)
}

fn render_runtime_imports(emit: &EmitProgram) -> String {
    let mut output = String::new();
    for intent in &emit.imports {
        output.push_str("import { ");
        output.push_str(&intent.imported);
        if intent.imported != intent.local {
            output.push_str(" as ");
            output.push_str(&intent.local);
        }
        output.push_str(" } from ");
        output.push_str(&format!("{:?}", intent.module_request));
        output.push_str(";\n");
    }
    output
}

#[derive(Debug)]
struct ContextSource {
    location: (u32, u32),
    source: String,
}

fn render_context_sources(emit: &EmitProgram) -> (Vec<ContextSource>, Vec<Diagnostic>) {
    let helper_names: BTreeMap<_, _> = emit
        .imports
        .iter()
        .map(|intent| (intent.helper, intent.local.as_str()))
        .collect();
    let mut sources = Vec::new();
    let mut diagnostics = Vec::new();
    let mut locations = BTreeSet::new();
    for context in emit
        .functions
        .iter()
        .filter_map(|function| function.context.as_ref())
    {
        let Some(span) = context.origin.primary_span else {
            diagnostics.push(emit_error(
                "FICT-OXC-EMIT-CONTEXT",
                "function context plan requires a source function origin",
                GuaranteeClass::Internal,
            ));
            continue;
        };
        let location = (span.start(), span.end());
        if !locations.insert(location) {
            diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-CONTEXT",
                    "multiple function context plans share the same source origin",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(span),
            );
            continue;
        }
        let Some(helper) = helper_names.get(&context.helper) else {
            diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-IMPORT",
                    "function context helper has no runtime import intent",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(span),
            );
            continue;
        };
        sources.push(ContextSource {
            location,
            source: format!("const {} = {}();", context.local, helper),
        });
    }
    (sources, diagnostics)
}

fn parse_context_declarations<'a>(
    allocator: &'a Allocator,
    sources: &'a [ContextSource],
) -> Result<BTreeMap<(u32, u32), Statement<'a>>, Vec<Diagnostic>> {
    let mut declarations = BTreeMap::new();
    for source in sources {
        let parsed = Parser::new(allocator, &source.source, SourceType::mjs()).parse();
        if !parsed.diagnostics.is_empty() {
            return Err(convert_diagnostics(
                parsed.diagnostics,
                "FICT-OXC-EMIT-CONTEXT",
            ));
        }
        let mut program = parsed.program;
        if program.body.len() != 1 {
            return Err(vec![emit_error(
                "FICT-OXC-EMIT-CONTEXT",
                "generated function context declaration did not parse as one statement",
                GuaranteeClass::Internal,
            )]);
        }
        ZeroSpans.visit_program(&mut program);
        let statement = program.body.pop().expect("one context statement");
        declarations.insert(source.location, statement);
    }
    Ok(declarations)
}

struct AstRewriter<'a, 'emit> {
    allocator: &'a Allocator,
    call_rewrites: &'emit BTreeMap<(u32, u32), CallRewrite>,
    reads: &'emit BTreeSet<(u32, u32)>,
    mutations: &'emit BTreeMap<(u32, u32), MutationRewrite>,
    context_declarations: BTreeMap<(u32, u32), Statement<'a>>,
    matched_calls: BTreeSet<(u32, u32)>,
    matched_reads: BTreeSet<(u32, u32)>,
    matched_mutations: BTreeSet<(u32, u32)>,
}

impl<'a> VisitMut<'a> for AstRewriter<'a, '_> {
    fn visit_function(&mut self, function: &mut Function<'a>, flags: ScopeFlags) {
        let location = (function.span.start, function.span.end);
        if let Some(body) = &mut function.body
            && let Some(declaration) = self.context_declarations.remove(&location)
        {
            body.statements.insert(0, declaration);
        }
        walk_mut::walk_function(self, function, flags);
    }

    fn visit_arrow_function_expression(&mut self, function: &mut ArrowFunctionExpression<'a>) {
        let location = (function.span.start, function.span.end);
        if !function.expression
            && let Some(declaration) = self.context_declarations.remove(&location)
        {
            function.body.statements.insert(0, declaration);
        }
        walk_mut::walk_arrow_function_expression(self, function);
    }

    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        let location = (expression.span().start, expression.span().end);
        if let Some(rewrite) = self.mutations.get(&location).copied()
            && self.rewrite_mutation(expression, rewrite)
        {
            self.matched_mutations.insert(location);
            return;
        }
        let Expression::Identifier(identifier) = expression else {
            walk_mut::walk_expression(self, expression);
            return;
        };
        let location = (identifier.span.start, identifier.span.end);
        if !self.reads.contains(&location) {
            walk_mut::walk_expression(self, expression);
            return;
        }
        let span = identifier.span;
        let callee = expression.take_in(&self.allocator);
        let builder = AstBuilder::new(self.allocator);
        *expression = Expression::new_call_expression(
            span,
            callee,
            NONE,
            ArenaVec::new_in(&self.allocator),
            false,
            &builder,
        );
        self.matched_reads.insert(location);
    }

    fn visit_call_expression(&mut self, call: &mut oxc::ast::ast::CallExpression<'a>) {
        let location = (call.span.start, call.span.end);
        if let Some(rewrite) = self.call_rewrites.get(&location)
            && rename_callee(&mut call.callee, self.allocator.alloc_str(&rewrite.local))
        {
            if let Some(context) = &rewrite.context {
                let builder = AstBuilder::new(self.allocator);
                let context = Expression::new_identifier(
                    call.span,
                    self.allocator.alloc_str(context),
                    &builder,
                );
                call.arguments.insert(0, Argument::from(context));
            }
            self.matched_calls.insert(location);
        }
        walk_mut::walk_call_expression(self, call);
    }
}

impl<'a> AstRewriter<'a, '_> {
    fn rewrite_mutation(
        &mut self,
        expression: &mut Expression<'a>,
        rewrite: MutationRewrite,
    ) -> bool {
        match rewrite {
            MutationRewrite::Write => {
                let Expression::AssignmentExpression(assignment) = expression else {
                    return false;
                };
                if assignment.operator != oxc::syntax::operator::AssignmentOperator::Assign {
                    return false;
                }
                let Some(signal) = assignment_target_name(&assignment.left) else {
                    return false;
                };
                walk_mut::walk_assignment_expression(self, assignment);
                let right = assignment.right.take_in(&self.allocator);
                let span = assignment.span;
                *expression = value_preserving_setter(self.allocator, &signal, right, span);
                true
            }
            MutationRewrite::Compound(operator) => {
                let Expression::AssignmentExpression(assignment) = expression else {
                    return false;
                };
                let Some(signal) = assignment_target_name(&assignment.left) else {
                    return false;
                };
                walk_mut::walk_assignment_expression(self, assignment);
                let right = assignment.right.take_in(&self.allocator);
                *expression = if let Some(logical) = compound_logical_operator(operator) {
                    logical_compound_update(
                        self.allocator,
                        &signal,
                        logical,
                        right,
                        assignment.span,
                    )
                } else {
                    let binary = compound_binary_operator(operator)
                        .expect("non-logical compound operator must be binary");
                    let builder = AstBuilder::new(self.allocator);
                    let current = getter_call(self.allocator, &signal, assignment.span);
                    let next = Expression::new_binary_expression(
                        assignment.span,
                        current,
                        binary,
                        right,
                        &builder,
                    );
                    value_preserving_setter(self.allocator, &signal, next, assignment.span)
                };
                true
            }
            MutationRewrite::Update { operator, prefix } => {
                let Expression::UpdateExpression(update) = expression else {
                    return false;
                };
                if update.prefix != prefix {
                    return false;
                }
                let Some(signal) = simple_assignment_target_name(&update.argument) else {
                    return false;
                };
                walk_mut::walk_update_expression(self, update);
                *expression = if prefix {
                    let builder = AstBuilder::new(self.allocator);
                    let current = getter_call(self.allocator, &signal, update.span);
                    let one = Expression::new_numeric_literal(
                        update.span,
                        1.0,
                        None,
                        NumberBase::Decimal,
                        &builder,
                    );
                    let next = Expression::new_binary_expression(
                        update.span,
                        current,
                        update_binary_operator(operator),
                        one,
                        &builder,
                    );
                    value_preserving_setter(self.allocator, &signal, next, update.span)
                } else {
                    postfix_update(self.allocator, &signal, operator, update.span)
                };
                true
            }
        }
    }
}

fn assignment_target_name(target: &AssignmentTarget<'_>) -> Option<String> {
    let AssignmentTarget::AssignmentTargetIdentifier(identifier) = target else {
        return None;
    };
    Some(identifier.name.to_string())
}

fn simple_assignment_target_name(target: &SimpleAssignmentTarget<'_>) -> Option<String> {
    let SimpleAssignmentTarget::AssignmentTargetIdentifier(identifier) = target else {
        return None;
    };
    Some(identifier.name.to_string())
}

fn compound_binary_operator(operator: CompoundAssignmentOperator) -> Option<OxcBinaryOperator> {
    Some(match operator {
        CompoundAssignmentOperator::Add => OxcBinaryOperator::Addition,
        CompoundAssignmentOperator::Subtract => OxcBinaryOperator::Subtraction,
        CompoundAssignmentOperator::Multiply => OxcBinaryOperator::Multiplication,
        CompoundAssignmentOperator::Divide => OxcBinaryOperator::Division,
        CompoundAssignmentOperator::Remainder => OxcBinaryOperator::Remainder,
        CompoundAssignmentOperator::Exponent => OxcBinaryOperator::Exponential,
        CompoundAssignmentOperator::ShiftLeft => OxcBinaryOperator::ShiftLeft,
        CompoundAssignmentOperator::ShiftRight => OxcBinaryOperator::ShiftRight,
        CompoundAssignmentOperator::ShiftRightUnsigned => OxcBinaryOperator::ShiftRightZeroFill,
        CompoundAssignmentOperator::BitOr => OxcBinaryOperator::BitwiseOR,
        CompoundAssignmentOperator::BitXor => OxcBinaryOperator::BitwiseXOR,
        CompoundAssignmentOperator::BitAnd => OxcBinaryOperator::BitwiseAnd,
        CompoundAssignmentOperator::LogicalAnd
        | CompoundAssignmentOperator::LogicalOr
        | CompoundAssignmentOperator::NullishCoalescing => return None,
    })
}

fn compound_logical_operator(operator: CompoundAssignmentOperator) -> Option<OxcLogicalOperator> {
    match operator {
        CompoundAssignmentOperator::LogicalAnd => Some(OxcLogicalOperator::And),
        CompoundAssignmentOperator::LogicalOr => Some(OxcLogicalOperator::Or),
        CompoundAssignmentOperator::NullishCoalescing => Some(OxcLogicalOperator::Coalesce),
        _ => None,
    }
}

fn update_binary_operator(operator: UpdateOperator) -> OxcBinaryOperator {
    match operator {
        UpdateOperator::Increment => OxcBinaryOperator::Addition,
        UpdateOperator::Decrement => OxcBinaryOperator::Subtraction,
    }
}

fn getter_call<'a>(allocator: &'a Allocator, signal: &str, span: Span) -> Expression<'a> {
    let builder = AstBuilder::new(allocator);
    let callee = Expression::new_identifier(span, allocator.alloc_str(signal), &builder);
    Expression::new_call_expression(
        span,
        callee,
        NONE,
        ArenaVec::new_in(&allocator),
        false,
        &builder,
    )
}

fn setter_call<'a>(
    allocator: &'a Allocator,
    signal: &str,
    value: Expression<'a>,
    span: Span,
) -> Expression<'a> {
    let builder = AstBuilder::new(allocator);
    let callee = Expression::new_identifier(span, allocator.alloc_str(signal), &builder);
    let mut arguments = ArenaVec::new_in(&allocator);
    arguments.push(Argument::from(value));
    Expression::new_call_expression(span, callee, NONE, arguments, false, &builder)
}

fn value_preserving_setter<'a>(
    allocator: &'a Allocator,
    signal: &str,
    value: Expression<'a>,
    span: Span,
) -> Expression<'a> {
    let parameter = generated_parameter_name(allocator, signal, "__fict_value");
    let parameter_value = || {
        let builder = AstBuilder::new(allocator);
        Expression::new_identifier(span, parameter, &builder)
    };
    let setter = setter_call(allocator, signal, parameter_value(), span);
    let mut sequence = ArenaVec::new_in(&allocator);
    sequence.extend([setter, parameter_value()]);
    let builder = AstBuilder::new(allocator);
    let body = Expression::new_sequence_expression(span, sequence, &builder);
    let arrow = expression_arrow(allocator, parameter, body, span);
    let mut arguments = ArenaVec::new_in(&allocator);
    arguments.push(Argument::from(value));
    Expression::new_call_expression(span, arrow, NONE, arguments, false, &builder)
}

fn logical_compound_update<'a>(
    allocator: &'a Allocator,
    signal: &str,
    operator: OxcLogicalOperator,
    right: Expression<'a>,
    span: Span,
) -> Expression<'a> {
    let parameter = generated_parameter_name(allocator, signal, "__fict_previous");
    let builder = AstBuilder::new(allocator);
    let previous = Expression::new_identifier(span, parameter, &builder);
    let assigned = value_preserving_setter(allocator, signal, right, span);
    let body = Expression::new_logical_expression(span, previous, operator, assigned, &builder);
    let arrow = expression_arrow(allocator, parameter, body, span);
    let current = getter_call(allocator, signal, span);
    let mut arguments = ArenaVec::new_in(&allocator);
    arguments.push(Argument::from(current));
    Expression::new_call_expression(span, arrow, NONE, arguments, false, &builder)
}

fn postfix_update<'a>(
    allocator: &'a Allocator,
    signal: &str,
    operator: UpdateOperator,
    span: Span,
) -> Expression<'a> {
    let parameter = generated_parameter_name(allocator, signal, "__fict_previous");
    let parameter_value = || {
        let builder = AstBuilder::new(allocator);
        Expression::new_identifier(span, parameter, &builder)
    };
    let builder = AstBuilder::new(allocator);
    let one = Expression::new_numeric_literal(span, 1.0, None, NumberBase::Decimal, &builder);
    let next = Expression::new_binary_expression(
        span,
        parameter_value(),
        update_binary_operator(operator),
        one,
        &builder,
    );
    let setter = setter_call(allocator, signal, next, span);
    let mut sequence = ArenaVec::new_in(&allocator);
    sequence.extend([setter, parameter_value()]);
    let body = Expression::new_sequence_expression(span, sequence, &builder);
    let arrow = expression_arrow(allocator, parameter, body, span);
    let current = getter_call(allocator, signal, span);
    let mut arguments = ArenaVec::new_in(&allocator);
    arguments.push(Argument::from(current));
    Expression::new_call_expression(span, arrow, NONE, arguments, false, &builder)
}

fn expression_arrow<'a>(
    allocator: &'a Allocator,
    parameter: &'a str,
    expression: Expression<'a>,
    span: Span,
) -> Expression<'a> {
    let builder = AstBuilder::new(allocator);
    let pattern = BindingPattern::new_binding_identifier(span, parameter, &builder);
    let parameter = FormalParameter::new(
        span,
        ArenaVec::new_in(&allocator),
        pattern,
        NONE,
        NONE,
        false,
        None,
        false,
        false,
        &builder,
    );
    let mut items = ArenaVec::new_in(&allocator);
    items.push(parameter);
    let parameters = FormalParameters::boxed(
        span,
        FormalParameterKind::ArrowFormalParameters,
        items,
        NONE,
        &builder,
    );
    let mut statements = ArenaVec::new_in(&allocator);
    statements.push(Statement::new_expression_statement(
        span, expression, &builder,
    ));
    let body = FunctionBody::boxed(span, ArenaVec::new_in(&allocator), statements, &builder);
    Expression::new_arrow_function_expression(
        span, true, false, NONE, parameters, NONE, body, &builder,
    )
}

fn generated_parameter_name<'a>(
    allocator: &'a Allocator,
    signal: &str,
    preferred: &str,
) -> &'a str {
    if signal != preferred {
        return allocator.alloc_str(preferred);
    }
    let mut candidate = format!("{preferred}_1");
    while candidate == signal {
        candidate.push('_');
    }
    allocator.alloc_str(&candidate)
}

fn rename_callee<'a>(expression: &mut Expression<'a>, local: &'a str) -> bool {
    match expression {
        Expression::Identifier(identifier) => {
            identifier.name = local.into();
            identifier.reference_id.set(None);
            true
        }
        Expression::ParenthesizedExpression(expression) => {
            rename_callee(&mut expression.expression, local)
        }
        Expression::TSAsExpression(expression) => rename_callee(&mut expression.expression, local),
        Expression::TSSatisfiesExpression(expression) => {
            rename_callee(&mut expression.expression, local)
        }
        Expression::TSTypeAssertion(expression) => rename_callee(&mut expression.expression, local),
        Expression::TSNonNullExpression(expression) => {
            rename_callee(&mut expression.expression, local)
        }
        Expression::TSInstantiationExpression(expression) => {
            rename_callee(&mut expression.expression, local)
        }
        Expression::SequenceExpression(expression) => expression
            .expressions
            .last_mut()
            .is_some_and(|expression| rename_callee(expression, local)),
        _ => false,
    }
}

struct ZeroSpans;

impl<'a> VisitMut<'a> for ZeroSpans {
    fn visit_span(&mut self, span: &mut Span) {
        *span = Span::default();
    }
}

fn output_source_type(module_kind: OxcModuleKind) -> SourceType {
    match module_kind {
        OxcModuleKind::Module => SourceType::mjs(),
        OxcModuleKind::Script => SourceType::cjs().with_script(true),
        OxcModuleKind::CommonJs => SourceType::cjs(),
        OxcModuleKind::Unambiguous => SourceType::unambiguous(),
    }
}

fn operation_origin(operation: &EmitOperation) -> fict_hir::Origin {
    match operation {
        EmitOperation::PreserveHir { origin, .. }
        | EmitOperation::CreateReactive { origin, .. }
        | EmitOperation::TrackRuntimeReactive { origin, .. }
        | EmitOperation::ReadReactive { origin, .. }
        | EmitOperation::RegisterEffect { origin, .. }
        | EmitOperation::WriteReactive { origin, .. }
        | EmitOperation::UpdateReactive { origin, .. }
        | EmitOperation::CreateVNode { origin, .. }
        | EmitOperation::DeclareTemplate { origin, .. }
        | EmitOperation::CloneTemplate { origin, .. }
        | EmitOperation::ResolveElement { origin, .. }
        | EmitOperation::InvokeComponent { origin, .. }
        | EmitOperation::CreateElement { origin, .. }
        | EmitOperation::BindDom { origin, .. }
        | EmitOperation::ApplyProps { origin, .. }
        | EmitOperation::BindEvent { origin, .. }
        | EmitOperation::BindRef { origin, .. }
        | EmitOperation::Insert { origin, .. }
        | EmitOperation::Conditional { origin, .. }
        | EmitOperation::KeyedList { origin, .. }
        | EmitOperation::Return { origin, .. } => *origin,
    }
}

fn emit_error(
    code: &'static str,
    message: impl Into<String>,
    guarantee: GuaranteeClass,
) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("emit diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(guarantee)
}

#[cfg(test)]
mod tests {
    use fict_emit::{
        CleanupOwner, EmitContext, EmitFunction, EmitModulePlan, EmitOperation, EmitProgram,
        EmitSlotId, EmitValueRef, ReactiveSlot, ReactiveSlotKind, ReactiveSlotStorage,
        RuntimeFamily, RuntimeHelper, RuntimeImportIntent,
    };
    use fict_hir::{
        CompoundAssignmentOperator, FunctionId, LiteralValue, Origin, Projection, SourceSpan,
        UpdateOperator, ValueId,
    };
    use fict_reactivity::{StructurizeAnalysis, StructurizeStats};

    use super::emit_program;
    use crate::{OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, OxcTypeScriptOptions};

    fn options(language: OxcSourceLanguage, sourcemap: bool) -> OxcCompileOptions {
        OxcCompileOptions {
            language,
            module_kind: OxcModuleKind::Module,
            typescript: OxcTypeScriptOptions::default(),
            sourcemap,
        }
    }

    fn effect_program(source: &str) -> EmitProgram {
        let call = "$effect(() => 1)";
        let start = u32::try_from(source.find(call).expect("effect call")).expect("span");
        let end = start + u32::try_from(call.len()).expect("span");
        let origin = Origin::source(SourceSpan::new(start, end).expect("ordered span"));
        EmitProgram {
            runtime_family: RuntimeFamily::Runtime,
            preview: false,
            strict_rejected: false,
            module: EmitModulePlan {
                source_fragment: None,
                reserved_names: vec!["createEffect_1".into()],
            },
            imports: vec![RuntimeImportIntent {
                helper: RuntimeHelper::Effect,
                module_request: "@fictjs/runtime/internal".into(),
                imported: "createEffect".into(),
                local: "createEffect_1".into(),
            }],
            functions: vec![EmitFunction {
                source: FunctionId::new(0),
                context: None,
                slots: vec![ReactiveSlot {
                    id: EmitSlotId::new(0),
                    kind: ReactiveSlotKind::Effect,
                    storage: ReactiveSlotStorage::Owned,
                    binding: None,
                    control_path: Vec::new(),
                    origin,
                }],
                temporaries: Vec::new(),
                regions: Vec::new(),
                control_flow: StructurizeAnalysis {
                    block_order: Vec::new(),
                    constructs: Vec::new(),
                    top_level_constructs: Vec::new(),
                    fallback: None,
                    stats: StructurizeStats::default(),
                },
                operations: vec![EmitOperation::RegisterEffect {
                    slot: EmitSlotId::new(0),
                    source_result: Some(ValueId::new(0)),
                    callback: EmitValueRef::Literal(LiteralValue::Undefined),
                    helper: RuntimeHelper::Effect,
                    cleanup: CleanupOwner::Function,
                    origin,
                }],
            }],
        }
    }

    #[test]
    fn rewrites_calls_in_oxc_ast_injects_imports_and_emits_maps() {
        let source = "import { $effect } from 'fict';\nconst value: number = 1;\n$effect(() => 1);\nexport { value };";
        let output = emit_program(
            source,
            "effect.ts",
            options(OxcSourceLanguage::TypeScript, true),
            &effect_program(source),
        );
        assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
        assert!(output.code.contains("@fictjs/runtime/internal"));
        assert!(output.code.contains("createEffect as createEffect_1"));
        assert!(output.code.contains("createEffect_1(() => 1)"));
        assert!(!output.code.contains("$effect"));
        assert!(!output.code.contains(": number"));
        assert!(output.code.contains("export { value }"));
        let map = output.source_map_json.expect("source map");
        assert!(map.contains("effect.ts"));
        assert!(map.contains("mappings"));
    }

    #[test]
    fn erases_only_exact_compiler_macro_import_specifiers() {
        let source = "import { $effect, batch } from 'fict';\n$effect(() => 1);\nexport { batch };";
        let emit = effect_program(source);

        let output = emit_program(
            source,
            "mixed-import.js",
            options(OxcSourceLanguage::JavaScript, false),
            &emit,
        );

        assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
        assert!(!output.code.contains("$effect"));
        assert!(output.code.contains("import { batch } from \"fict\""));
        assert!(output.code.contains("export { batch }"));
    }

    #[test]
    fn fails_closed_for_unmaterialized_operations_and_bad_origins() {
        let source = "import { $effect } from 'fict'; $effect(() => 1);";
        let mut unsupported = effect_program(source);
        unsupported.functions[0]
            .operations
            .push(EmitOperation::WriteReactive {
                slot: EmitSlotId::new(0),
                projections: vec![Projection::StaticProperty {
                    name: "value".into(),
                    optional: false,
                }],
                value: EmitValueRef::Literal(LiteralValue::Undefined),
                origin: Origin::source(SourceSpan::empty(0)),
            });
        let output = emit_program(
            source,
            "unsupported.js",
            options(OxcSourceLanguage::JavaScript, false),
            &unsupported,
        );
        assert!(output.code.is_empty());
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == "FICT-OXC-EMIT-UNSUPPORTED")
        );

        let mut bad_origin = effect_program(source);
        let EmitOperation::RegisterEffect { origin, .. } =
            &mut bad_origin.functions[0].operations[0]
        else {
            unreachable!()
        };
        *origin = Origin::source(SourceSpan::new(0, 1).expect("span"));
        let output = emit_program(
            source,
            "bad-origin.js",
            options(OxcSourceLanguage::JavaScript, false),
            &bad_origin,
        );
        assert!(output.code.is_empty());
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == "FICT-OXC-EMIT-ORIGIN")
        );
    }

    #[test]
    fn materializes_unprojected_reactive_reads_as_accessor_calls() {
        let source = "const memo = () => 1; export const value = memo + memo;";
        let mut emit = effect_program("$effect(() => 1)");
        emit.imports.clear();
        emit.functions[0].slots.clear();
        emit.functions[0].operations.clear();
        for (index, (start, _)) in source.match_indices("memo").skip(1).enumerate() {
            let start = u32::try_from(start).expect("span");
            emit.functions[0]
                .operations
                .push(EmitOperation::ReadReactive {
                    slot: EmitSlotId::new(0),
                    source_result: ValueId::new(u32::try_from(index).expect("value")),
                    projections: Vec::new(),
                    target: fict_emit::EmitTemporaryId::new(
                        u32::try_from(index).expect("temporary"),
                    ),
                    helper: None,
                    origin: Origin::source(
                        SourceSpan::new(start, start + 4).expect("ordered span"),
                    ),
                });
        }

        let output = emit_program(
            source,
            "read.js",
            options(OxcSourceLanguage::JavaScript, false),
            &emit,
        );

        assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
        assert!(output.code.contains("value = memo() + memo()"));
    }

    #[test]
    fn materializes_value_preserving_reactive_writes_and_updates() {
        let source = "let count = () => 0; export const values = [count = rhs(), count += 2, count++, --count, count &&= rhs(), count ||= rhs(), count ??= rhs()];";
        let mut emit = effect_program("$effect(() => 1)");
        emit.imports.clear();
        emit.functions[0].slots.clear();
        emit.functions[0].operations.clear();
        let operations = [
            ("count = rhs()", 0_u8),
            ("count += 2", 1_u8),
            ("count++", 2_u8),
            ("--count", 3_u8),
            ("count &&= rhs()", 4_u8),
            ("count ||= rhs()", 5_u8),
            ("count ??= rhs()", 6_u8),
        ];
        for (authored, kind) in operations {
            let start = u32::try_from(source.find(authored).expect("mutation span")).expect("span");
            let origin = Origin::source(
                SourceSpan::new(start, start + u32::try_from(authored.len()).expect("span"))
                    .expect("ordered span"),
            );
            let operation = match kind {
                0 => EmitOperation::WriteReactive {
                    slot: EmitSlotId::new(0),
                    projections: Vec::new(),
                    value: EmitValueRef::Literal(LiteralValue::Undefined),
                    origin,
                },
                1 => EmitOperation::UpdateReactive {
                    slot: EmitSlotId::new(0),
                    source_result: Some(ValueId::new(0)),
                    projections: Vec::new(),
                    compound: Some(CompoundAssignmentOperator::Add),
                    value: Some(EmitValueRef::Literal(LiteralValue::Undefined)),
                    update: None,
                    prefix: false,
                    target: None,
                    origin,
                },
                2 => EmitOperation::UpdateReactive {
                    slot: EmitSlotId::new(0),
                    source_result: Some(ValueId::new(1)),
                    projections: Vec::new(),
                    compound: None,
                    value: None,
                    update: Some(UpdateOperator::Increment),
                    prefix: false,
                    target: None,
                    origin,
                },
                3 => EmitOperation::UpdateReactive {
                    slot: EmitSlotId::new(0),
                    source_result: Some(ValueId::new(2)),
                    projections: Vec::new(),
                    compound: None,
                    value: None,
                    update: Some(UpdateOperator::Decrement),
                    prefix: true,
                    target: None,
                    origin,
                },
                4..=6 => EmitOperation::UpdateReactive {
                    slot: EmitSlotId::new(0),
                    source_result: Some(ValueId::new(u32::from(kind))),
                    projections: Vec::new(),
                    compound: Some(match kind {
                        4 => CompoundAssignmentOperator::LogicalAnd,
                        5 => CompoundAssignmentOperator::LogicalOr,
                        6 => CompoundAssignmentOperator::NullishCoalescing,
                        _ => unreachable!(),
                    }),
                    value: Some(EmitValueRef::Literal(LiteralValue::Undefined)),
                    update: None,
                    prefix: false,
                    target: None,
                    origin,
                },
                _ => unreachable!(),
            };
            emit.functions[0].operations.push(operation);
        }

        let output = emit_program(
            source,
            "writes.js",
            options(OxcSourceLanguage::JavaScript, false),
            &emit,
        );

        assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
        assert!(output.code.contains("count(__fict_value)"));
        assert!(output.code.contains("count() + 2"));
        assert!(output.code.contains("count(__fict_previous + 1)"));
        assert!(output.code.contains("count() - 1"));
        assert!(output.code.contains("__fict_previous &&"));
        assert!(output.code.contains("__fict_previous ||"));
        assert!(output.code.contains("__fict_previous ??"));
    }

    #[test]
    fn fails_closed_for_scoped_helpers_without_context_materialization() {
        let source = "import { $effect } from 'fict'; $effect(() => 1);";
        let mut scoped = effect_program(source);
        let EmitOperation::RegisterEffect { helper, .. } = &mut scoped.functions[0].operations[0]
        else {
            unreachable!()
        };
        *helper = RuntimeHelper::UseEffect;
        scoped.imports[0].helper = RuntimeHelper::UseEffect;
        scoped.imports[0].imported = "__fictUseEffect".into();
        scoped.imports[0].local = "__fictUseEffect".into();

        let output = emit_program(
            source,
            "scoped.js",
            options(OxcSourceLanguage::JavaScript, false),
            &scoped,
        );

        assert!(output.code.is_empty());
        assert_eq!(output.diagnostics[0].code.as_str(), "FICT-OXC-EMIT-CONTEXT");
    }

    #[test]
    fn injects_scoped_contexts_and_prepends_helper_arguments() {
        let source = "function App() { $effect(() => 1); }";
        let mut scoped = effect_program(source);
        let function_origin = Origin::source(
            SourceSpan::new(0, u32::try_from(source.len()).expect("span")).expect("ordered span"),
        );
        let EmitOperation::RegisterEffect { helper, .. } = &mut scoped.functions[0].operations[0]
        else {
            unreachable!()
        };
        *helper = RuntimeHelper::UseEffect;
        scoped.functions[0].context = Some(EmitContext {
            local: "__fictCtx".into(),
            helper: RuntimeHelper::UseContext,
            origin: function_origin,
        });
        scoped.imports = vec![
            RuntimeImportIntent {
                helper: RuntimeHelper::UseContext,
                module_request: "@fictjs/runtime/internal".into(),
                imported: "__fictUseContext".into(),
                local: "__fictUseContext".into(),
            },
            RuntimeImportIntent {
                helper: RuntimeHelper::UseEffect,
                module_request: "@fictjs/runtime/internal".into(),
                imported: "__fictUseEffect".into(),
                local: "__fictUseEffect".into(),
            },
        ];

        let output = emit_program(
            source,
            "scoped-valid.js",
            options(OxcSourceLanguage::JavaScript, false),
            &scoped,
        );

        assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
        assert!(output.code.contains("const __fictCtx = __fictUseContext()"));
        assert!(output.code.contains("__fictUseEffect(__fictCtx, () => 1)"));
    }
}
