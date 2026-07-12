use crate::{BindingId, FunctionId, Origin, TemplateId, ValueId};

/// JSX tag identity after semantic binding resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JsxElementName {
    /// Host element name such as `div` or `svg:path`.
    Intrinsic(String),
    /// Component referenced by a semantic binding.
    Component(BindingId),
    /// Member component whose root is a semantic binding.
    Member {
        /// Root component or namespace binding.
        root: BindingId,
        /// Static member path in source order.
        properties: Vec<String>,
    },
    /// Computed element type evaluated by HIR.
    Dynamic(ValueId),
}

/// Value of a named JSX attribute.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JsxAttributeValue {
    /// Attribute with no explicit value, equivalent to `true`.
    ImplicitTrue,
    /// Static JSX text after entity decoding.
    Text(String),
    /// Dynamic HIR value.
    Expression(ValueId),
    /// Nested JSX node used as an attribute value.
    Node(Box<JsxNode>),
}

/// Named or spread JSX attribute in source order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JsxAttribute {
    /// A named attribute.
    Named {
        /// Attribute name, including any namespace prefix.
        name: String,
        /// Attribute value.
        value: JsxAttributeValue,
        /// Source provenance.
        origin: Origin,
    },
    /// A spread attribute such as `{...props}`.
    Spread {
        /// Spread input value.
        value: ValueId,
        /// Source provenance.
        origin: Origin,
    },
}

/// JSX child in authored order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JsxChild {
    /// Static JSX text after entity decoding.
    Text {
        /// Text value.
        value: String,
        /// Source provenance.
        origin: Origin,
    },
    /// Dynamic expression container.
    Expression {
        /// Evaluated HIR value.
        value: ValueId,
        /// Source provenance.
        origin: Origin,
    },
    /// Nested element or fragment.
    Node(Box<JsxNode>),
    /// JSX spread child.
    Spread {
        /// Iterable or child collection value.
        value: ValueId,
        /// Source provenance.
        origin: Origin,
    },
}

/// JSX element with binding-aware name, attributes, and children.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsxElement {
    /// Element type.
    pub name: JsxElementName,
    /// Attributes in authored order.
    pub attributes: Vec<JsxAttribute>,
    /// Children in authored order.
    pub children: Vec<JsxChild>,
    /// Source provenance for the complete element.
    pub origin: Origin,
}

/// JSX tree node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JsxNode {
    /// Named host or component element.
    Element(JsxElement),
    /// Source fragment syntax.
    Fragment {
        /// Fragment children in authored order.
        children: Vec<JsxChild>,
        /// Source provenance for the fragment.
        origin: Origin,
    },
}

/// JSX template owned by one function.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsxTemplate {
    /// Request-local template identity.
    pub id: TemplateId,
    /// Function whose value arena is referenced by dynamic slots.
    pub owner: FunctionId,
    /// Template root.
    pub root: JsxNode,
    /// Source provenance for the complete template.
    pub origin: Origin,
}

#[cfg(test)]
mod tests {
    use fict_diagnostics::SourceSpan;

    use crate::{BindingId, Origin, ValueId};

    use super::{JsxAttribute, JsxAttributeValue, JsxElement, JsxElementName, JsxNode};

    #[test]
    fn component_tags_use_binding_identity() {
        let origin = Origin::source(SourceSpan::new(0, 7).expect("valid span"));
        let node = JsxNode::Element(JsxElement {
            name: JsxElementName::Component(BindingId::new(4)),
            attributes: vec![JsxAttribute::Named {
                name: "value".into(),
                value: JsxAttributeValue::Expression(ValueId::new(2)),
                origin,
            }],
            children: Vec::new(),
            origin,
        });

        let JsxNode::Element(element) = node else {
            panic!("expected element")
        };
        assert_eq!(element.name, JsxElementName::Component(BindingId::new(4)));
    }
}
