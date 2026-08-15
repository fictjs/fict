use std::collections::BTreeMap;

use fict_compiler_oxc::FrontendSuppression;
use fict_diagnostics::{Diagnostic, DiagnosticSeverity, GuaranteeClass, SourceIndex};

use crate::{CompilerOptions, WarningLevel, WarningsAsErrors};

const STRICT_REACTIVITY_CODES: &[&str] = &["FICT-R006"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DiagnosticPolicyEntry {
    pattern: &'static str,
    guarantee_class: GuaranteeClass,
    allow_override_outside_strict: bool,
    exact: bool,
}

// Machine-readable policy shared by request validation and final severity normalization.
//
// The diagnostic's own `guarantee_class` remains authoritative for unregistered future codes,
// so adding a fallback producer cannot accidentally bypass strict mode. Registry entries make
// policy known before a producer runs and therefore let request normalization reject an invalid
// strict-mode override without compiling the source first.
include!(concat!(env!("OUT_DIR"), "/diagnostic_policy_registry.rs"));

pub(crate) fn apply_diagnostic_policy(
    options: &CompilerOptions,
    diagnostics: &mut Vec<Diagnostic>,
) {
    diagnostics.retain_mut(|diagnostic| {
        let Some(severity) = effective_severity(options, diagnostic) else {
            return false;
        };
        diagnostic.severity = severity;
        true
    });
}

pub(crate) fn apply_diagnostic_suppressions(
    source: &str,
    suppressions: &[FrontendSuppression],
    diagnostics: &mut Vec<Diagnostic>,
) {
    if suppressions.is_empty() {
        return;
    }
    let lines = SourceIndex::new(source);
    diagnostics.retain(|diagnostic| {
        if diagnostic.severity == DiagnosticSeverity::Error {
            return true;
        }
        let Some(span) = diagnostic.primary_span else {
            return true;
        };
        let line = lines.line_of(span.start());
        !suppressions.iter().any(|suppression| {
            suppression.target_line == line
                && (suppression.codes.is_empty()
                    || suppression
                        .codes
                        .iter()
                        .any(|pattern| diagnostic_code_matches(diagnostic.code.as_str(), pattern)))
        })
    });
}
fn effective_severity(
    options: &CompilerOptions,
    diagnostic: &Diagnostic,
) -> Option<DiagnosticSeverity> {
    let code = diagnostic.code.as_str();
    if options.strict_guarantee && guarantee_class_requires_strict(diagnostic.guarantee_class) {
        return Some(DiagnosticSeverity::Error);
    }

    if let Some(level) = configured_warning_level(&options.warning_levels, code)
        && (level == WarningLevel::Error
            || diagnostic.severity != DiagnosticSeverity::Error
            || configurable_diagnostic_code(code))
    {
        return (level != WarningLevel::Off).then(|| warning_level_severity(level));
    }

    if options.strict_reactivity && matches_any(code, STRICT_REACTIVITY_CODES) {
        return Some(DiagnosticSeverity::Error);
    }

    if diagnostic.severity != DiagnosticSeverity::Error
        && warnings_as_errors_matches(&options.warnings_as_errors, code)
    {
        return Some(DiagnosticSeverity::Error);
    }

    Some(diagnostic.severity)
}

pub(crate) fn configured_diagnostic_severity(
    options: &CompilerOptions,
    code: &str,
    default: DiagnosticSeverity,
    guarantee_class: GuaranteeClass,
) -> DiagnosticSeverity {
    if options.strict_guarantee && guarantee_class_requires_strict(guarantee_class) {
        DiagnosticSeverity::Error
    } else {
        configured_warning_level(&options.warning_levels, code)
            .map_or(default, warning_level_severity)
    }
}

fn configured_warning_level(
    levels: &BTreeMap<String, WarningLevel>,
    code: &str,
) -> Option<WarningLevel> {
    levels.get(code).copied().or_else(|| {
        levels
            .iter()
            .filter(|(pattern, _)| diagnostic_code_matches(code, pattern))
            .max_by_key(|(pattern, _)| pattern.len())
            .map(|(_, level)| *level)
    })
}

const fn warning_level_severity(level: WarningLevel) -> DiagnosticSeverity {
    match level {
        WarningLevel::Off => DiagnosticSeverity::Info,
        WarningLevel::Warn => DiagnosticSeverity::Warning,
        WarningLevel::Error => DiagnosticSeverity::Error,
    }
}

fn warnings_as_errors_matches(policy: &WarningsAsErrors, code: &str) -> bool {
    match policy {
        WarningsAsErrors::Boolean(enabled) => *enabled,
        WarningsAsErrors::Codes(patterns) => patterns
            .iter()
            .any(|pattern| diagnostic_code_matches(code, pattern)),
    }
}

fn configurable_diagnostic_code(code: &str) -> bool {
    policy_entry(code).is_some_and(|entry| entry.allow_override_outside_strict)
}

const fn guarantee_class_requires_strict(guarantee_class: GuaranteeClass) -> bool {
    matches!(
        guarantee_class,
        GuaranteeClass::Fallback | GuaranteeClass::Unsupported
    )
}

pub(crate) fn strict_guarantee_pattern_overlaps(pattern: &str) -> bool {
    DIAGNOSTIC_POLICY_REGISTRY.iter().any(|entry| {
        guarantee_class_requires_strict(entry.guarantee_class)
            && (if entry.exact {
                pattern == entry.pattern || diagnostic_code_matches(entry.pattern, pattern)
            } else {
                diagnostic_code_matches(entry.pattern, pattern)
                    || diagnostic_code_matches(pattern, entry.pattern)
            })
    })
}

fn policy_entry(code: &str) -> Option<&'static DiagnosticPolicyEntry> {
    DIAGNOSTIC_POLICY_REGISTRY
        .iter()
        .filter(|entry| {
            if entry.exact {
                code == entry.pattern
            } else {
                diagnostic_code_matches(code, entry.pattern)
            }
        })
        .max_by_key(|entry| entry.pattern.len())
}

fn matches_any(code: &str, patterns: &[&str]) -> bool {
    patterns
        .iter()
        .any(|pattern| diagnostic_code_matches(code, pattern))
}

pub(crate) fn diagnostic_code_matches(code: &str, pattern: &str) -> bool {
    code == pattern
        || code
            .strip_prefix(pattern)
            .and_then(|suffix| suffix.chars().next())
            .is_some_and(|character| character.is_ascii_digit() || character == '-')
}

#[cfg(test)]
mod tests {
    use fict_compiler_oxc::{FrontendSuppression, SuppressionMode};
    use fict_diagnostics::SourceSpan;
    use fict_diagnostics::{Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass};

    use super::{apply_diagnostic_policy, apply_diagnostic_suppressions, diagnostic_code_matches};
    use crate::{CompilerOptions, WarningLevel, WarningsAsErrors};

    fn finding(code: &str, guarantee_class: GuaranteeClass) -> Diagnostic {
        Diagnostic::new(
            DiagnosticCode::new(code).expect("diagnostic code"),
            DiagnosticSeverity::Warning,
            "policy probe",
        )
        .with_guarantee_class(guarantee_class)
    }

    #[test]
    fn strict_guarantee_keeps_fict_m_exact() {
        let mut diagnostics = vec![
            finding("FICT-M", GuaranteeClass::Fallback),
            finding("FICT-M001", GuaranteeClass::Advisory),
        ];
        apply_diagnostic_policy(&CompilerOptions::default(), &mut diagnostics);

        assert_eq!(diagnostics[0].severity, DiagnosticSeverity::Error);
        assert_eq!(diagnostics[1].severity, DiagnosticSeverity::Warning);
    }

    #[test]
    fn strict_guarantee_is_driven_by_the_producer_class_for_future_codes() {
        let mut options = CompilerOptions::default();
        options
            .warning_levels
            .insert("FICT-FUTURE001".into(), WarningLevel::Off);
        options
            .warning_levels
            .insert("FICT-FUTURE002".into(), WarningLevel::Warn);
        let mut diagnostics = vec![
            finding("FICT-FUTURE001", GuaranteeClass::Fallback),
            finding("FICT-FUTURE002", GuaranteeClass::Unsupported),
            finding("FICT-M001", GuaranteeClass::Advisory),
        ];

        apply_diagnostic_policy(&options, &mut diagnostics);

        assert_eq!(diagnostics.len(), 3);
        assert_eq!(diagnostics[0].severity, DiagnosticSeverity::Error);
        assert_eq!(diagnostics[1].severity, DiagnosticSeverity::Error);
        assert_eq!(diagnostics[2].severity, DiagnosticSeverity::Warning);
    }

    #[test]
    fn matches_numeric_and_hyphenated_families_at_code_boundaries() {
        assert!(diagnostic_code_matches("FICT-P001", "FICT-P"));
        assert!(diagnostic_code_matches(
            "FICT-PLACEMENT-HOOK-CONTROL",
            "FICT-PLACEMENT"
        ));
        assert!(diagnostic_code_matches(
            "FICT-PLACEMENT-HOOK-CONTROL",
            "FICT-PLACEMENT-HOOK"
        ));
        assert!(!diagnostic_code_matches("FICT-HIR-MACRO", "FICT-H"));
        assert!(!diagnostic_code_matches("FICT-METADATA", "FICT-M"));
    }

    #[test]
    fn hyphenated_family_patterns_apply_to_all_warning_policies() {
        let mut options = CompilerOptions {
            strict_guarantee: false,
            warnings_as_errors: WarningsAsErrors::Codes(vec!["FICT-PLACEMENT".into()]),
            ..CompilerOptions::default()
        };
        let mut diagnostics = vec![finding(
            "FICT-PLACEMENT-HOOK-CONTROL",
            GuaranteeClass::Advisory,
        )];
        apply_diagnostic_policy(&options, &mut diagnostics);
        assert_eq!(diagnostics[0].severity, DiagnosticSeverity::Error);

        options.warnings_as_errors = WarningsAsErrors::Boolean(true);
        options
            .warning_levels
            .insert("FICT-PLACEMENT".into(), WarningLevel::Off);
        let mut diagnostics = vec![finding(
            "FICT-PLACEMENT-HOOK-CONTROL",
            GuaranteeClass::Advisory,
        )];
        apply_diagnostic_policy(&options, &mut diagnostics);
        assert!(diagnostics.is_empty());
    }

    #[test]
    fn source_suppressions_match_lines_and_families_before_policy() {
        let source = "first();\r\nsecond();\u{2028}third();\u{2029}fourth();";
        let located = |code: &str, needle: &str, severity| {
            let start = u32::try_from(source.find(needle).expect("source needle")).expect("offset");
            Diagnostic::new(
                DiagnosticCode::new(code).expect("diagnostic code"),
                severity,
                code,
            )
            .with_primary_span(SourceSpan::new(start, start + 1).expect("span"))
        };
        let suppressions = vec![
            FrontendSuppression {
                mode: SuppressionMode::NextLine,
                target_line: 2,
                codes: vec!["FICT-M".into()],
                comment_span: SourceSpan::empty(0),
            },
            FrontendSuppression {
                mode: SuppressionMode::SameLine,
                target_line: 3,
                codes: Vec::new(),
                comment_span: SourceSpan::empty(0),
            },
            FrontendSuppression {
                mode: SuppressionMode::SameLine,
                target_line: 4,
                codes: Vec::new(),
                comment_span: SourceSpan::empty(0),
            },
        ];
        let mut diagnostics = vec![
            located("FICT-M003", "second", DiagnosticSeverity::Warning),
            located("FICT-R006", "third", DiagnosticSeverity::Info),
            located("FICT-M003", "fourth", DiagnosticSeverity::Error),
        ];

        apply_diagnostic_suppressions(source, &suppressions, &mut diagnostics);

        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].severity, DiagnosticSeverity::Error);
    }
}
