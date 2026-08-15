use fict_compiler::{COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions, compile};
use fict_diagnostics::DiagnosticSeverity;
use fict_metadata::{HookReturnInfo, ReactiveExportKind};

fn request(code: &str) -> CompileRequest {
    CompileRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: code.into(),
        filename: "hook-return-conflict.tsx".into(),
        module_id: None,
        public_module_id: None,
        language: None,
        module_kind: None,
        input_source_map: None,
        options: CompilerOptions::default(),
        metadata: Vec::new(),
        integration_diagnostics: Vec::new(),
        limits: Default::default(),
    }
}

fn h002(result: &fict_compiler::CompileResult) -> &fict_diagnostics::Diagnostic {
    result
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code.as_str() == "FICT-H002")
        .expect("FICT-H002 diagnostic")
}

#[test]
fn inconsistent_hook_return_slots_fail_closed_by_default() {
    let result = compile(request(
        r#"
            import { $state } from 'fict';
            export function useThing(flag) {
                const count = $state(0);
                if (flag) return { count };
                return { count: 'off' };
            }
        "#,
    ));

    assert!(result.has_errors(), "{:?}", result.diagnostics);
    assert!(result.code.is_empty());
    assert_eq!(h002(&result).severity, DiagnosticSeverity::Error);
    assert!(h002(&result).primary_span.is_some());
}

#[test]
fn opt_out_warns_and_publishes_only_consistent_slots() {
    let mut input = request(
        r#"
            import { $state } from 'fict';
            export function useThing(flag) {
                const count = $state(0);
                const stable = $state(1);
                if (flag) return { count, stable };
                return { count: 'off', stable };
            }
        "#,
    );
    input.options.strict_guarantee = false;
    let result = compile(input);

    assert!(!result.has_errors(), "{:?}", result.diagnostics);
    assert!(!result.code.is_empty());
    assert_eq!(h002(&result).severity, DiagnosticSeverity::Warning);
    assert_eq!(
        result.module_metadata.hooks.get("useThing"),
        Some(&HookReturnInfo {
            object_props: [("stable".into(), ReactiveExportKind::Signal)].into(),
            ..HookReturnInfo::default()
        })
    );
}

#[test]
fn detects_expression_kind_and_forwarded_hook_conflicts() {
    let cases = [
        r#"
            import { $memo, $state } from 'fict';
            export function useThing(flag) {
                const count = $state(0);
                const doubled = $memo(() => count * 2);
                return flag ? count : doubled;
            }
        "#,
        r#"
            import { $state } from 'fict';
            export function useThing(flag) {
                const count = $state(0);
                return { value: flag && count };
            }
        "#,
        r#"
            import { $state } from 'fict';
            function useBase() {
                const count = $state(0);
                return { count };
            }
            function makePlain() { return { count: 'off' }; }
            export function useThing(flag) {
                const plain = makePlain();
                const live = useBase();
                return flag ? plain : live;
            }
        "#,
    ];

    for (index, source) in cases.into_iter().enumerate() {
        let mut input = request(source);
        input.options.strict_guarantee = false;
        let result = compile(input);
        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == "FICT-H002"),
            "case {index}: diagnostics={:?}, metadata={:?}",
            result.diagnostics,
            result.module_metadata
        );
        assert_eq!(h002(&result).severity, DiagnosticSeverity::Warning);
    }
}

#[test]
fn consistent_plain_and_accessor_shapes_remain_valid() {
    let result = compile(request(
        r#"
            import { $state } from 'fict';
            export function usePlain(flag) {
                const count = $state(0);
                if (flag) return { count: count() };
                return { count: 0 };
            }
            export function useLive(flag) {
                const left = $state(0);
                const right = $state(1);
                return { count: flag ? left : right };
            }
        "#,
    ));

    assert!(!result.has_errors(), "{:?}", result.diagnostics);
    assert!(
        result
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code.as_str() != "FICT-H002")
    );
    assert_eq!(
        result
            .module_metadata
            .hooks
            .get("useLive")
            .and_then(|info| info.object_props.get("count")),
        Some(&ReactiveExportKind::Signal)
    );
}
