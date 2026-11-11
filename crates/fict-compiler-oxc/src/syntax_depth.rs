//! Check recursion budgets before semantic analysis or any recursive Fict walk.
//!
//! Queue recursive AST edges instead of recursively visiting them. Flat binary
//! and branch chains get a separate budget from structural nesting: generated
//! dispatch tables and sums should not consume the small JSX/object budget.
use oxc::{
    ast::ast::*,
    ast_visit::{Visit, walk},
    diagnostics::OxcDiagnostic,
    span::{GetSpan, Span},
};

const MAX_NESTING: usize = 512;
const MAX_CHAIN: usize = 4096;

enum Item<'a> {
    Expression(&'a Expression<'a>),
    Statement(&'a Statement<'a>),
    Element(&'a JSXElement<'a>),
    Fragment(&'a JSXFragment<'a>),
    Pattern(&'a BindingPattern<'a>),
    Type(&'a TSType<'a>),
    TypeName(&'a TSTypeName<'a>),
    Target(&'a AssignmentTarget<'a>),
    Module(&'a TSModuleDeclaration<'a>),
}
impl Item<'_> {
    fn linear_kind(&self) -> u8 {
        match self {
            Self::Expression(
                Expression::BinaryExpression(_) | Expression::LogicalExpression(_),
            ) => 1,
            Self::Statement(Statement::IfStatement(_)) => 2,
            _ => 0,
        }
    }
    fn span(&self) -> Span {
        match self {
            Self::Expression(node) => node.span(),
            Self::Statement(node) => node.span(),
            Self::Element(node) => node.span(),
            Self::Fragment(node) => node.span(),
            Self::Pattern(node) => node.span(),
            Self::Type(node) => node.span(),
            Self::TypeName(node) => node.span(),
            Self::Target(node) => node.span(),
            Self::Module(node) => node.span(),
        }
    }
}
#[derive(Default)]
struct Check<'a> {
    pending: Vec<(Item<'a>, usize, usize)>,
    nesting: usize,
    chain: usize,
    linear_kind: u8,
    exceeded: Option<Span>,
}
impl<'a> Check<'a> {
    fn push(&mut self, item: Item<'a>) {
        if self.exceeded.is_some() {
            return;
        }
        let nesting = self.nesting
            + usize::from(self.linear_kind == 0 || self.linear_kind != item.linear_kind());
        let chain = self.chain + 1;
        if nesting > MAX_NESTING || chain > MAX_CHAIN {
            self.exceeded = Some(item.span());
        } else {
            self.pending.push((item, nesting, chain));
        }
    }
}
macro_rules! queue {
    ($method:ident, $type:ident, $variant:ident) => {
        fn $method(&mut self, node: &$type<'a>) {
            self.push(Item::$variant(self.alloc(node)));
        }
    };
}
impl<'a> Visit<'a> for Check<'a> {
    queue!(visit_expression, Expression, Expression);
    queue!(visit_statement, Statement, Statement);
    queue!(visit_jsx_element, JSXElement, Element);
    queue!(visit_jsx_fragment, JSXFragment, Fragment);
    queue!(visit_binding_pattern, BindingPattern, Pattern);
    queue!(visit_ts_type, TSType, Type);
    queue!(visit_ts_type_name, TSTypeName, TypeName);
    queue!(visit_assignment_target, AssignmentTarget, Target);
    queue!(visit_ts_module_declaration, TSModuleDeclaration, Module);
}

pub(crate) fn check(program: &Program<'_>) -> Option<OxcDiagnostic> {
    let mut check = Check::default();
    check.visit_program(program);
    while check.exceeded.is_none() {
        let Some((item, nesting, chain)) = check.pending.pop() else {
            break;
        };
        check.nesting = nesting;
        check.chain = chain;
        check.linear_kind = item.linear_kind();
        match item {
            Item::Expression(node) => walk::walk_expression(&mut check, node),
            Item::Statement(node) => walk::walk_statement(&mut check, node),
            Item::Element(node) => walk::walk_jsx_element(&mut check, node),
            Item::Fragment(node) => walk::walk_jsx_fragment(&mut check, node),
            Item::Pattern(node) => walk::walk_binding_pattern(&mut check, node),
            Item::Type(node) => walk::walk_ts_type(&mut check, node),
            Item::TypeName(node) => walk::walk_ts_type_name(&mut check, node),
            Item::Target(node) => walk::walk_assignment_target(&mut check, node),
            Item::Module(node) => walk::walk_ts_module_declaration(&mut check, node),
        }
    }
    check.exceeded.map(|span| OxcDiagnostic::error(format!(
        "source exceeds the compiler syntax depth limit ({MAX_NESTING} nested structures or {MAX_CHAIN} chained nodes)"
    )).with_error_code_scope("FICT-SYNTAX-DEPTH").with_label(span).with_help("split nested structures or generated expressions into smaller declarations"))
}

#[cfg(test)]
mod tests {
    use crate::{
        OxcCompileOptions, OxcModuleKind, OxcSourceLanguage, OxcTypeScriptOptions,
        with_compiler_stack,
    };
    use oxc::allocator::Allocator;

    fn rejected(source: &str) -> bool {
        with_compiler_stack(|| {
            let allocator = Allocator::default();
            let parsed = crate::compile::parse_source(
                &allocator,
                source,
                OxcCompileOptions {
                    language: OxcSourceLanguage::TypeScriptJsx,
                    module_kind: OxcModuleKind::Module,
                    typescript: OxcTypeScriptOptions::default(),
                    sourcemap: false,
                },
            );
            assert!(parsed.diagnostics.iter().all(|diagnostic| diagnostic.code.scope.as_deref() == Some("FICT-SYNTAX-DEPTH")), "{:?}", parsed.diagnostics);
            !parsed.diagnostics.is_empty()
        })
    }

    #[test]
    fn bounds_all_recursive_syntax_families_before_other_visitors() {
        for source in [
            format!("const v = {}1{}", "(".repeat(1500), ")".repeat(1500)),
            format!("const v = {}1{}", "{c:".repeat(1500), "}".repeat(1500)),
            format!(
                "const v = {}1{}",
                "<div>".repeat(1500),
                "</div>".repeat(1500)
            ),
            format!("const {}v{} = source", "[".repeat(1500), "]".repeat(1500)),
            format!("type T = {}number{}", "{c:".repeat(1500), "}".repeat(1500)),
            format!("type T = root{}", ".child".repeat(1500)),
            format!(
                "{}const v=1;{}",
                "namespace N {".repeat(1500),
                "}".repeat(1500)
            ),
        ] {
            assert!(rejected(&source));
        }
    }

    #[test]
    fn permits_wide_sources_literals_and_generated_linear_chains() {
        assert!(!rejected(&format!("const text = '{}';", "(".repeat(10000))));
        assert!(!rejected(&format!(
            "const values = [{}];",
            "1,".repeat(10000)
        )));
        assert!(!rejected(&format!(
            "function f(x){{ {} return -1; }}",
            (0..3000)
                .map(|i| format!(
                    "{}if(x==={i})return {i};",
                    if i == 0 { "" } else { "else " }
                ))
                .collect::<String>()
        )));
        assert!(!rejected(&format!(
            "const value = {}1;",
            "x + ".repeat(3000)
        )));
        assert!(rejected(&format!(
            "const value = {}1;",
            "x + ".repeat(5000)
        )));
    }
}
