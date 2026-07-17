use std::collections::BTreeMap;

use fict_diagnostics::{Diagnostic, DiagnosticSeverity};

use crate::{CompilerOptions, WarningLevel, WarningsAsErrors};

const STRICT_GUARANTEE_EXACT_CODES: &[&str] = &["FICT-M"];
const STRICT_GUARANTEE_CODES: &[&str] = &[
    "FICT-P001",
    "FICT-P002",
    "FICT-P003",
    "FICT-P004",
    "FICT-P005",
    "FICT-J003",
    "FICT-M003",
    "FICT-S002",
    "FICT-H",
    "FICT-H002",
    "FICT-R002",
    "FICT-R003",
    "FICT-R005",
    "FICT-R006",
    "FICT-R007",
];
const STRICT_REACTIVITY_CODES: &[&str] = &["FICT-R003", "FICT-R006"];
const CONFIGURABLE_DIAGNOSTIC_CODES: &[&str] = &[
    "FICT-P001",
    "FICT-P002",
    "FICT-P003",
    "FICT-P004",
    "FICT-P005",
    "FICT-S002",
    "FICT-E001",
    "FICT-M001",
    "FICT-M003",
    "FICT-C003",
    "FICT-C004",
    "FICT-J001",
    "FICT-J002",
    "FICT-J003",
    "FICT-R002",
    "FICT-R003",
    "FICT-R004",
    "FICT-R005",
    "FICT-R006",
    "FICT-R007",
    "FICT-H",
    "FICT-H002",
    "FICT-H003",
    "FICT-X003",
];

pub(crate) fn apply_diagnostic_policy(options: &CompilerOptions, diagnostics: &mut [Diagnostic]) {
    for diagnostic in diagnostics {
        diagnostic.severity = effective_severity(options, diagnostic);
    }
}

fn effective_severity(options: &CompilerOptions, diagnostic: &Diagnostic) -> DiagnosticSeverity {
    let code = diagnostic.code.as_str();
    if options.strict_guarantee && strict_guarantee_code_matches(code) {
        return DiagnosticSeverity::Error;
    }

    if let Some(level) = configured_warning_level(&options.warning_levels, code)
        && (level == WarningLevel::Error
            || diagnostic.severity != DiagnosticSeverity::Error
            || configurable_diagnostic_code(code))
    {
        return warning_level_severity(level);
    }

    if options.strict_reactivity && matches_any(code, STRICT_REACTIVITY_CODES) {
        return DiagnosticSeverity::Error;
    }

    if diagnostic.severity != DiagnosticSeverity::Error
        && warnings_as_errors_matches(&options.warnings_as_errors, code)
    {
        return DiagnosticSeverity::Error;
    }

    diagnostic.severity
}

pub(crate) fn configured_diagnostic_severity(
    levels: &BTreeMap<String, WarningLevel>,
    code: &str,
    default: DiagnosticSeverity,
) -> DiagnosticSeverity {
    configured_warning_level(levels, code).map_or(default, warning_level_severity)
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
    STRICT_GUARANTEE_EXACT_CODES.contains(&code) || matches_any(code, CONFIGURABLE_DIAGNOSTIC_CODES)
}

pub(crate) fn strict_guarantee_code_matches(code: &str) -> bool {
    STRICT_GUARANTEE_EXACT_CODES.contains(&code) || matches_any(code, STRICT_GUARANTEE_CODES)
}

pub(crate) fn strict_guarantee_pattern_overlaps(pattern: &str) -> bool {
    STRICT_GUARANTEE_CODES.iter().any(|code| {
        diagnostic_code_matches(code, pattern) || diagnostic_code_matches(pattern, code)
    }) || STRICT_GUARANTEE_EXACT_CODES
        .iter()
        .any(|code| pattern == *code || diagnostic_code_matches(code, pattern))
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
    use fict_diagnostics::{Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass};

    use super::{apply_diagnostic_policy, diagnostic_code_matches};
    use crate::{CompilerOptions, WarningLevel, WarningsAsErrors};

    fn warning(code: &str) -> Diagnostic {
        Diagnostic::new(
            DiagnosticCode::new(code).expect("diagnostic code"),
            DiagnosticSeverity::Warning,
            "policy probe",
        )
        .with_guarantee_class(GuaranteeClass::Fallback)
    }

    #[test]
    fn strict_guarantee_keeps_fict_m_exact() {
        let mut diagnostics = vec![warning("FICT-M"), warning("FICT-M001")];
        apply_diagnostic_policy(&CompilerOptions::default(), &mut diagnostics);

        assert_eq!(diagnostics[0].severity, DiagnosticSeverity::Error);
        assert_eq!(diagnostics[1].severity, DiagnosticSeverity::Warning);
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
        let mut diagnostics = vec![warning("FICT-PLACEMENT-HOOK-CONTROL")];
        apply_diagnostic_policy(&options, &mut diagnostics);
        assert_eq!(diagnostics[0].severity, DiagnosticSeverity::Error);

        options.warnings_as_errors = WarningsAsErrors::Boolean(true);
        options
            .warning_levels
            .insert("FICT-PLACEMENT".into(), WarningLevel::Off);
        let mut diagnostics = vec![warning("FICT-PLACEMENT-HOOK-CONTROL")];
        apply_diagnostic_policy(&options, &mut diagnostics);
        assert_eq!(diagnostics[0].severity, DiagnosticSeverity::Info);
    }
}
