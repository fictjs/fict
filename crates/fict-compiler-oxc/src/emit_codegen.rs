use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use fict_diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use fict_emit::{EmitOperation, EmitProgram, RuntimeHelper};
use oxc::{
    allocator::Allocator,
    ast::ast::{Expression, ImportDeclarationSpecifier, ImportOrExportKind, Statement},
    ast_visit::{VisitMut, walk_mut},
    codegen::{Codegen, CodegenOptions},
    parser::{ParseOptions, Parser},
    semantic::SemanticBuilder,
    span::{SourceType, Span},
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

    strip_compiler_macro_imports(&mut program);

    let (rewrites, rewrite_diagnostics) = call_rewrites(emit);
    diagnostics.extend(rewrite_diagnostics);
    if !diagnostics.is_empty() {
        return failed_output(diagnostics);
    }
    let mut rewriter = CallRewriter {
        allocator: &allocator,
        rewrites: &rewrites,
        matched: BTreeSet::new(),
    };
    rewriter.visit_program(&mut program);
    for location in rewrites.keys() {
        if !rewriter.matched.contains(location) {
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
    let unsupported_scoped_helper = emit
        .functions
        .iter()
        .flat_map(|function| &function.operations)
        .find(|operation| {
            matches!(
                operation,
                EmitOperation::CreateReactive {
                    helper: RuntimeHelper::UseSignal | RuntimeHelper::UseMemo,
                    ..
                } | EmitOperation::RegisterEffect {
                    helper: RuntimeHelper::UseEffect,
                    ..
                }
            )
        });
    if let Some(operation) = unsupported_scoped_helper {
        let mut diagnostic = emit_error(
            "FICT-OXC-EMIT-CONTEXT",
            "component and hook runtime helpers require a compiler context argument that is not yet materialized",
            GuaranteeClass::Unsupported,
        );
        diagnostic.primary_span = operation_origin(operation).primary_span;
        return vec![diagnostic];
    }
    let unsupported = emit
        .functions
        .iter()
        .flat_map(|function| &function.operations)
        .find(|operation| {
            matches!(
                operation,
                EmitOperation::ReadReactive { .. }
                    | EmitOperation::WriteReactive { .. }
                    | EmitOperation::UpdateReactive { .. }
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
            )
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

fn call_rewrites(emit: &EmitProgram) -> (BTreeMap<(u32, u32), String>, Vec<Diagnostic>) {
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
        if rewrites
            .insert((span.start(), span.end()), (*local).to_owned())
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
    (rewrites, diagnostics)
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

struct CallRewriter<'a, 'emit> {
    allocator: &'a Allocator,
    rewrites: &'emit BTreeMap<(u32, u32), String>,
    matched: BTreeSet<(u32, u32)>,
}

impl<'a> VisitMut<'a> for CallRewriter<'a, '_> {
    fn visit_call_expression(&mut self, call: &mut oxc::ast::ast::CallExpression<'a>) {
        let location = (call.span.start, call.span.end);
        if let Some(local) = self.rewrites.get(&location)
            && rename_callee(&mut call.callee, self.allocator.alloc_str(local))
        {
            self.matched.insert(location);
        }
        walk_mut::walk_call_expression(self, call);
    }
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
        CleanupOwner, EmitFunction, EmitModulePlan, EmitOperation, EmitProgram, EmitSlotId,
        EmitValueRef, ReactiveSlot, ReactiveSlotKind, RuntimeFamily, RuntimeHelper,
        RuntimeImportIntent,
    };
    use fict_hir::{FunctionId, LiteralValue, Origin, SourceSpan, ValueId};
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
                slots: vec![ReactiveSlot {
                    id: EmitSlotId::new(0),
                    kind: ReactiveSlotKind::Effect,
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
            .push(EmitOperation::ReadReactive {
                slot: EmitSlotId::new(0),
                source_result: ValueId::new(0),
                projections: Vec::new(),
                target: fict_emit::EmitTemporaryId::new(0),
                helper: None,
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
}
