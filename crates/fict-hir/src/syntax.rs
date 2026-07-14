use crate::{BindingId, Origin, SyntaxFragmentId};

/// Exact JavaScript string value represented as UTF-16 code units.
///
/// Rust strings cannot contain the lone surrogate code units that JavaScript permits. Keeping the
/// canonical language representation here avoids lossy replacement characters at adapter and
/// code-generation boundaries.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct JavaScriptString(Vec<u16>);

impl JavaScriptString {
    /// Construct a JavaScript string from exact UTF-16 code units.
    #[must_use]
    pub const fn from_code_units(code_units: Vec<u16>) -> Self {
        Self(code_units)
    }

    /// Borrow the exact UTF-16 code units.
    #[must_use]
    pub fn as_code_units(&self) -> &[u16] {
        &self.0
    }

    /// Return whether this string has zero UTF-16 code units.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Concatenate two JavaScript strings without Unicode normalization or lossy decoding.
    #[must_use]
    pub fn concat(&self, other: &Self) -> Self {
        let mut code_units = Vec::with_capacity(self.0.len().saturating_add(other.0.len()));
        code_units.extend_from_slice(&self.0);
        code_units.extend_from_slice(&other.0);
        Self(code_units)
    }

    /// Decode this value when it is a well-formed Unicode string.
    #[must_use]
    pub fn to_utf8(&self) -> Option<String> {
        String::from_utf16(&self.0).ok()
    }
}

impl From<&str> for JavaScriptString {
    fn from(value: &str) -> Self {
        Self(value.encode_utf16().collect())
    }
}

impl From<String> for JavaScriptString {
    fn from(value: String) -> Self {
        Self::from(value.as_str())
    }
}

/// Exact IEEE-754 payload for a JavaScript number literal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NumberLiteral(u64);

impl NumberLiteral {
    /// Preserve all bits, including negative zero and NaN payloads.
    #[must_use]
    pub const fn from_bits(bits: u64) -> Self {
        Self(bits)
    }

    /// Capture the exact representation of an `f64`.
    #[must_use]
    pub fn from_f64(value: f64) -> Self {
        Self(value.to_bits())
    }

    /// Return the exact IEEE-754 bits.
    #[must_use]
    pub const fn to_bits(self) -> u64 {
        self.0
    }

    /// Reconstruct the numeric value.
    #[must_use]
    pub fn to_f64(self) -> f64 {
        f64::from_bits(self.0)
    }

    /// Return whether this is JavaScript negative zero.
    #[must_use]
    pub const fn is_negative_zero(self) -> bool {
        self.0 == (-0.0_f64).to_bits()
    }
}

/// Literal values whose observable representation must survive optimization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiteralValue {
    /// JavaScript `null`.
    Null,
    /// JavaScript `undefined`.
    Undefined,
    /// Boolean literal.
    Boolean(bool),
    /// Exact JavaScript number representation.
    Number(NumberLiteral),
    /// BigInt digits without evaluation through a host numeric type.
    BigInt(String),
    /// String value after parser escape processing.
    String(JavaScriptString),
    /// Regular expression pattern and flags.
    RegExp {
        /// Pattern text.
        pattern: String,
        /// Flag text in source order.
        flags: String,
    },
}

/// Kind of adapter-owned source syntax referenced by HIR.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SyntaxFragmentKind {
    /// Binding, assignment, or parameter pattern.
    Pattern,
    /// Class body or class expression not yet expanded in core HIR.
    Class,
    /// Decorator expression or application site.
    Decorator,
    /// Async-specific syntax that must retain exact source shape.
    Async,
    /// Yield-specific syntax that must retain exact source shape.
    Yield,
    /// TypeScript syntax with runtime significance.
    TypeScript,
    /// A legal expression intentionally retained by the adapter.
    Expression,
    /// A legal statement intentionally retained by the adapter.
    Statement,
}

/// Binding effects of a retained pattern.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PatternSummary {
    /// Bindings declared by the pattern in source order.
    pub declared_bindings: Vec<BindingId>,
    /// Existing bindings written by an assignment pattern in source order.
    pub assigned_bindings: Vec<BindingId>,
    /// Whether the pattern contains defaults whose evaluation order matters.
    pub has_defaults: bool,
    /// Whether the pattern contains a rest element.
    pub has_rest: bool,
}

/// Read-only semantic facts exposed to compiler-core passes for retained syntax.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SyntaxSummary {
    /// Referenced semantic bindings in first-occurrence source order.
    pub referenced_bindings: Vec<BindingId>,
    /// Pattern-specific binding facts, when this is a pattern fragment.
    pub pattern: Option<PatternSummary>,
    /// Whether evaluating the fragment can observe or produce side effects.
    pub has_side_effects: bool,
    /// Whether evaluation can throw.
    pub may_throw: bool,
    /// Whether the fragment contains `await`.
    pub contains_await: bool,
    /// Whether the fragment contains `yield`.
    pub contains_yield: bool,
    /// Whether the fragment contains JSX.
    pub contains_jsx: bool,
    /// Whether the fragment contains decorators.
    pub contains_decorators: bool,
}

/// Core-visible handle and summary for syntax owned by the frontend adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyntaxFragment {
    /// Stable request-local handle used to ask the adapter to re-materialize syntax.
    pub id: SyntaxFragmentId,
    /// Controlled syntax category.
    pub kind: SyntaxFragmentKind,
    /// Source provenance.
    pub origin: Origin,
    /// Semantic facts sufficient for core analysis without traversing an adapter AST.
    pub summary: SyntaxSummary,
}

#[cfg(test)]
mod tests {
    use super::{JavaScriptString, NumberLiteral};

    #[test]
    fn number_literals_preserve_object_is_sensitive_bits() {
        let positive_zero = NumberLiteral::from_f64(0.0);
        let negative_zero = NumberLiteral::from_f64(-0.0);

        assert_ne!(positive_zero, negative_zero);
        assert!(negative_zero.is_negative_zero());
        assert_eq!(negative_zero.to_f64().to_bits(), (-0.0_f64).to_bits());
    }

    #[test]
    fn javascript_strings_preserve_utf16_and_concatenate_lone_surrogates() {
        let left = JavaScriptString::from_code_units(vec![u16::from(b'a'), 0xd800]);
        let right = JavaScriptString::from_code_units(vec![0xdc00, u16::from(b'z')]);
        let joined = left.concat(&right);

        assert_eq!(joined.as_code_units(), &[0x0061, 0xd800, 0xdc00, 0x007a]);
        assert_eq!(joined.to_utf8().as_deref(), Some("a𐀀z"));
        assert!(
            JavaScriptString::from_code_units(vec![0xd800])
                .to_utf8()
                .is_none()
        );
    }
}
