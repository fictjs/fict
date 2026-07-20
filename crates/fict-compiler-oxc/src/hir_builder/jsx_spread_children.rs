use fict_diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use oxc::{
    ast::ast::{JSXChild, JSXElement, JSXFragment, Program},
    ast_visit::{
        Visit,
        walk::{walk_jsx_element, walk_jsx_fragment},
    },
};

pub(super) fn diagnostics(program: &Program<'_>) -> Vec<Diagnostic> {
    let mut collector = JsxSpreadChildCollector::default();
    collector.visit_program(program);
    collector.diagnostics
}

#[derive(Default)]
struct JsxSpreadChildCollector {
    diagnostics: Vec<Diagnostic>,
}

impl JsxSpreadChildCollector {
    fn inspect_children(&mut self, children: &[JSXChild<'_>]) {
        for child in children {
            let JSXChild::Spread(spread) = child else {
                continue;
            };
            self.diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::new("FICT-J005").expect("diagnostic literal"),
                    DiagnosticSeverity::Error,
                    "JSX spread children are not supported",
                )
                .with_primary_span(
                    SourceSpan::new(spread.span.start, spread.span.end)
                        .expect("OXC JSX spread spans are ordered"),
                )
                .with_help("render the collection explicitly, for example with `.map(...)`")
                .with_guarantee_class(GuaranteeClass::Unsupported),
            );
        }
    }
}

impl<'a> Visit<'a> for JsxSpreadChildCollector {
    fn visit_jsx_element(&mut self, element: &JSXElement<'a>) {
        self.inspect_children(&element.children);
        walk_jsx_element(self, element);
    }

    fn visit_jsx_fragment(&mut self, fragment: &JSXFragment<'a>) {
        self.inspect_children(&fragment.children);
        walk_jsx_fragment(self, fragment);
    }
}
