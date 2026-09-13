use fict_compiler::{COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions, compile};

fn request(imports: &str, setup: &str, expression: &str) -> CompileRequest {
    CompileRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: format!(
            "import {{$state}} from 'fict'; {imports};
             export function Counter(props) {{
               let count = $state(1); {setup}
               const selected = {expression};
               return <button onClick={{() => count++}}>{{selected(1) ? 'yes' : 'no'}}</button>;
             }}"
        ),
        filename: "runtime-callbacks.tsx".into(),
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
fn selector_sources_follow_intact_runtime_imports_and_aliases() {
    for (imports, setup, expression) in [
        (
            "import {createSelector} from 'fict'",
            "",
            "createSelector(() => count)",
        ),
        (
            "import {createSelector as select} from 'fict'",
            "",
            "select(() => count)",
        ),
        (
            "import {createSelector} from 'fict'",
            "const select = createSelector;",
            "select(() => count)",
        ),
        (
            "import * as runtime from 'fict'",
            "",
            "runtime.createSelector(() => count)",
        ),
        (
            "import * as runtime from 'fict/advanced'",
            "const select = runtime.createSelector;",
            "select(() => count)",
        ),
        (
            "import {createSelector} from 'fict'",
            "const source = () => count;",
            "createSelector(source, (key, value) => key === value)",
        ),
        (
            "import {createSelector} from 'fict'",
            "",
            "createSelector(function () { return count })",
        ),
    ] {
        let result = compile(request(imports, setup, expression));
        assert!(
            !result.has_errors(),
            "{imports} {setup} {expression}: {:?}",
            result.diagnostics
        );
        assert!(
            !result.code.contains("const selected = __fictUseMemo"),
            "{}",
            result.code
        );
    }
}

#[test]
fn selector_contract_does_not_cover_unknown_or_deferred_callbacks() {
    for (imports, setup, expression) in [
        (
            "import {createSelector} from 'external'",
            "",
            "createSelector(() => count)",
        ),
        (
            "import {createSelector} from 'fict'",
            "const select = props.select;",
            "select(() => count)",
        ),
        (
            "import {createSelector} from 'fict'",
            "let select = createSelector; select = props.select;",
            "select(() => count)",
        ),
        (
            "import {createSelector} from 'fict'",
            "const api = {createSelector}; api.createSelector = props.select;",
            "api.createSelector(() => count)",
        ),
        (
            "import {createSelector} from 'fict'",
            "",
            "createSelector(async () => { await Promise.resolve(); return count })",
        ),
        (
            "import {createSelector} from 'fict'",
            "",
            "createSelector(function* () { yield count })",
        ),
        (
            "import {createSelector} from 'fict'",
            "",
            "createSelector(() => { setTimeout(() => count); return count })",
        ),
        (
            "import {createSelector} from 'fict'",
            "",
            "createSelector(() => count, (key, value) => key === value + count)",
        ),
    ] {
        let result = compile(request(imports, setup, expression));
        assert!(
            result.has_errors(),
            "{imports} {setup} {expression}: {}",
            result.code
        );
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| matches!(diagnostic.code.as_str(), "FICT-R002" | "FICT-R005")),
            "{:?}",
            result.diagnostics
        );
    }
}

#[test]
fn external_runtime_names_do_not_allow_implicit_state_snapshots() {
    for host in ["createSelector", "createMemo", "createEffect", "render"] {
        let result = compile(request(
            &format!("import {{{host}}} from 'external'"),
            "",
            &format!("{host}(count)"),
        ));
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == "FICT-S002"),
            "{host}: {:?}",
            result.diagnostics
        );
        assert!(result.code.is_empty());
    }
}

#[test]
fn snapshot_aliases_preserve_the_explicit_boundary_contract() {
    for (imports, setup, expression) in [
        (
            "import {untrack} from 'fict'",
            "const snapshot = untrack;",
            "snapshot(() => count)",
        ),
        (
            "import * as runtime from 'fict'",
            "",
            "runtime.untrack(() => count)",
        ),
        (
            "import * as runtime from 'fict'",
            "const snapshot = runtime.untrack;",
            "snapshot(() => count)",
        ),
    ] {
        let input = request(imports, setup, &format!("props.consume({expression})"));
        let result = compile(input);
        assert!(
            !result.has_errors(),
            "{expression}: {:?}",
            result.diagnostics
        );
    }
}

#[test]
fn synchronous_runtime_hosts_do_not_own_reactive_async_continuations() {
    for host in ["untrack", "batch", "startTransition", "createEffect"] {
        let result = compile(request(
            &format!("import {{{host}}} from 'fict'"),
            "",
            &format!("{host}(async () => {{ await Promise.resolve(); return count }})"),
        ));
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == "FICT-R005"),
            "{host}: {:?}",
            result.diagnostics
        );
        assert!(result.code.is_empty());
    }
    let result = compile(request(
        "import {untrack} from 'fict'",
        "const captured = untrack(() => count);",
        "Promise.resolve().then(async () => { await Promise.resolve(); return captured })",
    ));
    assert!(!result.has_errors(), "{:?}", result.diagnostics);

    for expression in [
        "Promise.resolve().then(() => [captured, count])",
        "createSelector(() => count, count)",
    ] {
        let result = compile(request(
            "import {untrack, createSelector} from 'fict'",
            "const captured = untrack(() => count);",
            expression,
        ));
        assert!(result.has_errors(), "{expression}: {}", result.code);
    }
}
