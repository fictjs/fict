use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use fict_diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use fict_emit::{
    ComponentChild, ComponentProp, ConditionalKind, DomBindingKind, DomNamespace, EmitOperation,
    EmitPreviewHandler, EmitPreviewPlan, EmitProgram, EmitPropMode, EmitValueRef, PropsOperation,
    RuntimeHelper,
};
use fict_hir::{
    CompoundAssignmentOperator, JavaScriptString, LiteralValue, TemplateId, UpdateOperator,
};
use oxc::{
    allocator::{Allocator, CloneIn, TakeIn, Vec as ArenaVec},
    ast::{
        AstBuilder, NONE,
        ast::{
            Argument, ArrayExpressionElement, ArrowFunctionExpression, AssignmentTarget,
            AssignmentTargetMaybeDefault, AssignmentTargetProperty, BindingPattern,
            BindingRestElement, CallExpression, ChainElement, Expression, FormalParameter,
            FormalParameterKind, FormalParameterRest, FormalParameters, Function, FunctionBody,
            FunctionType, IdentifierName, IdentifierReference, ImportDeclarationSpecifier,
            ImportOrExportKind, JSXAttributeItem, JSXAttributeName, JSXAttributeValue, JSXChild,
            JSXElement, JSXElementName, JSXFragment, JSXMemberExpression,
            JSXMemberExpressionObject, ObjectPropertyKind, PropertyKey, PropertyKind,
            SimpleAssignmentTarget, Statement, VariableDeclarationKind, VariableDeclarator,
        },
    },
    ast_visit::{Visit, VisitMut, walk, walk_mut},
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

use crate::commonjs::lower_standard_esm_to_commonjs;
use crate::{OxcCompileOptions, OxcCompileOutput, OxcModuleKind};

use super::compile::{convert_diagnostics, failed_output, sorted, source_type};
use super::preview_codegen::{PreparedHandler, generate_handler_artifact};
use super::typescript::{
    configure_transform, passthrough_blockers, plan_typescript_program,
    rewrite_import_equals_extensions,
};

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
    if emit.preview_plan.is_some() && options.module_kind != OxcModuleKind::Module {
        diagnostics.push(emit_error(
            "FICT-OXC-PREVIEW-MODULE",
            "Preview handler artifacts and resume entries require ESM output",
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
    let props_rewrites = props_rewrites(emit);
    let (reads, read_diagnostics) = read_rewrites(emit);
    let (mutations, mutation_diagnostics) = mutation_rewrites(emit);
    let (vnodes, vnode_diagnostics) = vnode_rewrites(emit);
    let (components, component_diagnostics) = component_rewrites(emit);
    let templates = template_rewrites(emit);
    let preview_handlers: BTreeMap<_, _> = emit
        .preview_plan
        .iter()
        .flat_map(|preview| &preview.handlers)
        .filter_map(|handler| {
            handler
                .handler_origin
                .primary_span
                .map(|span| ((span.start(), span.end()), handler.clone()))
        })
        .collect();
    let preview_qrl_local = emit
        .imports
        .iter()
        .find(|intent| intent.helper == RuntimeHelper::Qrl)
        .map(|intent| intent.local.as_str());
    diagnostics.extend(rewrite_diagnostics);
    diagnostics.extend(props_rewrites.diagnostics);
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
        props: &props_rewrites.parameters,
        prop_reads: &props_rewrites.reads,
        reads: &reads,
        mutations: &mutations,
        vnodes: &vnodes,
        components: &components,
        clones: &templates.clones,
        preview_handlers: &preview_handlers,
        preview_qrl_local,
        prepared_preview_handlers: BTreeMap::new(),
        context_declarations,
        matched_calls: BTreeSet::new(),
        matched_props: BTreeSet::new(),
        matched_prop_reads: BTreeSet::new(),
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
        active_list_key_initializer: None,
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
    for location in reads.keys() {
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
    for location in props_rewrites.parameters.keys() {
        if !rewriter.matched_props.contains(location) {
            diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-PROPS",
                    "component props plan does not identify a function object parameter",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(
                    SourceSpan::new(location.0, location.1)
                        .expect("ordered component props parameter location"),
                ),
            );
        }
    }
    for location in &props_rewrites.reads {
        if !rewriter.matched_prop_reads.contains(location) {
            diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-PROPS",
                    "component prop read origin does not identify an OXC identifier expression",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(
                    SourceSpan::new(location.0, location.1)
                        .expect("ordered component prop read location"),
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
    let prepared_preview_handlers = std::mem::take(&mut rewriter.prepared_preview_handlers);
    for location in preview_handlers.keys() {
        if !prepared_preview_handlers.contains_key(location) {
            diagnostics.push(
                emit_error(
                    "FICT-OXC-PREVIEW-ORIGIN",
                    "Preview handler origin does not identify a lowered JSX event expression",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(
                    SourceSpan::new(location.0, location.1)
                        .expect("ordered Preview handler location"),
                ),
            );
        }
    }
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

    if let Some(preview) = &emit.preview_plan {
        let preview_source = match render_preview_module_statements(emit, preview) {
            Ok(source) => source,
            Err(diagnostic) => return failed_output(vec![diagnostic]),
        };
        let preview_source = allocator.alloc_str(&preview_source);
        let statements = match parse_generated_module_statements(&allocator, preview_source) {
            Ok(statements) => statements,
            Err(findings) => return failed_output(findings),
        };
        program.body.extend(statements);
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
    let mut handler_artifacts = Vec::new();
    if let Some(preview) = &emit.preview_plan {
        for prepared in prepared_preview_handlers.into_values() {
            match generate_handler_artifact(
                &allocator,
                source,
                filename,
                input_source_type,
                options.module_kind,
                &transform_options,
                emit.runtime_family,
                preview,
                prepared,
                options.sourcemap,
            ) {
                Ok(artifact) => handler_artifacts.push(artifact),
                Err(findings) => diagnostics.extend(findings),
            }
        }
        handler_artifacts.sort_by(|left, right| left.id.cmp(&right.id));
        if !diagnostics.is_empty() {
            return failed_output(diagnostics);
        }
    }
    let scoping = semantic.semantic.into_scoping();
    if options.typescript.rewrite_import_extensions {
        rewrite_import_equals_extensions(&allocator, &mut program);
    }
    let transformed = Transformer::new(&allocator, Path::new(filename), &transform_options)
        .build_with_scoping(scoping, &mut program);
    let transform_has_errors = transformed.diagnostics.has_errors();
    let transformed_scoping = transformed.scoping;
    diagnostics.extend(convert_diagnostics(
        transformed.diagnostics,
        "FICT-TRANSFORM-EMIT",
    ));
    if transform_has_errors {
        return failed_output(diagnostics);
    }
    if options.module_kind == OxcModuleKind::CommonJs
        && let Err(diagnostic) =
            lower_standard_esm_to_commonjs(&allocator, &mut program, transformed_scoping)
    {
        diagnostics.push(*diagnostic);
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
        handler_artifacts,
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
            EmitOperation::WriteReactive { projections, .. } => !projections.is_empty(),
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

#[derive(Debug, Clone)]
struct PropBindingRewrite {
    path: Vec<String>,
    local: String,
    mode: EmitPropMode,
    checks: Vec<PropCheckRewrite>,
    default_value: Option<SourceSpan>,
    default_local: Option<String>,
    origin: SourceSpan,
}

#[derive(Debug, Clone)]
struct PropCheckRewrite {
    path: Vec<String>,
    local: String,
    origin: SourceSpan,
}

#[derive(Debug, Clone)]
struct PropsParameterDefaultRewrite {
    input: String,
    value: SourceSpan,
}

#[derive(Debug, Clone)]
struct PropsRestRewrite {
    local: String,
    excluded: Vec<String>,
    helper: String,
    origin: SourceSpan,
}

#[derive(Debug, Clone)]
struct PropsRewrite {
    source: String,
    default: Option<PropsParameterDefaultRewrite>,
    rest: Option<PropsRestRewrite>,
    helper: Option<String>,
    bindings: Vec<PropBindingRewrite>,
}

struct PropsRewrites {
    parameters: BTreeMap<(u32, u32), PropsRewrite>,
    reads: BTreeSet<(u32, u32)>,
    diagnostics: Vec<Diagnostic>,
}

fn props_rewrites(emit: &EmitProgram) -> PropsRewrites {
    let helper_names: BTreeMap<_, _> = emit
        .imports
        .iter()
        .map(|intent| (intent.helper, intent.local.as_str()))
        .collect();
    let mut rewrites = BTreeMap::new();
    let mut reads = BTreeSet::new();
    let mut diagnostics = Vec::new();
    for function in &emit.functions {
        let Some(props) = &function.props else {
            continue;
        };
        let Some(parameter) = props.parameter.primary_span else {
            diagnostics.push(emit_error(
                "FICT-OXC-EMIT-PROPS",
                "component props parameter requires a source origin",
                GuaranteeClass::Internal,
            ));
            continue;
        };
        let helper = match props.helper {
            Some(helper) => {
                let Some(local) = helper_names.get(&helper) else {
                    diagnostics.push(
                        emit_error(
                            "FICT-OXC-EMIT-IMPORT",
                            "component props helper has no runtime import intent",
                            GuaranteeClass::Internal,
                        )
                        .with_primary_span(parameter),
                    );
                    continue;
                };
                Some((*local).to_owned())
            }
            None => None,
        };
        let default = match &props.default {
            Some(default) => {
                let Some(value) = default.value.primary_span else {
                    diagnostics.push(
                        emit_error(
                            "FICT-OXC-EMIT-PROPS",
                            "component props parameter default requires a source origin",
                            GuaranteeClass::Internal,
                        )
                        .with_primary_span(parameter),
                    );
                    continue;
                };
                Some(PropsParameterDefaultRewrite {
                    input: default.input.clone(),
                    value,
                })
            }
            None => None,
        };
        let rest = match &props.rest {
            Some(rest) => {
                let Some(origin) = rest.origin.primary_span else {
                    diagnostics.push(
                        emit_error(
                            "FICT-OXC-EMIT-PROPS",
                            "component props rest requires a source origin",
                            GuaranteeClass::Internal,
                        )
                        .with_primary_span(parameter),
                    );
                    continue;
                };
                let Some(helper) = helper_names.get(&rest.helper) else {
                    diagnostics.push(
                        emit_error(
                            "FICT-OXC-EMIT-IMPORT",
                            "component props rest helper has no runtime import intent",
                            GuaranteeClass::Internal,
                        )
                        .with_primary_span(origin),
                    );
                    continue;
                };
                Some(PropsRestRewrite {
                    local: rest.local.clone(),
                    excluded: rest.excluded.clone(),
                    helper: (*helper).to_owned(),
                    origin,
                })
            }
            None => None,
        };
        let mut bindings = Vec::with_capacity(props.bindings.len());
        let mut valid = true;
        for binding in &props.bindings {
            let Some(origin) = binding.origin.primary_span else {
                diagnostics.push(
                    emit_error(
                        "FICT-OXC-EMIT-PROPS",
                        "component prop binding requires a source origin",
                        GuaranteeClass::Internal,
                    )
                    .with_primary_span(parameter),
                );
                valid = false;
                break;
            };
            for reference in &binding.references {
                let Some(reference) = reference.primary_span else {
                    diagnostics.push(
                        emit_error(
                            "FICT-OXC-EMIT-PROPS",
                            "component prop read requires a source origin",
                            GuaranteeClass::Internal,
                        )
                        .with_primary_span(parameter),
                    );
                    valid = false;
                    break;
                };
                if !reads.insert((reference.start(), reference.end())) {
                    diagnostics.push(
                        emit_error(
                            "FICT-OXC-EMIT-PROPS",
                            "component prop reads must have unique source origins",
                            GuaranteeClass::Internal,
                        )
                        .with_primary_span(reference),
                    );
                    valid = false;
                    break;
                }
            }
            if !valid {
                break;
            }
            let default_value = match binding.default_value {
                Some(default_value) => {
                    let Some(default_value) = default_value.primary_span else {
                        diagnostics.push(
                            emit_error(
                                "FICT-OXC-EMIT-PROPS",
                                "component prop default requires a source origin",
                                GuaranteeClass::Internal,
                            )
                            .with_primary_span(origin),
                        );
                        valid = false;
                        break;
                    };
                    Some(default_value)
                }
                None => None,
            };
            if default_value.is_some() != binding.default_local.is_some() {
                diagnostics.push(
                    emit_error(
                        "FICT-OXC-EMIT-PROPS",
                        "component prop defaults require a generated snapshot binding",
                        GuaranteeClass::Internal,
                    )
                    .with_primary_span(origin),
                );
                valid = false;
                break;
            }
            let mut checks = Vec::with_capacity(binding.checks.len());
            for check in &binding.checks {
                let Some(origin) = check.origin.primary_span else {
                    diagnostics.push(
                        emit_error(
                            "FICT-OXC-EMIT-PROPS",
                            "component prop object check requires a source origin",
                            GuaranteeClass::Internal,
                        )
                        .with_primary_span(origin),
                    );
                    valid = false;
                    break;
                };
                checks.push(PropCheckRewrite {
                    path: check.path.clone(),
                    local: check.local.clone(),
                    origin,
                });
            }
            if !valid {
                break;
            }
            bindings.push(PropBindingRewrite {
                path: binding.path.clone(),
                local: binding.local.clone(),
                mode: binding.mode,
                checks,
                default_value,
                default_local: binding.default_local.clone(),
                origin,
            });
        }
        if !valid {
            continue;
        }
        if rewrites
            .insert(
                (parameter.start(), parameter.end()),
                PropsRewrite {
                    source: props.source.clone(),
                    default,
                    rest,
                    helper,
                    bindings,
                },
            )
            .is_some()
        {
            diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-PROPS",
                    "component props parameters must have unique source origins",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(parameter),
            );
        }
    }
    PropsRewrites {
        parameters: rewrites,
        reads,
        diagnostics,
    }
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

#[derive(Debug, Clone, Copy)]
struct ReadRewrite {
    projected: bool,
    accessor_depth: u16,
    projection_count: usize,
    optional_accessor: bool,
}

fn projection_is_optional(projection: &fict_hir::Projection) -> bool {
    match projection {
        fict_hir::Projection::StaticProperty { optional, .. }
        | fict_hir::Projection::ComputedProperty { optional, .. }
        | fict_hir::Projection::Index { optional, .. } => *optional,
    }
}

fn read_rewrites(emit: &EmitProgram) -> (BTreeMap<(u32, u32), ReadRewrite>, Vec<Diagnostic>) {
    let mut reads = BTreeMap::new();
    let mut diagnostics = Vec::new();
    for operation in emit
        .functions
        .iter()
        .flat_map(|function| &function.operations)
    {
        let EmitOperation::ReadReactive {
            projections,
            accessor_depth,
            origin,
            ..
        } = operation
        else {
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
        if usize::from(*accessor_depth) > projections.len() {
            diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-READ",
                    "reactive-read accessor depth exceeds its projected place",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(span),
            );
            continue;
        }
        if reads
            .insert(
                (span.start(), span.end()),
                ReadRewrite {
                    projected: !projections.is_empty(),
                    accessor_depth: *accessor_depth,
                    projection_count: projections.len(),
                    optional_accessor: usize::from(*accessor_depth)
                        .checked_sub(1)
                        .and_then(|index| projections.get(index))
                        .is_some_and(projection_is_optional),
                },
            )
            .is_some()
        {
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

#[derive(Debug, Clone)]
enum MutationRewrite {
    Write,
    Compound(CompoundAssignmentOperator),
    Update {
        operator: UpdateOperator,
        prefix: bool,
    },
    Pattern {
        targets: BTreeSet<(u32, u32)>,
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
            EmitOperation::WriteReactivePattern {
                origin, targets, ..
            } => {
                let mut locations = BTreeSet::new();
                for target in targets {
                    let Some(span) = target.origin.primary_span else {
                        diagnostics.push(emit_error(
                            "FICT-OXC-EMIT-ORIGIN",
                            "reactive pattern target requires a source origin",
                            GuaranteeClass::Internal,
                        ));
                        continue;
                    };
                    if !locations.insert((span.start(), span.end())) {
                        diagnostics.push(
                            emit_error(
                                "FICT-OXC-EMIT-ORIGIN",
                                "reactive pattern target origins must be unique",
                                GuaranteeClass::Internal,
                            )
                            .with_primary_span(span),
                        );
                    }
                }
                (origin, MutationRewrite::Pattern { targets: locations })
            }
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
    reactive_function_helper: Option<String>,
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
            reactive_function_helper,
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
        let reactive_function_helper = match reactive_function_helper {
            Some(helper) => {
                let Some(local) = helper_names.get(helper) else {
                    diagnostics.push(
                        emit_error(
                            "FICT-OXC-EMIT-IMPORT",
                            "component reactive-function helper has no runtime import intent",
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
                    reactive_function_helper,
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
        optional: bool,
        key_origin: Option<SourceSpan>,
        key_source_origin: Option<SourceSpan>,
        key_alias_initializer: Option<SourceSpan>,
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
                    optional,
                    key,
                    key_source,
                    key_alias_initializer,
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
                    let key_origin = match key {
                        Some(key) => {
                            let Some(key) = key.primary_span else {
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
                            Some(key)
                        }
                        None => None,
                    };
                    let key_source_origin = match key_source {
                        Some(key_source) => {
                            let Some(key_source) = key_source.primary_span else {
                                diagnostics.push(with_operation_span(
                                    emit_error(
                                        "FICT-OXC-EMIT-ORIGIN",
                                        "keyed child key source requires a source origin",
                                        GuaranteeClass::Internal,
                                    ),
                                    *origin,
                                ));
                                continue;
                            };
                            Some(key_source)
                        }
                        None => None,
                    };
                    if key_origin.is_some() != key_source_origin.is_some() {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-ORIGIN",
                                "keyed child key and key source must both be present or absent",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    }
                    let key_alias_initializer = match key_alias_initializer {
                        Some(initializer) => {
                            let Some(initializer) = initializer.primary_span else {
                                diagnostics.push(with_operation_span(
                                    emit_error(
                                        "FICT-OXC-EMIT-ORIGIN",
                                        "keyed child key alias requires a source origin",
                                        GuaranteeClass::Internal,
                                    ),
                                    *origin,
                                ));
                                continue;
                            };
                            Some(initializer)
                        }
                        None => None,
                    };
                    if key_alias_initializer.is_some() && key_origin.is_none() {
                        diagnostics.push(with_operation_span(
                            emit_error(
                                "FICT-OXC-EMIT-ORIGIN",
                                "keyed child key alias requires an explicit key",
                                GuaranteeClass::Internal,
                            ),
                            *origin,
                        ));
                        continue;
                    }
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
                        optional: *optional,
                        key_origin,
                        key_source_origin,
                        key_alias_initializer,
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

fn parse_generated_module_statements<'a>(
    allocator: &'a Allocator,
    source: &'a str,
) -> Result<Vec<Statement<'a>>, Vec<Diagnostic>> {
    if source.is_empty() {
        return Ok(Vec::new());
    }
    let parsed = Parser::new(allocator, source, SourceType::mjs()).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(convert_diagnostics(
            parsed.diagnostics,
            "FICT-OXC-PREVIEW-GENERATED",
        ));
    }
    let mut program = parsed.program;
    ZeroSpans.visit_program(&mut program);
    Ok(program.body.into_iter().collect())
}

fn preview_helper_local(emit: &EmitProgram, helper: RuntimeHelper) -> Result<&str, Diagnostic> {
    emit.imports
        .iter()
        .find(|intent| intent.helper == helper)
        .map(|intent| intent.local.as_str())
        .ok_or_else(|| {
            emit_error(
                "FICT-OXC-PREVIEW-IMPORT",
                format!("Preview plan has no runtime import for {helper:?}"),
                GuaranteeClass::Internal,
            )
        })
}

fn render_preview_module_statements(
    emit: &EmitProgram,
    preview: &EmitPreviewPlan,
) -> Result<String, Diagnostic> {
    use std::fmt::Write;

    let mut source = String::new();
    let mut dependencies = BTreeSet::new();
    for handler in &preview.handlers {
        for capture in &handler.module_captures {
            dependencies.insert((capture.local.as_str(), capture.source_export_name.as_str()));
        }
    }
    for (local, exported) in dependencies {
        writeln!(source, "export {{ {local} as {exported} }};")
            .expect("writing generated Preview source cannot fail");
    }

    if preview.components.is_empty() {
        return Ok(source);
    }
    let get_scope = preview_helper_local(emit, RuntimeHelper::GetSSRScope)?;
    let ensure_scope = preview_helper_local(emit, RuntimeHelper::EnsureScope)?;
    let prepare_context = preview_helper_local(emit, RuntimeHelper::PrepareContext)?;
    let push_context = preview_helper_local(emit, RuntimeHelper::PushContext)?;
    let pop_context = preview_helper_local(emit, RuntimeHelper::PopContext)?;
    let hydrate_component = preview_helper_local(emit, RuntimeHelper::HydrateComponent)?;
    let qrl = preview_helper_local(emit, RuntimeHelper::Qrl)?;
    let register_resume = preview_helper_local(emit, RuntimeHelper::RegisterResume)?;
    let set_component_meta = preview_helper_local(emit, RuntimeHelper::SetComponentMeta)?;
    let public_module = preview
        .public_module_id
        .as_deref()
        .map(quote_javascript_string)
        .unwrap_or_else(|| "import.meta.url".to_owned());
    for component in &preview.components {
        writeln!(
            source,
            "export const {resume} = (scopeId, host) => {{\n  const snapshot = {get_scope}(scopeId);\n  if (!snapshot) return;\n  const ctx = {ensure_scope}(scopeId, host, snapshot);\n  try {{\n    {prepare_context}(ctx);\n    {push_context}();\n    {hydrate_component}(() => {component}(snapshot.props || {{}}), host);\n  }} finally {{\n    {pop_context}();\n  }}\n}};\n{register_resume}({qrl}(import.meta.url, {resume_name}), {resume});\nconst {metadata} = {{ id: {type_key} + {public_module}, resume: {qrl}({public_module}, {resume_name}) }};\n{set_component_meta}({component}, {metadata});",
            resume = component.resume_export_name,
            component = component.name,
            resume_name = quote_javascript_string(&component.resume_export_name),
            metadata = component.metadata_local,
            type_key = quote_javascript_string(&format!("{}@", component.name)),
        )
        .expect("writing generated Preview source cannot fail");
    }
    Ok(source)
}

struct AstRewriter<'a, 'emit> {
    allocator: &'a Allocator,
    call_rewrites: &'emit BTreeMap<(u32, u32), CallRewrite>,
    props: &'emit BTreeMap<(u32, u32), PropsRewrite>,
    prop_reads: &'emit BTreeSet<(u32, u32)>,
    reads: &'emit BTreeMap<(u32, u32), ReadRewrite>,
    mutations: &'emit BTreeMap<(u32, u32), MutationRewrite>,
    vnodes: &'emit BTreeMap<(u32, u32), VNodeRewrite>,
    components: &'emit BTreeMap<(u32, u32), ComponentRewrite>,
    clones: &'emit BTreeMap<(u32, u32), CloneRewrite>,
    preview_handlers: &'emit BTreeMap<(u32, u32), EmitPreviewHandler>,
    preview_qrl_local: Option<&'emit str>,
    prepared_preview_handlers: BTreeMap<(u32, u32), PreparedHandler<'a>>,
    context_declarations: BTreeMap<(u32, u32), Statement<'a>>,
    matched_calls: BTreeSet<(u32, u32)>,
    matched_props: BTreeSet<(u32, u32)>,
    matched_prop_reads: BTreeSet<(u32, u32)>,
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
    active_list_key_initializer: Option<(u32, u32)>,
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

struct SourceExpressionCloner<'a> {
    allocator: &'a Allocator,
    target: (u32, u32),
    found: Option<Expression<'a>>,
}

impl<'a> Visit<'a> for SourceExpressionCloner<'a> {
    fn visit_expression(&mut self, expression: &Expression<'a>) {
        if self.found.is_some() {
            return;
        }
        let span = expression.span();
        if (span.start, span.end) == self.target {
            self.found = Some(expression.clone_in(self.allocator));
            return;
        }
        walk::walk_expression(self, expression);
    }
}

fn clone_callback_expression<'a>(
    allocator: &'a Allocator,
    callback: &ArrowFunctionExpression<'a>,
    origin: SourceSpan,
) -> Option<Expression<'a>> {
    let mut cloner = SourceExpressionCloner {
        allocator,
        target: (origin.start(), origin.end()),
        found: None,
    };
    cloner.visit_arrow_function_expression(callback);
    cloner.found
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
                    }) if planned_value
                        .as_code_units()
                        .iter()
                        .copied()
                        .eq(value.encode_utf16())
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

fn collect_object_pattern_defaults<'a>(
    pattern: &oxc::ast::ast::ObjectPattern<'a>,
    allocator: &'a Allocator,
    defaults: &mut BTreeMap<(u32, u32), Expression<'a>>,
) {
    for property in &pattern.properties {
        match &property.value {
            BindingPattern::AssignmentPattern(default) => {
                let span = default.right.span();
                defaults.insert((span.start, span.end), default.right.clone_in(allocator));
            }
            BindingPattern::ObjectPattern(nested) => {
                collect_object_pattern_defaults(nested, allocator, defaults);
            }
            BindingPattern::BindingIdentifier(_) | BindingPattern::ArrayPattern(_) => {}
        }
    }
}

impl<'a> VisitMut<'a> for AstRewriter<'a, '_> {
    fn visit_function(&mut self, function: &mut Function<'a>, flags: ScopeFlags) {
        let location = (function.span.start, function.span.end);
        if let Some(body) = &mut function.body {
            self.apply_props_plan(&mut function.params, body);
            if let Some(declaration) = self.context_declarations.remove(&location) {
                body.statements.insert(0, declaration);
            }
        }
        walk_mut::walk_function(self, function, flags);
    }

    fn visit_arrow_function_expression(&mut self, function: &mut ArrowFunctionExpression<'a>) {
        let location = (function.span.start, function.span.end);
        if self.has_props_plan(&function.params) && function.expression {
            let Some(returned) = function
                .get_expression()
                .map(|expression| expression.clone_in(self.allocator))
            else {
                self.diagnostics.push(emit_error(
                    "FICT-OXC-EMIT-PROPS",
                    "expression-bodied component has no return expression",
                    GuaranteeClass::Internal,
                ));
                return;
            };
            function.expression = false;
            let body_span = function.body.span;
            function.body.statements.clear();
            function
                .body
                .statements
                .push(Statement::new_return_statement(
                    body_span,
                    Some(returned),
                    &AstBuilder::new(self.allocator),
                ));
        }
        self.apply_props_plan(&mut function.params, &mut function.body);
        if let Some(declaration) = self.context_declarations.remove(&location) {
            function.body.statements.insert(0, declaration);
        }
        walk_mut::walk_arrow_function_expression(self, function);
    }

    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        let location = (expression.span().start, expression.span().end);
        if self.active_list_key_initializer == Some(location)
            && let Some(local) = &self.active_list_key_local
        {
            *expression = Expression::new_identifier(
                expression.span(),
                self.allocator.alloc_str(local),
                &AstBuilder::new(self.allocator),
            );
            return;
        }
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
        if let Some(rewrite) = self.mutations.get(&location).cloned()
            && self.rewrite_mutation(expression, rewrite)
        {
            self.matched_mutations.insert(location);
            return;
        }
        if let Some(rewrite) = self.reads.get(&location).copied().filter(|rewrite| {
            !self.matched_reads.contains(&location)
                && (rewrite.projected
                    || rewrite.accessor_depth > 0
                    || matches!(expression, Expression::CallExpression(_)))
        }) {
            let root = projected_read_root_location(expression);
            if rewrite_reactive_accessor(
                expression,
                usize::from(rewrite.accessor_depth),
                rewrite.optional_accessor,
                self.allocator,
            ) {
                self.matched_reads.insert(location);
                let suppressed_list_read = root.filter(|root| self.active_list_reads.remove(root));
                if let Some(root) = suppressed_list_read {
                    self.matched_list_reads.insert(root);
                }
                walk_mut::walk_expression(self, expression);
                if let Some(root) = suppressed_list_read {
                    self.active_list_reads.insert(root);
                }
                return;
            }
        }
        let Expression::Identifier(identifier) = expression else {
            walk_mut::walk_expression(self, expression);
            return;
        };
        let location = (identifier.span.start, identifier.span.end);
        let list_read = self.active_list_reads.contains(&location);
        let prop_read = self.prop_reads.contains(&location);
        let reactive_read =
            self.reads.contains_key(&location) && !self.matched_reads.contains(&location);
        if !list_read && !prop_read && !reactive_read {
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
        if prop_read {
            self.matched_prop_reads.insert(location);
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
        let callee_span = call.callee.span();
        let callee_location = (callee_span.start, callee_span.end);
        if self
            .reads
            .get(&callee_location)
            .is_some_and(|rewrite| usize::from(rewrite.accessor_depth) == rewrite.projection_count)
        {
            self.matched_reads.insert(callee_location);
        }
        walk_mut::walk_call_expression(self, call);
    }
}

impl<'a> AstRewriter<'a, '_> {
    fn has_props_plan(&self, parameters: &FormalParameters<'_>) -> bool {
        parameters.items.first().is_some_and(|parameter| {
            self.props
                .contains_key(&(parameter.span.start, parameter.span.end))
        })
    }

    fn apply_props_plan(
        &mut self,
        parameters: &mut oxc::allocator::Box<'a, FormalParameters<'a>>,
        body: &mut oxc::allocator::Box<'a, FunctionBody<'a>>,
    ) {
        let Some(parameter) = parameters.items.first_mut() else {
            return;
        };
        let location = (parameter.span.start, parameter.span.end);
        let Some(plan) = self.props.get(&location).cloned() else {
            return;
        };
        let BindingPattern::ObjectPattern(object_pattern) = &parameter.pattern else {
            self.diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-PROPS",
                    "component props plan requires a non-defaulted object parameter",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(
                    SourceSpan::new(location.0, location.1)
                        .expect("ordered component props parameter"),
                ),
            );
            return;
        };
        let parameter_default = match (&plan.default, &parameter.initializer) {
            (Some(planned), Some(source))
                if source.span() == Span::new(planned.value.start(), planned.value.end()) =>
            {
                Some(source.clone_in(self.allocator).unbox())
            }
            (None, None) => None,
            (Some(_), Some(_)) | (Some(_), None) | (None, Some(_)) => {
                self.diagnostics.push(
                    emit_error(
                        "FICT-OXC-EMIT-PROPS",
                        "component props parameter default does not match its source expression",
                        GuaranteeClass::Internal,
                    )
                    .with_primary_span(
                        SourceSpan::new(location.0, location.1)
                            .expect("ordered component props parameter"),
                    ),
                );
                return;
            }
        };
        let mut defaults = BTreeMap::new();
        collect_object_pattern_defaults(object_pattern, self.allocator, &mut defaults);
        let planned_defaults = plan
            .bindings
            .iter()
            .filter(|binding| binding.default_value.is_some())
            .count();
        if defaults.len() != planned_defaults
            || plan.bindings.iter().any(|binding| {
                binding.default_value.is_some_and(|default| {
                    !defaults.contains_key(&(default.start(), default.end()))
                })
            })
        {
            self.diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-PROPS",
                    "component prop defaults do not match their source assignment patterns",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(
                    SourceSpan::new(location.0, location.1)
                        .expect("ordered component props parameter"),
                ),
            );
            return;
        }
        if plan
            .bindings
            .iter()
            .any(|binding| binding.mode == EmitPropMode::Accessor)
            && plan.helper.is_none()
        {
            self.diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-PROPS",
                    "component prop bindings require a runtime accessor helper",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(
                    SourceSpan::new(location.0, location.1)
                        .expect("ordered component props parameter"),
                ),
            );
            return;
        }
        let builder = AstBuilder::new(self.allocator);
        let parameter_local = plan
            .default
            .as_ref()
            .map_or(plan.source.as_str(), |default| default.input.as_str());
        parameter.pattern = BindingPattern::new_binding_identifier(
            parameter.pattern.span(),
            self.allocator.alloc_str(parameter_local),
            &builder,
        );
        parameter.initializer = None;
        let mut insertion_index = 0;
        if let (Some(default), Some(default_expression)) = (&plan.default, parameter_default) {
            let default_span = Span::new(default.value.start(), default.value.end());
            let input = Expression::new_identifier(
                default_span,
                self.allocator.alloc_str(&default.input),
                &builder,
            );
            let source_initializer = Expression::new_conditional_expression(
                default_span,
                self.identifier_is_undefined(&default.input, default_span),
                default_expression,
                input,
                &builder,
            );
            body.statements.insert(
                insertion_index,
                const_statement(
                    self.allocator,
                    &plan.source,
                    source_initializer,
                    default_span,
                ),
            );
            insertion_index += 1;
        }
        for binding in &plan.bindings {
            let span = Span::new(binding.origin.start(), binding.origin.end());
            for check in &binding.checks {
                let check_span = Span::new(check.origin.start(), check.origin.end());
                body.statements.insert(
                    insertion_index,
                    const_statement(
                        self.allocator,
                        &check.local,
                        self.prop_member(&plan.source, &check.path, check_span),
                        check_span,
                    ),
                );
                insertion_index += 1;
                body.statements.insert(
                    insertion_index,
                    self.nested_prop_check_statement(check, check_span),
                );
                insertion_index += 1;
            }
            let mut mutable_default = None;
            if let (Some(default), Some(default_local)) =
                (binding.default_value, binding.default_local.as_deref())
            {
                let default_expression = defaults
                    .remove(&(default.start(), default.end()))
                    .expect("validated component prop default expression");
                let default_initializer = if binding.mode == EmitPropMode::Mutable {
                    mutable_default = Some((default_local, default_expression));
                    self.prop_member(&plan.source, &binding.path, span)
                } else {
                    Expression::new_conditional_expression(
                        span,
                        self.prop_is_undefined(&plan.source, &binding.path, span),
                        default_expression,
                        self.void_zero(span),
                        &builder,
                    )
                };
                body.statements.insert(
                    insertion_index,
                    const_statement(self.allocator, default_local, default_initializer, span),
                );
                insertion_index += 1;
            }
            let value = match (binding.mode, mutable_default) {
                (EmitPropMode::Mutable, Some((default_local, default_expression))) => {
                    let snapshot = || {
                        Expression::new_identifier(
                            span,
                            self.allocator.alloc_str(default_local),
                            &builder,
                        )
                    };
                    Expression::new_conditional_expression(
                        span,
                        Expression::new_binary_expression(
                            span,
                            snapshot(),
                            OxcBinaryOperator::StrictEquality,
                            self.void_zero(span),
                            &builder,
                        ),
                        default_expression,
                        snapshot(),
                        &builder,
                    )
                }
                (EmitPropMode::Accessor, _) => {
                    if let Some(default_local) = binding.default_local.as_deref() {
                        Expression::new_conditional_expression(
                            span,
                            self.prop_is_undefined(&plan.source, &binding.path, span),
                            Expression::new_identifier(
                                span,
                                self.allocator.alloc_str(default_local),
                                &builder,
                            ),
                            self.prop_member(&plan.source, &binding.path, span),
                            &builder,
                        )
                    } else {
                        self.prop_member(&plan.source, &binding.path, span)
                    }
                }
                (EmitPropMode::Value, _) | (EmitPropMode::Mutable, None) => {
                    self.prop_member(&plan.source, &binding.path, span)
                }
            };
            let initializer = if binding.mode == EmitPropMode::Accessor {
                let getter = zero_parameter_expression_arrow(self.allocator, value, span);
                let helper = Expression::new_identifier(
                    span,
                    self.allocator.alloc_str(
                        plan.helper
                            .as_deref()
                            .expect("validated component prop accessor helper"),
                    ),
                    &builder,
                );
                let mut arguments = ArenaVec::new_in(&self.allocator);
                arguments.push(Argument::from(getter));
                Expression::new_call_expression(span, helper, NONE, arguments, false, &builder)
            } else {
                value
            };
            body.statements.insert(
                insertion_index,
                variable_statement(
                    self.allocator,
                    &binding.local,
                    initializer,
                    span,
                    if binding.mode == EmitPropMode::Mutable {
                        VariableDeclarationKind::Var
                    } else {
                        VariableDeclarationKind::Const
                    },
                ),
            );
            insertion_index += 1;
        }
        if let Some(rest) = &plan.rest {
            let span = Span::new(rest.origin.start(), rest.origin.end());
            body.statements.insert(
                insertion_index,
                self.props_rest_statement(&plan.source, rest, span),
            );
        }
        self.matched_props.insert(location);
    }

    fn prop_member(&self, source: &str, path: &[String], span: Span) -> Expression<'a> {
        let builder = AstBuilder::new(self.allocator);
        let mut value =
            Expression::new_identifier(span, self.allocator.alloc_str(source), &builder);
        for property in path {
            value = if is_identifier_name(property) {
                Expression::new_static_member_expression(
                    span,
                    value,
                    IdentifierName::new(span, self.allocator.alloc_str(property), &builder),
                    false,
                    &builder,
                )
            } else {
                let property = Expression::new_string_literal(
                    span,
                    self.allocator.alloc_str(property),
                    None,
                    &builder,
                );
                Expression::new_computed_member_expression(span, value, property, false, &builder)
            };
        }
        value
    }

    fn prop_is_undefined(&self, source: &str, path: &[String], span: Span) -> Expression<'a> {
        Expression::new_binary_expression(
            span,
            self.prop_member(source, path, span),
            OxcBinaryOperator::StrictEquality,
            self.void_zero(span),
            &AstBuilder::new(self.allocator),
        )
    }

    fn nested_prop_check_statement(&self, check: &PropCheckRewrite, span: Span) -> Statement<'a> {
        let builder = AstBuilder::new(self.allocator);
        let local =
            Expression::new_identifier(span, self.allocator.alloc_str(&check.local), &builder);
        let test = Expression::new_binary_expression(
            span,
            local,
            OxcBinaryOperator::Equality,
            Expression::new_null_literal(span, &builder),
            &builder,
        );
        let key = check.path.last().map_or("", String::as_str);
        let message = format!("Cannot destructure prop \"{key}\" because it is nullish");
        let mut arguments = ArenaVec::new_in(&self.allocator);
        arguments.push(Argument::from(Expression::new_string_literal(
            span,
            self.allocator.alloc_str(&message),
            None,
            &builder,
        )));
        let error = Expression::new_new_expression(
            span,
            Expression::new_identifier(span, "TypeError", &builder),
            NONE,
            arguments,
            &builder,
        );
        Statement::new_if_statement(
            span,
            test,
            Statement::new_throw_statement(span, error, &builder),
            None,
            &builder,
        )
    }

    fn props_rest_statement(
        &self,
        source: &str,
        rest: &PropsRestRewrite,
        span: Span,
    ) -> Statement<'a> {
        let builder = AstBuilder::new(self.allocator);
        let mut excluded = ArenaVec::new_in(&self.allocator);
        for key in &rest.excluded {
            excluded.push(ArrayExpressionElement::from(
                Expression::new_string_literal(span, self.allocator.alloc_str(key), None, &builder),
            ));
        }
        let mut arguments = ArenaVec::new_in(&self.allocator);
        arguments.push(Argument::from(Expression::new_identifier(
            span,
            self.allocator.alloc_str(source),
            &builder,
        )));
        arguments.push(Argument::from(Expression::new_array_expression(
            span, excluded, &builder,
        )));
        let initializer = Expression::new_call_expression(
            span,
            Expression::new_identifier(span, self.allocator.alloc_str(&rest.helper), &builder),
            NONE,
            arguments,
            false,
            &builder,
        );
        const_statement(self.allocator, &rest.local, initializer, span)
    }

    fn identifier_is_undefined(&self, name: &str, span: Span) -> Expression<'a> {
        Expression::new_binary_expression(
            span,
            Expression::new_identifier(
                span,
                self.allocator.alloc_str(name),
                &AstBuilder::new(self.allocator),
            ),
            OxcBinaryOperator::StrictEquality,
            self.void_zero(span),
            &AstBuilder::new(self.allocator),
        )
    }

    fn void_zero(&self, span: Span) -> Expression<'a> {
        let builder = AstBuilder::new(self.allocator);
        Expression::new_unary_expression(
            span,
            OxcUnaryOperator::Void,
            Expression::new_numeric_literal(span, 0.0, None, NumberBase::Decimal, &builder),
            &builder,
        )
    }

    fn prepare_preview_qrl(
        &mut self,
        location: (u32, u32),
        handler: Expression<'a>,
        prevent_default: bool,
        span: Span,
    ) -> Option<Expression<'a>> {
        let plan = self.preview_handlers.get(&location)?.clone();
        self.prepared_preview_handlers
            .entry(location)
            .or_insert(PreparedHandler {
                plan: plan.clone(),
                expression: handler,
            });
        let Some(qrl_local) = self.preview_qrl_local else {
            self.diagnostics.push(
                emit_error(
                    "FICT-OXC-PREVIEW-IMPORT",
                    "Preview handler plan has no QRL runtime import",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(
                    SourceSpan::new(location.0, location.1)
                        .expect("ordered Preview handler location"),
                ),
            );
            return None;
        };
        let builder = AstBuilder::new(self.allocator);
        let mut arguments = ArenaVec::new_in(&self.allocator);
        arguments.extend([
            Argument::from(Expression::new_string_literal(
                span,
                self.allocator.alloc_str(&plan.module_specifier),
                None,
                &builder,
            )),
            Argument::from(Expression::new_string_literal(
                span, "default", None, &builder,
            )),
        ]);
        if prevent_default {
            arguments.push(Argument::from(Expression::new_string_literal(
                span, "pd", None, &builder,
            )));
        }
        Some(Expression::new_call_expression(
            span,
            Expression::new_identifier(span, self.allocator.alloc_str(qrl_local), &builder),
            NONE,
            arguments,
            false,
            &builder,
        ))
    }

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
                    let prevent_default = handler_may_prevent_default(&handler);
                    handler = ignore_inline_event_handler_return(self.allocator, handler, span);
                    if self.preview_handlers.contains_key(&location) {
                        let Some(qrl) =
                            self.prepare_preview_qrl(location, handler, prevent_default, span)
                        else {
                            continue;
                        };
                        let target = Expression::new_identifier(
                            span,
                            self.allocator.alloc_str(&element),
                            &builder,
                        );
                        let callee = Expression::new_static_member_expression(
                            span,
                            target,
                            IdentifierName::new(span, "setAttribute", &builder),
                            false,
                            &builder,
                        );
                        let mut arguments = ArenaVec::new_in(&self.allocator);
                        arguments.extend([
                            Argument::from(Expression::new_string_literal(
                                span,
                                self.allocator.alloc_str(&format!("on:{event}")),
                                None,
                                &builder,
                            )),
                            Argument::from(qrl),
                        ]);
                        statements.push(Statement::new_expression_statement(
                            span,
                            Expression::new_call_expression(
                                span, callee, NONE, arguments, false, &builder,
                            ),
                            &builder,
                        ));
                        continue;
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
                    optional,
                    key_origin,
                    key_source_origin,
                    key_alias_initializer,
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
                        optional,
                        key_origin,
                        key_source_origin,
                        key_alias_initializer,
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
        optional: bool,
        key_origin: Option<SourceSpan>,
        key_source_origin: Option<SourceSpan>,
        key_alias_initializer: Option<SourceSpan>,
        render_key: &str,
        item_references: &[SourceSpan],
        index_references: &[SourceSpan],
        needs_index: bool,
        span: Span,
        statements: &mut ArenaVec<'a, Statement<'a>>,
    ) {
        let explicit_key = match (key_origin, key_source_origin) {
            (Some(key), Some(source)) => Some((key, source)),
            (None, None) => None,
            _ => {
                self.diagnostics.push(
                    emit_error(
                        "FICT-OXC-EMIT-KEYED",
                        "keyed child key and key source must both be present or absent",
                        GuaranteeClass::Internal,
                    )
                    .with_primary_span(items_origin),
                );
                return;
            }
        };
        if key_alias_initializer.is_some() && explicit_key.is_none() {
            self.diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-KEYED",
                    "keyed child key alias requires an explicit key",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(items_origin),
            );
            return;
        }
        let diagnostic_origin = explicit_key.map_or(items_origin, |(key, _)| key);
        let call = match map.into_inner_expression() {
            Expression::CallExpression(call) => call,
            Expression::ChainExpression(chain) => match chain.unbox().expression {
                ChainElement::CallExpression(call) => call,
                ChainElement::TSNonNullExpression(_)
                | ChainElement::ComputedMemberExpression(_)
                | ChainElement::StaticMemberExpression(_)
                | ChainElement::PrivateFieldExpression(_) => {
                    self.diagnostics.push(
                        emit_error(
                            "FICT-OXC-EMIT-KEYED",
                            "keyed child chain does not contain a direct map call",
                            GuaranteeClass::Internal,
                        )
                        .with_primary_span(items_origin),
                    );
                    return;
                }
            },
            _ => {
                self.diagnostics.push(
                    emit_error(
                        "FICT-OXC-EMIT-KEYED",
                        "keyed child source is not a direct map call",
                        GuaranteeClass::Internal,
                    )
                    .with_primary_span(items_origin),
                );
                return;
            }
        };
        let mut call = call.unbox();
        if call.optional {
            self.diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-KEYED",
                    "optional map calls are not supported by direct list lowering",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(items_origin),
            );
            return;
        }
        let projected_callee_root = projected_chain_read_root_location(&call.callee, self.reads);
        if projected_callee_root.is_some() {
            self.visit_expression(&mut call.callee);
        }
        let (mut items, source_optional) = match call.callee.into_inner_expression() {
            Expression::StaticMemberExpression(member) => {
                let member = member.unbox();
                (member.object, member.optional)
            }
            Expression::ComputedMemberExpression(member) => {
                let member = member.unbox();
                (member.object, member.optional)
            }
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
        if source_optional != optional {
            self.diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-KEYED",
                    "keyed child optionality does not match its map member",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(items_origin),
            );
            return;
        }
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
        let Some(mut render_callback) = into_list_render_arrow(
            self.allocator,
            callback.into_expression().into_inner_expression(),
        ) else {
            self.diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-KEYED",
                    "keyed child render callback is not a supported inline function",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(diagnostic_origin),
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
                .with_primary_span(diagnostic_origin),
            );
            return;
        };
        let suppressed_list_root =
            projected_callee_root.filter(|root| self.active_list_reads.remove(root));
        if let Some(root) = suppressed_list_root {
            self.matched_list_reads.insert(root);
        }
        self.visit_expression(&mut items);
        if let Some(root) = suppressed_list_root {
            self.active_list_reads.insert(root);
        }
        if optional {
            let items_span = items.span();
            let builder = AstBuilder::new(self.allocator);
            let empty = Expression::new_array_expression(
                items_span,
                ArenaVec::new_in(&self.allocator),
                &builder,
            );
            items = Expression::new_logical_expression(
                items_span,
                items,
                OxcLogicalOperator::Coalesce,
                empty,
                &builder,
            );
        }

        let mut key_callback = render_callback.clone_in(self.allocator);
        if let Some((_, key_source_origin)) = explicit_key {
            let Some(mut key_expression) =
                clone_callback_expression(self.allocator, &render_callback, key_source_origin)
                    .or_else(|| {
                        clone_direct_jsx_key_expression(
                            self.allocator,
                            render_body,
                            key_source_origin,
                        )
                    })
            else {
                self.diagnostics.push(
                    emit_error(
                        "FICT-OXC-EMIT-KEYED",
                        "keyed child key origin does not identify a direct JSX key",
                        GuaranteeClass::Internal,
                    )
                    .with_primary_span(key_source_origin),
                );
                return;
            };
            self.visit_expression(&mut key_expression);
            replace_arrow_body_with_expression(self.allocator, &mut key_callback, key_expression);
        } else {
            let index_name = match simple_arrow_parameter_name(&key_callback, 1) {
                Some(name) => name.to_owned(),
                None if key_callback.params.items.len() == 1 => {
                    append_arrow_parameter(self.allocator, &mut key_callback, render_key, span);
                    render_key.to_owned()
                }
                None => {
                    self.diagnostics.push(
                        emit_error(
                            "FICT-OXC-EMIT-KEYED",
                            "index-keyed child requires a simple callback index parameter",
                            GuaranteeClass::Internal,
                        )
                        .with_primary_span(items_origin),
                    );
                    return;
                }
            };
            let builder = AstBuilder::new(self.allocator);
            let index_expression =
                Expression::new_identifier(span, self.allocator.alloc_str(&index_name), &builder);
            replace_arrow_body_with_expression(self.allocator, &mut key_callback, index_expression);
        }
        let key_callback = Expression::ArrowFunctionExpression(key_callback);
        if explicit_key.is_some() {
            append_arrow_parameter(self.allocator, &mut render_callback, render_key, span);
        }

        let expected_reads: BTreeSet<_> = item_references
            .iter()
            .chain(index_references)
            .map(|origin| (origin.start(), origin.end()))
            .collect();
        let previous_reads = std::mem::take(&mut self.active_list_reads);
        self.active_list_reads = previous_reads.union(&expected_reads).copied().collect();
        let previous_matches = std::mem::take(&mut self.matched_list_reads);
        let previous_key_local = self.active_list_key_local.clone();
        let previous_key_origin = self.active_list_key_origin;
        let previous_key_initializer = self.active_list_key_initializer;
        let previous_suppressed = self.suppressed_evaluations.clone();
        if let Some((key_origin, _)) = explicit_key {
            self.active_list_key_local = Some(render_key.to_owned());
            self.active_list_key_origin = Some((key_origin.start(), key_origin.end()));
            self.active_list_key_initializer =
                key_alias_initializer.map(|origin| (origin.start(), origin.end()));
            self.suppressed_evaluations
                .insert((key_origin.start(), key_origin.end()));
        }
        let mut render_callback = Expression::ArrowFunctionExpression(render_callback);
        self.prefer_template_clones += 1;
        self.visit_expression(&mut render_callback);
        self.prefer_template_clones -= 1;
        let nested_matches = std::mem::take(&mut self.matched_list_reads);
        let matched_reads: BTreeSet<_> = nested_matches
            .intersection(&expected_reads)
            .copied()
            .collect();
        let propagated_matches: BTreeSet<_> = nested_matches
            .intersection(&previous_reads)
            .copied()
            .collect();
        self.active_list_reads = previous_reads;
        self.matched_list_reads = previous_matches
            .into_iter()
            .chain(propagated_matches)
            .collect();
        self.active_list_key_local = previous_key_local;
        self.active_list_key_origin = previous_key_origin;
        self.active_list_key_initializer = previous_key_initializer;
        self.suppressed_evaluations = previous_suppressed;
        if matched_reads != expected_reads {
            self.diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-KEYED-READ",
                    "keyed child did not materialize every binding-aware callback read",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(diagnostic_origin),
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
                    let getter = match planned {
                        Some(ComponentProp::Spread { getter, .. }) => getter,
                        _ => {
                            self.diagnostics.push(emit_error(
                                "FICT-OXC-EMIT-COMPONENT",
                                "component spread prop does not match its EmitIR plan",
                                GuaranteeClass::Internal,
                            ));
                            false
                        }
                    };
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
                    if getter {
                        if let Some(helper) = &component.prop_helper {
                            let arrow =
                                zero_parameter_expression_arrow(self.allocator, value, spread.span);
                            let callee = Expression::new_identifier(
                                spread.span,
                                self.allocator.alloc_str(helper),
                                &AstBuilder::new(self.allocator),
                            );
                            let mut arguments = ArenaVec::new_in(&self.allocator);
                            arguments.push(Argument::from(arrow));
                            value = Expression::new_call_expression(
                                spread.span,
                                callee,
                                NONE,
                                arguments,
                                false,
                                &AstBuilder::new(self.allocator),
                            );
                        } else {
                            self.diagnostics.push(emit_error(
                                "FICT-OXC-EMIT-COMPONENT",
                                "reactive component spread has no runtime prop helper",
                                GuaranteeClass::Internal,
                            ));
                        }
                    }
                    prop_segments.push(value);
                }
                JSXAttributeItem::Attribute(attribute) => {
                    let attribute = attribute.unbox();
                    let (name, name_span) = jsx_attribute_name(attribute.name);
                    let source_node_span = jsx_attribute_node_span(&attribute.value);
                    let (getter, non_reactive, reactive_function) = match planned {
                        Some(ComponentProp::Named {
                            name: planned_name,
                            getter,
                            non_reactive,
                            reactive_function,
                            ..
                        }) if planned_name == name && source_node_span.is_none() => {
                            (getter, non_reactive, reactive_function)
                        }
                        Some(ComponentProp::Node {
                            name: planned_name,
                            origin,
                        }) if planned_name == name
                            && source_node_span.is_some_and(|span| {
                                component_node_origin_matches(origin, span)
                            }) =>
                        {
                            (false, false, false)
                        }
                        _ => {
                            self.diagnostics.push(emit_error(
                                "FICT-OXC-EMIT-COMPONENT",
                                "component named prop does not match its EmitIR plan",
                                GuaranteeClass::Internal,
                            ));
                            (false, false, false)
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
                    if reactive_function {
                        if let Some(helper) = &component.reactive_function_helper {
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
                                "reactive function component prop has no runtime helper",
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
                    let preview = jsx_attribute_source_span(&attribute.value).and_then(|source| {
                        let location = (source.start, source.end);
                        self.preview_handlers
                            .get(&location)
                            .map(|handler| (location, handler.event.clone()))
                    });
                    let mut value = self.lower_jsx_attribute_value(attribute.value, attribute.span);
                    if let Some((location, event)) = preview {
                        let prevent_default = handler_may_prevent_default(&value);
                        value = ignore_inline_event_handler_return(
                            self.allocator,
                            value,
                            attribute.span,
                        );
                        let Some(qrl) = self.prepare_preview_qrl(
                            location,
                            value,
                            prevent_default,
                            attribute.span,
                        ) else {
                            continue;
                        };
                        properties.push(self.object_property(
                            name_span,
                            &format!("attr:on:{event}"),
                            qrl,
                        ));
                        continue;
                    }
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
            MutationRewrite::Pattern { targets } => {
                let Expression::AssignmentExpression(assignment) = expression else {
                    return false;
                };
                if assignment.operator != oxc::syntax::operator::AssignmentOperator::Assign
                    || !matches!(
                        assignment.left,
                        AssignmentTarget::ArrayAssignmentTarget(_)
                            | AssignmentTarget::ObjectAssignmentTarget(_)
                    )
                {
                    return false;
                }
                walk_mut::walk_assignment_expression(self, assignment);
                let mut matched = BTreeSet::new();
                rewrite_pattern_assignment_target(
                    &mut assignment.left,
                    &targets,
                    &mut matched,
                    self.allocator,
                );
                if matched != targets {
                    self.diagnostics.push(
                        emit_error(
                            "FICT-OXC-EMIT-PATTERN",
                            "reactive pattern target origins do not match the OXC assignment pattern",
                            GuaranteeClass::Internal,
                        )
                        .with_primary_span(
                            SourceSpan::new(assignment.span.start, assignment.span.end)
                                .expect("ordered OXC assignment span"),
                        ),
                    );
                }
                true
            }
        }
    }
}

fn rewrite_pattern_assignment_target<'a>(
    target: &mut AssignmentTarget<'a>,
    expected: &BTreeSet<(u32, u32)>,
    matched: &mut BTreeSet<(u32, u32)>,
    allocator: &'a Allocator,
) {
    if let Some((name, span)) = direct_pattern_target_identifier(target) {
        let location = (span.start, span.end);
        if expected.contains(&location) {
            *target = reactive_setter_assignment_target(allocator, &name, span);
            matched.insert(location);
        }
        return;
    }
    match target {
        AssignmentTarget::ArrayAssignmentTarget(array) => {
            for element in array.elements.iter_mut().flatten() {
                rewrite_pattern_maybe_default(element, expected, matched, allocator);
            }
            if let Some(rest) = &mut array.rest {
                rewrite_pattern_assignment_target(&mut rest.target, expected, matched, allocator);
            }
        }
        AssignmentTarget::ObjectAssignmentTarget(object) => {
            for property in &mut object.properties {
                rewrite_pattern_property(property, expected, matched, allocator);
            }
            if let Some(rest) = &mut object.rest {
                rewrite_pattern_assignment_target(&mut rest.target, expected, matched, allocator);
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

fn rewrite_pattern_maybe_default<'a>(
    target: &mut AssignmentTargetMaybeDefault<'a>,
    expected: &BTreeSet<(u32, u32)>,
    matched: &mut BTreeSet<(u32, u32)>,
    allocator: &'a Allocator,
) {
    if let AssignmentTargetMaybeDefault::AssignmentTargetWithDefault(default) = target {
        rewrite_pattern_assignment_target(&mut default.binding, expected, matched, allocator);
        return;
    }
    let owned = target.take_in(&allocator);
    let Ok(mut assignment_target) = AssignmentTarget::try_from(owned) else {
        unreachable!("non-default assignment target must convert to AssignmentTarget")
    };
    rewrite_pattern_assignment_target(&mut assignment_target, expected, matched, allocator);
    *target = assignment_target.into();
}

fn rewrite_pattern_property<'a>(
    property: &mut AssignmentTargetProperty<'a>,
    expected: &BTreeSet<(u32, u32)>,
    matched: &mut BTreeSet<(u32, u32)>,
    allocator: &'a Allocator,
) {
    match property {
        AssignmentTargetProperty::AssignmentTargetPropertyProperty(property) => {
            rewrite_pattern_maybe_default(&mut property.binding, expected, matched, allocator);
        }
        AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(shorthand) => {
            let location = (shorthand.binding.span.start, shorthand.binding.span.end);
            if !expected.contains(&location) {
                return;
            }
            let owned = property.take_in(&allocator);
            let AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(shorthand) = owned
            else {
                unreachable!("selected shorthand assignment property")
            };
            let shorthand = shorthand.unbox();
            let span = shorthand.binding.span;
            let name = shorthand.binding.name.to_string();
            let builder = AstBuilder::new(allocator);
            let key =
                PropertyKey::new_static_identifier(span, allocator.alloc_str(&name), &builder);
            let setter = reactive_setter_assignment_target(allocator, &name, span);
            let binding = match shorthand.init {
                Some(init) => AssignmentTargetMaybeDefault::new_assignment_target_with_default(
                    shorthand.span,
                    setter,
                    init,
                    &builder,
                ),
                None => AssignmentTargetMaybeDefault::from(setter),
            };
            *property = AssignmentTargetProperty::new_assignment_target_property_property(
                shorthand.span,
                key,
                binding,
                false,
                &builder,
            );
            matched.insert(location);
        }
    }
}

fn direct_pattern_target_identifier(target: &AssignmentTarget<'_>) -> Option<(String, Span)> {
    let identifier = match target {
        AssignmentTarget::AssignmentTargetIdentifier(identifier) => Some(identifier.as_ref()),
        AssignmentTarget::TSAsExpression(expression) => {
            direct_pattern_expression_identifier(&expression.expression)
        }
        AssignmentTarget::TSSatisfiesExpression(expression) => {
            direct_pattern_expression_identifier(&expression.expression)
        }
        AssignmentTarget::TSNonNullExpression(expression) => {
            direct_pattern_expression_identifier(&expression.expression)
        }
        AssignmentTarget::TSTypeAssertion(expression) => {
            direct_pattern_expression_identifier(&expression.expression)
        }
        AssignmentTarget::ComputedMemberExpression(_)
        | AssignmentTarget::StaticMemberExpression(_)
        | AssignmentTarget::PrivateFieldExpression(_)
        | AssignmentTarget::ArrayAssignmentTarget(_)
        | AssignmentTarget::ObjectAssignmentTarget(_) => None,
    }?;
    Some((identifier.name.to_string(), identifier.span))
}

fn direct_pattern_expression_identifier<'a, 'expression>(
    expression: &'expression Expression<'a>,
) -> Option<&'expression IdentifierReference<'a>> {
    match expression.get_inner_expression() {
        Expression::Identifier(identifier) => Some(identifier),
        _ => None,
    }
}

fn reactive_setter_assignment_target<'a>(
    allocator: &'a Allocator,
    signal: &str,
    span: Span,
) -> AssignmentTarget<'a> {
    let builder = AstBuilder::new(allocator);
    let setter_property = "__fictSetter";
    let value_property = "__fictValue";
    let parameter_name = "__fictNext";

    let mut properties = ArenaVec::new_in(&allocator);
    properties.push(ObjectPropertyKind::new_object_property(
        span,
        PropertyKind::Init,
        PropertyKey::new_static_identifier(span, allocator.alloc_str(setter_property), &builder),
        Expression::new_identifier(span, allocator.alloc_str(signal), &builder),
        false,
        false,
        false,
        &builder,
    ));

    let parameter_pattern = BindingPattern::new_binding_identifier(span, parameter_name, &builder);
    let parameter = FormalParameter::new(
        span,
        ArenaVec::new_in(&allocator),
        parameter_pattern,
        NONE,
        NONE,
        false,
        None,
        false,
        false,
        &builder,
    );
    let mut parameter_items = ArenaVec::new_in(&allocator);
    parameter_items.push(parameter);
    let parameters = FormalParameters::boxed(
        span,
        FormalParameterKind::FormalParameter,
        parameter_items,
        NONE,
        &builder,
    );
    let setter_callee = Expression::new_static_member_expression(
        span,
        Expression::new_this_expression(span, &builder),
        IdentifierName::new(span, setter_property, &builder),
        false,
        &builder,
    );
    let mut setter_arguments = ArenaVec::new_in(&allocator);
    setter_arguments.push(Argument::from(Expression::new_identifier(
        span,
        parameter_name,
        &builder,
    )));
    let setter_call = Expression::new_call_expression(
        span,
        setter_callee,
        NONE,
        setter_arguments,
        false,
        &builder,
    );
    let mut statements = ArenaVec::new_in(&allocator);
    statements.push(Statement::new_expression_statement(
        span,
        setter_call,
        &builder,
    ));
    let body = FunctionBody::boxed(span, ArenaVec::new_in(&allocator), statements, &builder);
    let setter_function = Expression::new_function_expression(
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
    );
    properties.push(ObjectPropertyKind::new_object_property(
        span,
        PropertyKind::Set,
        PropertyKey::new_static_identifier(span, allocator.alloc_str(value_property), &builder),
        setter_function,
        false,
        false,
        false,
        &builder,
    ));
    let object = Expression::new_object_expression(span, properties, &builder);
    AssignmentTarget::new_static_member_expression(
        span,
        object,
        IdentifierName::new(span, value_property, &builder),
        false,
        &builder,
    )
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
    variable_statement(
        allocator,
        name,
        initializer,
        span,
        VariableDeclarationKind::Const,
    )
}

fn variable_statement<'a>(
    allocator: &'a Allocator,
    name: &str,
    initializer: Expression<'a>,
    span: Span,
    kind: VariableDeclarationKind,
) -> Statement<'a> {
    let builder = AstBuilder::new(allocator);
    let pattern = BindingPattern::new_binding_identifier(span, allocator.alloc_str(name), &builder);
    let declarator = VariableDeclarator::new(
        span,
        kind,
        pattern,
        NONE,
        Some(initializer),
        false,
        &builder,
    );
    let mut declarations = ArenaVec::new_in(&allocator);
    declarations.push(declarator);
    Statement::new_variable_declaration(span, kind, declarations, false, &builder)
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
        LiteralValue::String(value) => {
            let (value, lone_surrogates) = encode_javascript_string_for_oxc(value);
            Some(Expression::new_string_literal_with_lone_surrogates(
                span,
                allocator.alloc_str(&value),
                None,
                lone_surrogates,
                &builder,
            ))
        }
        LiteralValue::Null
        | LiteralValue::Undefined
        | LiteralValue::Number(_)
        | LiteralValue::BigInt(_)
        | LiteralValue::RegExp { .. } => None,
    }
}

fn encode_javascript_string_for_oxc(value: &JavaScriptString) -> (String, bool) {
    if let Some(value) = value.to_utf8() {
        return (value, false);
    }

    let mut encoded = String::new();
    for character in char::decode_utf16(value.as_code_units().iter().copied()) {
        match character {
            Ok('\u{fffd}') => push_oxc_utf16_marker(&mut encoded, 0xfffd),
            Ok(character) => encoded.push(character),
            Err(error) => push_oxc_utf16_marker(&mut encoded, error.unpaired_surrogate()),
        }
    }
    (encoded, true)
}

fn push_oxc_utf16_marker(output: &mut String, code_unit: u16) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    output.push('\u{fffd}');
    for shift in [12_u16, 8, 4, 0] {
        output.push(char::from(HEX[usize::from((code_unit >> shift) & 0x0f)]));
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

fn handler_may_prevent_default(handler: &Expression<'_>) -> bool {
    let handler = handler.get_inner_expression();
    let parameters = match handler {
        Expression::ArrowFunctionExpression(function) => &function.params,
        Expression::FunctionExpression(function) => &function.params,
        _ => return false,
    };
    let Some(parameter) = parameters.items.first() else {
        return false;
    };
    let BindingPattern::BindingIdentifier(parameter) = &parameter.pattern else {
        return false;
    };
    let mut finder = PreventDefaultFinder {
        event_parameter: parameter.name.as_str(),
        found: false,
    };
    finder.visit_expression(handler);
    finder.found
}

struct PreventDefaultFinder<'name> {
    event_parameter: &'name str,
    found: bool,
}

impl<'a> Visit<'a> for PreventDefaultFinder<'_> {
    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if self.found {
            return;
        }
        let member_matches = match call.callee.get_inner_expression() {
            Expression::StaticMemberExpression(member) => {
                matches!(member.object.get_inner_expression(), Expression::Identifier(object) if object.name == self.event_parameter)
                    && member.property.name == "preventDefault"
            }
            Expression::ComputedMemberExpression(member) => {
                matches!(member.object.get_inner_expression(), Expression::Identifier(object) if object.name == self.event_parameter)
                    && matches!(member.expression.get_inner_expression(), Expression::StringLiteral(property) if property.value == "preventDefault")
            }
            _ => false,
        };
        if member_matches {
            self.found = true;
            return;
        }
        walk::walk_call_expression(self, call);
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

fn rewrite_reactive_accessor<'a>(
    expression: &mut Expression<'a>,
    accessor_depth: usize,
    optional_accessor: bool,
    allocator: &'a Allocator,
) -> bool {
    if accessor_depth == 0 {
        return rewrite_reactive_root(expression, allocator);
    }
    let Some(total_depth) = expression_projection_depth(expression) else {
        return false;
    };
    if accessor_depth > total_depth {
        return false;
    }
    rewrite_reactive_accessor_with_depth(
        expression,
        accessor_depth,
        total_depth,
        optional_accessor,
        allocator,
    )
}

fn rewrite_reactive_accessor_with_depth<'a>(
    expression: &mut Expression<'a>,
    accessor_depth: usize,
    total_depth: usize,
    optional_accessor: bool,
    allocator: &'a Allocator,
) -> bool {
    if total_depth == accessor_depth {
        let span = expression.span();
        let callee = expression.take_in(&allocator);
        let builder = AstBuilder::new(allocator);
        let call = Expression::new_call_expression(
            span,
            callee,
            NONE,
            ArenaVec::new_in(&allocator),
            optional_accessor,
            &builder,
        );
        *expression = if optional_accessor {
            let Expression::CallExpression(call) = call else {
                unreachable!("call builder returns a call expression")
            };
            Expression::new_chain_expression(span, ChainElement::CallExpression(call), &builder)
        } else {
            call
        };
        return true;
    }
    match expression {
        Expression::StaticMemberExpression(member) => rewrite_reactive_accessor_with_depth(
            &mut member.object,
            accessor_depth,
            total_depth.saturating_sub(1),
            optional_accessor,
            allocator,
        ),
        Expression::ComputedMemberExpression(member) => rewrite_reactive_accessor_with_depth(
            &mut member.object,
            accessor_depth,
            total_depth.saturating_sub(1),
            optional_accessor,
            allocator,
        ),
        Expression::PrivateFieldExpression(member) => rewrite_reactive_accessor_with_depth(
            &mut member.object,
            accessor_depth,
            total_depth.saturating_sub(1),
            optional_accessor,
            allocator,
        ),
        Expression::ChainExpression(chain) => match &mut chain.expression {
            ChainElement::StaticMemberExpression(member) => rewrite_reactive_accessor_with_depth(
                &mut member.object,
                accessor_depth,
                total_depth.saturating_sub(1),
                optional_accessor,
                allocator,
            ),
            ChainElement::ComputedMemberExpression(member) => rewrite_reactive_accessor_with_depth(
                &mut member.object,
                accessor_depth,
                total_depth.saturating_sub(1),
                optional_accessor,
                allocator,
            ),
            ChainElement::PrivateFieldExpression(member) => rewrite_reactive_accessor_with_depth(
                &mut member.object,
                accessor_depth,
                total_depth.saturating_sub(1),
                optional_accessor,
                allocator,
            ),
            ChainElement::TSNonNullExpression(expression) => rewrite_reactive_accessor_with_depth(
                &mut expression.expression,
                accessor_depth,
                total_depth,
                optional_accessor,
                allocator,
            ),
            ChainElement::CallExpression(_) => false,
        },
        Expression::ParenthesizedExpression(expression) => rewrite_reactive_accessor_with_depth(
            &mut expression.expression,
            accessor_depth,
            total_depth,
            optional_accessor,
            allocator,
        ),
        Expression::TSAsExpression(expression) => rewrite_reactive_accessor_with_depth(
            &mut expression.expression,
            accessor_depth,
            total_depth,
            optional_accessor,
            allocator,
        ),
        Expression::TSSatisfiesExpression(expression) => rewrite_reactive_accessor_with_depth(
            &mut expression.expression,
            accessor_depth,
            total_depth,
            optional_accessor,
            allocator,
        ),
        Expression::TSTypeAssertion(expression) => rewrite_reactive_accessor_with_depth(
            &mut expression.expression,
            accessor_depth,
            total_depth,
            optional_accessor,
            allocator,
        ),
        Expression::TSNonNullExpression(expression) => rewrite_reactive_accessor_with_depth(
            &mut expression.expression,
            accessor_depth,
            total_depth,
            optional_accessor,
            allocator,
        ),
        Expression::TSInstantiationExpression(expression) => rewrite_reactive_accessor_with_depth(
            &mut expression.expression,
            accessor_depth,
            total_depth,
            optional_accessor,
            allocator,
        ),
        _ => false,
    }
}

fn expression_projection_depth(expression: &Expression<'_>) -> Option<usize> {
    match expression {
        Expression::Identifier(_) | Expression::CallExpression(_) => Some(0),
        Expression::StaticMemberExpression(member) => {
            expression_projection_depth(&member.object).map(|depth| depth.saturating_add(1))
        }
        Expression::ComputedMemberExpression(member) => {
            expression_projection_depth(&member.object).map(|depth| depth.saturating_add(1))
        }
        Expression::PrivateFieldExpression(member) => {
            expression_projection_depth(&member.object).map(|depth| depth.saturating_add(1))
        }
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::StaticMemberExpression(member) => {
                expression_projection_depth(&member.object).map(|depth| depth.saturating_add(1))
            }
            ChainElement::ComputedMemberExpression(member) => {
                expression_projection_depth(&member.object).map(|depth| depth.saturating_add(1))
            }
            ChainElement::PrivateFieldExpression(member) => {
                expression_projection_depth(&member.object).map(|depth| depth.saturating_add(1))
            }
            ChainElement::TSNonNullExpression(expression) => {
                expression_projection_depth(&expression.expression)
            }
            ChainElement::CallExpression(_) => Some(0),
        },
        Expression::ParenthesizedExpression(expression) => {
            expression_projection_depth(&expression.expression)
        }
        Expression::TSAsExpression(expression) => {
            expression_projection_depth(&expression.expression)
        }
        Expression::TSSatisfiesExpression(expression) => {
            expression_projection_depth(&expression.expression)
        }
        Expression::TSTypeAssertion(expression) => {
            expression_projection_depth(&expression.expression)
        }
        Expression::TSNonNullExpression(expression) => {
            expression_projection_depth(&expression.expression)
        }
        Expression::TSInstantiationExpression(expression) => {
            expression_projection_depth(&expression.expression)
        }
        _ => None,
    }
}

fn projected_read_root_location(expression: &Expression<'_>) -> Option<(u32, u32)> {
    match expression {
        Expression::Identifier(identifier) => Some((identifier.span.start, identifier.span.end)),
        Expression::StaticMemberExpression(member) => projected_read_root_location(&member.object),
        Expression::ComputedMemberExpression(member) => {
            projected_read_root_location(&member.object)
        }
        Expression::PrivateFieldExpression(member) => projected_read_root_location(&member.object),
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::StaticMemberExpression(member) => {
                projected_read_root_location(&member.object)
            }
            ChainElement::ComputedMemberExpression(member) => {
                projected_read_root_location(&member.object)
            }
            ChainElement::PrivateFieldExpression(member) => {
                projected_read_root_location(&member.object)
            }
            ChainElement::TSNonNullExpression(expression) => {
                projected_read_root_location(&expression.expression)
            }
            ChainElement::CallExpression(_) => None,
        },
        Expression::ParenthesizedExpression(parenthesized) => {
            projected_read_root_location(&parenthesized.expression)
        }
        Expression::TSAsExpression(expression) => {
            projected_read_root_location(&expression.expression)
        }
        Expression::TSSatisfiesExpression(expression) => {
            projected_read_root_location(&expression.expression)
        }
        Expression::TSTypeAssertion(expression) => {
            projected_read_root_location(&expression.expression)
        }
        Expression::TSNonNullExpression(expression) => {
            projected_read_root_location(&expression.expression)
        }
        Expression::TSInstantiationExpression(expression) => {
            projected_read_root_location(&expression.expression)
        }
        _ => None,
    }
}

fn projected_chain_read_root_location(
    expression: &Expression<'_>,
    reads: &BTreeMap<(u32, u32), ReadRewrite>,
) -> Option<(u32, u32)> {
    let span = expression.span();
    if reads
        .get(&(span.start, span.end))
        .is_some_and(|rewrite| rewrite.projected)
    {
        return projected_read_root_location(expression);
    }
    match expression {
        Expression::StaticMemberExpression(member) => {
            projected_chain_read_root_location(&member.object, reads)
        }
        Expression::ComputedMemberExpression(member) => {
            projected_chain_read_root_location(&member.object, reads)
        }
        Expression::PrivateFieldExpression(member) => {
            projected_chain_read_root_location(&member.object, reads)
        }
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::StaticMemberExpression(member) => {
                projected_chain_read_root_location(&member.object, reads)
            }
            ChainElement::ComputedMemberExpression(member) => {
                projected_chain_read_root_location(&member.object, reads)
            }
            ChainElement::PrivateFieldExpression(member) => {
                projected_chain_read_root_location(&member.object, reads)
            }
            ChainElement::TSNonNullExpression(expression) => {
                projected_chain_read_root_location(&expression.expression, reads)
            }
            ChainElement::CallExpression(_) => None,
        },
        Expression::ParenthesizedExpression(parenthesized) => {
            projected_chain_read_root_location(&parenthesized.expression, reads)
        }
        Expression::TSAsExpression(expression) => {
            projected_chain_read_root_location(&expression.expression, reads)
        }
        Expression::TSSatisfiesExpression(expression) => {
            projected_chain_read_root_location(&expression.expression, reads)
        }
        Expression::TSTypeAssertion(expression) => {
            projected_chain_read_root_location(&expression.expression, reads)
        }
        Expression::TSNonNullExpression(expression) => {
            projected_chain_read_root_location(&expression.expression, reads)
        }
        Expression::TSInstantiationExpression(expression) => {
            projected_chain_read_root_location(&expression.expression, reads)
        }
        _ => None,
    }
}

fn rewrite_reactive_root<'a>(expression: &mut Expression<'a>, allocator: &'a Allocator) -> bool {
    match expression {
        Expression::Identifier(_) | Expression::CallExpression(_) => {
            let span = expression.span();
            let callee = expression.take_in(&allocator);
            *expression = Expression::new_call_expression(
                span,
                callee,
                NONE,
                ArenaVec::new_in(&allocator),
                false,
                &AstBuilder::new(allocator),
            );
            true
        }
        Expression::StaticMemberExpression(member) => {
            rewrite_reactive_root(&mut member.object, allocator)
        }
        Expression::ComputedMemberExpression(member) => {
            rewrite_reactive_root(&mut member.object, allocator)
        }
        Expression::PrivateFieldExpression(member) => {
            rewrite_reactive_root(&mut member.object, allocator)
        }
        Expression::ChainExpression(chain) => match &mut chain.expression {
            ChainElement::StaticMemberExpression(member) => {
                rewrite_reactive_root(&mut member.object, allocator)
            }
            ChainElement::ComputedMemberExpression(member) => {
                rewrite_reactive_root(&mut member.object, allocator)
            }
            ChainElement::PrivateFieldExpression(member) => {
                rewrite_reactive_root(&mut member.object, allocator)
            }
            ChainElement::TSNonNullExpression(expression) => {
                rewrite_reactive_root(&mut expression.expression, allocator)
            }
            ChainElement::CallExpression(_) => false,
        },
        Expression::ParenthesizedExpression(parenthesized) => {
            rewrite_reactive_root(&mut parenthesized.expression, allocator)
        }
        Expression::TSAsExpression(expression) => {
            rewrite_reactive_root(&mut expression.expression, allocator)
        }
        Expression::TSSatisfiesExpression(expression) => {
            rewrite_reactive_root(&mut expression.expression, allocator)
        }
        Expression::TSTypeAssertion(expression) => {
            rewrite_reactive_root(&mut expression.expression, allocator)
        }
        Expression::TSNonNullExpression(expression) => {
            rewrite_reactive_root(&mut expression.expression, allocator)
        }
        Expression::TSInstantiationExpression(expression) => {
            rewrite_reactive_root(&mut expression.expression, allocator)
        }
        _ => false,
    }
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
    if !callback.body.directives.is_empty() || !(1..=2).contains(&callback.body.statements.len()) {
        return None;
    }
    let Statement::ReturnStatement(statement) = callback.body.statements.last()? else {
        return None;
    };
    statement.argument.as_ref()
}

fn into_list_render_arrow<'a>(
    allocator: &'a Allocator,
    callback: Expression<'a>,
) -> Option<oxc::allocator::Box<'a, ArrowFunctionExpression<'a>>> {
    match callback {
        Expression::ArrowFunctionExpression(callback) => Some(callback),
        Expression::FunctionExpression(callback) => {
            let mut callback = callback.unbox();
            if callback.r#async
                || callback.generator
                || callback.id.is_some()
                || callback.this_param.is_some()
            {
                return None;
            }
            callback.params.kind = FormalParameterKind::ArrowFormalParameters;
            let expression = Expression::new_arrow_function_expression(
                callback.span,
                false,
                false,
                callback.type_parameters,
                callback.params,
                callback.return_type,
                callback.body?,
                &AstBuilder::new(allocator),
            );
            let Expression::ArrowFunctionExpression(callback) = expression else {
                unreachable!("arrow builder returns an arrow expression")
            };
            Some(callback)
        }
        _ => None,
    }
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

fn simple_arrow_parameter_name<'a>(
    arrow: &'a ArrowFunctionExpression<'_>,
    index: usize,
) -> Option<&'a str> {
    let parameter = arrow.params.items.get(index)?;
    if parameter.initializer.is_some() {
        return None;
    }
    let BindingPattern::BindingIdentifier(identifier) = &parameter.pattern else {
        return None;
    };
    Some(identifier.name.as_str())
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

pub(crate) struct ZeroSpans;

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
        | EmitOperation::WriteReactivePattern { origin, .. }
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
        CompoundAssignmentOperator, FunctionId, JavaScriptString, LiteralValue, Origin, Projection,
        SourceSpan, UpdateOperator, ValueId,
    };
    use fict_reactivity::{StructurizeAnalysis, StructurizeStats};

    use super::{emit_program, encode_javascript_string_for_oxc};
    use crate::{OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, OxcTypeScriptOptions};

    fn options(language: OxcSourceLanguage, sourcemap: bool) -> OxcCompileOptions {
        OxcCompileOptions {
            language,
            module_kind: OxcModuleKind::Module,
            typescript: OxcTypeScriptOptions::default(),
            sourcemap,
        }
    }

    #[test]
    fn encodes_exact_utf16_strings_for_oxc_without_replacement_loss() {
        let well_formed = JavaScriptString::from("value � 😀");
        assert_eq!(
            encode_javascript_string_for_oxc(&well_formed),
            ("value � 😀".to_owned(), false)
        );

        let exact = JavaScriptString::from_code_units(vec![
            u16::from(b'a'),
            0xd800,
            0xfffd,
            0xd83d,
            0xde00,
            0xdc00,
        ]);
        assert_eq!(
            encode_javascript_string_for_oxc(&exact),
            ("a\u{fffd}d800\u{fffd}fffd😀\u{fffd}dc00".to_owned(), true,)
        );
    }

    fn effect_program(source: &str) -> EmitProgram {
        let call = "$effect(() => 1)";
        let start = u32::try_from(source.find(call).expect("effect call")).expect("span");
        let end = start + u32::try_from(call.len()).expect("span");
        let origin = Origin::source(SourceSpan::new(start, end).expect("ordered span"));
        EmitProgram {
            runtime_family: RuntimeFamily::Runtime,
            preview: false,
            preview_plan: None,
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
                props: None,
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
                source_result: None,
                projections: vec![Projection::StaticProperty {
                    name: "value".into(),
                    optional: false,
                }],
                value: EmitValueRef::Literal(LiteralValue::Undefined),
                target: None,
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
                    accessor_depth: 0,
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
    fn materializes_projected_reactive_reads_at_the_root_only() {
        let source = "const state = () => ({}); export const values = [state.user.name, state?.items?.[key()]];";
        let mut emit = effect_program("$effect(() => 1)");
        emit.imports.clear();
        emit.functions[0].slots.clear();
        emit.functions[0].operations.clear();
        for (index, authored) in ["state.user.name", "state?.items?.[key()]"]
            .into_iter()
            .enumerate()
        {
            let start =
                u32::try_from(source.find(authored).expect("projected read span")).expect("span");
            emit.functions[0]
                .operations
                .push(EmitOperation::ReadReactive {
                    slot: EmitSlotId::new(0),
                    source_result: ValueId::new(u32::try_from(index).expect("value")),
                    projections: vec![Projection::StaticProperty {
                        name: "placeholder".into(),
                        optional: false,
                    }],
                    accessor_depth: 0,
                    target: fict_emit::EmitTemporaryId::new(
                        u32::try_from(index).expect("temporary"),
                    ),
                    helper: None,
                    origin: Origin::source(
                        SourceSpan::new(
                            start,
                            start + u32::try_from(authored.len()).expect("span"),
                        )
                        .expect("ordered span"),
                    ),
                });
        }

        let output = emit_program(
            source,
            "projected-read.js",
            options(OxcSourceLanguage::JavaScript, false),
            &emit,
        );

        assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
        assert!(output.code.contains("state().user.name"), "{}", output.code);
        assert!(
            output.code.contains("state()?.items?.[key()]"),
            "{}",
            output.code
        );
        assert!(!output.code.contains("state()()"), "{}", output.code);
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
                    source_result: None,
                    projections: Vec::new(),
                    value: EmitValueRef::Literal(LiteralValue::Undefined),
                    target: None,
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
