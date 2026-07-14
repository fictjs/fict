use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

use crate::{DiagnosticCode, SourceSpan};

/// Effective diagnostic severity after compiler policy is applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    /// Compilation cannot produce a valid result.
    Error,
    /// Compilation may continue, but the user should address the finding.
    Warning,
    /// Informational context that does not change compilation success.
    Info,
}

impl DiagnosticSeverity {
    const fn sort_rank(self) -> u8 {
        match self {
            Self::Error => 0,
            Self::Warning => 1,
            Self::Info => 2,
        }
    }
}

/// Relationship between a diagnostic and Fict's fail-closed guarantee policy.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GuaranteeClass {
    /// The diagnostic is unrelated to the reactivity guarantee matrix.
    #[default]
    NotApplicable,
    /// The behavior remains guaranteed, but the diagnostic is actionable.
    Advisory,
    /// Compilation would use a documented best-effort fallback.
    Fallback,
    /// The source shape is intentionally unsupported.
    Unsupported,
    /// A compiler invariant failed; this is never a user fallback.
    Internal,
}

/// Secondary source range and explanation attached to a diagnostic.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLabel {
    /// Labeled source range.
    pub span: SourceSpan,
    /// Explanation of the relationship to the primary finding.
    pub message: String,
}

/// Complete native diagnostic envelope before host rendering.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    /// Stable machine-readable identifier.
    pub code: DiagnosticCode,
    /// Effective severity.
    pub severity: DiagnosticSeverity,
    /// Primary human-readable message without a generated code frame.
    pub message: String,
    /// Primary source range, when the finding belongs to source text.
    pub primary_span: Option<SourceSpan>,
    /// Related source ranges in stable semantic order.
    pub secondary_labels: Vec<DiagnosticLabel>,
    /// Optional concise remediation.
    pub help: Option<String>,
    /// Additional context ordered from most to least relevant.
    pub notes: Vec<String>,
    /// Fail-closed policy classification.
    pub guarantee_class: GuaranteeClass,
}

impl Diagnostic {
    /// Construct a diagnostic with empty optional context.
    #[must_use]
    pub fn new(
        code: DiagnosticCode,
        severity: DiagnosticSeverity,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            severity,
            message: message.into(),
            primary_span: None,
            secondary_labels: Vec::new(),
            help: None,
            notes: Vec::new(),
            guarantee_class: GuaranteeClass::NotApplicable,
        }
    }

    /// Attach a primary source span.
    #[must_use]
    pub fn with_primary_span(mut self, span: SourceSpan) -> Self {
        self.primary_span = Some(span);
        self
    }

    /// Attach a secondary labeled span.
    #[must_use]
    pub fn with_secondary_label(mut self, span: SourceSpan, message: impl Into<String>) -> Self {
        self.secondary_labels.push(DiagnosticLabel {
            span,
            message: message.into(),
        });
        self
    }

    /// Attach remediation help.
    #[must_use]
    pub fn with_help(mut self, help: impl Into<String>) -> Self {
        self.help = Some(help.into());
        self
    }

    /// Attach one contextual note.
    #[must_use]
    pub fn with_note(mut self, note: impl Into<String>) -> Self {
        self.notes.push(note.into());
        self
    }

    /// Classify the diagnostic for guarantee policy.
    #[must_use]
    pub const fn with_guarantee_class(mut self, class: GuaranteeClass) -> Self {
        self.guarantee_class = class;
        self
    }
}

/// Collection used as a typed compiler-pass failure and deterministic result list.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DiagnosticBundle {
    diagnostics: Vec<Diagnostic>,
}

impl DiagnosticBundle {
    /// Construct a bundle from diagnostics in producer order.
    #[must_use]
    pub fn new(diagnostics: Vec<Diagnostic>) -> Self {
        Self { diagnostics }
    }

    /// Add a diagnostic.
    pub fn push(&mut self, diagnostic: Diagnostic) {
        self.diagnostics.push(diagnostic);
    }

    /// Borrow diagnostics in their current order.
    #[must_use]
    pub fn as_slice(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    /// Return whether the bundle contains no diagnostics.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.diagnostics.is_empty()
    }

    /// Return whether any diagnostic prevents valid output.
    #[must_use]
    pub fn has_errors(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
    }

    /// Sort by source location, severity, code, then message for stable output.
    pub fn sort_deterministically(&mut self) {
        self.diagnostics.sort_by(compare_diagnostics);
    }

    /// Sort and return the owned diagnostics.
    #[must_use]
    pub fn into_sorted(mut self) -> Vec<Diagnostic> {
        self.sort_deterministically();
        self.diagnostics
    }
}

fn compare_diagnostics(left: &Diagnostic, right: &Diagnostic) -> Ordering {
    let left_span = left.primary_span.unwrap_or(SourceSpan::empty(u32::MAX));
    let right_span = right.primary_span.unwrap_or(SourceSpan::empty(u32::MAX));

    left_span
        .cmp(&right_span)
        .then_with(|| left.severity.sort_rank().cmp(&right.severity.sort_rank()))
        .then_with(|| left.code.cmp(&right.code))
        .then_with(|| left.message.cmp(&right.message))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Diagnostic, DiagnosticBundle, DiagnosticSeverity, GuaranteeClass};
    use crate::{DiagnosticCode, SourceSpan};

    fn diagnostic(code: &str, severity: DiagnosticSeverity, start: u32) -> Diagnostic {
        Diagnostic::new(
            DiagnosticCode::new(code).expect("valid code"),
            severity,
            code,
        )
        .with_primary_span(SourceSpan::new(start, start + 1).expect("valid span"))
    }

    #[test]
    fn serializes_the_public_camel_case_shape() {
        let diagnostic = Diagnostic::new(
            DiagnosticCode::new("FICT-R006").expect("valid code"),
            DiagnosticSeverity::Warning,
            "control flow requires fallback",
        )
        .with_primary_span(SourceSpan::new(4, 9).expect("valid span"))
        .with_secondary_label(SourceSpan::empty(12), "related branch")
        .with_help("move the expression outside the branch")
        .with_note("strict guarantee escalates this finding")
        .with_guarantee_class(GuaranteeClass::Fallback);

        let value = serde_json::to_value(&diagnostic).expect("serialize diagnostic");
        assert_eq!(
            value,
            json!({
                "code": "FICT-R006",
                "severity": "warning",
                "message": "control flow requires fallback",
                "primarySpan": { "start": 4, "end": 9 },
                "secondaryLabels": [{
                    "span": { "start": 12, "end": 12 },
                    "message": "related branch"
                }],
                "help": "move the expression outside the branch",
                "notes": ["strict guarantee escalates this finding"],
                "guaranteeClass": "fallback"
            })
        );
        assert_eq!(
            serde_json::from_value::<Diagnostic>(value).expect("deserialize diagnostic"),
            diagnostic
        );
    }

    #[test]
    fn rejects_an_invalid_code_during_deserialization() {
        let value = json!({
            "code": "r006",
            "severity": "error",
            "message": "bad",
            "primarySpan": null,
            "secondaryLabels": [],
            "help": null,
            "notes": [],
            "guaranteeClass": "internal"
        });
        assert!(serde_json::from_value::<Diagnostic>(value).is_err());
    }

    #[test]
    fn rejects_an_inverted_span_during_deserialization() {
        let value = json!({
            "code": "FICT-PARSE",
            "severity": "error",
            "message": "bad span",
            "primarySpan": { "start": 9, "end": 4 },
            "secondaryLabels": [],
            "help": null,
            "notes": [],
            "guaranteeClass": "unsupported"
        });
        assert!(serde_json::from_value::<Diagnostic>(value).is_err());
    }

    #[test]
    fn sorts_diagnostics_deterministically() {
        let mut bundle = DiagnosticBundle::new(vec![
            diagnostic("FICT-Z001", DiagnosticSeverity::Info, 8),
            diagnostic("FICT-B001", DiagnosticSeverity::Warning, 2),
            diagnostic("FICT-A001", DiagnosticSeverity::Error, 2),
        ]);
        assert!(!bundle.is_empty());
        assert!(bundle.has_errors());
        bundle.sort_deterministically();

        let codes: Vec<_> = bundle
            .as_slice()
            .iter()
            .map(|item| item.code.as_str())
            .collect();
        assert_eq!(codes, ["FICT-A001", "FICT-B001", "FICT-Z001"]);
    }
}
