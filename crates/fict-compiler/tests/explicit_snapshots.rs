use fict_compiler::{
    COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions, OptimizeLevel, compile,
};

fn request(code: &str) -> CompileRequest {
    CompileRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: code.into(),
        filename: "explicit-snapshot.tsx".into(),
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

#[test]
fn strict_explicit_primitive_snapshots_compile_in_every_optimization_profile() {
    for (initial, update, snapshot) in [
        ("1", "count++", "untrack(() => externalFormat(count))"),
        (
            "'one'",
            "count = 'two'",
            "untrack(() => externalFormat(count))",
        ),
        (
            "false",
            "count = true",
            "untrack(() => externalFormat(count))",
        ),
        ("null", "count = 2", "untrack(() => externalFormat(count))"),
        ("1n", "count += 2n", "untrack(() => externalFormat(count))"),
        ("1", "count++", "externalFormat(untrack(() => count))"),
        (
            "1",
            "count++",
            "externalFormat(untrack(function () { return count }))",
        ),
    ] {
        for (optimize, optimize_level) in [
            (false, OptimizeLevel::Safe),
            (true, OptimizeLevel::Safe),
            (true, OptimizeLevel::Full),
        ] {
            let source = format!(
                "import {{ $state, untrack }} from 'fict';
                 import {{ externalFormat }} from 'external';
                 export function Counter() {{
                   let count = $state({initial});
                   const result = {snapshot};
                   {update};
                   return <div>{{result}}</div>;
                 }}"
            );
            let mut input = request(&source);
            input.options.optimize = optimize;
            input.options.optimize_level = optimize_level;
            let result = compile(input);
            assert!(!result.has_errors(), "{source}: {:?}", result.diagnostics);
            assert!(
                !result.code.contains("const result = __fictUseMemo"),
                "{}",
                result.code
            );
            assert!(result.code.contains("untrack("), "{}", result.code);
        }
    }
}

#[test]
fn primitive_snapshot_bindings_can_cross_unknown_value_boundaries() {
    let source = "import { $state, untrack as snapshot } from 'fict';
        import { consume } from 'external';
        export function Counter() {
          let count = $state(1);
          const captured = snapshot(() => count);
          const alias = captured;
          count++;
          consume(captured);
          consume(alias);
          return <div>{captured}</div>;
        }";
    let result = compile(request(source));
    assert!(!result.has_errors(), "{:?}", result.diagnostics);
    assert!(result.code.contains("consume(captured)"), "{}", result.code);
    assert!(result.code.contains("consume(alias)"), "{}", result.code);
}

#[test]
fn untrack_does_not_hide_retained_callbacks_async_work_or_mutable_values() {
    for (initial, setup, expression, code) in [
        ("1", "", "consume(count)", "FICT-S002"),
        ("{}", "", "untrack(() => consume(count))", "FICT-S002"),
        (
            "1",
            "count = {};",
            "untrack(() => consume(count))",
            "FICT-S002",
        ),
        (
            "1",
            "count({});",
            "untrack(() => consume(count))",
            "FICT-S002",
        ),
        (
            "1",
            "[count] = input;",
            "untrack(() => consume(count))",
            "FICT-S002",
        ),
        (
            "1",
            "for (count of input) {}",
            "untrack(() => consume(count))",
            "FICT-S002",
        ),
        ("1", "", "untrack(() => consume(() => count))", "FICT-R005"),
        ("1", "", "consume(untrack(() => () => count))", "FICT-R005"),
        (
            "1",
            "",
            "untrack(() => Promise.resolve().then(() => count))",
            "FICT-R005",
        ),
        (
            "1",
            "",
            "untrack(async () => { await ready(); consume(count) })",
            "FICT-S002",
        ),
    ] {
        let source = format!(
            "import {{ $state, untrack }} from 'fict';
             import {{ consume, ready, input }} from 'external';
             export function Counter() {{
               let count = $state({initial}); {setup} {expression}; return <div/>;
             }}"
        );
        let result = compile(request(&source));
        assert!(result.has_errors(), "{source}: {}", result.code);
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == code),
            "{source}: {:?}",
            result.diagnostics,
        );
    }
}

#[test]
fn unrelated_or_shadowed_untrack_does_not_grant_snapshot_permissions() {
    for source in [
        "import {$state} from 'fict'; import {untrack, consume} from 'external';
         export function Counter() { let count = $state(1);
           untrack(() => consume(count)); return <div/>; }",
        "import {$state, untrack} from 'fict'; import {consume} from 'external';
         export function Counter(untrack) { let count = $state(1);
           untrack(() => consume(count)); return <div/>; }",
        "import {$state, untrack} from 'fict'; import {consume} from 'external';
         export function useCounter() { let count = $state(1);
           untrack(() => consume(count)); return {count}; }",
    ] {
        let result = compile(request(source));
        assert!(result.has_errors(), "{source}: {}", result.code);
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == "FICT-S002"),
            "{:?}",
            result.diagnostics
        );
    }
}
