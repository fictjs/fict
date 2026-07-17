use fict_compiler_oxc::{
    OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, TypeScriptFeatureKind,
    TypeScriptLoweringOwner, analyze_typescript_compatibility, compile_passthrough,
};

fn options(module_kind: OxcModuleKind) -> OxcCompileOptions {
    OxcCompileOptions {
        language: OxcSourceLanguage::TypeScript,
        module_kind,
        typescript: Default::default(),
        sourcemap: false,
    }
}

#[test]
fn plans_runtime_typescript_features_before_mutation() {
    let mut compile_options = options(OxcModuleKind::Module);
    compile_options.typescript.rewrite_import_extensions = true;
    let output = analyze_typescript_compatibility(
        r#"
            import type { Shape } from './shape.ts';
            enum Color { Red, Blue }
            const enum Size { Small = 1 }
            namespace Outer { export namespace Inner { export const value = 1; } }
            class Model { declare shape: Shape; }
        "#,
        compile_options,
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let plan = output.plan.expect("compatibility plan");
    assert!(plan.requires_semantic_rebuild);
    assert!(!plan.requires_fict_lowering);
    assert!(plan.features.iter().any(|feature| {
        matches!(
            feature.kind,
            TypeScriptFeatureKind::Enum {
                const_enum: false,
                declared: false
            }
        ) && feature.owner == TypeScriptLoweringOwner::Oxc
    }));
    assert_eq!(plan.namespaces.segments.len(), 2);
    assert_eq!(plan.namespaces.segments[0].path, ["Outer"]);
    assert_eq!(plan.namespaces.segments[1].path, ["Outer", "Inner"]);
    assert!(
        plan.namespaces.segments[0]
            .members
            .iter()
            .any(|member| member.name == "Inner" && member.exported && member.namespace)
    );
    assert!(plan.features.iter().any(|feature| {
        matches!(
            feature.kind,
            TypeScriptFeatureKind::Namespace { depth: 2, .. }
        )
    }));
    assert!(plan.features.iter().any(|feature| {
        matches!(
            &feature.kind,
            TypeScriptFeatureKind::ImportExtension { source, rewritten }
                if source == "./shape.ts" && rewritten == "./shape.js"
        )
    }));
}

#[test]
fn safe_typescript_lowering_rewrites_extensions_and_rebuilds_semantics() {
    let mut compile_options = options(OxcModuleKind::Module);
    compile_options.typescript.rewrite_import_extensions = true;
    let output = compile_passthrough(
        r#"
            import './setup.ts';
            import type { Shape } from './shape.ts';
            enum Color { Red, Blue }
            namespace Defaults { export const color = Color.Red; }
            export const value: number = Defaults.color;
        "#,
        "safe.ts",
        compile_options,
    );

    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    assert!(output.code.contains("./setup.js"), "{}", output.code);
    assert!(!output.code.contains("./shape"), "{}", output.code);
    assert!(!output.code.contains(": number"), "{}", output.code);
    assert!(output.code.contains("Color[Color"), "{}", output.code);
    assert!(output.code.contains("let Defaults"), "{}", output.code);
}

#[test]
fn lowers_mutable_and_merged_namespaces_before_the_oxc_transform() {
    let mutable_source = "namespace Counter { export let value = 1; export function inc() { value++; } export function assign(input) { ({ value } = input); [value] = [2]; } export function read() { return { value }; } }";
    let analysis = analyze_typescript_compatibility(mutable_source, options(OxcModuleKind::Module));
    assert!(
        analysis.diagnostics.is_empty(),
        "{:?}",
        analysis.diagnostics
    );
    let plan = analysis.plan.expect("mutable namespace plan");
    assert!(
        plan.namespaces
            .references
            .iter()
            .any(|reference| reference.member == "value" && reference.mutable && reference.write)
    );

    let mutable = compile_passthrough(mutable_source, "mutable.ts", options(OxcModuleKind::Module));
    assert!(!mutable.code.is_empty());
    assert!(mutable.diagnostics.is_empty(), "{:?}", mutable.diagnostics);
    assert!(mutable.code.contains("Counter.value++"), "{}", mutable.code);
    assert!(
        mutable.code.contains("value: Counter.value"),
        "{}",
        mutable.code
    );
    assert!(
        mutable.code.matches("Counter.value").count() >= 4,
        "{}",
        mutable.code
    );

    let merged_source = concat!(
        "namespace Counter { export const first = 1; }\n",
        "namespace Counter { export const second = first + 1; }",
    );
    let merged_analysis =
        analyze_typescript_compatibility(merged_source, options(OxcModuleKind::Module));
    assert!(
        merged_analysis.diagnostics.is_empty(),
        "{:?}",
        merged_analysis.diagnostics
    );
    assert!(
        merged_analysis
            .plan
            .expect("merged namespace plan")
            .namespaces
            .references
            .iter()
            .any(|reference| reference.member == "first" && reference.cross_segment)
    );
    let merged = compile_passthrough(merged_source, "merged.ts", options(OxcModuleKind::Module));
    assert!(!merged.code.is_empty());
    assert!(merged.diagnostics.is_empty(), "{:?}", merged.diagnostics);
    assert!(merged.code.contains("Counter.first + 1"), "{}", merged.code);

    let uninitialized = compile_passthrough(
        "namespace Settings { export var value; export function set(next) { value = next; } }",
        "uninitialized.ts",
        options(OxcModuleKind::Module),
    );
    assert!(
        uninitialized.diagnostics.is_empty(),
        "{:?}",
        uninitialized.diagnostics
    );
    assert!(
        uninitialized.code.contains("Settings.value = next"),
        "{}",
        uninitialized.code
    );
    assert!(
        uninitialized.code.contains("void 0"),
        "{}",
        uninitialized.code
    );
}

#[test]
fn rejects_cross_segment_references_to_internal_namespace_bindings() {
    let output = compile_passthrough(
        concat!(
            "namespace Counter { const secret = 1; }\n",
            "namespace Counter { export const leaked = secret; }",
        ),
        "internal-namespace.ts",
        options(OxcModuleKind::Module),
    );

    assert!(output.code.is_empty());
    assert!(
        output
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code.as_str() == "FICT-TS-NAMESPACE-REFERENCE" })
    );
}

#[test]
fn rejects_nested_references_to_internal_bindings_from_another_merged_segment() {
    let output = compile_passthrough(
        concat!(
            "namespace Outer { const secret = 1; export namespace Inner {} }\n",
            "namespace Outer { export namespace Inner { export const leaked = secret; } }",
        ),
        "nested-internal-namespace.ts",
        options(OxcModuleKind::Module),
    );

    assert!(output.code.is_empty());
    assert!(
        output
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-TS-NAMESPACE-REFERENCE")
    );
}

#[test]
fn keeps_nested_references_to_internal_bindings_in_their_lexical_segment() {
    let output = compile_passthrough(
        "namespace Outer { const secret = 1; export namespace Inner { export const visible = secret; } export let version = 1; }",
        "nested-lexical-namespace.ts",
        options(OxcModuleKind::Module),
    );

    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    assert!(
        output.code.contains("visible = _Inner.visible = secret"),
        "{}",
        output.code
    );
}

#[test]
fn erases_type_only_references_to_mutable_namespace_exports() {
    let output = compile_passthrough(
        concat!(
            "namespace Settings {\n",
            "  export let value = 1;\n",
            "  export type Value = typeof value;\n",
            "  export function set(next: Value) { value = next; }\n",
            "}",
        ),
        "namespace-type-reference.ts",
        options(OxcModuleKind::Module),
    );

    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    assert!(
        output.code.contains("Settings.value = next"),
        "{}",
        output.code
    );
    assert!(!output.code.contains("type Value"), "{}", output.code);
}

#[test]
fn erases_cross_segment_namespace_heritage_type_references() {
    let output = compile_passthrough(
        concat!(
            "namespace Models { export class Contract {} export let version = 1; }\n",
            "namespace Models { export class Model implements Contract {} }",
        ),
        "namespace-heritage.ts",
        options(OxcModuleKind::Module),
    );

    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    assert!(output.code.contains("class Model"), "{}", output.code);
    assert!(!output.code.contains("implements"), "{}", output.code);
}

#[test]
fn cts_import_equals_export_assignment_and_top_level_return_lower_together() {
    let output = compile_passthrough(
        concat!(
            "import path = require('node:path');\n",
            "if (!path) return;\n",
            "const api = { join: path.join };\n",
            "export = api;",
        ),
        "module.cts",
        options(OxcModuleKind::CommonJs),
    );

    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    assert!(
        output.code.contains("const path = require"),
        "{}",
        output.code
    );
    assert!(
        output.code.contains("module.exports = api"),
        "{}",
        output.code
    );
    assert!(output.code.contains("return"), "{}", output.code);
}

#[test]
fn import_equals_and_export_assignment_require_commonjs_mode() {
    let output = analyze_typescript_compatibility(
        "import path = require('node:path'); export = path;",
        options(OxcModuleKind::Module),
    );

    let codes: Vec<_> = output
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.code.as_str())
        .collect();
    assert!(codes.contains(&"FICT-TS-IMPORT-EQUALS"));
    assert!(codes.contains(&"FICT-TS-EXPORT-ASSIGNMENT"));
}

#[test]
fn preserves_standard_decorators_and_lowers_legacy_parameter_decorators() {
    let standard = compile_passthrough(
        "@sealed class Service { @logged accessor value: number = 1; }",
        "standard.ts",
        options(OxcModuleKind::Module),
    );
    assert!(
        standard.diagnostics.is_empty(),
        "{:?}",
        standard.diagnostics
    );
    assert!(standard.code.contains("@sealed"));
    assert!(standard.code.contains("@logged"));

    let legacy = compile_passthrough(
        "class Service { constructor(@inject dependency: Dependency) {} }",
        "legacy.ts",
        options(OxcModuleKind::Module),
    );
    assert!(legacy.diagnostics.is_empty(), "{:?}", legacy.diagnostics);
    assert!(!legacy.code.contains("@inject"));
    assert!(legacy.code.contains("decorateParam"), "{}", legacy.code);
}

#[test]
fn mixed_decorator_profiles_are_structured_and_fail_closed() {
    let output = analyze_typescript_compatibility(
        "@sealed class Service { constructor(@inject dependency: Dependency) {} }",
        options(OxcModuleKind::Module),
    );

    assert!(output.plan.expect("plan").has_mixed_decorator_profiles);
    assert!(
        output
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code.as_str() == "FICT-TS-DECORATOR-MIXED" })
    );
}

#[test]
fn typescript_options_control_namespace_import_and_enum_lowering() {
    let disabled_namespace = {
        let mut compile_options = options(OxcModuleKind::Module);
        compile_options.typescript.allow_namespaces = false;
        compile_passthrough(
            "namespace Config { export const value = 1; }",
            "disabled.ts",
            compile_options,
        )
    };
    assert!(disabled_namespace.code.is_empty());
    assert!(
        disabled_namespace
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code.as_str() == "FICT-TS-NAMESPACE-DISABLED" })
    );

    let preserve_value_import = {
        let mut compile_options = options(OxcModuleKind::Module);
        compile_options.typescript.only_remove_type_imports = true;
        compile_passthrough(
            "import { Shape } from './shape'; export const value: Shape | null = null;",
            "imports.ts",
            compile_options,
        )
    };
    assert!(preserve_value_import.diagnostics.is_empty());
    assert!(preserve_value_import.code.contains("./shape"));

    let optimized_enum = {
        let mut compile_options = options(OxcModuleKind::Module);
        compile_options.typescript.optimize_const_enums = true;
        compile_passthrough(
            "const enum Size { Small = 1 } export const value = Size.Small;",
            "enum.ts",
            compile_options,
        )
    };
    assert!(optimized_enum.diagnostics.is_empty());
    assert!(
        !optimized_enum.code.contains("Size["),
        "{}",
        optimized_enum.code
    );
    assert!(
        optimized_enum.code.contains("value = 1"),
        "{}",
        optimized_enum.code
    );
}

#[test]
fn extension_rewrite_is_explicit_and_ignores_non_terminal_extensions() {
    let source = "import './setup.ts?worker';";
    let unchanged = compile_passthrough(source, "extensions.ts", options(OxcModuleKind::Module));
    assert!(unchanged.code.contains("./setup.ts?worker"));

    let mut compile_options = options(OxcModuleKind::Module);
    compile_options.typescript.rewrite_import_extensions = true;
    let rewritten = compile_passthrough(source, "extensions.ts", compile_options);
    assert!(rewritten.code.contains("./setup.ts?worker"));
}

#[test]
fn rewrites_external_import_equals_extensions_in_commonjs_mode() {
    let mut compile_options = options(OxcModuleKind::CommonJs);
    compile_options.typescript.rewrite_import_extensions = true;
    let rewritten = compile_passthrough(
        "import dependency = require('./dependency.cts'); export = dependency;",
        "entry.cts",
        compile_options,
    );

    assert!(
        rewritten.diagnostics.is_empty(),
        "{:?}",
        rewritten.diagnostics
    );
    assert!(
        rewritten.code.contains("require(\"./dependency.cjs\")"),
        "{}",
        rewritten.code
    );
    assert!(!rewritten.code.contains("./dependency.cts"));
}
