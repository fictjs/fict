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
        const three = selector(() => 3);
        const four = F.$store({ value: 4 });
        const five = F['resource'](() => 5);
        const six = F.createSelector(() => 6);
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
        .find(|diagnostic| diagnostic.code.as_str() == "FICT-M")
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
        .find(|diagnostic| diagnostic.code.as_str() == "FICT-M")
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
    let key = list
        .key
        .and_then(|key| key.primary_span)
        .expect("source key span");
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
fn models_direct_unkeyed_map_callbacks_with_index_identity() {
    let source = r#"
        import { $state } from 'fict';
        export function App() {
            let rows = $state([{ name: 'A' }]);
            return <ul>{rows.map((row, index) => <li data-index={index}>{row.name}</li>)}</ul>;
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
        panic!("unkeyed map metadata")
    };
    assert!(list.key.is_none());
    assert!(list.key_source.is_none());
    assert!(list.key_alias_initializer.is_none());
    assert_eq!(list.item_references.len(), 1);
    assert_eq!(list.index_references.len(), 1);
    assert!(list.needs_index);

    let spread = build_hir(
        "import { $state } from 'fict'; export function App() { let rows = $state([{ name: 'A' }]); return <ul>{rows.map(row => <li {...row}>{row.name}</li>)}</ul>; }",
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(spread.diagnostics.is_empty(), "{:?}", spread.diagnostics);
    let spread = spread.hir.expect("verified fallback HIR");
    let fict_hir::JsxNode::Element(root) = &spread.templates[0].root else {
        panic!("intrinsic list root")
    };
    assert!(matches!(
        &root.children[0],
        fict_hir::JsxChild::Expression { list: None, .. }
    ));
}

#[test]
fn traces_trusted_array_method_chains_to_their_base_receiver() {
    let source = r#"
        import { $state } from 'fict';
        export function App() {
            let rows = $state([{ id: 1, visible: true }]);
            return <ul>{rows.filter(row => row.visible).map(row => <li key={row.id}>{row.id}</li>)}</ul>;
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
        panic!("array chain map metadata")
    };
    let fict_hir::JsxListReceiver::Binding {
        root: receiver,
        projected: false,
        ..
    } = list.receiver
    else {
        panic!("array chain base binding")
    };
    assert_eq!(hir.bindings[receiver.as_usize()].display_name, "rows");
    let items = list.items.primary_span.expect("array chain items origin");
    assert_eq!(
        &source[items.start() as usize..items.end() as usize],
        "rows.filter(row => row.visible)"
    );
}

#[test]
fn distinguishes_optional_map_members_from_optional_calls() {
    let source = r#"
        import { $state } from 'fict';
        export function App() {
            let rows = $state([{ id: 1 }]);
            return <ul>{rows?.map(row => <li key={row.id}>{row.id}</li>)}</ul>;
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
        panic!("optional map metadata")
    };
    assert!(list.optional);

    let optional_call = build_hir(
        "import { $state } from 'fict'; export function App() { let rows = $state([{ id: 1 }]); return <ul>{rows.map?.(row => <li key={row.id}>{row.id}</li>)}</ul>; }",
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(
        optional_call.diagnostics.is_empty(),
        "{:?}",
        optional_call.diagnostics
    );
    let optional_call = optional_call.hir.expect("verified fallback HIR");
    let fict_hir::JsxNode::Element(root) = &optional_call.templates[0].root else {
        panic!("intrinsic list root")
    };
    assert!(matches!(
        &root.children[0],
        fict_hir::JsxChild::Expression { list: None, .. }
    ));
}

#[test]
fn models_context_free_anonymous_function_map_callbacks() {
    let source = r#"
        import { $state } from 'fict';
        export function App() {
            let rows = $state([{ id: 1, name: 'A' }]);
            return <ul>{rows.map(function (row, index) { return <li key={row.id}>{index}:{row.name}</li>; })}</ul>;
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
        panic!("function map metadata")
    };
    assert!(!hir.functions[list.callback.as_usize()].flags.is_arrow);
    assert_eq!(list.item_references.len(), 1);
    assert_eq!(list.index_references.len(), 1);

    for callback in [
        "function (row) { return <li key={row.id}>{this.label}</li>; }",
        "function (row) { return <li key={row.id}>{arguments.length}</li>; }",
        "function render(row) { return <li key={row.id}>{row.id}</li>; }",
    ] {
        let fallback_source = format!(
            "import {{ $state }} from 'fict'; export function App() {{ let rows = $state([{{ id: 1 }}]); return <ul>{{rows.map({callback})}}</ul>; }}"
        );
        let fallback = build_hir(
            &fallback_source,
            options(OxcSourceLanguage::JavaScriptJsx),
            &HirBuildOptions::default(),
        );
        assert!(
            fallback.diagnostics.is_empty(),
            "{:?}",
            fallback.diagnostics
        );
        let fallback = fallback.hir.expect("verified fallback HIR");
        let fict_hir::JsxNode::Element(root) = &fallback.templates[0].root else {
            panic!("intrinsic list root")
        };
        assert!(matches!(
            &root.children[0],
            fict_hir::JsxChild::Expression { list: None, .. }
        ));
    }
}

#[test]
fn models_simple_component_object_props_with_exact_read_origins() {
    let source = r#"
        function Child({ value: renamed, label = String(renamed) } = { value: 'fallback' }) {
            return <span>{label}:{renamed}</span>;
        }
        function Method({ value, value: alias }) {
            return <span>{value.toString()}:{alias}</span>;
        }
        function Nested({ user: { name, profile: { age = 18 } } }) {
            return <span>{name}:{age}</span>;
        }
        function Rest({ id, title: heading, ...rest }) {
            return <span>{id}:{heading}:{rest.extra}</span>;
        }
        function Mutated({ reactive, local, count = 1, user: { name }, alias }) {
            local = 'changed';
            count++;
            name = name.toUpperCase();
            ({ alias } = { alias: 'reassigned' });
            return <span>{reactive}:{local}:{count}:{name}:{alias}</span>;
        }
        export function App(value) {
            return <><Child value={value} label="ok" /><Method value={value} /><Nested user={{ name: 'Ada', profile: {} }} /><Rest id="x" title="Title" extra="ok" /><Mutated reactive={value} local="initial" user={{ name: 'ann' }} alias="initial" /></>;
        }
    "#;
    let output = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let hir = output.hir.expect("verified HIR");
    let child = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "Child")
        })
        .expect("Child component");
    assert_eq!(child.kind, FunctionKind::Component);
    assert!(child.parameters[0].binding.is_none());
    let parameter_default = child.parameters[0]
        .default_value
        .and_then(|origin| origin.primary_span)
        .expect("component parameter default expression");
    assert_eq!(
        &source[parameter_default.start() as usize..parameter_default.end() as usize],
        "{ value: 'fallback' }"
    );
    let properties = child.parameters[0]
        .object_properties
        .as_ref()
        .expect("modeled object props");
    assert_eq!(properties.len(), 2);
    assert_eq!(properties[0].path, ["value"]);
    assert_eq!(properties[1].path, ["label"]);
    assert!(properties[0].default_value.is_none());
    let label_default = properties[1]
        .default_value
        .and_then(|origin| origin.primary_span)
        .expect("label default expression");
    assert_eq!(
        &source[label_default.start() as usize..label_default.end() as usize],
        "String(renamed)"
    );
    assert_eq!(properties[0].references.len(), 2);
    assert_eq!(properties[1].references.len(), 1);
    for property in properties {
        for reference in &property.references {
            let reference = reference.primary_span.expect("prop reference origin");
            assert_eq!(
                &source[reference.start() as usize..reference.end() as usize],
                hir.bindings[property.binding.as_usize()].display_name
            );
        }
    }
    let method = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "Method")
        })
        .expect("Method component");
    let method_properties = method.parameters[0]
        .object_properties
        .as_ref()
        .expect("method receiver props remain modeled");
    assert_eq!(method_properties.len(), 2);
    assert!(
        method_properties
            .iter()
            .all(|property| property.path == ["value"])
    );
    let nested = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "Nested")
        })
        .expect("Nested component");
    let nested_properties = nested.parameters[0]
        .object_properties
        .as_ref()
        .expect("nested object props remain modeled");
    assert_eq!(nested_properties.len(), 2);
    assert_eq!(nested_properties[0].path, ["user", "name"]);
    assert_eq!(nested_properties[0].checks.len(), 1);
    assert_eq!(nested_properties[0].checks[0].path, ["user"]);
    assert_eq!(nested_properties[1].path, ["user", "profile", "age"]);
    assert_eq!(nested_properties[1].checks.len(), 1);
    assert_eq!(nested_properties[1].checks[0].path, ["user", "profile"]);
    assert!(nested_properties[1].default_value.is_some());
    let rest = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "Rest")
        })
        .expect("Rest component");
    let rest_binding = rest.parameters[0]
        .object_rest
        .as_ref()
        .expect("top-level props rest remains modeled");
    assert_eq!(rest_binding.excluded, ["id", "title"]);
    assert_eq!(
        hir.bindings[rest_binding.binding.as_usize()].display_name,
        "rest"
    );
    let mutated = hir
        .functions
        .iter()
        .find(|function| {
            function
                .binding
                .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == "Mutated")
        })
        .expect("Mutated component");
    let mutated_properties = mutated.parameters[0]
        .object_properties
        .as_ref()
        .expect("mutated props remain modeled");
    assert_eq!(mutated_properties.len(), 5);
    assert_eq!(mutated_properties[0].path, ["reactive"]);
    assert_eq!(
        mutated_properties[0].mode,
        fict_hir::HirObjectParameterMode::Accessor
    );
    assert_eq!(mutated_properties[0].references.len(), 1);
    assert_eq!(mutated_properties[1].path, ["local"]);
    assert_eq!(
        mutated_properties[1].mode,
        fict_hir::HirObjectParameterMode::Mutable
    );
    assert!(mutated_properties[1].references.is_empty());
    assert_eq!(mutated_properties[2].path, ["count"]);
    assert_eq!(
        mutated_properties[2].mode,
        fict_hir::HirObjectParameterMode::Mutable
    );
    assert!(mutated_properties[2].references.is_empty());
    assert!(mutated_properties[2].default_value.is_some());
    assert_eq!(mutated_properties[3].path, ["user", "name"]);
    assert_eq!(
        mutated_properties[3].mode,
        fict_hir::HirObjectParameterMode::Mutable
    );
    assert!(mutated_properties[3].references.is_empty());
    assert_eq!(mutated_properties[4].path, ["alias"]);
    assert_eq!(
        mutated_properties[4].mode,
        fict_hir::HirObjectParameterMode::Mutable
    );
    assert!(mutated_properties[4].references.is_empty());

    let callable = build_hir(
        "function Button({ onClick }) { const invoke = onClick; return <button onClick={() => invoke.call(null)}>go</button>; } function Mixed({ label }) { label(); return <span>{String(label)}</span>; } export function App(fn) { return <><Button onClick={fn} /><Mixed label={fn} /></>; }",
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(
        callable.diagnostics.is_empty(),
        "{:?}",
        callable.diagnostics
    );
    let callable = callable.hir.expect("verified callable props HIR");
    let button = callable
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                callable.bindings[binding.as_usize()].display_name == "Button"
            })
        })
        .expect("Button component");
    let callable_properties = button.parameters[0]
        .object_properties
        .as_ref()
        .expect("call-only prop remains modeled");
    assert_eq!(callable_properties.len(), 1);
    assert_eq!(
        callable_properties[0].mode,
        fict_hir::HirObjectParameterMode::Value
    );
    assert!(callable_properties[0].references.is_empty());
    let mixed = callable
        .functions
        .iter()
        .find(|function| {
            function.binding.is_some_and(|binding| {
                callable.bindings[binding.as_usize()].display_name == "Mixed"
            })
        })
        .expect("Mixed component");
    let mixed_property = &mixed.parameters[0]
        .object_properties
        .as_ref()
        .expect("mixed callable prop remains modeled")[0];
    assert_eq!(
        mixed_property.mode,
        fict_hir::HirObjectParameterMode::Accessor
    );
    assert_eq!(mixed_property.references.len(), 2);
}

#[test]
fn diagnoses_unsupported_component_props_patterns_with_strict_fallback_policy() {
    let source = r#"
        const key = 'name';
        function ArrayProps({ list: [first, second] }) {
            return <p>{first}:{second}</p>;
        }
        function ArrayRest({ list: [head, ...tail] }) {
            return <p>{head}:{tail.length}</p>;
        }
        function Computed({ [key]: value }) {
            return <p>{value}</p>;
        }
        function EmptyKey({ '': value }) {
            return <p>{value}</p>;
        }
        function NestedRest({ user: { ...userRest } }) {
            return <p>{String(userRest.name)}</p>;
        }
    "#;
    let strict = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(strict.hir.is_none());
    assert_eq!(
        strict
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<Vec<_>>(),
        [
            "FICT-P001",
            "FICT-P002",
            "FICT-P003",
            "FICT-P003",
            "FICT-P004"
        ]
    );
    assert!(strict.diagnostics.iter().all(|diagnostic| {
        diagnostic.severity == fict_diagnostics::DiagnosticSeverity::Error
            && diagnostic.guarantee_class == fict_diagnostics::GuaranteeClass::Fallback
            && diagnostic.primary_span.is_some()
    }));
    let issue_sources = strict
        .diagnostics
        .iter()
        .map(|diagnostic| {
            let span = diagnostic.primary_span.expect("props issue span");
            &source[span.start() as usize..span.end() as usize]
        })
        .collect::<Vec<_>>();
    assert_eq!(
        issue_sources,
        [
            "[first, second]",
            "[head, ...tail]",
            "[key]: value",
            "'': value",
            "...userRest"
        ]
    );

    let fallback = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions {
            strict_guarantee: false,
            ..HirBuildOptions::default()
        },
    );
    assert!(
        fallback.diagnostics.iter().all(|diagnostic| {
            diagnostic.severity == fict_diagnostics::DiagnosticSeverity::Warning
        }),
        "{:?}",
        fallback.diagnostics
    );
    let hir = fallback.hir.expect("fallback HIR");
    for name in [
        "ArrayProps",
        "ArrayRest",
        "Computed",
        "EmptyKey",
        "NestedRest",
    ] {
        let function = hir
            .functions
            .iter()
            .find(|function| {
                function
                    .binding
                    .is_some_and(|binding| hir.bindings[binding.as_usize()].display_name == name)
            })
            .unwrap_or_else(|| panic!("{name} component"));
        assert_eq!(function.kind, FunctionKind::Component);
        assert!(function.parameters[0].object_properties.is_none());
    }
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
fn enforces_binding_aware_selector_control_flow_placement() {
    let source = r#"
        import { createSelector as select } from 'fict';
        import * as Advanced from 'fict/advanced';

        function Demo({ ready, items, value }) {
            if (ready) select(() => value);
            for (const item of items) Advanced.createSelector(() => item);
            ready && select(() => value);
            if (ready) select?.(() => value);
            select(() => value) && ready;
            return <div>{ready && select(() => value)(value)}</div>;
        }

        function Nested({ ready, value }) {
            if (ready) {
                const setup = () => select(() => value);
                console.log(setup);
            }
            return <div />;
        }

        function Immediate({ ready, value }) {
            if (ready) (() => select(() => value))();
            return <div />;
        }

        function Shadow({ ready, value }, select) {
            if (ready) select(() => value);
            return <div />;
        }
    "#;
    let strict = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions::default(),
    );
    assert!(strict.hir.is_none());
    let findings = strict
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code.as_str() == "FICT-R004")
        .collect::<Vec<_>>();
    assert_eq!(findings.len(), 5, "{:?}", strict.diagnostics);
    assert!(findings.iter().all(|diagnostic| {
        diagnostic.severity == fict_diagnostics::DiagnosticSeverity::Error
            && diagnostic.guarantee_class == fict_diagnostics::GuaranteeClass::Fallback
    }));
    let finding_sources = findings
        .iter()
        .map(|diagnostic| {
            let span = diagnostic.primary_span.expect("selector placement span");
            &source[span.start() as usize..span.end() as usize]
        })
        .collect::<Vec<_>>();
    assert_eq!(
        finding_sources,
        [
            "select(() => value)",
            "Advanced.createSelector(() => item)",
            "select(() => value)",
            "select?.(() => value)",
            "select(() => value)"
        ]
    );

    let fallback = build_hir(
        source,
        options(OxcSourceLanguage::JavaScriptJsx),
        &HirBuildOptions {
            strict_guarantee: false,
            reactive_creation_control_flow_severity: fict_diagnostics::DiagnosticSeverity::Warning,
            ..HirBuildOptions::default()
        },
    );
    assert!(fallback.hir.is_some(), "{:?}", fallback.diagnostics);
    assert_eq!(
        fallback
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code.as_str() == "FICT-R004")
            .count(),
        5
    );
    assert!(fallback.diagnostics.iter().all(|diagnostic| {
        diagnostic.severity == fict_diagnostics::DiagnosticSeverity::Warning
    }));
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
