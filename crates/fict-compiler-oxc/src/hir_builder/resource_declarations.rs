use fict_diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use oxc::{
    ast::ast::{Program, VariableDeclaration, VariableDeclarationKind},
    ast_visit::{Visit, walk},
};

pub(super) fn diagnostics(program: &Program<'_>) -> Vec<Diagnostic> {
    let mut collector = ResourceDeclarationCollector::default();
    collector.visit_program(program);
    collector.diagnostics
}

#[derive(Default)]
struct ResourceDeclarationCollector {
    diagnostics: Vec<Diagnostic>,
}

impl<'a> Visit<'a> for ResourceDeclarationCollector {
    fn visit_variable_declaration(&mut self, declaration: &VariableDeclaration<'a>) {
        if matches!(
            declaration.kind,
            VariableDeclarationKind::Using | VariableDeclarationKind::AwaitUsing
        ) {
            self.diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::new("FICT-USING-UNSUPPORTED")
                        .expect("resource declaration diagnostic literal"),
                    DiagnosticSeverity::Error,
                    "`using` and `await using` declarations are not supported until resource disposal is represented in Fict HIR",
                )
                .with_primary_span(
                    SourceSpan::new(declaration.span.start, declaration.span.end)
                        .expect("OXC declaration spans are ordered"),
                )
                .with_help(
                    "manage disposal explicitly with try/finally, outside compiler-owned reactive lowering",
                )
                .with_guarantee_class(GuaranteeClass::Unsupported),
            );
        }
        walk::walk_variable_declaration(self, declaration);
    }
}
