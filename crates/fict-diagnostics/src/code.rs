use std::{error::Error, fmt};

use serde::{Deserialize, Deserializer, Serialize, Serializer, de};

const CODE_PREFIX: &str = "FICT-";
const MAX_CODE_LENGTH: usize = 64;

/// Stable machine-readable identifier for a Fict diagnostic.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DiagnosticCode(String);

impl DiagnosticCode {
    /// Validate and own a diagnostic code.
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidDiagnosticCode> {
        Self::try_from(value.into())
    }

    /// Borrow the validated code.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for DiagnosticCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl AsRef<str> for DiagnosticCode {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl TryFrom<String> for DiagnosticCode {
    type Error = InvalidDiagnosticCode;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if is_valid_code(&value) {
            Ok(Self(value))
        } else {
            Err(InvalidDiagnosticCode { value })
        }
    }
}

impl Serialize for DiagnosticCode {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for DiagnosticCode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::try_from(value).map_err(de::Error::custom)
    }
}

fn is_valid_code(value: &str) -> bool {
    if value.len() > MAX_CODE_LENGTH {
        return false;
    }
    let Some(suffix) = value.strip_prefix(CODE_PREFIX) else {
        return false;
    };
    if suffix.is_empty() || suffix.starts_with('-') || suffix.ends_with('-') {
        return false;
    }

    let mut previous_was_separator = false;
    for byte in suffix.bytes() {
        let is_separator = byte == b'-';
        if previous_was_separator && is_separator {
            return false;
        }
        if !byte.is_ascii_uppercase() && !byte.is_ascii_digit() && !is_separator {
            return false;
        }
        previous_was_separator = is_separator;
    }
    true
}

/// Validation error for a machine-readable diagnostic code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidDiagnosticCode {
    value: String,
}

impl InvalidDiagnosticCode {
    /// Return the rejected value.
    #[must_use]
    pub fn value(&self) -> &str {
        &self.value
    }
}

impl fmt::Display for InvalidDiagnosticCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid diagnostic code {:?}; expected FICT- followed by uppercase letters, digits, or single hyphens",
            self.value
        )
    }
}

impl Error for InvalidDiagnosticCode {}

#[cfg(test)]
mod tests {
    use super::DiagnosticCode;

    #[test]
    fn accepts_existing_and_namespaced_codes() {
        for code in ["FICT-M", "FICT-R006", "FICT-PARSE", "FICT-TS-NAMESPACE"] {
            assert_eq!(
                DiagnosticCode::new(code).expect("valid code").as_str(),
                code
            );
        }
    }

    #[test]
    fn rejects_malformed_codes_without_panicking() {
        for code in [
            "",
            "R006",
            "FICT-",
            "FICT-r006",
            "FICT-R_006",
            "FICT--R006",
            "FICT-R006-",
        ] {
            assert!(DiagnosticCode::new(code).is_err(), "accepted {code:?}");
        }
    }
}
