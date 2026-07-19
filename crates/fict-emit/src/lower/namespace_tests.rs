use super::*;
use fict_diagnostics::SourceSpan;
use fict_hir::{JsxElement, Origin};
fn test_origin() -> Origin {
    Origin::source(SourceSpan::empty(0))
}
fn element(tag: &str, attributes: Vec<JsxAttribute>, children: Vec<JsxChild>) -> JsxNode {
    JsxNode::Element(JsxElement {
        name: JsxElementName::Intrinsic(tag.to_owned()),
        attributes,
        children,
        origin: test_origin(),
    })
}
fn node(node: JsxNode) -> JsxChild {
    JsxChild::Node(Box::new(node))
}
fn spread(value: u32) -> JsxAttribute {
    JsxAttribute::Spread {
        value: ValueId::new(value),
        getter: false,
        origin: test_origin(),
    }
}
fn expression(value: u32) -> JsxChild {
    JsxChild::Expression {
        value: ValueId::new(value),
        kind: fict_hir::JsxExpressionKind::Value,
        contains_fragment: false,
        function_like: false,
        list: None,
        embedded_nodes: Vec::new(),
        origin: test_origin(),
    }
}
#[test]
fn resolves_svg_integration_points_and_normalizes_attributes() {
    let root = element(
        "svg",
        Vec::new(),
        vec![
            node(element(
                "path",
                vec![
                    JsxAttribute::Named {
                        name: "strokeWidth".into(),
                        value: JsxAttributeValue::Text("2".into()),
                        origin: test_origin(),
                    },
                    JsxAttribute::Named {
                        name: "xlinkHref".into(),
                        value: JsxAttributeValue::Expression {
                            value: ValueId::new(9),
                            function_like: false,
                            contains_fragment: false,
                        },
                        origin: test_origin(),
                    },
                    spread(0),
                ],
                Vec::new(),
            )),
            node(element(
                "foreignObject",
                Vec::new(),
                vec![node(element("div", vec![spread(1)], Vec::new()))],
            )),
            node(element(
                "title",
                Vec::new(),
                vec![node(element("span", vec![spread(2)], Vec::new()))],
            )),
            node(element("math", vec![spread(3)], Vec::new())),
        ],
    );
    let serialized = serialize_template(&root).expect("SVG namespace serialization");
    assert_eq!(serialized.namespace, DomNamespace::Svg);
    assert!(serialized.html.contains("stroke-width=\"2\""));
    assert!(serialized.bindings.iter().any(|binding| matches!(
        binding,
        TemplateBinding::Attribute {
            kind: DomBindingKind::Attribute(name),
            ..
        } if name == "xlink:href"
    )));
    let spread_namespaces: Vec<_> = serialized
        .bindings
        .iter()
        .filter_map(|binding| match binding {
            TemplateBinding::Spread { namespace, .. } => Some(*namespace),
            _ => None,
        })
        .collect();
    assert_eq!(
        spread_namespaces,
        [
            DomNamespace::Svg,
            DomNamespace::Html,
            DomNamespace::Html,
            DomNamespace::Svg,
        ]
    );
}
#[test]
fn resolves_mathml_text_annotation_and_runtime_parent_contexts() {
    let root = element(
        "math",
        Vec::new(),
        vec![
            node(element(
                "mtext",
                Vec::new(),
                vec![
                    node(element("span", vec![spread(0)], Vec::new())),
                    node(element("mglyph", vec![spread(1)], Vec::new())),
                    expression(10),
                ],
            )),
            node(element(
                "annotation-xml",
                vec![JsxAttribute::Named {
                    name: "ENCODING".into(),
                    value: JsxAttributeValue::Text("text/html".into()),
                    origin: test_origin(),
                }],
                vec![node(element("div", vec![spread(2)], Vec::new()))],
            )),
            node(element(
                "annotation-xml",
                vec![JsxAttribute::Named {
                    name: "encoding".into(),
                    value: JsxAttributeValue::Text("application/xml".into()),
                    origin: test_origin(),
                }],
                vec![node(element("mi", vec![spread(3)], Vec::new()))],
            )),
            node(element(
                "annotation-xml",
                vec![JsxAttribute::Named {
                    name: "encoding".into(),
                    value: JsxAttributeValue::Expression {
                        value: ValueId::new(11),
                        function_like: false,
                        contains_fragment: false,
                    },
                    origin: test_origin(),
                }],
                vec![expression(12)],
            )),
        ],
    );
    let serialized = serialize_template(&root).expect("MathML namespace serialization");
    assert_eq!(serialized.namespace, DomNamespace::MathMl);
    let spread_namespaces: Vec<_> = serialized
        .bindings
        .iter()
        .filter_map(|binding| match binding {
            TemplateBinding::Spread { namespace, .. } => Some(*namespace),
            _ => None,
        })
        .collect();
    assert_eq!(
        spread_namespaces,
        [
            DomNamespace::Html,
            DomNamespace::MathMl,
            DomNamespace::Html,
            DomNamespace::MathMl,
        ]
    );
    assert!(serialized.bindings.iter().any(|binding| matches!(
        binding,
        TemplateBinding::Child {
            value,
            namespace: DomNamespace::MathMlTextIntegration,
            ..
        } if *value == ValueId::new(10)
    )));
    assert!(serialized.bindings.iter().any(|binding| matches!(
        binding,
        TemplateBinding::Child {
            value,
            namespace: DomNamespace::Parent,
            ..
        } if *value == ValueId::new(12)
    )));
}
#[test]
fn materializes_implicit_table_groups_and_browser_paths() {
    let root = element(
        "table",
        Vec::new(),
        vec![
            node(element("col", vec![spread(0)], Vec::new())),
            node(element("col", Vec::new(), Vec::new())),
            node(element(
                "tr",
                Vec::new(),
                vec![node(element("td", vec![spread(1)], Vec::new()))],
            )),
            node(element(
                "tr",
                Vec::new(),
                vec![node(element("td", vec![spread(2)], Vec::new()))],
            )),
        ],
    );
    let serialized = serialize_template(&root).expect("table parser serialization");
    assert_eq!(
        serialized.html,
        "<table><colgroup><col><col></colgroup><tbody><tr><td></td></tr><tr><td></td></tr></tbody></table>"
    );
    let paths: Vec<_> = serialized
        .bindings
        .iter()
        .filter_map(|binding| match binding {
            TemplateBinding::Spread { path, .. } => Some(path.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(paths, [vec![0, 0], vec![1, 0, 0], vec![1, 1, 0]]);
}
#[test]
fn slots_static_children_when_annotation_namespace_is_runtime_selected() {
    let root = element(
        "math",
        Vec::new(),
        vec![node(element(
            "annotation-xml",
            vec![spread(0)],
            vec![node(element("mi", Vec::new(), Vec::new()))],
        ))],
    );
    let serialized = serialize_template(&root).expect("parent-derived child slot");
    assert_eq!(
        serialized.html,
        "<math><annotation-xml><!----></annotation-xml></math>"
    );
    assert!(serialized.bindings.iter().any(|binding| matches!(
        binding,
        TemplateBinding::NodeChild {
            namespace: DomNamespace::Parent,
            ..
        }
    )));
}
#[test]
fn classifies_standalone_foreign_roots_and_rejects_void_children() {
    assert_eq!(
        serialize_template(&element("circle", Vec::new(), Vec::new()))
            .expect("standalone SVG")
            .namespace,
        DomNamespace::Svg
    );
    assert_eq!(
        serialize_template(&element("mi", Vec::new(), Vec::new()))
            .expect("standalone MathML")
            .namespace,
        DomNamespace::MathMl
    );
    let invalid = element(
        "input",
        Vec::new(),
        vec![JsxChild::Text {
            value: "child".into(),
            origin: test_origin(),
        }],
    );
    let diagnostics = serialize_template(&invalid).expect_err("void child is invalid");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|diagnostic| diagnostic.code.as_str() == "FICT-EMIT-VOID-CHILD")
    );
}
#[test]
fn preserves_explicit_resumable_event_intent_without_polluting_the_dom_event_name() {
    let root = element(
        "button",
        vec![
            JsxAttribute::Named {
                name: "onClick$".into(),
                value: JsxAttributeValue::Expression {
                    value: ValueId::new(1),
                    function_like: true,
                    contains_fragment: false,
                },
                origin: test_origin(),
            },
            JsxAttribute::Named {
                name: "on:Input$".into(),
                value: JsxAttributeValue::Expression {
                    value: ValueId::new(2),
                    function_like: true,
                    contains_fragment: false,
                },
                origin: test_origin(),
            },
            JsxAttribute::Named {
                name: "onBlur".into(),
                value: JsxAttributeValue::Expression {
                    value: ValueId::new(3),
                    function_like: true,
                    contains_fragment: false,
                },
                origin: test_origin(),
            },
        ],
        Vec::new(),
    );
    let serialized = serialize_template(&root).expect("event serialization");
    let events: Vec<_> = serialized
        .bindings
        .iter()
        .filter_map(|binding| match binding {
            TemplateBinding::Event {
                event,
                resumable_explicit,
                ..
            } => Some((event.as_str(), *resumable_explicit)),
            _ => None,
        })
        .collect();
    assert_eq!(events, [("click", true), ("input", true), ("blur", false)]);
}
#[test]
fn normalizes_dom_event_options_and_pointer_capture_names() {
    let (event, explicit, options) =
        parse_event_attribute("onClickCapturePassiveOnce$").expect("combined event");
    assert_eq!(event, "click");
    assert!(explicit && options.capture && options.passive && options.once);
    let (event, explicit, options) =
        parse_event_attribute("onGotPointerCapture$").expect("pointer capture event");
    assert_eq!(event, "gotpointercapture");
    assert!(explicit);
    assert!(options.is_empty());
    let (event, explicit, options) =
        parse_event_attribute("onGotPointerCaptureOnce").expect("pointer capture once event");
    assert_eq!(event, "gotpointercapture");
    assert!(!explicit);
    assert!(options.once && !options.capture && !options.passive);
    let (event, explicit, options) =
        parse_event_attribute("oncapture:Input$").expect("namespaced capture event");
    assert_eq!(event, "input");
    assert!(explicit && options.capture);
    assert!(parse_event_attribute("onclick").is_none());
}
