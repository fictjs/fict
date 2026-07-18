use std::path::{Path, PathBuf};

use oxc::{
    allocator::Allocator,
    ast::ast::{Expression, Statement},
    codegen::{Codegen, CodegenOptions},
    parser::{ParseOptions, Parser},
    semantic::SemanticBuilder,
    span::SourceType,
    transformer::{
        DecoratorOptions, JsxOptions, Module, RewriteExtensionsMode, TransformOptions, Transformer,
    },
};

#[derive(Debug)]
struct TransformProbe {
    code: String,
    transform_diagnostics: usize,
    source_map_tokens: usize,
}

fn transform(
    source: &str,
    filename: &str,
    configure: impl FnOnce(&mut TransformOptions),
) -> TransformProbe {
    let allocator = Allocator::default();
    let path = Path::new(filename);
    let source_type = SourceType::from_path(path).expect("probe filename must be supported");
    let parsed = Parser::new(&allocator, source, source_type).parse();
    assert!(
        parsed.diagnostics.is_empty(),
        "parse diagnostics for {filename}: {:?}",
        parsed.diagnostics
    );

    let mut program = parsed.program;
    let semantic = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .with_enum_eval(true)
        .build(&program);
    assert!(
        semantic.diagnostics.is_empty(),
        "semantic diagnostics for {filename}: {:?}",
        semantic.diagnostics
    );

    let mut options = TransformOptions {
        jsx: JsxOptions::disable(),
        ..TransformOptions::default()
    };
    configure(&mut options);
    let transformed = Transformer::new(&allocator, path, &options)
        .build_with_scoping(semantic.semantic.into_scoping(), &mut program);

    let generated = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: Some(PathBuf::from(filename)),
            ..CodegenOptions::default()
        })
        .build(&program);

    TransformProbe {
        code: generated.code,
        transform_diagnostics: transformed.diagnostics.len(),
        source_map_tokens: generated.map.map_or(0, |map| map.get_tokens().len()),
    }
}

#[test]
fn lowers_supported_typescript_namespace() {
    let output = transform(
        "namespace Counter { export const initial = 1; export function read() { return initial; } }",
        "namespace.ts",
        |_| {},
    );

    assert_eq!(output.transform_diagnostics, 0);
    assert!(output.code.contains("let Counter"));
    assert!(output.code.contains("Counter.initial = 1"));
    assert!(output.code.contains("Counter.read = read"));
}

#[test]
fn records_namespace_features_that_require_fict_compat() {
    let mutable = transform(
        "namespace Counter { export let value = 1; export function inc() { value++; } }",
        "mutable-namespace.ts",
        |_| {},
    );
    assert_eq!(mutable.transform_diagnostics, 1);

    let merged = transform(
        concat!(
            "namespace Counter { export const first = 1; }\n",
            "namespace Counter { export const second = first + 1; }",
        ),
        "merged-namespace.ts",
        |_| {},
    );
    assert!(merged.code.contains("first + 1"));
    assert!(!merged.code.contains("Counter.first + 1"));
}

#[test]
fn lowers_cts_import_equals_and_export_assignment() {
    let output = transform(
        concat!(
            "import path = require('node:path');\n",
            "const api = { join: path.join };\n",
            "export = api;",
        ),
        "module.cts",
        |options| options.env.module = Module::CommonJS,
    );

    assert_eq!(output.transform_diagnostics, 0);
    assert!(output.code.contains("const path = require(\"node:path\")"));
    assert!(output.code.contains("module.exports = api"));
    assert!(output.code.contains("\"use strict\""));
}

#[test]
fn pinned_oxc_preserves_standard_decorators_and_lowers_legacy_parameter_decorators() {
    let standard = transform(
        "@sealed class Service { @logged accessor value: number = 1; }",
        "standard-decorator.ts",
        |_| {},
    );
    assert_eq!(standard.transform_diagnostics, 0);
    assert!(standard.code.contains("@sealed"));
    assert!(standard.code.contains("@logged"));
    assert!(!standard.code.contains(": number"));

    let legacy = transform(
        "class Service { constructor(@inject dependency: Dependency) {} }",
        "legacy-decorator.ts",
        |options| {
            options.decorator = DecoratorOptions {
                legacy: true,
                ..DecoratorOptions::default()
            };
        },
    );
    assert_eq!(legacy.transform_diagnostics, 0);
    assert!(!legacy.code.contains("@inject"));
    assert!(legacy.code.contains("decorateParam"));
}

#[test]
fn preserves_fict_and_optimizer_comments() {
    let output = transform(
        concat!(
            "/** @fictReturn signal */\n",
            "export function useValue() {\n",
            "  return /* @__PURE__ */ createValue();\n",
            "}",
        ),
        "comments.ts",
        |_| {},
    );

    assert!(output.code.contains("@fictReturn signal"));
    assert!(output.code.contains("@__PURE__"));
}

#[test]
fn rewrites_typescript_source_extensions_without_touching_packages() {
    let output = transform(
        concat!(
            "import { value } from './value.ts';\n",
            "console.log(value);\n",
            "export * from './nested/tool.mts';\n",
            "export { external } from 'package.ts';",
        ),
        "extensions.ts",
        |options| {
            options.typescript.rewrite_import_extensions = Some(RewriteExtensionsMode::Rewrite);
        },
    );

    assert!(output.code.contains("./value.js"), "{}", output.code);
    assert!(output.code.contains("./nested/tool.mjs"), "{}", output.code);
    assert!(output.code.contains("package.ts"), "{}", output.code);
}

#[test]
fn accepts_commonjs_top_level_return() {
    let allocator = Allocator::default();
    let source = "if (process.env.DISABLED) return; module.exports = 1;";
    let parsed = Parser::new(&allocator, source, SourceType::cjs())
        .with_options(ParseOptions {
            allow_return_outside_function: true,
            ..ParseOptions::default()
        })
        .parse();

    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
}

#[test]
fn emits_non_empty_source_maps_for_transformed_typescript() {
    let output = transform("export const value: number = 1;", "source-map.ts", |_| {});

    assert!(output.source_map_tokens > 0);
    assert!(output.code.contains("export const value = 1"));
}

#[test]
fn generated_getter_expression_maps_to_its_original_expression() {
    let allocator = Allocator::default();
    let filename = "generated-getter.tsx";
    let source = "const getter = props.count;\nconst __skeleton = () => 0;";
    let parsed = Parser::new(&allocator, source, SourceType::tsx()).parse();
    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    let mut program = parsed.program;

    let original = match &mut program.body[0] {
        Statement::VariableDeclaration(declaration) => declaration.declarations[0]
            .init
            .take()
            .expect("origin expression"),
        statement => panic!("unexpected origin statement: {statement:?}"),
    };
    let generated_getter = match &mut program.body[1] {
        Statement::VariableDeclaration(declaration) => declaration.declarations[0]
            .init
            .take()
            .expect("getter skeleton"),
        statement => panic!("unexpected getter statement: {statement:?}"),
    };
    let Expression::ArrowFunctionExpression(mut arrow) = generated_getter else {
        panic!("getter skeleton must be an arrow function")
    };
    let Statement::ExpressionStatement(body) = &mut arrow.body.statements[0] else {
        panic!("arrow expression body must be an expression statement")
    };
    body.expression = original;

    let Statement::VariableDeclaration(declaration) = &mut program.body[0] else {
        unreachable!()
    };
    declaration.declarations[0].init = Some(Expression::ArrowFunctionExpression(arrow));
    program.body.pop();

    let generated = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: Some(PathBuf::from(filename)),
            ..CodegenOptions::default()
        })
        .build(&program);
    let map = generated.map.expect("source map");
    let generated_column = u32::try_from(
        generated
            .code
            .find("props.count")
            .expect("generated getter expression"),
    )
    .expect("generated column");
    let original_column = u32::try_from(source.find("props.count").expect("origin expression"))
        .expect("original column");
    let lookup = map.generate_lookup_table();
    let token = map
        .lookup_token(&lookup, 0, generated_column)
        .expect("mapping for generated getter expression");

    assert_eq!(token.get_src_line(), 0);
    assert_eq!(token.get_src_col(), original_column);
}
