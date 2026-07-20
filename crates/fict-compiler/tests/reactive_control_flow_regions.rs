use fict_compiler::{COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions, compile};

fn compile_source(source: &str, optimize: bool) -> fict_compiler::CompileResult {
    compile_source_with_strict(source, optimize, false)
}

fn compile_source_with_strict(
    source: &str,
    optimize: bool,
    strict_guarantee: bool,
) -> fict_compiler::CompileResult {
    compile(CompileRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: source.into(),
        filename: "reactive-control-flow-region.tsx".into(),
        module_id: None,
        public_module_id: None,
        language: None,
        module_kind: None,
        input_source_map: None,
        options: CompilerOptions {
            optimize,
            strict_guarantee,
            ..CompilerOptions::default()
        },
        metadata: Vec::new(),
        integration_diagnostics: Vec::new(),
    })
}

#[test]
fn lowers_reactive_hook_do_while_outputs_into_a_live_region() {
    let source = r#"
        import { $state } from 'fict'

        export function useRun() {
            let n = $state(2)
            let out = ''
            let i = 0

            do {
                out += i
                i++
                if (i === 1) {
                    continue
                }
            } while (i < n)

            return {
                set: (next: number) => {
                    n = next
                },
                view: () => out,
            }
        }
    "#;

    for strict_guarantee in [false, true] {
        for optimize in [false, true] {
            let result = compile_source_with_strict(source, optimize, strict_guarantee);
            assert!(!result.has_errors(), "{:#?}", result.diagnostics);
            assert!(result.diagnostics.is_empty(), "{:#?}", result.diagnostics);
            assert!(result.code.contains("__fictUseMemo"), "{}", result.code);
            assert!(result.code.contains("do {"), "{}", result.code);
            assert!(result.code.contains("\n\t\t\tout,"), "{}", result.code);
            assert!(
                result.code.contains("view: () => __fict_region().out"),
                "{}",
                result.code
            );
        }
    }
}

#[test]
fn lowers_reactive_hook_conditionals_switches_and_loop_forms() {
    let sources = [
        r#"
            import { $state } from 'fict'
            export function useRun() {
                let enabled = $state(false)
                let out = 'off'
                if (enabled) out = 'on'
                return { set: value => { enabled = value }, view: () => out }
            }
        "#,
        r#"
            import { $state } from 'fict'
            export function useRun() {
                let mode = $state(0)
                let out = 'zero'
                switch (mode) {
                    case 1: out = 'one'; break
                    default: out = 'many'
                }
                return { set: value => { mode = value }, view: () => out }
            }
        "#,
        r#"
            import { $state } from 'fict'
            export function useRun() {
                let count = $state(2)
                let out = ''
                let index = 0
                while (index < count) out += index++
                return { set: value => { count = value }, view: () => out }
            }
        "#,
        r#"
            import { $state } from 'fict'
            export function useRun() {
                let count = $state(2)
                let out = ''
                for (let index = 0; index < count; index++) out += index
                return { set: value => { count = value }, view: () => out }
            }
        "#,
        r#"
            import { $state } from 'fict'
            export function useRun() {
                let values = $state([1, 2])
                let out = 0
                for (const value of values) out += value
                return { set: value => { values = value }, view: () => out }
            }
        "#,
        r#"
            import { $state } from 'fict'
            export function useRun() {
                let mode = $state(0)
                let out = ''
                const source = mode === 0 ? { a: 2 } : { a: 2, b: 3 }
                for (const key in source) out += key
                return { set: value => { mode = value }, view: () => out }
            }
        "#,
        r#"
            import { $state } from 'fict'
            export function useRun() {
                let count = $state(2)
                let out = ''
                let index = 0
                outer: while (index < count) {
                    out += index++
                    if (index === 1) continue outer
                }
                return { set: value => { count = value }, view: () => out }
            }
        "#,
    ];

    for source in sources {
        for optimize in [false, true] {
            let result = compile_source(source, optimize);
            assert!(!result.has_errors(), "{:#?}", result.diagnostics);
            assert!(result.code.contains("__fictUseMemo"), "{}", result.code);
            assert!(
                result.code.contains("view: () => __fict_region().out"),
                "{}",
                result.code
            );
            if source.contains("outer:") {
                assert!(result.code.contains("outer: while"), "{}", result.code);
            }
        }
    }
}

#[test]
fn does_not_move_function_exits_into_hook_or_loop_memo_callbacks() {
    let sources = [
        r#"
            import { $state } from 'fict'
            export function useRun() {
                let count = $state(2)
                let out = ''
                while (count > 0) {
                    out += count
                    return out
                }
                return out
            }
        "#,
        r#"
            import { $state } from 'fict'
            export function useRun() {
                let enabled = $state(false)
                let out = 'off'
                if (enabled) {
                    out = 'on'
                    return { view: () => out }
                }
                return { set: value => { enabled = value }, view: () => out }
            }
        "#,
    ];

    for source in sources {
        let result = compile_source(source, true);
        assert!(!result.has_errors(), "{:#?}", result.diagnostics);
        assert!(!result.code.contains("__fictUseMemo"), "{}", result.code);
        assert!(result.code.contains("return "), "{}", result.code);
    }
}

#[test]
fn preserves_adjacent_output_initializers_when_lowering_regions() {
    let sources = [
        r#"
            import { $state } from 'fict'
            function useCounter() {
                const count = $state(0)
                return { count }
            }
            export function App({ flag }: { flag: boolean }) {
                let state = useCounter()
                if (flag) state = { count: 1 }
                return <span>{state.count}</span>
            }
        "#,
        r#"
            import { $state } from 'fict'
            export function useProbe() {
                let flag = $state(false)
                let missing
                let explicit = void 0
                if (flag) {
                    missing = 'yes'
                    explicit = 'yes'
                }
                return String(missing) + String(explicit)
            }
        "#,
    ];

    for source in sources {
        let result = compile_source(source, true);
        assert!(!result.has_errors(), "{:#?}", result.diagnostics);
        assert!(result.code.contains("__fictUseMemo"), "{}", result.code);
    }
}
