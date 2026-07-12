#![forbid(unsafe_code)]

//! Pure orchestration boundary for the native Fict compiler.
//!
//! The crate coordinates Fict-owned passes and the OXC adapter without owning
//! filesystem, network, Node, N-API, or bundler state.

mod request;
mod result;
mod source_map;

pub use fict_compiler_oxc::ParseProbe;
pub use request::{
    CompileRequest, CompileRequestError, CompilerOptions, CompilerPreviewOptions, ModuleKind,
    NormalizedCompileRequest, OptimizeLevel, SourceLanguage, WarningLevel, WarningsAsErrors,
};
pub use result::{
    CompileResult, CompilerArtifact, CompilerArtifactKind, CompilerExplainArtifact,
    CompilerExplainEvent, CompilerExplainEventKind, CompilerStats,
};
pub use source_map::{RawSourceMap, SourceMapValidationError};

/// Current native request/result protocol version.
pub const COMPILER_PROTOCOL_VERSION: u32 = 1;

/// Parse-only compatibility probe retained while the complete compile pipeline
/// is assembled behind this orchestration boundary.
#[must_use]
pub fn parse_tsx_probe(source: &str) -> ParseProbe {
    fict_compiler_oxc::parse_tsx_probe(source)
}
