use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use fict_diagnostics::{Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass};
use fict_emit::{
    EmitPreviewHandler, EmitPreviewPlan, RuntimeFamily, RuntimeHelper, RuntimeHelperSpec,
};
use oxc::{
    allocator::Allocator,
    ast::ast::{Expression, IdentifierReference, Program},
    ast_visit::{Visit, VisitMut, walk_mut},
    codegen::{Codegen, CodegenOptions},
    parser::Parser,
    semantic::SemanticBuilder,
    span::SourceType,
    transformer::{TransformOptions, Transformer},
};

use crate::compile::convert_diagnostics;
use crate::{OxcHandlerArtifact, OxcModuleKind};

use super::emit_codegen::ZeroSpans;

const HANDLER_SENTINEL: &str = "__FICT_PREVIEW_HANDLER_EXPRESSION__";

pub(crate) struct PreparedHandler<'a> {
    pub plan: EmitPreviewHandler,
    pub expression: Expression<'a>,
}

pub(crate) fn generate_handler_artifact<'a>(
    allocator: &'a Allocator,
    source: &str,
    filename: &str,
    source_type: SourceType,
    module_kind: OxcModuleKind,
    transform_options: &TransformOptions,
    runtime_family: RuntimeFamily,
    preview: &EmitPreviewPlan,
    prepared: PreparedHandler<'a>,
    sourcemap: bool,
) -> Result<OxcHandlerArtifact, Vec<Diagnostic>> {
    if module_kind != OxcModuleKind::Module {
        return Err(vec![preview_error(
            "FICT-PREVIEW-MODULE",
            "structured Preview handler artifacts require ESM output",
        )]);
    }
    let mut identifiers = IdentifierCollector::default();
    identifiers.visit_expression(&prepared.expression);
    for capture in &prepared.plan.lexical_captures {
        identifiers.names.insert(capture.local.clone());
    }
    for capture in &prepared.plan.prop_captures {
        identifiers.names.insert(capture.local.clone());
    }
    for capture in &prepared.plan.prop_rest_captures {
        identifiers.names.insert(capture.local.clone());
    }
    for capture in &prepared.plan.module_captures {
        identifiers.names.insert(capture.local.clone());
    }
    if let Some(local) = &prepared.plan.props_object_local {
        identifiers.names.insert(local.clone());
    }
    let mut names = identifiers.names;
    let scope_id = allocate_name(&mut names, "scopeId");
    let event = allocate_name(&mut names, "event");
    let element = allocate_name(&mut names, "el");
    let handler = allocate_name(&mut names, "__handler");
    let result = allocate_name(&mut names, "__result");
    let scope_props = allocate_name(&mut names, "__scopeProps");
    let lexical_helper = helper_alias(
        &mut names,
        RuntimeHelper::UseLexicalScope.spec(),
        !prepared.plan.lexical_captures.is_empty(),
    );
    let props_helper = helper_alias(
        &mut names,
        RuntimeHelper::GetScopeProps.spec(),
        prepared.plan.props_object_local.is_some()
            || !prepared.plan.prop_captures.is_empty()
            || !prepared.plan.prop_rest_captures.is_empty(),
    );
    let props_rest_helper = helper_alias(
        &mut names,
        RuntimeHelper::PropsRest.spec(),
        !prepared.plan.prop_rest_captures.is_empty(),
    );

    let mut wrapper = String::new();
    if let Some(local) = &lexical_helper {
        push_helper_import(
            &mut wrapper,
            RuntimeHelper::UseLexicalScope.spec(),
            local,
            runtime_family,
        );
    }
    if let Some(local) = &props_helper {
        push_helper_import(
            &mut wrapper,
            RuntimeHelper::GetScopeProps.spec(),
            local,
            runtime_family,
        );
    }
    if let Some(local) = &props_rest_helper {
        push_helper_import(
            &mut wrapper,
            RuntimeHelper::PropsRest.spec(),
            local,
            runtime_family,
        );
    }
    if !prepared.plan.module_captures.is_empty() {
        wrapper.push_str("import { ");
        for (index, capture) in prepared.plan.module_captures.iter().enumerate() {
            if index > 0 {
                wrapper.push_str(", ");
            }
            wrapper.push_str(&capture.source_export_name);
            if capture.source_export_name != capture.local {
                wrapper.push_str(" as ");
                wrapper.push_str(&capture.local);
            }
        }
        wrapper.push_str(" } from ");
        wrapper.push_str(&quote_javascript_string(&preview.source_module_id));
        wrapper.push_str(";\n");
    }
    wrapper.push_str("export default (");
    wrapper.push_str(&scope_id);
    wrapper.push_str(", ");
    wrapper.push_str(&event);
    wrapper.push_str(", ");
    wrapper.push_str(&element);
    wrapper.push_str(") => {\n");
    if let Some(helper) = &lexical_helper {
        wrapper.push_str("const [");
        for (index, capture) in prepared.plan.lexical_captures.iter().enumerate() {
            if index > 0 {
                wrapper.push_str(", ");
            }
            wrapper.push_str(&capture.local);
        }
        wrapper.push_str("] = ");
        wrapper.push_str(helper);
        wrapper.push('(');
        wrapper.push_str(&scope_id);
        wrapper.push_str(", [");
        for (index, capture) in prepared.plan.lexical_captures.iter().enumerate() {
            if index > 0 {
                wrapper.push_str(", ");
            }
            wrapper.push_str(&quote_javascript_string(&capture.local));
        }
        wrapper.push_str("]);\n");
    }
    if let Some(helper) = &props_helper {
        wrapper.push_str("const ");
        wrapper.push_str(&scope_props);
        wrapper.push_str(" = ");
        wrapper.push_str(helper);
        wrapper.push('(');
        wrapper.push_str(&scope_id);
        wrapper.push_str(") || {};\n");
        if let Some(local) = &prepared.plan.props_object_local {
            wrapper.push_str("const ");
            wrapper.push_str(local);
            wrapper.push_str(" = ");
            wrapper.push_str(&scope_props);
            wrapper.push_str(";\n");
        }
        for capture in &prepared.plan.prop_captures {
            wrapper.push_str("const ");
            wrapper.push_str(&capture.local);
            wrapper.push_str(" = () => ");
            let mut read = scope_props.clone();
            for segment in &capture.path {
                read.push('[');
                read.push_str(&quote_javascript_string(segment));
                read.push(']');
            }
            if let Some(default) = capture.default_value.and_then(|origin| origin.primary_span) {
                let default_source = source
                    .get(default.start() as usize..default.end() as usize)
                    .unwrap_or("void 0");
                wrapper.push_str("((__value) => __value === void 0 ? (");
                wrapper.push_str(default_source);
                wrapper.push_str(") : __value)(");
                wrapper.push_str(&read);
                wrapper.push(')');
            } else {
                wrapper.push_str(&read);
            }
            wrapper.push_str(";\n");
        }
        for capture in &prepared.plan.prop_rest_captures {
            wrapper.push_str("const ");
            wrapper.push_str(&capture.local);
            wrapper.push_str(" = ");
            wrapper.push_str(
                props_rest_helper
                    .as_deref()
                    .expect("props-rest captures require their runtime helper"),
            );
            wrapper.push('(');
            wrapper.push_str(&scope_props);
            wrapper.push_str(", [");
            for (index, excluded) in capture.excluded.iter().enumerate() {
                if index > 0 {
                    wrapper.push_str(", ");
                }
                wrapper.push_str(&quote_javascript_string(excluded));
            }
            wrapper.push_str("]);\n");
        }
    }
    wrapper.push_str("const ");
    wrapper.push_str(&handler);
    wrapper.push_str(" = ");
    wrapper.push_str(HANDLER_SENTINEL);
    wrapper.push_str(";\nif (typeof ");
    wrapper.push_str(&handler);
    wrapper.push_str(" === \"function\") {\nconst ");
    wrapper.push_str(&result);
    wrapper.push_str(" = ");
    wrapper.push_str(&handler);
    wrapper.push_str(".call(");
    wrapper.push_str(&element);
    wrapper.push_str(", ");
    wrapper.push_str(&event);
    wrapper.push_str(");\nif (typeof ");
    wrapper.push_str(&result);
    wrapper.push_str(" === \"function\" && ");
    wrapper.push_str(&result);
    wrapper.push_str(" !== ");
    wrapper.push_str(&handler);
    wrapper.push_str(") return ");
    wrapper.push_str(&result);
    wrapper.push_str(".call(");
    wrapper.push_str(&element);
    wrapper.push_str(", ");
    wrapper.push_str(&event);
    wrapper.push_str(");\nif (");
    wrapper.push_str(&result);
    wrapper.push_str(" && typeof ");
    wrapper.push_str(&result);
    wrapper.push_str(".handleEvent === \"function\") return ");
    wrapper.push_str(&result);
    wrapper.push_str(".handleEvent.call(");
    wrapper.push_str(&result);
    wrapper.push_str(", ");
    wrapper.push_str(&event);
    wrapper.push_str(");\nreturn ");
    wrapper.push_str(&result);
    wrapper.push_str(";\n}\nif (");
    wrapper.push_str(&handler);
    wrapper.push_str(" && typeof ");
    wrapper.push_str(&handler);
    wrapper.push_str(".handleEvent === \"function\") return ");
    wrapper.push_str(&handler);
    wrapper.push_str(".handleEvent.call(");
    wrapper.push_str(&handler);
    wrapper.push_str(", ");
    wrapper.push_str(&event);
    wrapper.push_str(");\n};\n");

    let parsed = Parser::new(allocator, &wrapper, SourceType::mjs()).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(convert_diagnostics(
            parsed.diagnostics,
            "FICT-PREVIEW-ARTIFACT",
        ));
    }
    let mut program = parsed.program;
    ZeroSpans.visit_program(&mut program);
    let mut replacer = HandlerExpressionReplacer {
        replacement: Some(prepared.expression),
        replacements: 0,
    };
    replacer.visit_program(&mut program);
    if replacer.replacements != 1 {
        return Err(vec![preview_error(
            "FICT-PREVIEW-ARTIFACT",
            "generated handler wrapper did not contain exactly one expression placeholder",
        )]);
    }

    transform_artifact(
        allocator,
        filename,
        transform_options,
        &mut program,
        source_type,
    )?;
    let rebuilt = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .with_enum_eval(true)
        .build(&program);
    let has_errors = rebuilt.diagnostics.has_errors();
    let diagnostics = convert_diagnostics(rebuilt.diagnostics, "FICT-PREVIEW-SEMANTIC");
    if has_errors {
        return Err(diagnostics);
    }
    let generated = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: sourcemap.then(|| PathBuf::from(filename)),
            ..CodegenOptions::default()
        })
        .with_source_text(source)
        .with_source_type(source_type)
        .with_scoping(Some(rebuilt.semantic.into_scoping()))
        .build(&program);
    let source_span = prepared
        .plan
        .handler_origin
        .primary_span
        .expect("Preview planner requires handler source spans");
    Ok(OxcHandlerArtifact {
        id: prepared.plan.artifact_id,
        code: generated.code,
        source_map_json: generated.map.map(|map| map.to_json_string()),
        source_export_name: prepared.plan.source_export_name,
        artifact_export_name: "default".into(),
        module_specifier: prepared.plan.module_specifier,
        source_span,
    })
}

fn transform_artifact<'a>(
    allocator: &'a Allocator,
    filename: &str,
    options: &TransformOptions,
    program: &mut Program<'a>,
    source_type: SourceType,
) -> Result<(), Vec<Diagnostic>> {
    if !source_type.is_typescript() {
        return Ok(());
    }
    let semantic = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .with_enum_eval(true)
        .build(program);
    let has_errors = semantic.diagnostics.has_errors();
    let diagnostics = convert_diagnostics(semantic.diagnostics, "FICT-PREVIEW-SEMANTIC");
    if has_errors {
        return Err(diagnostics);
    }
    let transformed = Transformer::new(allocator, Path::new(filename), options)
        .build_with_scoping(semantic.semantic.into_scoping(), program);
    let has_errors = transformed.diagnostics.has_errors();
    let diagnostics = convert_diagnostics(transformed.diagnostics, "FICT-PREVIEW-TRANSFORM");
    if has_errors {
        return Err(diagnostics);
    }
    Ok(())
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

struct HandlerExpressionReplacer<'a> {
    replacement: Option<Expression<'a>>,
    replacements: u32,
}

impl<'a> VisitMut<'a> for HandlerExpressionReplacer<'a> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        if matches!(expression, Expression::Identifier(identifier) if identifier.name == HANDLER_SENTINEL)
        {
            *expression = self
                .replacement
                .take()
                .expect("one generated handler expression placeholder");
            self.replacements += 1;
            return;
        }
        walk_mut::walk_expression(self, expression);
    }
}

fn helper_alias(
    names: &mut BTreeSet<String>,
    spec: &RuntimeHelperSpec,
    used: bool,
) -> Option<String> {
    used.then(|| allocate_name(names, spec.preferred_local))
}

fn push_helper_import(
    output: &mut String,
    spec: &RuntimeHelperSpec,
    local: &str,
    family: RuntimeFamily,
) {
    output.push_str("import { ");
    output.push_str(spec.export);
    if spec.export != local {
        output.push_str(" as ");
        output.push_str(local);
    }
    output.push_str(" } from ");
    output.push_str(&quote_javascript_string(spec.module_request(family)));
    output.push_str(";\n");
}

fn allocate_name(names: &mut BTreeSet<String>, preferred: &str) -> String {
    if names.insert(preferred.to_owned()) {
        return preferred.to_owned();
    }
    let mut index = 1_u32;
    loop {
        let candidate = format!("{preferred}_{index}");
        index = index.saturating_add(1);
        if names.insert(candidate.clone()) {
            return candidate;
        }
    }
}

pub(crate) fn quote_javascript_string(value: &str) -> String {
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

fn preview_error(code: &'static str, message: impl Into<String>) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("Preview diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(GuaranteeClass::Internal)
}
