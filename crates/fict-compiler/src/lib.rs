#![forbid(unsafe_code)]

//! Pure orchestration boundary for the native Fict compiler.
//!
//! The crate coordinates Fict-owned passes and the OXC adapter without owning
//! filesystem, network, Node, N-API, or bundler state.

pub use fict_compiler_oxc::ParseProbe;

/// Parse-only compatibility probe retained while the complete compile pipeline
/// is assembled behind this orchestration boundary.
#[must_use]
pub fn parse_tsx_probe(source: &str) -> ParseProbe {
    fict_compiler_oxc::parse_tsx_probe(source)
}
