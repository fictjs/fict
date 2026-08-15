#![no_main]

use std::fmt::Write as _;

use fict_compiler::{
    COMPILER_PROTOCOL_VERSION, CompileRequest, CompileResult, CompilerOptions, ModuleKind,
    ScanRequest, SourceLanguage, compile, scan,
};
use fict_diagnostics::{DiagnosticSeverity, GuaranteeClass};
use libfuzzer_sys::fuzz_target;

const MAX_INPUT_BYTES: usize = 256;
const SCENARIO_COUNT: u8 = 40;

#[derive(Clone, Copy)]
enum Expectation {
    Diagnostic(&'static str),
    Clean,
    PolicyOnly,
}

struct GeneratedCase {
    label: &'static str,
    source: String,
    language: SourceLanguage,
    expectation: Expectation,
}

fuzz_target!(|data: &[u8]| {
    if data.len() < 6 || data.len() > MAX_INPUT_BYTES {
        return;
    }
    let generated = generate_case(data);
    let strict_request = request(&generated, true);
    let fallback_request = request(&generated, false);
    let strict = compile(strict_request.clone());
    let fallback = compile(fallback_request.clone());

    assert_deterministic(&strict_request, &strict, generated.label);
    assert_deterministic(&fallback_request, &fallback, generated.label);
    assert_no_internal(&strict, generated.label);
    assert_no_internal(&fallback, generated.label);
    assert_strict_fallback_symmetry(&strict, &fallback, generated.label);

    match generated.expectation {
        Expectation::Diagnostic(code) => {
            assert!(
                has_diagnostic(&strict, code, DiagnosticSeverity::Error),
                "{}: strict mode lost expected {code}: {:?}\n{}",
                generated.label,
                strict.diagnostics,
                generated.source
            );
            assert!(strict.has_errors(), "{}: strict mode must reject", generated.label);
            assert!(strict.code.is_empty(), "{}: strict mode emitted code", generated.label);
            assert!(
                has_diagnostic(&fallback, code, DiagnosticSeverity::Warning),
                "{}: fallback mode lost expected {code}: {:?}\n{}",
                generated.label,
                fallback.diagnostics,
                generated.source
            );
            assert!(
                !fallback.has_errors(),
                "{}: fallback mode rejected: {:?}\n{}",
                generated.label,
                fallback.diagnostics,
                generated.source
            );
            assert!(!fallback.code.is_empty(), "{}: fallback emitted no code", generated.label);
        }
        Expectation::Clean => {
            for result in [&strict, &fallback] {
                assert!(
                    !result.has_errors(),
                    "{}: safe provenance case rejected: {:?}\n{}",
                    generated.label,
                    result.diagnostics,
                    generated.source
                );
                assert!(
                    result.diagnostics.iter().all(|diagnostic| !matches!(
                        diagnostic.code.as_str(),
                        "FICT-M" | "FICT-R002" | "FICT-R-ALIAS-WRITE"
                    )),
                    "{}: safe provenance case diagnosed: {:?}\n{}",
                    generated.label,
                    result.diagnostics,
                    generated.source
                );
            }
        }
        Expectation::PolicyOnly => {}
    }

    validate_output(&strict, generated.label);
    validate_output(&fallback, generated.label);
});

fn generate_case(data: &[u8]) -> GeneratedCase {
    let scenario = data[0] % SCENARIO_COUNT;
    let projected = projection(data[1]);
    let other_projection = projection(data[1].wrapping_add(1));
    let alias_depth = usize::from(data[2] % 4) + 1;
    let write_kind = data[3] % 4;
    let type_style = data[4] % 4;
    let variant = data[5];
    let (state_declaration, language) = state_declaration(type_style);
    let mut body = String::new();
    let (label, expectation) = match scenario {
        0 => {
            append_alias_write(&mut body, &projected, alias_depth, write_kind);
            ("projection-alias", Expectation::Diagnostic("FICT-M"))
        }
        1 => {
            append_alias_write(
                &mut body,
                &format!("flag ? {projected} : {other_projection}"),
                alias_depth,
                write_kind,
            );
            ("conditional", Expectation::Diagnostic("FICT-M"))
        }
        2 => {
            append_alias_write(
                &mut body,
                &format!("flag && {projected}"),
                alias_depth,
                write_kind,
            );
            ("logical", Expectation::Diagnostic("FICT-M"))
        }
        3 => {
            append_alias_write(
                &mut body,
                &format!("(flag, {projected})"),
                alias_depth,
                write_kind,
            );
            ("sequence", Expectation::Diagnostic("FICT-M"))
        }
        4 => {
            match variant % 5 {
                0 => body.push_str("const [item] = state;\n"),
                1 => body.push_str("const { 0: item } = state;\n"),
                2 => body.push_str("let item; [item] = state;\n"),
                3 => body.push_str("const [item = { done: false }] = state;\n"),
                _ => body.push_str("const [, ...rest] = state; const item = rest.at(0);\n"),
            }
            append_existing_alias_write(&mut body, "item", alias_depth, write_kind);
            ("destructuring", Expectation::Diagnostic("FICT-M"))
        }
        5 => {
            let alternate = if variant & 1 == 0 {
                other_projection.as_str()
            } else {
                "{ done: false }"
            };
            writeln!(
                body,
                "let item; if (flag) {{ item = {projected}; }} else {{ item = {alternate}; }}"
            )
            .unwrap();
            append_existing_alias_write(&mut body, "item", alias_depth, write_kind);
            ("branch-merge", Expectation::Diagnostic("FICT-M"))
        }
        6 => {
            body.push_str("for (const item of state) {\n");
            append_existing_alias_write(&mut body, "item", alias_depth, write_kind);
            body.push_str("}\n");
            ("enumeration-loop", Expectation::Diagnostic("FICT-M"))
        }
        7 => {
            writeln!(
                body,
                "let item; switch (flag) {{ case true: item = {projected}; break; default: item = {other_projection}; }}"
            )
            .unwrap();
            append_existing_alias_write(&mut body, "item", alias_depth, write_kind);
            ("switch-merge", Expectation::Diagnostic("FICT-M"))
        }
        8 => {
            writeln!(
                body,
                "let item; try {{ if (flag) throw 1; item = {projected}; }} catch {{ item = {other_projection}; }} finally {{ state.length; }}"
            )
            .unwrap();
            append_existing_alias_write(&mut body, "item", alias_depth, write_kind);
            ("exception-merge", Expectation::Diagnostic("FICT-M"))
        }
        9 => {
            let method = ["forEach", "map", "filter", "find"][usize::from(variant % 4)];
            writeln!(body, "state.{method}(item => {{").unwrap();
            append_existing_alias_write(&mut body, "item", alias_depth, write_kind);
            body.push_str("return true; });\n");
            ("callback-parameter", Expectation::Diagnostic("FICT-M"))
        }
        10 => {
            body.push_str("state.map(item => () => {\n");
            append_existing_alias_write(&mut body, "item", alias_depth, write_kind);
            body.push_str("})[0]();\n");
            ("nested-callback-capture", Expectation::Diagnostic("FICT-M"))
        }
        11 => {
            append_alias_write(
                &mut body,
                "state.map(item => item).at(0)",
                alias_depth,
                write_kind,
            );
            ("method-chain-result", Expectation::Diagnostic("FICT-M"))
        }
        12 => {
            let method = ["map", "filter", "forEach", "find"][usize::from(variant % 4)];
            writeln!(body, "state.{method}(item => consume(item));").unwrap();
            ("callback-escape", Expectation::Diagnostic("FICT-R002"))
        }
        13 => {
            match variant % 3 {
                0 => {
                    writeln!(
                        body,
                        "class Box {{ item = {projected}; mutate() {{ if (this.item) this.item.done = true; }} }} const box = new Box(); box.mutate();"
                    )
                    .unwrap();
                }
                1 => {
                    writeln!(
                        body,
                        "class Box {{ static item = {projected}; static mutate() {{ if (Box.item) Box.item.done = true; }} }} Box.mutate();"
                    )
                    .unwrap();
                }
                _ => {
                    writeln!(
                        body,
                        "const key = 'item'; class Box {{ [key] = {projected}; mutate() {{ if (this[key]) this[key].done = true; }} }} const box = new Box(); box.mutate();"
                    )
                    .unwrap();
                }
            }
            ("state-derived-class-field", Expectation::Diagnostic("FICT-R002"))
        }
        14 => {
            body.push_str("return state.map(item => { const alias = item; return alias.done; }).join(',');\n");
            ("safe-callback-read", Expectation::Clean)
        }
        15 => {
            let method = if variant & 1 == 0 { ".map" } else { "['map']" };
            writeln!(
                body,
                "return state{method}(item => item.done).filter(Boolean).join(',');"
            )
            .unwrap();
            ("safe-array-chain", Expectation::Clean)
        }
        16 => {
            body.push_str("state = [{ done: true }]; return state.map(item => item.done).join(',');\n");
            ("safe-same-family-replacement", Expectation::Clean)
        }
        17 => {
            body.push_str("const method = flag ? 'at' : 'find'; const item = state[method](0); return item;\n");
            ("computed-method-policy", Expectation::PolicyOnly)
        }
        18 => {
            writeln!(body, "const item = {projected}; const mutate = () => {{").unwrap();
            append_existing_alias_write(&mut body, "item", alias_depth, write_kind);
            body.push_str("}; mutate();\n");
            ("closure-mutation", Expectation::Diagnostic("FICT-M"))
        }
        19 => {
            body.push_str("const suspect = flag ? [{ done: false }] : (({}) as Array<{ done: boolean }>); let typed = $state<Array<{ done: boolean }>>(suspect); const item = typed.at(0); if (item) item.done = true;\n");
            ("typescript-assertion", Expectation::Diagnostic("FICT-M"))
        }
        20 => {
            body.push_str("let mapped = $state(new Map([['key', { done: false }]])); const item = mapped.get('key'); if (item) item.done = true;\n");
            ("map-receiver", Expectation::Diagnostic("FICT-M"))
        }
        21 => {
            body.push_str("let selected = $state(new Set([{ done: false }])); for (const item of selected) item.done = true;\n");
            ("set-enumeration", Expectation::Diagnostic("FICT-M"))
        }
        22 => {
            body.push_str("state.map((_item, _index, source) => { source.push({ done: true }); return false; });\n");
            ("callback-receiver", Expectation::Diagnostic("FICT-M"))
        }
        23 => {
            body.push_str("let mapped = $state(new Map([[{ done: false }, 1]])); mapped.forEach((_value, key) => { key.done = true; });\n");
            ("map-key-parameter", Expectation::Diagnostic("FICT-M"))
        }
        24 => {
            body.push_str("return state.map((_item, index) => consume(index)).join(',');\n");
            ("safe-callback-index", Expectation::Clean)
        }
        25 => {
            body.push_str("return state.map((item, index) => consume(item.done ? index : index + 1)).join(',');\n");
            ("safe-callback-scalar", Expectation::Clean)
        }
        26 => {
            body.push_str("return state.reduce(accumulator => consume(accumulator));\n");
            ("reduce-implicit-accumulator", Expectation::Diagnostic("FICT-R002"))
        }
        27 => {
            body.push_str("return state.reduce(accumulator => consume(accumulator), state.at(0));\n");
            ("reduce-state-accumulator", Expectation::Diagnostic("FICT-R002"))
        }
        28 => {
            body.push_str("return state.reduce(accumulator => { consume(accumulator); return accumulator; }, 0);\n");
            ("safe-reduce-accumulator", Expectation::Clean)
        }
        29 => {
            body.push_str("const typed = $state(new Uint8Array([1, 2])); return typed.map(value => consume(value)).join(',');\n");
            ("safe-typed-array-value", Expectation::Clean)
        }
        30 => {
            body.push_str("const mutate = item => { item.done = true; }; const alias = mutate; state.forEach(alias);\n");
            ("callback-local-alias", Expectation::Diagnostic("FICT-M"))
        }
        31 => {
            body.push_str("const first = item => { item.done = true; }; const alias = first; const second = item => { item.done = true; }; state.forEach(flag ? alias : second);\n");
            ("callback-conditional-alias", Expectation::Diagnostic("FICT-M"))
        }
        32 => {
            body.push_str("state.forEach(callback);\n");
            ("unknown-callback-boundary", Expectation::Diagnostic("FICT-R002"))
        }
        33 => {
            body.push_str("const read = item => item.done; const alias = read; return state.map(alias).join(',');\n");
            ("safe-callback-read-alias", Expectation::Clean)
        }
        34 => {
            body.push_str("state = new Map([['item', { done: false }]]); const item = state.get('item'); if (item) item.done = true;\n");
            ("cross-family-replacement", Expectation::Diagnostic("FICT-M"))
        }
        35 => {
            body.push_str("const bases = $state([class Base {}]); class Child extends bases.at(0) {} void Child;\n");
            ("state-derived-class-base", Expectation::Diagnostic("FICT-R002"))
        }
        36 => {
            body.push_str("const keys = $state(['run']); class Box { [keys.at(0)]() { return 1; } } return new Box().run();\n");
            ("safe-computed-method-name", Expectation::Clean)
        }
        37 => {
            body.push_str("let container = [state.at(0)]; const item = container.at(0); item.done = true;\n");
            ("contained-array-item", Expectation::Diagnostic("FICT-M"))
        }
        38 => {
            body.push_str("let container = [state.at(0)]; container.push({ done: true }); return container.length;\n");
            ("safe-fresh-container-mutation", Expectation::Clean)
        }
        _ => {
            body.push_str("let item = state.at(0); item = { done: false }; item.done = true; return item.done;\n");
            ("safe-reassignment-forgets-provenance", Expectation::Clean)
        }
    };

    let source = format!(
        "import {{ $state }} from 'fict';\nfunction consume(value) {{ return value; }}\nexport function useProbe(flag = true, callback) {{\n{state_declaration}\n{body}\nreturn state[0]?.done;\n}}\n"
    );
    GeneratedCase {
        label,
        source,
        language: if scenario >= 19 {
            SourceLanguage::TypeScript
        } else {
            language
        },
        expectation,
    }
}

fn state_declaration(style: u8) -> (String, SourceLanguage) {
    let values = "[{ done: false }, { done: false }]";
    match style {
        0 => (format!("let state = $state({values});"), SourceLanguage::JavaScript),
        1 => (
            format!("let state = $state<Array<{{ done: boolean }}>>({values});"),
            SourceLanguage::TypeScript,
        ),
        2 => (
            format!("let state = $state(({values}) as Array<{{ done: boolean }}>);"),
            SourceLanguage::TypeScript,
        ),
        _ => (
            format!(
                "let state: Array<{{ done: boolean }}> = $state<Array<{{ done: boolean }}>>(({values}) as Array<{{ done: boolean }}>);"
            ),
            SourceLanguage::TypeScript,
        ),
    }
}

fn projection(selector: u8) -> String {
    match selector % 6 {
        0 => "state.at(0)".into(),
        1 => "state['at'](0)".into(),
        2 => "state?.at(0)".into(),
        3 => "state.at?.(0)".into(),
        4 => "state[0]".into(),
        _ => "state?.[0]".into(),
    }
}

fn append_alias_write(body: &mut String, expression: &str, depth: usize, write_kind: u8) {
    writeln!(body, "const item0 = {expression};").unwrap();
    append_existing_alias_write(body, "item0", depth, write_kind);
}

fn append_existing_alias_write(body: &mut String, source: &str, depth: usize, write_kind: u8) {
    let mut target = source.to_owned();
    for index in 0..depth {
        let next = format!("alias{index}");
        writeln!(body, "const {next} = {target};").unwrap();
        target = next;
    }
    let write = match write_kind {
        0 => format!("{target}.done = true"),
        1 => format!("{target}['done'] = true"),
        2 => format!("{target}.done++"),
        _ => format!("delete {target}.done"),
    };
    writeln!(body, "if ({target}) {{ {write}; }}").unwrap();
}

fn request(generated: &GeneratedCase, strict_guarantee: bool) -> CompileRequest {
    let extension = match generated.language {
        SourceLanguage::JavaScript => "js",
        SourceLanguage::TypeScript => "ts",
        SourceLanguage::JavaScriptJsx => "jsx",
        SourceLanguage::TypeScriptJsx => "tsx",
    };
    CompileRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: generated.source.clone(),
        filename: format!("/fuzz/state-provenance-{}.{}", generated.label, extension),
        module_id: Some(format!("/fuzz/state-provenance/{}", generated.label)),
        public_module_id: None,
        language: Some(generated.language),
        module_kind: Some(ModuleKind::Module),
        input_source_map: None,
        options: CompilerOptions {
            strict_guarantee,
            ..CompilerOptions::default()
        },
        metadata: Vec::new(),
        integration_diagnostics: Vec::new(),
        limits: Default::default(),
    }
}

fn has_diagnostic(result: &CompileResult, code: &str, severity: DiagnosticSeverity) -> bool {
    result.diagnostics.iter().any(|diagnostic| {
        diagnostic.code.as_str() == code
            && diagnostic.severity == severity
            && diagnostic.guarantee_class == GuaranteeClass::Fallback
    })
}

fn assert_no_internal(result: &CompileResult, label: &str) {
    assert!(
        result
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.guarantee_class != GuaranteeClass::Internal),
        "{label}: internal diagnostic: {:?}",
        result.diagnostics
    );
}

fn assert_strict_fallback_symmetry(strict: &CompileResult, fallback: &CompileResult, label: &str) {
    for diagnostic in &strict.diagnostics {
        if diagnostic.guarantee_class != GuaranteeClass::Fallback {
            continue;
        }
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Error, "{label}");
        assert!(fallback.diagnostics.iter().any(|candidate| {
            candidate.code == diagnostic.code
                && candidate.guarantee_class == GuaranteeClass::Fallback
                && candidate.severity == DiagnosticSeverity::Warning
        }), "{label}: fallback lost strict diagnostic {}", diagnostic.code);
    }
    for diagnostic in &fallback.diagnostics {
        if diagnostic.guarantee_class != GuaranteeClass::Fallback {
            continue;
        }
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Warning, "{label}");
        let visible_in_strict = strict.diagnostics.iter().any(|candidate| {
            candidate.code == diagnostic.code
                && candidate.guarantee_class == GuaranteeClass::Fallback
                && candidate.severity == DiagnosticSeverity::Error
        });
        // Strict mode may stop after a frontend fallback-class error, while fallback mode keeps
        // lowering and discovers additional core diagnostics. Those downstream-only warnings are
        // valid only when strict mode already failed closed for another fallback-class reason.
        assert!(
            visible_in_strict
                || strict.diagnostics.iter().any(|candidate| {
                    candidate.guarantee_class == GuaranteeClass::Fallback
                        && candidate.severity == DiagnosticSeverity::Error
                }),
            "{label}: strict mode lost fallback diagnostic {} without failing closed earlier",
            diagnostic.code
        );
    }
}

fn assert_deterministic(request: &CompileRequest, first: &CompileResult, label: &str) {
    let second = compile(request.clone());
    assert_eq!(first.code, second.code, "{label}: nondeterministic code");
    assert_eq!(first.map, second.map, "{label}: nondeterministic source map");
    assert_eq!(first.artifacts, second.artifacts, "{label}: nondeterministic artifacts");
    assert_eq!(
        first.diagnostics, second.diagnostics,
        "{label}: nondeterministic diagnostics"
    );
}

fn validate_output(result: &CompileResult, label: &str) {
    if result.has_errors() {
        assert!(result.code.is_empty(), "{label}: errors emitted code");
        return;
    }
    assert!(!result.code.is_empty(), "{label}: successful compile emitted no code");
    let reparsed = scan(ScanRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: result.code.clone(),
        filename: format!("/fuzz/state-provenance-output-{label}.js"),
        module_id: None,
        language: Some(SourceLanguage::JavaScript),
        module_kind: Some(ModuleKind::Module),
        limits: Default::default(),
    });
    assert!(
        !reparsed.has_errors(),
        "{label}: generated output did not reparse: {:?}",
        reparsed.diagnostics
    );
    assert!(
        reparsed
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.guarantee_class != GuaranteeClass::Internal),
        "{label}: reparsing produced an internal diagnostic: {:?}",
        reparsed.diagnostics
    );
}
