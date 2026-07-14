use std::fmt::Write;

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};

use crate::{BindingId, HirFile, ImportedName, Origin, OriginKind, ScopeKind};

/// OXC-independent module linkage facts carried beside typed HIR.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModulePlan {
    /// Whether the source contains ECMAScript module syntax.
    pub has_module_syntax: bool,
    /// Runtime exports in deterministic source order.
    pub exports: Vec<ModuleExport>,
}

/// One runtime export owned by the module plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModuleExport {
    /// An export backed by a local runtime binding or a default expression.
    Local {
        /// Public export spelling, including `default`.
        exported: String,
        /// Runtime value source.
        target: ModuleLocalExport,
        /// Source provenance for the export entry or expression.
        origin: Origin,
    },
    /// A named or namespace re-export from another module.
    ReExport {
        /// Public export spelling, including `default`.
        exported: String,
        /// Exact source module specifier.
        source: String,
        /// Export selected from the source module.
        imported: ImportedName,
        /// Source provenance for the export entry.
        origin: Origin,
    },
    /// `export * from` linkage, which excludes the source module's default export.
    Star {
        /// Exact source module specifier.
        source: String,
        /// Source provenance for the export declaration.
        origin: Origin,
    },
}

impl ModuleExport {
    /// Return the source provenance shared by every export variant.
    #[must_use]
    pub const fn origin(&self) -> Origin {
        match self {
            Self::Local { origin, .. }
            | Self::ReExport { origin, .. }
            | Self::Star { origin, .. } => *origin,
        }
    }
}

/// Runtime source for one local export.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModuleLocalExport {
    /// A semantic top-level runtime binding.
    Binding(BindingId),
    /// An anonymous `export default` expression or declaration.
    DefaultExpression,
}

/// Verify module-plan ownership and references against the associated HIR file.
pub fn verify_module_plan(file: &HirFile, plan: &ModulePlan) -> Result<(), DiagnosticBundle> {
    let mut diagnostics = DiagnosticBundle::default();
    if !plan.has_module_syntax && !plan.exports.is_empty() {
        push_error(
            &mut diagnostics,
            "a script module plan cannot contain ECMAScript exports",
            None,
        );
    }

    for export in &plan.exports {
        let origin = export.origin();
        verify_origin(file, origin, &mut diagnostics);
        match export {
            ModuleExport::Local {
                exported, target, ..
            } => {
                verify_name(exported, "local export", origin, &mut diagnostics);
                match target {
                    ModuleLocalExport::Binding(binding) => {
                        let Some(binding) = file.bindings.get(binding.as_usize()) else {
                            push_error(
                                &mut diagnostics,
                                format!(
                                    "module export references binding{} outside the binding arena",
                                    binding.index()
                                ),
                                Some(origin),
                            );
                            continue;
                        };
                        let module_scoped = file
                            .scopes
                            .get(binding.scope.as_usize())
                            .is_some_and(|scope| scope.kind == ScopeKind::Module);
                        if !module_scoped {
                            push_error(
                                &mut diagnostics,
                                format!(
                                    "module export binding{} must belong to the module scope",
                                    binding.id.index()
                                ),
                                Some(origin),
                            );
                        }
                    }
                    ModuleLocalExport::DefaultExpression if exported != "default" => push_error(
                        &mut diagnostics,
                        "only the default export may use an anonymous export expression",
                        Some(origin),
                    ),
                    ModuleLocalExport::DefaultExpression => {}
                }
            }
            ModuleExport::ReExport {
                exported,
                source,
                imported,
                ..
            } => {
                verify_name(exported, "re-export", origin, &mut diagnostics);
                verify_name(source, "re-export source", origin, &mut diagnostics);
                if let ImportedName::Named(imported) = imported {
                    verify_name(imported, "re-export import", origin, &mut diagnostics);
                }
            }
            ModuleExport::Star { source, .. } => {
                verify_name(source, "star-export source", origin, &mut diagnostics);
            }
        }
    }

    if diagnostics.is_empty() {
        Ok(())
    } else {
        diagnostics.sort_deterministically();
        Err(diagnostics)
    }
}

/// Print deterministic module linkage facts for snapshots and differential tests.
#[must_use]
pub fn print_module_plan(plan: &ModulePlan) -> String {
    let mut output = String::new();
    writeln!(output, "module syntax={}", plan.has_module_syntax)
        .expect("writing to String cannot fail");
    for export in &plan.exports {
        match export {
            ModuleExport::Local {
                exported,
                target,
                origin,
            } => writeln!(
                output,
                "export local name={exported:?} target={target:?} origin={}",
                print_origin(*origin)
            ),
            ModuleExport::ReExport {
                exported,
                source,
                imported,
                origin,
            } => writeln!(
                output,
                "export re-export name={exported:?} source={source:?} imported={imported:?} origin={}",
                print_origin(*origin)
            ),
            ModuleExport::Star { source, origin } => writeln!(
                output,
                "export star source={source:?} origin={}",
                print_origin(*origin)
            ),
        }
        .expect("writing to String cannot fail");
    }
    output
}

fn verify_origin(file: &HirFile, origin: Origin, diagnostics: &mut DiagnosticBundle) {
    match (origin.kind, origin.primary_span) {
        (OriginKind::Source | OriginKind::Desugared(_), None) => push_error(
            diagnostics,
            "module export source origin is missing its primary span",
            None,
        ),
        (_, Some(span)) if span.end() > file.source_len => push_error(
            diagnostics,
            format!(
                "module export source span {}..{} exceeds file length {}",
                span.start(),
                span.end(),
                file.source_len
            ),
            Some(origin),
        ),
        _ => {}
    }
}

fn verify_name(value: &str, role: &str, origin: Origin, diagnostics: &mut DiagnosticBundle) {
    if value.is_empty() {
        push_error(
            diagnostics,
            format!("{role} must not be empty"),
            Some(origin),
        );
    }
}

fn push_error(
    diagnostics: &mut DiagnosticBundle,
    message: impl Into<String>,
    origin: Option<Origin>,
) {
    let mut diagnostic = Diagnostic::new(
        DiagnosticCode::new("FICT-HIR-MODULE").expect("valid module verifier code"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(GuaranteeClass::Internal);
    if let Some(span) = origin.and_then(|item| item.primary_span) {
        diagnostic = diagnostic.with_primary_span(span);
    }
    diagnostics.push(diagnostic);
}

fn print_origin(origin: Origin) -> String {
    let kind = match origin.kind {
        OriginKind::Source => "source".to_owned(),
        OriginKind::Desugared(kind) => format!("desugared:{kind:?}"),
        OriginKind::Generated(kind) => format!("generated:{kind:?}"),
    };
    origin.primary_span.map_or_else(
        || format!("{kind}@-"),
        |span| format!("{kind}@{}..{}", span.start(), span.end()),
    )
}

#[cfg(test)]
mod tests {
    use fict_diagnostics::SourceSpan;

    use super::{ModuleExport, ModuleLocalExport, ModulePlan, print_module_plan};
    use crate::{BindingId, ImportedName, Origin};

    #[test]
    fn printer_is_source_ordered_and_source_free() {
        let plan = ModulePlan {
            has_module_syntax: true,
            exports: vec![
                ModuleExport::Local {
                    exported: "value".into(),
                    target: ModuleLocalExport::Binding(BindingId::new(2)),
                    origin: Origin::source(SourceSpan::new(7, 12).expect("span")),
                },
                ModuleExport::ReExport {
                    exported: "default".into(),
                    source: "./dep".into(),
                    imported: ImportedName::Default,
                    origin: Origin::source(SourceSpan::new(13, 40).expect("span")),
                },
                ModuleExport::Star {
                    source: "./more".into(),
                    origin: Origin::source(SourceSpan::new(41, 63).expect("span")),
                },
            ],
        };

        assert_eq!(
            print_module_plan(&plan),
            concat!(
                "module syntax=true\n",
                "export local name=\"value\" target=Binding(BindingId(2)) origin=source@7..12\n",
                "export re-export name=\"default\" source=\"./dep\" imported=Default origin=source@13..40\n",
                "export star source=\"./more\" origin=source@41..63\n",
            )
        );
    }
}
