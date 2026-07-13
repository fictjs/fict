use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use fict_diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use fict_emit::{
    ComponentChild, ComponentProp, ConditionalKind, DomBindingKind, DomNamespace, EmitOperation,
    EmitProgram, EmitValueRef, PropsOperation, RuntimeHelper,
};
use fict_hir::{CompoundAssignmentOperator, LiteralValue, TemplateId, UpdateOperator};
use oxc::{
    allocator::{Allocator, CloneIn, TakeIn, Vec as ArenaVec},
    ast::{
        AstBuilder, NONE,
        ast::{
            Argument, ArrayExpressionElement, ArrowFunctionExpression, AssignmentTarget,
            BindingPattern, BindingRestElement, ChainElement, Expression, FormalParameter,
            FormalParameterKind, FormalParameterRest, FormalParameters, Function, FunctionBody,
            FunctionType, IdentifierName, IdentifierReference, ImportDeclarationSpecifier,
            ImportOrExportKind, JSXAttributeItem, JSXAttributeName, JSXAttributeValue, JSXChild,
            JSXElement, JSXElementName, JSXFragment, JSXMemberExpression,
            JSXMemberExpressionObject, ObjectPropertyKind, PropertyKey, PropertyKind,
            SimpleAssignmentTarget, Statement, VariableDeclarationKind, VariableDeclarator,
        },
    },
    ast_visit::{Visit, VisitMut, walk_mut},
    codegen::{Codegen, CodegenOptions},
    parser::{ParseOptions, Parser},
    semantic::SemanticBuilder,
    span::{GetSpan, SourceType, Span},
    syntax::{
        identifier::is_identifier_name,
        number::NumberBase,
        operator::{
            BinaryOperator as OxcBinaryOperator, LogicalOperator as OxcLogicalOperator,
            UnaryOperator as OxcUnaryOperator,
        },
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
    let (vnodes, vnode_diagnostics) = vnode_rewrites(emit);
    let (components, component_diagnostics) = component_rewrites(emit);
    let templates = template_rewrites(emit);
    diagnostics.extend(rewrite_diagnostics);
    diagnostics.extend(read_diagnostics);
    diagnostics.extend(mutation_diagnostics);
    diagnostics.extend(vnode_diagnostics);
    diagnostics.extend(component_diagnostics);
    diagnostics.extend(templates.diagnostics);
    if !diagnostics.is_empty() {
        return failed_output(diagnostics);
    }
    let template_declarations = match parse_template_declarations(&allocator, &templates.sources) {
        Ok(declarations) => declarations,
        Err(findings) => return failed_output(findings),
    };
    let mut rewriter = AstRewriter {
        allocator: &allocator,
        call_rewrites: &rewrites,
        reads: &reads,
        mutations: &mutations,
        vnodes: &vnodes,
        components: &components,
        clones: &templates.clones,
        context_declarations,
        matched_calls: BTreeSet::new(),
        matched_reads: BTreeSet::new(),
        matched_mutations: BTreeSet::new(),
        matched_vnodes: BTreeSet::new(),
        matched_components: BTreeSet::new(),
        matched_clones: BTreeSet::new(),
        vnode_shadowed_clones: BTreeSet::new(),
        active_list_reads: BTreeSet::new(),
        matched_list_reads: BTreeSet::new(),
        active_list_key_local: None,
        active_list_key_origin: None,
        suppressed_evaluations: BTreeSet::new(),
        prefer_template_clones: 0,
        vnode_depth: 0,
        active_fragment_local: None,
        diagnostics: Vec::new(),
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
    for location in vnodes.keys() {
        if !rewriter.matched_vnodes.contains(location) {
            diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-ORIGIN",
                    "EmitIR VNode origin does not identify an OXC JSX root expression",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(
                    SourceSpan::new(location.0, location.1).expect("ordered EmitIR VNode location"),
                ),
            );
        }
    }
    for location in components.keys() {
        if !rewriter.matched_components.contains(location) {
            diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-ORIGIN",
                    "EmitIR component origin does not identify an OXC JSX element",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(
                    SourceSpan::new(location.0, location.1)
                        .expect("ordered EmitIR component location"),
                ),
            );
        }
    }
    for location in templates.clones.keys() {
        if !rewriter.matched_clones.contains(location)
            && !rewriter.vnode_shadowed_clones.contains(location)
        {
            diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-ORIGIN",
                    "EmitIR template-clone origin does not identify an OXC JSX root expression",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(
                    SourceSpan::new(location.0, location.1)
                        .expect("ordered EmitIR template-clone location"),
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
    diagnostics.append(&mut rewriter.diagnostics);
    if !diagnostics.is_empty() {
        return failed_output(diagnostics);
    }

    let used_template_factories: BTreeSet<_> = rewriter
        .matched_clones
        .iter()
        .filter_map(|location| templates.clones.get(location))
        .map(|clone| clone.factory.as_str())
        .collect();
    let template_declarations: Vec<_> = template_declarations
        .into_iter()
        .zip(&templates.sources)
        .filter_map(|(statement, source)| {
            used_template_factories
                .contains(source.local.as_str())
                .then_some(statement)
        })
        .collect();
    for statement in template_declarations.into_iter().rev() {
        program.body.insert(0, statement);
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
            EmitOperation::ApplyProps { operation, .. } => {
                !matches!(operation, PropsOperation::Spread { .. })
            }
            _ => matches!(operation, EmitOperation::CreateElement { .. }),
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
                | EmitOperation::RegisterEffect { helper, .. }
                | EmitOperation::KeyedList { helper, .. } => Some(*helper),
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

#[derive(Debug, Clone)]
struct VNodeRewrite {
    fragment_local: Option<String>,
}

fn vnode_rewrites(emit: &EmitProgram) -> (BTreeMap<(u32, u32), VNodeRewrite>, Vec<Diagnostic>) {
    let helper_names: BTreeMap<_, _> = emit
        .imports
        .iter()
        .map(|intent| (intent.helper, intent.local.as_str()))
        .collect();
    let mut rewrites = BTreeMap::new();
    let mut diagnostics = Vec::new();
    for operation in emit
        .functions
        .iter()
        .flat_map(|function| &function.operations)
    {
        let EmitOperation::CreateVNode {
            fragment_helper,
            origin,
            ..
        } = operation
        else {
            continue;
        };
        let Some(span) = origin.primary_span else {
            diagnostics.push(emit_error(
                "FICT-OXC-EMIT-ORIGIN",
                "VNode EmitIR operation requires a source origin",
                GuaranteeClass::Internal,
            ));
            continue;
        };
        let fragment_local = match fragment_helper {
            Some(helper) => {
                let Some(local) = helper_names.get(helper) else {
                    diagnostics.push(
                        emit_error(
                            "FICT-OXC-EMIT-IMPORT",
                            "VNode fragment helper has no runtime import intent",
                            GuaranteeClass::Internal,
                        )
                        .with_primary_span(span),
                    );
                    continue;
                };
                Some((*local).to_owned())
            }
            None => None,
        };
        if rewrites
            .insert((span.start(), span.end()), VNodeRewrite { fragment_local })
            .is_some()
        {
            diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-ORIGIN",
                    "multiple VNode operations share the same source origin",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(span),
            );
        }
    }
    (rewrites, diagnostics)
}

#[derive(Debug, Clone)]
struct ComponentRewrite {
    props: Vec<ComponentProp>,
    children: Vec<ComponentChild>,
    prop_helper: Option<String>,
    children_helper: Option<String>,
    merge_helper: Option<String>,
    non_reactive_helper: Option<String>,
    fragment_local: Option<String>,
}

fn component_rewrites(
    emit: &EmitProgram,
) -> (BTreeMap<(u32, u32), ComponentRewrite>, Vec<Diagnostic>) {
    let helper_names: BTreeMap<_, _> = emit
        .imports
        .iter()
        .map(|intent| (intent.helper, intent.local.as_str()))
        .collect();
    let mut rewrites = BTreeMap::new();
    let mut diagnostics = Vec::new();
    for operation in emit
        .functions
        .iter()
        .flat_map(|function| &function.operations)
    {
        let EmitOperation::InvokeComponent {
            props,
            children,
            prop_helper,
            children_helper,
            merge_helper,
            non_reactive_helper,
            fragment_helper,
            origin,
            ..
        } = operation
        else {
            continue;
        };
        let Some(span) = origin.primary_span else {
            diagnostics.push(emit_error(
                "FICT-OXC-EMIT-ORIGIN",
                "component invocation requires a source JSX origin",
                GuaranteeClass::Internal,
            ));
            continue;
        };
        let prop_helper = match prop_helper {
            Some(helper) => {
                let Some(local) = helper_names.get(helper) else {
                    diagnostics.push(
                        emit_error(
                            "FICT-OXC-EMIT-IMPORT",
                            "component prop helper has no runtime import intent",
                            GuaranteeClass::Internal,
                        )
                        .with_primary_span(span),
                    );
                    continue;
                };
                Some((*local).to_owned())
            }
            None => None,
        };
        let children_helper = match children_helper {
            Some(helper) => {
                let Some(local) = helper_names.get(helper) else {
                    diagnostics.push(
                        emit_error(
                            "FICT-OXC-EMIT-IMPORT",
                            "component children helper has no runtime import intent",
                            GuaranteeClass::Internal,
                        )
                        .with_primary_span(span),
                    );
                    continue;
                };
                Some((*local).to_owned())
            }
            None => None,
        };
        let merge_helper = match merge_helper {
            Some(helper) => {
                let Some(local) = helper_names.get(helper) else {
                    diagnostics.push(
                        emit_error(
                            "FICT-OXC-EMIT-IMPORT",
                            "component merge helper has no runtime import intent",
                            GuaranteeClass::Internal,
                        )
                        .with_primary_span(span),
                    );
                    continue;
                };
                Some((*local).to_owned())
            }
            None => None,
        };
        let non_reactive_helper = match non_reactive_helper {
            Some(helper) => {
                let Some(local) = helper_names.get(helper) else {
                    diagnostics.push(
                        emit_error(
                            "FICT-OXC-EMIT-IMPORT",
                            "component non-reactive helper has no runtime import intent",
                            GuaranteeClass::Internal,
                        )
                        .with_primary_span(span),
                    );
                    continue;
                };
                Some((*local).to_owned())
            }
            None => None,
        };
        let fragment_local = match fragment_helper {
            Some(helper) => {
                let Some(local) = helper_names.get(helper) else {
                    diagnostics.push(
                        emit_error(
                            "FICT-OXC-EMIT-IMPORT",
                            "component fragment helper has no runtime import intent",
                            GuaranteeClass::Internal,
                        )
                        .with_primary_span(span),
                    );
                    continue;
                };
                Some((*local).to_owned())
            }
            None => None,
        };
        if rewrites
            .insert(
                (span.start(), span.end()),
                ComponentRewrite {
                    props: props.clone(),
                    children: children.clone(),
                    prop_helper,
                    children_helper,
                    merge_helper,
                    non_reactive_helper,
                    fragment_local,
                },
            )
            .is_some()
        {
            diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-ORIGIN",
                    "multiple component invocations share the same source origin",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(span),
            );
        }
    }
    (rewrites, diagnostics)
}

#[derive(Debug)]
struct TemplateSource {
    local: String,
    source: String,
}

#[derive(Debug, Clone)]
struct CloneRewrite {
    factory: String,
    root: String,
    steps: Vec<FineJsxStep>,
}

#[derive(Debug, Clone)]
enum FineJsxStep {
    Resolve {
        source: String,
        target: String,
        path: Vec<u32>,
        helper: String,
    },
    Bind {
        element: String,
        kind: DomBindingKind,
        reactive: bool,
        helper: String,
        value: FineJsxValue,
    },
    Spread {
        target: String,
        helper: String,
        value_origin: SourceSpan,
        namespace: DomNamespace,
        skip_children: bool,
        excluded: Vec<String>,
    },
    Event {
        element: String,
        event: String,
        delegated: bool,
        helper: String,
        cleanup_helper: Option<String>,
        handler_origin: SourceSpan,
    },
    Ref {
        element: String,
        helper: String,
        reference_origin: SourceSpan,
    },
    Evaluate {
        value_origin: SourceSpan,
    },
    Insert {
        parent: String,
        before: Option<String>,
        helper: String,
        create_helper: String,
        fragment_local: Option<String>,
        namespace: DomNamespace,
        value_origin: SourceSpan,
    },
    Conditional {
        target: String,
        parent: String,
        start: String,
        end: String,
        kind: ConditionalKind,
        helper: String,
        create_helper: String,
        cleanup_helper: String,
        fragment_local: Option<String>,
        namespace: DomNamespace,
        value_origin: SourceSpan,
    },
    KeyedList {
        target: String,
        parent: String,
        start: String,
        end: String,
        helper: String,
        cleanup_helper: String,
        namespace: DomNamespace,
        value_origin: SourceSpan,
        items_origin: SourceSpan,
        key_origin: SourceSpan,
        render_key: String,
        item_references: Vec<SourceSpan>,
        index_references: Vec<SourceSpan>,
        needs_index: bool,
    },
}

#[derive(Debug, Clone)]
enum FineJsxValue {
    Source(SourceSpan),
    Literal(LiteralValue),
}

struct TemplateRewrites {
    sources: Vec<TemplateSource>,
    clones: BTreeMap<(u32, u32), CloneRewrite>,
    diagnostics: Vec<Diagnostic>,
}

fn template_rewrites(emit: &EmitProgram) -> TemplateRewrites {
    let helper_names: BTreeMap<_, _> = emit
        .imports
        .iter()
        .map(|intent| (intent.helper, intent.local.as_str()))
        .collect();
    let mut declarations: BTreeMap<TemplateId, String> = BTreeMap::new();
    let mut locals = BTreeSet::new();
    let mut sources = Vec::new();
    let mut diagnostics = Vec::new();
    for operation in emit
        .functions
        .iter()
        .flat_map(|function| &function.operations)
    {
        let EmitOperation::DeclareTemplate {
            template,
            local,
            html,
            namespace,
            helper,
            origin,
        } = operation
        else {
            continue;
        };
        let Some(helper_local) = helper_names.get(helper) else {
            let mut diagnostic = emit_error(
                "FICT-OXC-EMIT-IMPORT",
                "template declaration helper has no runtime import intent",
                GuaranteeClass::Internal,
            );
            diagnostic.primary_span = origin.primary_span;
            diagnostics.push(diagnostic);
            continue;
        };
        if declarations.insert(*template, local.clone()).is_some() || !locals.insert(local.clone())
        {
            let mut diagnostic = emit_error(
                "FICT-OXC-EMIT-TEMPLATE",
                "template declarations must have unique template and local identities",
                GuaranteeClass::Internal,
            );
            diagnostic.primary_span = origin.primary_span;
            diagnostics.push(diagnostic);
            continue;
        }
        let Some(call) = render_template_call(helper_local, html, *namespace) else {
            let mut diagnostic = emit_error(
                "FICT-OXC-EMIT-TEMPLATE",
                "template declaration uses a non-concrete DOM namespace",
                GuaranteeClass::Internal,
            );
            diagnostic.primary_span = origin.primary_span;
            diagnostics.push(diagnostic);
            continue;
        };
        sources.push(TemplateSource {
            local: local.clone(),
            source: format!("const {local} = {call};"),
        });
    }

    let mut clones: BTreeMap<(u32, u32), CloneRewrite> = BTreeMap::new();
    for function in &emit.functions {
        let temporary_names: BTreeMap<_, _> = function
            .temporaries
            .iter()
            .map(|temporary| (temporary.id, temporary.name.as_str()))
            .collect();
        let component_origins: BTreeMap<_, _> = function
            .operations
            .iter()
            .filter_map(|operation| match operation {
                EmitOperation::InvokeComponent { target, origin, .. } => {
                    origin.primary_span.map(|span| (*target, span))
                }
                _ => None,
            })
            .collect();
        let mut current = None;
        for operation in &function.operations {
            match operation {
                EmitOperation::CloneTemplate {
                    template,
                    target,
                    origin,
                    ..
                } => {
                    let Some(span) = origin.primary_span else {
                        diagnostics.push(emit_error(
                            "FICT-OXC-EMIT-ORIGIN",
                            "template-clone operation requires a source origin",
                            GuaranteeClass::Internal,
                        ));
                        current = None;
                        continue;
                    };
                    let Some(factory) = declarations.get(template) else {
                        diagnostics.push(
                            emit_error(
                                "FICT-OXC-EMIT-TEMPLATE",
                                "template clone has no matching declaration",
                                GuaranteeClass::Internal,
                            )
                            .with_primary_span(span),
                        );
                        current = None;
                        continue;
                    };
                    let Some(root) = temporary_names.get(target) else {
                        diagnostics.push(
                            emit_error(
                                "FICT-OXC-EMIT-TEMP",
                                "template clone target has no generated local",
                                GuaranteeClass::Internal,
                            )
                            .with_primary_span(span),
                        );
                        current = None;
                        continue;
                    };
                    let location = (span.start(), span.end());
                    if clones
                        .insert(
                            location,
                            CloneRewrite {
                                factory: factory.clone(),
                                root: (*root).to_owned(),
                                steps: Vec::new(),
                            },
                        )
                        .is_some()
                    {
                        diagnostics.push(
                            emit_error(
                                "FICT-OXC-EMIT-ORIGIN",
                                "multiple template clones share the same source origin",
                                GuaranteeClass::Internal,
                            )
                            .with_primary_span(span),
                        );
                        current = None;
                    } else {
                        current = Some(location);
                    }
                }
                EmitOperation::ResolveElement {
                    root,
                    path,
                    target,
                    helper,
                    origin,
                } => {
                    let Some(plan) = current.and_then(|location| clones.get_mut(&location)) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-TEMPLATE",
                                "element resolution is not attached to a template clone",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    let Some(source) = temporary_names.get(root) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-TEMP",
                                "element resolution source has no generated local",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    let Some(target) = temporary_names.get(target) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-TEMP",
                                "element resolution target has no generated local",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    let Some(helper) = helper_names.get(helper) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-IMPORT",
                                "element resolution helper has no runtime import intent",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    plan.steps.push(FineJsxStep::Resolve {
                        source: (*source).to_owned(),
                        target: (*target).to_owned(),
                        path: path.clone(),
                        helper: (*helper).to_owned(),
                    });
                }
                EmitOperation::BindDom {
                    element,
                    kind,
                    value,
                    reactive,
                    helper,
                    origin,
                } => {
                    let Some(plan) = current.and_then(|location| clones.get_mut(&location)) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-TEMPLATE",
                                "DOM binding is not attached to a template clone",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    let Some(element) = temporary_names.get(element) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-TEMP",
                                "DOM binding target has no generated local",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    let value = match value {
                        EmitValueRef::Hir(_) => {
                            let Some(span) = origin.primary_span else {
                                diagnostics.push(emit_error(
                                    "FICT-OXC-EMIT-ORIGIN",
                                    "DOM binding requires a source expression origin",
                                    GuaranteeClass::Internal,
                                ));
                                continue;
                            };
                            FineJsxValue::Source(span)
                        }
                        EmitValueRef::Literal(value) => FineJsxValue::Literal(value.clone()),
                        EmitValueRef::Ssa(_)
                        | EmitValueRef::Slot(_)
                        | EmitValueRef::Temporary(_)
                        | EmitValueRef::Function(_)
                        | EmitValueRef::Binding(_) => {
                            diagnostics.push(with_operation_span(
                                emit_error(
                                    "FICT-OXC-EMIT-VALUE",
                                    "DOM binding temporary value is not materialized",
                                    GuaranteeClass::Internal,
                                ),
                                *origin,
                            ));
                            continue;
                        }
                    };
                    let Some(helper) = helper_names.get(helper) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-IMPORT",
                                "DOM binding helper has no runtime import intent",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    plan.steps.push(FineJsxStep::Bind {
                        element: (*element).to_owned(),
                        kind: kind.clone(),
                        reactive: *reactive,
                        helper: (*helper).to_owned(),
                        value,
                    });
                }
                EmitOperation::ApplyProps {
                    target,
                    operation:
                        PropsOperation::Spread {
                            source,
                            namespace,
                            skip_children,
                            excluded,
                        },
                    helper,
                    origin,
                } => {
                    let Some(plan) = current.and_then(|location| clones.get_mut(&location)) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-TEMPLATE",
                                "props spread is not attached to a template clone",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    let Some(target) = temporary_names.get(target) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-TEMP",
                                "props spread target has no generated local",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    if !matches!(source, EmitValueRef::Hir(_)) {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-VALUE",
                                "props spread is not backed by a source HIR expression",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    }
                    let Some(value_origin) = origin.primary_span else {
                        diagnostics.push(emit_error(
                            "FICT-OXC-EMIT-ORIGIN",
                            "props spread requires a source expression origin",
                            GuaranteeClass::Internal,
                        ));
                        continue;
                    };
                    let Some(helper) = helper_names.get(helper) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-IMPORT",
                                "props spread helper has no runtime import intent",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    plan.steps.push(FineJsxStep::Spread {
                        target: (*target).to_owned(),
                        helper: (*helper).to_owned(),
                        value_origin,
                        namespace: *namespace,
                        skip_children: *skip_children,
                        excluded: excluded.clone(),
                    });
                }
                EmitOperation::BindEvent {
                    element,
                    event,
                    handler,
                    delegated,
                    helper,
                    cleanup_helper,
                    origin,
                    ..
                } => {
                    let Some(plan) = current.and_then(|location| clones.get_mut(&location)) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-TEMPLATE",
                                "event binding is not attached to a template clone",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    let Some(element) = temporary_names.get(element) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-TEMP",
                                "event binding target has no generated local",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    if !matches!(handler, EmitValueRef::Hir(_)) {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-VALUE",
                                "event handler is not backed by a source HIR expression",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    }
                    let Some(handler_origin) = origin.primary_span else {
                        diagnostics.push(emit_error(
                            "FICT-OXC-EMIT-ORIGIN",
                            "event binding requires a source handler origin",
                            GuaranteeClass::Internal,
                        ));
                        continue;
                    };
                    let Some(helper) = helper_names.get(helper) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-IMPORT",
                                "event binding helper has no runtime import intent",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    let cleanup_helper = match cleanup_helper {
                        Some(cleanup_helper) => {
                            let Some(local) = helper_names.get(cleanup_helper) else {
                                diagnostics.push(with_operation_span(
                                    emit_error(
                                        "FICT-OXC-EMIT-IMPORT",
                                        "event cleanup helper has no runtime import intent",
                                        GuaranteeClass::Internal,
                                    ),
                                    *origin,
                                ));
                                continue;
                            };
                            Some((*local).to_owned())
                        }
                        None => None,
                    };
                    plan.steps.push(FineJsxStep::Event {
                        element: (*element).to_owned(),
                        event: event.clone(),
                        delegated: *delegated,
                        helper: (*helper).to_owned(),
                        cleanup_helper,
                        handler_origin,
                    });
                }
                EmitOperation::BindRef {
                    element,
                    reference,
                    helper,
                    origin,
                    ..
                } => {
                    let Some(plan) = current.and_then(|location| clones.get_mut(&location)) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-TEMPLATE",
                                "ref binding is not attached to a template clone",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    let Some(element) = temporary_names.get(element) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-TEMP",
                                "ref binding target has no generated local",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    if !matches!(reference, EmitValueRef::Hir(_)) {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-VALUE",
                                "ref value is not backed by a source HIR expression",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    }
                    let Some(reference_origin) = origin.primary_span else {
                        diagnostics.push(emit_error(
                            "FICT-OXC-EMIT-ORIGIN",
                            "ref binding requires a source value origin",
                            GuaranteeClass::Internal,
                        ));
                        continue;
                    };
                    let Some(helper) = helper_names.get(helper) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-IMPORT",
                                "ref binding helper has no runtime import intent",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    plan.steps.push(FineJsxStep::Ref {
                        element: (*element).to_owned(),
                        helper: (*helper).to_owned(),
                        reference_origin,
                    });
                }
                EmitOperation::Evaluate { value, origin } => {
                    let Some(plan) = current.and_then(|location| clones.get_mut(&location)) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-TEMPLATE",
                                "discarded JSX value is not attached to a template clone",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    if !matches!(value, EmitValueRef::Hir(_)) {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-VALUE",
                                "discarded JSX value is not backed by a source expression",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    }
                    let Some(value_origin) = origin.primary_span else {
                        diagnostics.push(emit_error(
                            "FICT-OXC-EMIT-ORIGIN",
                            "discarded JSX value requires a source origin",
                            GuaranteeClass::Internal,
                        ));
                        continue;
                    };
                    plan.steps.push(FineJsxStep::Evaluate { value_origin });
                }
                EmitOperation::Insert {
                    parent,
                    value,
                    before,
                    namespace,
                    helper,
                    create_helper,
                    fragment_helper,
                    origin,
                } => {
                    let Some(plan) = current.and_then(|location| clones.get_mut(&location)) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-TEMPLATE",
                                "child insertion is not attached to a template clone",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    let Some(parent) = temporary_names.get(parent) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-TEMP",
                                "child insertion parent has no generated local",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    let before = match before {
                        Some(before) => {
                            let Some(local) = temporary_names.get(before) else {
                                diagnostics.push(with_operation_span(
                                    emit_error(
                                        "FICT-OXC-EMIT-TEMP",
                                        "child insertion marker has no generated local",
                                        GuaranteeClass::Internal,
                                    ),
                                    *origin,
                                ));
                                continue;
                            };
                            Some((*local).to_owned())
                        }
                        None => None,
                    };
                    let value_origin = match value {
                        EmitValueRef::Hir(_) => origin.primary_span,
                        EmitValueRef::Temporary(target) => component_origins.get(target).copied(),
                        EmitValueRef::Ssa(_)
                        | EmitValueRef::Slot(_)
                        | EmitValueRef::Literal(_)
                        | EmitValueRef::Function(_)
                        | EmitValueRef::Binding(_) => None,
                    };
                    let Some(value_origin) = value_origin else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-VALUE",
                                "child insertion must reference a source expression or planned component",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    let Some(helper) = helper_names.get(helper) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-IMPORT",
                                "child insertion helper has no runtime import intent",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    let Some(create_helper) = helper_names.get(create_helper) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-IMPORT",
                                "child creation helper has no runtime import intent",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    let fragment_local = match fragment_helper {
                        Some(fragment_helper) => {
                            let Some(local) = helper_names.get(fragment_helper) else {
                                diagnostics.push(with_operation_span(
                                    emit_error(
                                        "FICT-OXC-EMIT-IMPORT",
                                        "child fragment helper has no runtime import intent",
                                        GuaranteeClass::Internal,
                                    ),
                                    *origin,
                                ));
                                continue;
                            };
                            Some((*local).to_owned())
                        }
                        None => None,
                    };
                    plan.steps.push(FineJsxStep::Insert {
                        parent: (*parent).to_owned(),
                        before,
                        helper: (*helper).to_owned(),
                        create_helper: (*create_helper).to_owned(),
                        fragment_local,
                        namespace: *namespace,
                        value_origin,
                    });
                }
                EmitOperation::Conditional {
                    target,
                    source,
                    kind,
                    parent,
                    start,
                    end,
                    namespace,
                    helper,
                    create_helper,
                    cleanup_helper,
                    fragment_helper,
                    origin,
                    ..
                } => {
                    let Some(plan) = current.and_then(|location| clones.get_mut(&location)) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-TEMPLATE",
                                "conditional binding is not attached to a template clone",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    if !matches!(source, EmitValueRef::Hir(_)) {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-VALUE",
                                "conditional binding is not backed by a source HIR expression",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    }
                    let Some(value_origin) = origin.primary_span else {
                        diagnostics.push(emit_error(
                            "FICT-OXC-EMIT-ORIGIN",
                            "conditional binding requires a source expression origin",
                            GuaranteeClass::Internal,
                        ));
                        continue;
                    };
                    let mut temporary = |id, description| {
                        temporary_names.get(id).map_or_else(
                            || {
                                diagnostics.push(with_operation_span(
                                    emit_error(
                                        "FICT-OXC-EMIT-TEMP",
                                        description,
                                        GuaranteeClass::Internal,
                                    ),
                                    *origin,
                                ));
                                None
                            },
                            |name| Some((*name).to_owned()),
                        )
                    };
                    let Some(target) =
                        temporary(target, "conditional target has no generated local")
                    else {
                        continue;
                    };
                    let Some(parent) =
                        temporary(parent, "conditional parent has no generated local")
                    else {
                        continue;
                    };
                    let Some(start) =
                        temporary(start, "conditional start marker has no generated local")
                    else {
                        continue;
                    };
                    let Some(end) = temporary(end, "conditional end marker has no generated local")
                    else {
                        continue;
                    };
                    let mut runtime_helper = |helper, description| {
                        helper_names.get(helper).map_or_else(
                            || {
                                diagnostics.push(with_operation_span(
                                    emit_error(
                                        "FICT-OXC-EMIT-IMPORT",
                                        description,
                                        GuaranteeClass::Internal,
                                    ),
                                    *origin,
                                ));
                                None
                            },
                            |name| Some((*name).to_owned()),
                        )
                    };
                    let Some(helper) =
                        runtime_helper(helper, "conditional helper has no runtime import intent")
                    else {
                        continue;
                    };
                    let Some(create_helper) = runtime_helper(
                        create_helper,
                        "conditional create helper has no runtime import intent",
                    ) else {
                        continue;
                    };
                    let Some(cleanup_helper) = runtime_helper(
                        cleanup_helper,
                        "conditional cleanup helper has no runtime import intent",
                    ) else {
                        continue;
                    };
                    let fragment_local = match fragment_helper {
                        Some(fragment_helper) => {
                            let Some(local) = runtime_helper(
                                fragment_helper,
                                "conditional fragment helper has no runtime import intent",
                            ) else {
                                continue;
                            };
                            Some(local)
                        }
                        None => None,
                    };
                    plan.steps.push(FineJsxStep::Conditional {
                        target,
                        parent,
                        start,
                        end,
                        kind: *kind,
                        helper,
                        create_helper,
                        cleanup_helper,
                        fragment_local,
                        namespace: *namespace,
                        value_origin,
                    });
                }
                EmitOperation::KeyedChild {
                    target,
                    items,
                    key,
                    render_key,
                    item_references,
                    index_references,
                    needs_index,
                    parent,
                    start,
                    end,
                    namespace,
                    helper,
                    cleanup_helper,
                    origin,
                    ..
                } => {
                    let Some(plan) = current.and_then(|location| clones.get_mut(&location)) else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-TEMPLATE",
                                "keyed child is not attached to a template clone",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    let Some(value_origin) = origin.primary_span else {
                        diagnostics.push(emit_error(
                            "FICT-OXC-EMIT-ORIGIN",
                            "keyed child requires a source map expression origin",
                            GuaranteeClass::Internal,
                        ));
                        continue;
                    };
                    let Some(items_origin) = items.primary_span else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-ORIGIN",
                                "keyed child items require a source origin",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    let Some(key_origin) = key.primary_span else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-ORIGIN",
                                "keyed child key requires a source origin",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    let item_references: Option<Vec<_>> = item_references
                        .iter()
                        .map(|origin| origin.primary_span)
                        .collect();
                    let index_references: Option<Vec<_>> = index_references
                        .iter()
                        .map(|origin| origin.primary_span)
                        .collect();
                    let (Some(item_references), Some(index_references)) =
                        (item_references, index_references)
                    else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-ORIGIN",
                                "keyed child parameter references require source origins",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    let mut temporary = |id, description| {
                        temporary_names.get(id).map_or_else(
                            || {
                                diagnostics.push(with_operation_span(
                                    emit_error(
                                        "FICT-OXC-EMIT-TEMP",
                                        description,
                                        GuaranteeClass::Internal,
                                    ),
                                    *origin,
                                ));
                                None
                            },
                            |name| Some((*name).to_owned()),
                        )
                    };
                    let Some(target) =
                        temporary(target, "keyed child target has no generated local")
                    else {
                        continue;
                    };
                    let Some(parent) =
                        temporary(parent, "keyed child parent has no generated local")
                    else {
                        continue;
                    };
                    let Some(start) = temporary(start, "keyed child start has no generated local")
                    else {
                        continue;
                    };
                    let Some(end) = temporary(end, "keyed child end has no generated local") else {
                        continue;
                    };
                    let Some(helper) = helper_names.get(helper).map(|local| (*local).to_owned())
                    else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-IMPORT",
                                "keyed child helper has no runtime import intent",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    let Some(cleanup_helper) = helper_names
                        .get(cleanup_helper)
                        .map(|local| (*local).to_owned())
                    else {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-IMPORT",
                                "keyed child cleanup helper has no runtime import intent",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    };
                    plan.steps.push(FineJsxStep::KeyedList {
                        target,
                        parent,
                        start,
                        end,
                        helper,
                        cleanup_helper,
                        namespace: *namespace,
                        value_origin,
                        items_origin,
                        key_origin,
                        render_key: render_key.clone(),
                        item_references,
                        index_references,
                        needs_index: *needs_index,
                    });
                }
                _ => {}
            }
        }
    }
    for clone in clones.values_mut() {
        clone
            .steps
            .sort_by_key(|step| !matches!(step, FineJsxStep::Resolve { .. }));
    }
    TemplateRewrites {
        sources,
        clones,
        diagnostics,
    }
}

fn render_template_call(helper: &str, html: &str, namespace: DomNamespace) -> Option<String> {
    let html = quote_javascript_string(html);
    Some(match namespace {
        DomNamespace::Html => format!("{helper}({html})"),
        DomNamespace::Svg => format!("{helper}({html}, void 0, true)"),
        DomNamespace::MathMl
        | DomNamespace::MathMlTextIntegration
        | DomNamespace::MathMlAnnotationXml => {
            format!("{helper}({html}, void 0, void 0, true)")
        }
        DomNamespace::Parent => return None,
    })
}

fn quote_javascript_string(value: &str) -> String {
    use std::fmt::Write;

    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for character in value.chars() {
        match character {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            '\u{08}' => quoted.push_str("\\b"),
            '\u{0c}' => quoted.push_str("\\f"),
            '\u{2028}' => quoted.push_str("\\u2028"),
            '\u{2029}' => quoted.push_str("\\u2029"),
            character if character <= '\u{1f}' => {
                write!(quoted, "\\u{:04x}", u32::from(character))
                    .expect("writing to a String cannot fail");
            }
            character => quoted.push(character),
        }
    }
    quoted.push('"');
    quoted
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

fn parse_template_declarations<'a>(
    allocator: &'a Allocator,
    sources: &'a [TemplateSource],
) -> Result<Vec<Statement<'a>>, Vec<Diagnostic>> {
    let mut declarations = Vec::with_capacity(sources.len());
    for source in sources {
        let parsed = Parser::new(allocator, &source.source, SourceType::mjs()).parse();
        if !parsed.diagnostics.is_empty() {
            return Err(convert_diagnostics(
                parsed.diagnostics,
                "FICT-OXC-EMIT-TEMPLATE",
            ));
        }
        let mut program = parsed.program;
        if program.body.len() != 1 {
            return Err(vec![emit_error(
                "FICT-OXC-EMIT-TEMPLATE",
                "generated template declaration did not parse as one statement",
                GuaranteeClass::Internal,
            )]);
        }
        ZeroSpans.visit_program(&mut program);
        declarations.push(program.body.pop().expect("one template statement"));
    }
    Ok(declarations)
}

struct AstRewriter<'a, 'emit> {
    allocator: &'a Allocator,
    call_rewrites: &'emit BTreeMap<(u32, u32), CallRewrite>,
    reads: &'emit BTreeSet<(u32, u32)>,
    mutations: &'emit BTreeMap<(u32, u32), MutationRewrite>,
    vnodes: &'emit BTreeMap<(u32, u32), VNodeRewrite>,
    components: &'emit BTreeMap<(u32, u32), ComponentRewrite>,
    clones: &'emit BTreeMap<(u32, u32), CloneRewrite>,
    context_declarations: BTreeMap<(u32, u32), Statement<'a>>,
    matched_calls: BTreeSet<(u32, u32)>,
    matched_reads: BTreeSet<(u32, u32)>,
    matched_mutations: BTreeSet<(u32, u32)>,
    matched_vnodes: BTreeSet<(u32, u32)>,
    matched_components: BTreeSet<(u32, u32)>,
    matched_clones: BTreeSet<(u32, u32)>,
    vnode_shadowed_clones: BTreeSet<(u32, u32)>,
    active_list_reads: BTreeSet<(u32, u32)>,
    matched_list_reads: BTreeSet<(u32, u32)>,
    active_list_key_local: Option<String>,
    active_list_key_origin: Option<(u32, u32)>,
    suppressed_evaluations: BTreeSet<(u32, u32)>,
    prefer_template_clones: usize,
    vnode_depth: usize,
    active_fragment_local: Option<String>,
    diagnostics: Vec<Diagnostic>,
}

enum VNodeChild<'a> {
    Value(Expression<'a>),
    Spread(Span, Expression<'a>),
}

fn jsx_attribute_name(name: JSXAttributeName<'_>) -> (String, Span) {
    match name {
        JSXAttributeName::Identifier(identifier) => (identifier.name.to_string(), identifier.span),
        JSXAttributeName::NamespacedName(name) => (
            format!("{}:{}", name.namespace.name, name.name.name),
            name.span,
        ),
    }
}

fn jsx_attribute_node_span(value: &Option<JSXAttributeValue<'_>>) -> Option<Span> {
    match value {
        Some(JSXAttributeValue::Element(element)) => Some(element.span),
        Some(JSXAttributeValue::Fragment(fragment)) => Some(fragment.span),
        Some(JSXAttributeValue::ExpressionContainer(container)) => container
            .expression
            .as_expression()
            .and_then(|expression| match expression.get_inner_expression() {
                Expression::JSXElement(element) => Some(element.span),
                Expression::JSXFragment(fragment) => Some(fragment.span),
                _ => None,
            }),
        Some(JSXAttributeValue::StringLiteral(_)) | None => None,
    }
}

fn jsx_attribute_source_span(value: &Option<JSXAttributeValue<'_>>) -> Option<Span> {
    match value {
        Some(JSXAttributeValue::StringLiteral(literal)) => Some(literal.span),
        Some(JSXAttributeValue::ExpressionContainer(container)) => {
            container.expression.as_expression().map(GetSpan::span)
        }
        Some(JSXAttributeValue::Element(element)) => Some(element.span),
        Some(JSXAttributeValue::Fragment(fragment)) => Some(fragment.span),
        None => None,
    }
}

fn clone_direct_jsx_key_expression<'a>(
    allocator: &'a Allocator,
    body: &Expression<'a>,
    key_origin: SourceSpan,
) -> Option<Expression<'a>> {
    let Expression::JSXElement(element) = body.get_inner_expression() else {
        return None;
    };
    for attribute in &element.opening_element.attributes {
        let JSXAttributeItem::Attribute(attribute) = attribute else {
            continue;
        };
        if !matches!(&attribute.name, JSXAttributeName::Identifier(name) if name.name == "key") {
            continue;
        }
        match attribute.value.as_ref()? {
            JSXAttributeValue::StringLiteral(literal)
                if (literal.span.start, literal.span.end)
                    == (key_origin.start(), key_origin.end()) =>
            {
                let decoded = crate::jsx_text::decode_entities(literal.value.as_str());
                return Some(Expression::new_string_literal(
                    literal.span,
                    allocator.alloc_str(&decoded),
                    None,
                    &AstBuilder::new(allocator),
                ));
            }
            JSXAttributeValue::ExpressionContainer(container) => {
                let expression = container.expression.as_expression()?;
                if (expression.span().start, expression.span().end)
                    == (key_origin.start(), key_origin.end())
                {
                    return Some(expression.clone_in(allocator));
                }
            }
            JSXAttributeValue::Element(_)
            | JSXAttributeValue::Fragment(_)
            | JSXAttributeValue::StringLiteral(_) => {}
        }
    }
    None
}

fn keyed_list_namespace(namespace: DomNamespace) -> Option<&'static str> {
    match namespace {
        DomNamespace::Html => Some("html"),
        DomNamespace::Svg => Some("svg"),
        DomNamespace::MathMl => Some("mathml"),
        DomNamespace::MathMlTextIntegration => Some("mathmlTextIntegration"),
        DomNamespace::MathMlAnnotationXml => Some("mathmlAnnotationXml"),
        DomNamespace::Parent => Some("parent"),
    }
}

fn component_node_origin_matches(origin: fict_hir::Origin, span: Span) -> bool {
    origin
        .primary_span
        .is_some_and(|source| source.start() == span.start && source.end() == span.end)
}

fn component_children_match(children: &[JSXChild<'_>], planned: &[ComponentChild]) -> bool {
    let mut planned = planned.iter();
    for child in children {
        let valid = match child {
            JSXChild::Text(text) => {
                let Some(value) = crate::jsx_text::normalize_text(text.value.as_str()) else {
                    continue;
                };
                matches!(
                    planned.next(),
                    Some(ComponentChild::Value {
                        value: EmitValueRef::Literal(LiteralValue::String(planned_value)),
                        ..
                    }) if planned_value == &value
                )
            }
            JSXChild::Element(element) => matches!(
                planned.next(),
                Some(ComponentChild::Node(origin))
                    if component_node_origin_matches(*origin, element.span)
            ),
            JSXChild::Fragment(fragment) => matches!(
                planned.next(),
                Some(ComponentChild::Node(origin))
                    if component_node_origin_matches(*origin, fragment.span)
            ),
            JSXChild::ExpressionContainer(container) => {
                let Some(expression) = container.expression.as_expression() else {
                    continue;
                };
                match expression.get_inner_expression() {
                    Expression::JSXElement(element) => matches!(
                        planned.next(),
                        Some(ComponentChild::Node(origin))
                            if component_node_origin_matches(*origin, element.span)
                    ),
                    Expression::JSXFragment(fragment) => matches!(
                        planned.next(),
                        Some(ComponentChild::Node(origin))
                            if component_node_origin_matches(*origin, fragment.span)
                    ),
                    _ => matches!(planned.next(), Some(ComponentChild::Value { .. })),
                }
            }
            JSXChild::Spread(_) => {
                matches!(planned.next(), Some(ComponentChild::Value { .. }))
            }
        };
        if !valid {
            return false;
        }
    }
    planned.next().is_none()
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
        if self.components.contains_key(&location)
            && matches!(expression, Expression::JSXElement(_))
        {
            let Expression::JSXElement(element) = expression.take_in(&self.allocator) else {
                unreachable!()
            };
            *expression = self.lower_planned_jsx_element(element.unbox());
            return;
        }
        let clone = self.clones.get(&location).cloned();
        if let Some(clone) = clone.clone()
            && matches!(
                expression,
                Expression::JSXElement(_) | Expression::JSXFragment(_)
            )
            && (self.vnode_depth == 0 || self.prefer_template_clones > 0)
        {
            let span = expression.span();
            let jsx = expression.take_in(&self.allocator);
            *expression = self.lower_template_clone(clone, jsx, span);
            self.matched_clones.insert(location);
            return;
        }
        let vnode = self.vnodes.get(&location).cloned();
        if matches!(
            expression,
            Expression::JSXElement(_) | Expression::JSXFragment(_)
        ) && (vnode.is_some() || self.vnode_depth > 0)
        {
            let previous_fragment = self.active_fragment_local.clone();
            if let Some(vnode) = &vnode {
                self.active_fragment_local.clone_from(&vnode.fragment_local);
            }
            self.vnode_depth += 1;
            let original = expression.take_in(&self.allocator);
            *expression = self.lower_jsx_expression(original);
            self.vnode_depth -= 1;
            self.active_fragment_local = previous_fragment;
            if vnode.is_some() {
                self.matched_vnodes.insert(location);
            }
            if clone.is_some() {
                self.vnode_shadowed_clones.insert(location);
            }
            return;
        }
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
        let list_read = self.active_list_reads.contains(&location);
        let reactive_read = self.reads.contains(&location);
        if !list_read && !reactive_read {
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
        if list_read {
            self.matched_list_reads.insert(location);
        }
        if reactive_read {
            self.matched_reads.insert(location);
        }
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
    fn lower_template_clone(
        &mut self,
        clone: CloneRewrite,
        jsx: Expression<'a>,
        span: Span,
    ) -> Expression<'a> {
        let builder = AstBuilder::new(self.allocator);
        let factory =
            Expression::new_identifier(span, self.allocator.alloc_str(&clone.factory), &builder);
        let clone_call = Expression::new_call_expression(
            span,
            factory,
            NONE,
            ArenaVec::new_in(&self.allocator),
            false,
            &builder,
        );
        if clone.steps.is_empty() {
            return clone_call;
        }

        let mut values = jsx_dynamic_values(jsx, self.components);
        let mut statements = ArenaVec::new_in(&self.allocator);
        statements.push(const_statement(
            self.allocator,
            &clone.root,
            clone_call,
            span,
        ));
        for step in clone.steps {
            match step {
                FineJsxStep::Resolve {
                    source,
                    target,
                    path,
                    helper,
                } => {
                    let callee = Expression::new_identifier(
                        span,
                        self.allocator.alloc_str(&helper),
                        &builder,
                    );
                    let source = Expression::new_identifier(
                        span,
                        self.allocator.alloc_str(&source),
                        &builder,
                    );
                    let mut path_elements = ArenaVec::new_in(&self.allocator);
                    for index in path {
                        path_elements.push(ArrayExpressionElement::from(
                            Expression::new_numeric_literal(
                                span,
                                f64::from(index),
                                None,
                                NumberBase::Decimal,
                                &builder,
                            ),
                        ));
                    }
                    let path = Expression::new_array_expression(span, path_elements, &builder);
                    let mut arguments = ArenaVec::new_in(&self.allocator);
                    arguments.extend([Argument::from(source), Argument::from(path)]);
                    let resolved = Expression::new_call_expression(
                        span, callee, NONE, arguments, false, &builder,
                    );
                    statements.push(const_statement(self.allocator, &target, resolved, span));
                }
                FineJsxStep::Bind {
                    element,
                    kind,
                    reactive,
                    helper,
                    value,
                } => {
                    let (mut value, value_origin) = match value {
                        FineJsxValue::Source(value_origin) => {
                            let location = (value_origin.start(), value_origin.end());
                            let Some(value) = values.remove(&location) else {
                                self.diagnostics.push(
                                    emit_error(
                                        "FICT-OXC-EMIT-ORIGIN",
                                        "DOM binding origin does not identify a JSX value expression",
                                        GuaranteeClass::Internal,
                                    )
                                    .with_primary_span(value_origin),
                                );
                                continue;
                            };
                            (value, Some(value_origin))
                        }
                        FineJsxValue::Literal(value) => {
                            let Some(value) = dom_literal_expression(self.allocator, &value, span)
                            else {
                                self.diagnostics.push(emit_error(
                                    "FICT-OXC-EMIT-VALUE",
                                    "DOM binding contains a literal unsupported by JSX lowering",
                                    GuaranteeClass::Internal,
                                ));
                                continue;
                            };
                            (value, None)
                        }
                    };
                    self.visit_expression(&mut value);
                    if reactive {
                        value = zero_parameter_expression_arrow(self.allocator, value, span);
                    }
                    let callee = Expression::new_identifier(
                        span,
                        self.allocator.alloc_str(&helper),
                        &builder,
                    );
                    let element = Expression::new_identifier(
                        span,
                        self.allocator.alloc_str(&element),
                        &builder,
                    );
                    let mut arguments = ArenaVec::new_in(&self.allocator);
                    arguments.push(Argument::from(element));
                    match kind {
                        DomBindingKind::Attribute(name) | DomBindingKind::Property(name) => {
                            arguments.push(Argument::from(Expression::new_string_literal(
                                span,
                                self.allocator.alloc_str(&name),
                                None,
                                &builder,
                            )));
                        }
                        DomBindingKind::Text
                        | DomBindingKind::TextContent
                        | DomBindingKind::Class
                        | DomBindingKind::Style => {}
                        DomBindingKind::Spread => {
                            let mut diagnostic = emit_error(
                                "FICT-OXC-EMIT-BINDING",
                                "spread DOM bindings must use ApplyProps EmitIR",
                                GuaranteeClass::Internal,
                            );
                            diagnostic.primary_span = value_origin;
                            self.diagnostics.push(diagnostic);
                            continue;
                        }
                    }
                    arguments.push(Argument::from(value));
                    let call = Expression::new_call_expression(
                        span, callee, NONE, arguments, false, &builder,
                    );
                    statements.push(Statement::new_expression_statement(span, call, &builder));
                }
                FineJsxStep::Spread {
                    target,
                    helper,
                    value_origin,
                    namespace,
                    skip_children,
                    excluded,
                } => {
                    let location = (value_origin.start(), value_origin.end());
                    let Some(mut value) = values.remove(&location) else {
                        self.diagnostics.push(
                            emit_error(
                                "FICT-OXC-EMIT-ORIGIN",
                                "props spread origin does not identify a JSX value expression",
                                GuaranteeClass::Internal,
                            )
                            .with_primary_span(value_origin),
                        );
                        continue;
                    };
                    self.visit_expression(&mut value);
                    let getter = zero_parameter_expression_arrow(self.allocator, value, span);
                    let callee = Expression::new_identifier(
                        span,
                        self.allocator.alloc_str(&helper),
                        &builder,
                    );
                    let target = Expression::new_identifier(
                        span,
                        self.allocator.alloc_str(&target),
                        &builder,
                    );
                    let namespace = match namespace {
                        DomNamespace::Svg => Expression::new_boolean_literal(span, true, &builder),
                        DomNamespace::MathMl
                        | DomNamespace::MathMlTextIntegration
                        | DomNamespace::MathMlAnnotationXml => {
                            Expression::new_string_literal(span, "mathml", None, &builder)
                        }
                        DomNamespace::Html | DomNamespace::Parent => {
                            Expression::new_boolean_literal(span, false, &builder)
                        }
                    };
                    let mut arguments = ArenaVec::new_in(&self.allocator);
                    arguments.extend([
                        Argument::from(target),
                        Argument::from(getter),
                        Argument::from(namespace),
                        Argument::from(Expression::new_boolean_literal(
                            span,
                            skip_children,
                            &builder,
                        )),
                    ]);
                    if !excluded.is_empty() {
                        let mut exclusions = ArenaVec::new_in(&self.allocator);
                        for name in excluded {
                            exclusions.push(ArrayExpressionElement::from(
                                Expression::new_string_literal(
                                    span,
                                    self.allocator.alloc_str(&name),
                                    None,
                                    &builder,
                                ),
                            ));
                        }
                        arguments.push(Argument::from(Expression::new_array_expression(
                            span, exclusions, &builder,
                        )));
                    }
                    let call = Expression::new_call_expression(
                        span, callee, NONE, arguments, false, &builder,
                    );
                    statements.push(Statement::new_expression_statement(span, call, &builder));
                }
                FineJsxStep::Event {
                    element,
                    event,
                    delegated,
                    helper,
                    cleanup_helper,
                    handler_origin,
                } => {
                    let location = (handler_origin.start(), handler_origin.end());
                    let Some(mut handler) = values.remove(&location) else {
                        self.diagnostics.push(
                            emit_error(
                                "FICT-OXC-EMIT-ORIGIN",
                                "event binding origin does not identify a JSX handler expression",
                                GuaranteeClass::Internal,
                            )
                            .with_primary_span(handler_origin),
                        );
                        continue;
                    };
                    self.visit_expression(&mut handler);
                    handler = ignore_inline_event_handler_return(self.allocator, handler, span);
                    let callee = Expression::new_identifier(
                        span,
                        self.allocator.alloc_str(&helper),
                        &builder,
                    );
                    let element = Expression::new_identifier(
                        span,
                        self.allocator.alloc_str(&element),
                        &builder,
                    );
                    let mut arguments = ArenaVec::new_in(&self.allocator);
                    arguments.extend([
                        Argument::from(element),
                        Argument::from(Expression::new_string_literal(
                            span,
                            self.allocator.alloc_str(&event),
                            None,
                            &builder,
                        )),
                        Argument::from(handler),
                    ]);
                    if delegated {
                        arguments.push(Argument::from(Expression::new_boolean_literal(
                            span, true, &builder,
                        )));
                    }
                    let mut call = Expression::new_call_expression(
                        span, callee, NONE, arguments, false, &builder,
                    );
                    if let Some(cleanup_helper) = cleanup_helper {
                        let cleanup = Expression::new_identifier(
                            span,
                            self.allocator.alloc_str(&cleanup_helper),
                            &builder,
                        );
                        let mut cleanup_arguments = ArenaVec::new_in(&self.allocator);
                        cleanup_arguments.push(Argument::from(call));
                        call = Expression::new_call_expression(
                            span,
                            cleanup,
                            NONE,
                            cleanup_arguments,
                            false,
                            &builder,
                        );
                    }
                    statements.push(Statement::new_expression_statement(span, call, &builder));
                }
                FineJsxStep::Ref {
                    element,
                    helper,
                    reference_origin,
                } => {
                    let location = (reference_origin.start(), reference_origin.end());
                    let Some(mut reference) = values.remove(&location) else {
                        self.diagnostics.push(
                            emit_error(
                                "FICT-OXC-EMIT-ORIGIN",
                                "ref binding origin does not identify a JSX ref expression",
                                GuaranteeClass::Internal,
                            )
                            .with_primary_span(reference_origin),
                        );
                        continue;
                    };
                    self.visit_expression(&mut reference);
                    let callee = Expression::new_identifier(
                        span,
                        self.allocator.alloc_str(&helper),
                        &builder,
                    );
                    let element = Expression::new_identifier(
                        span,
                        self.allocator.alloc_str(&element),
                        &builder,
                    );
                    let mut arguments = ArenaVec::new_in(&self.allocator);
                    arguments.extend([Argument::from(element), Argument::from(reference)]);
                    let call = Expression::new_call_expression(
                        span, callee, NONE, arguments, false, &builder,
                    );
                    statements.push(Statement::new_expression_statement(span, call, &builder));
                }
                FineJsxStep::Evaluate { value_origin } => {
                    let location = (value_origin.start(), value_origin.end());
                    if self.suppressed_evaluations.contains(&location) {
                        values.remove(&location);
                        continue;
                    }
                    let Some(mut value) = values.remove(&location) else {
                        self.diagnostics.push(
                            emit_error(
                                "FICT-OXC-EMIT-ORIGIN",
                                "discarded JSX value origin does not identify an expression",
                                GuaranteeClass::Internal,
                            )
                            .with_primary_span(value_origin),
                        );
                        continue;
                    };
                    self.visit_expression(&mut value);
                    statements.push(Statement::new_expression_statement(span, value, &builder));
                }
                FineJsxStep::Insert {
                    parent,
                    before,
                    helper,
                    create_helper,
                    fragment_local,
                    namespace,
                    value_origin,
                } => {
                    let location = (value_origin.start(), value_origin.end());
                    let Some(mut value) = values.remove(&location) else {
                        self.diagnostics.push(
                            emit_error(
                                "FICT-OXC-EMIT-ORIGIN",
                                "child insertion origin does not identify a JSX value expression",
                                GuaranteeClass::Internal,
                            )
                            .with_primary_span(value_origin),
                        );
                        continue;
                    };
                    let previous_fragment = self.active_fragment_local.clone();
                    if let Some(fragment_local) = fragment_local {
                        self.active_fragment_local = Some(fragment_local);
                    }
                    self.vnode_depth += 1;
                    self.visit_expression(&mut value);
                    self.vnode_depth -= 1;
                    self.active_fragment_local = previous_fragment;
                    let getter = zero_parameter_expression_arrow(self.allocator, value, span);
                    let callee = Expression::new_identifier(
                        span,
                        self.allocator.alloc_str(&helper),
                        &builder,
                    );
                    let create = insertion_create_callback(
                        self.allocator,
                        &create_helper,
                        namespace,
                        &parent,
                        span,
                    );
                    let parent = Expression::new_identifier(
                        span,
                        self.allocator.alloc_str(&parent),
                        &builder,
                    );
                    let mut arguments = ArenaVec::new_in(&self.allocator);
                    arguments.extend([Argument::from(parent), Argument::from(getter)]);
                    if let Some(before) = before {
                        arguments.push(Argument::from(Expression::new_identifier(
                            span,
                            self.allocator.alloc_str(&before),
                            &builder,
                        )));
                    }
                    arguments.push(Argument::from(create));
                    let call = Expression::new_call_expression(
                        span, callee, NONE, arguments, false, &builder,
                    );
                    statements.push(Statement::new_expression_statement(span, call, &builder));
                }
                FineJsxStep::Conditional {
                    target,
                    parent,
                    start,
                    end,
                    kind,
                    helper,
                    create_helper,
                    cleanup_helper,
                    fragment_local,
                    namespace,
                    value_origin,
                } => {
                    let location = (value_origin.start(), value_origin.end());
                    let Some(value) = values.remove(&location) else {
                        self.diagnostics.push(
                            emit_error(
                                "FICT-OXC-EMIT-ORIGIN",
                                "conditional origin does not identify a JSX child expression",
                                GuaranteeClass::Internal,
                            )
                            .with_primary_span(value_origin),
                        );
                        continue;
                    };
                    let (mut test, consequent, alternate) =
                        match (kind, value.into_inner_expression()) {
                            (
                                ConditionalKind::Ternary,
                                Expression::ConditionalExpression(conditional),
                            ) => {
                                let conditional = conditional.unbox();
                                (
                                    conditional.test,
                                    conditional.consequent,
                                    Some(conditional.alternate),
                                )
                            }
                            (
                                ConditionalKind::LogicalAnd,
                                Expression::LogicalExpression(logical),
                            ) if logical.operator == OxcLogicalOperator::And => {
                                let logical = logical.unbox();
                                (logical.left, logical.right, None)
                            }
                            _ => {
                                self.diagnostics.push(
                                emit_error(
                                    "FICT-OXC-EMIT-CONDITIONAL",
                                    "conditional source expression does not match its EmitIR kind",
                                    GuaranteeClass::Internal,
                                )
                                .with_primary_span(value_origin),
                            );
                                continue;
                            }
                        };
                    self.visit_expression(&mut test);
                    let consequent =
                        self.lower_conditional_branch(consequent, fragment_local.as_deref());
                    let alternate = alternate.map(|alternate| {
                        self.lower_conditional_branch(alternate, fragment_local.as_deref())
                    });
                    let condition = zero_parameter_expression_arrow(self.allocator, test, span);
                    let consequent =
                        zero_parameter_expression_arrow(self.allocator, consequent, span);
                    let create = insertion_create_callback(
                        self.allocator,
                        &create_helper,
                        namespace,
                        &parent,
                        span,
                    );
                    let alternate = alternate.map_or_else(
                        || {
                            Expression::new_unary_expression(
                                span,
                                OxcUnaryOperator::Void,
                                Expression::new_numeric_literal(
                                    span,
                                    0.0,
                                    None,
                                    NumberBase::Decimal,
                                    &builder,
                                ),
                                &builder,
                            )
                        },
                        |alternate| {
                            zero_parameter_expression_arrow(self.allocator, alternate, span)
                        },
                    );
                    let callee = Expression::new_identifier(
                        span,
                        self.allocator.alloc_str(&helper),
                        &builder,
                    );
                    let mut arguments = ArenaVec::new_in(&self.allocator);
                    arguments.extend([
                        Argument::from(condition),
                        Argument::from(consequent),
                        Argument::from(create),
                        Argument::from(alternate),
                        Argument::from(Expression::new_identifier(
                            span,
                            self.allocator.alloc_str(&start),
                            &builder,
                        )),
                        Argument::from(Expression::new_identifier(
                            span,
                            self.allocator.alloc_str(&end),
                            &builder,
                        )),
                    ]);
                    let call = Expression::new_call_expression(
                        span, callee, NONE, arguments, false, &builder,
                    );
                    statements.push(const_statement(self.allocator, &target, call, span));

                    let target_expression = Expression::new_identifier(
                        span,
                        self.allocator.alloc_str(&target),
                        &builder,
                    );
                    let dispose = Expression::new_static_member_expression(
                        span,
                        target_expression,
                        IdentifierName::new(span, "dispose", &builder),
                        false,
                        &builder,
                    );
                    let cleanup = Expression::new_identifier(
                        span,
                        self.allocator.alloc_str(&cleanup_helper),
                        &builder,
                    );
                    let mut cleanup_arguments = ArenaVec::new_in(&self.allocator);
                    cleanup_arguments.push(Argument::from(dispose));
                    let cleanup_call = Expression::new_call_expression(
                        span,
                        cleanup,
                        NONE,
                        cleanup_arguments,
                        false,
                        &builder,
                    );
                    statements.push(Statement::new_expression_statement(
                        span,
                        cleanup_call,
                        &builder,
                    ));
                }
                FineJsxStep::KeyedList {
                    target,
                    parent,
                    start,
                    end,
                    helper,
                    cleanup_helper,
                    namespace,
                    value_origin,
                    items_origin,
                    key_origin,
                    render_key,
                    item_references,
                    index_references,
                    needs_index,
                } => {
                    let location = (value_origin.start(), value_origin.end());
                    let Some(value) = values.remove(&location) else {
                        self.diagnostics.push(
                            emit_error(
                                "FICT-OXC-EMIT-ORIGIN",
                                "keyed child origin does not identify its map expression",
                                GuaranteeClass::Internal,
                            )
                            .with_primary_span(value_origin),
                        );
                        continue;
                    };
                    self.lower_keyed_list_step(
                        value,
                        &target,
                        &parent,
                        &start,
                        &end,
                        &helper,
                        &cleanup_helper,
                        namespace,
                        items_origin,
                        key_origin,
                        &render_key,
                        &item_references,
                        &index_references,
                        needs_index,
                        span,
                        &mut statements,
                    );
                }
            }
        }
        let root =
            Expression::new_identifier(span, self.allocator.alloc_str(&clone.root), &builder);
        statements.push(Statement::new_return_statement(span, Some(root), &builder));
        block_iife(self.allocator, statements, span)
    }

    fn lower_conditional_branch(
        &mut self,
        mut branch: Expression<'a>,
        fragment_local: Option<&str>,
    ) -> Expression<'a> {
        let previous_fragment = self.active_fragment_local.clone();
        if let Some(fragment_local) = fragment_local {
            self.active_fragment_local = Some(fragment_local.to_owned());
        }
        self.vnode_depth += 1;
        self.visit_expression(&mut branch);
        self.vnode_depth -= 1;
        self.active_fragment_local = previous_fragment;
        branch
    }

    #[allow(clippy::too_many_arguments)]
    fn lower_keyed_list_step(
        &mut self,
        map: Expression<'a>,
        target: &str,
        _parent: &str,
        start: &str,
        end: &str,
        helper: &str,
        cleanup_helper: &str,
        namespace: DomNamespace,
        items_origin: SourceSpan,
        key_origin: SourceSpan,
        render_key: &str,
        item_references: &[SourceSpan],
        index_references: &[SourceSpan],
        needs_index: bool,
        span: Span,
        statements: &mut ArenaVec<'a, Statement<'a>>,
    ) {
        let Expression::CallExpression(call) = map.into_inner_expression() else {
            self.diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-KEYED",
                    "keyed child source is not a direct map call",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(items_origin),
            );
            return;
        };
        let mut call = call.unbox();
        let mut items = match call.callee.into_inner_expression() {
            Expression::StaticMemberExpression(member) => member.unbox().object,
            Expression::ComputedMemberExpression(member) => member.unbox().object,
            _ => {
                self.diagnostics.push(
                    emit_error(
                        "FICT-OXC-EMIT-KEYED",
                        "keyed child map callee is not a static member access",
                        GuaranteeClass::Internal,
                    )
                    .with_primary_span(items_origin),
                );
                return;
            }
        };
        if (items.span().start, items.span().end) != (items_origin.start(), items_origin.end()) {
            self.diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-ORIGIN",
                    "keyed child items origin does not match its map receiver",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(items_origin),
            );
            return;
        }
        let Some(callback) = call.arguments.pop() else {
            self.diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-KEYED",
                    "keyed child map call has no render callback",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(items_origin),
            );
            return;
        };
        let Expression::ArrowFunctionExpression(mut render_callback) =
            callback.into_expression().into_inner_expression()
        else {
            self.diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-KEYED",
                    "keyed child render callback is not an inline arrow function",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(key_origin),
            );
            return;
        };
        let Some(render_body) = direct_arrow_return_expression(&render_callback) else {
            self.diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-KEYED",
                    "keyed child render callback has no direct return expression",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(key_origin),
            );
            return;
        };
        let Some(mut key_expression) =
            clone_direct_jsx_key_expression(self.allocator, render_body, key_origin)
        else {
            self.diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-KEYED",
                    "keyed child key origin does not identify a direct JSX key",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(key_origin),
            );
            return;
        };
        self.visit_expression(&mut items);
        self.visit_expression(&mut key_expression);

        let mut key_callback = render_callback.clone_in(self.allocator);
        replace_arrow_body_with_expression(self.allocator, &mut key_callback, key_expression);
        let key_callback = Expression::ArrowFunctionExpression(key_callback);
        append_arrow_parameter(self.allocator, &mut render_callback, render_key, span);

        let expected_reads: BTreeSet<_> = item_references
            .iter()
            .chain(index_references)
            .map(|origin| (origin.start(), origin.end()))
            .collect();
        let previous_reads = std::mem::replace(&mut self.active_list_reads, expected_reads.clone());
        let previous_matches = std::mem::take(&mut self.matched_list_reads);
        let previous_key_local = self.active_list_key_local.replace(render_key.to_owned());
        let previous_key_origin = self
            .active_list_key_origin
            .replace((key_origin.start(), key_origin.end()));
        let previous_suppressed = self.suppressed_evaluations.clone();
        self.suppressed_evaluations
            .insert((key_origin.start(), key_origin.end()));
        let mut render_callback = Expression::ArrowFunctionExpression(render_callback);
        self.prefer_template_clones += 1;
        self.visit_expression(&mut render_callback);
        self.prefer_template_clones -= 1;
        let matched_reads = std::mem::take(&mut self.matched_list_reads);
        self.active_list_reads = previous_reads;
        self.matched_list_reads = previous_matches;
        self.active_list_key_local = previous_key_local;
        self.active_list_key_origin = previous_key_origin;
        self.suppressed_evaluations = previous_suppressed;
        if matched_reads != expected_reads {
            self.diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-KEYED-READ",
                    "keyed child did not materialize every binding-aware callback read",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(key_origin),
            );
            return;
        }

        let builder = AstBuilder::new(self.allocator);
        let get_items = zero_parameter_expression_arrow(self.allocator, items, span);
        let callee = Expression::new_identifier(span, self.allocator.alloc_str(helper), &builder);
        let mut arguments = ArenaVec::new_in(&self.allocator);
        arguments.extend([
            Argument::from(get_items),
            Argument::from(key_callback),
            Argument::from(render_callback),
            Argument::from(Expression::new_boolean_literal(span, needs_index, &builder)),
            Argument::from(Expression::new_identifier(
                span,
                self.allocator.alloc_str(start),
                &builder,
            )),
            Argument::from(Expression::new_identifier(
                span,
                self.allocator.alloc_str(end),
                &builder,
            )),
            Argument::from(Expression::new_boolean_literal(span, true, &builder)),
        ]);
        if let Some(namespace) = keyed_list_namespace(namespace) {
            arguments.push(Argument::from(Expression::new_string_literal(
                span, namespace, None, &builder,
            )));
        }
        let call = Expression::new_call_expression(span, callee, NONE, arguments, false, &builder);
        statements.push(const_statement(self.allocator, target, call, span));

        let target_expression =
            Expression::new_identifier(span, self.allocator.alloc_str(target), &builder);
        let flush = Expression::new_static_member_expression(
            span,
            target_expression,
            IdentifierName::new(span, "flush", &builder),
            false,
            &builder,
        );
        let flush_call = Expression::new_call_expression(
            span,
            flush,
            NONE,
            ArenaVec::new_in(&self.allocator),
            true,
            &builder,
        );
        let Expression::CallExpression(flush_call) = flush_call else {
            unreachable!("call builder returns a call expression")
        };
        let flush_chain = Expression::new_chain_expression(
            span,
            ChainElement::CallExpression(flush_call),
            &builder,
        );
        statements.push(Statement::new_expression_statement(
            span,
            flush_chain,
            &builder,
        ));

        let target_expression =
            Expression::new_identifier(span, self.allocator.alloc_str(target), &builder);
        let dispose = Expression::new_static_member_expression(
            span,
            target_expression,
            IdentifierName::new(span, "dispose", &builder),
            false,
            &builder,
        );
        let cleanup =
            Expression::new_identifier(span, self.allocator.alloc_str(cleanup_helper), &builder);
        let mut cleanup_arguments = ArenaVec::new_in(&self.allocator);
        cleanup_arguments.push(Argument::from(dispose));
        let cleanup_call = Expression::new_call_expression(
            span,
            cleanup,
            NONE,
            cleanup_arguments,
            false,
            &builder,
        );
        statements.push(Statement::new_expression_statement(
            span,
            cleanup_call,
            &builder,
        ));
    }

    fn lower_planned_jsx_element(&mut self, element: JSXElement<'a>) -> Expression<'a> {
        let location = (element.span.start, element.span.end);
        let Some(component) = self.components.get(&location).cloned() else {
            return self.lower_jsx_element(element);
        };
        let previous_fragment = self.active_fragment_local.clone();
        self.active_fragment_local = component.fragment_local.clone();
        let lowered = self.lower_component_element(element, component);
        self.active_fragment_local = previous_fragment;
        self.matched_components.insert(location);
        lowered
    }

    fn lower_component_element(
        &mut self,
        element: JSXElement<'a>,
        component: ComponentRewrite,
    ) -> Expression<'a> {
        let span = element.span;
        if !component_children_match(&element.children, &component.children) {
            self.diagnostics.push(emit_error(
                "FICT-OXC-EMIT-COMPONENT",
                "component children do not match their EmitIR plan",
                GuaranteeClass::Internal,
            ));
        }
        let opening = element.opening_element.unbox();
        let element_type = self.lower_jsx_element_name(opening.name);
        let mut planned_props = component.props.into_iter();
        let mut properties = ArenaVec::new_in(&self.allocator);
        let mut prop_segments = Vec::new();
        let mut key = None;
        for attribute in opening.attributes {
            let planned = planned_props.next();
            match attribute {
                JSXAttributeItem::SpreadAttribute(spread) => {
                    if !matches!(planned, Some(ComponentProp::Spread(_))) {
                        self.diagnostics.push(emit_error(
                            "FICT-OXC-EMIT-COMPONENT",
                            "component spread prop does not match its EmitIR plan",
                            GuaranteeClass::Internal,
                        ));
                    }
                    let spread = spread.unbox();
                    if !properties.is_empty() {
                        let bucket =
                            std::mem::replace(&mut properties, ArenaVec::new_in(&self.allocator));
                        prop_segments.push(Expression::new_object_expression(
                            spread.span,
                            bucket,
                            &AstBuilder::new(self.allocator),
                        ));
                    }
                    let mut value = spread.argument;
                    self.visit_expression(&mut value);
                    prop_segments.push(value);
                }
                JSXAttributeItem::Attribute(attribute) => {
                    let attribute = attribute.unbox();
                    let (name, name_span) = jsx_attribute_name(attribute.name);
                    let source_node_span = jsx_attribute_node_span(&attribute.value);
                    let (getter, non_reactive) = match planned {
                        Some(ComponentProp::Named {
                            name: planned_name,
                            getter,
                            non_reactive,
                            ..
                        }) if planned_name == name && source_node_span.is_none() => {
                            (getter, non_reactive)
                        }
                        Some(ComponentProp::Node {
                            name: planned_name,
                            origin,
                        }) if planned_name == name
                            && source_node_span.is_some_and(|span| {
                                component_node_origin_matches(origin, span)
                            }) =>
                        {
                            (false, false)
                        }
                        _ => {
                            self.diagnostics.push(emit_error(
                                "FICT-OXC-EMIT-COMPONENT",
                                "component named prop does not match its EmitIR plan",
                                GuaranteeClass::Internal,
                            ));
                            (false, false)
                        }
                    };
                    let keyed_runtime_value = (name == "key")
                        .then(|| jsx_attribute_source_span(&attribute.value))
                        .flatten()
                        .filter(|source| {
                            self.active_list_key_origin == Some((source.start, source.end))
                        })
                        .and_then(|_| self.active_list_key_local.clone());
                    let mut value = match keyed_runtime_value {
                        Some(local) => Expression::new_identifier(
                            name_span,
                            self.allocator.alloc_str(&local),
                            &AstBuilder::new(self.allocator),
                        ),
                        None => self.lower_jsx_attribute_value(attribute.value, attribute.span),
                    };
                    if getter {
                        if let Some(helper) = &component.prop_helper {
                            let arrow =
                                zero_parameter_expression_arrow(self.allocator, value, name_span);
                            let callee = Expression::new_identifier(
                                name_span,
                                self.allocator.alloc_str(helper),
                                &AstBuilder::new(self.allocator),
                            );
                            let mut arguments = ArenaVec::new_in(&self.allocator);
                            arguments.push(Argument::from(arrow));
                            value = Expression::new_call_expression(
                                name_span,
                                callee,
                                NONE,
                                arguments,
                                false,
                                &AstBuilder::new(self.allocator),
                            );
                        } else {
                            self.diagnostics.push(emit_error(
                                "FICT-OXC-EMIT-COMPONENT",
                                "reactive component prop has no runtime prop helper",
                                GuaranteeClass::Internal,
                            ));
                        }
                    }
                    if non_reactive {
                        if let Some(helper) = &component.non_reactive_helper {
                            let callee = Expression::new_identifier(
                                name_span,
                                self.allocator.alloc_str(helper),
                                &AstBuilder::new(self.allocator),
                            );
                            let mut arguments = ArenaVec::new_in(&self.allocator);
                            arguments.push(Argument::from(value));
                            value = Expression::new_call_expression(
                                name_span,
                                callee,
                                NONE,
                                arguments,
                                false,
                                &AstBuilder::new(self.allocator),
                            );
                        } else {
                            self.diagnostics.push(emit_error(
                                "FICT-OXC-EMIT-COMPONENT",
                                "function component prop has no non-reactive runtime helper",
                                GuaranteeClass::Internal,
                            ));
                        }
                    }
                    if name == "key" {
                        key = Some(value);
                    } else {
                        properties.push(self.object_property(name_span, &name, value));
                    }
                }
            }
        }
        if planned_props.next().is_some() {
            self.diagnostics.push(emit_error(
                "FICT-OXC-EMIT-COMPONENT",
                "component EmitIR has props absent from its source JSX",
                GuaranteeClass::Internal,
            ));
        }
        if let Some(mut children) = self.lower_jsx_children(
            element.children,
            span,
            Some((
                &component.children,
                component.non_reactive_helper.as_deref(),
            )),
        ) {
            if let Some(helper) = &component.children_helper {
                let getter = zero_parameter_expression_arrow(self.allocator, children, span);
                let callee = Expression::new_identifier(
                    span,
                    self.allocator.alloc_str(helper),
                    &AstBuilder::new(self.allocator),
                );
                let mut arguments = ArenaVec::new_in(&self.allocator);
                arguments.push(Argument::from(getter));
                children = Expression::new_call_expression(
                    span,
                    callee,
                    NONE,
                    arguments,
                    false,
                    &AstBuilder::new(self.allocator),
                );
            }
            properties.push(self.object_property(span, "children", children));
        }

        let builder = AstBuilder::new(self.allocator);
        if !properties.is_empty() {
            prop_segments.push(Expression::new_object_expression(
                span, properties, &builder,
            ));
        }
        let props = if prop_segments.is_empty() {
            Expression::new_null_literal(span, &builder)
        } else if let Some(helper) = &component.merge_helper {
            let callee =
                Expression::new_identifier(span, self.allocator.alloc_str(helper), &builder);
            let mut arguments = ArenaVec::new_in(&self.allocator);
            arguments.extend(prop_segments.into_iter().map(Argument::from));
            Expression::new_call_expression(span, callee, NONE, arguments, false, &builder)
        } else {
            if prop_segments.len() != 1 {
                self.diagnostics.push(emit_error(
                    "FICT-OXC-EMIT-COMPONENT",
                    "segmented component props have no runtime merge helper",
                    GuaranteeClass::Internal,
                ));
            }
            prop_segments
                .into_iter()
                .next()
                .expect("non-empty component prop segments")
        };
        let mut vnode = ArenaVec::new_in(&self.allocator);
        vnode.push(self.object_property(span, "type", element_type));
        vnode.push(self.object_property(span, "props", props));
        if let Some(key) = key {
            vnode.push(self.object_property(span, "key", key));
        }
        Expression::new_object_expression(span, vnode, &builder)
    }

    fn lower_jsx_expression(&mut self, expression: Expression<'a>) -> Expression<'a> {
        match expression {
            Expression::JSXElement(element) => self.lower_planned_jsx_element(element.unbox()),
            Expression::JSXFragment(fragment) => self.lower_jsx_fragment(fragment.unbox()),
            _ => unreachable!("VNode lowering only accepts JSX expressions"),
        }
    }

    fn lower_jsx_element(&mut self, element: JSXElement<'a>) -> Expression<'a> {
        let span = element.span;
        let opening = element.opening_element.unbox();
        let element_type = self.lower_jsx_element_name(opening.name);
        let mut properties = ArenaVec::new_in(&self.allocator);
        let mut key = None;

        for attribute in opening.attributes {
            match attribute {
                JSXAttributeItem::SpreadAttribute(spread) => {
                    let spread = spread.unbox();
                    let mut value = spread.argument;
                    self.visit_expression(&mut value);
                    properties.push(ObjectPropertyKind::new_spread_property(
                        spread.span,
                        value,
                        &AstBuilder::new(self.allocator),
                    ));
                }
                JSXAttributeItem::Attribute(attribute) => {
                    let attribute = attribute.unbox();
                    let (name, name_span) = jsx_attribute_name(attribute.name);
                    let value = self.lower_jsx_attribute_value(attribute.value, attribute.span);
                    if name == "key" {
                        key = Some(value);
                    } else {
                        properties.push(self.object_property(name_span, &name, value));
                    }
                }
            }
        }

        if let Some(children) = self.lower_jsx_children(element.children, span, None) {
            properties.push(self.object_property(span, "children", children));
        }

        let builder = AstBuilder::new(self.allocator);
        let props = if properties.is_empty() {
            Expression::new_null_literal(span, &builder)
        } else {
            Expression::new_object_expression(span, properties, &builder)
        };
        let mut vnode = ArenaVec::new_in(&self.allocator);
        vnode.push(self.object_property(span, "type", element_type));
        vnode.push(self.object_property(span, "props", props));
        if let Some(key) = key {
            vnode.push(self.object_property(span, "key", key));
        }
        Expression::new_object_expression(span, vnode, &builder)
    }

    fn lower_jsx_fragment(&mut self, fragment: JSXFragment<'a>) -> Expression<'a> {
        let span = fragment.span;
        let builder = AstBuilder::new(self.allocator);
        let element_type = if let Some(local) = &self.active_fragment_local {
            Expression::new_identifier(span, self.allocator.alloc_str(local), &builder)
        } else {
            let mut diagnostic = emit_error(
                "FICT-OXC-EMIT-FRAGMENT",
                "JSX fragment lowering requires an EmitIR runtime Fragment helper",
                GuaranteeClass::Internal,
            );
            diagnostic.primary_span = SourceSpan::new(span.start, span.end);
            self.diagnostics.push(diagnostic);
            Expression::new_null_literal(span, &builder)
        };
        let children = self.lower_jsx_children(fragment.children, span, None);
        let props = children.map_or_else(
            || Expression::new_null_literal(span, &builder),
            |children| {
                let mut properties = ArenaVec::new_in(&self.allocator);
                properties.push(self.object_property(span, "children", children));
                Expression::new_object_expression(span, properties, &builder)
            },
        );
        let mut vnode = ArenaVec::new_in(&self.allocator);
        vnode.push(self.object_property(span, "type", element_type));
        vnode.push(self.object_property(span, "props", props));
        Expression::new_object_expression(span, vnode, &builder)
    }

    fn lower_jsx_element_name(&mut self, name: JSXElementName<'a>) -> Expression<'a> {
        let builder = AstBuilder::new(self.allocator);
        match name {
            JSXElementName::Identifier(identifier) => {
                Expression::new_string_literal(identifier.span, identifier.name, None, &builder)
            }
            JSXElementName::IdentifierReference(identifier) => {
                let mut expression = Expression::Identifier(identifier);
                self.visit_expression(&mut expression);
                expression
            }
            JSXElementName::NamespacedName(name) => {
                let value = format!("{}:{}", name.namespace.name, name.name.name);
                Expression::new_string_literal(
                    name.span,
                    self.allocator.alloc_str(&value),
                    None,
                    &builder,
                )
            }
            JSXElementName::MemberExpression(member) => {
                self.lower_jsx_member_expression(member.unbox())
            }
            JSXElementName::ThisExpression(expression) => Expression::ThisExpression(expression),
        }
    }

    fn lower_jsx_member_expression(&mut self, member: JSXMemberExpression<'a>) -> Expression<'a> {
        let object = match member.object {
            JSXMemberExpressionObject::IdentifierReference(identifier) => {
                let mut expression = Expression::Identifier(identifier);
                self.visit_expression(&mut expression);
                expression
            }
            JSXMemberExpressionObject::MemberExpression(parent) => {
                self.lower_jsx_member_expression(parent.unbox())
            }
            JSXMemberExpressionObject::ThisExpression(expression) => {
                Expression::ThisExpression(expression)
            }
        };
        let property = IdentifierName::new(
            member.property.span,
            member.property.name,
            &AstBuilder::new(self.allocator),
        );
        Expression::new_static_member_expression(
            member.span,
            object,
            property,
            false,
            &AstBuilder::new(self.allocator),
        )
    }

    fn lower_jsx_attribute_value(
        &mut self,
        value: Option<JSXAttributeValue<'a>>,
        span: Span,
    ) -> Expression<'a> {
        let builder = AstBuilder::new(self.allocator);
        match value {
            None => Expression::new_boolean_literal(span, true, &builder),
            Some(JSXAttributeValue::StringLiteral(literal)) => {
                let literal = literal.unbox();
                let decoded = crate::jsx_text::decode_entities(literal.value.as_str());
                Expression::new_string_literal_with_lone_surrogates(
                    literal.span,
                    self.allocator.alloc_str(&decoded),
                    None,
                    literal.lone_surrogates,
                    &builder,
                )
            }
            Some(JSXAttributeValue::ExpressionContainer(container)) => {
                let container = container.unbox();
                if container.expression.is_expression() {
                    self.lower_jsx_container_expression(container.expression.into_expression())
                } else {
                    Expression::new_boolean_literal(span, true, &builder)
                }
            }
            Some(JSXAttributeValue::Element(element)) => {
                self.lower_planned_jsx_element(element.unbox())
            }
            Some(JSXAttributeValue::Fragment(fragment)) => {
                self.lower_jsx_fragment(fragment.unbox())
            }
        }
    }

    fn lower_jsx_children(
        &mut self,
        children: ArenaVec<'a, JSXChild<'a>>,
        span: Span,
        component: Option<(&[ComponentChild], Option<&str>)>,
    ) -> Option<Expression<'a>> {
        let (mut planned, non_reactive_helper) = component
            .map_or((None, None), |(planned, helper)| {
                (Some(planned.iter()), helper)
            });
        let mut lowered = Vec::new();
        for child in children {
            match child {
                JSXChild::Text(text) => {
                    if let Some(value) = crate::jsx_text::normalize_text(text.value.as_str()) {
                        let _ = planned.as_mut().and_then(Iterator::next);
                        lowered.push(VNodeChild::Value(Expression::new_string_literal(
                            text.span,
                            self.allocator.alloc_str(&value),
                            None,
                            &AstBuilder::new(self.allocator),
                        )));
                    }
                }
                JSXChild::Element(element) => {
                    let _ = planned.as_mut().and_then(Iterator::next);
                    lowered.push(VNodeChild::Value(
                        self.lower_planned_jsx_element(element.unbox()),
                    ));
                }
                JSXChild::Fragment(fragment) => {
                    let _ = planned.as_mut().and_then(Iterator::next);
                    lowered.push(VNodeChild::Value(self.lower_jsx_fragment(fragment.unbox())))
                }
                JSXChild::ExpressionContainer(container) => {
                    let container = container.unbox();
                    if container.expression.is_expression() {
                        let plan = planned.as_mut().and_then(Iterator::next);
                        let expression = self
                            .lower_jsx_container_expression(container.expression.into_expression());
                        lowered.push(VNodeChild::Value(self.wrap_non_reactive_component_child(
                            expression,
                            plan,
                            non_reactive_helper,
                            container.span,
                        )));
                    }
                }
                JSXChild::Spread(spread) => {
                    let spread = spread.unbox();
                    let plan = planned.as_mut().and_then(Iterator::next);
                    let mut expression = spread.expression;
                    self.visit_expression(&mut expression);
                    let expression = self.wrap_non_reactive_component_child(
                        expression,
                        plan,
                        non_reactive_helper,
                        spread.span,
                    );
                    lowered.push(VNodeChild::Spread(spread.span, expression));
                }
            }
        }
        match lowered.as_mut_slice() {
            [] => None,
            [VNodeChild::Value(_)] => match lowered.pop().expect("one JSX child") {
                VNodeChild::Value(value) => Some(value),
                VNodeChild::Spread(_, _) => unreachable!(),
            },
            _ => {
                let mut elements = ArenaVec::new_in(&self.allocator);
                for child in lowered {
                    match child {
                        VNodeChild::Value(value) => {
                            elements.push(ArrayExpressionElement::from(value));
                        }
                        VNodeChild::Spread(spread_span, value) => {
                            elements.push(ArrayExpressionElement::new_spread_element(
                                spread_span,
                                value,
                                &AstBuilder::new(self.allocator),
                            ));
                        }
                    }
                }
                Some(Expression::new_array_expression(
                    span,
                    elements,
                    &AstBuilder::new(self.allocator),
                ))
            }
        }
    }

    fn wrap_non_reactive_component_child(
        &mut self,
        value: Expression<'a>,
        plan: Option<&ComponentChild>,
        helper: Option<&str>,
        span: Span,
    ) -> Expression<'a> {
        if !matches!(
            plan,
            Some(ComponentChild::Value {
                non_reactive: true,
                ..
            })
        ) {
            return value;
        }
        let Some(helper) = helper else {
            self.diagnostics.push(emit_error(
                "FICT-OXC-EMIT-COMPONENT",
                "function component child has no non-reactive runtime helper",
                GuaranteeClass::Internal,
            ));
            return value;
        };
        let builder = AstBuilder::new(self.allocator);
        let callee = Expression::new_identifier(span, self.allocator.alloc_str(helper), &builder);
        let mut arguments = ArenaVec::new_in(&self.allocator);
        arguments.push(Argument::from(value));
        Expression::new_call_expression(span, callee, NONE, arguments, false, &builder)
    }

    fn lower_jsx_container_expression(&mut self, mut expression: Expression<'a>) -> Expression<'a> {
        if matches!(
            expression.get_inner_expression(),
            Expression::JSXElement(_) | Expression::JSXFragment(_)
        ) {
            self.lower_jsx_expression(expression.into_inner_expression())
        } else {
            self.vnode_depth += 1;
            self.visit_expression(&mut expression);
            self.vnode_depth -= 1;
            expression
        }
    }

    fn object_property(
        &self,
        span: Span,
        name: &str,
        value: Expression<'a>,
    ) -> ObjectPropertyKind<'a> {
        let builder = AstBuilder::new(self.allocator);
        let computed = name == "__proto__";
        let key = if !computed && is_identifier_name(name) {
            PropertyKey::new_static_identifier(span, self.allocator.alloc_str(name), &builder)
        } else {
            PropertyKey::new_string_literal(span, self.allocator.alloc_str(name), None, &builder)
        };
        ObjectPropertyKind::new_object_property(
            span,
            PropertyKind::Init,
            key,
            value,
            false,
            false,
            computed,
            &builder,
        )
    }

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

fn jsx_dynamic_values<'a>(
    jsx: Expression<'a>,
    components: &BTreeMap<(u32, u32), ComponentRewrite>,
) -> BTreeMap<(u32, u32), Expression<'a>> {
    let mut values = BTreeMap::new();
    match jsx {
        Expression::JSXElement(element) => {
            collect_jsx_element_values(element.unbox(), &mut values, components);
        }
        Expression::JSXFragment(fragment) => {
            collect_jsx_children_values(fragment.unbox().children, &mut values, components);
        }
        _ => unreachable!("template clone source must be JSX"),
    }
    values
}

fn collect_jsx_element_values<'a>(
    element: JSXElement<'a>,
    values: &mut BTreeMap<(u32, u32), Expression<'a>>,
    components: &BTreeMap<(u32, u32), ComponentRewrite>,
) {
    for attribute in element.opening_element.unbox().attributes {
        match attribute {
            JSXAttributeItem::SpreadAttribute(spread) => {
                let spread = spread.unbox();
                let span = spread.argument.span();
                values.insert((span.start, span.end), spread.argument);
            }
            JSXAttributeItem::Attribute(attribute) => {
                if let Some(value) = attribute.unbox().value {
                    match value {
                        JSXAttributeValue::ExpressionContainer(container) => {
                            let expression = container.unbox().expression;
                            if expression.is_expression() {
                                collect_jsx_expression_value(
                                    expression.into_expression(),
                                    values,
                                    components,
                                );
                            }
                        }
                        JSXAttributeValue::Element(element) => {
                            let location = (element.span.start, element.span.end);
                            if components.contains_key(&location) {
                                values.insert(location, Expression::JSXElement(element));
                            } else {
                                collect_jsx_element_values(element.unbox(), values, components);
                            }
                        }
                        JSXAttributeValue::Fragment(fragment) => {
                            collect_jsx_children_values(
                                fragment.unbox().children,
                                values,
                                components,
                            );
                        }
                        JSXAttributeValue::StringLiteral(_) => {}
                    }
                }
            }
        }
    }
    collect_jsx_children_values(element.children, values, components);
}

fn collect_jsx_children_values<'a>(
    children: ArenaVec<'a, JSXChild<'a>>,
    values: &mut BTreeMap<(u32, u32), Expression<'a>>,
    components: &BTreeMap<(u32, u32), ComponentRewrite>,
) {
    for child in children {
        match child {
            JSXChild::Element(element) => {
                let location = (element.span.start, element.span.end);
                if components.contains_key(&location) {
                    values.insert(location, Expression::JSXElement(element));
                } else {
                    collect_jsx_element_values(element.unbox(), values, components);
                }
            }
            JSXChild::Fragment(fragment) => {
                collect_jsx_children_values(fragment.unbox().children, values, components);
            }
            JSXChild::ExpressionContainer(container) => {
                let expression = container.unbox().expression;
                if expression.is_expression() {
                    collect_jsx_expression_value(expression.into_expression(), values, components);
                }
            }
            JSXChild::Spread(spread) => {
                let spread = spread.unbox();
                let span = spread.expression.span();
                values.insert((span.start, span.end), spread.expression);
            }
            JSXChild::Text(_) => {}
        }
    }
}

fn collect_jsx_expression_value<'a>(
    expression: Expression<'a>,
    values: &mut BTreeMap<(u32, u32), Expression<'a>>,
    components: &BTreeMap<(u32, u32), ComponentRewrite>,
) {
    if matches!(
        expression.get_inner_expression(),
        Expression::JSXElement(_) | Expression::JSXFragment(_)
    ) {
        match expression.into_inner_expression() {
            Expression::JSXElement(element) => {
                let location = (element.span.start, element.span.end);
                if components.contains_key(&location) {
                    values.insert(location, Expression::JSXElement(element));
                } else {
                    collect_jsx_element_values(element.unbox(), values, components);
                }
            }
            Expression::JSXFragment(fragment) => {
                collect_jsx_children_values(fragment.unbox().children, values, components);
            }
            _ => unreachable!("inner JSX expression kind was checked"),
        }
    } else {
        let span = expression.span();
        values.insert((span.start, span.end), expression);
    }
}

fn const_statement<'a>(
    allocator: &'a Allocator,
    name: &str,
    initializer: Expression<'a>,
    span: Span,
) -> Statement<'a> {
    let builder = AstBuilder::new(allocator);
    let pattern = BindingPattern::new_binding_identifier(span, allocator.alloc_str(name), &builder);
    let declarator = VariableDeclarator::new(
        span,
        VariableDeclarationKind::Const,
        pattern,
        NONE,
        Some(initializer),
        false,
        &builder,
    );
    let mut declarations = ArenaVec::new_in(&allocator);
    declarations.push(declarator);
    Statement::new_variable_declaration(
        span,
        VariableDeclarationKind::Const,
        declarations,
        false,
        &builder,
    )
}

fn dom_literal_expression<'a>(
    allocator: &'a Allocator,
    value: &LiteralValue,
    span: Span,
) -> Option<Expression<'a>> {
    let builder = AstBuilder::new(allocator);
    match value {
        LiteralValue::Boolean(value) => {
            Some(Expression::new_boolean_literal(span, *value, &builder))
        }
        LiteralValue::String(value) => Some(Expression::new_string_literal(
            span,
            allocator.alloc_str(value),
            None,
            &builder,
        )),
        LiteralValue::Null
        | LiteralValue::Undefined
        | LiteralValue::Number(_)
        | LiteralValue::BigInt(_)
        | LiteralValue::RegExp { .. } => None,
    }
}

fn zero_parameter_expression_arrow<'a>(
    allocator: &'a Allocator,
    expression: Expression<'a>,
    span: Span,
) -> Expression<'a> {
    let builder = AstBuilder::new(allocator);
    let parameters = FormalParameters::boxed(
        span,
        FormalParameterKind::ArrowFormalParameters,
        ArenaVec::new_in(&allocator),
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

fn ignore_inline_event_handler_return<'a>(
    allocator: &'a Allocator,
    handler: Expression<'a>,
    span: Span,
) -> Expression<'a> {
    let arrow = matches!(handler, Expression::ArrowFunctionExpression(_));
    if !arrow && !matches!(handler, Expression::FunctionExpression(_)) {
        return handler;
    }

    let mut collector = IdentifierCollector::default();
    collector.visit_expression(&handler);
    let mut parameter = "__fictArgs".to_owned();
    let mut suffix = 1_u32;
    while collector.names.contains(&parameter) {
        parameter = format!("__fictArgs_{suffix}");
        suffix = suffix.saturating_add(1);
    }
    let parameter = allocator.alloc_str(&parameter);
    let builder = AstBuilder::new(allocator);
    let arguments = Expression::new_identifier(span, parameter, &builder);
    let call = if arrow {
        let mut call_arguments = ArenaVec::new_in(&allocator);
        call_arguments.push(Argument::new_spread_element(span, arguments, &builder));
        Expression::new_call_expression(span, handler, NONE, call_arguments, false, &builder)
    } else {
        let apply = Expression::new_static_member_expression(
            span,
            handler,
            IdentifierName::new(span, "apply", &builder),
            false,
            &builder,
        );
        let mut call_arguments = ArenaVec::new_in(&allocator);
        call_arguments.extend([
            Argument::from(Expression::new_this_expression(span, &builder)),
            Argument::from(arguments),
        ]);
        Expression::new_call_expression(span, apply, NONE, call_arguments, false, &builder)
    };
    let mut statements = ArenaVec::new_in(&allocator);
    statements.push(Statement::new_expression_statement(span, call, &builder));
    let body = FunctionBody::boxed(span, ArenaVec::new_in(&allocator), statements, &builder);
    let rest_pattern = BindingPattern::new_binding_identifier(span, parameter, &builder);
    let rest = BindingRestElement::new(span, rest_pattern, &builder);
    let rest = FormalParameterRest::boxed(span, ArenaVec::new_in(&allocator), rest, NONE, &builder);
    let parameter_kind = if arrow {
        FormalParameterKind::ArrowFormalParameters
    } else {
        FormalParameterKind::FormalParameter
    };
    let parameters = FormalParameters::boxed(
        span,
        parameter_kind,
        ArenaVec::new_in(&allocator),
        Some(rest),
        &builder,
    );
    if arrow {
        Expression::new_arrow_function_expression(
            span, false, false, NONE, parameters, NONE, body, &builder,
        )
    } else {
        Expression::new_function_expression(
            span,
            FunctionType::FunctionExpression,
            None,
            false,
            false,
            false,
            NONE,
            NONE,
            parameters,
            NONE,
            Some(body),
            &builder,
        )
    }
}

#[derive(Default)]
struct IdentifierCollector {
    names: BTreeSet<String>,
}

impl<'a> Visit<'a> for IdentifierCollector {
    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        self.names.insert(identifier.name.to_string());
    }
}

fn insertion_create_callback<'a>(
    allocator: &'a Allocator,
    helper: &str,
    namespace: DomNamespace,
    parent: &str,
    span: Span,
) -> Expression<'a> {
    let builder = AstBuilder::new(allocator);
    if namespace == DomNamespace::Html {
        return Expression::new_identifier(span, allocator.alloc_str(helper), &builder);
    }

    let parameter = allocator.alloc_str("__fict_child");
    let callee = Expression::new_identifier(span, allocator.alloc_str(helper), &builder);
    let child = Expression::new_identifier(span, parameter, &builder);
    let mut arguments = ArenaVec::new_in(&allocator);
    arguments.push(Argument::from(child));
    if namespace == DomNamespace::Parent {
        arguments.push(Argument::from(Expression::new_identifier(
            span,
            allocator.alloc_str(parent),
            &builder,
        )));
    } else {
        let namespace = match namespace {
            DomNamespace::Svg => "svg",
            DomNamespace::MathMl => "mathml",
            DomNamespace::MathMlTextIntegration => "mathmlTextIntegration",
            DomNamespace::MathMlAnnotationXml => "mathmlAnnotationXml",
            DomNamespace::Html | DomNamespace::Parent => unreachable!(),
        };
        arguments.push(Argument::from(Expression::new_string_literal(
            span, namespace, None, &builder,
        )));
    }
    let body = Expression::new_call_expression(span, callee, NONE, arguments, false, &builder);
    expression_arrow(allocator, parameter, body, span)
}

fn block_iife<'a>(
    allocator: &'a Allocator,
    statements: ArenaVec<'a, Statement<'a>>,
    span: Span,
) -> Expression<'a> {
    let builder = AstBuilder::new(allocator);
    let parameters = FormalParameters::boxed(
        span,
        FormalParameterKind::ArrowFormalParameters,
        ArenaVec::new_in(&allocator),
        NONE,
        &builder,
    );
    let body = FunctionBody::boxed(span, ArenaVec::new_in(&allocator), statements, &builder);
    let arrow = Expression::new_arrow_function_expression(
        span, false, false, NONE, parameters, NONE, body, &builder,
    );
    Expression::new_call_expression(
        span,
        arrow,
        NONE,
        ArenaVec::new_in(&allocator),
        false,
        &builder,
    )
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

fn direct_arrow_return_expression<'a, 'callback>(
    callback: &'callback ArrowFunctionExpression<'a>,
) -> Option<&'callback Expression<'a>> {
    if let Some(expression) = callback.get_expression() {
        return Some(expression);
    }
    if !callback.body.directives.is_empty() || callback.body.statements.len() != 1 {
        return None;
    }
    let Statement::ReturnStatement(statement) = &callback.body.statements[0] else {
        return None;
    };
    statement.argument.as_ref()
}

fn replace_arrow_body_with_expression<'a>(
    allocator: &'a Allocator,
    arrow: &mut oxc::allocator::Box<'a, ArrowFunctionExpression<'a>>,
    expression: Expression<'a>,
) {
    let span = arrow.body.span;
    let builder = AstBuilder::new(allocator);
    let mut statements = ArenaVec::new_in(&allocator);
    statements.push(Statement::new_expression_statement(
        span, expression, &builder,
    ));
    arrow.expression = true;
    arrow.body = FunctionBody::boxed(span, ArenaVec::new_in(&allocator), statements, &builder);
}

fn append_arrow_parameter<'a>(
    allocator: &'a Allocator,
    arrow: &mut oxc::allocator::Box<'a, ArrowFunctionExpression<'a>>,
    name: &str,
    span: Span,
) {
    let builder = AstBuilder::new(allocator);
    let pattern = BindingPattern::new_binding_identifier(span, allocator.alloc_str(name), &builder);
    arrow.params.items.push(FormalParameter::new(
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
    ));
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
        | EmitOperation::Evaluate { origin, .. }
        | EmitOperation::Insert { origin, .. }
        | EmitOperation::Conditional { origin, .. }
        | EmitOperation::KeyedChild { origin, .. }
        | EmitOperation::KeyedList { origin, .. }
        | EmitOperation::Return { origin, .. } => *origin,
    }
}

fn with_operation_span(mut diagnostic: Diagnostic, origin: fict_hir::Origin) -> Diagnostic {
    diagnostic.primary_span = origin.primary_span;
    diagnostic
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
