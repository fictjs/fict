#![forbid(unsafe_code)]

//! Structured diagnostics and policy shared by native compiler passes.

mod code;
mod diagnostic;
mod span;

pub use code::{DiagnosticCode, InvalidDiagnosticCode};
pub use diagnostic::{
    Diagnostic, DiagnosticBundle, DiagnosticLabel, DiagnosticSeverity, GuaranteeClass,
};
pub use span::SourceSpan;
