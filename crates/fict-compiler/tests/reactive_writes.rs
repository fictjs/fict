use fict_compiler::{
    COMPILER_PROTOCOL_VERSION, CompileRequest, CompilerOptions, WarningLevel, compile,
};
use fict_diagnostics::{Diagnostic, DiagnosticSeverity, GuaranteeClass, SourceSpan};

fn compile_source_with_strict(
    source: &str,
    mut options: CompilerOptions,
    strict_guarantee: bool,
) -> fict_compiler::CompileResult {
    options.strict_guarantee = strict_guarantee;
    compile(CompileRequest {
        protocol_version: COMPILER_PROTOCOL_VERSION,
        code: source.into(),
        filename: "reactive-write.tsx".into(),
        module_id: None,
        public_module_id: None,
        language: None,
        module_kind: None,
        input_source_map: None,
        options,
        metadata: Vec::new(),
        integration_diagnostics: Vec::new(),
    })
}

fn compile_source(source: &str, options: CompilerOptions) -> fict_compiler::CompileResult {
    compile_source_with_strict(source, options, false)
}

fn find_error<'a>(result: &'a fict_compiler::CompileResult, code: &str) -> &'a Diagnostic {
    result
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code.as_str() == code)
        .unwrap_or_else(|| panic!("missing {code}: {:#?}", result.diagnostics))
}

fn assert_rejected(source: &str, code: &str) {
    for optimize in [false, true] {
        let result = compile_source(
            source,
            CompilerOptions {
                optimize,
                ..CompilerOptions::default()
            },
        );
        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code.as_str() == code)
            .unwrap_or_else(|| panic!("missing {code} for {source}: {:#?}", result.diagnostics));
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
        assert!(diagnostic.primary_span.is_some(), "{diagnostic:#?}");
        assert!(result.code.is_empty(), "{}", result.code);
    }
}

#[test]
fn rejects_alias_assignment_update_compound_capture_and_multihop_writes() {
    for source in [
        r#"
            import { $state } from 'fict'
            function App() {
                let count = $state(0)
                let alias = count
                alias = 1
                return alias
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App(flag) {
                let first = $state(0)
                let second = $state(1)
                let alias
                if (flag) {
                    alias = first
                } else {
                    alias = second
                }
                alias = 2
                return alias
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                let count = $state(0)
                let alias
                alias = count
                alias += 1
                return alias
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                let count = $state(0)
                let alias = count
                ++alias
                return alias
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                let count = $state(0)
                let alias = count
                function update() {
                    alias = 2
                }
                return update
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                let first = $state(0)
                let second = $state(1)
                let alias = first
                alias = second
                return alias
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                let first = $state(0)
                let second = $state(1)
                let alias
                alias = first
                alias = second
                return alias
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                let count = $state(0)
                let alias = count
                const update = () => alias++
                return update
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                const state = $state({ count: 0 })
                const alias = state
                const { count } = alias
                count++
                return count
            }
        "#,
    ] {
        assert_rejected(source, "FICT-R-ALIAS-WRITE");
    }
}

#[test]
fn rejects_derived_and_destructured_pattern_writes() {
    assert_rejected(
        r#"
            import { $state } from 'fict'
            function App() {
                const count = $state(0)
                const doubled = count * 2
                if (count > 0) {
                    doubled = 3
                }
                return doubled
            }
        "#,
        "FICT-R-DERIVED-WRITE",
    );

    for source in [
        r#"
            import { $state } from 'fict'
            function App() {
                const state = $state({ count: 0 })
                const { count } = state
                count++
                return count
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                const state = $state({ count: 0 })
                const { count } = state
                ;({ count } = { count: 2 })
                return count
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App(key) {
                const state = $state({ count: 0 })
                const { [key]: count } = state
                count -= 1
                return count
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                const state = $state({ nested: { values: [1] } })
                const { nested: { values: [first] } } = state
                first = 2
                return first
            }
        "#,
    ] {
        assert_rejected(source, "FICT-R-ALIAS-WRITE");
    }
}

#[test]
fn write_diagnostics_are_unsuppressible_and_use_exact_write_spans() {
    let source = r#"
        import { $state } from 'fict'
        function App() {
            let count = $state(0)
            let alias = count
            // fict-ignore FICT-R-ALIAS-WRITE
            alias++
            return alias
        }
    "#;
    let mut options = CompilerOptions::default();
    options
        .warning_levels
        .insert("FICT-R-ALIAS-WRITE".into(), WarningLevel::Off);
    let result = compile_source(source, options);
    let diagnostic = find_error(&result, "FICT-R-ALIAS-WRITE");
    let start = source.find("alias++").expect("write expression");
    assert_eq!(
        diagnostic.primary_span,
        SourceSpan::new(
            u32::try_from(start).expect("source offset"),
            u32::try_from(start + "alias++".len()).expect("source offset"),
        )
    );
    assert_eq!(diagnostic.secondary_labels.len(), 1);
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);

    let pattern_source = r#"
        import { $state } from 'fict'
        function App() {
            const state = $state({ count: 0 })
            const { count } = state
            ;({ count } = { count: 2 })
            return count
        }
    "#;
    let result = compile_source(pattern_source, CompilerOptions::default());
    let diagnostic = find_error(&result, "FICT-R-ALIAS-WRITE");
    let pattern = pattern_source
        .find("({ count }")
        .expect("assignment pattern");
    let target = pattern + "({ ".len();
    assert_eq!(
        diagnostic.primary_span,
        SourceSpan::new(
            u32::try_from(target).expect("source offset"),
            u32::try_from(target + "count".len()).expect("source offset"),
        )
    );
}

#[test]
fn projected_alias_mutations_follow_the_fict_m_policy() {
    let source = r#"
        import { $state } from 'fict'
        function App() {
            const state = $state({ count: 0 })
            const alias = state
            alias['count'] += 1
            return alias.count
        }
    "#;
    let fallback = compile_source(source, CompilerOptions::default());
    let diagnostic = find_error(&fallback, "FICT-M");
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Warning);
    assert_eq!(diagnostic.guarantee_class, GuaranteeClass::Fallback);
    let start = source
        .find("alias['count'] += 1")
        .expect("computed mutation");
    assert_eq!(
        diagnostic.primary_span,
        SourceSpan::new(
            u32::try_from(start).expect("source offset"),
            u32::try_from(start + "alias['count'] += 1".len()).expect("source offset"),
        )
    );
    assert!(!fallback.code.is_empty(), "{:#?}", fallback.diagnostics);

    let strict = compile_source_with_strict(source, CompilerOptions::default(), true);
    let diagnostic = find_error(&strict, "FICT-M");
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
    assert!(strict.code.is_empty());

    let method_source = r#"
        import { $state } from 'fict'
        function App() {
            const state = $state([])
            const alias = state
            alias.push(1)
            return alias.length
        }
    "#;
    let method = compile_source(method_source, CompilerOptions::default());
    let diagnostic = find_error(&method, "FICT-M");
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Warning);
    let start = method_source.find("alias.push(1)").expect("mutating call");
    assert_eq!(
        diagnostic.primary_span,
        SourceSpan::new(
            u32::try_from(start).expect("source offset"),
            u32::try_from(start + "alias.push(1)".len()).expect("source offset"),
        )
    );
}

#[test]
fn state_derived_method_calls_fail_closed_unless_the_receiver_operation_is_readonly() {
    let source = r#"
        import { $state } from 'fict'
        function App() {
            const state = $state({ values: new Map(), custom: { touch() {} } })
            const values = state.values
            const custom = state.custom
            values.set('x', 1)
            const current = values.get('x')
            custom.touch()
            return current
        }
    "#;
    let fallback = compile_source(source, CompilerOptions::default());
    let findings = fallback
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code.as_str() == "FICT-M")
        .collect::<Vec<_>>();
    assert_eq!(findings.len(), 3, "{:#?}", fallback.diagnostics);
    assert!(findings.iter().all(|diagnostic| {
        diagnostic.severity == DiagnosticSeverity::Warning
            && diagnostic.guarantee_class == GuaranteeClass::Fallback
    }));
    assert!(!fallback.code.is_empty(), "{:#?}", fallback.diagnostics);

    let strict = compile_source_with_strict(source, CompilerOptions::default(), true);
    let findings = strict
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code.as_str() == "FICT-M")
        .collect::<Vec<_>>();
    assert_eq!(findings.len(), 3, "{:#?}", strict.diagnostics);
    assert!(
        findings
            .iter()
            .all(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
    );
    assert!(strict.code.is_empty());
}

#[test]
fn permits_state_roots_plain_aliases_shadowing_and_initial_alias_assignment() {
    for source in [
        r#"
            import { $state } from 'fict'
            function App() {
                let items = $state([])
                const shuffled = [...items]
                items = shuffled
                items = []
                items.length = 0
                return items.length
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                let count = $state(0)
                let alias
                alias = count
                return alias
            }
        "#,
        r#"
            function App() {
                let value = 1
                let alias = value
                alias++
                return alias
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                let count = $state(0)
                let alias = count
                function update(alias) {
                    alias = 2
                    return alias
                }
                return update(1)
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                const count = $state(0)
                let snapshot = count * 2
                snapshot = 3
                return snapshot
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App(flag) {
                let first = $state(0)
                let second = $state(1)
                let alias
                if (flag) {
                    alias = first
                } else {
                    alias = second
                }
                return alias
            }
        "#,
    ] {
        for optimize in [false, true] {
            let result = compile_source(
                source,
                CompilerOptions {
                    optimize,
                    ..CompilerOptions::default()
                },
            );
            assert!(!result.has_errors(), "{:#?}", result.diagnostics);
        }
    }
}
