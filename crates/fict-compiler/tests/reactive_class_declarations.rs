use fict_compiler::{
    COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions, ModuleKind, compile,
};

fn compile_source(code: &str, strict_guarantee: bool) -> fict_compiler::CompileResult {
    compile(CompileRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: code.into(),
        filename: "reactive-class-declaration.tsx".into(),
        module_id: None,
        public_module_id: None,
        language: None,
        module_kind: Some(ModuleKind::CommonJs),
        input_source_map: None,
        options: CompilerOptions {
            sourcemap: true,
            strict_guarantee,
            optimize: false,
            ..CompilerOptions::default()
        },
        metadata: Vec::new(),
        integration_diagnostics: Vec::new(),
    })
}

#[test]
fn compiles_reactive_class_declarations_without_internal_diagnostics() {
    let source = r#"
        import { $state } from 'fict';
        export function Scenario() {
            class Base {}
            let Parent = $state(Base);
            class Child extends Parent {}
            return new Child();
        }
    "#;
    for strict in [false, true] {
        let result = compile_source(source, strict);
        assert!(
            !result.has_errors(),
            "strict={strict}: {:?}",
            result.diagnostics
        );
        assert!(result.code.contains("class Child extends Parent()"));
        assert!(result.map.is_some());
    }
}

#[test]
fn preserves_reactive_class_internal_names() {
    let source = r#"
        import { $state } from 'fict';
        export function Scenario() {
            class Base {}
            let Parent = $state(Base);
            class Child extends Parent {
                static self = Child;
                static current() { return Child; }
            }
            return [Child, Child.self, Child.current()];
        }
    "#;
    for strict in [false, true] {
        let result = compile_source(source, strict);
        assert!(
            !result.has_errors(),
            "strict={strict}: {:?}",
            result.diagnostics
        );
        assert!(result.code.contains("class Child extends Parent()"));
        assert!(result.code.contains("static self = Child;"));
        assert!(!result.code.contains("static self = Child();"));
        assert!(result.code.contains("return Child;"));
    }
}

#[test]
fn compiles_declaration_and_expression_scope_matrix() {
    let source = r#"
        import { $state } from 'fict';
        export class NamedExport { static value = 1; }
        export default class DefaultExport { static value = 2; }
        export function Scenario() {
            class Base {}
            let Parent = $state(Base);
            let key = $state('run');
            class Extends extends Parent {}
            class Computed { [key]() { return 1; } }
            class StaticField { static value = Parent; }
            class StaticBlock { static value; static { this.value = Parent; } }
            const Expression = class Expression extends Parent { static self = Expression; };
            const Block = (() => {
                class BlockChild extends Parent {}
                return BlockChild;
            })();
            function nested() {
                class NestedChild extends Parent {}
                return NestedChild;
            }
            return [
                Extends,
                Computed,
                StaticField,
                StaticBlock,
                Expression,
                Block,
                nested(),
                NamedExport.value,
                DefaultExport.value,
            ];
        }
    "#;
    for strict in [false, true] {
        let result = compile_source(source, strict);
        assert!(
            !result.has_errors(),
            "strict={strict}: {:?}",
            result.diagnostics
        );
        for name in [
            "Extends",
            "Computed",
            "StaticField",
            "StaticBlock",
            "BlockChild",
            "NestedChild",
        ] {
            assert!(
                result.code.contains(&format!("class {name}")),
                "missing {name}: {}",
                result.code
            );
        }
        assert!(result.code.contains("class NamedExport"));
        assert!(result.code.contains("class DefaultExport"));
        assert!(result.code.contains("const Expression ="));
        for name in ["Extends", "BlockChild", "NestedChild"] {
            assert!(
                result
                    .code
                    .contains(&format!("class {name} extends Parent()")),
                "missing reactive base for {name}: {}",
                result.code
            );
        }
        assert!(result.code.contains("[key()]()"));
        assert!(result.code.contains("static value = Parent()"));
        assert!(result.code.contains("this.value = Parent()"));
    }
}
