use fict_compiler::{
    COMPILER_PROTOCOL_VERSION, CompileRequest, CompileResult, CompilerOptions, ModuleKind, compile,
};
use oxc_sourcemap::{SourceMap, SourceViewToken};

struct MappedOutput {
    source: String,
    filename: String,
    result: CompileResult,
    map: SourceMap<'static>,
}

impl MappedOutput {
    fn compile(source: &str, filename: &str) -> Self {
        Self::compile_with_module(source, filename, None)
    }

    fn compile_with_module(source: &str, filename: &str, module_kind: Option<ModuleKind>) -> Self {
        let options = CompilerOptions {
            sourcemap: true,
            strict_guarantee: false,
            ..CompilerOptions::default()
        };
        let result = compile(CompileRequest {
            protocol_version: COMPILER_PROTOCOL_VERSION,
            code: source.to_owned(),
            filename: filename.to_owned(),
            module_id: None,
            public_module_id: None,
            language: None,
            module_kind,
            input_source_map: None,
            options,
            metadata: Vec::new(),
            integration_diagnostics: Vec::new(),
        });
        assert!(!result.has_errors(), "{:?}", result.diagnostics);
        let raw_map = result.map.as_ref().expect("requested source map");
        assert_eq!(raw_map.sources, [filename]);
        assert_eq!(
            raw_map.sources_content.as_ref(),
            Some(&vec![Some(source.to_owned())])
        );
        let json = serde_json::to_string(raw_map).expect("serializable source map");
        let map = SourceMap::from_json_string(&json)
            .expect("decodable source map")
            .into_owned();
        assert!(map.get_tokens().len() > 0);
        Self {
            source: source.to_owned(),
            filename: filename.to_owned(),
            result,
            map,
        }
    }

    fn assert_maps(
        &self,
        generated_needle: &str,
        generated_occurrence: usize,
        source_needle: &str,
        source_occurrence: usize,
    ) {
        let token = self
            .token(generated_needle, generated_occurrence)
            .unwrap_or_else(|| {
                panic!(
                    "{generated_needle:?} occurrence {generated_occurrence} has no mapping\n{}",
                    self.result.code
                )
            });
        let expected_index = nth_index(&self.source, source_needle, source_occurrence);
        let (expected_line, expected_column) = line_column(&self.source, expected_index);
        assert_eq!(token.get_source(), Some(self.filename.as_str()));
        assert_eq!(
            (token.get_src_line(), token.get_src_col()),
            (expected_line, expected_column),
            "generated {generated_needle:?} occurrence {generated_occurrence} did not map to source {source_needle:?} occurrence {source_occurrence}"
        );
    }

    fn assert_unmapped(&self, generated_needle: &str, occurrence: usize) {
        assert!(
            self.token(generated_needle, occurrence)
                .and_then(|token| token.get_source())
                .is_none(),
            "generated bookkeeping {generated_needle:?} occurrence {occurrence} unexpectedly points into authored source"
        );
    }

    fn token(&self, needle: &str, occurrence: usize) -> Option<SourceViewToken<'_, 'static>> {
        let index = nth_index(&self.result.code, needle, occurrence);
        let (line, column) = line_column(&self.result.code, index);
        let table = self.map.generate_lookup_table();
        self.map.lookup_source_view_token(&table, line, column)
    }
}

fn nth_index(text: &str, needle: &str, occurrence: usize) -> usize {
    assert!(!needle.is_empty());
    text.match_indices(needle)
        .nth(occurrence)
        .map(|(index, _)| index)
        .unwrap_or_else(|| panic!("missing {needle:?} occurrence {occurrence} in:\n{text}"))
}

fn line_column(text: &str, byte_index: usize) -> (u32, u32) {
    let prefix = &text[..byte_index];
    let line = u32::try_from(prefix.bytes().filter(|byte| *byte == b'\n').count())
        .expect("source line fits u32");
    let line_start = prefix.rfind('\n').map_or(0, |index| index + 1);
    let column =
        u32::try_from(prefix[line_start..].encode_utf16().count()).expect("source column fits u32");
    (line, column)
}

#[test]
fn maps_reactivity_props_events_and_control_flow_origins() {
    let source = concat!(
        "import { $state, $effect } from 'fict';\n",
        "function Child({ value, label = String(value), ...rest }) { return <button {...rest}>{label}:{value}</button>; }\n",
        "export function App() {\n",
        "  let count = $state(0);\n",
        "  $effect(() => { document.title = String(count); });\n",
        "  return <main title={count} onClick={() => count++}>{count > 0 ? <Child value={count} /> : <i>zero</i>}</main>;\n",
        "}",
    );
    let output = MappedOutput::compile(source, "origins.tsx");

    output.assert_maps("__fictUseSignal(__fictCtx, 0,", 0, "$state", 1);
    output.assert_maps("document.title", 0, "document.title", 0);
    output.assert_maps("const value = prop", 0, "value", 0);
    output.assert_maps("String(value())", 0, "String(value)", 0);
    output.assert_maps("value()", 1, "value", 2);
    output.assert_maps("__fict_previous + 1", 0, "count++", 0);
    output.assert_maps("count() > 0", 0, "count > 0", 0);
    output.assert_maps("props: { value: count() }", 0, "<Child value={count} />", 0);
    output.assert_maps("const __fictPropDefault", 0, "label", 0);
    output.assert_unmapped("createConditional", 0);
}

#[test]
fn maps_keyed_list_receivers_keys_render_reads_and_svg_bindings() {
    let source = concat!(
        "import { $state } from 'fict';\n",
        "export function Lists() {\n",
        "  let rows = $state([{ id: 1, value: 4 }]);\n",
        "  return <svg>{rows.map(row => <circle key={row.id} cx={row.value} />)}</svg>;\n",
        "}",
    );
    let output = MappedOutput::compile(source, "lists.tsx");

    output.assert_maps("rows()", 0, "rows.map", 0);
    output.assert_maps("row.id", 0, "row.id", 0);
    output.assert_maps("row().value", 0, "row.value", 0);
    output.assert_maps("createKeyedList", 1, "<svg>", 0);
    output.assert_maps("\"svg\"", 0, "<svg>", 0);
    output.assert_unmapped("createKeyedList", 0);
    output.assert_unmapped("const __fict_tmpl0", 0);
}

#[test]
fn maps_nested_keyed_table_lists_across_outer_and_inner_callbacks() {
    let source = concat!(
        "import { $state } from 'fict';\n",
        "export function Matrix() {\n",
        "  let groups = $state([{ id: 1, items: [{ id: 2, label: 'A' }] }]);\n",
        "  return <table><tbody>{groups.map(group => <tr key={group.id}><td>{group.items.map(item => <span key={item.id}>{item.label}</span>)}</td></tr>)}</tbody></table>;\n",
        "}",
    );
    let output = MappedOutput::compile(source, "nested-lists.tsx");

    output.assert_maps("groups()", 0, "groups.map", 0);
    output.assert_maps("group.id", 0, "group.id", 0);
    output.assert_maps("group().items", 0, "group.items", 0);
    output.assert_maps("item.id", 0, "item.id", 0);
    output.assert_maps("item().label", 0, "item.label", 0);
    output.assert_maps("\"html\"", 3, "<tr", 0);
    output.assert_maps("\"html\"", 5, "<table>", 0);
}

#[test]
fn maps_memos_runtime_primitives_and_async_handler_origins() {
    let source = concat!(
        "import { $state, $memo, $store, resource, createSelector } from 'fict';\n",
        "export function Model() {\n",
        "  let price = $state(2);\n",
        "  let quantity = $state(3);\n",
        "  const total = $memo(() => price * quantity);\n",
        "  const store = $store({ selected: 'a' });\n",
        "  const selected = createSelector(() => store.selected);\n",
        "  const data = resource(async (_ctx, id) => String(id));\n",
        "  return <button onClick={async () => { price++; await data.read('x'); }}>{total}:{selected('a') ? store.selected : data.read('y')}</button>;\n",
        "}",
    );
    let output = MappedOutput::compile(source, "runtime-origins.tsx");

    output.assert_maps("__fictUseMemo", 1, "$memo", 1);
    output.assert_maps("price() * quantity()", 0, "price * quantity", 0);
    output.assert_maps("total()", 0, "total", 1);
    output.assert_maps("$store({", 0, "$store({", 0);
    output.assert_maps("createSelector", 1, "createSelector", 1);
    output.assert_maps("resource(async", 0, "resource(async", 0);
    output.assert_maps("price(__fict_previous + 1)", 0, "price++", 0);
    output.assert_maps("await data.read", 0, "await data.read", 0);
    output.assert_maps("selected(\"a\")", 0, "selected('a')", 0);
    output.assert_maps("store.selected", 1, "store.selected", 1);
    output.assert_maps("data.read(\"y\")", 0, "data.read('y')", 0);
    output.assert_unmapped("__fictUseMemo", 0);
}

#[test]
fn maps_commonjs_rewrites_and_keeps_generated_preludes_unmapped() {
    let source = concat!(
        "import path from 'node:path';\n",
        "export const separator: string = path.sep;\n",
        "export function join(a: string, b: string) { return path.join(a, b); }",
    );
    let output = MappedOutput::compile_with_module(source, "entry.cts", Some(ModuleKind::CommonJs));

    output.assert_maps("__fict_cjs_import.default.sep", 0, "separator", 0);
    output.assert_maps("sep;", 0, "sep;", 0);
    output.assert_maps("join(a, b)", 1, "join(a, b)", 0);
    output.assert_maps("function join", 0, "function join", 0);
    output.assert_unmapped("const __fict_cjs_load", 0);
    output.assert_unmapped("Object.defineProperty(__fict_cjs_exports", 0);
}

#[test]
fn maps_reactive_writes_across_try_catch_and_finally() {
    let source = concat!(
        "import { $state } from 'fict';\n",
        "export function App(fail) {\n",
        "  let result = $state('init');\n",
        "  try { result = 'try'; if (fail) throw new Error('boom'); }\n",
        "  catch (error) { result = error.message; }\n",
        "  finally { result += '!'; }\n",
        "  return <span>{result}</span>;\n",
        "}",
    );
    let output = MappedOutput::compile(source, "try-origins.tsx");

    output.assert_maps("result(__fict_value)", 0, "result = 'try'", 0);
    output.assert_maps("result(__fict_value)", 1, "result = error.message", 0);
    output.assert_maps("result(__fict_value)", 2, "result += '!'", 0);
    output.assert_maps("result() + \"!\"", 0, "result += '!'", 0);
}

#[test]
fn preserves_utf16_columns_for_unicode_jsx_reads() {
    let source = concat!(
        "export function Emoji() {\n",
        "  const prefix = '😀'; const café = prefix + '雪';\n",
        "  return <p title={café}>{café}</p>;\n",
        "}",
    );
    let output = MappedOutput::compile(source, "unicode.tsx");

    output.assert_maps("const café", 0, "const café", 0);
    output.assert_maps("café", 1, "café", 1);
    output.assert_maps("café", 2, "café", 2);
}

#[test]
fn maps_erased_typescript_class_fields_and_multiline_jsx_origins() {
    let source = concat!(
        "export class Model {\n",
        "  declare erased: string;\n",
        "  value: number = 1;\n",
        "}\n",
        "export function View() {\n",
        "  const model = new Model();\n",
        "  return (\n",
        "    <section title={model.value}>\n",
        "      hello\n",
        "      <strong>{model.value}</strong>\n",
        "    </section>\n",
        "  );\n",
        "}",
    );
    let output = MappedOutput::compile(source, "class-fields-and-multiline-jsx.tsx");

    assert!(!output.result.code.contains("declare erased"));
    assert!(!output.result.code.contains(": number"));
    output.assert_maps("value = 1", 0, "value: number = 1", 0);
    output.assert_maps("model.value", 0, "model.value", 0);
    output.assert_maps("model.value", 1, "model.value", 1);
}
