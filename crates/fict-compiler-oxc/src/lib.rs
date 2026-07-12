#![forbid(unsafe_code)]

//! OXC-facing adapter boundary for the Fict compiler.
//!
//! Fict-owned IR crates must not depend on OXC directly. The adapter is kept as
//! a real workspace member from the first toolchain pin so Cargo resolves and
//! locks the exact OXC version used by every later compiler milestone.

mod compile;
mod facts;
mod frontend;
mod hir_builder;
mod typescript;

pub use compile::{
    OxcCompileOptions, OxcCompileOutput, OxcModuleKind, OxcSourceLanguage, compile_passthrough,
};
pub use facts::{
    FictDirectiveKind, FictReturnShape, FrontendDirective, FrontendSourceFacts,
    FrontendSuppression, ParsedFictReturn, PureAnnotation, PureComment, PureCommentKind,
    PureTargetKind, ReactiveValueKind, SuppressionMode,
};
pub use frontend::{
    FrontendBinding, FrontendBindingKind, FrontendMacroCall, FrontendMacroImport,
    FrontendMacroValueUse, FrontendOutput, FrontendScope, FrontendScopeKind, FrontendSourceSummary,
    FrontendSummary, NamespaceMacroCall, analyze_frontend,
};
pub use hir_builder::{HirBuildOptions, HirBuildOutput, OxcSyntaxFragment, build_hir};
pub use typescript::{
    OxcTypeScriptOptions, TypeScriptCompatibilityOutput, TypeScriptCompatibilityPlan,
    TypeScriptFeature, TypeScriptFeatureKind, TypeScriptLoweringOwner,
    analyze_typescript_compatibility,
};

use oxc::{allocator::Allocator, parser::Parser, span::SourceType};

/// Exact OXC release compiled into this adapter.
pub const OXC_VERSION: &str = "0.139.0";

/// Owned parse information that is safe to cross the OXC arena boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseProbe {
    /// Number of top-level statements parsed from the source.
    pub statement_count: u32,
    /// Number of parser diagnostics produced for the source.
    pub diagnostic_count: u32,
}

/// Parse TSX without exposing an arena-backed OXC AST to callers.
#[must_use]
pub fn parse_tsx_probe(source: &str) -> ParseProbe {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::tsx()).parse();

    ParseProbe {
        statement_count: u32::try_from(parsed.program.body.len()).unwrap_or(u32::MAX),
        diagnostic_count: u32::try_from(parsed.diagnostics.len()).unwrap_or(u32::MAX),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_tsx_probe;

    #[test]
    fn pinned_oxc_release_parses_tsx() {
        let parsed = parse_tsx_probe(
            "export const View = (props: { value: number }) => <div>{props.value}</div>;",
        );

        assert_eq!(parsed.diagnostic_count, 0);
        assert_eq!(parsed.statement_count, 1);
    }

    #[test]
    fn parser_diagnostics_are_owned_summary_data() {
        let parsed = parse_tsx_probe("export const Broken = <div>;");

        assert!(parsed.diagnostic_count > 0);
    }
}
