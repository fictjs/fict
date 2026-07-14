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
fn mutable_and_merged_namespaces_fail_closed_before_oxc_miscompile() {
    let mutable = compile_passthrough(
        "namespace Counter { export let value = 1; export function inc() { value++; } }",
        "mutable.ts",
        options(OxcModuleKind::Module),
    );
    assert!(mutable.code.is_empty());
    assert!(
        mutable
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code.as_str() == "FICT-TS-NAMESPACE-MUTABLE" })
    );

    let merged = compile_passthrough(
        concat!(
            "namespace Counter { export const first = 1; }\n",
            "namespace Counter { export const second = first + 1; }",
        ),
        "merged.ts",
        options(OxcModuleKind::Module),
    );
    assert!(merged.code.is_empty());
    assert!(
        merged
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code.as_str() == "FICT-TS-NAMESPACE-MERGED" })
    );
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
