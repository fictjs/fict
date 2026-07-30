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
fn treats_only_direct_builtin_state_type_arguments_as_caller_owned_receiver_proofs() {
    for optimize in [false, true] {
        let accepted = compile_source_with_strict(
            r#"
                import { $state } from 'fict'
                function App(value: unknown) {
                    const rows = $state<number[]>(value as number[])
                    return rows.map(row => row + 1).join(',')
                }
            "#,
            CompilerOptions {
                optimize,
                ..CompilerOptions::default()
            },
            true,
        );
        assert!(!accepted.has_errors(), "{:#?}", accepted.diagnostics);
        assert!(!accepted.code.is_empty());
        assert!(
            accepted
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code.as_str() != "FICT-M")
        );

        for source in [
            r#"
                import { $state } from 'fict'
                function App(value: unknown) {
                    const rows = $state(value as number[])
                    return rows.map(row => row + 1).join(',')
                }
            "#,
            r#"
                import { $state } from 'fict'
                function App(value: unknown) {
                    let rows: number[] = $state(value as number[])
                    return rows.map(row => row + 1).join(',')
                }
            "#,
            r#"
                import { $state } from 'fict'
                type Rows = number[]
                function App(value: unknown) {
                    const rows = $state<Rows>(value as Rows)
                    return rows.map(row => row + 1).join(',')
                }
            "#,
            r#"
                import { $state } from 'fict'
                type Array<T> = { map(callback: (value: T) => T): T[] }
                function App(value: unknown) {
                    const rows = $state<Array<number>>(value as Array<number>)
                    return rows.map(row => row + 1).join(',')
                }
            "#,
        ] {
            let rejected = compile_source_with_strict(
                source,
                CompilerOptions {
                    optimize,
                    ..CompilerOptions::default()
                },
                true,
            );
            let diagnostic = find_error(&rejected, "FICT-M");
            assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
            assert_eq!(diagnostic.guarantee_class, GuaranteeClass::Fallback);
            assert!(rejected.code.is_empty());
        }
    }
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

#[test]
fn forgets_projected_provenance_after_safe_snapshot_reassignment() {
    for source in [
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }])
                let item = rows.at(0)
                item = { done: false }
                item.done = true
                return item.done
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ id: 1 }])
                return rows.map(row => {
                    let id = row.id
                    id = 42
                    return id
                }).join(',')
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([1])
                return rows.map(item => {
                    item = item + 1
                    return item
                }).join(',')
            }
        "#,
    ] {
        let result = compile_source_with_strict(source, CompilerOptions::default(), true);
        assert!(!result.has_errors(), "{:#?}", result.diagnostics);
        assert!(result.diagnostics.iter().all(|diagnostic| {
            !matches!(
                diagnostic.code.as_str(),
                "FICT-M" | "FICT-R002" | "FICT-R-ALIAS-WRITE"
            )
        }));
    }
}

#[test]
fn tracks_state_elements_in_array_sort_comparators() {
    for parameter in ["left", "right"] {
        let source = format!(
            r#"
                import {{ $state }} from 'fict'
                function App() {{
                    const rows = $state([{{ done: false }}])
                    return rows.toSorted((left, right) => {{
                        {parameter}.done = true
                        return Number(left.done) - Number(right.done)
                    }})
                }}
            "#
        );
        let fallback = compile_source(&source, CompilerOptions::default());
        let findings = fallback
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code.as_str() == "FICT-M")
            .collect::<Vec<_>>();
        assert_eq!(findings.len(), 1, "{:#?}", fallback.diagnostics);
        assert_eq!(findings[0].severity, DiagnosticSeverity::Warning);
        assert_eq!(findings[0].guarantee_class, GuaranteeClass::Fallback);
        let mutation = format!("{parameter}.done = true");
        let start = source.find(&mutation).expect("comparator mutation");
        assert_eq!(
            findings[0].primary_span,
            SourceSpan::new(
                u32::try_from(start).expect("source offset"),
                u32::try_from(start + mutation.len()).expect("source offset"),
            )
        );
        assert!(!fallback.code.is_empty(), "{:#?}", fallback.diagnostics);

        let strict = compile_source_with_strict(&source, CompilerOptions::default(), true);
        let diagnostic = find_error(&strict, "FICT-M");
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
        assert!(strict.code.is_empty());
    }

    let sort_source = r#"
        import { $state } from 'fict'
        function App() {
            const rows = $state([{ done: false }])
            return rows.sort((left, right) => {
                left.done = true
                return Number(left.done) - Number(right.done)
            })
        }
    "#;
    let fallback = compile_source(sort_source, CompilerOptions::default());
    let mut spans = fallback
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code.as_str() == "FICT-M")
        .map(|diagnostic| diagnostic.primary_span)
        .collect::<Vec<_>>();
    spans.sort();
    let call_start = sort_source.find("rows.sort").expect("sort call");
    let call_end = call_start
        + sort_source[call_start..]
            .find("\n            })")
            .expect("sort call end")
        + "\n            })".len();
    let mutation_start = sort_source
        .find("left.done = true")
        .expect("comparator mutation");
    let mut expected = vec![
        SourceSpan::new(
            u32::try_from(call_start).expect("source offset"),
            u32::try_from(call_end).expect("source offset"),
        ),
        SourceSpan::new(
            u32::try_from(mutation_start).expect("source offset"),
            u32::try_from(mutation_start + "left.done = true".len()).expect("source offset"),
        ),
    ];
    expected.sort();
    assert_eq!(spans, expected, "{:#?}", fallback.diagnostics);
}

#[test]
fn accepts_definitely_undefined_array_sort_comparators() {
    for source in [
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }])
                return rows.toSorted(undefined)
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }])
                const comparator = undefined
                return rows.toSorted(comparator)
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }])
                return rows.toSorted((0, undefined))
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }])
                let comparator
                return rows.toSorted(comparator)
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }])
                var comparator
                return rows.toSorted(comparator)
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App(flag) {
                const rows = $state([{ done: false }])
                let comparator
                if (flag) {
                    comparator = (left, right) => Number(left.done) - Number(right.done)
                }
                return rows.toSorted(comparator)
            }
        "#,
        r#"
            import { $state } from 'fict'
            function noComparator() {
                return undefined
            }
            function App() {
                const rows = $state([{ done: false }])
                return rows.toSorted(noComparator())
            }
        "#,
        r#"
            import { $state } from 'fict'
            const noComparator = () => undefined
            function App() {
                const rows = $state([{ done: false }])
                return rows.toSorted(noComparator())
            }
        "#,
        r#"
            import { $state } from 'fict'
            let noComparator = () => undefined
            function App() {
                const rows = $state([{ done: false }])
                return rows.toSorted(noComparator())
            }
        "#,
    ] {
        for optimize in [false, true] {
            let result = compile_source_with_strict(
                source,
                CompilerOptions {
                    optimize,
                    ..CompilerOptions::default()
                },
                true,
            );
            assert!(!result.has_errors(), "{:#?}", result.diagnostics);
            assert!(
                result
                    .diagnostics
                    .iter()
                    .all(|diagnostic| diagnostic.code.as_str() != "FICT-R002")
            );
            assert!(!result.code.is_empty());
        }
    }
}

#[test]
fn rejects_reassigned_known_safe_callback_globals() {
    let accepted = compile_source_with_strict(
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }])
                return rows.filter(Boolean)
            }
        "#,
        CompilerOptions::default(),
        true,
    );
    assert!(!accepted.has_errors(), "{:#?}", accepted.diagnostics);

    for source in [
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }, { done: false }])
                Boolean = (left, right) => {
                    left.done = true
                    return 0
                }
                return rows.toSorted(Boolean)
            }
        "#,
        r#"
            import { $state } from 'fict'
            String = value => {
                value.done = true
                return ''
            }
            function App() {
                const rows = $state([{ done: false }])
                rows.forEach(item => {
                    String(item)
                })
                return rows
            }
        "#,
        r#"
            import { $state } from 'fict'
            Boolean = (left, right) => {
                left.done = true
                return 0
            }
            function getComparator() {
                return Boolean
            }
            function App() {
                const rows = $state([{ done: false }, { done: false }])
                return rows.toSorted(getComparator())
            }
        "#,
    ] {
        let fallback = compile_source(source, CompilerOptions::default());
        let diagnostic = find_error(&fallback, "FICT-R002");
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Warning);
        assert!(!fallback.code.is_empty());

        let strict = compile_source_with_strict(source, CompilerOptions::default(), true);
        let diagnostic = find_error(&strict, "FICT-R002");
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
        assert!(strict.code.is_empty());
    }
}

#[test]
fn keeps_shadowed_undefined_array_sort_comparators_unresolved() {
    let result = compile_source(
        r#"
            import { $state } from 'fict'
            function App(undefined) {
                const rows = $state([{ done: false }])
                return rows.toSorted(undefined)
            }
        "#,
        CompilerOptions::default(),
    );
    let diagnostic = find_error(&result, "FICT-R002");
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Warning);
}

#[test]
fn keeps_capture_written_array_sort_comparators_unresolved() {
    let result = compile_source(
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }])
                let comparator
                const install = () => {
                    comparator = (left, right) => Number(left.done) - Number(right.done)
                }
                install()
                return rows.toSorted(comparator)
            }
        "#,
        CompilerOptions::default(),
    );
    let diagnostic = find_error(&result, "FICT-R002");
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Warning);
}

#[test]
fn resolves_reassigned_array_sort_callback_producers_at_call_sites() {
    for source in [
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }])
                let getComparator = () => undefined
                getComparator = () => (left, right) => {
                    left.done = true
                    return 0
                }
                return rows.toSorted(getComparator())
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App(flag) {
                const rows = $state([{ done: false }])
                function getComparator() {
                    return undefined
                }
                if (flag) {
                    getComparator = () => (left, right) => {
                        left.done = true
                        return 0
                    }
                }
                return rows.toSorted(getComparator())
            }
        "#,
    ] {
        let fallback = compile_source(source, CompilerOptions::default());
        let diagnostic = find_error(&fallback, "FICT-M");
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Warning);
        assert!(
            fallback
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code.as_str() != "FICT-R002")
        );

        let strict = compile_source_with_strict(source, CompilerOptions::default(), true);
        let diagnostic = find_error(&strict, "FICT-M");
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
        assert!(
            strict
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code.as_str() != "FICT-R002")
        );
        assert!(strict.code.is_empty());
    }

    let write_after_call = compile_source_with_strict(
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }])
                let getComparator = () => undefined
                const sorted = rows.toSorted(getComparator())
                getComparator = () => (left, right) => {
                    left.done = true
                    return 0
                }
                return sorted
            }
        "#,
        CompilerOptions::default(),
        true,
    );
    assert!(
        !write_after_call.has_errors(),
        "{:#?}",
        write_after_call.diagnostics
    );
    assert!(
        write_after_call
            .diagnostics
            .iter()
            .all(|diagnostic| !matches!(diagnostic.code.as_str(), "FICT-M" | "FICT-R002"))
    );
}

#[test]
fn keeps_cross_function_array_sort_callback_writes_unresolved() {
    for source in [
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }])
                let comparator = (left, right) => 0
                const install = () => {
                    comparator = (left, right) => {
                        left.done = true
                        return 0
                    }
                }
                install()
                return rows.toSorted(comparator)
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }])
                let getComparator = () => undefined
                const install = () => {
                    getComparator = () => (left, right) => {
                        left.done = true
                        return 0
                    }
                }
                install()
                return rows.toSorted(getComparator())
            }
        "#,
        r#"
            import { $state } from 'fict'
            let getComparator = () => undefined
            getComparator = () => (left, right) => {
                left.done = true
                return 0
            }
            function App() {
                const rows = $state([{ done: false }])
                return rows.toSorted(getComparator())
            }
        "#,
    ] {
        let fallback = compile_source(source, CompilerOptions::default());
        let diagnostic = find_error(&fallback, "FICT-R002");
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Warning);

        let strict = compile_source_with_strict(source, CompilerOptions::default(), true);
        let diagnostic = find_error(&strict, "FICT-R002");
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
        assert!(strict.code.is_empty());
    }
}

#[test]
fn keeps_extracted_array_sort_callbacks_unresolved() {
    for source in [
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }, { done: false }])
                let comparator
                [comparator] = [(left, right) => {
                    left.done = true
                    return 0
                }]
                return rows.toSorted(comparator)
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }, { done: false }])
                let getComparator
                ({ getComparator } = {
                    getComparator: () => (left, right) => {
                        left.done = true
                        return 0
                    },
                })
                return rows.toSorted(getComparator())
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }, { done: false }])
                for (const comparator of [(left, right) => {
                    left.done = true
                    return 0
                }]) {
                    return rows.toSorted(comparator)
                }
                return rows
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }, { done: false }])
                for (const getComparator of [() => (left, right) => {
                    left.done = true
                    return 0
                }]) {
                    return rows.toSorted(getComparator())
                }
                return rows
            }
        "#,
    ] {
        let fallback = compile_source(source, CompilerOptions::default());
        let diagnostic = find_error(&fallback, "FICT-R002");
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Warning);

        let strict = compile_source_with_strict(source, CompilerOptions::default(), true);
        let diagnostic = find_error(&strict, "FICT-R002");
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
        assert!(strict.code.is_empty());
    }
}

#[test]
fn keeps_ambiguous_array_sort_callback_bindings_unresolved() {
    for source in [
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }, { done: false }])
                function comparator(left, right) {
                    return 0
                }
                function comparator(left, right) {
                    left.done = true
                    return 0
                }
                return rows.toSorted(comparator)
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }, { done: false }])
                function getComparator() {
                    return undefined
                }
                function getComparator() {
                    return (left, right) => {
                        left.done = true
                        return 0
                    }
                }
                return rows.toSorted(getComparator())
            }
        "#,
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }, { done: false }])
                function getComparator() {
                    return undefined
                }
                function getComparator() {
                    return (left, right) => {
                        left.done = true
                        return 0
                    }
                }
                const sortRows = () => rows.toSorted(getComparator())
                return sortRows()
            }
        "#,
    ] {
        let fallback = compile_source(source, CompilerOptions::default());
        let diagnostic = find_error(&fallback, "FICT-R002");
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Warning);

        let strict = compile_source_with_strict(source, CompilerOptions::default(), true);
        let diagnostic = find_error(&strict, "FICT-R002");
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
        assert!(strict.code.is_empty());
    }
}

#[test]
fn keeps_ambiguous_callback_helper_bindings_unresolved() {
    for source in [
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ done: false }])
                rows.forEach(item => {
                    function consume(value) {
                        return value.done
                    }
                    function consume(value) {
                        value.done = true
                    }
                    consume(item)
                })
                return rows
            }
        "#,
        r#"
            import { $state } from 'fict'
            let retained
            function App() {
                const rows = $state([{ done: false }])
                rows.forEach(item => {
                    function consume(value) {
                        return value.done
                    }
                    function consume(value) {
                        retained = value
                    }
                    consume(item)
                })
                return rows
            }
        "#,
    ] {
        let fallback = compile_source(source, CompilerOptions::default());
        let diagnostic = find_error(&fallback, "FICT-R002");
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Warning);
        assert!(!fallback.code.is_empty());

        let strict = compile_source_with_strict(source, CompilerOptions::default(), true);
        let diagnostic = find_error(&strict, "FICT-R002");
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
        assert!(strict.code.is_empty());
    }
}

#[test]
fn tracks_mutating_optional_array_sort_comparators_without_unresolved_fallback() {
    let source = r#"
        import { $state } from 'fict'
        function App(flag) {
            const rows = $state([{ done: false }])
            let comparator
            if (flag) {
                comparator = (left, right) => {
                    left.done = true
                    return Number(left.done) - Number(right.done)
                }
            }
            return rows.toSorted(comparator)
        }
    "#;
    let fallback = compile_source(source, CompilerOptions::default());
    let diagnostic = find_error(&fallback, "FICT-M");
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Warning);
    assert!(
        fallback
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code.as_str() != "FICT-R002")
    );

    let strict = compile_source_with_strict(source, CompilerOptions::default(), true);
    let diagnostic = find_error(&strict, "FICT-M");
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
    assert!(
        strict
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code.as_str() != "FICT-R002")
    );
    assert!(strict.code.is_empty());
}

#[test]
fn state_provenance_worklist_has_linear_deterministic_work() {
    const ALIASES: usize = 1_200;
    let mut source = String::from(
        r#"
            import { $state } from 'fict'
            function App() {
                const state = $state({ done: false })
                const alias0 = state
        "#,
    );
    for index in 1..ALIASES {
        source.push_str(&format!(
            "        const alias{index} = alias{}\n",
            index - 1
        ));
    }
    source.push_str(&format!(
        "        alias{}.done = true\n        return alias{}.done\n    }}",
        ALIASES - 1,
        ALIASES - 1,
    ));

    let result = compile_source(
        &source,
        CompilerOptions {
            optimize: false,
            ..CompilerOptions::default()
        },
    );
    let diagnostic = find_error(&result, "FICT-M");
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Warning);
    let stats = result.stats.expect("successful compile stats");
    let work_items = stats.counters["stateProvenanceWorkItems"];
    let dependency_edges = stats.counters["stateProvenanceDependencyEdges"];
    let value_visits = stats.counters["stateProvenanceValueVisits"];
    assert!(
        work_items <= u64::try_from(ALIASES * 4).expect("work budget"),
        "work items {work_items} exceeded the linear alias-chain budget"
    );
    assert!(
        dependency_edges <= u64::try_from(ALIASES * 4).expect("edge budget"),
        "dependency edges {dependency_edges} exceeded the linear alias-chain budget"
    );
    assert!(
        value_visits <= u64::try_from(ALIASES * 6).expect("visit budget"),
        "value visits {value_visits} exceeded the linear alias-chain budget"
    );
}

#[test]
fn state_provenance_deep_value_graph_has_bounded_visits() {
    const DEPTH: usize = 128;
    let mut expression = "state".to_owned();
    for _ in 0..DEPTH {
        expression = format!("null ?? ({expression})");
    }
    let source = format!(
        r#"
            import {{ $state }} from 'fict'
            function App() {{
                const state = $state({{ done: false }})
                const alias = {expression}
                alias.done = true
                return alias.done
            }}
        "#
    );
    let result = compile_source(
        &source,
        CompilerOptions {
            optimize: false,
            ..CompilerOptions::default()
        },
    );
    let diagnostic = find_error(&result, "FICT-M");
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Warning);
    let stats = result.stats.expect("successful compile stats");
    let value_visits = stats.counters["stateProvenanceValueVisits"];
    assert!(
        value_visits <= u64::try_from(DEPTH * 4 + 64).expect("visit budget"),
        "value visits {value_visits} exceeded the deep-value-graph budget"
    );
}

#[test]
fn permits_structural_mutation_of_fresh_state_derived_containers() {
    let result = compile_source_with_strict(
        r#"
            import { $state } from 'fict'
            export let api: { deleteFirst(): void }
            function App() {
                let items = $state<Array<string | undefined>>([undefined, 'b'])
                api = {
                    deleteFirst() {
                        const next = items.slice()
                        delete next[0]
                        items = next
                    },
                }
                return items.length
            }
        "#,
        CompilerOptions::default(),
        true,
    );
    assert!(!result.has_errors(), "{:#?}", result.diagnostics);
    assert!(
        result
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code.as_str() != "FICT-M")
    );
}

#[test]
fn distinguishes_non_retaining_local_reads_from_returned_state_identity() {
    let safe = compile_source_with_strict(
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ id: 1 }])
                return rows.map(row => {
                    const read = value => value.id
                    return read(row)
                }).join(',')
            }
        "#,
        CompilerOptions::default(),
        true,
    );
    assert!(!safe.has_errors(), "{:#?}", safe.diagnostics);
    assert!(
        safe.diagnostics
            .iter()
            .all(|diagnostic| { !matches!(diagnostic.code.as_str(), "FICT-M" | "FICT-R002") })
    );

    let projected_passthrough = compile_source_with_strict(
        r#"
            import { $state } from 'fict'
            function App() {
                const rows = $state([{ id: 1 }])
                const remove = id => id
                return <div>{rows.map(row => (
                    <button onClick={() => remove(row.id)}>{row.id}</button>
                ))}</div>
            }
        "#,
        CompilerOptions::default(),
        true,
    );
    assert!(
        !projected_passthrough.has_errors(),
        "{:#?}",
        projected_passthrough.diagnostics
    );
    assert!(
        projected_passthrough
            .diagnostics
            .iter()
            .all(|diagnostic| { !matches!(diagnostic.code.as_str(), "FICT-M" | "FICT-R002") })
    );

    let unsafe_result = compile_source_with_strict(
        r#"
            import { $state } from 'fict'
            function identity(value) { return value }
            function App() {
                const rows = $state([{ done: false }])
                const item = identity(rows.at(0))
                item.done = true
                return item.done
            }
        "#,
        CompilerOptions::default(),
        false,
    );
    let diagnostic = find_error(&unsafe_result, "FICT-M");
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Warning);
    assert_eq!(diagnostic.guarantee_class, GuaranteeClass::Fallback);
    assert!(!unsafe_result.code.is_empty());
}
