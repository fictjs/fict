#![forbid(unsafe_code)]

//! Pure orchestration boundary for the native Fict compiler.
//!
//! The crate coordinates Fict-owned passes and the OXC adapter without owning
//! filesystem, network, Node, N-API, or bundler state.

mod request;
mod result;
mod source_map;

pub use fict_compiler_oxc::{OXC_VERSION, ParseProbe};
pub use fict_metadata::MODULE_REACTIVE_METADATA_VERSION;
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

/// SHA-256 of native source, manifests, lockfile, toolchain, feature mode, and build revision.
pub const COMPILER_SOURCE_HASH: &str = env!("FICT_COMPILER_SOURCE_HASH");

/// Stable cross-platform identity used by caches, shadow comparisons, and rollback checks.
pub const COMPILER_BUILD_ID: &str = concat!(
    "fict-rust-p1-oxc0.139.0-m1-",
    env!("FICT_COMPILER_SOURCE_HASH")
);

/// Return this native artifact's immutable compiler build identity.
#[must_use]
pub const fn compiler_build_id() -> &'static str {
    COMPILER_BUILD_ID
}

/// Parse-only compatibility probe retained while the complete compile pipeline
/// is assembled behind this orchestration boundary.
#[must_use]
pub fn parse_tsx_probe(source: &str) -> ParseProbe {
    fict_compiler_oxc::parse_tsx_probe(source)
}

#[cfg(test)]
mod build_id_tests {
    use super::{
        COMPILER_BUILD_ID, COMPILER_PROTOCOL_VERSION, COMPILER_SOURCE_HASH,
        MODULE_REACTIVE_METADATA_VERSION, OXC_VERSION, compiler_build_id,
    };

    #[test]
    fn build_id_contains_protocol_dependency_and_sha256_identity() {
        assert_eq!(compiler_build_id(), COMPILER_BUILD_ID);
        assert_eq!(COMPILER_SOURCE_HASH.len(), 64);
        assert!(
            COMPILER_SOURCE_HASH
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        );
        assert!(COMPILER_BUILD_ID.contains(&format!("-p{COMPILER_PROTOCOL_VERSION}-")));
        assert!(COMPILER_BUILD_ID.contains(&format!("oxc{OXC_VERSION}")));
        assert!(COMPILER_BUILD_ID.contains(&format!("-m{MODULE_REACTIVE_METADATA_VERSION}-")));
        assert!(COMPILER_BUILD_ID.ends_with(COMPILER_SOURCE_HASH));
    }
}
