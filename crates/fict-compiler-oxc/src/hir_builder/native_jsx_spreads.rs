use std::collections::BTreeSet;

use fict_diagnostics::SourceSpan;
use oxc::{
    ast::ast::{JSXAttributeItem, JSXElement, JSXElementName, Program},
    ast_visit::{Visit, walk::walk_jsx_element},
};

use super::source_span;

/// Return the first spread attribute on every intrinsic JSX element.
///
/// This intentionally follows the authored tag category instead of resolved binding names:
/// lowercase/custom-element and namespaced tags are native, while component/member/`this` tags
/// belong to component props lowering.
pub(super) fn collect(program: &Program<'_>) -> Vec<SourceSpan> {
    let mut collector = NativeSpreadCollector {
        spans: BTreeSet::new(),
    };
    collector.visit_program(program);
    collector.spans.into_iter().collect()
}

struct NativeSpreadCollector {
    spans: BTreeSet<SourceSpan>,
}

impl<'a> Visit<'a> for NativeSpreadCollector {
    fn visit_jsx_element(&mut self, element: &JSXElement<'a>) {
        if matches!(
            element.opening_element.name,
            JSXElementName::Identifier(_) | JSXElementName::NamespacedName(_)
        ) && let Some(JSXAttributeItem::SpreadAttribute(spread)) = element
            .opening_element
            .attributes
            .iter()
            .find(|attribute| matches!(attribute, JSXAttributeItem::SpreadAttribute(_)))
        {
            self.spans.insert(source_span(spread.span));
        }
        walk_jsx_element(self, element);
    }
}
