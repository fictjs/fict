use fict_compiler_oxc::{
    HirBuildOptions, OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, build_hir,
};
use fict_hir::{
    CallHost, CompoundAssignmentOperator, FictMacroKind, FunctionKind, HirInstructionKind,
    ReactiveCallKind, SyntaxFragmentKind, UpdateOperator,
};

fn options(language: OxcSourceLanguage) -> OxcCompileOptions {
    OxcCompileOptions {
        language,
        module_kind: OxcModuleKind::Module,
        typescript: Default::default(),
        sourcemap: false,
    }
}

#[test]
fn builds_verified_binding_aware_hir_for_tsx_components_and_macros() {
    let source = r#"
        import { $state as state } from 'fict';
        export function App(props: { initial: number }) {
            const count = state(props.initial);
            return <button>{count}</button>;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::TypeScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");

    let app = hir
        .functions
        .iter()
        .find(|function| function.kind == FunctionKind::Component)
        .expect("component function");
    assert_eq!(app.parameters.len(), 1);
    let (call_index, state_result, call) = app.blocks[0]
        .instructions
        .iter()
        .enumerate()
        .find_map(|(index, instruction)| match &instruction.kind {
            HirInstructionKind::Call(call) => Some((index, instruction.result, call)),
            _ => None,
        })
        .expect("state call");
    let state_result = state_result.expect("state result");
    assert_eq!(call.macro_kind, Some(FictMacroKind::State));
    let CallHost::Binding(callee) = call.host else {
        panic!("state call must carry its imported binding")
    };
    assert_eq!(
        callee,
        hir.bindings
            .iter()
            .find(|binding| binding.display_name == "state")
            .unwrap()
            .id
    );
    let count = app
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("count"))
        .expect("count local");
    let (declaration_index, initializer) = app.blocks[0]
        .instructions
        .iter()
        .enumerate()
        .find_map(|(index, instruction)| match instruction.kind {
            HirInstructionKind::Declare {
                local, initializer, ..
            } if local == count.id => Some((index, initializer)),
            _ => None,
        })
        .expect("count declaration");
    assert_eq!(initializer, Some(state_result));
    assert!(call_index < declaration_index);
    assert!(
        hir.bindings
            .iter()
            .all(|binding| binding.id.as_usize() < hir.bindings.len())
    );
    assert!(
        output
            .syntax_fragments
            .iter()
            .any(|fragment| fragment.source.contains("<button>"))
    );
    assert_eq!(hir.templates.len(), 1);
    assert_eq!(hir.templates[0].owner, app.id);
    assert!(
        app.blocks[0]
            .instructions
            .iter()
            .any(|instruction| matches!(instruction.kind, HirInstructionKind::Jsx { .. }))
    );
}

#[test]
fn alias_and_shadow_calls_keep_distinct_binding_identity() {
    let source = r#"
        import { $state as state } from 'fict';
        function App() {
            const outer = state(1);
            function inner(state) { return state(2); }
            return outer;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let calls: Vec<_> = hir
        .functions
        .iter()
        .flat_map(|function| &function.blocks[0].instructions)
        .filter_map(|instruction| match &instruction.kind {
            HirInstructionKind::Call(call) => Some(call),
            _ => None,
        })
        .collect();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].macro_kind, Some(FictMacroKind::State));
    assert_eq!(calls[1].macro_kind, None);
    let CallHost::Binding(imported) = calls[0].host else {
        panic!("import call")
    };
    let CallHost::Binding(shadow) = calls[1].host else {
        panic!("shadow call")
    };
    assert_ne!(imported, shadow);
}

#[test]
fn classifies_runtime_reactive_calls_by_import_identity() {
    let source = r#"
        import { $store as store } from 'fict';
        import { resource } from 'fict/plus';
        import { createSelector as selector } from '@fictjs/runtime/advanced';
        import * as F from 'fict';
        import { $store as fakeStore } from 'third-party';

        const one = store({ value: 1 });
        const two = resource(() => 2);
        const three = selector(() => one.value);
        const four = F.$store({ value: 4 });
        const five = F['resource'](() => 5);
        const six = F.createSelector(() => four.value);
        const ignored = fakeStore({ value: 0 });
        function shadow(store) { return store({ value: 0 }); }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified reactive-call HIR");
    let calls: Vec<_> = hir
        .functions
        .iter()
        .flat_map(|function| &function.blocks[0].instructions)
        .filter_map(|instruction| match &instruction.kind {
            HirInstructionKind::Call(call) => Some(call),
            _ => None,
        })
        .collect();
    let kinds: Vec<_> = calls.iter().filter_map(|call| call.reactive_kind).collect();
    assert_eq!(
        kinds,
        [
            ReactiveCallKind::Store,
            ReactiveCallKind::Resource,
            ReactiveCallKind::Selector,
            ReactiveCallKind::Store,
            ReactiveCallKind::Resource,
            ReactiveCallKind::Selector,
        ]
    );
    for call in calls.iter().filter(|call| call.reactive_kind.is_some()) {
        assert!(matches!(call.host, CallHost::Binding(_)));
        assert!(call.macro_kind.is_none());
    }
    assert_eq!(
        calls
            .iter()
            .filter(|call| call.reactive_kind.is_none())
            .count(),
        2,
        "wrong-module and shadowed same-name calls remain ordinary"
    );
}

#[test]
fn materializes_binding_resolved_macro_reads_in_hir() {
    let source = r#"
        import { $memo as memo } from 'fict';
        const doubled = memo(() => 2);
        export const result = doubled + doubled;
        function shadow(doubled) { return doubled; }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified reactive-read HIR");
    let module = &hir.functions[hir.root_function.as_usize()];
    let doubled = module
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("doubled"))
        .expect("memo local");
    let reads: Vec<_> = module.blocks[0]
        .instructions
        .iter()
        .filter(|instruction| {
            matches!(
                &instruction.kind,
                HirInstructionKind::Read { place }
                    if place == &fict_hir::Place::local(doubled.id)
            )
        })
        .collect();

    assert_eq!(reads.len(), 2);
    for read in reads {
        let span = read.origin.primary_span.expect("read source span");
        assert_eq!(
            &source[span.start() as usize..span.end() as usize],
            "doubled"
        );
    }
    let shadow = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "shadow")
        })
        .expect("shadow function");
    assert!(
        shadow.blocks[0]
            .instructions
            .iter()
            .all(|instruction| { !matches!(instruction.kind, HirInstructionKind::Read { .. }) })
    );
}

#[test]
fn materializes_reactive_assignments_compounds_and_updates() {
    let source = r#"
        import { $state as state } from 'fict';
        function App() {
            let count = state(0);
            const assigned = (count = next());
            const compound = (count += delta());
            const postfix = count++;
            const prefix = --count;
            return [assigned, compound, postfix, prefix, count];
        }
        function shadow(count) { count += 1; return count++; }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified mutation HIR");
    let app = hir
        .functions
        .iter()
        .find(|function| function.kind == FunctionKind::Component)
        .expect("component");
    let count = app
        .locals
        .iter()
        .find(|local| local.debug_name.as_deref() == Some("count"))
        .expect("state local");
    let mutations: Vec<_> = app.blocks[0]
        .instructions
        .iter()
        .filter(|instruction| match &instruction.kind {
            HirInstructionKind::Write { place, .. }
            | HirInstructionKind::ReadWrite { place, .. } => {
                place == &fict_hir::Place::local(count.id)
            }
            _ => false,
        })
        .collect();

    assert_eq!(mutations.len(), 4);
    assert!(matches!(
        mutations[0].kind,
        HirInstructionKind::Write { .. }
    ));
    assert!(matches!(
        mutations[1].kind,
        HirInstructionKind::ReadWrite {
            compound: Some(CompoundAssignmentOperator::Add),
            update: None,
            ..
        }
    ));
    assert!(matches!(
        mutations[2].kind,
        HirInstructionKind::ReadWrite {
            update: Some(UpdateOperator::Increment),
            prefix: false,
            ..
        }
    ));
    assert!(matches!(
        mutations[3].kind,
        HirInstructionKind::ReadWrite {
            update: Some(UpdateOperator::Decrement),
            prefix: true,
            ..
        }
    ));
    let authored: Vec<_> = mutations
        .iter()
        .map(|instruction| {
            let span = instruction.origin.primary_span.expect("mutation origin");
            &source[span.start() as usize..span.end() as usize]
        })
        .collect();
    assert_eq!(
        authored,
        ["count = next()", "count += delta()", "count++", "--count"]
    );

    let shadow = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "shadow")
        })
        .expect("shadow function");
    assert!(shadow.blocks[0].instructions.iter().all(|instruction| {
        !matches!(
            instruction.kind,
            HirInstructionKind::Write { .. } | HirInstructionKind::ReadWrite { .. }
        )
    }));
}

#[test]
fn classifies_nested_state_mutation_by_strict_guarantee_policy() {
    let source = r#"
        import { $state } from 'fict';
        function App() {
            const user = $state({ name: 'Ada' });
            user.name = 'Grace';
            return user.name;
        }
    "#;
    let strict = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(strict.hir.is_none());
    let finding = strict
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code.as_str() == "FICT-M001")
        .expect("strict nested-mutation diagnostic");
    assert_eq!(
        finding.severity,
        fict_diagnostics::DiagnosticSeverity::Error
    );
    assert_eq!(
        finding.guarantee_class,
        fict_diagnostics::GuaranteeClass::Fallback
    );

    let fallback = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions {
            strict_guarantee: false,
            ..HirBuildOptions::default()
        },
    );
    assert!(fallback.hir.is_some(), "{:?}", fallback.diagnostics);
    let finding = fallback
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code.as_str() == "FICT-M001")
        .expect("fallback nested-mutation warning");
    assert_eq!(
        finding.severity,
        fict_diagnostics::DiagnosticSeverity::Warning
    );
}

#[test]
fn classifies_hooks_and_binding_resolved_reactive_callbacks() {
    let source = r#"
        import { run as render } from './host';
        function useCounter() { return 1; }
        render(() => useCounter());
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions {
            reactive_scopes: vec!["render".into()],
            ..HirBuildOptions::default()
        },
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    assert!(
        hir.functions
            .iter()
            .any(|function| function.kind == FunctionKind::Hook)
    );
    assert!(
        hir.functions
            .iter()
            .any(|function| function.kind == FunctionKind::ReactiveScope)
    );
    let render_call = hir.functions[0].blocks[0]
        .instructions
        .iter()
        .find_map(|instruction| match &instruction.kind {
            HirInstructionKind::Call(call) => Some(call),
            _ => None,
        })
        .expect("render call");
    assert!(matches!(render_call.host, CallHost::ReactiveScope(_)));
}

#[test]
fn retains_patterns_and_function_bodies_as_owned_controlled_fragments() {
    let source = "const View = ({ value = 1, ...rest }) => value + rest.offset;";
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let view = hir
        .functions
        .iter()
        .find(|function| function.kind == FunctionKind::Component)
        .expect("inferred arrow component");
    let pattern = &hir.syntax_fragments[view.parameters[0].pattern.as_usize()];
    assert_eq!(pattern.kind, SyntaxFragmentKind::Pattern);
    let summary = pattern.summary.pattern.as_ref().expect("pattern summary");
    assert_eq!(summary.declared_bindings.len(), 2);
    assert!(summary.has_defaults);
    assert!(summary.has_rest);
    let adapter = output
        .syntax_fragments
        .iter()
        .find(|fragment| fragment.id == pattern.id)
        .expect("adapter fragment");
    assert!(adapter.source.contains("value = 1"));
}

#[test]
fn unsupported_macro_shapes_fail_closed_with_structured_codes() {
    let cases = [
        (
            "import { $state as state } from 'fict'; state?.(1);",
            "FICT-HIR-MACRO-OPTIONAL",
        ),
        (
            "import { $state as state } from 'fict'; const escaped = state;",
            "FICT-HIR-MACRO-VALUE",
        ),
        (
            "import * as Fict from 'fict'; Fict.$state(1);",
            "FICT-HIR-MACRO-NAMESPACE",
        ),
    ];
    for (source, code) in cases {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none());
        assert_eq!(output.diagnostics[0].code.as_str(), code);
    }
}

#[test]
fn applies_function_directives_and_erases_type_only_binding_ids() {
    let source = r#"
        import type { Shape } from './shape';
        export function useValue(value: Shape) {
            "use no memo";
            "use pure";
            return value;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::TypeScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let hook = hir
        .functions
        .iter()
        .find(|function| function.kind == FunctionKind::Hook)
        .expect("hook");
    assert!(hook.flags.no_memo);
    assert!(hook.flags.pure);
    assert!(
        hir.bindings
            .iter()
            .all(|binding| binding.display_name != "Shape")
    );
    for (index, binding) in hir.bindings.iter().enumerate() {
        assert_eq!(binding.id.as_usize(), index);
    }
}

#[test]
fn builds_structural_jsx_tags_attributes_children_and_spreads() {
    let source = r#"
        import * as UI from './ui';
        import { Item } from './item';
        export function App({ items }) {
            return <UI.List dense title="items" {...items}>
                <Item value={items[0]} />
                {...items}
            </UI.List>;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    assert_eq!(hir.templates.len(), 1);
    let fict_hir::JsxNode::Element(root) = &hir.templates[0].root else {
        panic!("root JSX element")
    };
    let fict_hir::JsxElementName::Member {
        root: binding,
        properties,
    } = &root.name
    else {
        panic!("binding-aware member tag")
    };
    assert_eq!(properties, &["List"]);
    assert_eq!(hir.bindings[binding.as_usize()].display_name, "UI");
    assert_eq!(root.attributes.len(), 3);
    assert!(matches!(
        root.attributes[0],
        fict_hir::JsxAttribute::Named {
            value: fict_hir::JsxAttributeValue::ImplicitTrue,
            ..
        }
    ));
    assert!(
        root.attributes
            .iter()
            .any(|attribute| matches!(attribute, fict_hir::JsxAttribute::Spread { .. }))
    );
    assert!(root.children.iter().any(|child| matches!(
        child,
        fict_hir::JsxChild::Node(node)
            if matches!(node.as_ref(), fict_hir::JsxNode::Element(element)
                if matches!(element.name, fict_hir::JsxElementName::Component(_)))
    )));
    assert!(
        root.children
            .iter()
            .any(|child| matches!(child, fict_hir::JsxChild::Spread { .. }))
    );
}

#[test]
fn models_binding_aware_direct_keyed_map_callbacks() {
    let source = r#"
        import { $state } from 'fict';
        export function App() {
            let rows = $state([{ id: 1, name: 'A' }]);
            return <ul>{rows.map((row, index) => <li key={row.id}>{index}:{row.name}</li>)}</ul>;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let fict_hir::JsxNode::Element(root) = &hir.templates[0].root else {
        panic!("intrinsic list root")
    };
    let fict_hir::JsxChild::Expression {
        list: Some(list), ..
    } = &root.children[0]
    else {
        panic!("keyed map metadata")
    };
    let fict_hir::JsxListReceiver::Binding {
        root: receiver,
        projected: false,
        ..
    } = list.receiver
    else {
        panic!("direct binding receiver")
    };
    assert_eq!(hir.bindings[receiver.as_usize()].display_name, "rows");
    assert!(hir.functions[list.callback.as_usize()].flags.is_arrow);
    assert_eq!(list.item_references.len(), 1);
    assert_eq!(list.index_references.len(), 1);
    assert!(list.needs_index);
    let key = list.key.primary_span.expect("source key span");
    assert_eq!(&source[key.start() as usize..key.end() as usize], "row.id");

    let mutated = build_hir(
        "export function App(rows) { return <ul>{rows.map(row => <li key={row.id}>{row++}</li>)}</ul>; }",
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(mutated.diagnostics.is_empty(), "{:?}", mutated.diagnostics);
    let mutated = mutated.hir.expect("verified fallback HIR");
    let fict_hir::JsxNode::Element(root) = &mutated.templates[0].root else {
        panic!("intrinsic list root")
    };
    assert!(matches!(
        &root.children[0],
        fict_hir::JsxChild::Expression { list: None, .. }
    ));
}

#[test]
fn assigns_dense_function_local_storage_and_outer_captures_without_name_identity() {
    let source = r#"
        const outer = 1;
        function App() {
            const value = outer;
            function inner() {
                const value = outer;
                return value;
            }
            return inner() + value;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let value_bindings: Vec<_> = hir
        .bindings
        .iter()
        .filter(|binding| binding.display_name == "value")
        .map(|binding| binding.id)
        .collect();
    assert_eq!(value_bindings.len(), 2);
    assert_ne!(value_bindings[0], value_bindings[1]);

    let app = hir
        .functions
        .iter()
        .find(|function| function.kind == FunctionKind::Component)
        .expect("App");
    let inner = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "inner")
        })
        .expect("inner");
    for function in [app, inner] {
        for (index, local) in function.locals.iter().enumerate() {
            assert_eq!(local.id.as_usize(), index);
        }
        assert!(function.locals.iter().any(|local| {
            local.kind == fict_hir::LocalKind::Capture
                && local
                    .binding
                    .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "outer")
        }));
    }
    assert!(
        hir.functions[0]
            .locals
            .iter()
            .all(|local| local.kind != fict_hir::LocalKind::Capture)
    );
}

#[test]
fn enforces_state_owner_target_and_top_level_placement() {
    let cases = [
        (
            "import { $state } from 'fict'; const value = $state(0);",
            "FICT-PLACEMENT-STATE-OWNER",
        ),
        (
            "import { $state } from 'fict'; function helper() { const value = $state(0); }",
            "FICT-PLACEMENT-STATE-OWNER",
        ),
        (
            "import { $state } from 'fict'; function App() { function nested() { const value = $state(0); } return null; }",
            "FICT-PLACEMENT-STATE-NESTED",
        ),
        (
            "import { $state } from 'fict'; function App() { function Child() { const value = $state(0); return value; } return null; }",
            "FICT-PLACEMENT-STATE-NESTED",
        ),
        (
            "import { $state } from 'fict'; function App() { if (ready) { const value = $state(0); } return null; }",
            "FICT-PLACEMENT-STATE-CONTROL",
        ),
        (
            "import { $state } from 'fict'; function App() { consume($state(0)); return null; }",
            "FICT-PLACEMENT-STATE-TARGET",
        ),
        (
            "import { $state } from 'fict'; function App() { const { value } = $state({ value: 0 }); return null; }",
            "FICT-PLACEMENT-STATE-DESTRUCTURE",
        ),
    ];
    for (source, expected) in cases {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{source}");
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == expected),
            "{source}: {:?}",
            output.diagnostics
        );
    }

    for source in [
        "import { $state } from 'fict'; function App() { const value = $state(0); return value; }",
        "import { $state } from 'fict'; function useValue() { const value = $state(0); return value; }",
    ] {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
        assert!(output.hir.is_some());
    }
}

#[test]
fn enforces_effect_and_memo_control_flow_placement() {
    let cases = [
        (
            "import { $effect } from 'fict'; function helper() { $effect(() => {}); }",
            "FICT-PLACEMENT-EFFECT-OWNER",
        ),
        (
            "import { $effect } from 'fict'; function App() { if (ready) $effect(() => {}); return null; }",
            "FICT-PLACEMENT-EFFECT-CONTROL",
        ),
        (
            "import { $effect } from 'fict'; function App() { function nested() { $effect(() => {}); } return null; }",
            "FICT-PLACEMENT-EFFECT-NESTED",
        ),
        (
            "import { $memo } from 'fict'; function App() { while (ready) { $memo(() => value); } return null; }",
            "FICT-PLACEMENT-MEMO-CONTROL",
        ),
    ];
    for (source, expected) in cases {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{source}");
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == expected),
            "{source}: {:?}",
            output.diagnostics
        );
    }

    for source in [
        "import { $effect } from 'fict'; $effect(() => {});",
        "import { $memo } from 'fict'; { $memo(() => value); }",
    ] {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
        assert!(output.hir.is_some());
    }
}

#[test]
fn configured_reactive_scope_is_a_binding_resolved_state_owner() {
    let source = r#"
        import { renderHook as run } from './host';
        import { $state } from 'fict';
        run(() => {
            const value = $state(0);
            return value;
        });
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScript),
        &HirBuildOptions {
            reactive_scopes: vec!["run".into()],
            ..HirBuildOptions::default()
        },
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    assert!(output.hir.is_some());
}

#[test]
fn enforces_direct_hook_owner_and_control_flow_placement_by_binding() {
    let cases = [
        (
            "import { useCounter } from './hooks'; useCounter();",
            "FICT-PLACEMENT-HOOK-OWNER",
        ),
        (
            "import { useCounter } from './hooks'; function App() { if (ready) useCounter(); return null; }",
            "FICT-PLACEMENT-HOOK-CONTROL",
        ),
        (
            "import { useCounter } from './hooks'; function App() { ready && useCounter(); return null; }",
            "FICT-PLACEMENT-HOOK-CONTROL",
        ),
        (
            "import { useCounter } from './hooks'; function App() { function Child() { useCounter(); return null; } return null; }",
            "FICT-PLACEMENT-HOOK-CONTROL",
        ),
    ];
    for (source, expected) in cases {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{source}");
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == expected)
        );
    }

    for source in [
        "import { useCounter } from './hooks'; function App() { useCounter(); return null; }",
        "function helper(useCounter) { return useCounter(); }",
        "import { useCounter as counter } from './hooks'; counter();",
    ] {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(
            output.diagnostics.is_empty(),
            "{source}: {:?}",
            output.diagnostics
        );
    }
}

#[test]
fn enforces_namespace_and_member_hook_placement() {
    let cases = [
        (
            "import * as hooks from './hooks'; hooks.useCounter();",
            "FICT-PLACEMENT-HOOK-OWNER",
        ),
        (
            "import * as hooks from './hooks'; function App() { if (ready) hooks.useCounter(); return null; }",
            "FICT-PLACEMENT-HOOK-CONTROL",
        ),
        (
            "const api = { useCounter() {} }; function App() { if (ready) api['useCounter'](); return null; }",
            "FICT-PLACEMENT-HOOK-CONTROL",
        ),
    ];
    for (source, expected) in cases {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(output.hir.is_none(), "{source}");
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.as_str() == expected)
        );
    }

    for source in [
        "import * as hooks from './hooks'; function App() { hooks.useCounter?.(); return null; }",
        "const api = { useCounter() {} }; api.useCounter();",
    ] {
        let output = build_hir(
            source,
            options(OxcSourceLanguage::JavaScript),
            &HirBuildOptions::default(),
        );
        assert!(
            output.diagnostics.is_empty(),
            "{source}: {:?}",
            output.diagnostics
        );
    }
}
