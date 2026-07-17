use fict_diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use oxc::{
    ast::ast::{JSXAttributeItem, JSXAttributeName, JSXChild, JSXElement, JSXExpression, Program},
    ast_visit::{Visit, walk::walk_jsx_element},
    semantic::Scoping,
};

use super::{RawJsxName, raw_jsx_name, source_span};

pub(super) fn diagnostics(program: &Program<'_>, scoping: &Scoping) -> Vec<Diagnostic> {
    let mut collector = DangerousHtmlCollector {
        scoping,
        diagnostics: Vec::new(),
    };
    collector.visit_program(program);
    collector.diagnostics
}

struct DangerousHtmlCollector<'semantic> {
    scoping: &'semantic Scoping,
    diagnostics: Vec<Diagnostic>,
}

impl<'a> Visit<'a> for DangerousHtmlCollector<'_> {
    fn visit_jsx_element(&mut self, element: &JSXElement<'a>) {
        if matches!(
            raw_jsx_name(self.scoping, &element.opening_element.name),
            RawJsxName::Intrinsic(_)
        ) && let Some(attribute_span) = dangerous_html_attribute(element)
            && let Some(child_span) = renderable_child(element)
        {
            self.diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::new("FICT-J004").expect("diagnostic literal"),
                    DiagnosticSeverity::Error,
                    "dangerouslySetInnerHTML cannot be used with JSX children",
                )
                .with_primary_span(attribute_span)
                .with_secondary_label(child_span, "conflicting JSX child")
                .with_help("remove the JSX children or remove dangerouslySetInnerHTML")
                .with_guarantee_class(GuaranteeClass::Unsupported),
            );
        }
        walk_jsx_element(self, element);
    }
}

fn dangerous_html_attribute(element: &JSXElement<'_>) -> Option<SourceSpan> {
    element
        .opening_element
        .attributes
        .iter()
        .find_map(|attribute| match attribute {
            JSXAttributeItem::Attribute(attribute)
                if matches!(
                    &attribute.name,
                    JSXAttributeName::Identifier(name)
                        if name.name == "dangerouslySetInnerHTML"
                ) =>
            {
                Some(source_span(attribute.span))
            }
            JSXAttributeItem::Attribute(_) | JSXAttributeItem::SpreadAttribute(_) => None,
        })
}

fn renderable_child(element: &JSXElement<'_>) -> Option<SourceSpan> {
    element.children.iter().find_map(|child| match child {
        JSXChild::Text(text)
            if crate::jsx_text::normalize_text(text.value.as_str())
                .is_some_and(|value| !value.is_empty()) =>
        {
            Some(source_span(text.span))
        }
        JSXChild::Element(child) => Some(source_span(child.span)),
        JSXChild::Fragment(child) => Some(source_span(child.span)),
        JSXChild::ExpressionContainer(container)
            if !matches!(container.expression, JSXExpression::EmptyExpression(_)) =>
        {
            Some(source_span(container.span))
        }
        JSXChild::Spread(child) => Some(source_span(child.span)),
        JSXChild::Text(_) | JSXChild::ExpressionContainer(_) => None,
    })
}
