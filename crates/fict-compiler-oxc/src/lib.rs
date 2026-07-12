#![forbid(unsafe_code)]

//! OXC-facing adapter boundary for the Fict compiler.
//!
//! Fict-owned IR crates must not depend on OXC directly. The adapter is kept as
//! a real workspace member from the first toolchain pin so Cargo resolves and
//! locks the exact OXC version used by every later compiler milestone.

#[cfg(test)]
mod tests {
    use oxc::{allocator::Allocator, parser::Parser, span::SourceType};

    #[test]
    fn pinned_oxc_release_parses_tsx() {
        let allocator = Allocator::default();
        let source_type = SourceType::from_path("toolchain-probe.tsx").unwrap();
        let parsed = Parser::new(
            &allocator,
            "export const View = (props: { value: number }) => <div>{props.value}</div>;",
            source_type,
        )
        .parse();

        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        assert_eq!(parsed.program.body.len(), 1);
    }
}
