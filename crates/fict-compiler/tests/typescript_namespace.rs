use fict_compiler::{COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions, compile};
use fict_metadata::{MetadataResolutionStatus, ReactiveExportKind, ResolvedMetadataInput};

fn request(code: &str, filename: &str) -> CompileRequest {
    CompileRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: code.into(),
        filename: filename.into(),
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
fn lowers_merged_mutable_namespaces_and_publishes_nested_metadata() {
    let result = compile(request(
        r#"
            import { createSignal, createMemo, createStore } from 'fict';
            export namespace State {
                export type Shape = { value: number };
                export let plain = 1;
                export const count = createSignal(0);
                export function increment() { plain++; }
                export function useCount() { return count; }
                export namespace Nested {
                    export const store = createStore({ value: 1 });
                    export function useStore() { return store; }
                }
            }
            export namespace State {
                export const doubled = createMemo(() => count() * 2);
                export const snapshot = plain;
            }
        "#,
        "namespace.ts",
    ));

    assert!(!result.has_errors(), "{:?}", result.diagnostics);
    assert!(result.code.contains("State.plain++"), "{}", result.code);
    assert!(result.code.contains("State.count"), "{}", result.code);
    assert!(!result.code.contains("snapshot = plain"), "{}", result.code);

    let state = result
        .module_metadata
        .namespaces
        .get("State")
        .expect("State namespace metadata");
    assert_eq!(
        state.exports.get("count"),
        Some(&ReactiveExportKind::Signal)
    );
    assert_eq!(
        state.exports.get("doubled"),
        Some(&ReactiveExportKind::Memo)
    );
    assert_eq!(
        state
            .hooks
            .get("useCount")
            .and_then(|hook| hook.direct_accessor),
        Some(ReactiveExportKind::Signal)
    );
    let nested = state.namespaces.get("Nested").expect("nested metadata");
    assert_eq!(
        nested.exports.get("store"),
        Some(&ReactiveExportKind::Store)
    );
    assert_eq!(
        nested
            .hooks
            .get("useStore")
            .and_then(|hook| hook.direct_accessor),
        Some(ReactiveExportKind::Store)
    );
}

#[test]
fn consumes_generated_namespace_reactive_and_hook_metadata() {
    let producer = compile(request(
        "import { createSignal } from 'fict'; export namespace State { export const count = createSignal(0); export function useCount() { return count; } }",
        "producer.ts",
    ));
    assert!(!producer.has_errors(), "{:?}", producer.diagnostics);

    let mut consumer = request(
        "import { State } from './producer'; export function App() { const count = State.useCount(); return <p>{State.count + count}</p>; }",
        "consumer.tsx",
    );
    consumer.metadata.push(ResolvedMetadataInput {
        request: "./producer".into(),
        resolved_id: Some("/producer.ts".into()),
        status: MetadataResolutionStatus::Resolved,
        metadata: Some(producer.module_metadata),
        fingerprint: "sha256:typescript-namespace".into(),
    });
    let result = compile(consumer);

    assert!(!result.has_errors(), "{:?}", result.diagnostics);
    assert!(result.code.contains("State.count()"), "{}", result.code);
    assert!(result.code.contains("count()"), "{}", result.code);
}
